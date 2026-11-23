# dsh-baton-native

Native DSH tools for [dsh-baton](https://github.com/JialaoLiu/dsh-baton). Instead of mounting
baton's MCP server, this Host plugin runs inside DeepSeek Harness and speaks the documented
control-socket protocol to the already-installed `dsh-baton-host` plugin.

A DSH session **A** hands a task to an independent DSH session **B** with one tool call. B runs
live in the sidebar, and when it ends the plugin wakes A **once** with the evidence: changed
files, the check commands that ran (exit codes and output tails) and B's final reply, including
its requirement-by-requirement review table.

- English README · [中文说明](README.zh.md)
- Design and milestones: [PLAN.md](PLAN.md)
- Live A → B → A verification: [docs/E2E.md](docs/E2E.md)

## Why this exists

baton's original direction is external → DSH: Claude Code, Codex or Antigravity hand a task to a
Harness session through an MCP server. This plugin flips the same idea **inside** DSH: A and B are
ordinary Harness sessions, no MCP process is involved, and A receives an evidence-backed result
instead of the other agent's own prose.

Compared with the MCP route (mounting `dsh-baton-mcp` as an MCP server):

| | Native plugin (this) | MCP server mounted in DSH |
|---|---|---|
| Who asks | any DSH session | any MCP-capable session, but the tool result is synchronous |
| Result delivery | one proactive wake-up message (`agent.followup`) | the caller must wait in `dsh_wait` or poll |
| Sender label | native relay message | whatever the MCP client name maps to |
| Extra process | none | an MCP server process + schema bridging |

## Status

Verified live (A → B → A) on DeepSeek Harness **0.2.2-rc.5** — see [docs/E2E.md](docs/E2E.md).

- Tools: `baton_workspaces`, `baton_send`, `baton_status`, `baton_read`, `baton_cancel`,
  `baton_answer`, `baton_runs`.
- `baton_send` snapshots the target folder, starts a long `wait` watcher and returns at once.
- When the run ends, A gets one wake-up message with changed files, check results and the final
  reply; a run that stops to ask a person also wakes A so it can call `baton_answer`.
- A delivered run is not woken again when the plugin reloads.
- Not yet exercised live: several runs at once, a Harness restart mid-run, and the upstream PR.

## How it works

```text
session A (root)                         deepseek harness host process
   │  baton_send(...)                        ┌───────────────────────────────┐
   ├───────────────────────────────────────► │ dsh-baton-native (this plugin)│
   │  returns run_id immediately            └───────────────┬───────────────┘
   │                                                        │ NDJSON over the
   │                                                        │ owner-only socket
   │                                                        ▼
   │                                        ┌───────────────────────────────┐
   │                                        │ dsh-baton-host (already there)│
   │                                        └───────────────┬───────────────┘
   │                                                        │ sessionController
   │                                                        ▼
   │                                          session B (independent, live)
   │                                                        │ ends
   │                                                        ▼
   │  one wake-up message  ◄── watcher: wait → evidence → agent.followup(A)
   └─────────────────────────────────────────────────────────┘
```

- The plugin uses the same socket protocol the upstream MCP server uses
  (`host/PROTOCOL.md` in the baton repository): `ping`, `workspaces`, `send`, `status`,
  `read_session`, `wait`, `cancel`, `answer`, `list_runs`.
- A watcher issues one long `wait` per run (up to 24 h on the host side); it does not poll.
- The wake-up is a user-role message whose `source` is `agent-message/relay` (not `user`), so a
  plugin never inherits human authority such as goal-tool rights. It is delivered with
  `agent.followup`: if A is idle it starts a new turn; if A is running it is queued after the
  current turn.
- Delivery state is kept in `~/.dsh-baton-native/state.json` (or `DSH_BATON_NATIVE_STATE`);
  activation resumes watchers for runs that were never delivered.

## Requirements

| Requirement | Notes |
|---|---|
| DeepSeek Harness 0.2.x | Verified on 0.2.2-rc.5; the plugin uses public Host services (`tools`, `sessionController`) |
| `dsh-baton-host` in the same profile | Provides the socket and drives sessions; it must be enabled |
| Node.js 22.15+ | The Harness runtime satisfies this; the plugin itself has no dependencies |
| The host socket | `~/.dsh-baton/host.sock` (a per-user named pipe on Windows), or `DSH_BATON_SOCKET` |

## Install

Development / local checkout:

```powershell
# from the repository root; use --profile desktop for the Desktop app, --profile web for dsh web
dsh plugin --profile web add link:<absolute path to this native/ folder>
```

A newly added bundle is loaded when the Harness that owns the profile starts; DSH's plugin
manager can also install and activate it while Harness runs (`plugin_manager` `install_bundle`).
After installing, open a **new** session and check that `baton_workspaces` is listed and returns
the same folders as the Harness sidebar.

Uninstall:

```powershell
dsh plugin --profile web remove dsh-baton-native
```

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `baton_workspaces` | — | Lists Harness workspaces: id, path, title, session count. Read-only. |
| `baton_send` | `message` (required, ≤ 64 KiB), `session_id?`, `cwd?`, `workspace_id?`, `mode?` (`followup`/`steer`), `model?`, `reasoning_effort?`, `checks?` (≤ 10) | Creates a new session (needs `cwd` or `workspace_id`) or continues one (`session_id`); returns `run_id` at once. When `checks` are given, the commands run when the run ends and a short self-check/requirement-table instruction is appended to the task. |
| `baton_status` | `run_id?` or `session_id?`, `tail?` | Run state, recent events, final text, error, `waiting_on`, `needs_input`, question. Read-only. |
| `baton_read` | `session_id`, `last?` (1–50, default 20) | Recent messages of a session without waking it. Read-only. |
| `baton_cancel` | `run_id?` or `session_id?` | Stops the turn, sub-agents and background jobs, and drops queued messages. |
| `baton_answer` | `run_id?` or `session_id?`, `answers` (one per open question: `id?`, `choose?`, `text?`, `skip?`) | Answers `ask_user_question` from the run. Approvals are not answerable here; handle them in the Harness UI. |
| `baton_runs` | `limit?` (1–100, default 20) | The runs this plugin started: run id, target session, asking session, delivery state. Read-only. |

## The wake-up message

Example (from the live verification):

```text
[baton] run hrun-mwspm3qf-0191d7 finished: completed
session: session-96b57f2b-…
final reply: B_DONE.txt created and verified byte-for-byte.
  | requirement | met (yes/no) | evidence (file:line or test name) |
  …
changed files: created 1, modified 0, deleted 0
  created: B_DONE.txt
checks:
  PASS node --version (exit 0, 0.2s)
all checks passed: yes
full evidence: …\.dsh-baton\evidence\hrun-mwspm3qf-0191d7.json
review table: the final reply contains a requirement table (rows above).

next: baton_read(…), baton_send({session_id: …}) to continue, baton_status(…)
```

If the run stops to ask a person, A receives a shorter message with the question and how to
answer it (`baton_answer`, or the Harness window).

## Evidence

Evidence is produced by the plugin, not by the other session's own reply:

- **Folder snapshot** — taken when the task is sent, compared when the run ends:
  `changes.created`, `changes.modified`, `changes.deleted` (path entries; the listing is capped
  and flagged `truncated`, and dependency/build folders are skipped).
- **Checks** — up to 10 commands run in the target folder when the run ends:
  `{ command, passed, exit_code, timed_out?, seconds, output_tail }` plus `all_checks_passed`.
  Checks run in the Harness host process (not inside B's sandbox), with `CI=1`, a 120 s
  per-command and 180 s total budget.
- **Requirement table** — when `checks` are given, the plugin appends a request that B start a
  read-only sub-agent, check every requirement and end its reply with
  `requirement | met | evidence`. The final reply (table included) travels in the wake-up.
- **Worktrees / same-folder runs** — passed through when the host reports them: a session that
  moved into a Git worktree, or other runs that changed the same folder concurrently.
- The full evidence record is stored at `$DSH_BATON_HOME/evidence/<run_id>.json`; the wake-up
  carries a summary and that path.

## Delivery, retries and recovery

- Exactly one wake-up per finished run; the delivered flag lives in the state file.
- If A's session cannot be resolved (archived, deleted), delivery fails and the run stays
  undelivered; the next plugin activation retries through `agent.followup`.
- If the run is no longer known to the host (for example after a Harness restart), A is woken
  with a "run lost" message that points at the target session.
- A question may be answered from A (`baton_answer`) or from the Harness window; whoever answers
  first wins.
- `baton_runs` shows which runs are delivered and which are still pending.

## Configuration

There is no per-session config UI in this version; the plugin reads environment variables from
the Harness process:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BATON_HOME` | `~/.dsh-baton` | Baton home (socket, settings, evidence) |
| `DSH_BATON_SOCKET` | `$DSH_BATON_HOME/host.sock` | Explicit socket path or Windows pipe name |
| `DSH_BATON_NATIVE_STATE` | `~/.dsh-baton-native` | This plugin's run registry |
| `DSH_BATON_AUTO_REGISTER` | `1` | Upstream host behaviour: register baton's MCP server for Claude Code/Codex; set `0` to skip when testing |

Approval policy for the runs comes from the `dsh-baton-host` plugin page in Harness (`allow` —
auto-approve during hand-over runs, the upstream default — or `ask`, leaving approvals to the
user in the target session).

## Verification

```powershell
# unit tests: protocol framing, evidence, tool surface, watcher/wake, reload dedupe
npm test

# live connectivity to a running Harness with dsh-baton-host
node scripts/probe-host.mjs

# live A -> B -> A on an isolated instance (see docs/E2E.md for the full recipe)
node scripts/e2e-live.mjs
```

The current suite has 20 tests. The live run recorded every check as true: B completed and
created its file, checks passed, the wake-up was found in A's session log, A woke again, and the
run was marked delivered.

## Known limitations

- Not restricted to root sessions yet: subagents also see the `baton_*` tools, so a subagent can
  start another session (recursion is possible). Treat this as a development limitation.
- The folder snapshot is taken right after `baton_send` returns; a file B changes in that instant
  can be missed (upstream has the same race).
- Checks run with the Harness host's permissions, not inside B's sandbox; only pass commands you
  would run yourself.
- `baton_answer` answers `ask_user_question` only. Tool approvals must be handled in the Harness
  window or pre-approved through the host's `approvals` setting.
- Multi-run concurrency and restart-mid-run are covered by unit tests but not yet by a live run.
- There is no panel or button; everything happens through the tools and the wake-up message.
- The socket grants the current OS user full control of Harness sessions — the same trust as
  running `dsh` directly. Evidence files can contain paths and command output; do not share them
  carelessly.

## Development

```text
native/
  index.js            Host plugin entry: tools, watcher, evidence wiring
  lib/protocol.js     NDJSON client for the host socket (long wait, reconnect)
  lib/socket.js       Endpoint resolution shared with the host (MIT, adapted)
  lib/evidence.js     Folder snapshot / checks (MIT, adapted from baton)
  lib/wake.js         Wake-up text and agent injection
  lib/watcher.js      One long wait per run, retries, delivery state
  lib/state.js        Run registry (`~/.dsh-baton-native/state.json`)
  lib/format.js       Model-facing renderings
  lib/review.js       Self-check request appended when checks are given
  test/               node:test suite
  scripts/            probe and live e2e drivers
  docs/               plugin detail page, E2E record
```

Branch: `feat/dsh-native` in the fork. Upstream files are untouched; all additions live under
`native/`. `git diff <upstream-base>..HEAD` should list only `native/`.

## License

MIT. `lib/socket.js`, `lib/evidence.js` and the review wording are adapted from dsh-baton's
MIT-licensed source (Copyright (c) 2026 JialaoLiu); the adapted files keep that notice.
