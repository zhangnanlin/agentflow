import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DistributionAssets } from "../src/distribution.js";
import {
  globalInstallationPaths,
  type GlobalPathEnvironment
} from "../src/global-paths.js";
import { executeSetup, resolveSetupDestination } from "../src/setup.js";

const temporaryDirectories: string[] = [];
const superpowersCommit = "d884ae04edebef577e82ff7c4e143debd0bbec99";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeDistributionAssets(root: string): Promise<DistributionAssets> {
  const distribution = join(root, "test-distribution");
  const skillsDirectory = join(distribution, ".agents", "skills");
  await mkdir(join(skillsDirectory, "agentflow-auto-router"), { recursive: true });
  const cliBundle = join(distribution, "bundle", "agentflow-cli.mjs");
  const mcpBundle = join(distribution, "bundle", "agentflow-mcp.mjs");
  const skillsLockPath = join(distribution, "skills-lock.json");
  await mkdir(join(distribution, "bundle"), { recursive: true });
  await Promise.all([
    writeFile(cliBundle, "#!/usr/bin/env node\n"),
    writeFile(mcpBundle, "#!/usr/bin/env node\n"),
    writeFile(
      join(skillsDirectory, "agentflow-auto-router", "SKILL.md"),
      "---\nname: agentflow-auto-router\ndescription: Route changes\n---\nRoute changes.\n"
    ),
    writeFile(skillsLockPath, JSON.stringify({ schemaVersion: 1, dependencies: [] }))
  ]);
  return { root: distribution, cliBundle, mcpBundle, skillsDirectory, skillsLockPath };
}

