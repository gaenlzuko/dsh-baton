// Live A -> B -> A verification against a real dsh-baton host (used by M6).
//
// A harness session A is created and prompted through the host socket; its model is
// asked to call baton_send, which creates session B. When B ends, the native plugin
// must wake A once with evidence. This script drives that flow and writes a JSON
// result file; it never talks to the web UI.
//
// Required env:
//   E2E_A_CWD, E2E_B_CWD, E2E_RESULT  (absolute paths)
// optional: E2E_LOG, E2E_TIMEOUT_MS (default 20 min)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { BatonHost } from '../lib/protocol.js'

const A_CWD = process.env.E2E_A_CWD
const B_CWD = process.env.E2E_B_CWD
const RESULT = process.env.E2E_RESULT
const LOG = process.env.E2E_LOG || RESULT.replace(/\.json$/, '.log')
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 20 * 60_000)
const STATE_DIR = process.env.DSH_BATON_NATIVE_STATE
const BATON_HOME = process.env.DSH_BATON_HOME || path.join(os.homedir(), '.dsh-baton')
const SESSION_ROOT = path.join(process.env.E2E_DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const ZSTD = process.env.E2E_ZSTD || 'D:\\ProgramData\\miniconda3\\Library\\bin\\zstd.exe'

const started = Date.now()
const result = { ok: false, stage: 'start', startedAt: new Date().toISOString() }

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  console.log(line)
  try {
    fs.appendFileSync(LOG, `${line}\n`)
  } catch {
    // logging is best effort
  }
}

function save() {
  result.durationMs = Date.now() - started
  fs.mkdirSync(path.dirname(RESULT), { recursive: true })
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const host = new BatonHost({
  log: (message, extra) => {
    if (process.env.E2E_DEBUG) log('client', message, extra ?? '')
  },
})

function promptForA() {
  return [
    'You are session A, the lead of this task. Call the baton_send tool exactly once in this turn with:',
    `- cwd: ${B_CWD}`,
    '- checks: ["node --version"]',
    '- message: "Create a file named B_DONE.txt in the current folder containing exactly: ok. Do not do anything else. Then end your reply with a review table: requirement | met (yes/no) | evidence (file:line or test name)."',
    'Do not call any other tool in this turn. After baton_send returns, reply with exactly: STARTED',
    'A baton wake-up message will arrive later with the evidence. When it arrives, reply with one short paragraph naming the changed file(s) and the check result.',
  ].join('\n')
}

async function waitRun(runId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await host.wait(runId, 60)
    if (run.timed_out) {
      log(`${label}: still active`)
      continue
    }
    if (run.needs_input) {
      log(`${label}: needs input`, run.question)
      continue
    }
    return run
  }
  throw new Error(`${label}: run ${runId} did not finish within ${timeoutMs} ms`)
}

async function findBRun(sessionA, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const runs = await host.request('list_runs', { limit: 30 })
    const candidate = runs.find((run) => run.session_id && run.session_id !== sessionA)
    if (candidate) return candidate
    await sleep(1000)
  }
  throw new Error('session B was never created: A did not call baton_send successfully')
}

function findSessionLog(sessionId) {
  if (!fs.existsSync(SESSION_ROOT)) return null
  for (const project of fs.readdirSync(SESSION_ROOT)) {
    const dir = path.join(SESSION_ROOT, project, sessionId)
    if (!fs.existsSync(dir)) continue
    const file = fs.readdirSync(dir).find((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name))
    if (file) return path.join(dir, file)
  }
  return null
}

function readSessionEvents(sessionId) {
  const file = findSessionLog(sessionId)
  if (!file) return { file: null, events: [] }
  const decompressed = spawnSync(ZSTD, ['-d', '-c', file], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (decompressed.status !== 0) return { file, events: [], error: String(decompressed.stderr ?? 'zstd failed') }
  const events = []
  for (const line of decompressed.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // skip malformed line
    }
  }
  return { file, events }
}

function findWake(events) {
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'agent-message') continue
    const text = JSON.stringify(event.data?.content ?? '')
    if (text.includes('[baton]')) return { text, source }
  }
  return null
}

