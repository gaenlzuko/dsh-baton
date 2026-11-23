# dsh-baton-native — 路线 3 详细计划

> 状态：草案 v0.1（2026-11-23）
> 上游：JialaoLiu/dsh-baton 0.6.19（MIT，commit `318b6cd`）
> 目标宿主：DeepSeek Harness 0.2.2-rc.5（desktop / web profile）
> 本文是 fork 内的设计文档；实现完成后可作为 upstream PR 的说明。

---

## 0. 一句话目标

给 DSH 加一个**原生 Host 插件** `dsh-baton-native`：DSH 会话 A 用原生工具把任务交给独立会话 B（B 在侧栏里实时可见、可接管），B 结束后**自动唤醒 A 一次**，唤醒消息带回 baton 式证据链——**改了哪些文件、跑了什么测试（exit code + 输出尾部）、逐条需求核对表**。A 不需要轮询，也不需要挂 MCP。

## 1. 背景与现状

- baton 的 MCP 路线已在上一轮评估过：能用，但 DSH 的 MCP 调用是同步的、`dsh_wait` 对非 Codex 客户端默认 50s、发送者标签/审批语义不贴合 DSH 内部使用。
- 上游代码把能力分成两半：
  - **MCP server**（`src/*.mjs`）：任务语义、等待策略、证据链（`evidence.mjs`）、review 提示词（`core.mjs` 的 `reviewRequest`）、客户端注册（`register.mjs`）。
  - **Host 插件**（`host/lib/*.js`）：跑在 DSH 进程里，用宿主自己的会话控制器创建/继续会话，并对外提供文档化的 **NDJSON socket 协议**（`host/PROTOCOL.md`）。
- 本机事实（2026-11-23 实测）：`desktop`/`web` profile 均已安装 `dsh-baton-host@0.6.16`；`~/.dsh-baton/app/src/server.mjs` 可用；host socket 存活（`node ~/.dsh-baton/app/src/cli.mjs workspaces` 能列出工作区）；`~/.dsh-baton/evidence/` 有历史运行证据。**宿主侧无需改动**。
- 因此路线 3 = 在同一个 DSH 进程里再写一个 Host 插件，直接复用宿主 socket，只新增"工具面 + 唤醒 + 证据呈现"，不把 MCP 当载体。

## 2. 目标与非目标

### 目标（MVP）

1. A 调 `baton_send` 创建/继续 B（独立顶层会话），立即返回 `run_id`；B 出现在侧栏，实时可看、可打断。
2. B 结束时，A **被唤醒一次**（不轮询），唤醒消息包含：状态、final_text 摘要、改动文件清单、checks 结果、B 回复中的需求核对表。
3. A 能用 `baton_status` / `baton_read` 查看、`baton_cancel` 取消、`baton_answer` 回答 B 的提问；可继续在同一 B 上追问。
4. 多个 B 并行、插件重载/宿主重启后不重复唤醒、不丢唤醒。
5. 证据链在 Windows + DSH 0.2.2-rc.5 上端到端验证通过。
6. 改动与上游隔离在 `native/` 内，便于提 PR 或独立发布。

### 非目标（本阶段不做）

- 不改上游 `src/` / `host/`（除非发现必须的小补丁，单独评估）。
- 不做 MCP 挂载（上一轮路线 1 已验证可行，作为对比保留）。
- 不做独立 UI 面板/客户端插件（先用普通会话 + 唤醒消息；后续可加）。
- 不实现审批代批（protocol 没有审批通道；审批仍由宿主策略与 B 的界面处理，A 只收到提示）。
- 不做跨机器/远程。

## 3. 关键决策（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 走宿主 socket 协议，不 fork host 内部 | `host/PROTOCOL.md` 是文档化契约；`host/lib` 是编译产物，直接改难维护；协议升级风险可控（`ping.version/features`） |
| D2 | 发送非阻塞，结束用 `agent.followup()/steer()` 注入唤醒 | DSH 没有"异步工具结果"；插件在宿主内，能拿到 A 的 agent 并主动注入（baton 的"wake once"语义） |
| D3 | 唤醒消息的 `source` 必须是非人类来源 | DSH 约定：`followup/steer` 省略 source 会默认 `{kind:'user'}`，插件必须传自己的 source（`dsh-tool-goal` README 明确要求），避免继承人类权限 |
| D4 | 证据链三件套 = 快照 diff + checks + 只读复核表 | 与 baton 对齐：`src/evidence.mjs` 的 snapshot/collect/recheck + checks；`reviewRequest` 提示 B 在回复末尾附"需求\|是否满足\|证据"表格（由 B 自己启动只读子代理完成） |
| D5 | 不自动批准审批 | 宿主 `approvals: allow` 是 baton 页面设置；本插件默认不改策略，遇到 `waiting` 唤醒 A 提示用户去 B 处理 |
| D6 | 工具仅对根会话开放 | baton 对子 agent 隐藏 `dsh_*` 工具；本插件同样在 `agent/created` 时对子代理限制，防止递归/越权 |
| D7 | 状态落 `~/.dsh-baton-native/state.json` | 与 baton 的 `~/.dsh-baton` 分开，便于卸载/排障；只存 run→A 映射与 delivered 标记，不存正文 |

