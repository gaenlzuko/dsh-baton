# dsh-baton-native

[dsh-baton](https://github.com/JialaoLiu/dsh-baton) 的 DSH 原生工具。它不挂 baton 的 MCP
server，而是作为 Host 插件跑在 DeepSeek Harness 进程里，通过宿主已有的
`dsh-baton-host` 插件的文档化控制 socket 协议通信。

DSH 会话 **A** 用一次工具调用把任务交给独立会话 **B**；B 在侧栏里实时运行，结束后插件
**只唤醒 A 一次**，并带回证据：改动文件、跑过的检查命令（退出码与输出尾部）以及 B 的最终
回复（其中的逐条需求核对表）。

- [English README](README.md) · 中文说明
- 设计与里程碑：[PLAN.md](PLAN.md)
- 真实 A → B → A 验证记录：[docs/E2E.md](docs/E2E.md)

## 为什么需要它

baton 原本的方向是"外部 → DSH"：Claude Code、Codex 或 Antigravity 通过 MCP server 把任务
交给 Harness 会话。本插件把同样的思路**搬进 DSH 内部**：A 和 B 都是普通 Harness 会话，不
需要额外的 MCP 进程，A 拿到的是**带证据的结果**，而不是另一个 agent 的自述。

与"把 `dsh-baton-mcp` 挂成 MCP server"相比：

| | 原生插件（本插件） | 在 DSH 里挂 MCP server |
|---|---|---|
| 谁能发起 | 任意 DSH 会话 | 有 MCP 工具的会话，但工具调用是同步的 |
| 结果投递 | 主动注入一条唤醒消息（`agent.followup`） | 调用方要阻塞在 `dsh_wait` 或轮询 |
| 消息来源标注 | 原生 relay 消息 | 取决于 MCP client 名称映射 |
| 额外进程 | 无 | 一个 MCP server 进程 + schema 桥接 |

## 状态

已在 DeepSeek Harness **0.2.2-rc.5** 上真实跑通 A → B → A，见 [docs/E2E.md](docs/E2E.md)。

- 工具：`baton_workspaces`、`baton_send`、`baton_status`、`baton_read`、`baton_cancel`、
  `baton_answer`、`baton_runs`。
- `baton_send` 会对目标目录做快照、启动长 `wait` watcher，然后立即返回。
- run 结束时 A 收到一条唤醒消息，含改动文件、检查结果与最终回复；B 停下来等人时也会唤醒
  A，A 可用 `baton_answer` 回答。
- 插件重载后，已投递的 run 不会被再次唤醒。
- 尚未做真实场景验证：多 run 并发、run 中途重启 Harness，以及向上游提 PR。

## 工作原理

```text
会话 A（根会话）                          DeepSeek Harness 宿主进程
   │  baton_send(...)                        ┌───────────────────────────────┐
   ├───────────────────────────────────────► │ dsh-baton-native（本插件）     │
   │  立即返回 run_id                        └───────────────┬───────────────┘
   │                                                        │ 仅限本用户的 socket
   │                                                        │ NDJSON 协议
   │                                                        ▼
   │                                        ┌───────────────────────────────┐
   │                                        │ dsh-baton-host（已安装）       │
   │                                        └───────────────┬───────────────┘
   │                                                        │ sessionController
   │                                                        ▼
   │                                          会话 B（独立会话，侧栏可见）
   │                                                        │ 结束
   │                                                        ▼
   │  一条唤醒消息  ◄── watcher：wait → 证据 → agent.followup(A)
   └─────────────────────────────────────────────────────────┘
```

- 协议与上游 MCP server 使用的是同一套（baton 仓库的 `host/PROTOCOL.md`）：`ping`、
  `workspaces`、`send`、`status`、`read_session`、`wait`、`cancel`、`answer`、`list_runs`。
- 每个 run 一个 watcher，发一次长 `wait`（宿主侧最长 24 小时），不轮询。
- 唤醒消息是 user 角色消息，但 `source` 为 `agent-message/relay`（不是 `user`），插件不会
  继承人类权限（例如 goal 工具权限）。投递用 `agent.followup`：A 空闲则开启新回合，A 在跑
  则排在当前回合之后。
- 投递状态记录在 `~/.dsh-baton-native/state.json`（可用 `DSH_BATON_NATIVE_STATE` 改）；
  插件重新激活时会为未投递的 run 恢复 watcher。

## 环境要求

| 要求 | 说明 |
|---|---|
| DeepSeek Harness 0.2.x | 已在 0.2.2-rc.5 验证；插件使用公开 Host 服务（`tools`、`sessionController`） |
| 同一 profile 里启用 `dsh-baton-host` | 它提供 socket 并负责驱动会话 |
| Node.js 22.15+ | Harness 运行时已满足；本插件自身零依赖 |
| host socket | `~/.dsh-baton/host.sock`（Windows 上是按用户隔离的命名管道），或 `DSH_BATON_SOCKET` |

## 安装

本地开发 / 从 checkout 安装：

```powershell
# 在仓库根目录；Desktop 应用用 --profile desktop，dsh web 用 --profile web
dsh plugin --profile web add link:<native/ 目录的绝对路径>
```

新加的 bundle 会在拥有该 profile 的 Harness 下次启动时加载；DSH 的 plugin manager 也可以在
Harness 运行中安装并激活（`plugin_manager` 的 `install_bundle`）。安装后开一个**新会话**，
确认工具列表里有 `baton_workspaces`，且它返回的目录与 Harness 侧栏一致。

卸载：

```powershell
dsh plugin --profile web remove dsh-baton-native
```

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `baton_workspaces` | — | 列出 Harness 工作区：id、路径、标题、会话数。只读。 |
| `baton_send` | `message`（必填，≤64 KiB）、`session_id?`、`cwd?`、`workspace_id?`、`mode?`（`followup`/`steer`）、`model?`、`reasoning_effort?`、`checks?`（≤10 条） | 新建会话（需要 `cwd` 或 `workspace_id`）或继续已有会话（`session_id`）；立即返回 `run_id`。给 `checks` 时，run 结束后运行这些命令，并在任务末尾追加"只读自查 + 需求核对表"的提示。 |
| `baton_status` | `run_id?` 或 `session_id?`、`tail?` | run 状态、最近事件、最终文本、错误、`waiting_on`、`needs_input`、问题。只读。 |
| `baton_read` | `session_id`、`last?`（1–50，默认 20） | 读取会话最近消息，不唤醒目标。只读。 |
| `baton_cancel` | `run_id?` 或 `session_id?` | 停止回合、子代理与后台作业，并丢弃排队消息。 |
| `baton_answer` | `run_id?` 或 `session_id?`、`answers`（每个问题一项：`id?`、`choose?`、`text?`、`skip?`） | 回答 run 的 `ask_user_question`。审批不在这里处理，请在 Harness 界面处理。 |
| `baton_runs` | `limit?`（1–100，默认 20） | 本插件发起过的 run：run id、目标会话、发起会话、投递状态。只读。 |

## 唤醒消息长什么样

真实验证中的示例：

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

如果 B 停下来等人，A 会收到一条更短的消息，包含问题与回答方式（`baton_answer` 或 Harness
窗口）。

## 证据链

证据由插件生产，不依赖 B 的自述：

- **目录快照**：发任务时拍快照，run 结束时对比，得到 `changes.created`、
  `changes.modified`、`changes.deleted`（路径列表；有上限并标记 `truncated`，会跳过
  `node_modules`、`.git`、`dist` 等依赖/构建目录）。
- **检查命令**：run 结束时在目标目录执行最多 10 条命令，返回
  `{ command, passed, exit_code, timed_out?, seconds, output_tail }` 与
  `all_checks_passed`。检查在 Harness 宿主进程里运行（不在 B 的沙箱内），环境带 `CI=1`，
  单条 120 秒、总计 180 秒预算。
- **需求核对表**：给 `checks` 时，插件在任务末尾追加提示，要求 B 启动只读子代理逐项核对，
  并在回复末尾输出 `需求 | 是否满足 | 证据` 表格；最终回复（含表格）随唤醒消息带回。
- **worktree / 同目录并发**：宿主报告时一并透传：会话迁移到 Git worktree，或同时有其他 run
  在改同一目录。
- 完整证据记录存放在 `$DSH_BATON_HOME/evidence/<run_id>.json`，唤醒消息带摘要与该路径。

## 投递、重试与恢复

- 每个结束的 run 恰好一条唤醒；已投递标记在 state 文件里。
- A 的会话无法解析（被归档/删除）时投递失败，run 保持未投递；插件下次激活会通过
  `agent.followup` 重试。
- run 在宿主侧已不存在（例如 Harness 重启过）时，A 会收到一条"run lost"消息，指向目标会话。
- 提问可以从 A 回答（`baton_answer`），也可以直接在 Harness 窗口回答；先答者生效。
- `baton_runs` 可以看到哪些 run 已投递、哪些还在等待投递。

## 配置

本版本没有独立的配置界面；插件从 Harness 进程的环境变量读取：

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_BATON_HOME` | `~/.dsh-baton` | baton 主目录（socket、设置、证据） |
| `DSH_BATON_SOCKET` | `$DSH_BATON_HOME/host.sock` | 显式 socket 路径或 Windows 管道名 |
| `DSH_BATON_NATIVE_STATE` | `~/.dsh-baton-native` | 本插件的 run 登记表 |
| `DSH_BATON_AUTO_REGISTER` | `1` | 上游 host 的行为：为 Claude Code/Codex 注册 baton 的 MCP；测试时可设 `0` 跳过 |

run 的审批策略来自 Harness 里 `dsh-baton-host` 插件页的 `approvals` 设置（`allow`：hand-over
期间自动放行，上游默认；`ask`：留给用户在目标会话里处理）。

## 验证

```powershell
# 单元测试：协议分包、证据、工具面、watcher/唤醒、重载去重
npm test

# 对正在运行且启用了 dsh-baton-host 的 Harness 做连通性探测
node scripts/probe-host.mjs

# 在隔离实例上跑真实 A → B → A（完整步骤见 docs/E2E.md）
node scripts/e2e-live.mjs
```

当前测试套件 20 个用例全绿。真实运行记录中每项检查均为 true：B 完成并创建文件、检查通过、
在 A 的会话日志里找到唤醒消息、A 被唤醒并回复、run 被标记为已投递。

## 已知限制

- 尚未限制为"仅根会话"：子代理也能看到 `baton_*` 工具，因此子代理也能再开新会话（可能递归）。
  这是当前开发阶段的限制。
- 目录快照在 `baton_send` 返回后立即拍摄；B 若恰好在那一瞬间改文件，可能漏记（上游同样存在
  这个竞态）。
- 检查命令以 Harness 宿主权限执行，不在 B 的沙箱内；只传你自己愿意执行的命令。
- `baton_answer` 只回答 `ask_user_question`；工具审批需在 Harness 窗口处理，或通过 host 的
  `approvals` 设置预先放行。
- 多 run 并发与 run 中途重启只有单元测试覆盖，尚无真实场景验证。
- 没有面板/按钮；一切通过工具与唤醒消息完成。
- socket 赋予当前 OS 用户对 Harness 会话的完全控制——与直接运行 `dsh` 同等信任级别。证据文件
  可能包含路径与命令输出，不要随意外发。

## 开发

```text
native/
  index.js            Host 插件入口：工具、watcher、证据接线
  lib/protocol.js     宿主 socket 的 NDJSON 客户端（长 wait、重连）
  lib/socket.js       与宿主共享的端点解析（MIT，改编）
  lib/evidence.js     目录快照 / 检查（MIT，改编自 baton）
  lib/wake.js         唤醒文本与 agent 注入
  lib/watcher.js      每 run 一个长 wait、重试、投递状态
  lib/state.js        run 登记表（`~/.dsh-baton-native/state.json`）
  lib/format.js       给模型看的渲染
  lib/review.js       给 checks 时追加的自查提示
  test/               node:test 测试
  scripts/            探测与真实 e2e 驱动
  docs/               插件详情页、E2E 记录
```

分支：fork 里的 `feat/dsh-native`。上游文件零改动，所有新增都在 `native/` 下；
`git diff <upstream-base>..HEAD` 只会列出 `native/`。

## 许可证

MIT。`lib/socket.js`、`lib/evidence.js` 与 review 提示词改编自 dsh-baton 的 MIT 源码
（Copyright (c) 2026 JialaoLiu），改编文件保留了原始声明。
