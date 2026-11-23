// One watcher per run: a long `wait` on the host socket, then one wake-up message to
// the session that asked for the run. No polling: the host releases the wait when the
// run ends, asks a person, or the (24 h) wait expires.
import path from 'node:path'
import { collect } from './evidence.js'
import { buildFinishedText, buildInputText, buildLostText, deliverWake } from './wake.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class RunWatcher {
  #client
  #registry
  #ctx
  #log
  #home
  #waitTimeoutS
  #disposed = false
  #active = new Map()

  constructor({ client, registry, ctx, log, home, waitTimeoutS = 86_400 }) {
    this.#client = client
    this.#registry = registry
    this.#ctx = ctx
    this.#log = log
    this.#home = home
    this.#waitTimeoutS = waitTimeoutS
  }

  /** Start watching one run (idempotent while it is active). */
  start(runId) {
    if (this.#disposed || !runId || this.#active.has(runId)) return
    const promise = this.#loop(String(runId)).finally(() => this.#active.delete(String(runId)))
    this.#active.set(String(runId), promise)
    promise.catch((error) => this.#log?.warn?.(`baton watcher ${runId}: ${error?.message ?? error}`))
  }

  /** Restart watchers for runs whose result was never delivered (plugin reload / restart). */
  resume() {
    for (const entry of this.#registry.list()) {
      if (!entry.deliveredAt && entry.runId) this.start(entry.runId)
    }
  }

  dispose() {
    this.#disposed = true
  }

  async #loop(runId) {
    let failures = 0
    while (!this.#disposed) {
      let result
      try {
        result = await this.#client.wait(runId, this.#waitTimeoutS)
        failures = 0
      } catch (error) {
        if (this.#disposed) return
        const message = String(error?.message ?? error)
        if (/Unknown run/.test(message)) {
          const entry = this.#registry.get(runId)
          await this.#deliver(runId, buildLostText({ runId, entry, reason: message }), { kind: 'lost' })
          return
        }
        failures += 1
        this.#log?.warn?.(`baton watcher ${runId}: wait failed (${message}); retrying`)
        await sleep(Math.min(10_000, 500 * 2 ** Math.min(failures, 5)))
        continue
      }
      if (!result) continue
      if (result.needs_input) {
        await this.#deliver(runId, buildInputText({ runId, run: result }), { kind: 'input' })
        continue
      }
      if (result.timed_out) continue

      const evidence = this.#collectEvidence(runId)
      await this.#deliver(runId, buildFinishedText({
        runId,
        run: result,
        evidence,
        evidenceFile: path.join(this.#home, 'evidence', `${String(runId).replace(/[^\w.-]/g, '_')}.json`),
      }), { kind: 'finished' })
      return
    }
  }

  #collectEvidence(runId) {
    try {
      return collect(this.#home, runId)
    } catch (error) {
      this.#log?.warn?.(`baton watcher ${runId}: evidence collection failed: ${error?.message ?? error}`)
      return null
    }
  }

  async #deliver(runId, text, { kind }) {
    const entry = this.#registry.get(runId)
    if (!entry) return { delivered: false, reason: 'run is not registered by this plugin' }
    if (kind === 'finished' && entry.deliveredAt) return { delivered: true }
    const result = await deliverWake({ ctx: this.#ctx, log: this.#log, entry, text })
    if (result.delivered) {
      if (kind === 'finished' || kind === 'lost') this.#registry.markDelivered(runId)
      if (kind === 'input') this.#registry.markInputNotified(runId)
      this.#log?.info?.(`baton watcher: woke ${entry.agentSessionId} for ${runId} (${kind})`)
    } else {
      this.#log?.warn?.(`baton watcher: could not wake ${entry.agentSessionId} for ${runId}: ${result.reason}`)
    }
    return result
  }
}
