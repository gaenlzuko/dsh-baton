// End-to-end M3 test with a fake host and a fake asking agent: send a task, let the
// run finish after the folder changed, and require exactly one wake-up message that
// carries the evidence (changed files + checks).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { socketEndpoint } from '../lib/socket.js'
import { apply } from '../index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baton-watcher-'))
const workspace = path.join(tmp, 'workspace')
fs.mkdirSync(workspace)
fs.writeFileSync(path.join(workspace, 'a.txt'), 'one')
const socketPath = path.join(tmp, 'host.sock')
const stateDir = path.join(tmp, 'state')
const batonHome = path.join(tmp, 'baton-home')
process.env.DSH_BATON_SOCKET = socketPath
process.env.DSH_BATON_NATIVE_STATE = stateDir
process.env.DSH_BATON_HOME = batonHome
const endpoint = socketEndpoint(socketPath)

const captured = []
const waiters = []
let released = null
let releasePayload = null

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
      const request = JSON.parse(line)
      handle(socket, request)
    }
  })
})

function handle(socket, request) {
  const { method, params = {} } = request
  const write = (result) => socket.write(JSON.stringify({ id: request.id, result }) + '\n')
  if (method === 'ping') return write({ name: 'fake-baton', version: '9.9.9', pid: 1, features: [] })
  if (method === 'send') {
    return write({ run_id: 'hrun-w1', session_id: 'sess-w1', state: 'queued', message_preview: params.message })
  }
  if (method === 'wait') {
    if (released) return write(released)
    waiters.push(() => write(released))
    return undefined
  }
  return socket.write(JSON.stringify({ id: request.id, error: `unexpected method ${method}` }) + '\n')
}

function release(payload) {
  released = payload
  for (const reply of waiters.splice(0)) reply()
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
  sessionController: {
    async resolveAgent(sessionId) {
      assert.equal(sessionId, 'agent-A')
      return {
        agent: {
          followup(message) {
            captured.push(message)
          },
        },
      }
    },
  },
}
apply(ctx)

after(async () => {
  for (const dispose of disposers.reverse()) dispose()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('a finished run wakes the asking session once with evidence', async () => {
  const text = await tools.get('baton_send').execute(
    { message: 'write the new file', cwd: workspace, checks: ['node --version'] },
    { agent: { session: { header: { id: 'agent-A' } } } },
  )
  assert.match(text, /Started run hrun-w1/)

  // The run changes the folder, then ends.
  fs.writeFileSync(path.join(workspace, 'b.txt'), 'new')
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one two')
  release({
    run_id: 'hrun-w1',
    session_id: 'sess-w1',
    state: 'completed',
    final_text: 'done\n| requirement | met | evidence |\n| file | yes | b.txt:1 |',
  })

  const deadline = Date.now() + 10_000
  while (captured.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  assert.equal(captured.length, 1, 'expected exactly one wake-up message')
  const message = captured[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'agent-message')
  assert.equal(message.source.form, 'relay')
  const wake = message.content[0].text
  assert.match(wake, /run hrun-w1 finished: completed/)
  assert.match(wake, /created: b\.txt/)
  assert.match(wake, /modified: a\.txt/)
  assert.match(wake, /PASS node --version/)
  assert.match(wake, /all checks passed: yes/)
  assert.match(wake, /final reply: done/)
  assert.match(wake, /requirement table/)

  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  assert.ok(saved.runs['hrun-w1'].deliveredAt, 'the run should be marked delivered')
})

test('a delivered run is not woken again when the plugin reloads', async () => {
  const captured2 = []
  const disposers2 = []
  const ctx2 = {
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    tools: { register() {} },
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers2.push(dispose)
    },
    sessionController: {
      async resolveAgent() {
        return { agent: { followup: (message) => captured2.push(message) } }
      },
    },
  }
  apply(ctx2)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(captured2.length, 0, 'a delivered run must not wake the session again')
  for (const dispose of disposers2.reverse()) dispose()
})
