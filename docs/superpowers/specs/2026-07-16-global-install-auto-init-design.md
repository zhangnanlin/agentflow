# AgentFlow Global Installation And Lazy Project Initialization Design

## Status

- Date: 2026-07-16
- Decision: approved
- Selected approach: global user installation with per-request project resolution
- Hosts: Codex, Cursor, and VS Code
- Target distribution version: 0.3.0

## Problem

AgentFlow 0.2.0 installs a complete runtime, Skills, routing instructions, and
MCP configuration into every project. This makes each repository independently
portable, but it repeats machine-owned files and requires users to run setup in
every new repository.

The desired experience is one machine-level installation:

```bash
npx --yes github:zhangnanlin/agentflow setup --host all
```

After that command and any required host restart or Figma OAuth, users should
enter ordinary requests in any project. A project-changing request must start
or resume AgentFlow and initialize only that project's state on first use. Pure
questions and read-only requests must not create AgentFlow state.

The unversioned GitHub package selector resolves the repository's default
branch. AgentFlow therefore treats `main` as release-ready and keeps explicit
Git tags available for users who require reproducible installation.

## Goals

1. Install the AgentFlow runtime and reviewed Skills once per user account.
2. Configure Codex, Cursor, and VS Code user-level MCP discovery once per host.
3. Resolve the active project at tool-call time without binding the global MCP
   configuration to one absolute repository path.
4. Initialize a lightweight `.agentflow/` directory only when the first
   project-changing request starts or resumes a Run.
5. Keep Run state, current-Run selection, Artifacts, Gates, and Worker leases
   isolated by project.
6. Preserve automatic routing and every existing human Gate.
7. Keep AgentFlow 0.2.0 project-scoped installations operational.
8. Make repeated global setup and repeated first-use routing idempotent and
   recoverable.

## Non-Goals

- A resident background daemon or shared network service.
- Moving project Run state into a user-global database.
- Automatically removing existing 0.2.0 project runtime or host files.
- Automatically approving Requirements, Design, Engineering Plan, or Release
  Gates.
- Automating Figma OAuth, editor restart, Workspace Trust, or account choice.
- Publishing to npm as part of this change.
- Supporting arbitrary VS Code named or portable profiles without an explicit
  user configuration path.

## Considered Approaches

### 1. Global runtime with dynamic project resolution (selected)

Install executable assets and Skills under user-owned directories. Configure
one MCP entry per host. Resolve and validate the active project for each tool
call, then keep state in that project's `.agentflow/` directory.

This provides one installation, strong project isolation, no daemon lifecycle,
and a backward-compatible path for fixed project roots.

### 2. Global runtime with a generated project launcher

Install binaries once but create a thin MCP and instruction file in each
project on first use. This is simpler internally, but it still mutates host
configuration per repository and may require an editor restart before the
first request can continue. It does not satisfy zero-touch first use.

### 3. Resident multi-project AgentFlow service

Run one long-lived local HTTP MCP service with a global project registry. This
supports arbitrary project switching but introduces process supervision,
ports, authentication, concurrency, stale registrations, and upgrade concerns
that the current local stdio architecture does not need.

## Global Installation Layout

`AGENTFLOW_HOME` controls the runtime root. Its default is
`$HOME/.agentflow`:

```text
~/.agentflow/
  bin/
    agentflow-cli.mjs
    agentflow-mcp.mjs
  skills-lock.json
  install.json

~/.agents/skills/
  agentflow-*/
  brainstorming/
  writing-plans/
  ...other lock-declared Superpowers Skills
```

`install.json` records the installed AgentFlow version, distribution revision,
runtime paths, selected hosts, Skill names, and pinned external commits. It
contains no token, Authorization header, OAuth credential, or secret.

The primary command is:

```text
agentflow setup
  --host codex|cursor|vscode|all
  [--scope global|project]
  [--dry-run]
  [--skip-external-skills]
  [--vscode-config <absolute-path>]
```

`--scope` defaults to `global`. `--scope project` preserves the 0.2.0 setup
contract, including `--project-root`, `--start`, `--project-type`, and
`--no-ui`. Global setup rejects project-only options instead of silently
ignoring them.

## User-Level Host Configuration

Global setup merges only the `agentflow` and `figma` server definitions and
preserves every unrelated setting.

### Codex

- Target: `$CODEX_HOME/config.toml`, defaulting to `~/.codex/config.toml`.
- AgentFlow entry: `node ~/.agentflow/bin/agentflow-mcp.mjs` with no fixed
  `--project-root` argument.
- Figma entry: `https://mcp.figma.com/mcp` with host-managed OAuth.
- The existing structural TOML conflict and managed-marker checks remain in
  force.

### Cursor

- Target: `~/.cursor/mcp.json`.
- AgentFlow entry: the global MCP bundle with no fixed project argument.
- Figma entry: the same Remote MCP URL.
- The JSON merge preserves unrelated top-level keys and MCP servers.

### VS Code

