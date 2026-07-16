import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DistributionAssets } from "../src/distribution.js";
import { normalizeHostCapabilities, runDoctor } from "../src/doctor.js";
import { projectPaths } from "../src/runtime.js";
import { executeSetup } from "../src/setup.js";

const temporaryDirectories: string[] = [];

async function setupAssets(root: string): Promise<DistributionAssets> {
  const distribution = join(root, "distribution");
  const skillsDirectory = join(distribution, ".agents", "skills");
  const routerDirectory = join(skillsDirectory, "agentflow-auto-router");
  const bundleDirectory = join(distribution, "bundle");
  await Promise.all([
    mkdir(routerDirectory, { recursive: true }),
    mkdir(bundleDirectory, { recursive: true })
  ]);
  const cliBundle = join(bundleDirectory, "agentflow-cli.mjs");
  const mcpBundle = join(bundleDirectory, "agentflow-mcp.mjs");
  const skillsLockPath = join(distribution, "skills-lock.json");
  await Promise.all([
    writeFile(cliBundle, "#!/usr/bin/env node\n"),
    writeFile(mcpBundle, "#!/usr/bin/env node\n"),
    writeFile(
      join(routerDirectory, "SKILL.md"),
      "---\nname: agentflow-auto-router\ndescription: Route changes\n---\nRoute changes.\n"
    ),
    writeFile(skillsLockPath, JSON.stringify({
      schemaVersion: 1,
      dependencies: [{
        id: "figma-mcp-server-guide",
        commit: "07316dd2920d61303ca0e52812b31f5f341e7b15",
        skills: [{ name: "figma-use" }]
      }]
    }))
  ]);
  return { root: distribution, cliBundle, mcpBundle, skillsDirectory, skillsLockPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("doctor capability normalization", () => {
  it("accepts canonical IDs and explicitly namespaced Figma tool aliases", () => {
    expect(normalizeHostCapabilities([
      "host.worker.spawn",
      "mcp__figma__use_figma",
      "figma.get_screenshot",
      "figma-use",
      "use_figma",
      "mcp__untrusted__use_figma"
    ])).toEqual({
      available: [
        "figma.tool.get_screenshot",
        "figma.tool.use_figma",
        "host.worker.spawn",
        "skill.figma-use"
      ],
      ignored: ["mcp__untrusted__use_figma", "use_figma"]
    });
  });

  it("checks the durable router/runtime surfaces and isolates restart or OAuth as a warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-"));
    temporaryDirectories.push(root);
    await executeSetup({
      projectRoot: root,
      hosts: ["all"],
      assets: await setupAssets(root),
      skipExternalSkills: true
    });

    for (const host of ["codex", "cursor", "vscode"] as const) {
      const report = await runDoctor({ paths: projectPaths(root), host });
      expect(report.ok, JSON.stringify(report.checks, null, 2)).toBe(true);
      expect(report.status).toBe("warn");
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "durable-mcp-runtime", status: "ok" }),
        expect.objectContaining({ id: "auto-router-skill", status: "ok" }),
        expect.objectContaining({ id: `auto-router-instruction.${host}`, status: "ok" }),
        expect.objectContaining({ id: "host-restart-auth", status: "warn" })
      ]));
    }
  });
});
