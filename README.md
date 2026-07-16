[English](./README.md) | [简体中文](./README.zh-CN.md)

# AgentFlow

AgentFlow coordinates a resumable software-delivery pipeline across one Supervisor task and bounded Worker tasks in Codex, Cursor, or VS Code. Install it once for your user account; each repository receives only lightweight state when its first project-changing request arrives.

## Install Once

Prerequisites: Node.js 20 or newer, Git, and Codex, Cursor, or VS Code.

```bash
npx --yes github:zhangnanlin/agentflow setup --host codex
```

Use `cursor`, `vscode`, or `all` for another host:

```bash
npx --yes github:zhangnanlin/agentflow setup --host all
```

The command without a Git selector follows the repository's current default branch. For a reproducible installation, use an immutable release tag only after that tag has passed the AgentFlow Release Gate and is published.

Global setup installs:

- CLI, MCP bundle, lock data, and `install.json` under `~/.agentflow`
- AgentFlow and reviewed external Skills under `~/.agents/skills`
- Codex MCP configuration at `$CODEX_HOME/config.toml`, defaulting to `~/.codex/config.toml`
- Cursor MCP configuration at `~/.cursor/mcp.json`
- VS Code user `mcp.json` for the current platform

It merges only the `agentflow` and `figma` server entries, preserves unrelated settings, and never writes tokens, OAuth credentials, or authorization headers. Restart the selected host after first setup, then complete Figma OAuth once in that host when a UI Stage needs it.

## First Project Use

Enter an ordinary requirement in any repository. The installed router classifies the request automatically; you do not need to paste an AgentFlow prompt.

For a project-changing request, it calls `run_start_or_resume` with the original requirement before other state mutations. The call either resumes the unfinished Run or initializes lightweight project control files and starts one Run. Pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands do not initialize the repository.

Lazy initialization creates only project state such as:

```text
.agentflow/
  .gitignore
  config.yaml
  pipeline.yaml
  current-run.json
  runs/
  start-requests/
```

It does not copy the runtime, Skills, routing instructions, or host configuration into the project, and it does not edit the root `.gitignore`.

`agentflow:on` forces routing for one request. `agentflow:off` bypasses it for one request. Human Requirements, Design Direction, Design Freeze, Engineering Plan, and Release Gates remain explicit.

## Fast Git Sync

An explicit request to `git push` commits or tags that already exist locally uses a deterministic fast path. AgentFlow verifies the clean worktree, local revision, remote, and fast-forward relationship, performs the normal push, then reads the remote branch and dereferenced tag refs. It does not create a Run, model Worker, release plan, or observation timer.

The fast path never permits `--force`, remote ref deletion, history rewriting, GitHub Release creation, package publication, migration, or deployment. A request that still needs file changes or commits remains project-changing and starts or resumes AgentFlow. Package publication and production deployment retain their explicit Release Gates; production also retains rollback, health checks, and a positive observation window.

Examples:

```text
Push the current branch.                         -> fast Git sync
Create annotated tag v1.2.3 here and push it.   -> fast Git sync
Fix the README, commit it, and push.             -> AgentFlow Run
Publish the package or deploy production.        -> AgentFlow release
```

## Multiple Projects

One global MCP executable can serve multiple projects without a global queue. Each tool call resolves an immutable project context, and each repository owns its Run state and `.agentflow/.start.lock`. Project A and project B can initialize and execute concurrently; only competing first-use calls inside the same project serialize briefly.

Resolution priority is:

1. Fixed `--project-root` or `AGENTFLOW_PROJECT_ROOT` compatibility root
2. Explicit absolute `projectRoot` in the MCP call
3. One client workspace root
4. Git top-level directory
5. MCP process working directory

When a client exposes multiple workspace roots, the caller must pass an explicit absolute `projectRoot`. AgentFlow fails closed instead of guessing or queueing the request.

## Setup And Doctor

Validate global setup without writing:

```bash
npx --yes github:zhangnanlin/agentflow setup --host codex --dry-run
```

Override user paths when needed:

```bash
AGENTFLOW_HOME=/absolute/runtime/path \
CODEX_HOME=/absolute/codex/path \
npx --yes github:zhangnanlin/agentflow setup --host codex

npx --yes github:zhangnanlin/agentflow setup --host vscode \
  --vscode-config /absolute/profile/mcp.json
```

`--vscode-config` must be absolute. On Windows, `AGENTFLOW_HOME` and `CODEX_HOME` use the same environment-variable names.

Run the globally installed doctor for a project:

```bash
node ~/.agentflow/bin/agentflow-cli.mjs \
  --project-root /absolute/project/path doctor --host codex
```

Doctor reports independent `installation` and `project` sections. `project.status: not-initialized` is healthy before first changing use; malformed existing config, pipeline, or Run state is blocking. A healthy static report may still be `warn` because restart and Figma OAuth require live host evidence.

## Project Scope Compatibility

AgentFlow 0.2 project-contained installation remains available explicitly:

```bash
npx --yes github:zhangnanlin/agentflow \
  --project-root /absolute/project/path setup --scope project --host codex
```

Project scope keeps fixed-root runtime, Skills, routing files, host configuration, `--start`, `--project-type`, and `--no-ui` behavior. Global setup rejects those project-only start options.

Existing project MCP configuration normally takes precedence over user configuration, so a 0.2 repository remains fixed to its project server until its AgentFlow-owned project host entry is removed.

## Migrate From 0.2

1. Run global setup for the host and restart it.
2. Run global doctor against the repository and confirm the global runtime, router Skill, and user host configuration.
3. Keep `.agentflow/config.yaml`, `.agentflow/pipeline.yaml`, `.agentflow/current-run.json`, and the entire `.agentflow/runs/` history.
4. Remove old AgentFlow-owned project MCP entries only after confirming the global server resolves that repository correctly.
5. Optionally remove the old project runtime, copied Skills, and managed routing blocks after confirming no active workflow depends on them.

Global setup never scans repositories and never removes project files. See [Host Setup](./docs/HOST_SETUP.md) for exact paths, rollback, OAuth, multi-root handling, and migration details.

## Contributors

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:distribution
```

Source compatibility commands:

```bash
npm run cli -- setup --scope project --host codex --skip-external-skills
npm run cli -- status
npm run mcp -- --project-root /absolute/project/path
```

The root package exposes the standalone `agentflow` bin. Packaged bundles do not depend on unpublished workspace packages. See [AGENTFLOW_PROJECT_SPEC.md](./AGENTFLOW_PROJECT_SPEC.md) for the full pipeline, state, Worker, Artifact, and Gate contract.
