import { resolve } from "node:path";
import { AgentFlowError } from "@agentflow/core";
import { describe, expect, it } from "vitest";
import { mergeHostConfiguration } from "../src/host-config-merge.js";
import type { HostClient, HostConfigurationSpec } from "../src/host-config.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const projectRoot = resolve(repositoryRoot, "fixtures/example-project");

function spec(client: HostClient): HostConfigurationSpec {
  return {
    client,
    projectRoot,
    agentflowMcpEntryPoint: resolve(repositoryRoot, "bundle/agentflow-mcp.mjs")
  };
}

describe("host configuration merge", () => {
  it("preserves unrelated Cursor and VS Code settings", () => {
    const cursor = JSON.parse(mergeHostConfiguration(
      "cursor",
      JSON.stringify({ mcpServers: { other: { command: "other" } }, keep: true }),
      spec("cursor")
    )) as Record<string, unknown>;

    expect(cursor.keep).toBe(true);
    expect(cursor.mcpServers).toHaveProperty("other");
    expect(cursor.mcpServers).toHaveProperty("agentflow");
    expect(cursor.mcpServers).toHaveProperty("figma");
  });

  it("preserves unrelated Codex TOML and is idempotent", () => {
    const first = mergeHostConfiguration("codex", "model = \"gpt-test\"\n", spec("codex"));

    expect(first).toContain("model = \"gpt-test\"");
    expect(mergeHostConfiguration("codex", first, spec("codex"))).toBe(first);
  });

  it("rejects a conflicting managed server", () => {
    const existing = JSON.stringify({ mcpServers: { agentflow: { command: "wrong" } } });

    expect(() => mergeHostConfiguration("cursor", existing, spec("cursor")))
      .toThrowError(expect.objectContaining<Partial<AgentFlowError>>({
        code: "HOST_CONFIG_CONFLICT"
      }));
  });
});
