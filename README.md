[English](./README.md) | [简体中文](./README.zh-CN.md)

# AgentFlow

AgentFlow coordinates a resumable software-delivery pipeline across one Supervisor conversation and multiple bounded Worker conversations in the same Codex, Cursor, or VS Code client.

## Prerequisites

- Node.js 20 or newer
- Git
- Codex, Cursor, or VS Code
- A project directory in which you can create files

From the project root, run:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex
```

Use `cursor`, `vscode`, or `all` instead of `codex` when appropriate. The `v0.2.0` tag is intentionally pending until the release Gate is approved; the command becomes the stable friend-facing entry point after that tag is pushed.

Setup installs a standalone runtime under `.agentflow/runtime/`, copies reviewed Skills, safely merges project-scoped MCP configuration, and installs persistent automatic-routing instructions. It never writes a token, OAuth credential, or Authorization header.

After setup:

1. Restart the selected host if it does not reload project instructions and MCP configuration automatically.
2. Complete host-owned Figma OAuth when you intend to run a UI Stage.
3. Enter an ordinary requirement. You do not need to mention `agentflow-orchestrator`.

## Automatic Routing

Every request whose requested outcome changes the project enters or resumes AgentFlow. This includes new projects, features, bug fixes, refactors, tests, documentation, configuration, migrations, design work, and releases.

These requests bypass AgentFlow:

- Pure questions
- Code explanation
- Read-only inspection
- Status lookup
- Simple commands that do not modify the project

`agentflow:on` forces routing for one request. `agentflow:off` bypasses routing for one request. Neither token changes future requests.

Before editing, the router checks `.agentflow/current-run.json` or AgentFlow status. An unfinished Run is resumed instead of duplicated. Requirements, Design Direction, Design Freeze, Engineering Plan, and Release Gates still require explicit human approval.

Skills and MCP tools are loaded only when the active Pipeline Stage declares them. Figma is not called for a non-UI project or a read-only question, and a configured Figma server is not treated as live authentication evidence.

## Setup Options

Install every host surface:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host all
```

Target another project without changing directories:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 \
  --project-root /absolute/project/path setup --host codex
```

Validate the filesystem plan without writing:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex --dry-run
```

Install and start the first Run in one command:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex \
  --start "Build a small team project manager" \
  --project-type new
```

Add `--no-ui` for a non-UI Run. `--project-type` and `--no-ui` require `--start`; `--dry-run` cannot be combined with `--start`. Use `--skip-external-skills` only when approved external Skills are already managed separately.

Dry-run does not mutate the project, so static doctor checks are reported as `ok: null, skipped: true`. Run Setup normally, then use the installed doctor to verify the resulting project.

Setup is idempotent. Re-running it updates AgentFlow-owned blocks, preserves unrelated instructions and MCP servers, and returns the current unfinished Run rather than creating another one.

The setup JSON includes durable runtime paths, installed Skill names, pinned dependency commits, and one static doctor report per selected host. Setup does not start a Run when any doctor report is blocked.

## Verify And Recover

Run the installed doctor from the target project:

```bash
node .agentflow/runtime/bin/agentflow-cli.mjs doctor --host codex
```

A healthy static report may remain `warn` because an editor restart and Figma OAuth cannot be proven from files. Before S04, the Supervisor must probe the live host registry, load `figma-use`, and call Figma `whoami`; missing capability evidence blocks only the dependent design Stage.

Setup computes and validates every destination before writing. It aborts on conflicting `agentflow` or `figma` servers, different same-name Skills, malformed managed markers, symbolic links, and path escapes. Writes use same-directory temporary files and rollback this invocation if a later write fails.

Rerun the same setup command after repairing a reported conflict. Existing Run state and completed Artifacts remain intact. See [Host Setup](./docs/HOST_SETUP.md) for host-specific OAuth, diagnostics, recovery, and manual rollback.

## What Gets Installed

- `.agentflow/runtime/bin/agentflow-cli.mjs`
- `.agentflow/runtime/bin/agentflow-mcp.mjs`
- `.agentflow/config.yaml` and `.agentflow/pipeline.yaml` when absent
- `.agents/skills/agentflow-*`
- Pinned Superpowers Skills declared by `skills-lock.json`
- `AGENTS.md` managed routing block
- `.cursor/rules/agentflow.mdc` for Cursor
- `.github/copilot-instructions.md` for VS Code
- `.codex/config.toml`, `.cursor/mcp.json`, or `.vscode/mcp.json`

Generated runtime and machine MCP files are ignored by Git. Portable routing instructions and AgentFlow Skills can be reviewed and committed with the project.

## Contributors

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:distribution
```

Run source commands with:

```bash
npm run cli -- setup --host codex --skip-external-skills
npm run cli -- status
npm run mcp -- --project-root /absolute/project/path
```

The root package exposes the standalone `agentflow` bin. `prepare` rebuilds `bundle/agentflow-cli.mjs` and `bundle/agentflow-mcp.mjs`; the packaged runtime has no dependency on unpublished `@agentflow/*` workspace packages.

## Architecture

- `@agentflow/core`: persistent Run, Stage, Task, Worker, Artifact, resource, preflight, and Gate invariants.
- `@agentflow/cli`: setup, initialization, diagnostics, and operator commands.
- `@agentflow/mcp-server`: Supervisor and Worker state tools over stdio.
- `@agentflow/host-adapter`: portable Worker contract and Codex native bridge.
- `.agents/skills/`: Stage-specific operating contracts, including `agentflow-auto-router` and `agentflow-orchestrator`.

Pipeline `0.4.0` carries typed evidence from discovery through architecture, implementation, integration, QA, release planning, and final verification. Codex native Worker execution has been exercised. Cursor and VS Code persistent configuration is implemented, while their native Worker execution remains an explicit validation boundary. Live Figma evidence also remains blocked until an authenticated host exposes the required tools.

See [AGENTFLOW_PROJECT_SPEC.md](./AGENTFLOW_PROJECT_SPEC.md) for the complete project contract and current boundaries.
