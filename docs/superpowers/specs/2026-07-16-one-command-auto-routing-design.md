# AgentFlow One-Command Setup And Automatic Routing Design

## Status

- Date: 2026-07-16
- Decision: approved approach A
- Audience: developers who want to add AgentFlow to an existing or new repository from Codex, Cursor, or VS Code

## Problem

The current repository is usable by its author, but onboarding another developer requires too many manual steps: clone, install, build, regenerate a machine-specific MCP configuration, copy Skills, initialize AgentFlow, remember a routing prompt, restart the host, and authenticate Figma. The checked-in host configurations also contain one machine's absolute paths, so they are not portable.

The desired experience is:

```bash
npx --yes github:zhangnanlin/agentflow#<release-tag> setup --host codex
```

After the one-time setup and host restart, the user should enter an ordinary product or engineering requirement. The host should automatically start or resume AgentFlow for requests that change the project, without requiring the user to mention `agentflow-orchestrator`.

## Approved Routing Scope

Approach A routes every actual development change through AgentFlow:

- Start or resume AgentFlow for new projects, features, bug fixes, refactors, tests, documentation changes, configuration changes, migrations, design work, and releases.
- Do not create a Run for pure questions, code explanation, read-only inspection, status lookup, or a simple command that does not modify the project.
- `agentflow:on` forces AgentFlow for one request.
- `agentflow:off` bypasses AgentFlow for one request.
- An unfinished current Run is resumed instead of duplicated.
- Human approval remains mandatory at Requirements, Design Direction, Design Freeze, and Release Gates.

This is durable model routing, not a transport-level interception of every chat message. Higher-priority host or user policy can override repository instructions. Once a Run starts, Core and MCP continue to enforce state, Artifact, Worker, and Gate invariants deterministically.

## Considered Installation Approaches

### 1. GitHub-backed `npx` package (selected)

Build standalone CLI and MCP bundles and expose a root `agentflow` binary. `npx` installs a pinned Git tag directly from GitHub, so no npm organization or registry publication is required for the first release.

Advantages: one cross-platform command, version pinning, no curl-to-shell pattern, and a future npm publication can use the same binary contract.

Tradeoff: the first run downloads dependencies and builds the Git package, so it is slower than a registry tarball.

### 2. Clone plus `npm run setup`

Keep the existing monorepo workflow and add a setup command.

Advantages: simplest implementation and easiest debugging.

Tradeoff: still requires cloning, entering the repository, installing dependencies, and remembering where AgentFlow lives. This remains a supported contributor workflow but is not the primary friend-facing path.

### 3. Raw PowerShell or shell bootstrap

Publish an `install.ps1` or `install.sh` and execute it from a raw GitHub URL.

Advantages: visually one line.

Tradeoff: curl/`irm` to shell is difficult to audit, needs separate Windows and POSIX maintenance, and encourages unpinned execution. This approach is rejected.

## Distribution Shape

The root package will expose:

```json
{
  "bin": {
    "agentflow": "bundle/agentflow-cli.mjs"
  }
}
```

The distribution build creates two standalone Node.js 20+ ESM bundles:

- `bundle/agentflow-cli.mjs`
- `bundle/agentflow-mcp.mjs`

The package also contains AgentFlow-owned Skills, `skills-lock.json`, and setup templates. Bundling removes the current runtime dependency on unpublished private workspace packages. Git installation runs a deterministic `prepare` build; normal repository development continues to use the existing workspace packages and tests.

The friend-facing command is pinned to a release tag:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex
```

The same contract supports `cursor`, `vscode`, and `all`. Creating and pushing the release tag remains a separate release action after implementation verification.

## Setup Command

The command accepts:

```text
agentflow setup
  --host codex|cursor|vscode|all
  [--project-root <absolute-or-relative-path>]
  [--dry-run]
  [--skip-external-skills]
  [--start <requirement>]
  [--project-type new|existing]
  [--no-ui]
