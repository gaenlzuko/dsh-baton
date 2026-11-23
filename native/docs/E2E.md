# Live end-to-end verification

First real A → B → A run of `dsh-baton-native` inside a Harness instance (route 3).

| | |
|---|---|
| Date | 2026-11-23 |
| Host | Windows, DeepSeek Harness 0.2.2-rc.5 |
| Instance | `dsh web --port 0 --no-open`, profile `web`, link-installed native plugin |
| dsh-baton-host | 0.6.19 |
| Isolation | temporary `DSH_BATON_HOME`, `DSH_BATON_NATIVE_STATE` and `DSH_BATON_AUTO_REGISTER=0`; the running desktop instance was untouched |
| Driver | [`scripts/e2e-live.mjs`](../scripts/e2e-live.mjs) over the host socket |

## Flow

1. An external client (the host socket) created session **A** and prompted its model:
   *call `baton_send` with `cwd = <temp workspaceB>`, `checks = ["node --version"]`, and a message
   asking for `B_DONE.txt` plus a requirement table.*
2. A's model called **`baton_send`**; the plugin created independent session **B** and returned
   `run_id` immediately.
3. B ran in the Harness instance: wrote `B_DONE.txt`, answered with a requirement table, ended.
4. The plugin's watcher collected evidence (folder diff + checks) and woke **A exactly once**
   with one `agent-message/relay` user message starting `[baton] run … finished: completed`.
5. A's model replied to the wake-up; the plugin marked the run delivered.

## Result (all checks true)

- B run `completed`, and B created `B_DONE.txt`.
- Evidence `changes.created`: `B_DONE.txt`; `changes.modified/deleted`: none.
- `checks`: `node --version` → passed, exit 0; `all_checks_passed: true`.
- Wake message found in A's session log (`user/message` with `source.kind = "agent-message"`),
  carrying the changed file, the check result and B's final reply (with its requirement table).
- A's assistant message count went 1 → 2 (the wake-up started a new turn and the model replied).
- Plugin state recorded `deliveredAt` for the run.

## Reproduce

```powershell
# 1. start an isolated instance (its host socket lives under the temporary baton home)
$base = "<temp dir>"
$env:DSH_BATON_HOME = "$base\baton-home"
$env:DSH_BATON_NATIVE_STATE = "$base\state"
$env:DSH_BATON_AUTO_REGISTER = "0"
Start-Process dsh -ArgumentList "web","--port","0","--no-open"

# 2. drive the flow (needs zstd to read A's session log)
$env:E2E_A_CWD = "$base\workspaceA"
$env:E2E_B_CWD = "$base\workspaceB"
$env:E2E_RESULT = "$base\result.json"
node native/scripts/e2e-live.mjs
```

The driver exits 0 with every check true, writes `result.json`, and prints the evidence.
Test sessions can be removed from `$DSH_HOME\sessions` after stopping the instance.
