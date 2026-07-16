# AgentFlow Automatic Routing Contract

Apply the first matching row to the current user request. Override tokens are scoped to one request.

| Priority | Request signal | Decision | Required action |
| --- | --- | --- | --- |
| 1 | `agentflow:on` | Route | Inspect status, then resume or start AgentFlow. |
| 1 | `agentflow:off` | Bypass | Handle normally and do not mutate AgentFlow state. |
| 2 | Any requested project mutation | Route | Inspect status before edits, then use `agentflow-orchestrator`. |
| 3 | Pure question | Bypass | Answer without creating a Run. |
| 3 | Code explanation | Bypass | Explain without changing files. |
| 3 | Read-only inspection | Bypass | Inspect and report without changing files. |
| 3 | Status lookup | Bypass | Report status without starting or advancing a Run. |
| 3 | Simple non-mutating command | Bypass | Run the command without creating a Run. |

Project mutations include creating or modifying code, tests, documentation, configuration, migrations, designs, build outputs intended for the project, release state, or deployment state.

For a mixed request such as "inspect this failure and fix it", route before the inspection because the requested outcome includes a mutation. For a request such as "inspect this failure and tell me what is wrong", bypass because the requested outcome is read-only.

If both override tokens appear and the user's intent is not otherwise explicit, do not guess which override wins. Ask the user to provide one override token.

Routing is durable model instruction, not transport interception. Higher-priority host or user policy still applies. Once routed, AgentFlow Core and MCP enforce Worker, Artifact, Stage, and human Gate invariants.
