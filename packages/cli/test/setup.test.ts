import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DistributionAssets } from "../src/distribution.js";
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("AgentFlow setup", () => {
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
});
