import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { globalInstallationPaths } from "../src/global-paths.js";
import {
  globalHostWorkerProfileTarget,
  inspectHostWorkerProfile,
  mergeHostWorkerProfile,
  projectHostWorkerProfileTarget,
  renderHostWorkerProfile
} from "../src/host-worker-profile.js";
import type { HostClient } from "../src/host-config.js";

const hosts: HostClient[] = ["codex", "cursor", "vscode"];

describe("host Worker profiles", () => {
  it.each(hosts)("renders a bounded fresh-context %s profile without AgentFlow MCP", (host) => {
    const content = renderHostWorkerProfile(host);
    const inspection = inspectHostWorkerProfile(host, content);

    expect(inspection).toMatchObject({
      client: host,
      ok: true,
      profileName: "agentflow-worker",
      freshContextRequested: true,
      boundedToolsRequested: true,
      agentflowMcpDisabled: true,
      nestedWorkersDisabled: true,
      liveConformanceRequired: true
    });
    expect(content).not.toContain("mcp__agentflow__");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("uses an empty Codex MCP table instead of inheriting the Supervisor servers", () => {
    const parsed = parseToml(renderHostWorkerProfile("codex")) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      name: "agentflow-worker",
      sandbox_mode: "workspace-write",
      mcp_servers: {}
    });
  });

  it("uses explicit native tool allowlists for Cursor and VS Code", () => {
    const cursor = inspectHostWorkerProfile("cursor", renderHostWorkerProfile("cursor"));
    const vscode = inspectHostWorkerProfile("vscode", renderHostWorkerProfile("vscode"));

    expect(cursor.tools).toEqual(["Read", "Grep", "Glob", "LS", "Write", "StrReplace", "Shell"]);
    expect(vscode.tools).toEqual(["search", "edit", "runCommands", "runTests"]);
    expect(vscode.agents).toEqual([]);
  });

  it("resolves provider-native project and user profile locations", () => {
    const projectRoot = resolve("project");
    const paths = globalInstallationPaths({
      platform: "win32",
      home: "C:\\Users\\worker",
      appData: "C:\\Users\\worker\\AppData\\Roaming",
      codexHome: "C:\\CodexProfile"
    });

    expect(projectHostWorkerProfileTarget("codex", projectRoot))
      .toBe(join(projectRoot, ".codex", "agents", "agentflow-worker.toml"));
    expect(projectHostWorkerProfileTarget("cursor", projectRoot))
      .toBe(join(projectRoot, ".cursor", "agents", "agentflow-worker.md"));
    expect(projectHostWorkerProfileTarget("vscode", projectRoot))
      .toBe(join(projectRoot, ".github", "agents", "agentflow-worker.agent.md"));
    expect(globalHostWorkerProfileTarget("codex", paths)).toBe(paths.workerProfiles.codex);
    expect(globalHostWorkerProfileTarget("cursor", paths)).toBe(paths.workerProfiles.cursor);
    expect(globalHostWorkerProfileTarget("vscode", paths)).toBe(paths.workerProfiles.vscode);
  });

  it("updates only AgentFlow-owned profile files and rejects unrelated content", () => {
    const desired = renderHostWorkerProfile("cursor");

    expect(mergeHostWorkerProfile("cursor", "")).toBe(desired);
    expect(mergeHostWorkerProfile("cursor", desired)).toBe(desired);
    expect(() => mergeHostWorkerProfile(
      "cursor",
      "---\nname: team-worker\ndescription: Keep this profile\n---\nTeam owned.\n"
    )).toThrowError(expect.objectContaining({ code: "HOST_WORKER_PROFILE_CONFLICT" }));
  });

  it("does not treat a valid static file as live adapter conformance", () => {
    const inspection = inspectHostWorkerProfile("vscode", renderHostWorkerProfile("vscode"));

    expect(inspection.ok).toBe(true);
    expect(inspection.liveConformanceRequired).toBe(true);
    expect(inspection).not.toHaveProperty("conformance");
  });
});