- Default target on Windows: `%APPDATA%/Code/User/mcp.json`.
- Default target on macOS: `~/Library/Application Support/Code/User/mcp.json`.
- Default target on Linux: `${XDG_CONFIG_HOME:-~/.config}/Code/User/mcp.json`.
- `--vscode-config` selects a different user-profile or portable configuration
  file and must be absolute.
- Setup uses the same structural JSON merge as project-scoped VS Code setup.

Host configuration never sets either MCP server as globally required. A Figma
outage or missing OAuth must block only a Stage that declares Figma
capabilities.

## Automatic Routing

The cross-host routing contract has two reinforcing sources:

1. `agentflow-auto-router` is installed as a user Skill in
   `~/.agents/skills` with implicit invocation enabled and a description that
   matches every project-changing request.
2. The global MCP server publishes the canonical routing contract through the
   MCP initialization `instructions` field. Its first 512 characters contain
   the mutation-vs-read classification, start-or-resume rule, and human-Gate
   requirement.

The canonical text has one source module shared by the CLI renderer and MCP
server. Tests reject drift between the installed Skill, legacy project
instructions, and MCP initialization instructions.

The router bypasses AgentFlow for pure questions, code explanation, read-only
inspection, status lookup, and simple non-mutating commands. `agentflow:on`
and `agentflow:off` remain one-request overrides.

## Dynamic Project Resolution

Every MCP tool accepts an optional absolute `projectRoot`. A common resolver
selects the project in this order:

1. A fixed `--project-root` or `AGENTFLOW_PROJECT_ROOT`, retained for 0.2.0
   project configurations and explicit operator use.
2. The tool's explicit `projectRoot`.
3. The single file root returned by the MCP client's `roots/list` capability.
4. The Git top-level directory containing the MCP process working directory.
5. The MCP process working directory when it is an existing real directory.

An explicit root must match or be contained by one of the client-advertised
file roots when the client supplies roots. File URIs are decoded with a
standards-based URL parser. Non-file roots are ignored.

The resolver canonicalizes paths, verifies that the result is a directory,
and records both the requested and canonical paths. It never accepts an empty,
relative, missing, or file path as a project root.

When the client advertises multiple file roots and the call omits
`projectRoot`, resolution fails with `PROJECT_ROOT_AMBIGUOUS` and returns the
canonical candidates. When no trustworthy root can be established, it fails
with `PROJECT_ROOT_UNRESOLVED`. Neither error creates files.

All tool handlers resolve `ProjectPaths` inside the call. No mutable global
"current project" is stored in the MCP process, so concurrent conversations
cannot redirect each other's operations.

## Lazy Project Initialization

The MCP server adds a mutating `run_start_or_resume` tool with this logical
input:

```ts
interface RunStartOrResumeInput {
  projectRoot?: string;
  requirement: string;
  projectType: "new" | "existing";
  hasUi: boolean;
  requestedRunId?: string;
  requestKey: string;
}
```

For a project-changing user request, the router invokes this tool before other
state tools. The operation:

1. Resolves and validates the project root.
2. Acquires a project-level initialization lock.
3. Creates missing project control files without replacing existing ones.
4. Recovers any pending Run-start journal left by an interrupted invocation.
5. Loads the current Run when the pointer exists.
6. Returns that Run with `action: "resumed"` when it is unfinished.
7. Otherwise creates exactly one new Run, atomically updates the current-Run
   pointer, and returns `action: "started"`.
8. Removes the pending journal and releases the lock.

`requestKey` makes retries idempotent. The pending journal stores the generated
Run ID and the hash of the immutable request fields before the Run file is
created. A retry with the same key completes the interrupted operation; reuse
with different fields fails with `IDEMPOTENCY_CONFLICT`.

The project receives only:

```text
.agentflow/
  .gitignore
  config.yaml
  pipeline.yaml
  current-run.json       # ignored
  runs/                  # ignored
```

The nested `.agentflow/.gitignore` ignores `runtime/`, `runs/`,
`current-run.json`, lock files, pending journals, and temporary files. It does
not edit the repository's root `.gitignore`. `config.yaml` and `pipeline.yaml`
remain reviewable and may be committed by a team.

`status_get` and other read tools never initialize a missing project. Before
initialization they return `PROJECT_NOT_INITIALIZED` with the resolved project
path and direct the router to call `run_start_or_resume` only for a
project-changing request.

## Setup Safety And Idempotency

Global setup performs all discovery and validation before writing:

- Node.js 20+, Git, home directory, selected host, distribution assets, and
  optional VS Code config path.
- Every source and destination path, including parent links and exact allowed
  roots.
- Skill equality or collision.
- Host configuration syntax, unrelated content preservation, and managed
  server conflicts.
- The complete runtime, Skill, lock, manifest, and host-configuration write
  plan.

Writes use same-directory temporary files and atomic rename. The executor
revalidates each destination against its snapshot immediately before writing.
If an operation fails, it restores this invocation's prior bytes in reverse
order. Rollback refuses to overwrite a path changed by another process and
reports every incomplete restoration.

