import { isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

export type HostClient = "codex" | "cursor" | "vscode";

export const FIGMA_REMOTE_MCP_URL = "https://mcp.figma.com/mcp";

export interface HostConfigurationSpec {
  client: HostClient;
  agentflowMcpEntryPoint: string;
  projectRoot: string;
  nodeCommand?: string;
}

export type HostConfigurationCheckId =
  | "configuration-format"
  | "server-table"
  | "agentflow-server"
  | "agentflow-command"
  | "agentflow-args"
  | "figma-server"
  | "figma-url"
  | "transport"
  | "figma-auth"
  | "codex-required";

export interface HostConfigurationCheck {
  id: HostConfigurationCheckId;
  ok: boolean;
  detail: string;
}

export interface HostConfigurationInspection {
  client: HostClient;
  ok: boolean;
  checks: HostConfigurationCheck[];
}

export interface HostConfigurationPlan {
  client: HostClient;
  targetPath: string;
  content: string;
  authentication: {
    type: "oauth";
    command?: string;
    instructions: string;
  };
}

type JsonRecord = Record<string, unknown>;

const SERVER_TABLES: Record<HostClient, string> = {
  codex: "mcp_servers",
  cursor: "mcpServers",
  vscode: "servers"
};

const SENSITIVE_FIGMA_KEYS = new Set([
  "authorization",
  "bearertokenenvvar",
  "clientsecret",
  "envhttpheaders",
  "headers",
  "httpheaders",
  "token",
  "accesstoken",
  "xfigmatoken"
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function validateSpec(spec: HostConfigurationSpec): void {
  if (!isAbsolute(spec.agentflowMcpEntryPoint)) {
    throw new TypeError("agentflowMcpEntryPoint must be an absolute path");
  }
  if (!isAbsolute(spec.projectRoot)) {
    throw new TypeError("projectRoot must be an absolute path");
  }
  if (spec.nodeCommand !== undefined && spec.nodeCommand.trim().length === 0) {
    throw new TypeError("nodeCommand must not be empty");
  }
}

function nodeCommand(spec: HostConfigurationSpec): string {
  return spec.nodeCommand ?? "node";
}

function agentflowArgs(spec: HostConfigurationSpec): string[] {
  return [spec.agentflowMcpEntryPoint, "--project-root", spec.projectRoot];
}

function renderJsonConfiguration(value: JsonRecord): string {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(rendered);
  return rendered;
}

function renderCodexConfiguration(spec: HostConfigurationSpec): string {
  const args = agentflowArgs(spec).map((value) => JSON.stringify(value)).join(", ");
  return [
    "[mcp_servers.agentflow]",
    `command = ${JSON.stringify(nodeCommand(spec))}`,
    `args = [${args}]`,
    "",
    "[mcp_servers.figma]",
    `url = ${JSON.stringify(FIGMA_REMOTE_MCP_URL)}`,
    ""
  ].join("\n");
}

/** Render a host-native MCP configuration without reading or writing the filesystem. */
export function renderHostConfiguration(spec: HostConfigurationSpec): string {
  validateSpec(spec);
  const agentflow = {
    command: nodeCommand(spec),
    args: agentflowArgs(spec)
  };

  switch (spec.client) {
    case "codex":
      return renderCodexConfiguration(spec);
    case "cursor":
      return renderJsonConfiguration({
        mcpServers: {
          agentflow,
          figma: { url: FIGMA_REMOTE_MCP_URL }
        }
      });
    case "vscode":
      return renderJsonConfiguration({
        inputs: [],
        servers: {
          agentflow: { type: "stdio", ...agentflow },
          figma: { type: "http", url: FIGMA_REMOTE_MCP_URL }
        }
      });
  }
}

export function hostConfigurationTarget(client: HostClient, projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  switch (client) {
    case "codex":
      return resolve(projectRoot, ".codex", "config.toml");
    case "cursor":
      return resolve(projectRoot, ".cursor", "mcp.json");
    case "vscode":
      return resolve(projectRoot, ".vscode", "mcp.json");
  }
}

export function planHostConfiguration(spec: HostConfigurationSpec): HostConfigurationPlan {
  const targetPath = hostConfigurationTarget(spec.client, spec.projectRoot);
  const authentication = (() => {
    switch (spec.client) {
      case "codex":
        return {
          type: "oauth" as const,
          command: "codex mcp login figma",
          instructions: "Restart the Codex host if needed, then authenticate Figma through the MCP server list or the CLI command."
        };
      case "cursor":
        return {
          type: "oauth" as const,
          command: "agent mcp login figma",
          instructions: "Restart Cursor if needed, then connect and authenticate Figma from MCP settings."
        };
      case "vscode":
        return {
          type: "oauth" as const,
          instructions: "Run MCP: List Servers, start Figma, and complete the Allow Access flow."
        };
    }
  })();
  return {
    client: spec.client,
    targetPath,
    content: renderHostConfiguration(spec),
    authentication
  };
}

function parseConfiguration(
  client: HostClient,
  configuration: unknown
): { value?: JsonRecord; error?: string } {
  if (typeof configuration === "string") {
    try {
      const parsed: unknown = client === "codex" ? parseToml(configuration) : JSON.parse(configuration);
      return isRecord(parsed)
        ? { value: parsed }
        : { error: "Configuration must contain an object" };
    } catch (error) {
      return {
        error: `Invalid ${client === "codex" ? "TOML" : "JSON"}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  return isRecord(configuration)
    ? { value: configuration }
    : { error: "Configuration must be an object" };
}

function findSensitiveFigmaKeys(value: unknown, prefix = "figma"): string[] {
  if (!isRecord(value)) return [];
  const matches: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SENSITIVE_FIGMA_KEYS.has(normalized)) matches.push(path);
    matches.push(...findSensitiveFigmaKeys(child, path));
  }
  return matches;
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function transportIsValid(client: HostClient, agentflow: JsonRecord | undefined, figma: JsonRecord | undefined): boolean {
  if (client === "codex") return true;
  if (client === "vscode") {
    return own(agentflow ?? {}, "type") === "stdio" && own(figma ?? {}, "type") === "http";
  }

  const agentflowType = own(agentflow ?? {}, "type");
  const figmaType = own(figma ?? {}, "type");
  return (agentflowType === undefined || agentflowType === "stdio")
    && (figmaType === undefined || figmaType === "http");
}

function addCheck(
  checks: HostConfigurationCheck[],
  id: HostConfigurationCheckId,
  ok: boolean,
  success: string,
  failure: string
): void {
  checks.push({ id, ok, detail: ok ? success : failure });
}

/**
 * Statically inspect an MCP configuration for the AgentFlow/Figma baseline.
 * Hosts accept rendered text or a caller-parsed object.
 */
export function inspectHostConfiguration(
  spec: HostConfigurationSpec,
  configuration: unknown
): HostConfigurationInspection {
  validateSpec(spec);
  const checks: HostConfigurationCheck[] = [];
  const parsed = parseConfiguration(spec.client, configuration);
  addCheck(
    checks,
    "configuration-format",
    parsed.value !== undefined,
    "Configuration is a parsed object",
    parsed.error ?? "Configuration could not be parsed"
  );
  if (!parsed.value) return { client: spec.client, ok: false, checks };

  const tableName = SERVER_TABLES[spec.client];
  const tableValue = own(parsed.value, tableName);
  const table = isRecord(tableValue) ? tableValue : undefined;
  addCheck(
    checks,
    "server-table",
    table !== undefined,
    `Found ${tableName}`,
    `Missing ${tableName} object`
  );

  const agentflowValue = table ? own(table, "agentflow") : undefined;
  const agentflow = isRecord(agentflowValue) ? agentflowValue : undefined;
  addCheck(
    checks,
    "agentflow-server",
    agentflow !== undefined,
    "Found agentflow server",
    "Missing agentflow server object"
  );
  addCheck(
    checks,
    "agentflow-command",
    own(agentflow ?? {}, "command") === nodeCommand(spec),
    `AgentFlow uses ${nodeCommand(spec)}`,
    `AgentFlow command must be ${nodeCommand(spec)}`
  );
  addCheck(
    checks,
    "agentflow-args",
    sameStringArray(own(agentflow ?? {}, "args"), agentflowArgs(spec)),
    "AgentFlow entry point and project root match",
    "AgentFlow args must contain the absolute entry point and project root"
  );

  const figmaValue = table ? own(table, "figma") : undefined;
  const figma = isRecord(figmaValue) ? figmaValue : undefined;
  addCheck(
    checks,
    "figma-server",
    figma !== undefined,
    "Found figma server",
    "Missing figma server object"
  );
  addCheck(
    checks,
    "figma-url",
    own(figma ?? {}, "url") === FIGMA_REMOTE_MCP_URL,
    `Figma uses ${FIGMA_REMOTE_MCP_URL}`,
    `Figma URL must be ${FIGMA_REMOTE_MCP_URL}`
  );
  addCheck(
    checks,
    "transport",
    transportIsValid(spec.client, agentflow, figma),
    "Server transports match the host schema",
    "Server transport does not match the host schema"
  );

  const sensitiveKeys = findSensitiveFigmaKeys(figma);
  addCheck(
    checks,
    "figma-auth",
    sensitiveKeys.length === 0,
    "Figma uses host-managed OAuth without token or header fields",
    `Remove Figma token/header fields: ${sensitiveKeys.join(", ")}`
  );

  if (spec.client === "codex") {
    const required = own(agentflow ?? {}, "required") === true || own(figma ?? {}, "required") === true;
    addCheck(
      checks,
      "codex-required",
      !required,
      "Codex servers are not globally required",
      "Do not set required = true; enforce Figma availability at the design-stage preflight"
    );
  }

  return {
    client: spec.client,
    ok: checks.every((check) => check.ok),
    checks
  };
}
