# AgentFlow Host Setup

AgentFlow configures a local AgentFlow MCP server and Figma Remote MCP for the selected editor, but invokes tools only when the active Pipeline Stage requires them. Static configuration is never accepted as proof that a conversation is authenticated.

## One-Command Setup

Run from the target project root:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex
```

| Host | Setup value | MCP target | Persistent instruction |
| --- | --- | --- | --- |
| Codex | `codex` | `.codex/config.toml` | managed block in `AGENTS.md` |
| Cursor | `cursor` | `.cursor/mcp.json` | `.cursor/rules/agentflow.mdc` |
| VS Code | `vscode` | `.vscode/mcp.json` | managed block in `.github/copilot-instructions.md` |

Use `--host all` to install all three. The generated MCP files contain the current project's absolute path and are ignored by Git.

The installer copies standalone binaries to:

```text
.agentflow/runtime/bin/agentflow-cli.mjs
.agentflow/runtime/bin/agentflow-mcp.mjs
```

Host configuration always invokes the durable project copy of `agentflow-mcp.mjs`. It does not point back to the AgentFlow source repository or require unpublished workspace packages.

## Safe Merge Rules

Setup parses Cursor and VS Code JSON structurally, preserves unrelated top-level keys and servers, and adds only missing `agentflow` and `figma` entries. Codex TOML is parsed before AgentFlow-owned server tables are added inside managed markers.

Setup stops before mutation when:

- An existing `agentflow` or `figma` server has different values.
- A same-name Skill contains different files.
- A managed marker is missing, duplicated, or reversed.
- A source or destination traverses a symbolic link or escapes its allowed root.
- Distribution assets or the pinned Superpowers commit cannot be verified.

There is no delete-and-regenerate requirement. Repair only the reported conflict and rerun the same command. Every target is read and validated before writes begin; changed files use same-directory atomic rename, and a failure rolls this invocation back in reverse order.

## Host Authentication

OAuth remains a user and host action. AgentFlow does not click Allow Access, select an account/team, bypass Workspace Trust, restart an editor, or persist credentials.

### Codex

Restart Codex if the project MCP list does not refresh, then authenticate:

```bash
codex mcp login figma
codex mcp list
```

Do not set `required = true` for Figma. A Figma outage must block the design Stage, not every Codex session.

### Cursor

Restart Cursor, open MCP settings, and connect the generated `figma` server. Depending on the installed Cursor CLI, these diagnostics may also be available:

```bash
agent mcp login figma
agent mcp list
agent mcp list-tools figma
```

### VS Code

Restart VS Code if necessary, run `MCP: List Servers`, start `figma`, and complete Allow Access. AgentFlow writes only project configuration and does not guess a user Profile path.

## Static Doctor

Use the durable CLI installed in the project:

```bash
node .agentflow/runtime/bin/agentflow-cli.mjs doctor --host codex
node .agentflow/runtime/bin/agentflow-cli.mjs doctor --host cursor
node .agentflow/runtime/bin/agentflow-cli.mjs doctor --host vscode
```

Doctor verifies:

- Node.js 20 or newer
- Git is available on `PATH`
- `.agentflow` config and Pipeline
- Durable MCP runtime
- `agentflow-auto-router/SKILL.md`
- Shared `AGENTS.md` routing block
- Selected host's native instruction surface
- MCP transport, command, arguments, and Figma URL
- Absence of token/header fields
- Pinned Figma Skill metadata

When these checks pass, `status: warn` is expected until restart/OAuth is confirmed in the host. `ok: true` means the static project setup is usable; it does not mean Figma has been probed live.

## S04 Live Preflight

Immediately before a Figma Writer is dispatched, the Supervisor inspects the current host tool and Skill registry, loads `figma-use`, calls Figma `whoami`, and reports canonical capability IDs to `stage_preflight_report`.

The default S04 contract requires:

```text
host.worker.spawn
host.worker.collect
figma.remote.connected
figma.remote.authenticated
figma.tool.whoami
figma.tool.create_new_file
figma.tool.use_figma
figma.tool.get_metadata
figma.tool.get_screenshot
skill.figma-use
```

A local diagnostic can consume observations collected from the live host:

```bash
node .agentflow/runtime/bin/agentflow-cli.mjs doctor \
  --host codex --stage S04 --live-probe \
  --capability host.worker.spawn host.worker.collect \
  figma.remote.connected figma.remote.authenticated \
  figma.tool.whoami figma.tool.create_new_file figma.tool.use_figma \
  figma.tool.get_metadata figma.tool.get_screenshot skill.figma-use
```

If a capability is missing, Core retains completed briefs and Artifact hashes, blocks S04, creates no Figma Writer or design Artifact, and resumes the same Stage after a fresh passing probe.

## Automatic Router Diagnostics

If a project-changing request does not enter AgentFlow:

1. Run doctor for the current host.
2. Confirm the native instruction file is visible to the editor.
3. Restart the editor after setup or instruction changes.
4. Confirm `.agentflow/current-run.json` points to the expected unfinished Run.
5. Use `agentflow:on` on one request to test forced routing.

If a read-only request unexpectedly routes, confirm it does not request a later edit and use `agentflow:off` for one request. Override tokens never persist.

## Recovery And Rollback

Setup is idempotent, so retrying the same pinned command is the normal recovery path. It preserves existing Run data under `.agentflow/runs/`.

For a manual uninstall or release rollback:

1. Remove only the `agentflow:auto-router` managed block from `AGENTS.md` and `.github/copilot-instructions.md`.
2. Remove `.cursor/rules/agentflow.mdc` if Cursor was configured.
3. Structurally remove only the `agentflow` and `figma` MCP entries; preserve every unrelated host setting.
4. Remove `.agentflow/runtime/` and AgentFlow-owned Skills only when no active Run or other project instruction depends on them.
5. Restore committed portable instruction files with the project's normal Git workflow.

Never delete `.agentflow/runs/` as part of an installer rollback unless the user explicitly intends to destroy Run history.

## Sources

- [Figma Remote MCP installation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Figma MCP tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Cursor MCP documentation](https://cursor.com/docs/mcp)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
