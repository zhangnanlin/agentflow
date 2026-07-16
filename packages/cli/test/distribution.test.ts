import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliBundle = resolve(repositoryRoot, "bundle/agentflow-cli.mjs");
const temporaryDirectories: string[] = [];

function stringEnvironment(overrides: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  ));
}

function toolResult<T>(value: unknown): T {
  const result = value as { content?: Array<{ type?: string; text?: string }> };
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("Tool result did not contain JSON text");
  return JSON.parse(text) as T;
}

function initializeMcp(entryPoint: string, projectRoot: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entryPoint, "--project-root", projectRoot], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP initialize timed out: ${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`MCP exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim().split(/\r?\n/)[0] ?? ""));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentflow-package-test", version: "1.0.0" }
      }
    })}\n`);
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("standalone AgentFlow distribution", () => {
  it("declares distribution version 0.3.0", async () => {
    const packageJson = JSON.parse(await readFile(
      resolve(repositoryRoot, "package.json"),
      "utf8"
    )) as { version?: string };

    expect(packageJson.version).toBe("0.3.0");
  });

  it("uses APIs available across the declared Node 20 range", async () => {
    const builder = await readFile(
      resolve(repositoryRoot, "scripts/build-distribution.mjs"),
      "utf8"
    );
    expect(builder).not.toContain("import.meta.dirname");
    expect(builder).toContain("fileURLToPath(import.meta.url)");
  });

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
      "--scope",
      "project",
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
      "--scope",
      "project",
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
      "skills-lock.json",
      "README.md",
      "README.zh-CN.md"
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      ".codex/config.toml",
      ".cursor/mcp.json",
      ".vscode/mcp.json"
    ]));

    const packageDirectory = await mkdtemp(join(tmpdir(), "agentflow-package-"));
    const installDirectory = await mkdtemp(join(tmpdir(), "agentflow-install-"));
    const installedTarget = await mkdtemp(join(tmpdir(), "agentflow-installed-target-"));
    temporaryDirectories.push(packageDirectory, installDirectory, installedTarget);
    await mkdir(packageDirectory, { recursive: true });
    const packedArtifact = await execFileAsync(process.execPath, [
      npmExecPath,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packageDirectory
    ], { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 });
    const artifactManifest = JSON.parse(packedArtifact.stdout) as Array<{ filename: string }>;
    const tarball = join(packageDirectory, artifactManifest[0]?.filename ?? "");
    await execFileAsync(process.execPath, [
      npmExecPath,
      "install",
      "--prefix",
      installDirectory,
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      tarball
    ], { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 });
    const installedPackage = join(installDirectory, "node_modules", "agentflow");
    const installedCli = join(installedPackage, "bundle", "agentflow-cli.mjs");
    const installedMcp = join(installedPackage, "bundle", "agentflow-mcp.mjs");
    const installedSetup = await execFileAsync(process.execPath, [
      installedCli,
      "--project-root",
      installedTarget,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills"
    ], { cwd: installedTarget });
    expect(JSON.parse(installedSetup.stdout)).toMatchObject({
      hosts: ["codex"],
      doctor: { ok: true }
    });
    expect(await initializeMcp(installedMcp, installedTarget)).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: expect.any(Object) },
        serverInfo: { version: "0.3.0" }
      }
    });
  }, 60_000);

  it("installs globally once and isolates two projects through the packed MCP server", async () => {
    await execFileAsync(process.execPath, [
      resolve(repositoryRoot, "scripts/build-distribution.mjs")
    ], { cwd: repositoryRoot });
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) throw new Error("npm_execpath is required for the package test");

    const packageDirectory = await mkdtemp(join(tmpdir(), "agentflow-global-package-"));
    const installDirectory = await mkdtemp(join(tmpdir(), "agentflow-global-install-"));
    const home = await mkdtemp(join(tmpdir(), "agentflow-global-home-"));
    const projectA = await mkdtemp(join(tmpdir(), "agentflow-project-a-"));
    const projectB = await mkdtemp(join(tmpdir(), "agentflow-project-b-"));
    temporaryDirectories.push(packageDirectory, installDirectory, home, projectA, projectB);

    const packedArtifact = await execFileAsync(process.execPath, [
      npmExecPath,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packageDirectory
    ], { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 });
    const artifactManifest = JSON.parse(packedArtifact.stdout) as Array<{ filename: string }>;
    const tarball = join(packageDirectory, artifactManifest[0]?.filename ?? "");
    await execFileAsync(process.execPath, [
      npmExecPath,
      "install",
      "--prefix",
      installDirectory,
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      tarball
    ], { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 });

    await Promise.all([
      execFileAsync("git", ["init"], { cwd: projectA }),
      execFileAsync("git", ["init"], { cwd: projectB })
    ]);
    const installedPackage = join(installDirectory, "node_modules", "agentflow");
    const installedCli = join(installedPackage, "bundle", "agentflow-cli.mjs");
    const runtimeRoot = join(home, ".agentflow");
    const environment = stringEnvironment({
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      AGENTFLOW_HOME: runtimeRoot,
      CODEX_HOME: join(home, ".codex")
    });

    const setup = await execFileAsync(process.execPath, [
      installedCli,
      "--project-root",
      projectA,
      "setup",
      "--host",
      "codex",
      "--skip-external-skills"
    ], { cwd: projectA, env: environment });
    expect(JSON.parse(setup.stdout)).toMatchObject({
      hosts: ["codex"],
      runtime: {
        cli: join(runtimeRoot, "bin", "agentflow-cli.mjs"),
        mcp: join(runtimeRoot, "bin", "agentflow-mcp.mjs")
      },
      doctor: {
        ok: true,
        reports: [{ project: { status: "not-initialized" } }]
      }
    });

    const manifest = JSON.parse(await readFile(join(runtimeRoot, "install.json"), "utf8")) as {
      version: string;
      runtime: { mcp: string };
      [key: string]: unknown;
    };
    expect(manifest).toMatchObject({
      version: "0.3.0",
      runtime: { mcp: join(runtimeRoot, "bin", "agentflow-mcp.mjs") }
    });
    expect(JSON.stringify(manifest)).not.toMatch(/token|secret|authorization/i);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [manifest.runtime.mcp],
      cwd: projectA,
      env: environment,
      stderr: "pipe"
    });
    const client = new Client({ name: "agentflow-packed-global-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: "agentflow",
        version: "0.3.0"
      });
      const startedA = toolResult<{ action: string; state: { id: string } }>(await client.callTool({
        name: "run_start_or_resume",
        arguments: {
          projectRoot: projectA,
          requirement: "Build project A",
          projectType: "new",
          hasUi: true,
          requestedRunId: "packed-project-a",
          requestKey: "packed-project-a-start"
        }
      }));
      const startedB = toolResult<{ action: string; state: { id: string } }>(await client.callTool({
        name: "run_start_or_resume",
        arguments: {
          projectRoot: projectB,
          requirement: "Build project B",
          projectType: "existing",
          hasUi: false,
          requestedRunId: "packed-project-b",
          requestKey: "packed-project-b-start"
        }
      }));
      expect(startedA).toMatchObject({ action: "started", state: { id: "packed-project-a" } });
      expect(startedB).toMatchObject({ action: "started", state: { id: "packed-project-b" } });
    } finally {
      await client.close();
    }

    expect(JSON.parse(await readFile(
      join(projectA, ".agentflow", "current-run.json"),
      "utf8"
    ))).toEqual({ runId: "packed-project-a" });
    expect(JSON.parse(await readFile(
      join(projectB, ".agentflow", "current-run.json"),
      "utf8"
    ))).toEqual({ runId: "packed-project-b" });
    for (const projectRoot of [projectA, projectB]) {
      for (const relativePath of [
        ".agentflow/runtime",
        ".agents",
        ".codex",
        ".cursor",
        ".vscode"
      ]) {
        await expect(access(join(projectRoot, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      }
    }

    const doctor = await execFileAsync(process.execPath, [
      installedCli,
      "--project-root",
      projectA,
      "doctor",
      "--host",
      "codex"
    ], { cwd: projectA, env: environment });
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ok: true,
      scope: "global",
      project: { status: "initialized" }
    });
  }, 60_000);
});