## 4. 架构

```text
DSH Host 进程
├─ session A (agent) ── tools: baton_send / status / read / cancel / answer / runs
│        │  (ctx.tools.register)
│        ▼
│  dsh-baton-native (Host 插件, native/index.js)
│    ├─ lib/protocol.js   NDJSON socket 客户端（request/response + 长 wait + 重连）
│    ├─ lib/watcher.js    每个 run 一个后台 watcher：长 wait → 证据 → 唤醒 A
│    ├─ lib/evidence.js   快照/对比/checks（复用/改编 src/evidence.mjs，MIT 署名）
│    ├─ lib/format.js     证据 → 唤醒消息（Markdown，截断 + 完整 JSON 路径）
│    └─ lib/state.js      run→session 映射、delivered、恢复
│        │
│        ▼  (owner-only socket, NDJSON)
└─ dsh-baton-host (已存在) ── 用宿主 sessionController 创建/继续/取消会话
     └─ session B (agent) —— 在侧栏实时运行，可接管
```

数据流（一次任务）：

1. A 调 `baton_send({message, cwd, checks})` → 插件先对 `cwd` 做快照（`evidence.prepare`），再经 socket `send` 创建 B，拿到 `run_id`；立即返回。
2. 插件为 `run_id` 启动 watcher：socket `wait {run_id, timeout_s: 86400}` 挂起（宿主端 waiters 唤醒，不占 CPU）。
3. B 跑完 → `wait` 返回 `publicRun`（`state/final_text/...`）→ 插件跑 `evidence.collect()`（对比快照 + 执行 checks）→ 组装唤醒文本。
4. 插件 `ctx.sessionController.resolveAgent(A)` → `agent.followup(createUserMessage({content, source}))` 唤醒 A；记录 delivered。
5. A 继续：可 `baton_send({session_id})` 追问、`baton_read` 查看、`baton_status` 查状态、`baton_cancel` 取消。
6. B 停下来问问题 → `wait` 返回 `needs_input: 'answer'` → 唤醒 A（提示"B 在等你回答"，附问题）→ A 用 `baton_answer` 提交。

## 5. 仓库与分支

```text
dsh-baton/                     # fork 仓库（origin = <user>/dsh-baton, upstream = JialaoLiu/dsh-baton）
├─ src/                        # 上游 MCP server（不改）
├─ host/                       # 上游 DSH 插件（不改）
├─ native/                     # 本计划新增
│  ├─ package.json             # name: dsh-baton-native; dsh.bundle.patch; exports ./locale/*, ./icon
│  ├─ cordis.patch.yml         # insert: id: baton-native
│  ├─ index.js                 # apply(ctx, config)
│  ├─ lib/protocol.js
│  ├─ lib/watcher.js
│  ├─ lib/evidence.js
│  ├─ lib/format.js
│  ├─ lib/state.js
│  ├─ locale/{en,zh}.json
│  ├─ docs/DETAIL.md
│  ├─ icon.svg
│  ├─ test/*.test.mjs          # node --test
│  └─ PLAN.md                  # 本文件
└─ docs/native.md              # 安装/使用/限制（可选，PR 用）
```

分支：`feat/dsh-native`。fork 未创建前本地先写好；创建后：

```sh
git remote rename origin upstream
git remote add origin https://github.com/<user>/dsh-baton.git
git push -u origin feat/dsh-native
```

## 6. 工具面（MVP）

