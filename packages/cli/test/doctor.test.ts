import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DistributionAssets } from "../src/distribution.js";
import { normalizeHostCapabilities, runDoctor } from "../src/doctor.js";
import {
  createEngine,
  initializeProject,
  projectPaths,
  writeCurrentRun
} from "../src/runtime.js";
import { executeSetup } from "../src/setup.js";
import type { GlobalPathEnvironment } from "../src/global-paths.js";

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

function isolatedGlobalEnvironment(home: string): GlobalPathEnvironment {
  return {
    platform: process.platform,
    home,
    appData: join(home, "AppData", "Roaming"),
    xdgConfigHome: join(home, ".config"),
    agentflowHome: join(home, ".agentflow"),
    codexHome: join(home, ".codex")
  };
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
      expect(report.installation.status).toBe("warn");
      expect(report.project.status).toBe("initialized");
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "durable-mcp-runtime", status: "ok" }),
        expect.objectContaining({ id: "auto-router-skill", status: "ok" }),
        expect.objectContaining({ id: `auto-router-instruction.${host}`, status: "ok" }),
        expect.objectContaining({ id: "host-restart-auth", status: "warn" })
      ]));
    }
  });

  it("reports a healthy global installation separately from an untouched project", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-global-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(projectRoot, { recursive: true })
    ]);
    const globalPathEnvironment = isolatedGlobalEnvironment(home);
    await executeSetup({
      projectRoot,
      scope: "global",
      hosts: ["codex"],
      assets: await setupAssets(root),
      skipExternalSkills: true
    }, {
      globalPathEnvironment,
      distributionVersion: "0.3.0"
    });

    const report = await runDoctor({
      paths: projectPaths(projectRoot),
      scope: "global",
      host: "codex",
      globalPathEnvironment
    });

    expect(report.ok, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.status).toBe("warn");
    expect(report.installation).toMatchObject({ status: "warn" });
    expect(report.installation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "global-cli-runtime", status: "ok" }),
      expect.objectContaining({ id: "global-mcp-runtime", status: "ok" }),
      expect.objectContaining({ id: "auto-router-skill", status: "ok" }),
      expect.objectContaining({ id: "host-restart-auth", status: "warn" })
    ]));
    expect(report.project).toMatchObject({ status: "not-initialized" });
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("blocks a missing global runtime or router Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-missing-global-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(projectRoot, { recursive: true })
    ]);

    const report = await runDoctor({
      paths: projectPaths(projectRoot),
      scope: "global",
      globalPathEnvironment: isolatedGlobalEnvironment(home)
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe("blocked");
    expect(report.installation.status).toBe("blocked");
    expect(report.installation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "global-mcp-runtime", status: "blocked" }),
      expect.objectContaining({ id: "auto-router-skill", status: "blocked" })
    ]));
    expect(report.project.status).toBe("not-initialized");
  });

  it("marks an initialized project valid and malformed project state invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-project-state-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(projectRoot, { recursive: true })
    ]);
    const globalPathEnvironment = isolatedGlobalEnvironment(home);
    await executeSetup({
      projectRoot,
      scope: "global",
      hosts: ["codex"],
      assets: await setupAssets(root),
      skipExternalSkills: true
    }, {
      globalPathEnvironment,
      distributionVersion: "0.3.0"
    });

    const paths = projectPaths(projectRoot);
    await initializeProject(paths);
    const engine = await createEngine(paths);
    const state = await engine.createRun({
      id: "doctor-project",
      requirement: "Check project diagnostics",
      projectType: "existing",
      hasUi: false
    });
    await writeCurrentRun(state.id, paths);

    const healthy = await runDoctor({
      paths,
      scope: "global",
      host: "codex",
      globalPathEnvironment
    });
    expect(healthy.ok, JSON.stringify(healthy, null, 2)).toBe(true);
    expect(healthy.project).toMatchObject({ status: "initialized" });
    expect(healthy.project.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agentflow-config", status: "ok" }),
      expect.objectContaining({ id: "pipeline", status: "ok" }),
      expect.objectContaining({ id: "current-run", status: "ok" })
    ]));

    await writeFile(paths.currentRunPath, '{"runId":"missing-run"}\n');
    const missingRun = await runDoctor({
      paths,
      scope: "global",
      host: "codex",
      globalPathEnvironment
    });
    expect(missingRun.ok).toBe(false);
    expect(missingRun.project.status).toBe("invalid");
    await writeCurrentRun(state.id, paths);

    await writeFile(
      paths.configPath,
      "version: 1\npipeline: other.yaml\nrunsDirectory: runs\n"
    );
    const wrongConfigTargets = await runDoctor({
      paths,
      scope: "global",
      host: "codex",
      globalPathEnvironment
    });
    expect(wrongConfigTargets.ok).toBe(false);
    expect(wrongConfigTargets.project.status).toBe("invalid");

    await writeFile(paths.configPath, "[invalid\n");
    const invalidConfig = await runDoctor({
      paths,
      scope: "global",
      host: "codex",
      globalPathEnvironment
    });
    expect(invalidConfig.ok).toBe(false);
    expect(invalidConfig.status).toBe("blocked");
    expect(invalidConfig.project.status).toBe("invalid");

    await writeFile(paths.configPath, "version: 1\npipeline: pipeline.yaml\nrunsDirectory: runs\n");
    await writeFile(paths.pipelinePath, "stages: nope\n");
    const invalidPipeline = await runDoctor({
      paths,
      scope: "global",
      host: "codex",
      globalPathEnvironment
    });
    expect(invalidPipeline.ok).toBe(false);
    expect(invalidPipeline.project.status).toBe("invalid");
  });

  it("blocks when Git is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-git-"));
    temporaryDirectories.push(root);
    await executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets: await setupAssets(root),
      skipExternalSkills: true
    });

    const report = await runDoctor({
      paths: projectPaths(root),
      host: "codex",
      gitRunner: async () => {
        throw new Error("git unavailable");
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "git",
      status: "blocked"
    }));
  });
});
