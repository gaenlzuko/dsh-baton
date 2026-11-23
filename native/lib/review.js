// Appended to a task when the caller supplies checks. dsh-baton asks the worker to run a
// read-only self-check and to end its reply with a requirement table, so the wake-up can
// carry a point-by-point answer instead of only the worker's own prose.
//
// Same wording as upstream dsh-baton (src/core.mjs, MIT): Chinese when the message has CJK
// characters, English otherwise.
export function reviewRequest(message) {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(String(message ?? ''))
    ? '\n\n---\n完成后，启动一个只读子代理，对照上面的每一项需求检查，然后在最终回复末尾附上它的表格：需求 | 是否满足（是 / 否 / 不确定）| 证据（文件:行 或测试名）。标为"否"的先修好再回复。'
    : '\n\n---\nWhen the work is done, start a read-only sub-agent to check it against every requirement above, then end your final reply with its table: requirement | met (yes / no / unclear) | evidence (file:line or test name). Fix anything marked no before replying.'
}