所有工具返回结构化文本（JSON 或表格文本），错误带可行动说明。

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `baton_send` | `message`（必填，≤64KB）；`cwd?`/`workspace_id?`/`session_id?`；`mode?`（followup/steer）；`model?`/`reasoning_effort?`；`checks?: string[]`（≤10）；`review?: boolean`（默认 true，追加需求核对提示） | `{run_id, session_id, state, ...}` | 新会话需 cwd/workspace_id；给了 session_id 则继续 B。创建前做证据快照 |
| `baton_status` | `run_id?` 或 `session_id?`；`tail?` | `publicRun`（含 `state/final_text/waiting_on/question/needs_input`） | 只读 |
| `baton_read` | `session_id`；`last?`（默认 20，≤50） | 最近消息/工具记录 | 不唤醒目标 |
| `baton_cancel` | `run_id?` 或 `session_id?` | 取消结果 | 会停 turn/subagents/jobs |
| `baton_answer` | `run_id`；`answers: [{id?, choose?, text?, skip?}]` | 提交结果 | 回答 B 的 `ask_user_question` |
| `baton_runs` | `limit?` | 本插件登记的 run 列表（run_id/session/A/delivered/state） | 排障与重投递 |
| `baton_wait` | `run_id`；`timeout_s?`（≤3540） | 阻塞版 `wait` | 可选，给脚本/明确同步场景；默认推荐非阻塞 |

命名空间：`baton_*`（避免与上游 MCP 的 `dsh_*` 混淆）。工具只在根会话注册；子代理上下文限制掉。

### 工具注册要点

- 插件导出：`export const name = 'dsh-baton-native'`；`export const inject = ['tools','sessionController']`；`export function apply(ctx, config)`；`export const Config`（schemastery）。
- 所有注册放 `ctx.effect(...)`；socket 连接、watcher 定时器、事件监听都要在 dispose 时清理。
- 工具定义按 `@deepseek-ai/dsh-tools` 的 `ctx.tools.register` 形状（以 dsh-tools README/类型为准），参数用 JSON Schema；描述按 `references/tool-design.md` 写行为而非实现。

## 7. Watcher 状态机

```text
send ──► queued ──► running ──► (completed | failed | cancelled | interrupted)
                      │  ▲
                      ▼  │
                   waiting（needs_input / harness-ui approval）
```

- `wait` 返回：`state` 为活动态且 `timed_out: true` → 续 `wait`（长超时，不轮询）；`needs_input` → 唤醒 A 并标记该 episode 已通知（宿主 `waitNoticed` 保证一次）；`done` → collect 证据 → 唤醒 → delivered。
- 宿主侧状态：`queued/running/waiting/completed/failed/cancelled/interrupted`（`host/lib` 定义）。
- watcher 键：`run_id`；值：`{aSessionId, createdAt, delivered, lastState, attempts}`。
- 退避：socket 断线 250ms→10s 重连；`wait` 失败重试最多 5 次，之后写 `state.json` 并在 `baton_runs` 显示。
- 插件重载：`apply` 时 `ping` → `list_runs` → 对活动 run 重启 watcher；对已结束未 delivered 的补投递。
- 宿主重启：socket 关闭 → 重连 → 重新 `wait`；`interrupted` 状态的 run 也要唤醒 A（带 `interrupted` 说明）。
- 限制：同时 watcher 数默认 16，超出排队；单条唤醒消息 ≤ 32KB（超了给摘要 + 完整证据 JSON 路径）。

## 8. 证据链

复用上游 `src/evidence.mjs`（MIT，文件头注明 `Adapted from dsh-baton, MIT, Copyright (c) 2026 JialaoLiu`）：

- `prepare(home, {run_id, session_id, cwd, checks})`：在 `baton_send` 时对目录做文件快照（`before.json`），记录 checks。
- `collect(home, runId)`：run 结束时对比快照，返回：
  - `changes: {created:[{path,...}], modified:[...], deleted:[...], truncated?}`
  - `worktrees`（若会话切换了 worktree）、`same_folder_runs`（同目录并发提示）
  - `checks: [{command, passed, exit_code, ...}]`、`all_checks_passed`
- `recheck(home, runId)`：重跑 checks（可选，供 `baton_status --recheck` 未来用）。
- checks 执行：cwd 固定为会话目录（宿主返回的 cwd），超时/失败语义沿用上游（单条超时、总预算、`skipIfMissing` 可选）。
- 需求核对表：`baton_send` 默认在消息末尾追加 `reviewRequest(message)`（中文/英文按消息语言），要求 B 自己启动只读子代理，在最终回复末尾输出 `需求 | 是否满足 | 证据` 表格。A 的唤醒消息提取 `final_text` 尾部表格（若存在）。
- 证据落盘：`~/.dsh-baton/evidence/<run_id>.json`（与上游共用目录，键为 run_id，不冲突）；唤醒消息里给完整路径供 A 用 `read` 查看。
- 截断：路径列表默认 20 条 + 总数；checks 输出每条尾部 40 行；表格原文 4KB。

