// Protocol client tests: framing, error replies, timeouts, disconnects.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { BatonHost } from '../lib/protocol.js'

function pipeName() {
  return `\\\\.\\pipe\\dsh-baton-test-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
}

async function withServer(handler, run) {
  const endpoint = pipeName()
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
        handler(socket, request)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  try {
    return await run(endpoint)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('request/response survives a reply split across chunks', async () => {
  await withServer((socket, request) => {
    if (request.method !== 'ping') return
    const payload = JSON.stringify({ id: request.id, result: { name: 'fake', version: '1.2.3' } }) + '\n'
    socket.write(payload.slice(0, 7))
    setTimeout(() => socket.write(payload.slice(7)), 10)
  }, async (endpoint) => {
    const host = new BatonHost({ endpoints: [endpoint] })
    const info = await host.ping()
    assert.equal(info.name, 'fake')
    assert.equal(info.version, '1.2.3')
    host.close()
  })
})

test('an error reply rejects the request', async () => {
  await withServer((socket, request) => {
    socket.write(JSON.stringify({ id: request.id, error: 'boom' }) + '\n')
  }, async (endpoint) => {
    const host = new BatonHost({ endpoints: [endpoint] })
    await assert.rejects(() => host.ping(), /boom/)
    host.close()
  })
})

test('a host timeout rejects the request', async () => {
  await withServer(() => {}, async (endpoint) => {
    const host = new BatonHost({ endpoints: [endpoint] })
    await assert.rejects(
      () => host.request('ping', {}, { timeoutMs: 50 }),
      /timed out/,
    )
    host.close()
  })
})

test('disconnect rejects pending requests', async () => {
  await withServer((socket) => {
    socket.destroy()
  }, async (endpoint) => {
    const host = new BatonHost({ endpoints: [endpoint] })
    await assert.rejects(() => host.ping(), /disconnected|error/i)
    host.close()
  })
})

test('wait uses no client-side timeout and sends timeout_s', async () => {
  let seen
  await withServer((socket, request) => {
    seen = request
    socket.write(JSON.stringify({ id: request.id, result: { run_id: 'hrun-x', state: 'completed' } }) + '\n')
  }, async (endpoint) => {
    const host = new BatonHost({ endpoints: [endpoint] })
    const result = await host.wait('hrun-x', 3600)
    assert.equal(result.state, 'completed')
    assert.equal(seen.method, 'wait')
    assert.equal(seen.params.run_id, 'hrun-x')
    assert.equal(seen.params.timeout_s, 3600)
    host.close()
  })
})
