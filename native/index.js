// dsh-baton-native: native DSH tools over the dsh-baton host control socket.
//
// Route 3 of PLAN.md: instead of mounting the upstream MCP server, this Host plugin
// runs inside Harness and registers ordinary model tools. It speaks the documented
// NDJSON protocol of the already-installed dsh-baton-host plugin, so sessions are
// created and driven exactly like the GUI's own sessions.
//
// M2 surface: workspaces, send, status, read, cancel and the local run registry.
// M3 adds the end-of-run wake-up and the evidence chain.
import { BatonHost } from './lib/protocol.js'
import { RunRegistry } from './lib/state.js'
import { batonHome } from './lib/socket.js'
import { prepare } from './lib/evidence.js'
import { RunWatcher } from './lib/watcher.js'
import {
  formatAnswer,
  formatCancel,
  formatRead,
  formatRuns,
  formatSend,
  formatStatus,
  formatWorkspaces,
} from './lib/format.js'

export const name = 'dsh-baton-native'

// sessionController wakes the asking session when a run ends; tools is the M1+ surface.
export const inject = ['tools', 'sessionController']

const LOG_PREFIX = 'dsh-baton-native'
const MAX_MESSAGE_BYTES = 64 * 1024

function loggerOf(ctx) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(LOG_PREFIX) : ctx?.logger
  return logger ?? console
}

