import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliBundle = resolve(repositoryRoot, "bundle/agentflow-cli.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("standalone AgentFlow distribution", () => {
  it("sets up and diagnoses an external project and packs only portable assets", async () => {
    await execFileAsync(process.execPath, [
      resolve(repositoryRoot, "scripts/build-distribution.mjs")
    ], { cwd: repositoryRoot });
    const target = await mkdtemp(join(tmpdir(), "agentflow-distribution-"));
    temporaryDirectories.push(target);

    const setup = await execFileAsync(process.execPath, [
      cliBundle,
      "--project-root",
      target,
      "setup",
      "--host",
      "codex",
      "--skip-external-skills"
    ], { cwd: target });
    expect(JSON.parse(setup.stdout)).toMatchObject({ hosts: ["codex"] });
    expect(await readFile(
      join(target, ".agentflow/runtime/bin/agentflow-mcp.mjs"),
      "utf8"
    )).toContain("#!/usr/bin/env node");

    const doctor = await execFileAsync(process.execPath, [
      cliBundle,
      "--project-root",
      target,
      "doctor",
      "--host",
      "codex"
    ], { cwd: target });
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true, host: "codex" });

    const configured = await execFileAsync(process.execPath, [
      cliBundle,
      "--project-root",
      target,
      "configure",
      "--host",
      "cursor"
    ], { cwd: target });
    const configurationPlan = JSON.parse(configured.stdout) as { content: string };
    expect(JSON.parse(configurationPlan.content)).toMatchObject({
      mcpServers: {
        agentflow: {
          args: [
            resolve(repositoryRoot, "bundle/agentflow-mcp.mjs"),
            "--project-root",
            target
          ]
        }
      }
    });

    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) throw new Error("npm_execpath is required for the package test");
    const packed = await execFileAsync(process.execPath, [
      npmExecPath,
      "pack",
      "--dry-run",
      "--json"
    ], { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 });
    const manifest = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const files = manifest[0]?.files.map((file) => file.path) ?? [];

    expect(files).toEqual(expect.arrayContaining([
      "bundle/agentflow-cli.mjs",
      "bundle/agentflow-mcp.mjs",
      ".agents/skills/agentflow-auto-router/SKILL.md",
      "skills-lock.json"
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      ".codex/config.toml",
      ".cursor/mcp.json",
      ".vscode/mcp.json"
    ]));
  }, 30_000);
});
