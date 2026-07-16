import { isDeepStrictEqual } from "node:util";
import { AgentFlowError } from "@agentflow/core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { mergeManagedBlock } from "./managed-content.js";
import {
  hostServerTable,
  renderHostConfiguration,
  type HostClient,
  type HostConfigurationSpec
} from "./host-config.js";

type JsonRecord = Record<string, unknown>;

const tomlMarkers = {
  start: "# agentflow:mcp:start",
  end: "# agentflow:mcp:end"
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(
  client: HostClient,
  content: string,
  desired = false
): JsonRecord {
  try {
    const parsed: unknown = content.trim().length === 0
      ? {}
      : client === "codex"
        ? parseToml(content)
        : JSON.parse(content);
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    throw new AgentFlowError(
      `Invalid ${client === "codex" ? "TOML" : "JSON"} host configuration`,
      desired ? "HOST_CONFIG_RENDER_INVALID" : "HOST_CONFIG_INVALID",
      { client, cause: error instanceof Error ? error.message : String(error) }
    );
  }

  throw new AgentFlowError(
    "Host configuration must contain an object",
    desired ? "HOST_CONFIG_RENDER_INVALID" : "HOST_CONFIG_INVALID",
    { client }
  );
}

function serverTable(
  root: JsonRecord,
  tableName: string,
  client: HostClient,
  desired = false
): JsonRecord {
  const value = root[tableName];
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  throw new AgentFlowError(
    `Host server table ${tableName} must contain an object`,
    desired ? "HOST_CONFIG_RENDER_INVALID" : "HOST_CONFIG_INVALID",
    { client, tableName }
  );
}

function mergeServers(
  client: HostClient,
  existing: JsonRecord,
  desired: JsonRecord
): { merged: JsonRecord; missing: JsonRecord } {
  const merged = { ...existing };
  const missing: JsonRecord = {};

  for (const [name, value] of Object.entries(desired)) {
    if (!Object.prototype.hasOwnProperty.call(existing, name)) {
      merged[name] = value;
      missing[name] = value;
      continue;
    }
    if (!isDeepStrictEqual(existing[name], value)) {
      throw new AgentFlowError(
        `Host configuration already defines a conflicting ${name} server`,
        "HOST_CONFIG_CONFLICT",
        { client, server: name }
      );
    }
  }

  return { merged, missing };
}

function renderJsonMerge(
  client: Exclude<HostClient, "codex">,
  existingText: string,
  desiredText: string
): string {
  const tableName = hostServerTable(client);
  const existing = parseObject(client, existingText);
  const desired = parseObject(client, desiredText, true);
  const existingServers = serverTable(existing, tableName, client);
  const desiredServers = serverTable(desired, tableName, client, true);
  const { merged } = mergeServers(client, existingServers, desiredServers);
  const value = {
    ...desired,
    ...existing,
    [tableName]: merged
  };
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  parseObject(client, rendered);
  return rendered;
}

function managedTomlBody(existing: string): string | undefined {
  const starts = existing.split(tomlMarkers.start).length - 1;
  const ends = existing.split(tomlMarkers.end).length - 1;
  const start = existing.indexOf(tomlMarkers.start);
  const end = existing.indexOf(tomlMarkers.end);
  if (starts === 0 && ends === 0) return undefined;
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new AgentFlowError(
      "Managed AgentFlow block is malformed",
      "MANAGED_BLOCK_INVALID"
    );
  }
  return existing.slice(start + tomlMarkers.start.length, end).trim();
}

function renderCodexMerge(existingText: string, desiredText: string): string {
  const client = "codex" as const;
  const tableName = hostServerTable(client);
  const existing = parseObject(client, existingText);
  const desired = parseObject(client, desiredText, true);
  const existingServers = serverTable(existing, tableName, client);
  const desiredServers = serverTable(desired, tableName, client, true);
  const { missing } = mergeServers(client, existingServers, desiredServers);
  const currentBody = managedTomlBody(existingText);

  if (Object.keys(missing).length === 0) {
    return existingText;
  }

  const addedBody = stringifyToml({ [tableName]: missing }).trim();
  const body = [currentBody, addedBody].filter((value) => value && value.length > 0).join("\n\n");
  const rendered = mergeManagedBlock(existingText, body, tomlMarkers);
  parseObject(client, rendered);
  return rendered;
}

/** Merge AgentFlow-owned MCP servers without replacing unrelated host settings. */
export function mergeHostConfiguration(
  client: HostClient,
  existing: string,
  spec: HostConfigurationSpec
): string {
  if (spec.client !== client) {
    throw new TypeError(`Host client mismatch: expected ${client}, received ${spec.client}`);
  }

  const desired = renderHostConfiguration(spec);
  return client === "codex"
    ? renderCodexMerge(existing, desired)
    : renderJsonMerge(client, existing, desired);
}
