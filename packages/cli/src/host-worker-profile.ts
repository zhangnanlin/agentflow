import { isAbsolute, resolve } from "node:path";
import { AgentFlowError } from "@agentflow/core";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { GlobalInstallationPaths } from "./global-paths.js";
import type { HostClient } from "./host-config.js";

const PROFILE_NAME = "agentflow-worker";
const CODEX_MARKER = "# agentflow:worker-profile:v1";
const MARKDOWN_MARKER = "<!-- agentflow:worker-profile:v1 -->";
const CURSOR_TOOLS = ["Read", "Grep", "Glob", "LS", "Write", "StrReplace", "Shell"];
const VSCODE_TOOLS = ["search", "edit", "runCommands", "runTests"];

const workerInstructions = [
  "Start in a fresh native subagent context with no inherited Supervisor conversation turns.",
  "Use only the bounded Task envelope, referenced repository files, and verification commands.",
  "Do not start or call AgentFlow MCP; the Supervisor owns every control-plane mutation.",
  "Do not spawn nested agents or import chat transcripts, unrelated Run state, or hidden history.",
  "Persist the requested repository changes and return a compact result before native cleanup."
].join("\n");

export interface HostWorkerProfileInspection {
  client: HostClient;
  ok: boolean;
  profileName?: string;
  freshContextRequested: boolean;
  boundedToolsRequested: boolean;
  agentflowMcpDisabled: boolean;
  nestedWorkersDisabled: boolean;
  liveConformanceRequired: true;
  tools: string[];
  agents?: string[];
  issues: string[];
}

function renderCodexProfile(): string {
  return [
    CODEX_MARKER,
    `name = ${JSON.stringify(PROFILE_NAME)}`,
    `description = ${JSON.stringify("Fresh, bounded implementation Worker controlled by an AgentFlow Supervisor.")}`,
    "developer_instructions = \"\"\"",
    workerInstructions,
    "\"\"\"",
    "sandbox_mode = \"workspace-write\"",
    "approval_policy = \"on-request\"",
    "",
    "# An empty table prevents inheritance of the Supervisor's MCP servers.",
    "[mcp_servers]",
    ""
  ].join("\n");
}

function renderCursorProfile(): string {
  return [
    "---",
    `name: ${PROFILE_NAME}`,
    "description: Fresh, bounded implementation Worker controlled by an AgentFlow Supervisor.",
    "tools:",
    ...CURSOR_TOOLS.map((tool) => `  - ${tool}`),
    "---",
    MARKDOWN_MARKER,
    workerInstructions,
    ""
  ].join("\n");
}

function renderVsCodeProfile(): string {
  return [
    "---",
    `name: ${PROFILE_NAME}`,
    "description: Fresh, bounded implementation Worker controlled by an AgentFlow Supervisor.",
    "tools:",
    ...VSCODE_TOOLS.map((tool) => `  - ${tool}`),
    "agents: []",
    "user-invocable: false",
    "disable-model-invocation: false",
    "target: vscode",
    "---",
    MARKDOWN_MARKER,
    workerInstructions,
    ""
  ].join("\n");
}

