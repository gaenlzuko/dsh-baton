// NDJSON client for the dsh-baton host control socket.
//
// The host (dsh-baton-host, already installed) serves newline-delimited JSON:
// request  { id, method, params }   reply { id, result } | { id, error }
// See https://github.com/JialaoLiu/dsh-baton/blob/main/host/PROTOCOL.md
import net from 'node:net'
import { hostEndpoints } from './socket.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

export class HostUnavailableError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'HostUnavailableError'
  }
}

export class BatonHost {
  #endpoints
  #conn = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #connecting = null
  #closed = false
  #log

  constructor({ env = process.env, platform = process.platform, log = () => {}, endpoints } = {}) {
    this.#endpoints = endpoints ?? hostEndpoints(env, platform)
    this.#log = log
  }

  get endpoint() {
    return this.#conn ? this.#conn.localAddress ?? this.#endpoints[0] : this.#endpoints[0]
  }

  /** Connect now; resolves with the chosen endpoint. */
  async connect() {
    if (this.#closed) throw new HostUnavailableError('dsh-baton-native is closed')
    if (this.#conn) return this.endpoint
    if (this.#connecting) return this.#connecting
    this.#connecting = this.#connect().finally(() => { this.#connecting = null })
    return this.#connecting
  }

  async #connect() {
    let lastError
    for (const endpoint of this.#endpoints) {
      try {
        const conn = await new Promise((resolve, reject) => {
          const socket = net.connect(endpoint)
          const timer = setTimeout(() => {
            socket.destroy()
            reject(new HostUnavailableError(`timed out connecting to ${endpoint}`))
          }, DEFAULT_CONNECT_TIMEOUT_MS)
          socket.once('connect', () => {
            clearTimeout(timer)
            resolve(socket)
          })
          socket.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
        })
        this.#attach(conn)
        this.#log('connected', endpoint)
        return this.endpoint
      } catch (error) {
        lastError = error
      }
    }
    throw new HostUnavailableError(
      'dsh-baton-host is not reachable. Is DeepSeek Harness running with the dsh-baton-host plugin enabled? '
      + `Tried: ${this.#endpoints.join(', ')}`,
      lastError,
    )
  }

  #attach(conn) {
    this.#conn = conn
    this.#buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => this.#onData(chunk))
    conn.on('error', (error) => this.#log('socket error', error?.message ?? String(error)))
    conn.on('close', () => {
      if (this.#conn === conn) this.#conn = null
      this.#rejectAll(new HostUnavailableError('dsh-baton host disconnected'))
    })
  }

  #onData(chunk) {
    this.#buffer += chunk
    let nl
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, nl)
      this.#buffer = this.#buffer.slice(nl + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.#log('ignoring malformed host line', line.slice(0, 200))
        continue
      }
      const pending = this.#pending.get(message.id)
      if (!pending) continue
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(String(message.error)))
      else pending.resolve(message.result)
    }
  }

  #rejectAll(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  /** Send one request; `timeoutMs` 0 means no client-side timeout (long waits). */
  async request(method, params = {}, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    await this.connect()
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.#pending.delete(id)
            reject(new Error(`dsh-baton host timed out on ${method}`))
          }, timeoutMs)
        : null
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#conn.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new HostUnavailableError(`could not write to dsh-baton host: ${error?.message ?? error}`, error))
      }
    })
  }

  ping() {
    return this.request('ping', {}, { timeoutMs: 5_000 })
  }

  workspaces() {
    return this.request('workspaces')
  }

  /** Block until the run ends, the host asks a person, or `timeoutS` passes. */
  wait(runId, timeoutS) {
    const seconds = Number.isFinite(Number(timeoutS)) ? Math.max(1, Math.min(Number(timeoutS), 86_400)) : 86_400
    return this.request('wait', { run_id: runId, timeout_s: seconds }, { timeoutMs: 0 })
  }

  close() {
    this.#closed = true
    this.#rejectAll(new HostUnavailableError('dsh-baton-native closed the host connection'))
    this.#conn?.destroy()
    this.#conn = null
  }
}
