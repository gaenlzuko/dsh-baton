// M2 tool tests against a fake dsh-baton host: request shapes, validation,
// formatting and the local run registry.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { socketEndpoint } from '../lib/socket.js'
import { apply } from '../index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baton-native-test-'))
const socketPath = path.join(tmp, 'host.sock')
const stateDir = path.join(tmp, 'state')
process.env.DSH_BATON_SOCKET = socketPath
process.env.DSH_BATON_NATIVE_STATE = stateDir
process.env.DSH_BATON_HOME = path.join(tmp, 'baton-home')
const endpoint = socketEndpoint(socketPath)

let lastSend = null
const server = net.createServer((socket) => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      let request
      try {
        request = JSON.parse(line)
      } catch {
        continue
      }
      socket.write(JSON.stringify({ id: request.id, ...reply(request) }) + '\n')
    }
  })
})

function reply({ method, params = {} }) {
  if (method === 'ping') {
    return { result: { name: 'fake-baton', version: '9.9.9', pid: 123, features: [] } }
  }
  if (method === 'workspaces') {
    return { result: [{ id: 'ws-1', path: 'C:\\ws', title: 'fake workspace', session_count: 2 }] }
  }
  if (method === 'send') {
    lastSend = params
    if (!params.session_id && !params.cwd && !params.workspace_id) {
      return { error: 'A new session needs cwd or workspace_id.' }
    }
    return {
      result: {
        run_id: 'hrun-test-1',
        session_id: 'sess-test-1',
        state: 'queued',
        message_preview: String(params.message).slice(0, 200),
        mode: params.mode ?? 'followup',
        workspace: { id: 'ws-1', path: 'C:\\ws' },
      },
    }
  }
  if (method === 'status') {
    return {
      result: {
        run_id: params.run_id ?? 'hrun-test-1',
        session_id: params.session_id ?? 'sess-test-1',
        state: 'completed',
        final_text: 'all good',
        ended_at: '2026-11-23T00:00:00.000Z',
      },
    }
  }
  if (method === 'wait') {
    return {
      result: {
        run_id: params.run_id ?? 'hrun-test-1',
        session_id: 'sess-test-1',
        state: 'completed',
        final_text: 'done',
      },
    }
  }
  if (method === 'read_session') {
    return {
      result: {
        session_id: params.session_id,
        title: 'fake session',
        cwd: 'C:\\ws',
        total_messages: 2,
        messages: [
          { role: 'user', text: 'do the thing' },
          { role: 'assistant', text: 'done', tools: ['bash'] },
        ],
      },
    }
  }
  if (method === 'cancel') {
    return { result: { session_id: params.session_id ?? 'sess-test-1', attempts: 1, still_busy: false, queued_runs: [] } }
  }
  return { error: `unexpected method ${method}` }
}

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(endpoint, resolve)
})

const tools = new Map()
const disposers = []
const ctx = {
  logger: { info() {}, debug() {}, warn() {}, error() {} },
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}
apply(ctx)

after(async () => {
  for (const dispose of disposers.reverse()) dispose()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const run = (name, args, exec = {}) => tools.get(name).execute(args, exec)

test('registers the M2 tool surface', () => {
  assert.deepEqual([...tools.keys()].sort(), [
    'baton_cancel',
    'baton_read',
    'baton_runs',
    'baton_send',
    'baton_status',
    'baton_workspaces',
  ])
})

test('baton_send refuses a new session without a folder or workspace', async () => {
  await assert.rejects(() => run('baton_send', { message: 'hello' }), /needs cwd or workspace_id/)
})

test('baton_send passes the task and records the run for the asking agent', async () => {
  const text = await run(
    'baton_send',
    { message: 'do the thing', cwd: 'C:\\ws', mode: 'followup' },
    { agent: { session: { header: { id: 'agent-A' } } } },
  )
  assert.match(text, /Started run hrun-test-1/)
  assert.equal(lastSend.message, 'do the thing')
  assert.equal(lastSend.cwd, 'C:\\ws')
  assert.equal(lastSend.mode, 'followup')

  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  assert.equal(saved.runs['hrun-test-1'].sessionId, 'sess-test-1')
  assert.equal(saved.runs['hrun-test-1'].agentSessionId, 'agent-A')
})

test('baton_status renders a finished run', async () => {
  const text = await run('baton_status', { run_id: 'hrun-test-1' })
  assert.match(text, /state: completed/)
  assert.match(text, /all good/)
})

test('baton_read renders recent messages', async () => {
  const text = await run('baton_read', { session_id: 'sess-test-1' })
  assert.match(text, /fake session/)
  assert.match(text, /do the thing/)
  assert.match(text, /done/)
})

test('baton_cancel reports the stop', async () => {
  const text = await run('baton_cancel', { session_id: 'sess-test-1' })
  assert.match(text, /cancel requested/)
  assert.match(text, /still busy: no/)
})

test('baton_runs lists the recorded run', async () => {
  const text = await run('baton_runs', {})
  assert.match(text, /hrun-test-1/)
  assert.match(text, /sess-test-1/)
  assert.match(text, /agent-A/)
})
