// Local registry of runs this plugin started: which Harness session asked for each
// run, and whether its wake-up message was delivered. Kept outside the profile so an
// uninstall or reinstall keeps the account; it stores no conversation text.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const VERSION = 1

function defaultDir() {
  return process.env.DSH_BATON_NATIVE_STATE || path.join(os.homedir(), '.dsh-baton-native')
}

export class RunRegistry {
  #dir
  #file
  #runs = new Map()

  constructor({ dir = defaultDir() } = {}) {
    this.#dir = dir
    this.#file = path.join(dir, 'state.json')
    this.#load()
  }

  get file() {
    return this.#file
  }

  #load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.#file, 'utf8'))
      if (doc?.version !== VERSION || typeof doc.runs !== 'object' || doc.runs === null) return
      for (const [runId, entry] of Object.entries(doc.runs)) {
        if (runId && entry && typeof entry === 'object') this.#runs.set(runId, { ...entry, runId })
      }
    } catch {
      // A missing or unreadable file is simply an empty registry.
    }
  }

  #save() {
    try {
      fs.mkdirSync(this.#dir, { recursive: true })
      const tmp = `${this.#file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, runs: Object.fromEntries(this.#runs) }, null, 2))
      fs.renameSync(tmp, this.#file)
    } catch {
      // Losing the local registry must not fail a tool call; M3 reconciles with the host.
    }
  }

  record(entry) {
    if (!entry?.runId || !entry?.sessionId) throw new TypeError('runId and sessionId are required')
    const record = {
      ...entry,
      recordedAt: entry.recordedAt ?? new Date().toISOString(),
    }
    this.#runs.set(record.runId, record)
    this.#save()
    return record
  }

  markDelivered(runId, at = new Date().toISOString()) {
    const entry = this.#runs.get(runId)
    if (!entry) return false
    entry.deliveredAt = at
    this.#save()
    return true
  }

  markInputNotified(runId, at = new Date().toISOString()) {
    const entry = this.#runs.get(runId)
    if (!entry) return false
    entry.inputNotifiedAt = at
    this.#save()
    return true
  }

  get(runId) {
    return this.#runs.get(runId)
  }

  list() {
    return [...this.#runs.values()].sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))
  }

  forget(runId) {
    return this.#runs.delete(runId) ? this.#save() : false
  }
}
