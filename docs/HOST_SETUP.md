# AgentFlow Host Setup

AgentFlow keeps the local control-plane MCP and Figma Remote MCP configured in the editor host, but invokes their tools only when the active Pipeline Stage declares them. A configured server is not proof that the current conversation is authenticated or can see its tools.

## Generate A Project Configuration

Build AgentFlow first so the generated stdio entry point exists:

```bash
npm run build
```

Preview a host-native configuration:

```bash
npm run cli -- configure --host codex
npm run cli -- configure --host cursor
npm run cli -- configure --host vscode
```

Use `--write` to create the project-scoped target. AgentFlow uses exclusive creation and never overwrites a different existing file. When a target already contains other settings, inspect it with `doctor` and merge the rendered `agentflow` and `figma` server entries with a structured TOML/JSON editor.

| Host | Project target | Figma transport |
|---|---|---|
| Codex | `.codex/config.toml` | Streamable HTTP in `mcp_servers` |
| Cursor | `.cursor/mcp.json` | URL-inferred HTTP in `mcpServers` |
| VS Code | `.vscode/mcp.json` | Explicit `type: http` in `servers` |

All three use `https://mcp.figma.com/mcp`. Generated files contain no Figma token, Authorization header, client secret, or OAuth credential.

## Authenticate Figma

OAuth remains a user and host action. AgentFlow does not click Allow Access, choose an account/team, bypass Workspace Trust, or write credentials.

### Codex

Codex App, CLI, and the Codex IDE extension on the same host share `config.toml`. The Figma plugin is the preferred interactive installation; AgentFlow also supports the manual project configuration it generates.

```bash
codex mcp login figma
codex mcp list
```

Do not set `required = true` for Figma. A temporary Figma outage must block only the design Stage, not every Codex session.

### Cursor

Cursor recommends `/add-plugin figma` when its bundled Skills and rules are desired. AgentFlow's bare MCP configuration is useful when external Skills are independently pinned in `skills-lock.json`.

```bash
agent mcp login figma
agent mcp list
agent mcp list-tools figma
```

### VS Code

Run `MCP: List Servers`, start `figma`, and complete Allow Access. User-level configuration belongs to the active VS Code Profile; AgentFlow only generates the project target and does not guess a global profile path.

## S04 Live Preflight

Immediately before dispatching the Figma Writer, the Supervisor inspects the current host registry, loads `figma-use`, and calls Figma `whoami`. Identity details are not persisted. The canonical S04 requirements are:

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

Run a local diagnostic with canonical observations from the host:

```bash
npm run cli -- doctor --host codex --stage S04 --live-probe \
  --capability host.worker.spawn host.worker.collect \
  figma.remote.connected figma.remote.authenticated \
  figma.tool.whoami figma.tool.create_new_file figma.tool.use_figma \
  figma.tool.get_metadata figma.tool.get_screenshot skill.figma-use
```

The Host Skill then sends the same observed capability IDs to `stage_preflight_report` with the current Run revision and a short TTL. Core computes missing capabilities; callers do not submit a trusted `passed` boolean.

## Block And Recovery

When a capability is missing:

1. Core records the failed preflight and sets the current Run and S04 to `blocked` while retaining `activeStageId: S04`.
2. Ready S04 Tasks become pending. Completed concept briefs and their Artifact hashes remain intact.
3. No Figma Writer, resource, operation, screenshot, `design-concepts` Artifact, or Gate approval is created.
4. The user completes configuration/OAuth or restarts the host.
5. The Supervisor performs a fresh live probe and reports it. A passing report reactivates S04 and readies eligible pending Tasks.
6. `task_claim`, `resource_acquire`, `resource_rekey`, `resource_operation_begin`, and `stage_complete` enforce the unexpired preflight again.

If connectivity becomes uncertain after a write has started, finish or reconcile the recorded operation before releasing its resource or dispatching a new Writer. Never infer external side effects from an error alone.

## Sources

- [Figma Remote MCP installation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Figma MCP tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Cursor MCP documentation](https://cursor.com/docs/mcp)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
