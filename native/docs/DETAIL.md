# Baton Native

Native DSH tools for [dsh-baton](https://github.com/JialaoLiu/dsh-baton). Instead of mounting
baton's MCP server, this Host plugin runs inside DeepSeek Harness and speaks the documented
control-socket protocol to the already-installed `dsh-baton-host` plugin.

The goal (see [PLAN.md](../PLAN.md)): a DSH session A hands a task to an independent DSH session B
with one tool call, B runs live in the sidebar, and when B ends a single wake-up message returns the
evidence — changed files, checks that ran, and a requirement-by-requirement review table.

## Status

M3: task tools and the wake-up.

- Tools: `baton_workspaces`, `baton_send`, `baton_status`, `baton_read`, `baton_cancel`, `baton_runs`.
- `baton_send` snapshots the target folder, starts a long `wait` watcher, and returns at once.
- When the run ends, the asking session gets one wake-up message with changed files, check
  exit codes/output and the final reply (including any requirement table); a run that stops to
  ask a person also wakes the asking session so it can call `baton_answer` (M4) or answer in the
  Harness window.
- Remaining: `baton_answer`, multi-run/restart recovery polish, live end-to-end verification.

## Requirements

- DeepSeek Harness 0.2.x with the `dsh-baton-host` plugin enabled in the same profile.
- Node.js 22.15 or newer (the Harness runtime satisfies this).
- The host socket at `~/.dsh-baton/host.sock` (on Windows a per-user named pipe), or
  `DSH_BATON_SOCKET` pointing at it.

## Install (development)

```powershell
# from the repository root
dsh plugin --profile web add link:<absolute path to this native/ folder>
```

Restart the Harness that owns the profile, then in a new session check that `baton_workspaces`
is listed and returns the same folders as the Harness sidebar.

## Known limitations

- M1 is read-only; it cannot create or wake sessions yet.
- The host must be running in the same process/profile as the plugin; otherwise tools report a
  clear connectivity error.
- The socket grants its owner (the current OS user) full control of Harness sessions — the same
  trust as running `dsh` directly.

## License

MIT. The socket helper and the evidence format are adapted from dsh-baton's MIT-licensed source.