function agentSessionIdOf(exec) {
  const session = exec?.agent?.session
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id ? id : null
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

export function apply(ctx) {
  const log = loggerOf(ctx)
  const debug = (...args) => {
    try {
      log.debug?.(...args)
    } catch {
      // Logging must never break activation.
    }
  }
  const client = new BatonHost({ env: process.env, log: debug })
  const registry = new RunRegistry()
  const home = batonHome()
  const watcher = new RunWatcher({ client, registry, ctx, log, home })

  ctx.effect(() => () => {
    watcher.dispose()
    client.close()
  }, `${LOG_PREFIX} host connection and run watchers`)
  watcher.resume()

  // Warm the connection and record the host version; a failure here is reported
  // by the first tool call instead of failing activation.
  void client.ping()
    .then((info) => log.info?.(`connected to dsh-baton host ${info?.version ?? '?'} (features: ${(info?.features ?? []).join(', ') || 'none'})`))
    .catch(() => debug('dsh-baton host is not reachable yet; tools will retry'))

  const request = async (method, params, options) => {
    try {
      return await client.request(method, params, options)
    } catch (error) {
      throw new Error(
        `dsh-baton host error: ${error?.message ?? error}. `
        + 'Check that DeepSeek Harness is running with the dsh-baton-host plugin enabled, '
        + 'or set DSH_BATON_SOCKET to the socket that host listens on.',
      )
    }
  }

  ctx.tools.register({
    name: 'baton_workspaces',
    description: 'List the Harness workspaces (project folders) where dsh-baton can start a session: id, path, title and session count. Read-only; use the returned id or path with baton_send.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: textOutput(),
    async execute() {
      return formatWorkspaces(await request('workspaces', {}, { timeoutMs: 15_000 }))
    },
  })

  ctx.tools.register({
    name: 'baton_send',
    description: 'Hand a task to an independent Harness session through dsh-baton and return immediately. The session runs live in the Harness sidebar. Omit session_id to start a new session (then cwd or workspace_id is required), or pass session_id to continue an existing session. When the run ends, or stops to ask a person, this session receives one wake-up message with the result and dsh-baton evidence: changed files, check exit codes and output tails. Pass checks to have those commands run when the run ends. Check progress with baton_status or baton_read; baton_cancel stops it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: {
          type: 'string',
          description: 'The task for the other session. Its first turn starts from this message.',
        },
        session_id: {
          type: 'string',
          description: 'Continue this existing Harness session instead of starting a new one.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute folder for a new session. Not used when session_id or workspace_id is given.',
        },
        workspace_id: {
          type: 'string',
          description: 'Harness workspace id for a new session (from baton_workspaces). Not used when session_id or cwd is given.',
        },
        mode: {
          type: 'string',
          enum: ['followup', 'steer'],
          description: 'Only matters for a busy session: followup queues the message after its current turn; steer adds it to the running turn.',
        },
        model: {
          type: 'string',
          description: 'Only when the user names a model for this run; the session keeps its own model otherwise.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Only when the user names a reasoning effort for this run.',
        },
        checks: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string' },
          description: 'The project\'s own test commands to run when the run ends, e.g. "npm test" or "python -m pytest". Their exit codes and output tails come back as evidence; never check scripts written just for the check.',
        },
      },
      required: ['message'],
    },
    output: textOutput(),
    async execute(args = {}, exec) {
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error('message is required: it becomes the other session\'s first turn.')
      }
      if (byteLength(args.message) > MAX_MESSAGE_BYTES) {
        throw new Error(`message is too large (${byteLength(args.message)} bytes; the limit is ${MAX_MESSAGE_BYTES}).`)
      }
      if (!args.session_id && !args.cwd && !args.workspace_id) {
        throw new Error('A new session needs cwd or workspace_id. Call baton_workspaces for the available ids and paths, or pass session_id to continue an existing session.')
      }
      if (args.mode !== undefined && args.mode !== 'followup' && args.mode !== 'steer') {
        throw new Error('mode must be followup or steer.')
      }
      const checks = Array.isArray(args.checks)
        ? args.checks.filter((check) => typeof check === 'string' && check.trim()).slice(0, 10)
        : []
      let evidenceCwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : null
      if (!evidenceCwd && args.workspace_id) {
        try {
          const list = await request('workspaces', {}, { timeoutMs: 15_000 })
          evidenceCwd = Array.isArray(list)
            ? list.find((workspace) => workspace?.id === String(args.workspace_id))?.path ?? null
            : null
        } catch {
          // Evidence is optional; the task itself does not depend on it.
        }
      } else if (!evidenceCwd && args.session_id) {
        try {
          const info = await request('read_session', { session_id: String(args.session_id), last: 1 }, { timeoutMs: 15_000 })
          evidenceCwd = info?.cwd ?? null
        } catch {
          // Evidence is optional.
        }
      }
      const payload = { message: args.message }
      if (args.session_id) payload.session_id = String(args.session_id)
      else if (args.workspace_id) payload.workspace_id = String(args.workspace_id)
      else payload.cwd = String(args.cwd)
      if (args.mode) payload.mode = args.mode
      if (args.model) payload.model = String(args.model)
      if (args.reasoning_effort) payload.reasoning_effort = String(args.reasoning_effort)

      const result = await request('send', payload, { timeoutMs: 30_000 })
      if (!result?.run_id || !result?.session_id) {
        throw new Error('dsh-baton host returned no run_id/session_id for the send.')
      }
      registry.record({
        runId: String(result.run_id),
        sessionId: String(result.session_id),
        agentSessionId: agentSessionIdOf(exec),
        messagePreview: args.message.slice(0, 200),
        workspace: result.workspace ?? null,
        checks,
        evidenceCwd,
      })
      if (evidenceCwd) {
        prepare(home, {
          run_id: String(result.run_id),
          session_id: String(result.session_id),
          cwd: evidenceCwd,
          checks,
        })
      }
      watcher.start(String(result.run_id))
      return formatSend(result)
    },
  })

  ctx.tools.register({
    name: 'baton_status',
    description: 'Progress of a dsh-baton run (run_id) or of a Harness session (session_id): state, recent text, errors, whether it waits for a person, and the final reply once it ends. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'The run returned by baton_send.' },
        session_id: { type: 'string', description: 'The session returned by baton_send.' },
        tail: { type: 'number', description: 'How many recent events to include (default 20).' },
      },
    },
    output: textOutput(),
    async execute(args = {}) {
      if (!args.run_id && !args.session_id) throw new Error('run_id or session_id is required.')
      const payload = {}
      if (args.run_id) payload.run_id = String(args.run_id)
      if (args.session_id) payload.session_id = String(args.session_id)
      if (Number.isFinite(args.tail)) payload.tail = Math.max(0, Math.min(200, Math.trunc(args.tail)))
      return formatStatus(await request('status', payload, { timeoutMs: 20_000 }))
    },
  })

  ctx.tools.register({
    name: 'baton_read',
    description: 'Read the most recent messages of a Harness session (session_id) without waking it. Read-only; useful to review what the other session did before acting on its result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: 'The session returned by baton_send.' },
        last: { type: 'number', description: 'How many recent messages to return (default 20, max 50).' },
      },
      required: ['session_id'],
    },
    output: textOutput(),
    async execute(args = {}) {
      if (!args.session_id) throw new Error('session_id is required.')
      const last = Number.isFinite(args.last) ? Math.max(1, Math.min(50, Math.trunc(args.last))) : 20
      return formatRead(await request('read_session', { session_id: String(args.session_id), last }, { timeoutMs: 20_000 }))
    },
  })

  ctx.tools.register({
    name: 'baton_cancel',
    description: 'Stop everything a dsh-baton run or Harness session is doing: the turn, its sub-agents and its background jobs. Also drops messages still waiting in the session queue.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'The run to stop.' },
        session_id: { type: 'string', description: 'Stop everything this session is doing.' },
      },
    },
    output: textOutput(),
    async execute(args = {}) {
      if (!args.run_id && !args.session_id) throw new Error('run_id or session_id is required.')
      const payload = {}
      if (args.run_id) payload.run_id = String(args.run_id)
      if (args.session_id) payload.session_id = String(args.session_id)
      return formatCancel(await request('cancel', payload, { timeoutMs: 60_000 }))
    },
  })

  ctx.tools.register({
    name: 'baton_answer',
    description: 'Answer the questions a dsh-baton run stopped to ask (the wake-up message says when it waits for a person). Pass one entry per question: option number or label in choose, or text for a single-choice question, or skip. A question that needs an approval in the Harness window cannot be answered here; tell the user to answer it there.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'The run that is waiting for an answer.' },
        session_id: { type: 'string', description: 'The session that is waiting, when run_id is not known.' },
        answers: {
          type: 'array',
          minItems: 1,
          description: 'One entry per open question.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'The question id when several questions are open.' },
              choose: {
                type: 'array',
                items: { type: 'string' },
                description: 'Option numbers (as strings "1", "2") or option labels to select.',
              },
              text: { type: 'string', description: 'Free text; for a single-choice question it replaces the option.' },
              skip: { type: 'boolean', description: 'Answer nothing for this question.' },
            },
          },
        },
      },
      required: ['answers'],
    },
    output: textOutput(),
    async execute(args = {}) {
      if (!args.run_id && !args.session_id) throw new Error('run_id or session_id is required.')
      if (!Array.isArray(args.answers) || args.answers.length === 0) {
        throw new Error('answers must list at least one answer.')
      }
      const answers = args.answers.map((answer) => {
        if (!answer || typeof answer !== 'object') throw new Error('each answer must be an object.')
        const row = {}
        if (answer.id !== undefined) row.id = String(answer.id)
        if (Array.isArray(answer.choose) && answer.choose.length > 0) {
          row.choose = answer.choose.map((value) => String(value))
        }
        if (typeof answer.text === 'string' && answer.text.trim()) row.text = answer.text
        if (answer.skip === true) row.skip = true
        return row
      })
      const payload = { answers }
      if (args.run_id) payload.run_id = String(args.run_id)
      if (args.session_id) payload.session_id = String(args.session_id)
      return formatAnswer(await request('answer', payload, { timeoutMs: 30_000 }))
    },
  })

  ctx.tools.register({
    name: 'baton_runs',
    description: 'List the dsh-baton runs this plugin started, newest first: run id, target session, who asked for it, and whether its end-of-run result was delivered. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'How many runs to list (default 20, max 100).' },
      },
    },
    output: textOutput(),
    async execute(args = {}) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
      return formatRuns(registry.list().slice(0, limit))
    },
  })
}