function globalEnvironment(home: string): GlobalPathEnvironment {
  return {
    platform: process.platform,
    home,
    ...(process.platform === "win32" ? { appData: join(home, "AppData", "Roaming") } : {})
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("AgentFlow setup", () => {
  it("installs runtime, Skills, manifest, and all host configs globally without touching the project", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-setup-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "project");
    await Promise.all([mkdir(home), mkdir(projectRoot)]);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);
    const options = {
      scope: "global" as const,
      projectRoot,
      hosts: ["all" as const],
      assets: await fakeDistributionAssets(sandbox),
      skipExternalSkills: true
    };

    const first = await executeSetup(options, { globalPathEnvironment: environment });
    expect(first.runtime).toEqual({ cli: paths.runtimeCli, mcp: paths.runtimeMcp });
    expect(first.installedSkills).toEqual(["agentflow-auto-router"]);
    expect(await readFile(paths.runtimeMcp, "utf8")).toContain("#!/usr/bin/env node");
    expect(await readFile(join(paths.skillsRoot, "agentflow-auto-router", "SKILL.md"), "utf8"))
      .toContain("name: agentflow-auto-router");
    expect(await readdir(projectRoot)).toEqual([]);

    const codex = await readFile(paths.codexConfig, "utf8");
    const cursor = await readFile(paths.cursorConfig, "utf8");
    const vscode = await readFile(paths.vscodeConfig, "utf8");
    for (const configuration of [codex, cursor, vscode]) expect(configuration).not.toContain("--project-root");

    const manifestSource = await readFile(paths.installManifest, "utf8");
    const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      hosts: ["codex", "cursor", "vscode"],
      skills: ["agentflow-auto-router"]
    });
    expect(manifestSource).not.toMatch(/token|secret|authorization|credential/i);

    const second = await executeSetup(options, { globalPathEnvironment: environment });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  it("plans global setup without writing during dry-run", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-dry-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "project");
    await Promise.all([mkdir(home), mkdir(projectRoot)]);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);

    const result = await executeSetup({
      scope: "global",
      projectRoot,
      hosts: ["all"],
      assets: await fakeDistributionAssets(sandbox),
      dryRun: true,
      skipExternalSkills: true
    }, { globalPathEnvironment: environment });

    expect(result.planned.length).toBeGreaterThan(0);
    expect(result.planned).toContain(paths.runtimeMcp);
    await expect(readFile(paths.runtimeMcp)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("does not require or create a project root for global setup", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-no-project-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "does-not-exist");
    await mkdir(home);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);

    await expect(executeSetup({
      scope: "global",
      projectRoot,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(sandbox),
      skipExternalSkills: true
    }, { globalPathEnvironment: environment })).resolves.toMatchObject({
      runtime: { mcp: paths.runtimeMcp }
    });
    await expect(readFile(join(projectRoot, "anything"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unrelated user Skills and Codex configuration", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-preserve-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "project");
    await Promise.all([mkdir(home), mkdir(projectRoot)]);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);
    const unrelatedSkill = join(paths.skillsRoot, "team-skill", "SKILL.md");
    await mkdir(join(paths.skillsRoot, "team-skill"), { recursive: true });
    await mkdir(join(paths.codexConfig, ".."), { recursive: true });
    await writeFile(unrelatedSkill, "team owned\n");
    await writeFile(paths.codexConfig, "model = \"gpt-test\"\n", "utf8");

    await executeSetup({
      scope: "global",
      projectRoot,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(sandbox),
      skipExternalSkills: true
    }, { globalPathEnvironment: environment });

    expect(await readFile(unrelatedSkill, "utf8")).toBe("team owned\n");
    expect(await readFile(paths.codexConfig, "utf8")).toContain("model = \"gpt-test\"");
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("rejects a linked global Skills parent before any write", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-link-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "project");
    const outside = join(sandbox, "outside-skills");
    await Promise.all([mkdir(home), mkdir(projectRoot), mkdir(outside)]);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);
    await symlink(
      outside,
      join(home, ".agents"),
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(executeSetup({
      scope: "global",
      projectRoot,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(sandbox),
      skipExternalSkills: true
    }, { globalPathEnvironment: environment })).rejects.toMatchObject({ code: "SETUP_PATH_ESCAPE" });
    await expect(readFile(paths.runtimeMcp)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("rejects a conflicting global Skill before writing runtime files", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-collision-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "project");
    await Promise.all([mkdir(home), mkdir(projectRoot)]);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);
    const collision = join(paths.skillsRoot, "agentflow-auto-router");
    await mkdir(collision, { recursive: true });
    await writeFile(join(collision, "SKILL.md"), "different Skill\n");

    await expect(executeSetup({
      scope: "global",
      projectRoot,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(sandbox),
      skipExternalSkills: true
    }, { globalPathEnvironment: environment })).rejects.toMatchObject({ code: "SKILL_COLLISION" });
    await expect(readFile(paths.runtimeMcp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back writes across global roots when a later rename fails", async () => {
    const sandbox = await temporaryDirectory("agentflow-global-rollback-");
    const home = join(sandbox, "home");
    const projectRoot = join(sandbox, "project");
    await Promise.all([mkdir(home), mkdir(projectRoot)]);
    const environment = globalEnvironment(home);
    const paths = globalInstallationPaths(environment);
    let renameCount = 0;

    await expect(executeSetup({
      scope: "global",
      projectRoot,
      hosts: ["all"],
      assets: await fakeDistributionAssets(sandbox),
      skipExternalSkills: true
    }, {
      globalPathEnvironment: environment,
      fileSystem: {
        rename: async (source, destination) => {
          renameCount += 1;
          if (renameCount === 4) throw new Error("injected global rename failure");
          await rename(source, destination);
        }
      }
    })).rejects.toThrow("injected global rename failure");

    await expect(readFile(paths.runtimeCli)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.runtimeMcp)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("creates runtime, Skills, host config, and automatic routing idempotently", async () => {
    const root = await temporaryDirectory("agentflow-setup-");
    const assets = await fakeDistributionAssets(root);

    const first = await executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    });
    expect(first.created).toContain(join(root, ".agentflow/runtime/bin/agentflow-mcp.mjs"));
    expect(first.runtime).toEqual({
      cli: join(root, ".agentflow/runtime/bin/agentflow-cli.mjs"),
      mcp: join(root, ".agentflow/runtime/bin/agentflow-mcp.mjs")
    });
    expect(first.installedSkills).toEqual(["agentflow-auto-router"]);
    expect(first.pinnedCommits).toEqual({});
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("agentflow:auto-router:start");
    expect(await readFile(join(root, ".codex/config.toml"), "utf8")).toContain("agentflow-mcp.mjs");

    const second = await executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  it("preserves a UTF-8 BOM outside the managed instruction block", async () => {
    const root = await temporaryDirectory("agentflow-instruction-bom-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "\uFEFF# Team rules\r\n");

    await executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(root),
      skipExternalSkills: true
    });

    expect(await readFile(agentsPath, "utf8"))
      .toMatch(/^\uFEFF# Team rules\r\n/);
  });

  it("writes nothing during dry-run", async () => {
    const root = await temporaryDirectory("agentflow-dry-");
    const result = await executeSetup({
      projectRoot: root,
      hosts: ["all"],
      assets: await fakeDistributionAssets(root),
      dryRun: true,
      skipExternalSkills: true
    });

    expect(result.planned.length).toBeGreaterThan(0);
    await expect(readFile(join(root, "AGENTS.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs native configuration and instructions for all hosts", async () => {
    const root = await temporaryDirectory("agentflow-all-hosts-");
    const result = await executeSetup({
      projectRoot: root,
      hosts: ["all"],
      assets: await fakeDistributionAssets(root),
      skipExternalSkills: true
    });

    expect(result.hosts).toEqual(["codex", "cursor", "vscode"]);
    expect(await readFile(join(root, ".cursor/rules/agentflow.mdc"), "utf8"))
      .toMatch(/alwaysApply:\s*true/);
    expect(await readFile(join(root, ".github/copilot-instructions.md"), "utf8"))
      .toContain("agentflow:auto-router:start");
    expect(await readFile(join(root, ".codex/config.toml"), "utf8"))
      .toContain("agentflow-mcp.mjs");
    expect(JSON.parse(await readFile(join(root, ".cursor/mcp.json"), "utf8")))
      .toHaveProperty("mcpServers.agentflow");
    expect(JSON.parse(await readFile(join(root, ".vscode/mcp.json"), "utf8")))
      .toHaveProperty("servers.agentflow");
  });

  it("rejects a different Skill at the same destination before writing", async () => {
    const root = await temporaryDirectory("agentflow-skill-collision-");
    const assets = await fakeDistributionAssets(root);
    const destination = join(root, ".agents", "skills", "agentflow-auto-router");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "unrelated Skill\n");

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    })).rejects.toMatchObject({ code: "SKILL_COLLISION" });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unrelated Cursor rule at the AgentFlow-owned path", async () => {
    const root = await temporaryDirectory("agentflow-cursor-rule-");
    const assets = await fakeDistributionAssets(root);
    const rulePath = join(root, ".cursor", "rules", "agentflow.mdc");
    const unrelated = "---\ndescription: Team rule\nalwaysApply: true\n---\nDo not replace me.\n";
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(rulePath, unrelated);

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["cursor"],
      assets,
      skipExternalSkills: true
    })).rejects.toMatchObject({ code: "INSTRUCTION_CONFLICT" });
    expect(await readFile(rulePath, "utf8")).toBe(unrelated);
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unmarked Cursor rule that copies AgentFlow frontmatter", async () => {
    const root = await temporaryDirectory("agentflow-cursor-signature-");
    const assets = await fakeDistributionAssets(root);
    const rulePath = join(root, ".cursor", "rules", "agentflow.mdc");
    const unrelated = [
      "---",
      "description: Route project changes through AgentFlow",
      "globs:",
      "alwaysApply: true",
      "---",
      "",
      "Keep this team instruction.",
      ""
    ].join("\n");
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(rulePath, unrelated);

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["cursor"],
      assets,
      skipExternalSkills: true
    })).rejects.toMatchObject({ code: "INSTRUCTION_CONFLICT" });
    expect(await readFile(rulePath, "utf8")).toBe(unrelated);
  });

  it("restores earlier writes when a later atomic rename fails", async () => {
    const root = await temporaryDirectory("agentflow-rollback-");
    const assets = await fakeDistributionAssets(root);
    const agentsPath = join(root, "AGENTS.md");
    const originalAgents = "# Team rules\n";
    await writeFile(agentsPath, originalAgents);
    let renameCount = 0;

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    }, {
      fileSystem: {
        rename: async (source: string, destination: string) => {
          renameCount += 1;
          if (renameCount === 2) throw new Error("injected rename failure");
          await rename(source, destination);
        }
      }
    })).rejects.toThrow("injected rename failure");

    expect(await readFile(agentsPath, "utf8")).toBe(originalAgents);
    await expect(readFile(join(root, ".agentflow/runtime/bin/agentflow-mcp.mjs")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects destination traversal and linked distribution files before writes", async () => {
    const root = await temporaryDirectory("agentflow-path-");
    const assets = await fakeDistributionAssets(root);
    const outside = join(root, "outside-skill");
    await mkdir(outside);
    await writeFile(join(outside, "outside.md"), "outside\n");
    await symlink(
      outside,
      join(assets.skillsDirectory, "agentflow-auto-router", "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(() => resolveSetupDestination(root, "../escape"))
      .toThrowError(expect.objectContaining({ code: "SETUP_PATH_ESCAPE" }));
    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    })).rejects.toMatchObject({ code: "SETUP_PATH_ESCAPE" });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a distribution file reached through a linked parent directory", async () => {
    const root = await temporaryDirectory("agentflow-parent-link-");
    const assets = await fakeDistributionAssets(root);
    const bundleDirectory = join(assets.root, "bundle");
    const realBundleDirectory = join(assets.root, "real-bundle");
    await rename(bundleDirectory, realBundleDirectory);
    await symlink(
      realBundleDirectory,
      bundleDirectory,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    })).rejects.toMatchObject({ code: "SETUP_PATH_ESCAPE" });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a linked distribution root before writing", async () => {
    const root = await temporaryDirectory("agentflow-root-link-");
    const assets = await fakeDistributionAssets(root);
    const realDistribution = join(root, "real-distribution");
    await rename(assets.root, realDistribution);
    await symlink(
      realDistribution,
      assets.root,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    })).rejects.toMatchObject({ code: "SETUP_PATH_ESCAPE" });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates the project root before every write", async () => {
    const parent = await temporaryDirectory("agentflow-root-swap-");
    const root = join(parent, "project");
    const movedRoot = join(parent, "moved-project");
    const outsideRoot = join(parent, "outside");
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(outsideRoot, { recursive: true })
    ]);
    const assets = await fakeDistributionAssets(root);
    let swapped = false;

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets,
      skipExternalSkills: true
    }, {
      fileSystem: {
        rename: async (source: string, destination: string) => {
          await rename(source, destination);
          if (swapped) return;
          swapped = true;
          await rename(root, movedRoot);
          await symlink(
            outsideRoot,
            root,
            process.platform === "win32" ? "junction" : "dir"
          );
        }
      }
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^SETUP_(?:PATH_ESCAPE|ROLLBACK_FAILED)$/)
    });

    expect(swapped).toBe(true);
    await expect(readFile(join(
      outsideRoot,
      ".agentflow/runtime/bin/agentflow-cli.mjs"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported Node versions before writing", async () => {
    const root = await temporaryDirectory("agentflow-node-version-");

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(root),
      skipExternalSkills: true
    }, { nodeVersion: "19.9.0" })).rejects.toMatchObject({
      code: "SETUP_NODE_UNSUPPORTED"
    });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires Git even when external Skills are skipped", async () => {
    const root = await temporaryDirectory("agentflow-git-required-");

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets: await fakeDistributionAssets(root),
      skipExternalSkills: true
    }, {
      gitRunner: async () => {
        throw new Error("git unavailable");
      }
    })).rejects.toMatchObject({ code: "SETUP_GIT_UNAVAILABLE" });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages only lock-declared Superpowers Skills at the pinned commit", async () => {
    const root = await temporaryDirectory("agentflow-external-");
    const assets = await fakeDistributionAssets(root);
    await writeFile(assets.skillsLockPath, JSON.stringify({
      schemaVersion: 1,
      dependencies: [{
        id: "obra-superpowers",
        repository: "https://example.invalid/obra/superpowers.git",
        commit: superpowersCommit,
        skills: [{ name: "brainstorming" }]
      }]
    }));
    const calls: string[][] = [];

    const result = await executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets
    }, {
      gitRunner: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "clone") {
          const checkout = args.at(-1);
          if (!checkout) throw new Error("missing checkout path");
          await mkdir(join(checkout, "skills", "brainstorming"), { recursive: true });
          await writeFile(
            join(checkout, "skills", "brainstorming", "SKILL.md"),
            "---\nname: brainstorming\ndescription: Think first\n---\nThink first.\n"
          );
          await mkdir(join(checkout, "skills", "not-declared"), { recursive: true });
          await writeFile(join(checkout, "skills", "not-declared", "SKILL.md"), "not installed\n");
        }
        return args.includes("rev-parse") ? { stdout: `${superpowersCommit}\n` } : { stdout: "" };
      }
    });

    expect(await readFile(
      join(root, ".agents", "skills", "brainstorming", "SKILL.md"),
      "utf8"
    )).toContain("name: brainstorming");
    await expect(readFile(join(root, ".agents", "skills", "not-declared", "SKILL.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.some((args) => args.includes(superpowersCommit))).toBe(true);
    expect(calls.some((args) => args.includes("core.autocrlf=false")
      && args.includes("checkout"))).toBe(true);
    expect(result.created).toContain(
      join(root, ".agents", "skills", "brainstorming", "SKILL.md")
    );
    expect(result.pinnedCommits).toEqual({
      "obra-superpowers": superpowersCommit
    });
  });

  it("rejects a mismatched external checkout and removes its staging directory", async () => {
    const root = await temporaryDirectory("agentflow-external-mismatch-");
    const assets = await fakeDistributionAssets(root);
    await writeFile(assets.skillsLockPath, JSON.stringify({
      schemaVersion: 1,
      dependencies: [{
        id: "obra-superpowers",
        repository: "https://example.invalid/obra/superpowers.git",
        commit: superpowersCommit,
        skills: [{ name: "brainstorming" }]
      }]
    }));
    let checkout: string | undefined;

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets
    }, {
      gitRunner: async (args: string[]) => {
        if (args[0] === "clone") {
          checkout = args.at(-1);
          if (!checkout) throw new Error("missing checkout path");
          await mkdir(join(checkout, "skills", "brainstorming"), { recursive: true });
          await writeFile(join(checkout, "skills", "brainstorming", "SKILL.md"), "staged\n");
        }
        return args.includes("rev-parse") ? { stdout: `${"0".repeat(40)}\n` } : { stdout: "" };
      }
    })).rejects.toMatchObject({ code: "EXTERNAL_SKILL_COMMIT_MISMATCH" });

    expect(checkout).toBeDefined();
    await expect(readFile(join(checkout ?? "", "skills", "brainstorming", "SKILL.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects external Skill activation when reviewed content does not match", async () => {
    const root = await temporaryDirectory("agentflow-external-policy-mismatch-");
    const assets = await fakeDistributionAssets(root);
    await writeFile(assets.skillsLockPath, JSON.stringify({
      schemaVersion: 2,
      updatePolicy: "manual-review-only",
      dependencies: [{
        id: "obra-superpowers",
        organization: "obra",
        repository: "https://example.invalid/obra/superpowers.git",
        commit: superpowersCommit,
        license: "MIT",
        sourceMode: "external-host",
        reviewedAt: "2026-07-15",
        skills: [{
          name: "brainstorming",
          activation: "orchestration",
          contentSha256: "0".repeat(64),
          entrypoint: "SKILL.md",
          scriptScope: [],
          toolScope: ["filesystem.read"],
          audits: { socket: "pass" },
          approval: {
            status: "approved",
            reviewedBy: "agentflow-maintainers",
            reviewedAt: "2026-07-15"
          },
          adapterCompatibility: ["codex", "cursor", "vscode"],
          restrictions: ["core-safety-precedence", "manual-updates-only"],
          policyRules: ["focused-task-briefs"]
        }]
      }]
    }));

    await expect(executeSetup({
      projectRoot: root,
      hosts: ["codex"],
      assets
    }, {
      gitRunner: async (args: string[]) => {
        if (args[0] === "clone") {
          const checkout = args.at(-1);
          if (!checkout) throw new Error("missing checkout path");
          await mkdir(join(checkout, "skills", "brainstorming"), { recursive: true });
          await writeFile(
            join(checkout, "skills", "brainstorming", "SKILL.md"),
            "---\nname: brainstorming\n---\nThink first.\n"
          );
        }
        return args.includes("rev-parse") ? { stdout: `${superpowersCommit}\n` } : { stdout: "" };
      }
    })).rejects.toMatchObject({
      code: "SKILL_POLICY_INVALID",
      message: expect.stringContaining("content SHA-256")
    });

    await expect(readFile(join(root, "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
