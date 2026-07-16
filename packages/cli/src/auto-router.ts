import { mergeManagedBlock } from "./managed-content.js";

export const AGENTFLOW_ROUTER_BODY = `## AgentFlow automatic routing
- For every project-changing request, load agentflow-auto-router before editing.
- Pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands bypass AgentFlow.
- agentflow:on forces routing for one request; agentflow:off bypasses it for one request.
- Inspect .agentflow/current-run.json or AgentFlow status_get first. Resume an unfinished Run and never duplicate it.
- If no unfinished Run exists, preserve the user's original requirement and start the correct new/existing and UI/non-UI Run.
- Execute staged work through agentflow-orchestrator and its Workers. Preserve every human Gate and never infer approval.`;

const markdownMarkers = {
  start: "<!-- agentflow:auto-router:start -->",
  end: "<!-- agentflow:auto-router:end -->"
};

export function renderAgentsInstruction(existing = ""): string {
  return mergeManagedBlock(existing, AGENTFLOW_ROUTER_BODY, markdownMarkers);
}

export function renderVsCodeInstruction(existing = ""): string {
  return mergeManagedBlock(existing, AGENTFLOW_ROUTER_BODY, markdownMarkers);
}

export function renderCursorRule(): string {
  return `---\ndescription: Route project changes through AgentFlow\nglobs:\nalwaysApply: true\n---\n\n${AGENTFLOW_ROUTER_BODY}\n`;
}