function assistantTexts(events) {
  return events
    .filter((event) => event?.type === 'assistant/message')
    .map((event) => JSON.stringify(event.data?.message?.content ?? ''))
}

try {
  result.stage = 'connect'
  const info = await host.ping()
  result.host = info
  log('connected to host', info?.version)

  result.stage = 'send-A'
  const aSend = await host.request('send', { cwd: A_CWD, message: promptForA() }, { timeoutMs: 60_000 })
  result.a = { runId: aSend.run_id, sessionId: aSend.session_id, send: aSend }
  log('session A started', aSend.session_id, aSend.run_id)

  result.stage = 'wait-A-first-turn'
  const aFirst = await waitRun(aSend.run_id, TIMEOUT_MS, 'A first turn')
  result.a.firstRun = aFirst
  log('A first turn ended:', aFirst.state, String(aFirst.final_text ?? '').slice(0, 200))

  result.stage = 'find-B'
  const bRun = await findBRun(aSend.session_id, 120_000)
  result.b = { runId: bRun.run_id, sessionId: bRun.session_id }
  log('session B created', bRun.session_id, bRun.run_id)

  result.stage = 'wait-B'
  const bDone = await waitRun(bRun.run_id, TIMEOUT_MS, 'B run')
  result.b.run = bDone
  log('B run ended:', bDone.state, String(bDone.final_text ?? '').slice(0, 200))

  result.stage = 'wait-wake'
  const wakeDeadline = Date.now() + TIMEOUT_MS
  let aLog = null
  while (Date.now() < wakeDeadline) {
    aLog = readSessionEvents(aSend.session_id)
    if (findWake(aLog.events) && assistantTexts(aLog.events).length >= 2) break
    await sleep(2000)
  }
  result.aLog = aLog ? { file: aLog.file, events: aLog.events.length, error: aLog.error ?? null } : null
  const wake = aLog ? findWake(aLog.events) : null
  const posts = aLog ? assistantTexts(aLog.events) : []
  result.wake = wake
  result.aAssistantMessages = posts.length
  result.aAssistantTail = posts.slice(-3)
  log('wake found:', Boolean(wake), 'assistant messages:', posts.length)

  result.stage = 'evidence'
  const evidenceFile = path.join(BATON_HOME, 'evidence', `${String(bRun.run_id).replace(/[^\w.-]/g, '_')}.json`)
  result.evidence = { file: evidenceFile, found: fs.existsSync(evidenceFile) }
  if (fs.existsSync(evidenceFile)) {
    try {
      const record = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
      result.evidence.result = record.result ?? null
    } catch (error) {
      result.evidence.error = String(error?.message ?? error)
    }
  }

  result.stateFile = STATE_DIR ? path.join(STATE_DIR, 'state.json') : null
  if (result.stateFile && fs.existsSync(result.stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'))
      result.delivered = Boolean(state.runs?.[bRun.run_id]?.deliveredAt)
    } catch (error) {
      result.delivered = false
      result.stateError = String(error?.message ?? error)
    }
  }

  result.bDoneFile = fs.existsSync(path.join(B_CWD, 'B_DONE.txt'))
  const changes = result.evidence.result?.changes ?? null
  const created = Array.isArray(changes?.created) ? changes.created.map((row) => row.path) : []
  const checks = Array.isArray(result.evidence.result?.checks) ? result.evidence.result.checks : []

  result.checks = {
    bRunCompleted: bDone.state === 'completed',
    bCreatedDoneFile: result.bDoneFile || created.includes('B_DONE.txt'),
    bChecksPassed: checks.length > 0 && checks.every((check) => check.passed === true),
    wakeMessageFound: Boolean(wake),
    aWokeAgain: posts.length >= 2,
    runMarkedDelivered: Boolean(result.delivered),
  }
  result.ok = Object.values(result.checks).every(Boolean)
  result.stage = 'done'
  save()
  log('E2E result', result.ok ? 'PASS' : 'FAIL', result.checks)
  host.close()
  process.exit(result.ok ? 0 : 2)
} catch (error) {
  result.stage = result.stage ?? 'error'
  result.error = String(error?.stack ?? error?.message ?? error)
  save()
  log('E2E error at', result.stage, String(error?.message ?? error))
  host.close()
  process.exit(1)
}
