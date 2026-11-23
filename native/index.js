// dsh-baton-native: native DSH tools over the dsh-baton host control socket.
//
// Route 3 of PLAN.md: instead of mounting the upstream MCP server, this Host plugin
// runs inside Harness, registers ordinary model tools, and (from M3 on) wakes the
// initiating session when a run ends. At M1 it exposes a read-only connectivity
// check (`baton_workspaces`) so the socket, the tool surface and the bundle can be
// verified end to end before session creation is added.
import { BatonHost } from './lib/protocol.js'

export const name = 'dsh-baton-native'

// sessionController is needed from M3 (wake-up injection); tools from M1.
export const inject = ['tools']

const LOG_PREFIX = 'dsh-baton-native'

function loggerOf(ctx) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger(LOG_PREFIX) : ctx?.logger
  return logger ?? console
}

function formatWorkspaces(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'No workspaces are registered in this Harness. A new session needs a folder; register one in the Harness sidebar first.'
  }
  return rows.map((workspace, index) => {
    const count = Number.isFinite(workspace?.session_count) ? `, ${workspace.session_count} sessions` : ''
    return `${index + 1}. ${workspace?.title || '(untitled)'} — ${workspace?.path}${count}\n   id: ${workspace?.id}`
  }).join('\n')
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

  ctx.effect(() => () => client.close(), `${LOG_PREFIX} host connection`)

  // Warm the connection and record the host version; a failure here is reported
  // by the first tool call instead of failing activation.
  void client.ping()
    .then((info) => log.info?.(`connected to dsh-baton host ${info?.version ?? '?'} (features: ${(info?.features ?? []).join(', ') || 'none'})`))
    .catch(() => debug('dsh-baton host is not reachable yet; tools will retry'))

  ctx.tools.register({
    name: 'baton_workspaces',
    description: 'List the Harness workspaces (project folders) where dsh-baton can start a session: id, path, title and session count. Read-only; use the returned id or path with the baton_* task tools.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      try {
        const rows = await client.request('workspaces', {}, { timeoutMs: 15_000 })
        return formatWorkspaces(rows)
      } catch (error) {
        throw new Error(
          `Could not reach dsh-baton-host: ${error?.message ?? error}. `
          + 'Check that DeepSeek Harness is running with the dsh-baton-host plugin enabled, '
          + 'or set DSH_BATON_SOCKET to the socket that host listens on.',
        )
      }
    },
  })
}
