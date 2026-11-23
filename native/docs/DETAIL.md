# Baton Native

Native DSH tools for [dsh-baton](https://github.com/JialaoLiu/dsh-baton). Instead of mounting
baton's MCP server, this Host plugin runs inside DeepSeek Harness and speaks the documented
control-socket protocol to the already-installed `dsh-baton-host` plugin.

A DSH session **A** hands a task to an independent DSH session **B** with one tool call. B runs
live in the Harness sidebar; when it ends, the plugin wakes A **once** with the evidence:
changed files, the check commands that ran (exit codes and output tails) and B's final reply,
including its requirement-by-requirement review table.

**Status:** verified live (A → B → A) on DeepSeek Harness 0.2.2-rc.5. Full documentation,
design and the E2E record are in the package README, `docs/E2E.md` and `PLAN.md`.

## How it works

- `baton_send` calls the host socket (`send`), which creates or continues session B through
  Harness's own session controller; the call returns a `run_id` immediately.
- The plugin snapshots the target folder and starts one long `wait` per run (no polling).
- When the run ends, the watcher collects the evidence, builds a short report and injects it as
  one user-role message (`source = agent-message/relay`) into A with `agent.followup`.
- A run that stops to ask a person wakes A too; `baton_answer` submits answers.
- Delivery state is stored locally, so a plugin reload does not wake A twice for the same run.

## Tools

| Tool | What it does |
|---|---|
| `baton_workspaces` | Workspaces A can start a session in (id, path, title, session count). Read-only. |
| `baton_send` | `message` plus `session_id` or `cwd`/`workspace_id`, optional `mode`, `model`, `reasoning_effort`, `checks`. Returns `run_id` at once. With checks, the commands run when the run ends and a self-check/requirement-table request is appended to the task. |
| `baton_status` | Run or session progress (state, final text, waiting, question). Read-only. |
| `baton_read` | Recent messages of a session without waking it. Read-only. |
| `baton_cancel` | Stop the turn, sub-agents, background jobs and queued messages. |
| `baton_answer` | Answer the run's `ask_user_question` questions. |
| `baton_runs` | The runs this plugin started and whether their wake-up was delivered. Read-only. |

## The wake-up message

```text
[baton] run hrun-… finished: completed
session: session-…
final reply: …
changed files: created 1, modified 0, deleted 0
  created: B_DONE.txt
checks:
  PASS node --version (exit 0, 0.2s)
all checks passed: yes
full evidence: …\.dsh-baton\evidence\hrun-….json
next: baton_read(…), baton_send({session_id: …}), baton_status(…)
```

## Evidence

- Folder snapshot taken when the task is sent, compared when the run ends: created / modified /
  deleted files (capped; dependency and build folders are skipped).
- Check commands (up to 10) run in the target folder at the end: exit code, timing, output tail
  and `all_checks_passed`.
- With checks, B is asked to run a read-only self-check and end with a
  `requirement | met | evidence` table; the final reply carries it back.
- The full record is at `$DSH_BATON_HOME/evidence/<run_id>.json`; the wake-up carries a summary
  and that path.

## Requirements and install

- DeepSeek Harness 0.2.x with `dsh-baton-host` enabled in the same profile.
- Node.js 22.15+ (the Harness runtime satisfies this).
- Host socket at `~/.dsh-baton/host.sock` (a per-user pipe on Windows) or `DSH_BATON_SOCKET`.
- Install from a checkout: `dsh plugin --profile <profile> add link:<this folder>`, then restart
  that profile's Harness (or install through DSH's plugin manager) and check `baton_workspaces`
  in a new session.

## Configuration

Environment variables read by the plugin: `DSH_BATON_HOME` (default `~/.dsh-baton`),
`DSH_BATON_SOCKET`, `DSH_BATON_NATIVE_STATE` (default `~/.dsh-baton-native`). Run approvals are
controlled by the `dsh-baton-host` plugin page (`allow` auto-approves during hand-over runs;
`ask` leaves them to the user).

## Known limitations

- Subagents also see the tools (not restricted to root sessions yet), so recursion is possible.
- The snapshot is taken right after `baton_send`; a file changed in that instant can be missed.
- Checks run with Harness host permissions, not inside B's sandbox.
- `baton_answer` handles questions only; approvals stay in the Harness UI.
- Authentication is the host socket's owner-only access — the same trust as running `dsh`.

## Verification

Unit tests: `npm test` (20 tests). Live probe: `node scripts/probe-host.mjs`. Live A → B → A
driver and recorded result: `scripts/e2e-live.mjs` and `docs/E2E.md`.

## License

MIT. The socket helper, the evidence module and the review wording are adapted from dsh-baton's
MIT-licensed source (Copyright (c) 2026 JialaoLiu).