/** Render one provider-native Worker profile without any Supervisor MCP tools. */
export function renderHostWorkerProfile(client: HostClient): string {
  switch (client) {
    case "codex": return renderCodexProfile();
    case "cursor": return renderCursorProfile();
    case "vscode": return renderVsCodeProfile();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

function markdownFrontmatter(content: string): Record<string, unknown> | undefined {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  const body = match?.[1];
  if (body === undefined) return undefined;
  try {
    return record(parseYaml(body));
  } catch {
    return undefined;
  }
}

function hasWorkerInstructions(content: string): {
  fresh: boolean;
  noMcp: boolean;
  noNested: boolean;
} {
  return {
    fresh: content.includes("fresh native subagent context")
      && content.includes("no inherited Supervisor conversation turns"),
    noMcp: content.includes("Do not start or call AgentFlow MCP"),
    noNested: content.includes("Do not spawn nested agents")
  };
}

/** Validate static profile intent. Live adapter conformance remains a separate check. */
export function inspectHostWorkerProfile(
  client: HostClient,
  content: string
): HostWorkerProfileInspection {
  const instructionChecks = hasWorkerInstructions(content);
  let profileName: string | undefined;
  let tools: string[] = [];
  let agents: string[] | undefined;
  let boundedToolsRequested = false;
  let agentflowMcpDisabled = false;
  const issues: string[] = [];

  if (client === "codex") {
    try {
      const parsed = record(parseToml(content));
      profileName = typeof parsed?.name === "string" ? parsed.name : undefined;
      const mcpServers = record(parsed?.mcp_servers);
      agentflowMcpDisabled = mcpServers !== undefined && Object.keys(mcpServers).length === 0;
      boundedToolsRequested = parsed?.sandbox_mode === "workspace-write"
        && parsed?.approval_policy === "on-request"
        && instructionChecks.fresh;
    } catch {
      issues.push("profile-format");
    }
  } else {
    const frontmatter = markdownFrontmatter(content);
    if (!frontmatter) {
      issues.push("profile-format");
    } else {
      profileName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
      tools = stringArray(frontmatter.tools);
      boundedToolsRequested = tools.length > 0
        && tools.length <= 16
        && tools.every((tool) => tool !== "*" && !tool.includes("/*"));
      agentflowMcpDisabled = boundedToolsRequested
        && tools.every((tool) => !/agentflow|mcp/i.test(tool))
        && instructionChecks.noMcp;
      if (client === "vscode") {
        agents = stringArray(frontmatter.agents);
        if (!Array.isArray(frontmatter.agents)) issues.push("nested-agent-policy");
      }
    }
  }

  const nestedWorkersDisabled = client === "vscode"
    ? agents?.length === 0 && instructionChecks.noNested
    : !tools.some((tool) => /^(?:task|agent)$/i.test(tool)) && instructionChecks.noNested;
  if (profileName !== PROFILE_NAME) issues.push("profile-name");
  if (!instructionChecks.fresh) issues.push("fresh-context");
  if (!boundedToolsRequested) issues.push("bounded-tools");
  if (!agentflowMcpDisabled) issues.push("agentflow-mcp");
  if (!nestedWorkersDisabled) issues.push("nested-agents");

  return {
    client,
    ok: issues.length === 0,
    ...(profileName === undefined ? {} : { profileName }),
    freshContextRequested: instructionChecks.fresh,
    boundedToolsRequested,
    agentflowMcpDisabled,
    nestedWorkersDisabled,
    liveConformanceRequired: true,
    tools,
    ...(agents === undefined ? {} : { agents }),
    issues: [...new Set(issues)].sort()
  };
}

function managedMarker(client: HostClient): string {
  return client === "codex" ? CODEX_MARKER : MARKDOWN_MARKER;
}

/** Replace only an AgentFlow-owned profile; never overwrite an unrelated same-name file. */
export function mergeHostWorkerProfile(client: HostClient, existing: string): string {
  const desired = renderHostWorkerProfile(client);
  if (existing.trim().length === 0 || existing === desired) return desired;
  if (!existing.includes(managedMarker(client))) {
    throw new AgentFlowError(
      `A non-AgentFlow Worker profile already occupies the ${PROFILE_NAME} path`,
      "HOST_WORKER_PROFILE_CONFLICT",
      { client }
    );
  }
  const inspection = inspectHostWorkerProfile(client, existing);
  if (!inspection.ok) {
    throw new AgentFlowError(
      `The managed ${client} Worker profile is malformed`,
      "HOST_WORKER_PROFILE_INVALID",
      { client, issues: inspection.issues }
    );
  }
  return desired;
}

export function projectHostWorkerProfileTarget(
  client: HostClient,
  projectRoot: string
): string {
  if (!isAbsolute(projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  switch (client) {
    case "codex": return resolve(projectRoot, ".codex", "agents", `${PROFILE_NAME}.toml`);
    case "cursor": return resolve(projectRoot, ".cursor", "agents", `${PROFILE_NAME}.md`);
    case "vscode": return resolve(projectRoot, ".github", "agents", `${PROFILE_NAME}.agent.md`);
  }
}

export function globalHostWorkerProfileTarget(
  client: HostClient,
  paths: GlobalInstallationPaths
): string {
  return paths.workerProfiles[client];
}
