[English](./README.md) | [简体中文](./README.zh-CN.md)

# AgentFlow

AgentFlow 在 Codex、Cursor 或 VS Code 中，用一个 Supervisor 任务和多个有边界的 Worker 任务协同执行可恢复的软件交付流水线。每个用户只需全局安装一次；仓库只会在第一次收到项目变更需求时创建轻量状态。

## 一次安装

前置条件：Node.js 20 或更高版本、Git，以及 Codex、Cursor 或 VS Code。

```bash
npx --yes agentflow@0.4.0 setup --host codex
```

按需把 `codex` 换成 `cursor`、`vscode`，也可以一次配置全部宿主：

```bash
npx --yes agentflow@0.4.0 setup --host all
```

npm 版本是不可变的。对于需要直接从 GitHub 安装的环境，也可以使用对应的不可变 Git tag：

```bash
npx --yes github:zhangnanlin/agentflow#v0.4.0 setup --host codex
```

全局 Setup 会安装：

- `~/.agentflow` 下的 CLI、MCP bundle、锁文件和 `install.json`
- `~/.agents/skills` 下的 AgentFlow Skills 与已审查的外部 Skills
- `$CODEX_HOME/config.toml` 中的 Codex MCP 配置，默认路径为 `~/.codex/config.toml`
- `~/.cursor/mcp.json` 中的 Cursor MCP 配置
- 当前平台对应的 VS Code 用户级 `mcp.json`

Setup 只合并 `agentflow` 与 `figma` server 条目，保留无关设置，也不会写入 token、OAuth 凭据或 Authorization header。首次安装后重启宿主；只有 UI Stage 需要 Figma 时，才在该宿主中完成一次 OAuth。

### 升级已有安装

已经安装 AgentFlow 的用户只需重新执行同一个全局命令，即可更新到 0.4.0：

```bash
npx --yes agentflow@0.4.0 setup --host codex
```

如果 Codex 尚未重新加载 MCP bundle，请重启 Codex。各项目不需要重新执行 setup；这次升级既不新增 MCP server 条目，也不新增 OAuth 流程。Figma 仍由宿主按需管理，只有 UI Stage 需要时才授权。

## 项目首次使用

在任意仓库中直接输入普通需求即可，不需要粘贴 AgentFlow 专用提示词。

对于会修改项目的请求，路由器会先使用原始需求调用 `run_start_or_resume`，之后才允许其他状态变更。该调用会恢复尚未完成的 Run，或创建轻量控制文件并且只启动一个新 Run。纯问答、代码解释、只读检查、状态查询和简单非写命令不会初始化仓库。

懒初始化只创建类似下面的项目状态：

```text
.agentflow/
  .gitignore
  config.yaml
  pipeline.yaml
  current-run.json
  runs/
  start-requests/
```

它不会把 runtime、Skills、路由指令或宿主配置复制进项目，也不会修改项目根目录的 `.gitignore`。

`agentflow:on` 只强制当前请求进入流水线，`agentflow:off` 只让当前请求绕过流水线。需求、设计方向、设计冻结、工程计划与发布 Gate 仍必须由用户明确批准。

## 自适应工作流

MCP 新建 Run 时会使用带版本的确定性策略，并持久化 lane、命中的信号、解释、可执行 Stage 与后续升级历史：

| Lane | 典型请求 | 可执行 Stage |
| --- | --- | --- |
| `Quick` | 现有非 UI 项目中的低风险修改 | 接入、实现、系统 QA、完成验证 |
| `Standard` | 新建非 UI 项目，或有边界的多模块修改 | 发现、需求、架构、计划、实现、集成、QA、完成验证 |
| `Full` | UI、迁移、破坏性 Git、安全、发布、部署或跨模块契约修改 | 完整兼容流水线及所有适用 Gate |

策略只能升级，不能降级。后续仓库或 Task 证据出现更高风险信号时，Supervisor 通过 `workflow_escalate` 持久化升级；已终止的 Run 不能再修改。在单次需求中加入 `agentflow:full`，可以明确选择 Full，但不会绕过任何 Gate。旧调用方与迁移后的 0.4.0 Run 继续使用 legacy Full。

推荐默认值只会自动应用于非强制选择。需求、设计方向、设计冻结、工程计划与发布决策仍保持 pending，直到用户明确批准当前 Artifact 哈希。路由信号、响应 profile、上线与回滚细节见[自适应工作流运维](./docs/adaptive-workflow.md)。

## 原生协同

并行 wave 中，Supervisor 会亲自领取一个可执行 Task，并且只把其余互不依赖的 Task 委派出去，因此主窗口不会停下来只做轮询。Worker 必须是 Codex、Cursor 或 VS Code 的原生任务，继承历史为零，只接收有边界的提示词，使用强制工具白名单，并禁用 AgentFlow MCP。AgentFlow 不会启动自建 Agent CLI 进程作为回退；原生适配器缺失或不合规时，由 Supervisor inline 或串行执行。

模型工作由跨进程的 host/profile 预算协调，默认同时只允许一个 Worker。第一次分类后的 429 会打开共享冷却；有 `Retry-After` 时优先遵守，否则使用带抖动的有界指数退避；冷却期间不会重复 spawn。确定性 Git 同步、校验、回读、计时器与显式等待不消耗模型 permit。

终态证据必须先持久化，之后才关闭原生执行、在宿主明确支持时归档子任务、释放准确的 permit，并记录与适配器绑定的清理 receipt。不支持的操作会如实保留；恢复清理时不会重新派发已完成工作。原生 profile 与诊断方式见 [Host Setup](./docs/HOST_SETUP.md)。

## 结构化选择

