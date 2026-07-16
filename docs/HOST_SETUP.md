# AgentFlow Host Setup

This guide covers user-global installation, host OAuth, dynamic project resolution, diagnostics, compatibility, migration, and rollback for Codex, Cursor, and VS Code.

## Global Setup

Install AgentFlow once for the current user:

```bash
npx --yes agentflow@0.4.0 setup --host codex
```

Use `cursor`, `vscode`, or `all` for another host. Run the same command again to update AgentFlow-owned files while preserving unrelated Skills and host settings. Preview the complete validated write plan with `--dry-run`.

The npm version is immutable. The corresponding immutable Git tag is an alternative for environments that install directly from GitHub:

```bash
npx --yes github:zhangnanlin/agentflow#v0.4.0 setup --host codex
```

### Update An Existing Installation

To load AgentFlow 0.4.0, an existing user reruns the same global setup command:

```bash
npx --yes agentflow@0.4.0 setup --host codex
```

Restart Codex if it has not reloaded the installed bundle. Do not rerun setup in individual projects. The update reuses the existing AgentFlow MCP entry and introduces no new MCP server or OAuth flow; Figma OAuth remains a separate host-managed action only when a UI Stage requires it.

### User Paths

| Surface | Default path |
| --- | --- |
| Runtime, lock, manifest | `~/.agentflow` |
| CLI | `~/.agentflow/bin/agentflow-cli.mjs` |
| MCP server | `~/.agentflow/bin/agentflow-mcp.mjs` |
| Personal Skills | `~/.agents/skills` |
| Codex config | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` |
| Cursor config | `~/.cursor/mcp.json` |
| VS Code on Windows | `%APPDATA%/Code/User/mcp.json` |
| VS Code on macOS | `~/Library/Application Support/Code/User/mcp.json` |
| VS Code on Linux | `${XDG_CONFIG_HOME:-~/.config}/Code/User/mcp.json` |

Set `AGENTFLOW_HOME` to move the global runtime, `CODEX_HOME` to select another Codex profile, or pass an absolute `--vscode-config` for a named or portable VS Code profile.

The installed AgentFlow MCP entry has no `--project-root`. Global setup never writes runtime, Skills, instructions, or host configuration into a repository.

## Merge And Transaction Rules

Setup structurally merges only the `agentflow` and `figma` MCP entries. It preserves unrelated TOML/JSON settings and servers. It rejects malformed configuration, conflicting managed servers, different same-name Skills, path traversal, linked parents, changed targets, and unsafe overwrite races.

Every destination carries an exact user-owned safety root. Setup validates all destinations before the first write, uses same-directory temporary files and atomic rename, then restores this invocation's prior bytes in reverse order if a later write fails. Rollback refuses to overwrite a file another process changed during recovery.

`~/.agentflow/install.json` records non-secret version, bundle or revision identity, runtime paths, selected hosts, installed Skill names, and pinned commits. It never contains tokens, OAuth credentials, headers, or environment secrets.

## Host Authentication

AgentFlow configures Figma as `https://mcp.figma.com/mcp` without credentials and without making it globally required. Authentication is host-owned and needed only when an active Stage declares Figma capabilities.

### Codex

1. Run global setup with `--host codex`.
2. Restart Codex if it does not reload the user MCP configuration.
3. Authenticate through the MCP server list or `codex mcp login figma`.
4. Before S04, inspect the live tool registry and call Figma `whoami`.

### Cursor

1. Run global setup with `--host cursor`.
2. Restart Cursor if needed.
3. Connect Figma in MCP settings or use the host's MCP login command.
4. Confirm the live Figma tools before S04.

### VS Code

1. Run global setup with `--host vscode` and, for non-default profiles, an absolute `--vscode-config`.
2. Reload the VS Code window.
3. Run `MCP: List Servers`, start Figma, and complete Allow Access.
4. Confirm the live Figma tools before S04.

Static configuration is not proof of restart or OAuth. AgentFlow records those uncertainties as warnings and blocks only a Stage whose declared capabilities are missing.

## Structured User Input

For material bounded decisions, AgentFlow requests clickable choices through MCP form elicitation or an already exposed host-native structured control. It may batch at most three independent questions; dependent questions remain sequential, and recommendations never preselect an answer. The form accepts only non-sensitive single-select values and rejects secrets, credentials, payment data, and OAuth fields.