```

The default project root is the current working directory. Setup performs these steps in order:

1. Check Node.js, Git, target-directory access, package assets, and host selection.
2. Compute every intended filesystem operation without writing.
3. Detect configuration or Skill collisions and stop before mutation when a safe merge is impossible.
4. Initialize `.agentflow/config.yaml` and `.agentflow/pipeline.yaml` idempotently.
5. Copy AgentFlow-owned Skills, including the new `agentflow-auto-router`, into `.agents/skills`.
6. Install the selected pinned Superpowers Skills into an isolated staging directory unless `--skip-external-skills` is set; verify the exact Git commit and reject symlink/path escape before copying.
7. Merge the selected host MCP configuration while preserving unrelated servers and settings.
8. Install or update managed automatic-routing instruction blocks.
9. Run static doctor checks and return a structured summary.
10. Optionally start the first Run when `--start` is provided.

Figma configuration is generated, but host-owned OAuth, Workspace Trust, plugin consent, and account/team selection remain explicit user actions. UI Stages fail closed until a live Figma preflight passes. Non-UI projects do not require Figma.

## Portable Host Configuration

Machine-specific generated files are runtime configuration and must no longer be committed:

- `.codex/config.toml`
- `.cursor/mcp.json`
- `.vscode/mcp.json`

They will be removed from Git tracking and added to `.gitignore`. Setup writes paths for the current machine and project.

JSON host files are parsed and merged structurally. Existing unrelated MCP servers and top-level keys are retained. A conflicting `agentflow` or `figma` entry aborts with a diagnostic instead of being overwritten.

Codex TOML is inspected structurally first. Missing AgentFlow/Figma tables are appended as a managed block. An existing matching block is updated idempotently; a conflicting unmanaged table aborts. Setup never writes tokens, headers, OAuth credentials, or secrets.

## Automatic Routing Surfaces

Setup uses the host's supported persistent instruction surface:

- Codex: a managed section in repository-root `AGENTS.md`.
- Cursor: `.cursor/rules/agentflow.mdc` with `alwaysApply: true`.
- VS Code: a managed section in `.github/copilot-instructions.md` with workspace-wide application.
- Shared workflow: `.agents/skills/agentflow-auto-router/SKILL.md`.

`AGENTS.md` is also useful to VS Code hosts that enable its supported Agent instructions. Separate Cursor and VS Code files make behavior explicit and diagnosable on each host.

The generated instruction is concise:

1. Classify the request using the approved routing scope.
2. For a development change, load `agentflow-auto-router` and inspect `.agentflow/current-run.json` or `status_get` before editing.
3. Resume an unfinished Run; otherwise start one with the user's original requirement, project type, and UI classification.
4. Delegate staged work through `agentflow-orchestrator`; do not silently implement outside the Pipeline.
5. Preserve every human Gate and never infer approval from silence.
6. For an exempt read-only request, answer directly without creating AgentFlow state.

Managed markers allow setup to update only AgentFlow-owned text while preserving existing team instructions:

```text
<!-- agentflow:auto-router:start -->
...
<!-- agentflow:auto-router:end -->
```

Malformed or duplicated markers cause setup to fail closed.

## Idempotency And Failure Handling

Setup is safe to run repeatedly. Exact files are reported as unchanged; managed files are updated only when the desired content differs.

Before writing, setup validates the complete operation plan. Files are written through same-directory temporary files and atomic rename. Existing files that need a managed update are held in memory for rollback. If a write fails, setup restores modified files and removes files created by that invocation.

External Skill retrieval occurs in a temporary directory. The installer verifies the pinned commit, copies only declared Skill directories, rejects links and paths outside the checkout, and removes staging whether setup succeeds or fails.

The result is structured JSON with:

- host and project root
- runtime and MCP entry point
- created, updated, unchanged, and skipped files
- installed Skill names and pinned commits
- doctor status
- required human actions, such as Figma OAuth or host restart

## Testing

Implementation uses test-driven development. Required coverage includes:

- setup creates a usable project from an empty temporary directory
- Codex, Cursor, VS Code, and `all` host modes
- repeated setup is idempotent
- dry-run writes nothing
- managed instruction merge preserves unrelated content
- malformed or duplicated markers fail before mutation
- JSON MCP merge preserves unrelated servers and rejects conflicts
- Codex TOML merge preserves unrelated tables and rejects conflicts
- setup rollback restores files after an injected write failure
- Skill copy rejects symlink and traversal escapes
- an unfinished Run is selected for resume by the router contract
- pure questions and read-only commands are exempt in router fixtures
- project-changing requests route to AgentFlow in router fixtures
- local packed distribution executes its CLI and MCP bundles outside the monorepo
- `npm pack --dry-run` contains bundles, Skills, lock data, and no machine-specific configuration
- repository tests, typecheck, build, Skill validation, three host doctors, and a clean Git diff pass

## Documentation And Migration

README will lead with the one-command setup path and retain contributor commands separately. `docs/HOST_SETUP.md` will describe the one remaining host restart/OAuth step and troubleshooting. Existing users can run `agentflow setup --host <host>` once; it replaces only managed AgentFlow blocks and leaves current Run data untouched.

The current hard-coded host configuration snapshots will be removed from the repository. They contain no credentials, and removing them does not modify the local ignored copies after users regenerate them.

## Non-Goals

- Installing Codex, Cursor, VS Code, Node.js, or Git.
- Automating OAuth consent, account selection, Workspace Trust, or editor restart.
- Intercepting chat transport before the model receives a request.
- Bypassing higher-priority host, organization, or user instructions.
- Automatically approving Requirements, Design, or Release Gates.
- Publishing to npm or creating a Git tag without a separate verified release decision.

## Official Host Basis

- Codex automatically loads repository `AGENTS.md` guidance and can delegate when applicable `AGENTS.md` or Skill instructions request it: <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Cursor Project Rules support an Always rule stored under `.cursor/rules`: <https://docs.cursor.com/context/rules>
- VS Code automatically applies `.github/copilot-instructions.md` to workspace chat requests and supports `AGENTS.md`: <https://code.visualstudio.com/docs/agent-customization/custom-instructions>