## 9. 唤醒注入

- 获取 A：`ctx.sessionController.resolveAgent(sessionId)`（冷会话会恢复；失败则重试一次，仍失败写 `undelivered`）。
- 消息构造：`createUserMessage({ content: [{type:'text', text}], source })`（`@deepseek-ai/dsh-llm`）。
- `source`：优先 `{ kind:'agent-message', form:'relay', senderSessionId: <B session id> }`（与 `dsh-session-messaging` 一致的既有语义）；若 DSH 校验不允许，退回插件自定义 source（实现时确认 dsh-llm 的 source 联合类型）。
- 投递：
  - A 空闲 → `agent.followup(message)`（唤醒新回合）。
  - A 运行中 → 默认 `followup`（排到当前轮之后）；配置 `wakeDelivery: steer` 可插入当前轮。
- 去重：`state.json` 记录 `run_id → deliveredAt`；注入前检查；注入成功后写盘（先写 delivering，再 delivered，崩溃可恢复）。
- 唤醒文本模板（示例）：

```text
[baton] run hrun-xxx 结束：completed（会话「重构登录」/ <session-id>）
摘要：<final_text 前 800 字>
改动：created 3 / modified 5 / deleted 1（前 20 个路径，完整见 evidence JSON）
检查：npm test ✅ exit 0（12.3s）；lint ❌ exit 2（输出尾部…）
需求核对表：<从 final_text 提取>（没有则说明"B 未附核对表"）
下一步：baton_send({session_id}) 继续；baton_status 查看；证据：<path>
```

## 10. 配置（Config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `socketPath` | 宿主默认（`~/.dsh-baton/host.sock`；Windows 命名管道） | 与 `DSH_BATON_SOCKET` 二选一 |
| `waitTimeoutS` | 86400 | 单次 `wait` 的超时；断线后会重连再 wait |
| `wakeDelivery` | `followup` | `followup` / `steer` |
| `wakeMaxBytes` | 32768 | 唤醒消息上限（超出截断并给证据路径） |
| `maxWatchers` | 16 | 并发 watcher 上限 |
| `reviewRequest` | true | 是否追加需求核对提示 |
| `checksMax` | 10 | 每次任务 checks 上限 |
| `evidenceDir` | `~/.dsh-baton/evidence` | 与 baton 共用 |
| `stateDir` | `~/.dsh-baton-native` | 本插件状态 |
| `minHostVersion` | `0.6.0` | 低于此版本工具报错并提示升级 |

配置校验失败回默认值并告警；不因配置错误让插件起不来。

## 11. 权限与安全

- socket 仅本用户可访问（上游实现：Unix 0600 / Windows 命名管道）；同用户进程可驱动 Harness，这一点与直接跑 `dsh` 相同，文档写明。
- 插件不自动批准任何审批；B 的审批仍按宿主 `dsh-baton-host` 页面的 `approvals` 设置。若为 `ask`，`wait` 会返回 `needs_input: 'harness-ui'`，插件唤醒 A 提示"去 B 处理审批"。
- 唤醒消息 source 非 user，不继承人类权限（防止 A 被注入后调用 goal 等人类受限工具）。
- 工具对子代理限制：`agent/created` 时 `ctx.tools.restrict` 或预设层限制，避免递归派发；限制规则与 baton 对齐。
- 证据 JSON 可能含文件路径与 checks 输出：留在本机 `~/.dsh-baton/evidence`，文档提示不要贴到外部。

## 12. 测试计划

- 单元（`node --test`）：
  - NDJSON 分包/半包解析、request id、超时、重连、并发请求；
  - 消息格式化（截断、中文/英文模板）、证据 diff（临时目录、created/modified/deleted）、checks 通过/失败/超时；
  - 状态去重（重复 wait 不重复投递）、恢复流程（state.json 重建）。
