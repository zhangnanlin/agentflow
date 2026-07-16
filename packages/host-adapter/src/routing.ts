export const AGENTFLOW_ROUTER_BODY = `## AgentFlow automatic routing
- For every project-changing request, load agentflow-auto-router before editing.
- Call run_start_or_resume with the original requirement before other state mutations.
- Resume an unfinished Run and never duplicate it.
- Preserve every human Gate and never infer approval.
- Pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands bypass AgentFlow.
- agentflow:on forces routing for one request; agentflow:off bypasses it for one request.
- When the client exposes multiple workspace roots, pass the intended absolute projectRoot and never guess.
- Execute staged work through agentflow-orchestrator and bounded Workers; validate and register every Artifact.`;

export const AGENTFLOW_MCP_INSTRUCTIONS = `${AGENTFLOW_ROUTER_BODY}
Treat configured tools and static host files as insufficient evidence of live authentication or capability.`;
