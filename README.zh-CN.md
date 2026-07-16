[English](./README.md) | [简体中文](./README.zh-CN.md)

# AgentFlow

AgentFlow 用于在同一个 Codex、Cursor 或 VS Code 客户端中，通过一个 Supervisor 对话和多个职责受限的 Worker 对话，协调一条可恢复的软件交付流水线。

## 前置条件

- Node.js 20 或更高版本
- Git
- Codex、Cursor 或 VS Code
- 一个允许创建文件的项目目录

在项目根目录执行：

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex
```

按需将 `codex` 替换为 `cursor`、`vscode` 或 `all`。`v0.2.0` 标签会一直等到 Release Gate 获得批准后才创建并推送；届时，这条命令才会成为提供给朋友使用的稳定入口。

Setup 会在 `.agentflow/runtime/` 下安装独立运行时，复制已审查的 Skills，安全合并项目级 MCP 配置，并安装持久化的自动路由指令。它不会写入 token、OAuth 凭据或 Authorization header。

Setup 完成后：

1. 如果所选客户端没有自动重新加载项目指令和 MCP 配置，请重启该客户端。
2. 准备执行 UI 阶段时，在客户端中完成由 Figma 管理的 OAuth 授权。
3. 像平常一样输入需求，无需再提及 `agentflow-orchestrator`。

## 自动路由

凡是预期结果会修改项目的请求，都会进入或恢复 AgentFlow。这包括新项目、功能、缺陷修复、重构、测试、文档、配置、迁移、设计工作和发布。

以下请求不会进入 AgentFlow：

- 纯问答
- 代码解释
- 只读检查
- 状态查询
- 不修改项目的简单命令

`agentflow:on` 可强制当前一次请求进入 AgentFlow，`agentflow:off` 可让当前一次请求绕过 AgentFlow。两者都不会影响后续请求。

开始编辑前，路由器会检查 `.agentflow/current-run.json` 或 AgentFlow 状态。若存在尚未完成的 Run，它会恢复该 Run，而不会重复创建。Requirements、Design Direction、Design Freeze、Engineering Plan 和 Release Gate 仍然必须由用户明确批准。

Skills 和 MCP 工具只会在当前 Pipeline Stage 声明需要时加载。非 UI 项目或只读问题不会调用 Figma，已配置 Figma server 也不会被当作实时认证成功的证据。

## Setup 选项

安装全部三种客户端配置：

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host all
```

不切换当前目录，直接指定另一个项目：

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 \
  --project-root /absolute/project/path setup --host codex
```

仅校验文件系统写入计划，不写入文件：

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex --dry-run
```

在安装完成后立即启动第一个 Run：

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex \
  --start "Build a small team project manager" \
  --project-type new
```

非 UI Run 请添加 `--no-ui`。`--project-type` 和 `--no-ui` 必须与 `--start` 一起使用；`--dry-run` 不能与 `--start` 组合。只有在已通过其他方式管理获批外部 Skills 时，才应使用 `--skip-external-skills`。

Dry-run 不会修改项目，因此静态 doctor 状态会报告为 `ok: null, skipped: true`。正常执行 Setup 后，再使用已安装的 doctor 验证最终项目。

Setup 是幂等的。重复执行会更新 AgentFlow 管理的区块，保留无关指令和 MCP servers，并返回当前未完成的 Run，而不是另建一个 Run。

Setup 输出的 JSON 包含持久运行时路径、已安装 Skill 名称、固定依赖提交，以及每个所选客户端的一份静态 doctor 报告。任何 doctor 报告处于阻断状态时，Setup 都不会启动 Run。

## 验证与恢复

在目标项目中运行已安装的 doctor：

```bash
node .agentflow/runtime/bin/agentflow-cli.mjs doctor --host codex
```

健康的静态报告仍可能是 `warn`，因为仅凭文件无法证明编辑器已经重启或 Figma OAuth 已完成。在 S04 开始前，Supervisor 必须探测客户端的实时工具注册表、加载 `figma-use` 并调用 Figma `whoami`；缺少能力证据时，只会阻断依赖这些能力的设计阶段。

Setup 会在写入前计算并校验全部目标路径。遇到冲突的 `agentflow` 或 `figma` server、内容不同的同名 Skill、损坏的受管标记、符号链接或路径逃逸时，它会中止。写入使用同目录临时文件；如果后续写入失败，本次调用已经完成的写入会被回滚。

修复报告中的冲突后，重新执行同一条 Setup 命令即可。已有 Run 状态和已完成 Artifacts 会保留。各客户端的 OAuth、诊断、恢复和手动回滚方式见 [Host Setup](./docs/HOST_SETUP.md)。

## 安装内容

- `.agentflow/runtime/bin/agentflow-cli.mjs`
- `.agentflow/runtime/bin/agentflow-mcp.mjs`
- 不存在时创建 `.agentflow/config.yaml` 和 `.agentflow/pipeline.yaml`
- `.agents/skills/agentflow-*`
- `skills-lock.json` 声明并固定版本的 Superpowers Skills
- `AGENTS.md` 中的受管路由区块
- Cursor 使用的 `.cursor/rules/agentflow.mdc`
- VS Code 使用的 `.github/copilot-instructions.md`
- `.codex/config.toml`、`.cursor/mcp.json` 或 `.vscode/mcp.json`

生成的运行时文件和本机 MCP 配置会被 Git 忽略。可移植的路由指令与 AgentFlow Skills 可以经过审查后提交到项目仓库。

## 贡献者开发

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:distribution
```

从源码运行命令：

```bash
npm run cli -- setup --host codex --skip-external-skills
npm run cli -- status
npm run mcp -- --project-root /absolute/project/path
```

根 package 暴露独立的 `agentflow` bin。`prepare` 会重新构建 `bundle/agentflow-cli.mjs` 和 `bundle/agentflow-mcp.mjs`；打包后的运行时不依赖尚未发布的 `@agentflow/*` workspace packages。

## 架构

- `@agentflow/core`：持久化 Run、Stage、Task、Worker、Artifact、资源、preflight 和 Gate 不变量。
- `@agentflow/cli`：Setup、初始化、诊断和操作命令。
- `@agentflow/mcp-server`：通过 stdio 提供 Supervisor 与 Worker 状态工具。
- `@agentflow/host-adapter`：可移植 Worker contract 与 Codex 原生桥接。
- `.agents/skills/`：各 Stage 的执行规范，包括 `agentflow-auto-router` 和 `agentflow-orchestrator`。

Pipeline `0.4.0` 让带类型的证据贯穿需求发现、架构、实现、集成、QA、发布计划和最终验证。Codex 原生 Worker 执行已经过验证。Cursor 和 VS Code 的持久化配置已经实现，但它们的原生 Worker 执行仍是明确的待验证边界。实时 Figma 证据也仍需等待已认证且暴露所需工具的客户端环境。

完整项目约定和当前边界见 [AGENTFLOW_PROJECT_SPEC.md](./AGENTFLOW_PROJECT_SPEC.md)。