A pending human Gate is presented from persisted Run state and finalized in one explicit interaction bound to the current Artifact hash. Decline, cancellation, timeout, disconnect, stale revision, and concurrent conflict paths leave the Gate unchanged. When structured controls are unsupported, AgentFlow issues one concise text fallback and does not repeat an accepted answer.

Structured input is provided by the existing AgentFlow MCP server. It is not another server entry, does not require a mode switch, and has no authentication flow of its own.

## Project Resolution

The global MCP server resolves an immutable project context for each call in this order:

1. Fixed `--project-root` or `AGENTFLOW_PROJECT_ROOT` supplied when the MCP process starts
2. Explicit absolute `projectRoot` supplied to the tool call
3. Exactly one file workspace root advertised by the client
4. Git top-level directory for the MCP working directory
5. MCP working directory

Accepted roots are canonical existing directories. An explicit root must remain inside an advertised workspace when client roots are available. Non-file URIs, relative paths, files, missing directories, and boundary escapes fail closed.

When the client advertises multiple workspace roots, pass the intended absolute `projectRoot` on `run_start_or_resume` and every later AgentFlow call. AgentFlow does not guess and does not put ambiguous projects into a queue.

One MCP process can handle independent projects concurrently. State, request records, journals, and `.agentflow/.start.lock` belong to each project. Only competing first-use operations in the same project serialize briefly.

## Lazy Initialization

For every project-changing request, the automatic router calls `run_start_or_resume` before another state mutation. It supplies the original requirement, new/existing classification, UI classification, and a stable request key. The operation either resumes the unfinished Run or creates one new Run.

On first use, it creates lightweight state only:

```text
.agentflow/
  .gitignore
  config.yaml
  pipeline.yaml
  current-run.json
  runs/
  start-requests/
```

The operation is project-locked, journaled, idempotent, and crash-recoverable. It does not edit the root `.gitignore`. Read-only calls never initialize a missing project and return `PROJECT_NOT_INITIALIZED` when project state is required.

## Doctor

Run doctor from the global runtime while naming the project:

```bash
node ~/.agentflow/bin/agentflow-cli.mjs \
  --project-root /absolute/project/path doctor --host codex
```

The report contains:

- `installation`: Node, Git, global CLI/MCP, manifest, lock, router Skill, selected user host config, and restart/OAuth warnings
- `project`: resolved root and `initialized`, `not-initialized`, or `invalid` evidence for config, pipeline, and current Run

`not-initialized` is non-blocking before first changing use. An existing malformed `.agentflow` directory is blocking and is never replaced automatically.

For a Stage capability check, add `--stage`, `--live-probe`, and canonical `--capability` values collected from the current host. Provider-qualified live tools and Skills count; arbitrary lookalike names do not.

## Project Scope Compatibility

Use explicit project scope when repository-contained AgentFlow 0.2 behavior is required:

```bash
npx --yes agentflow@0.4.0 \
  --project-root /absolute/project/path setup --scope project --host codex
```

Project scope retains `.agentflow/runtime`, copied Skills, managed instruction surfaces, project host configuration, fixed MCP roots, and the optional `--start`, `--project-type`, and `--no-ui` flow. The MCP executable also continues to accept a fixed `--project-root` or `AGENTFLOW_PROJECT_ROOT`.

Project host configuration normally takes precedence over user configuration. Therefore an existing 0.2 repository continues to use its fixed-root server until its AgentFlow-owned project server entry is removed.

## Migration And Rollback

To migrate a 0.2 repository:

1. Run global setup and restart/authenticate the host.
2. Run global doctor against the repository.
3. Confirm that a changing request resolves the intended root and resumes the expected Run.
4. Preserve `.agentflow/config.yaml`, `.agentflow/pipeline.yaml`, `.agentflow/current-run.json`, and all `.agentflow/runs/` data.
5. Remove the old AgentFlow-owned project host entry so the user-level dynamic server takes precedence.
6. Optionally remove old project runtime, copied Skills, and managed instruction blocks only after confirming nothing still depends on them.

Global setup never scans or deletes repositories. Never delete `.agentflow/runs/` during migration or rollback.

To roll back the global installation manually, first stop host MCP processes. Back up `~/.agentflow/install.json`, remove only the global AgentFlow runtime and AgentFlow-owned Skills listed there, and structurally remove only the `agentflow` and `figma` entries that point to that runtime from selected user configs. Preserve unrelated host settings and Skills. Restore the previous files from backup if any check fails.
