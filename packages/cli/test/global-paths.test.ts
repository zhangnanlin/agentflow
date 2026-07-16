import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  globalInstallationPaths,
  type GlobalPathEnvironment,
  type GlobalPathOverrides
} from "../src/global-paths.js";

const invalidCases: Array<[GlobalPathEnvironment, GlobalPathOverrides | undefined]> = [
  [{ platform: "linux", home: "" }, undefined],
  [{ platform: "linux", home: "relative-home" }, undefined],
  [{ platform: "win32", home: "C:\\Users\\agentflow" }, undefined],
  [{ platform: "linux", home: "/home/agentflow", agentflowHome: "relative" }, undefined],
  [{ platform: "linux", home: "/home/agentflow", codexHome: "" }, undefined],
  [{ platform: "linux", home: "/home/agentflow" }, { vscodeConfig: "relative/mcp.json" }],
  [{ platform: "linux", home: "/home/agentflow" }, { vscodeConfig: "" }]
];

describe("globalInstallationPaths", () => {
  it("resolves Windows user runtime, Skills, and host configuration", () => {
    const home = "C:\\Users\\agentflow";
    const appData = "C:\\Users\\agentflow\\AppData\\Roaming";

    expect(globalInstallationPaths({ platform: "win32", home, appData })).toMatchObject({
      home,
      runtimeRoot: win32.join(home, ".agentflow"),
      runtimeCli: win32.join(home, ".agentflow", "bin", "agentflow-cli.mjs"),
      runtimeMcp: win32.join(home, ".agentflow", "bin", "agentflow-mcp.mjs"),
      installManifest: win32.join(home, ".agentflow", "install.json"),
      skillsLock: win32.join(home, ".agentflow", "skills-lock.json"),
      skillsRoot: win32.join(home, ".agents", "skills"),
      codexConfig: win32.join(home, ".codex", "config.toml"),
      cursorConfig: win32.join(home, ".cursor", "mcp.json"),
      vscodeConfig: win32.join(appData, "Code", "User", "mcp.json")
    });
  });

  it("resolves macOS and Linux/XDG host paths", () => {
    const macHome = "/Users/agentflow";
    expect(globalInstallationPaths({ platform: "darwin", home: macHome })).toMatchObject({
      runtimeRoot: posix.join(macHome, ".agentflow"),
      vscodeConfig: posix.join(macHome, "Library", "Application Support", "Code", "User", "mcp.json")
    });

    const linuxHome = "/home/agentflow";
    expect(globalInstallationPaths({
      platform: "linux",
      home: linuxHome,
      xdgConfigHome: "/xdg/config"
    })).toMatchObject({
      cursorConfig: posix.join(linuxHome, ".cursor", "mcp.json"),
      vscodeConfig: "/xdg/config/Code/User/mcp.json"
    });
    expect(globalInstallationPaths({ platform: "linux", home: linuxHome }).vscodeConfig)
      .toBe(posix.join(linuxHome, ".config", "Code", "User", "mcp.json"));
  });

  it("honors AgentFlow, Codex, and VS Code absolute overrides", () => {
    const paths = globalInstallationPaths({
      platform: "linux",
      home: "/home/agentflow",
      agentflowHome: "/srv/agentflow",
      codexHome: "/srv/codex"
    }, {
      vscodeConfig: "/srv/vscode/mcp.json"
    });

    expect(paths.runtimeRoot).toBe("/srv/agentflow");
    expect(paths.codexConfig).toBe("/srv/codex/config.toml");
    expect(paths.vscodeConfig).toBe("/srv/vscode/mcp.json");
    expect(paths.skillsRoot).toBe("/home/agentflow/.agents/skills");
  });

  it.each(invalidCases)("rejects missing, empty, or relative roots: %j", (environment, overrides) => {
    expect(() => globalInstallationPaths(environment, overrides)).toThrowError(
      expect.objectContaining({ code: "GLOBAL_PATH_INVALID" })
    );
  });
});
