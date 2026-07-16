import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntryPoint = join(repositoryRoot, "packages", "cli", "dist", "index.js");
const cliTsconfig = join(repositoryRoot, "packages", "cli", "tsconfig.json");
const typescriptDirectory = dirname(require.resolve("typescript/package.json"));
const tscEntryPoint = join(typescriptDirectory, "bin", "tsc");
const temporaryDirectories: string[] = [];

function execute(
  file: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", ...environment }
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr
      });
    });
  });
}

async function runCli(projectRoot: string, ...args: string[]): Promise<CliResult> {
  return execute(cliEntryPoint, ["--project-root", projectRoot, ...args]);
}

async function runCliWithEnvironment(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<CliResult> {
  return execute(cliEntryPoint, ["--project-root", projectRoot, ...args], environment);
}

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentflow-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function parseOutput<T>(result: CliResult): T {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

beforeAll(async () => {
  const result = await execute(tscEntryPoint, ["-b", cliTsconfig, "--pretty", "false"]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  const bundleDirectory = join(repositoryRoot, "bundle");
  await mkdir(bundleDirectory, { recursive: true });
  for (const name of ["agentflow-cli.mjs", "agentflow-mcp.mjs"]) {
    await writeFile(join(bundleDirectory, name), "#!/usr/bin/env node\n", { flag: "wx" })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
  }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agentflow CLI", () => {
  it("reports the 0.3.0 distribution version", async () => {
    const result = await execute(cliEntryPoint, ["--version"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "0.3.0\n",
      stderr: ""
    });
  });

  it("runs global setup by default without changing the project", async () => {
    const projectRoot = await createTemporaryProject();
    const home = await createTemporaryProject();
    const environment = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      AGENTFLOW_HOME: join(home, ".agentflow"),
      CODEX_HOME: join(home, ".codex")
    };

    const result = parseOutput<{
      projectRoot: string;
      runtime: { cli: string; mcp: string };
      doctor: { ok: boolean; reports: Array<{ installation: { status: string } }> };
    }>(await runCliWithEnvironment(
      projectRoot,
      environment,
      "setup",
      "--host",
      "codex",
      "--skip-external-skills"
    ));

    expect(result.projectRoot).toBe(projectRoot);
    expect(result.runtime).toEqual({
      cli: join(home, ".agentflow", "bin", "agentflow-cli.mjs"),
      mcp: join(home, ".agentflow", "bin", "agentflow-mcp.mjs")
    });
    expect(result.doctor).toMatchObject({
      ok: true,
      reports: [{ installation: { status: "warn" } }]
    });
    expect(await readdir(projectRoot)).toEqual([]);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8"))
      .not.toContain("--project-root");
  });

  it("accepts an explicit VS Code user configuration path", async () => {
    const projectRoot = await createTemporaryProject();
    const home = await createTemporaryProject();
    const vscodeConfig = join(home, "vscode-user", "mcp.json");
    const result = parseOutput<{ hosts: string[] }>(await runCliWithEnvironment(
      projectRoot,
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        AGENTFLOW_HOME: join(home, ".agentflow"),
        CODEX_HOME: join(home, ".codex")
      },
      "setup",
      "--host",
      "vscode",
      "--vscode-config",
      vscodeConfig,
      "--skip-external-skills"
    ));

    expect(result.hosts).toEqual(["vscode"]);
    expect(JSON.parse(await readFile(vscodeConfig, "utf8"))).toHaveProperty(
      "servers.agentflow.args"
    );
    expect(await readdir(projectRoot)).toEqual([]);

    const relativeOverride = await runCliWithEnvironment(
      projectRoot,
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        AGENTFLOW_HOME: join(home, ".agentflow"),
        CODEX_HOME: join(home, ".codex")
      },
      "setup",
      "--host",
      "vscode",
      "--vscode-config",
      "relative/mcp.json",
      "--skip-external-skills",
      "--dry-run"
    );
    expect(relativeOverride.exitCode).toBe(1);
    expect(JSON.parse(relativeOverride.stderr)).toMatchObject({
      error: "GLOBAL_PATH_INVALID"
    });
  });

  it("rejects project-only setup options in global scope", async () => {
    const projectRoot = await createTemporaryProject();
    for (const args of [
      ["--start", "Do not start"],
      ["--project-type", "existing"],
      ["--no-ui"]
    ]) {
      const result = await runCli(
        projectRoot,
        "setup",
        "--host",
        "codex",
        "--skip-external-skills",
        ...args
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: "SETUP_PROJECT_OPTION_REQUIRES_PROJECT_SCOPE"
      });
    }
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("runs setup for one host and optionally starts the first Run", async () => {
    const projectRoot = await createTemporaryProject();
    const result = parseOutput<{
      hosts: string[];
      runtime: { cli: string; mcp: string };
      installedSkills: string[];
      pinnedCommits: Record<string, string>;
      doctor: {
        ok: boolean;
        reports: Array<{ host?: string; ok: boolean; status: string }>;
      };
      run?: { requirement: string; activeStageId: string | null };
    }>(await runCli(
      projectRoot,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills",
      "--start",
      "Build a notes app"
    ));

    expect(result.hosts).toEqual(["codex"]);
    expect(result.runtime).toEqual({
      cli: join(projectRoot, ".agentflow/runtime/bin/agentflow-cli.mjs"),
      mcp: join(projectRoot, ".agentflow/runtime/bin/agentflow-mcp.mjs")
    });
    expect(result.installedSkills).toContain("agentflow-auto-router");
    expect(result.pinnedCommits).toHaveProperty("obra-superpowers");
    expect(result.doctor).toMatchObject({
      ok: true,
      reports: [{ host: "codex", ok: true, status: "warn" }]
    });
    expect(result.run).toMatchObject({
      requirement: "Build a notes app",
      activeStageId: "S00"
    });
    const currentRun = JSON.parse(await readFile(
      join(projectRoot, ".agentflow/current-run.json"),
      "utf8"
    )) as { runId: string };
    expect(currentRun).toHaveProperty("runId");

    const resumed = parseOutput<{
      run?: { id: string; requirement: string; activeStageId: string | null };
    }>(await runCli(
      projectRoot,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills",
      "--start",
      "Do not create a second Run"
    ));
    expect(resumed.run).toMatchObject({
      id: currentRun.runId,
      requirement: "Build a notes app",
      activeStageId: "S00"
    });
    expect(await readdir(join(projectRoot, ".agentflow", "runs")))
      .toHaveLength(1);
  });

  it("rejects setup options that cannot have an effect", async () => {
    const projectRoot = await createTemporaryProject();
    for (const args of [
      ["--no-ui"],
      ["--project-type", "existing"]
    ]) {
      const result = await runCli(
        projectRoot,
        "setup",
        "--scope",
        "project",
        "--host",
        "codex",
        "--skip-external-skills",
        ...args
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: "SETUP_OPTION_REQUIRES_START"
      });
    }

    const dryStart = await runCli(
      projectRoot,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills",
      "--dry-run",
      "--start",
      "Do not write"
    );
    expect(dryStart.exitCode).toBe(1);
    expect(JSON.parse(dryStart.stderr)).toMatchObject({
      error: "SETUP_DRY_RUN_START_CONFLICT"
    });
    await expect(readFile(join(projectRoot, ".agentflow", "current-run.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report a skipped dry-run doctor as healthy", async () => {
    const projectRoot = await createTemporaryProject();
    const result = parseOutput<{
      doctor: { ok: boolean | null; skipped: boolean; reports: unknown[] };
    }>(await runCli(
      projectRoot,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills",
      "--dry-run"
    ));

    expect(result.doctor).toEqual({
      ok: null,
      skipped: true,
      reports: []
    });
  });

  it("does not start a Run when setup doctor finds an unusable project", async () => {
    const projectRoot = await createTemporaryProject();
    await mkdir(join(projectRoot, ".agentflow"), { recursive: true });
    await writeFile(join(projectRoot, ".agentflow", "config.yaml"), "[invalid\n");

    const result = await runCli(
      projectRoot,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills",
      "--start",
      "Must not start"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      doctor: { ok: false }
    });
    await expect(readFile(join(projectRoot, ".agentflow", "current-run.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes a project and starts a selected run", async () => {
    const projectRoot = await createTemporaryProject();
    const initialized = parseOutput<{ initialized: boolean; directory: string }>(await runCli(projectRoot, "init"));
    expect(initialized).toEqual({
      initialized: true,
      directory: join(projectRoot, ".agentflow")
    });

    const started = parseOutput<{ id: string; projectType: string; hasUi: boolean }>(await runCli(
      projectRoot,
      "start",
      "Build a command line application",
      "--id",
      "cli-smoke",
      "--project-type",
      "existing",
      "--no-ui"
    ));
    expect(started).toMatchObject({ id: "cli-smoke", projectType: "existing", hasUi: false });

    const currentRun = JSON.parse(await readFile(join(projectRoot, ".agentflow", "current-run.json"), "utf8")) as { runId: string };
    expect(currentRun).toEqual({ runId: "cli-smoke" });

    const status = parseOutput<{ id: string; activeStageId: string }>(await runCli(projectRoot, "status"));
    expect(status).toMatchObject({ id: "cli-smoke", activeStageId: "S00" });
  });

  it("executes a real task, artifact, and stage-transition workflow", async () => {
    const projectRoot = await createTemporaryProject();
    parseOutput(await runCli(projectRoot, "start", "Exercise the CLI", "--id", "workflow-smoke"));

    const created = parseOutput<{ tasks: Record<string, { status: string; writeScopes: string[] }> }>(await runCli(
      projectRoot,
      "task",
      "create",
      "inspect-requirement",
      "--stage",
      "S00",
      "--title",
      "Inspect requirement",
      "--write-scope",
      "packages/cli/**"
    ));
    expect(created.tasks["inspect-requirement"]).toMatchObject({
      status: "ready",
      writeScopes: ["packages/cli/**"]
    });

    const invalidLease = await runCli(
      projectRoot,
      "task",
      "claim",
      "inspect-requirement",
      "--worker",
      "worker-1",
      "--lease-seconds",
      "0"
    );
    expect(invalidLease.exitCode).toBe(1);
    expect(invalidLease.stderr).toContain("lease seconds must be a safe integer greater than or equal to 1");

    const claimed = parseOutput<{ tasks: Record<string, { status: string; owner?: string }> }>(await runCli(
      projectRoot,
      "task",
      "claim",
      "inspect-requirement",
      "--worker",
      "worker-1",
      "--lease-seconds",
      "60"
    ));
    expect(claimed.tasks["inspect-requirement"]).toMatchObject({ status: "running", owner: "worker-1" });

    const invalidResult = await runCli(
      projectRoot,
      "task",
      "complete",
      "inspect-requirement",
      "--worker",
      "worker-1",
      "--verification-command",
      "npm test",
      "--result",
      "[]"
    );
    expect(invalidResult.exitCode).toBe(1);
    expect(JSON.parse(invalidResult.stderr)).toMatchObject({ error: "INVALID_JSON_OBJECT" });

    const completed = parseOutput<{ tasks: Record<string, { status: string; result?: unknown; verification: unknown[] }> }>(await runCli(
      projectRoot,
      "task",
      "complete",
      "inspect-requirement",
      "--worker",
      "worker-1",
      "--verification-command",
      "npm test",
      "--verification-summary",
      "CLI tests passed",
      "--result",
      '{"filesChanged":2}'
    ));
    expect(completed.tasks["inspect-requirement"]).toMatchObject({
      status: "completed",
      result: { filesChanged: 2 }
    });
    expect(completed.tasks["inspect-requirement"]?.verification).toHaveLength(1);

    parseOutput(await runCli(
      projectRoot,
      "artifact",
      "project-context",
      "--stage",
      "S00",
      "--kind",
      "project-context",
      "--uri",
      ".agentflow/artifacts/project-context.json",
      "--content",
      '{"projectType":"new"}'
    ));
    const transitioned = parseOutput<{ activeStageId: string; stages: Record<string, { status: string }> }>(await runCli(
      projectRoot,
      "stage",
      "complete",
      "S00"
    ));
    expect(transitioned.activeStageId).toBe("S01");
    expect(transitioned.stages.S00?.status).toBe("completed");
    expect(transitioned.stages.S01?.status).toBe("active");
  }, 15_000);

  it("returns stable structured errors from the engine", async () => {
    const projectRoot = await createTemporaryProject();
    parseOutput(await runCli(projectRoot, "start", "First run", "--id", "duplicate-run"));

    const duplicate = await runCli(projectRoot, "start", "Second run", "--id", "duplicate-run");
    expect(duplicate.exitCode).toBe(1);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      error: "RUN_EXISTS",
      message: "Run already exists: duplicate-run",
      details: { runId: "duplicate-run" }
    });
  });

  it("generates host configuration and fails closed until S04 capabilities are observed live", async () => {
    const projectRoot = await createTemporaryProject();
    parseOutput(await runCli(projectRoot, "init"));

    const configured = parseOutput<{
      client: string;
      targetPath: string;
      written: boolean;
      alreadyPresent: boolean;
      content: string;
    }>(await runCli(projectRoot, "configure", "--host", "codex", "--write"));
    expect(configured).toMatchObject({ client: "codex", written: true, alreadyPresent: false });
    expect(configured.targetPath).toBe(join(projectRoot, ".codex", "config.toml"));
    expect(configured.content).toContain("https://mcp.figma.com/mcp");
    expect(configured.content).not.toMatch(/token|authorization|required\s*=\s*true/i);

    const repeated = parseOutput<{ written: boolean; alreadyPresent: boolean }>(
      await runCli(projectRoot, "configure", "--host", "codex", "--write")
    );
    expect(repeated).toMatchObject({ written: false, alreadyPresent: true });

    const setupRoot = await createTemporaryProject();
    parseOutput(await runCli(
      setupRoot,
      "setup",
      "--scope",
      "project",
      "--host",
      "codex",
      "--skip-external-skills"
    ));

    const blocked = await runCli(
      setupRoot,
      "doctor",
      "--scope",
      "project",
      "--host",
      "codex",
      "--stage",
      "S04"
    );
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      ok: false,
      status: "blocked",
      capabilities: { liveProbeProvided: false }
    });

    const capabilities = [
      "host.worker.spawn",
      "host.worker.collect",
      "figma.remote.connected",
      "figma.remote.authenticated",
      "figma.tool.whoami",
      "figma.tool.create_new_file",
      "figma.tool.use_figma",
      "figma.tool.get_metadata",
      "figma.tool.get_screenshot",
      "skill.figma-use"
    ];
    const ready = parseOutput<{
      ok: boolean;
      status: string;
      capabilities: { missing: string[]; available: string[] };
    }>(await runCli(
      setupRoot,
      "doctor",
      "--scope",
      "project",
      "--host",
      "codex",
      "--stage",
      "S04",
      "--live-probe",
      "--capability",
      ...capabilities
    ));
    expect(ready.ok).toBe(true);
    expect(ready.status).toBe("warn");
    expect(ready.capabilities).toMatchObject({ missing: [], available: capabilities.slice().sort() });
  });
});
