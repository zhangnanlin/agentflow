import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIGMA_REMOTE_MCP_URL,
  hostConfigurationTarget,
  inspectHostConfiguration,
  planHostConfiguration,
  renderHostConfiguration,
  type HostClient,
  type HostConfigurationSpec
} from "../src/host-config.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const agentflowMcpEntryPoint = resolve(repositoryRoot, "packages/mcp-server/dist/index.js");
const projectRoot = resolve(repositoryRoot, "fixtures/example-project");

function spec(client: HostClient): HostConfigurationSpec {
  return { client, agentflowMcpEntryPoint, projectRoot };
}

function check(inspection: ReturnType<typeof inspectHostConfiguration>, id: string) {
  return inspection.checks.find((candidate) => candidate.id === id);
}

describe("host MCP configuration", () => {
  it("renders the Codex mcp_servers TOML fragment without global requirements or auth fields", () => {
    const rendered = renderHostConfiguration(spec("codex"));

    expect(rendered).toBe([
      "[mcp_servers.agentflow]",
      'command = "node"',
      `args = [${JSON.stringify(agentflowMcpEntryPoint)}, "--project-root", ${JSON.stringify(projectRoot)}]`,
      "",
      "[mcp_servers.figma]",
      `url = ${JSON.stringify(FIGMA_REMOTE_MCP_URL)}`,
      ""
    ].join("\n"));
    expect(rendered).not.toMatch(/required\s*=\s*true/i);
    expect(rendered).not.toMatch(/token|headers|authorization/i);
  });

  it("renders Cursor mcpServers JSON using URL-inferred remote transport", () => {
    const rendered = renderHostConfiguration(spec("cursor"));

    expect(JSON.parse(rendered)).toEqual({
      mcpServers: {
        agentflow: {
          command: "node",
          args: [agentflowMcpEntryPoint, "--project-root", projectRoot]
        },
        figma: { url: FIGMA_REMOTE_MCP_URL }
      }
    });
    expect(rendered).not.toMatch(/"headers"|"token"|"authorization"/i);
  });

  it("renders VS Code servers JSON with explicit stdio and HTTP transports", () => {
    const rendered = renderHostConfiguration(spec("vscode"));

    expect(JSON.parse(rendered)).toEqual({
      inputs: [],
      servers: {
        agentflow: {
          type: "stdio",
          command: "node",
          args: [agentflowMcpEntryPoint, "--project-root", projectRoot]
        },
        figma: { type: "http", url: FIGMA_REMOTE_MCP_URL }
      }
    });
    expect(rendered).not.toMatch(/"headers"|"token"|"authorization"/i);
  });

  it("accepts each rendered host configuration", () => {
    for (const client of ["codex", "cursor", "vscode"] as const) {
      const inspection = inspectHostConfiguration(spec(client), renderHostConfiguration(spec(client)));
      expect(inspection.ok, inspection.checks.map((item) => item.detail).join("\n")).toBe(true);
    }

    const codexInspection = inspectHostConfiguration(spec("codex"), {
      mcp_servers: {
        agentflow: {
          command: "node",
          args: [agentflowMcpEntryPoint, "--project-root", projectRoot]
        },
        figma: { url: FIGMA_REMOTE_MCP_URL }
      }
    });
    expect(codexInspection.ok).toBe(true);
    expect(check(codexInspection, "codex-required")).toMatchObject({ ok: true });
  });

  it("returns a static failure instead of throwing for invalid JSON", () => {
    const inspection = inspectHostConfiguration(spec("cursor"), "{not-json");

    expect(inspection.ok).toBe(false);
    expect(inspection.checks).toHaveLength(1);
    expect(check(inspection, "configuration-format")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Invalid JSON")
    });
  });

  it("detects a wrong Figma URL and token or header configuration", () => {
    const inspection = inspectHostConfiguration(spec("vscode"), {
      inputs: [],
      servers: {
        agentflow: {
          type: "stdio",
          command: "node",
          args: [agentflowMcpEntryPoint, "--project-root", projectRoot]
        },
        figma: {
          type: "http",
          url: "https://example.invalid/mcp",
          headers: { Authorization: "Bearer secret" }
        }
      }
    });

    expect(inspection.ok).toBe(false);
    expect(check(inspection, "figma-url")).toMatchObject({ ok: false });
    expect(check(inspection, "figma-auth")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("figma.headers.Authorization")
    });
  });

  it("flags required Codex servers while permitting host-managed OAuth", () => {
    const inspection = inspectHostConfiguration(spec("codex"), {
      mcp_servers: {
        agentflow: {
          command: "node",
          args: [agentflowMcpEntryPoint, "--project-root", projectRoot]
        },
        figma: {
          url: FIGMA_REMOTE_MCP_URL,
          auth: "oauth",
          required: true
        }
      }
    });

    expect(inspection.ok).toBe(false);
    expect(check(inspection, "figma-auth")).toMatchObject({ ok: true });
    expect(check(inspection, "codex-required")).toMatchObject({ ok: false });
  });

  it("requires absolute paths and a non-empty node command", () => {
    expect(() => renderHostConfiguration({
      client: "cursor",
      agentflowMcpEntryPoint: "packages/mcp-server/dist/index.js",
      projectRoot
    })).toThrow("agentflowMcpEntryPoint must be an absolute path");

    expect(() => renderHostConfiguration({
      ...spec("vscode"),
      nodeCommand: " "
    })).toThrow("nodeCommand must not be empty");
  });

  it("plans only project-scoped targets and host-owned OAuth", () => {
    expect(hostConfigurationTarget("codex", projectRoot)).toBe(resolve(projectRoot, ".codex/config.toml"));
    expect(hostConfigurationTarget("cursor", projectRoot)).toBe(resolve(projectRoot, ".cursor/mcp.json"));
    expect(hostConfigurationTarget("vscode", projectRoot)).toBe(resolve(projectRoot, ".vscode/mcp.json"));

    const codex = planHostConfiguration(spec("codex"));
    expect(codex).toMatchObject({
      client: "codex",
      authentication: { type: "oauth", command: "codex mcp login figma" }
    });
    expect(codex.content).not.toMatch(/token|authorization|required\s*=\s*true/i);
  });
});
