# AgentFlow Host Setup

This guide covers user-global installation, Supervisor and Worker separation, host OAuth, dynamic project resolution, diagnostics, compatibility, migration, and rollback for Codex, Cursor, and VS Code.

## Global Setup

Install AgentFlow once for the current user:

```bash
npx --yes agentflow@0.5.0 setup --host codex
```

Use `cursor`, `vscode`, or `all` for another host. Run the same command again to update AgentFlow-owned files while preserving unrelated Skills, custom agents, and host settings. Preview the complete validated write plan with `--dry-run`.

The npm version is immutable. The corresponding immutable Git tag is an alternative for environments that install directly from GitHub:

```bash
npx --yes github:zhangnanlin/agentflow#v0.5.0 setup --host codex
```

### Update An Existing Installation

To load AgentFlow 0.5.0, an existing user reruns the same global setup command:

```bash
npx --yes agentflow@0.5.0 setup --host codex
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
| Codex Worker profile | `$CODEX_HOME/agents/agentflow-worker.toml` |
| Cursor Worker profile | `~/.cursor/agents/agentflow-worker.md` |
| VS Code Worker profile | `~/.copilot/agents/agentflow-worker.agent.md` |

Set `AGENTFLOW_HOME` to move the global runtime, `CODEX_HOME` to select another Codex profile, or pass an absolute `--vscode-config` for a named or portable VS Code profile.

The installed AgentFlow MCP entry has no `--project-root`. Global setup never writes runtime, Skills, instructions, or host configuration into a repository.

## Supervisor And Worker Separation

The main Supervisor remains the only AgentFlow control-plane participant. Its normal host configuration keeps the `agentflow` MCP server so it can route work, persist Task and Worker facts, collect terminal results, integrate changes, and reconcile cleanup.

Delegated work uses the host's native `agentflow-worker` profile instead:

| Host | Native profile behavior |
| --- | --- |
| Codex | A standalone custom-agent TOML profile requests a fresh context and uses an empty `[mcp_servers]` table so Supervisor MCP servers are not inherited. |
| Cursor | A custom subagent Markdown profile exposes only repository read, search, edit, and shell tools; it omits MCP and nested Task tools. |
| VS Code | A `.agent.md` custom agent uses an explicit `search`, `edit`, `runCommands`, and `runTests` allowlist with `agents: []`; no MCP tool set is included. |

All three profiles instruct the Worker to consume only the bounded Task envelope and referenced repository evidence, never import the Supervisor transcript or full Run state, never create nested agents, and return a compact result before cleanup. Project-scope compatibility setup installs the corresponding files under `.codex/agents/`, `.cursor/agents/`, or `.github/agents/`.

A valid profile file proves only static setup intent. Before native delegation, the live host adapter must still attest zero-history context, an enforced bounded tool profile, AgentFlow MCP disabled, and the required lifecycle operations. Missing or non-conforming evidence causes inline or serial Supervisor fallback; AgentFlow does not infer conformance from files, prose, or GUI state.

### Native Execution Lifecycle

For each independent wave, the Supervisor claims one eligible Task and continues that work while conforming native Workers execute the remaining disjoint Tasks. It uses one event-driven `waitAny` or completion notification for active Workers; heartbeats and timers do not consume model turns. AgentFlow never launches a custom Agent CLI Worker process.

The native v2 handle must match the prepared Worker ID, Task ID, native ID, task name, prompt hash, adapter version, prompt byte count, context policy, and tool policy. `inheritedTurnCount` must be `0`; the allowlist must be enforced and must exclude AgentFlow MCP and nested-agent tools. Any mismatch fails closed before binding.

Cleanup is durable first and visible second:

1. Collect and persist a valid terminal result, or persist a confirmed failure or interruption.
2. Close native execution when supported.
3. Archive the child task when the host reports archive support. Never archive the Supervisor task.
4. Release the exact host Worker permit.
5. Persist the host-, adapter-version-, Worker-, and native-ID-bound receipt with `worker_cleanup_record`.

Codex child tasks are removed after successful supported archive. Cursor or VS Code operations that are unavailable are recorded as `unsupported`, not treated as success. Resume re-probes capabilities and retries only supported incomplete cleanup; it never redispatches a Task whose result is already durable.

### Host Budget And 429 Recovery

The scheduler state lives under `~/.agentflow/scheduler` and is shared by MCP processes for the same sanitized host/profile budget key. Capacity defaults to one active model Worker. Leases and host-side heartbeats prevent abandoned permits from becoming permanent, and expiry requires confirmed recovery before reuse.

A classified 429 opens a persisted circuit. AgentFlow honors bounded `Retry-After` when present; otherwise it applies bounded exponential backoff with jitter. Dispatch during cooldown performs no native spawn, and a half-open circuit permits one recovery probe. Deterministic operations bypass the model permit rather than increasing concurrency.

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

For a non-mandatory choice with a documented recommendation, AgentFlow applies and records that default without opening a user interaction. For a genuinely blocking material choice without a safe default, it requests clickable choices through MCP form elicitation or an already exposed host-native structured control. It may batch at most three independent questions; dependent questions remain sequential, and recommendations shown in a control never preselect an answer. The form accepts only non-sensitive single-select values and rejects secrets, credentials, payment data, and OAuth fields.

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
- `runtime.processes`: sanitized AgentFlow MCP process count, aggregate working set when available, and age-based stale candidates
- `runtime.runs` and `runtime.responseBudgets`: bounded largest-Run summaries and violations of the 8192-byte status or 4096-byte mutation budgets
- `runtime.scheduler`: active and expired permits plus the current persisted cooldown state
- `runtime.cleanup`: pending, unsupported, failed, completed, and stale-live Worker lifecycle counts
- `runtime.nativeAdapter`: live fresh-context and tool-profile conformance, kept separate from static Worker profile health
- `skillPolicy`: legacy, warning, invalid, or valid reviewed policy status and active policy count

`not-initialized` is non-blocking before first changing use. An existing malformed `.agentflow` directory is blocking and is never replaced automatically.

For a Stage capability check, add `--stage`, `--live-probe`, and canonical `--capability` values collected from the current host. Provider-qualified live tools and Skills count; arbitrary lookalike names do not.

When the native host bridge exports a `NativeCapabilitySnapshot` v2 file, include it explicitly:

```bash
node ~/.agentflow/bin/agentflow-cli.mjs \
  --project-root /absolute/project/path doctor \
  --host codex \
  --adapter-snapshot /absolute/path/native-capability.json
```

The snapshot path is read with a 64 KB bound. Invalid input is rejected without echoing its contents. Runtime diagnostics return aggregate numbers, bounded hashes, fixed status labels, and counts; they never return process command lines, environment values, adapter reason text, tokens, credentials, or OTPs.

After a Worker becomes terminal, AgentFlow persists its result or failure evidence before calling native close and, on Codex, archive. Doctor reports incomplete or unsupported cleanup without redispatching completed work. Resume reconciliation retries only supported incomplete cleanup and leaves the Supervisor task visible.

## Project Scope Compatibility

Use explicit project scope when repository-contained AgentFlow 0.2 behavior is required:

```bash
npx --yes agentflow@0.5.0 \
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
