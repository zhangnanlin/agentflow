import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
const expectedToolNames = [
  "artifact_register",
  "artifact_validate",
  "deterministic_operation_run",
  "gate_decision_request",
  "gate_resolve",
  "implementation_plan_materialize",
  "pipeline_get",
  "resource_acquire",
  "resource_heartbeat",
  "resource_operation_begin",
  "resource_operation_finish",
  "resource_rekey",
  "resource_release",
  "resource_status",
  "run_block",
  "run_cancel",
  "run_fail",
  "run_start_or_resume",
  "run_supersede",
  "stage_complete",
  "stage_preflight_report",
  "stage_skip",
  "status_get",
  "structured_choice_request",
  "task_claim",
  "task_complete",
  "task_create",
  "task_heartbeat",
  "task_retry",
  "task_setup_abort",
  "worker_bind",
  "worker_cleanup_record",
  "worker_close",
  "worker_collect",
  "worker_dispatch_prepare",
  "worker_fail",
  "worker_interrupt",
  "worker_observe",
  "worker_prepare",
  "worker_status"
];
const packagedSkillNames = [
  "agentflow-architecture",
  "agentflow-auto-router",
  "agentflow-codex-host-bridge",
  "agentflow-completion-verifier",
  "agentflow-engineering-plan",
  "agentflow-figma-concept-explorer",
  "agentflow-integration-manager",
  "agentflow-orchestrator",
  "agentflow-prd-authoring",
  "agentflow-product-discovery",
  "agentflow-release-gate",
  "agentflow-ux-architecture",
  "agentflow-visual-qa",
  "agentflow-worktree-isolation"
];
const structuredChoiceSkillNames = [
  "agentflow-auto-router",
  "agentflow-product-discovery",
  "agentflow-prd-authoring",
  "agentflow-figma-concept-explorer",
  "agentflow-engineering-plan",
  "agentflow-orchestrator",
  "agentflow-release-gate"
];
const structuredInputSkillNames = [
  ...structuredChoiceSkillNames,
  "agentflow-codex-host-bridge"
];

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

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }))).flat();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("standalone AgentFlow distribution", () => {
  it("declares exact public AgentFlow 0.4.0 package metadata", async () => {
    const [packageJson, lockJson] = await Promise.all([
      readFile(resolve(repositoryRoot, "package.json"), "utf8").then((content) => (
        JSON.parse(content) as {
          private?: boolean;
          engines?: { node?: string };
          [key: string]: unknown;
        }
      )),
      readFile(resolve(repositoryRoot, "package-lock.json"), "utf8").then((content) => (
        JSON.parse(content) as {
          packages: Record<string, { private?: boolean; [key: string]: unknown }>;
        }
      ))
    ]);

    expect(packageJson).toMatchObject({
      name: "agentflow",
      version: "0.4.0",
      license: "UNLICENSED",
      publishConfig: { access: "public" },
      repository: {
        type: "git",
        url: "git+https://github.com/zhangnanlin/agentflow.git"
      },
      bugs: { url: "https://github.com/zhangnanlin/agentflow/issues" },
      homepage: "https://github.com/zhangnanlin/agentflow#readme",
      engines: { node: ">=20" }
    });
    expect(packageJson.private).toBeUndefined();
    expect(lockJson.packages[""]).toMatchObject({
      name: "agentflow",
      version: "0.4.0",
      license: "UNLICENSED"
    });

    for (const workspace of ["cli", "core", "host-adapter", "mcp-server"]) {
      const workspaceJson = JSON.parse(await readFile(
        resolve(repositoryRoot, `packages/${workspace}/package.json`),
        "utf8"
      )) as { private?: boolean; publishConfig?: unknown };
      expect(workspaceJson.private).toBe(true);
      expect(workspaceJson.publishConfig).toBeUndefined();
    }
  });

  it("uses APIs available across the declared Node 20 range", async () => {
    const builder = await readFile(
      resolve(repositoryRoot, "scripts/build-distribution.mjs"),
      "utf8"
    );
    expect(builder).not.toContain("import.meta.dirname");
    expect(builder).toContain("fileURLToPath(import.meta.url)");
  });

  it("documents immutable public setup and lazy project routing", async () => {
    const [
      english,
      chinese,
      hostSetup,
      projectSpec,
      routerSkill,
      routingContract,
      orchestratorSkill,
      releaseGateSkill,
      completionSkill
    ] = await Promise.all([
      readFile(resolve(repositoryRoot, "README.md"), "utf8"),
      readFile(resolve(repositoryRoot, "README.zh-CN.md"), "utf8"),
      readFile(resolve(repositoryRoot, "docs/HOST_SETUP.md"), "utf8"),
      readFile(resolve(repositoryRoot, "AGENTFLOW_PROJECT_SPEC.md"), "utf8"),
      readFile(resolve(repositoryRoot, ".agents/skills/agentflow-auto-router/SKILL.md"), "utf8"),
      readFile(resolve(repositoryRoot, ".agents/skills/agentflow-auto-router/references/routing-contract.md"), "utf8"),
      readFile(resolve(repositoryRoot, ".agents/skills/agentflow-orchestrator/SKILL.md"), "utf8"),
      readFile(resolve(repositoryRoot, ".agents/skills/agentflow-release-gate/SKILL.md"), "utf8"),
      readFile(resolve(repositoryRoot, ".agents/skills/agentflow-completion-verifier/SKILL.md"), "utf8")
    ]);
    const primaryCommand = "npx --yes agentflow@0.4.0 setup --host codex";
    const immutableGitCommand = "npx --yes github:zhangnanlin/agentflow#v0.4.0 setup --host codex";

    for (const documentation of [english, chinese, hostSetup]) {
      expect(documentation).toContain(primaryCommand);
      expect(documentation).toContain(immutableGitCommand);
    }
    for (const readme of [english, chinese]) {
      expect(readme).toContain("setup --host all");
      expect(readme).toContain("--scope project");
      expect(readme).toContain("AGENTFLOW_HOME");
      expect(readme).toContain("CODEX_HOME");
      expect(readme).toContain("--vscode-config");
      expect(readme).toContain("git push");
      expect(readme).toContain("--force");
      expect(readme).not.toContain("github:zhangnanlin/agentflow#v0.2.0 setup");
    }
    for (const phrase of [
      "clickable choices",
      "three independent questions",
      "one explicit interaction",
      "cancellation",
      "text fallback"
    ]) {
      expect(english).toContain(phrase);
      expect(hostSetup).toContain(phrase);
    }
    for (const phrase of [
      "Individual projects do not rerun setup",
      "neither an MCP server entry nor an OAuth flow"
    ]) {
      expect(english).toContain(phrase);
    }
    expect(hostSetup).toContain("Do not rerun setup in individual projects");
    expect(hostSetup).toContain("no new MCP server or OAuth flow");
    for (const phrase of [
      "可点击选项",
      "最多三个独立问题",
      "一次明确交互",
      "取消",
      "文本回退"
    ]) {
      expect(chinese).toContain(phrase);
    }
    expect(chinese).toContain("各项目不需要重新执行 setup");
    expect(chinese).toContain("不新增 MCP server 条目");
    expect(chinese).toContain("不新增 OAuth 流程");
    expect(english).not.toContain("Setup installs a standalone runtime under `.agentflow/runtime/`");
    expect(chinese).not.toContain("Setup 会在 `.agentflow/runtime/` 下安装独立运行时");

    expect(routerSkill).toContain("run_start_or_resume");
    expect(routerSkill).toContain("multiple workspace roots");
    expect(routerSkill).toContain("absolute `projectRoot`");
    expect(routingContract).toContain("run_start_or_resume");
    expect(orchestratorSkill).toContain("per-call project");
    expect(orchestratorSkill).toContain("run_start_or_resume");
    expect(releaseGateSkill).toContain("source-control");
    expect(releaseGateSkill).toContain("immediate remote-ref verification");
    expect(releaseGateSkill).toContain("does not require a model Worker");
    expect(releaseGateSkill).toContain("positive observation window");
    expect(completionSkill).toContain("zero-minute observation window");
    expect(completionSkill).toContain("production");

    for (const documentation of [hostSetup, projectSpec]) {
      expect(documentation).toContain("~/.agentflow");
      expect(documentation).toContain("~/.agents/skills");
      expect(documentation).toContain("--scope project");
      expect(documentation).toContain("run_start_or_resume");
    }
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
    const approvedRootFiles = [
      "bundle/agentflow-cli.mjs",
      "bundle/agentflow-cli.mjs.map",
      "bundle/agentflow-mcp.mjs",
      "bundle/agentflow-mcp.mjs.map",
      "skills-lock.json",
      "README.md",
      "README.zh-CN.md",
      "docs/HOST_SETUP.md",
      "package.json"
    ];
    expect(files).toEqual(expect.arrayContaining(approvedRootFiles));
    const packedSkillNames = [...new Set(files.flatMap((file) => {
      const match = /^\.agents\/skills\/([^/]+)\//.exec(file);
      return match?.[1] ? [match[1]] : [];
    }))].sort();
    expect(packedSkillNames).toEqual(packagedSkillNames);
    expect(files.every((file) => (
      approvedRootFiles.includes(file)
      || packagedSkillNames.some((skill) => file.startsWith(`.agents/skills/${skill}/`))
    ))).toBe(true);
    for (const forbiddenPath of [
      /^packages\//,
      /^\.agentflow\//,
      /^\.codex\//,
      /^\.cursor\//,
      /^\.vscode\//,
      /(?:^|\/)\.npmrc$/
    ]) {
      expect(files.some((file) => forbiddenPath.test(file))).toBe(false);
    }

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
    const credentialValuePatterns = [
      /_authToken\s*=/i,
      /\bnpm_[A-Za-z0-9]{20,}\b/,
      /\bghp_[A-Za-z0-9]{20,}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/
    ];
    for (const file of await listFiles(installedPackage)) {
      const content = await readFile(file, "utf8");
      for (const pattern of credentialValuePatterns) {
        expect(`${file}\n${content}`).not.toMatch(pattern);
      }
    }
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
        serverInfo: { version: "0.4.0" }
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
    const setupResult = JSON.parse(setup.stdout) as {
      installedSkills: string[];
      [key: string]: unknown;
    };
    expect(setupResult).toMatchObject({
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
    expect(setupResult.installedSkills).toEqual(expect.arrayContaining(
      structuredInputSkillNames
    ));
    for (const skillName of structuredChoiceSkillNames) {
      expect(await readFile(
        join(home, ".agents", "skills", skillName, "SKILL.md"),
        "utf8"
      )).toContain("structured_choice_request");
    }
    expect(await readFile(
      join(home, ".agents", "skills", "agentflow-codex-host-bridge", "SKILL.md"),
      "utf8"
    )).toContain("host.user-input.structured");

    const manifest = JSON.parse(await readFile(join(runtimeRoot, "install.json"), "utf8")) as {
      version: string;
      runtime: { mcp: string };
      [key: string]: unknown;
    };
    expect(manifest).toMatchObject({
      version: "0.4.0",
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
        version: "0.4.0"
      });
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        expectedToolNames
      );
      expect(toolResult(await client.callTool({
        name: "structured_choice_request",
        arguments: {
          message: "Choose a bounded delivery target.",
          questions: [{
            id: "target",
            prompt: "Which target should be used?",
            options: [
              { value: "staging", label: "Staging" },
              { value: "production", label: "Production" }
            ]
          }]
        }
      }))).toMatchObject({
        outcome: "unsupported",
        fallback: {
          instruction: "Present all questions once and submit only explicit user selections."
        }
      });
      const startedA = toolResult<{ action: string; summary: { runId: string } }>(await client.callTool({
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
      const startedB = toolResult<{ action: string; summary: { runId: string } }>(await client.callTool({
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
      expect(startedA).toMatchObject({ action: "started", summary: { runId: "packed-project-a" } });
      expect(startedB).toMatchObject({ action: "started", summary: { runId: "packed-project-b" } });
      expect(toolResult<{ id: string }>(await client.callTool({
        name: "status_get",
        arguments: {
          projectRoot: projectA,
          runId: "packed-project-a",
          responseProfile: "full"
        }
      }))).toMatchObject({ id: "packed-project-a" });
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
