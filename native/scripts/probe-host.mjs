// M1 smoke test: connect to the running dsh-baton host and print its identity and
// workspaces. Exits 0 on success, 1 with the error otherwise.
import { BatonHost } from '../lib/protocol.js'

const host = new BatonHost({
  log: (message, extra) => {
    if (process.env.BATON_PROBE_DEBUG) console.error('[probe]', message, extra ?? '')
  },
})

try {
  const info = await host.ping()
  console.log(`host: ${info?.name ?? '?'} ${info?.version ?? '?'} (pid ${info?.pid ?? '?'})`)
  console.log(`features: ${(info?.features ?? []).join(', ') || 'none'}`)
  const rows = await host.workspaces()
  console.log(`workspaces: ${Array.isArray(rows) ? rows.length : 0}`)
  for (const row of rows ?? []) {
    console.log(`  - ${row.title ?? '(untitled)'} | ${row.path} | ${row.session_count ?? '?'} sessions | ${row.id}`)
  }
  host.close()
  process.exit(0)
} catch (error) {
  console.error(`probe failed: ${error?.message ?? error}`)
  host.close()
  process.exit(1)
}
