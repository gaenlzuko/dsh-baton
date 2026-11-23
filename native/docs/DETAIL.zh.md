# Baton 原生工具

[dsh-baton](https://github.com/JialaoLiu/dsh-baton) 的 DSH 原生工具。它不挂 baton 的 MCP
server，而是作为 Host 插件跑在 DeepSeek Harness 进程里，通过宿主已有的 `dsh-baton-host`
插件的文档化控制 socket 协议通信。

DSH 会话 **A** 用一次工具调用把任务交给独立会话 **B**。B 在 Harness 侧栏里实时运行；结束
时插件**只唤醒 A 一次**，带回证据：改动文件、跑过的检查命令（退出码与输出尾部）以及 B 的
最终回复（其中的逐条需求核对表）。

**状态：** 已在 DeepSeek Harness 0.2.2-rc.5 上真实跑通 A → B → A。完整文档、设计与 E2E
记录见包的 README、`docs/E2E.md` 与 `PLAN.md`。

## 工作原理

- `baton_send` 调宿主 socket 的 `send`，由 Harness 自己的 session controller 创建或继续
  会话 B；调用立即返回 `run_id`。
- 插件对目标目录做快照，并为每个 run 发一次长 `wait`（不轮询）。
- run 结束时 watcher 收集证据、拼出简报，并用 `agent.followup` 以一条 user 角色消息
  （`source = agent-message/relay`）注入 A。
- B 停下来等人时也会唤醒 A；A 用 `baton_answer` 提交答案。
- 投递状态保存在本地，插件重载不会对同一个 run 重复唤醒。

## 工具

| 工具 | 作用 |
|---|---|
| `baton_workspaces` | A 可以在其中创建会话的工作区（id、路径、标题、会话数）。只读。 |
| `baton_send` | `message` 加 `session_id` 或 `cwd`/`workspace_id`，可选 `mode`、`model`、`reasoning_effort`、`checks`。立即返回 `run_id`。给 checks 时，run 结束后运行这些命令，并在任务末尾追加"只读自查 + 需求核对表"的提示。 |
| `baton_status` | run 或会话进度（状态、最终文本、等待、问题）。只读。 |
| `baton_read` | 读会话最近消息，不唤醒目标。只读。 |
| `baton_cancel` | 停止回合、子代理、后台作业与排队消息。 |
| `baton_answer` | 回答 run 的 `ask_user_question` 问题。 |
| `baton_runs` | 本插件发起过的 run 及其唤醒投递状态。只读。 |

## 唤醒消息

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

## 证据链

- 发任务时拍目录快照，run 结束时对比：新建 / 修改 / 删除的文件（有上限；跳过依赖与构建目录）。
- run 结束时在目标目录执行最多 10 条检查命令：退出码、耗时、输出尾部与 `all_checks_passed`。
- 给 checks 时，会要求 B 启动只读子代理自查，并在回复末尾给出
  `需求 | 是否满足 | 证据` 表格；最终回复会把它带回来。
- 完整记录在 `$DSH_BATON_HOME/evidence/<run_id>.json`；唤醒消息带摘要与该路径。

## 环境要求与安装

- DeepSeek Harness 0.2.x，且同一 profile 里启用 `dsh-baton-host`。
- Node.js 22.15+（Harness 运行时已满足）。
- host socket 在 `~/.dsh-baton/host.sock`（Windows 上是按用户隔离的命名管道），或
  `DSH_BATON_SOCKET` 指向的位置。
- 从 checkout 安装：`dsh plugin --profile <profile> add link:<本目录>`，然后重启该 profile
  的 Harness（或通过 DSH 的插件管理器安装），在新会话里确认 `baton_workspaces` 可用。

## 配置

插件读取的环境变量：`DSH_BATON_HOME`（默认 `~/.dsh-baton`）、`DSH_BATON_SOCKET`、
`DSH_BATON_NATIVE_STATE`（默认 `~/.dsh-baton-native`）。run 的审批策略由
`dsh-baton-host` 插件页控制（`allow` 在 hand-over 期间自动放行；`ask` 留给用户）。

## 已知限制

- 尚未限制为仅根会话：子代理也能看到这些工具，可能递归派发。
- 快照在 `baton_send` 之后立即拍摄，恰好在那一瞬间改的文件可能漏记。
- 检查命令以 Harness 宿主权限运行，不在 B 的沙箱内。
- `baton_answer` 只处理提问；审批仍需在 Harness 界面处理。
- 认证依赖 host socket 的"仅当前用户"访问——与直接运行 `dsh` 同等信任级别。

## 验证

单元测试：`npm test`（20 个用例）。连通性探测：`node scripts/probe-host.mjs`。真实 A → B → A
驱动与记录：`scripts/e2e-live.mjs` 与 `docs/E2E.md`。

## 许可证

MIT。socket 辅助、证据模块与 review 提示词改编自 dsh-baton 的 MIT 源码
（Copyright (c) 2026 JialaoLiu）。
