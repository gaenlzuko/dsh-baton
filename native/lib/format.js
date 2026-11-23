// Human- and model-readable renderings of the host protocol results. Keep them
// compact: the tool result is model context, not a log dump.

const clip = (text, max = 600) => {
  const value = String(text ?? '').replace(/\r\n/g, '\n').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function formatWorkspaces(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'No workspaces are registered in this Harness. A new session needs a folder; register one in the Harness sidebar first.'
  }
  return rows.map((workspace, index) => {
    const count = Number.isFinite(workspace?.session_count) ? `, ${workspace.session_count} sessions` : ''
    return `${index + 1}. ${workspace?.title || '(untitled)'} — ${workspace?.path}${count}\n   id: ${workspace?.id}`
  }).join('\n')
}

export function formatSend(result) {
  const lines = [
    `Started run ${result.run_id} in session ${result.session_id} (state: ${result.state}).`,
    result.admission_pending
      ? 'The message is still queued; Harness has not taken it in yet.'
      : 'The session is running in the Harness sidebar now.',
    `message: ${clip(result.message_preview, 200)}`,
  ]
  if (Array.isArray(result.other_active_runs) && result.other_active_runs.length > 0) {
    lines.push(`other active runs in this session: ${result.other_active_runs.join(', ')}`)
  }
  if (result.workspace) lines.push(`workspace: ${result.workspace.path ?? result.workspace.id ?? result.workspace}`)
  lines.push('Check progress with baton_status (run_id or session_id) or baton_read (session_id).')
  return lines.join('\n')
}

export function formatStatus(result) {
  if (!result) return 'No status returned by the host.'
  if (result.session_id && !result.run_id && result.turn_running === undefined) {
    return `session ${result.session_id}\n${clip(JSON.stringify(result, null, 2), 1200)}`
  }
  const lines = [
    `run: ${result.run_id ?? '(session status)'}`,
    `session: ${result.session_id ?? '?'}`,
    `state: ${result.state ?? (result.turn_running ? 'running' : 'idle')}`,
    ...(result.started_at ? [`started: ${result.started_at}`] : []),
    ...(result.ended_at ? [`ended: ${result.ended_at}`] : []),
    ...(result.model ? [`model: ${result.model.provider ?? ''}/${result.model.model ?? result.model}`] : []),
    ...(result.waiting_on ? [`waiting_on: ${clip(JSON.stringify(result.waiting_on), 400)}`] : []),
    ...(result.needs_input ? [`needs_input: ${result.needs_input}`] : []),
    ...(result.question ? [`question: ${clip(JSON.stringify(result.question), 800)}`] : []),
    ...(result.error ? [`error: ${clip(result.error, 800)}`] : []),
    ...(result.final_text ? [`final_text: ${clip(result.final_text, 1500)}`] : []),
    ...(result.left_running ? [`left_running: ${clip(JSON.stringify(result.left_running), 400)}`] : []),
    ...(result.timed_out ? ['(wait timed out; the run is still active)'] : []),
  ]
  return lines.join('\n')
}

export function formatRead(result) {
  if (!result) return 'No session returned by the host.'
  const header = [
    `session: ${result.session_id}${result.archived ? ' (archived)' : ''}`,
    `title: ${result.title ?? '(untitled)'}`,
    `cwd: ${result.cwd ?? '?'}`,
    `messages: showing the last ${result.messages?.length ?? 0} of ${result.total_messages ?? '?'}`,
  ].join('\n')
  const rows = (result.messages ?? []).map((message) => {
    const tools = Array.isArray(message.tools) && message.tools.length > 0 ? ` [tools: ${message.tools.join(', ')}]` : ''
    return `\n[${message.role}${message.time ? ` ${message.time}` : ''}]${tools}\n${clip(message.text, 1200) || '(no text)'}`
  })
  return `${header}\n${rows.join('\n')}`
}

export function formatCancel(result) {
  return [
    `cancel requested for session ${result.session_id}`,
    `attempts: ${result.attempts ?? '?'}; still busy: ${result.still_busy === true ? 'yes' : 'no'}`,
    ...(Array.isArray(result.queued_runs) && result.queued_runs.length > 0 ? [`queued runs: ${result.queued_runs.join(', ')}`] : []),
    ...(Array.isArray(result.removed_from_queue) && result.removed_from_queue.length > 0
      ? [`removed from queue: ${result.removed_from_queue.join(', ')}`]
      : []),
  ].join('\n')
}

export function formatRuns(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 'No baton runs have been started by this plugin yet.'
  return entries.map((entry) => {
    const delivered = entry.deliveredAt ? 'delivered' : 'pending wake-up'
    return `${entry.runId} | session ${entry.sessionId} | ${delivered} | asked by ${entry.agentSessionId ?? '?'} | ${clip(entry.messagePreview, 120)}`
  }).join('\n')
}
