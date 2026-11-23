# dsh-baton-native

Native DSH tools for [dsh-baton](https://github.com/JialaoLiu/dsh-baton) — route 3 of
[PLAN.md](./PLAN.md): no MCP, the plugin runs inside Harness and talks to the
already-installed `dsh-baton-host` over its documented NDJSON socket.

**M1 status:** plugin skeleton + `baton_workspaces`. Task tools and wake-up arrive in M2–M4.

## Layout

- `index.js` — Host plugin entry (`apply`, `inject`, tool registration)
- `lib/protocol.js` — NDJSON socket client (connect, request, long wait)
- `lib/socket.js` — endpoint resolution shared with the host (MIT, adapted)
- `PLAN.md` — full design, milestones and acceptance criteria

## Verify M1 locally

```powershell
# syntax
node --check index.js
node --check lib/protocol.js
node --check lib/socket.js

# live connectivity against a running Harness with dsh-baton-host
node scripts/probe-host.mjs
```

`probe-host.mjs` prints the host version/features and the workspaces, then exits 0.

## Install (development)

```powershell
dsh plugin --profile web add link:<absolute path to this folder>
```

Then restart that profile's Harness and create a new session; `baton_workspaces` should be in the
tool list.

## License

MIT. Adapted code keeps its upstream copyright notice (see `lib/socket.js`).
