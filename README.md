# 本机 Codex 点子到交付工具

最终交付目标是一套本机 Codex 研发工具：把新点子或未完成项目带到可审查的代码交付。Router 负责整合目标和上下文，把已批准任务派给边界明确的 Codex 子 Agent 并行实施；随后由 Router 集成、测试和独立审查，处理 GitHub Actions 或 GitLab CI 反馈并在需要人决策时暂停。

## 当前状态

本机 MVP 正在开发和试跑。用户提出的局域网海战棋是用来验收这套工具的试点项目；它不是本仓库的最终产品目标。合并、发布和部署始终由人确认。

## Router 与 Worker

- Router 是一个有持续上下文的 Codex 主会话，负责目标书、任务包、子 Agent 分派、状态、集成、验收与用户沟通。
- 子 Agent 各自有独立会话上下文，按不重叠的文件范围并行做后端、前端、测试或只读审查；有依赖的工作串行。
- Codex 子 Agent 审计从本地 rollout JSONL 读取 `SubAgentActivity` 生命周期事件，输出真实子会话 ID 和状态，不用主 Agent 的文字报告代替运行证据。
- Worker 只拿到自己所需的目标、获批边界、接口契约和验收要求。Router 在派发前生成并校验 `task-context.json`，集成后重跑全量检查，并把一般审查问题派回对应 Worker。
- 独立审查不暂停整条执行：范围内问题由 Router 指派原 Worker 修复并继续。Autoloop 只在需要用户裁决的范围/验收冲突、缺少本人权限、修复耗尽、合并或发布时通知用户。

## 本机运行

需要 Node 24（通过项目脚本使用独立安装，不改系统默认 Node）。初始化 Autoloop 时先运行：

```sh
AGENT_AUTOLOOP_HOME="$PWD/.local/agent-autoloop" \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
./.local/agent-autoloop/bin/agent-autoloop init --agent codex --no-service --port 3381
```

配置目标仓库路由后，在一个终端启动本机中台。省略 `IDEA_REPO_PATH` 时，目标为本控制器仓库：

```sh
./scripts/agent-autoloop.sh up
```

另一个终端提交点子：

```sh
./scripts/new-demo-idea.sh "新增一个 API，并写清验收标准"
```

Autoloop 会先安排只读调研并显示审批卡。只有明确选择“同意，开始实现”后，任务 Worker 才在独立 Git Worktree 中创建功能分支并获得写权限；同一批准也会把该任务 Worktree 的 Git 元数据目录与仓库共用 Git 目录加入可写范围，以便提交任务分支。首轮规划不会获得这项额外写权限。

将当前项目切换到另一个本地仓库时，用该仓库路径重配路由，再提交点子：

```sh
IDEA_REPO_PATH="/绝对路径/到/半成品仓库" \
IDEA_RULE_NAME="新点子到交付（我的项目）" \
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
node scripts/configure-demo.mjs
scripts/new-idea.sh "继续完成这个仓库的登录流程，并补齐验收"
```

后续审查意见和 CI 失败使用原任务 ID 回到同一个 Router 会话，普通范围内问题由 Router 派回 Worker 自动修复：

```sh
scripts/continue-task.sh review.finding idea-a8e5d3e65fe0 "缺少 X 输入边界校验；范围内，请修复并重跑测试"
scripts/continue-task.sh ci.failed idea-a8e5d3e65fe0 "run 123 的提交 SHA ... 失败；日志摘要 ..."
```

配置器同时增加每 5 分钟一次的 CI 轮询：GitHub 使用 `gh run list`，GitLab 使用 `glab ci list`。它只检查已登记任务 Worktree 当前 HEAD，等该提交关联的工作流全部结束后才回送 `ci.failed` 或 `ci.passed`；失败事件附上运行编号和链接，Router 再读取失败日志。事件 ID 按提交 SHA 稳定生成，由 Autoloop 去重。失败事件区分失败提交数、已执行修复轮数和 `repairExhausted`；第三次失败只请求用户裁决，不再派发修复。没有受支持远端的本机任务会直接跳过，不启动模型会话。

独立审查与项目检查通过、任务改动已提交后，Router 可运行 `node "$IDEA_DELIVERY_HOME/scripts/publish-task.mjs" task-context.json`。发布器核对任务包记录的仓库、关联 Worktree 和 `codex/<task>` 分支；检查干净状态时允许本地未跟踪的 `PROGRESS.md`、`BLOCKED.md` 与 `task-context.json`，其他未提交文件仍会阻止发布。发布器也要求远端 `main`/`master` 是任务分支祖先且任务分支包含新提交；GitHub 通过 `gh` 创建/更新 PR，GitLab 通过 `glab` 创建/更新 MR。GitLab 自托管实例需在任务包中标记 `repository.provider: "gitlab"`，并在本机安装、登录 `glab`；详情见 [glab MR](https://docs.gitlab.com/cli/mr/create/)、[认证状态](https://docs.gitlab.com/cli/auth/status/)和 [CI 列表](https://docs.gitlab.com/cli/ci/list/)文档。发布器不会合并或部署；仓库没有远端时会明确保留本地分支。

## 当前边界

- 已接通本地点子事件、隔离 Worktree、只读规划、显式审批、批准后分支/写入权限、Codex 会话续接和原生子 Agent 编排；真实子 Agent 生命周期已从 Codex rollout 记录核实。
- Agent-Autoloop 暂以本地前台进程运行；登录启动服务尚未安装。
- 海战棋只是试点夹具：规则和 HTTP 测试 6/6 通过，两个独立浏览器客户端完成整局；另一台物理设备的 LAN 接入尚未验收。该仓库没有 Git 远端。
- 后续事件按稳定任务 ID 回到原 Autoloop lane；GitHub/GitLab CI 轮询及失败/通过事件回流已实现。海战棋试点已真实验证 GitHub 分支推送、PR、两个 CI 运行通过及 `ci.passed` 回到原 Autoloop lane；两轮失败修复与耗尽后暂停仍未做真实端到端验证。
- 发布器的 GitHub PR 路径已在 [海战棋 PR #1](https://github.com/MaxEvansLiuer/seabattle/pull/1) 真实验证；GitLab MR 路径仍由临时远端和模拟 CLI 验证，真实 GitLab 认证、推送及 MR 尚未验收。
- 本机权限策略不等同于独立操作系统账号或容器隔离。

## 设计

见 [架构方案](docs/architecture.md)。

Autoloop 完成一个 Codex 会话后，会把子 Agent 审计记录保存在 `$CODEX_HOME/idea-to-delivery/subagent-audits/<主会话 ID>.json`。根据 `agent-autoloop why <轮次> --json` 取主会话 ID 后，可用以下命令核实真实派发记录：

```sh
node scripts/codex-subagents.mjs <主会话 ID>
```