非强制选择存在明确推荐时，AgentFlow 会直接采用推荐，不再询问，并把选中值与理由记录到相关 Task 结果或 Artifact。只有真正阻塞且没有安全默认值的选择，才显示为可点击选项。一次可以合并最多三个独立问题；存在依赖关系的问题仍按顺序询问。控件中展示的推荐项不会预选答案。宿主已经暴露的原生结构化控件可以作为 MCP 表单询问的等价入口。

遇到待处理的人工 Gate 时，AgentFlow 从持久化 Run 状态读取问题和选项，并通过一次明确交互提交用户接受的答案，同时绑定当前 Artifact 哈希。拒绝、取消、超时、断开连接、revision 过期或并发冲突都不会修改 Gate。宿主不支持结构化输入时，只进行一次简洁的文本回退；答案被接受后不会重复询问。

结构化控件只包含非敏感的单选字段，不会收集密码、API key、access token、支付数据或 OAuth 凭据。

## Git 快速同步

当用户明确要求 `git push` 已经存在于本地的提交或标签时，AgentFlow 使用确定性的快速路径：校验工作区干净、当前 revision、remote 与 fast-forward 关系，执行普通推送，然后读取远端分支和解引用后的标签 ref。这个路径不会创建 Run、模型 Worker、发布计划或观察计时器。

快速路径绝不允许 `--force`、删除远端 ref、重写历史、创建 GitHub Release、发布 package、执行 migration 或 deployment。只要请求还包含文件修改或需要新建 commit，就仍属于项目变更并启动或恢复 AgentFlow。package 发布和生产部署继续保留明确的 Release Gate；生产部署还保留回滚、健康检查与正数观察窗口。

示例：

```text
推送当前分支。                              -> Git 快速同步
在当前 revision 创建 v1.2.3 注解标签并推送。 -> Git 快速同步
修改 README、提交并推送。                   -> AgentFlow Run
发布 package 或部署生产环境。               -> AgentFlow 发布流程
```

## 多项目并发

同一个全局 MCP 可执行文件可以服务多个项目，不存在全局项目队列。每次工具调用都会解析一个不可变的项目上下文；每个仓库分别拥有自己的 Run 状态与 `.agentflow/.start.lock`。项目 A 和项目 B 可以并发初始化和执行，只有同一项目内互相竞争的首次调用会短暂串行。

项目根解析优先级为：

1. 兼容模式中的固定 `--project-root` 或 `AGENTFLOW_PROJECT_ROOT`
2. MCP 调用中显式提供的绝对 `projectRoot`
3. 客户端暴露的唯一 workspace root
4. Git 顶层目录
5. MCP 进程工作目录

客户端暴露 multiple workspace roots 时，调用方必须传入显式的绝对 `projectRoot`。AgentFlow 会直接拒绝含糊请求，不会猜目录，也不会将请求排队等待猜测。

## Setup 与 Doctor

只校验全局安装计划，不写文件：

```bash
npx --yes agentflow@0.4.0 setup --host codex --dry-run
```

按需覆盖用户级路径：

```bash
AGENTFLOW_HOME=/absolute/runtime/path \
CODEX_HOME=/absolute/codex/path \
npx --yes agentflow@0.4.0 setup --host codex

npx --yes agentflow@0.4.0 setup --host vscode \
  --vscode-config /absolute/profile/mcp.json
```

`--vscode-config` 必须是绝对路径。Windows 同样使用 `AGENTFLOW_HOME` 与 `CODEX_HOME` 这两个环境变量名。

针对某个项目运行全局 Doctor：

```bash
node ~/.agentflow/bin/agentflow-cli.mjs \
  --project-root /absolute/project/path doctor --host codex
```

Doctor 分别输出 `installation` 与 `project`。第一次变更前的 `project.status: not-initialized` 是健康状态；已经存在但损坏的 config、pipeline 或 Run 状态会阻断。静态检查健康时仍可能为 `warn`，因为重启状态与 Figma OAuth 必须通过宿主现场证据确认。

## 项目级兼容模式

AgentFlow 0.2 的项目内安装仍可显式使用：

```bash
npx --yes agentflow@0.4.0 \
  --project-root /absolute/project/path setup --scope project --host codex
```

项目级模式保留固定根 runtime、Skills、路由文件、宿主配置，以及 `--start`、`--project-type`、`--no-ui` 行为。全局模式会拒绝这些项目级启动参数。

宿主通常让项目配置优先于用户配置，因此旧版 0.2 仓库会继续使用固定根 server，直到用户移除 AgentFlow 管理的项目级宿主条目。

## 从 0.2 迁移

1. 为目标宿主执行全局 Setup，然后重启宿主。
2. 对仓库运行全局 Doctor，确认全局 runtime、路由 Skill 与用户级宿主配置。
3. 保留 `.agentflow/config.yaml`、`.agentflow/pipeline.yaml`、`.agentflow/current-run.json` 和完整的 `.agentflow/runs/` 历史。
4. 确认全局 server 能正确解析仓库后，再删除旧的 AgentFlow 项目级 MCP 条目。
5. 确认没有活跃流程依赖后，才按需删除旧项目 runtime、复制的 Skills 与托管路由块。

全局 Setup 不会扫描仓库，也不会删除项目文件。完整路径、回滚、OAuth、多根处理和迁移步骤见 [Host Setup](./docs/HOST_SETUP.md)。

## 贡献者开发

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:distribution
```

源码兼容命令：

```bash
npm run cli -- setup --scope project --host codex --skip-external-skills
npm run cli -- status
npm run mcp -- --project-root /absolute/project/path
```

根 package 暴露独立的 `agentflow` bin，打包后的 bundle 不依赖未发布的 workspace package。完整的 Pipeline、状态、Worker、Artifact 与 Gate 契约见 [AGENTFLOW_PROJECT_SPEC.md](./AGENTFLOW_PROJECT_SPEC.md)。
