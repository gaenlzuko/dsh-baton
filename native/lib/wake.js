// The message injected into the asking session when a baton run needs attention or
// ends. It carries the evidence dsh-baton produced (changed files, check results) —
// never a claim that came only from the other session's own reply.
import { randomUUID } from 'node:crypto'

const MAX_WAKE_BYTES = 32 * 1024
const MAX_FINAL_TEXT = 1500
const MAX_PATHS_PER_KIND = 15

const clip = (text, max) => {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function tableRows(text) {
  return String(text ?? '').split('\n').filter((line) => /^\s*\|.*\|\s*$/.test(line)).length
}

function changeLines(changes) {
  if (!changes) return ['changed files: (no folder snapshot)']
  const lines = []
  const counts = ['created', 'modified', 'deleted'].map((kind) => `${kind} ${changes[kind]?.length ?? 0}`)
  lines.push(`changed files: ${counts.join(', ')}${changes.truncated ? ' (listing truncated)' : ''}`)
  for (const kind of ['created', 'modified', 'deleted']) {
    const rows = changes[kind] ?? []
    if (rows.length === 0) continue
    const paths = rows.slice(0, MAX_PATHS_PER_KIND).map((row) => row?.path ?? String(row))
    lines.push(`  ${kind}: ${paths.join(', ')}${rows.length > paths.length ? ` … (+${rows.length - paths.length} more)` : ''}`)
  }
  return lines
}

function checkLines(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return []
  const lines = ['checks:']
  for (const check of checks) {
    const status = check.passed ? 'PASS' : check.timed_out ? 'TIMEOUT' : 'FAIL'
    const exit = check.exit_code === null || check.exit_code === undefined ? '?' : check.exit_code
    lines.push(`  ${status} ${check.command} (exit ${exit}${check.seconds !== undefined ? `, ${check.seconds}s` : ''})`)
    const tail = String(check.output_tail ?? '').trim()
    if (tail) lines.push(...tail.split('\n').slice(-8).map((line) => `    ${line}`))
  }
  return lines
}

export function buildFinishedText({ runId, run, evidence, evidenceFile }) {
  const lines = [
    `[baton] run ${runId} finished: ${run.state ?? 'completed'}`,
    `session: ${run.session_id ?? '?'}`,
    ...(run.error ? [`error: ${clip(run.error, 800)}`] : []),
    `final reply: ${clip(run.final_text, MAX_FINAL_TEXT) || '(no text)'}`,
    '',
    ...changeLines(evidence?.changes),
    ...(evidence?.worktrees ? [`worktrees: ${evidence.worktrees.map((w) => w.path).join(', ')}`] : []),
    ...(evidence?.same_folder_runs ? [`same-folder runs (their changes may overlap): ${evidence.same_folder_runs.join(', ')}`] : []),
    ...checkLines(evidence?.checks),
    ...(evidence && Object.prototype.hasOwnProperty.call(evidence, 'all_checks_passed')
      ? [`all checks passed: ${evidence.all_checks_passed ? 'yes' : 'NO'}`]
      : []),
    ...(evidenceFile ? [`full evidence: ${evidenceFile}`] : []),
    ...(tableRows(run.final_text) >= 2 ? ['review table: the final reply contains a requirement table (rows above).'] : []),
    '',
    `next: baton_read({session_id:"${run.session_id ?? ''}"}) to inspect the session; baton_send({session_id:"${run.session_id ?? ''}", message}) to continue it; baton_status({run_id:"${runId}"}) for status.`,
  ]
  const text = lines.join('\n')
  if (Buffer.byteLength(text, 'utf8') <= MAX_WAKE_BYTES) return text
  return `${clip(text, Math.floor(MAX_WAKE_BYTES / 2))}\n…(wake-up truncated; see the evidence file and the session)`
}

export function buildInputText({ runId, run }) {
  const question = run.question ? JSON.stringify(run.question) : '(no question text)'
  return [
    `[baton] run ${runId} is waiting for a person in session ${run.session_id ?? '?'}.`,
    `question: ${clip(question, 1200)}`,
    `answer with baton_answer({run_id:"${runId}", answers:[...]}) or in the Harness window; the run continues after the answer and its end still wakes you.`,
  ].join('\n')
}

export function buildLostText({ runId, entry, reason }) {
  return [
    `[baton] run ${runId} is no longer known to dsh-baton-host (${clip(reason, 300)}).`,
    `It was sent to session ${entry?.sessionId ?? '?'}; Harness may have restarted and dropped the run record.`,
    `Check the session with baton_read({session_id:"${entry?.sessionId ?? ''}"}) and decide whether to resend with baton_send.`,
  ].join('\n')
}

/** Wake the session that asked for a run. Returns why it could not be delivered. */
export async function deliverWake({ ctx, log, entry, text }) {
  if (!entry?.agentSessionId) {
    return { delivered: false, reason: 'the asking session was not recorded for this run' }
  }
  const controller = ctx?.sessionController
  if (typeof controller?.resolveAgent !== 'function') {
    return { delivered: false, reason: 'sessionController is unavailable in this Harness' }
  }
  let resolved
  try {
    resolved = await controller.resolveAgent(entry.agentSessionId)
  } catch (error) {
    return { delivered: false, reason: String(error?.message ?? error) }
  }
  if (!resolved?.agent) {
    const reason = resolved?.error?.code ?? resolved?.error?.message ?? 'session not available'
    return { delivered: false, reason: String(reason) }
  }
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    // Not kind 'user': a plugin must not inherit human authority (goal tools etc.).
    source: { kind: 'agent-message', form: 'relay', senderSessionId: entry.sessionId },
  }
  try {
    resolved.agent.followup(message)
  } catch (error) {
    log?.warn?.(`baton wake-up: could not queue the message for ${entry.agentSessionId}: ${error?.message ?? error}`)
    return { delivered: false, reason: String(error?.message ?? error) }
  }
  return { delivered: true }
}