- 假宿主：`net.createServer` 实现 ping/send/status/wait/list_runs 子集，模拟 waiting/needs_input/断线。
- 端到端（web profile）：真实宿主 + 真实 B 会话：
  1. `baton_send` 带 checks → B 出现在侧栏；
  2. B 改文件 + 跑测试 → A 收到一条唤醒，含 changes/checks/核对表；
  3. 追问同一 B；取消；B 提问 → A 收到问题 → `baton_answer`；
  4. 并行 2 个 B；插件 disable/enable；重启 `dsh web` → 不重复、不丢唤醒。
- 回归：`npm test`（上游 20 个测试文件）保持全绿；上游文件零改动。
- Windows：命名管道路径、路径大小写、快照性能（大目录上限）。

## 13. 里程碑与验收

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M0 | fork/克隆/分支/本计划（部分完成） | 0.5d |
| M1 | 插件骨架 + protocol 客户端 + `ping`/`workspaces` + 安装到 web profile | 0.5d |
| M2 | `baton_send`/`status`/`read`/`cancel`；B 创建并在侧栏可见 | 1d |
| M3 | watcher + 唤醒注入 + 证据（changes/checks）+ 核对表提示 | 1.5d |
| M4 | `baton_answer`、多 run、重载/重启恢复、去重 | 1d |
| M5 | 单元/假宿主测试 + 文档 + locale + icon | 1d |
| M6 | web profile 端到端 + Windows 修复 + 验收记录 | 1d |
| M7 | upstream PR 草案（或独立发布方案） | 0.5d |

**验收标准**

- [ ] A 调 `baton_send` 后 1s 内返回 `run_id`，B 会话出现在侧栏并实时运行；
- [ ] B 结束 5s 内 A 收到**恰好一条**唤醒；消息含 changes/checks/核对表（或明确说明缺失）；
- [ ] A 不轮询即可继续（`baton_status` 可选）；
- [ ] `baton_send({session_id})` 追问同一 B 正常；
- [ ] `cancel`/`answer`/多 run 正常；
- [ ] 插件重载、`dsh web` 重启后不重复唤醒、不丢唤醒；
- [ ] 上游 `npm test` 全绿、上游文件未改；
- [ ] Windows + 0.2.2-rc.5 web profile 实测；desktop 记录步骤与结果；
- [ ] 卸载后无残留 watcher/socket/工具。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 协议结果字段与预期不符 | 证据/状态解析失败 | 以 `host/lib/index.js` 实现为准；假宿主测试覆盖；`ping.version` 门禁 |
| DSH API 变化（`resolveAgent`/`createUserMessage`/`tools.register`） | 插件不可用 | 用公开文档 API；集成测试；版本范围声明 |
| 唤醒与 A 正在运行冲突 | 插入错位 | 默认 followup（排队）；可配 steer；去重 |
| 插件重载/宿主重启丢唤醒 | 结果不回来 | state.json + `list_runs` 对账 + 重投递 |
| 证据快照慢（大目录/网络盘） | send 变慢 | 上限 + 超时 + 截断；文档说明 |
| 重复唤醒/重复投递 | 打扰/重复回合 | delivered 标记 + run_id 幂等 + 先写 delivering |
| 上游拒绝 PR 或方向不合 | 无法合并 | `native/` 隔离；可独立包发布；fork 自用 |

## 15. Fork 与上游流程

1. **Fork 已创建**（2026-11-23）：<https://github.com/gaenlzuko/dsh-baton>，parent `JialaoLiu/dsh-baton`。
2. 本地 remotes：`origin` = fork，`upstream` = 上游；`feat/dsh-native` 已推送并跟踪 `origin/feat/dsh-native`。
3. 开发在 `feat/dsh-native`；每个里程碑一个 commit；上游 `main` 定期 rebase。
4. **PR 内容**：新增 `native/`（可选 bundle）、`docs/native.md`、测试；不改 MCP 行为；MIT 头保留；PR 说明 DSH 内部使用场景与与 dsh-baton-host 的关系；附验证记录。
5. 若上游不接受：fork 独立维护/发布 `dsh-baton-native`，或转为独立仓库。

## 16. 待决问题（实现时验证）

1. `dsh-llm` 的 UserMessage `source` 允许哪些 kind？`agent-message/relay` 是否足够；自定义 source 是否合法。
2. `ctx.tools.register` 的精确定义形状与工具名约束（读 `dsh-tools` README/类型）。
3. `inject` 是否需要 `agents`/`sessions` 服务；`resolveAgent` 冷恢复的边界。
4. 证据模块复用方式：相对 import `../src/evidence.mjs`（link 安装可行）vs 复制进 `native/lib`（打包发布可行）。
5. Windows 命名管道路径解析与长连接行为。
6. 子代理限制的工具面 API（`ctx.tools.restrict` / 预设层）在 0.2.2-rc.5 的可用性。
7. 宿主 `approvals` 为 `ask` 时的唤醒措辞与用户流程。
8. 是否需要在 A 侧显示"运行中"状态（后续可加 client 插件）。