Repeated setup updates AgentFlow-owned files, preserves unrelated files, and
reports created, updated, unchanged, skipped, and required-action lists.
`--dry-run` performs the same validation and returns `doctor.ok: null` without
writing.

## Backward Compatibility And Migration

- The MCP executable continues to accept `--project-root` and
  `AGENTFLOW_PROJECT_ROOT`.
- Existing project `.codex/config.toml`, `.cursor/mcp.json`, or
  `.vscode/mcp.json` entries continue to launch a project-bound server.
- Existing project `.agents/skills`, routing instructions, runtime bundles,
  and Run state remain valid.
- Project configuration has normal host precedence over user configuration, so
  an old repository keeps its fixed-root behavior until the user removes its
  generated project host entry.
- Global setup never scans repositories and never removes project files.
- `setup --scope project` remains available for teams that deliberately want
  repository-contained installation.

Documentation provides a manual migration checklist that removes only
AgentFlow-managed project runtime, Skills, instructions, and host entries after
the user confirms there is no active dependency on them. It never deletes
`.agentflow/runs/`.

## Doctor Behavior

`agentflow doctor --host <host>` reports two independent sections:

- `installation`: global runtime, lock, Skills, selected user MCP
  configuration, Node.js, Git, restart, and Figma OAuth caveats.
- `project`: resolved root and one of `initialized`, `not-initialized`, or
  `invalid` for config, pipeline, current Run, and state directories.

An uninitialized project is healthy before first use and therefore does not
make global setup fail. Invalid existing AgentFlow files are blocking and are
never replaced automatically.

## Version And Documentation Policy

This breaking setup-default change increments the root distribution version to
`0.3.0`. The primary English and Chinese README command omits a Git selector:

```bash
npx --yes github:zhangnanlin/agentflow setup --host codex
```

The command follows `main`. Repository policy requires feature work to land
through verified commits and keeps `main` installable. Documentation explains
that users needing immutable installation should append a released Git tag.
Tag creation and push remain subject to the AgentFlow Release Gate.

## Testing Strategy

Implementation follows red-green-refactor. Required automated evidence:

1. Global path selection for Windows, macOS, Linux, `AGENTFLOW_HOME`,
   `CODEX_HOME`, and explicit VS Code configuration.
2. Global setup for each host and `all`, repeated setup, dry-run, rollback,
   target-change detection, symlink rejection, Skill collision, and malformed
   host configuration.
3. MCP project resolution for fixed roots, explicit roots, one client root,
   multiple roots, non-file roots, Git fallback, working-directory fallback,
   missing directories, and out-of-workspace explicit roots.
4. `run_start_or_resume` initialization, resume, completed-Run replacement,
   retry idempotency, conflicting request keys, concurrent calls, interrupted
   journal recovery, and invalid existing project files.
5. Two simultaneous project roots using one server implementation without
   state crossover.
6. Read-only tools proving that a missing `.agentflow/` remains absent.
7. Existing fixed-root MCP and `--scope project` setup regressions.
8. Packed-distribution execution from outside the monorepo with a temporary
   home directory and two temporary repositories.
9. English and Chinese documentation checks proving that the primary command
   has no Git tag and that no stale project-runtime instructions remain.

Final verification includes the complete test suite, TypeScript checks,
workspace build, standalone distribution build, every AgentFlow Skill
validator, all three static host doctors, package-content inspection,
`git diff --check`, and an unversioned GitHub `npx` smoke test after the verified
revision reaches `main`.

## Acceptance Criteria

- One successful global setup makes AgentFlow Skills and MCP tools available in
  Codex, Cursor, and VS Code without running setup in each repository.
- A new repository remains untouched after read-only requests.
- Its first project-changing request creates only lightweight project state and
  starts or resumes exactly one Run.
- Two repositories never share Run, Artifact, Gate, Task, Worker, resource, or
  current-Run state.
- Multi-root ambiguity and unsafe paths fail before any write.
- Existing project-scoped installations and fixed-root MCP invocation continue
  to pass their tests.
- The primary README setup command contains no explicit version selector.
- No Release tag or external publication occurs without an approved Release
  Plan bound to current QA evidence.

## Official Host Basis

- Codex user and project configuration, MCP, global `AGENTS.md`, and personal
  Skills: <https://learn.chatgpt.com/docs/config-file/config-advanced>,
  <https://learn.chatgpt.com/docs/mcp>, and
  <https://learn.chatgpt.com/docs/build-skills>
- Cursor global MCP configuration and user rules:
  <https://docs.cursor.com/context/model-context-protocol> and
  <https://docs.cursor.com/context/rules>
- VS Code user-profile MCP servers, personal Skills, and profile instructions:
  <https://code.visualstudio.com/docs/agent-customization/mcp-servers>,
  <https://code.visualstudio.com/docs/agent-customization/agent-skills>, and
  <https://code.visualstudio.com/docs/agent-customization/custom-instructions>
