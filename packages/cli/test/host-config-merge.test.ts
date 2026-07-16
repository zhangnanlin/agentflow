import { resolve } from "node:path";
import { AgentFlowError } from "@agentflow/core";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { mergeHostConfiguration } from "../src/host-config-merge.js";
import {
  renderHostConfiguration,
  type HostClient,
  type HostConfigurationSpec
} from "../src/host-config.js";

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

    const vscode = JSON.parse(mergeHostConfiguration(
      "vscode",
      JSON.stringify({
        inputs: [{ type: "promptString", id: "existing" }],
        servers: { other: { type: "stdio", command: "other" } },
        keep: true
      }),
      spec("vscode")
    )) as Record<string, unknown>;
    expect(vscode.keep).toBe(true);
    expect(vscode.inputs).toEqual([{ type: "promptString", id: "existing" }]);
    expect(vscode.servers).toHaveProperty("other");
    expect(vscode.servers).toHaveProperty("agentflow");
    expect(vscode.servers).toHaveProperty("figma");
  });

  it("accepts a UTF-8 BOM in an existing JSON host configuration", () => {
    const merged = JSON.parse(mergeHostConfiguration(
      "cursor",
      `\uFEFF${JSON.stringify({ keep: true })}`,
      spec("cursor")
    )) as Record<string, unknown>;

    expect(merged.keep).toBe(true);
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

  it("rejects duplicated Codex managed markers even when server values match", () => {
    const codexSpec = spec("codex");
    const existing = [
      renderHostConfiguration(codexSpec),
      "# agentflow:mcp:start",
      "# agentflow:mcp:end",
      "# agentflow:mcp:start",
      "# agentflow:mcp:end",
      ""
    ].join("\n");

    expect(() => mergeHostConfiguration("codex", existing, codexSpec))
      .toThrowError(expect.objectContaining({ code: "MANAGED_BLOCK_INVALID" }));
  });

  it("updates AgentFlow-owned Codex servers while preserving unmanaged TOML", () => {
    const firstSpec = spec("codex");
    const first = mergeHostConfiguration(
      "codex",
      "model = \"gpt-test\"\n",
      firstSpec
    );
    const movedSpec: HostConfigurationSpec = {
      ...firstSpec,
      projectRoot: resolve(projectRoot, "moved"),
      agentflowMcpEntryPoint: resolve(repositoryRoot, "moved/agentflow-mcp.mjs")
    };

    const moved = mergeHostConfiguration("codex", first, movedSpec);
    const parsed = parseToml(moved) as {
      model: string;
      mcp_servers: { agentflow: { args: string[] } };
    };

    expect(parsed.model).toBe("gpt-test");
    expect(parsed.mcp_servers.agentflow.args).toEqual([
      movedSpec.agentflowMcpEntryPoint,
      "--project-root",
      movedSpec.projectRoot
    ]);
  });
});