## 17. 进度记录

- 2026-11-23 M0：本地克隆 0.6.19（`318b6cd`）、`native/PLAN.md`、分支 `feat/dsh-native`（commit `31952c6`）；fork 创建为 `gaenlzuko/dsh-baton`，remotes 已切换（origin=fork，upstream=上游），分支已推送。
- 2026-11-23 M1：`native/` 骨架（package.json / cordis.patch.yml / index.js / lib/protocol.js / lib/socket.js / locale / icon / docs）与 `baton_workspaces` 工具；验证：
  - `node --check` 全部通过；
  - `npm test`（`node --test "test/*.test.mjs"`）5/5：NDJSON 分包、错误回复、客户端超时、断线拒绝、长 wait 不带客户端超时；
  - `node test/plugin-smoke.mjs` 对运行中的 dsh-baton-host（0.6.19，pid 32692）返回 6 个 workspace；
  - `dsh --profile web --dump-config` 退出 0，组合树包含 `id: dsh-baton-native` 行（bundle 可被 profile 解析）。
- 2026-11-23 M2：`baton_send` / `baton_status` / `baton_read` / `baton_cancel` / `baton_runs` 工具 + `lib/state.js`（run→发起会话登记）+ `lib/format.js`；假宿主测试覆盖请求形状、参数校验、状态/读取/取消渲染与登记表（`npm test` 12/12）。**尚未做真实会话创建**（等 M6 用隔离 socket + 临时 web 实例做端到端）。
- 环境备注：`dsh plugin --profile web add link:<native>` 已把本插件装进 web profile；pnpm 顺带把该 profile 的 `dsh-baton-host` 从 0.6.16 升到 0.6.19（并加入 `dsh-baton-mcp`）。desktop profile 未改动。
- 2026-11-23 M3：`lib/evidence.js`（复用上游证据模块，MIT 署名）、`lib/wake.js`（唤醒文本 + `agent.followup` 注入，source=`agent-message/relay`，不继承人类权限）、`lib/watcher.js`（每 run 一个长 `wait`，结束/提问/丢失时唤醒，断线退避重连）；`baton_send` 新增 `checks`、目录快照与 watcher 启动；`baton_runs` 显示投递状态。测试：`npm test` 15/15，含 watcher 端到端（发任务→改文件→run 结束→恰好一条唤醒，正文含 created/modified、`PASS node --version`、`all checks passed: yes`、核对表提示）。**真实 DSH 运行时未验证**（`sessionController.resolveAgent` + `agent.followup` + `agent-message` source 等 M6 实机确认）。
- 2026-11-23 M4（部分）：`baton_answer` 工具（透传 `answers`）；插件重载后已投递的 run 不重复唤醒（`resume()` 只补未投递；测试 `npm test` 17/17，含 reload 去重用例）。待做：多 run 并发/宿主重启的真实场景验证、`input` 唤醒去重细化。
- 2026-11-23 M5：`npm pack --dry-run` 检查（16 个文件、31.3 kB）；README/DETAIL 状态与 E2E 文档补齐。
- 2026-11-23 M6（通过）：在隔离 socket 的临时 `dsh web`（`--port 0 --no-open`，临时 `DSH_BATON_HOME`/`DSH_BATON_NATIVE_STATE`/`DSH_BATON_AUTO_REGISTER=0`）上跑真实 A→B→A：A 的模型调用 `baton_send` 创建 B；B 写 `B_DONE.txt`、跑 `node --version`、给出需求核对表；B 结束后 A 的 session log 中出现一条 `agent-message` 唤醒（`[baton] run … finished: completed`，含 created/modified、checks、最终回复与核对表），A 的 assistant 消息数 1→2，插件 state 标记 delivered。驱动脚本 [scripts/e2e-live.mjs](../scripts/e2e-live.mjs)，记录见 [docs/E2E.md](../docs/E2E.md)。回滚验证：`dsh plugin --profile web remove dsh-baton-native` 后依赖与 bundle 均移除，重新 `add link:` 恢复。
- 下一步：M7（向上游提 PR 或独立发布方案）；多 run/重启场景可选补测。
