import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeCapabilitySnapshot } from "@agentflow/host-adapter";
import type { DistributionAssets } from "../src/distribution.js";
import {
  collectDoctorRuntimeDiagnostics,
  probeAgentFlowMcpProcesses,
  readNativeCapabilitySnapshotFile,
  type DoctorProcessCommandRunner
} from "../src/doctor-runtime.js";
import { runDoctor } from "../src/doctor.js";
import type { GlobalPathEnvironment } from "../src/global-paths.js";
import { createEngine, initializeProject, projectPaths } from "../src/runtime.js";
import { executeSetup } from "../src/setup.js";

const temporaryDirectories: string[] = [];
const now = Date.parse("2026-07-18T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function runtimeProject() {
  const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-runtime-"));
  temporaryDirectories.push(root);
  const paths = projectPaths(root);
  await initializeProject(paths);
  const engine = await createEngine(paths);
  const state = await engine.createRun({
    id: "runtime-large",
    requirement: "Inspect runtime pressure",
    projectType: "existing",
    hasUi: false
  });
  state.workers["worker-terminal"] = {
    id: "worker-terminal",
    taskId: "task-terminal",
    adapter: "codex-native-v2",
    adapterVersion: "2",
    hostTaskName: "bounded-worker",
    promptHash: "a".repeat(64),
    status: "completed",
    capabilities: {
      spawn: true,
      send: true,
      status: true,
      collect: true,
      interrupt: true,
      close: true
    },
    contextPolicy: {
      mode: "fresh-attested",
      inheritedTurnCount: 0,
      promptBytes: 1_024,
      agentflowMcpEnabled: false
    },
    cleanup: {
      resultCollectedAt: "2026-07-18T06:00:00.000Z",
      close: { status: "pending" },
      archive: { status: "unsupported", reason: "host capability unavailable" },
      permitRelease: { status: "completed", at: "2026-07-18T06:00:01.000Z" }
    },
    createdAt: "2026-07-18T05:00:00.000Z",
    updatedAt: "2026-07-18T06:00:00.000Z"
  };
  for (let index = 0; index < 30; index += 1) {
    const id = `artifact-${String(index).padStart(2, "0")}-${"x".repeat(145)}`;
    state.artifacts[id] = {
      id,
      stageId: "S00",
      kind: "diagnostic-fixture",
      uri: `.agentflow/artifacts/${index}.json`,
      sha256: "b".repeat(64),
      producedBy: "worker-terminal",
      stale: false,
      metadata: {},
      createdAt: "2026-07-18T06:00:00.000Z",
      updatedAt: "2026-07-18T06:00:00.000Z"
    };
  }
  state.events.push({
    id: "event-response-budget",
    type: "diagnostic.response",
    actorId: "system",
    actorKind: "system",
    at: "2026-07-18T06:00:00.000Z",
    data: {
      responseProfile: "summary",
      responseBytes: 9_001,
      token: "npm_secret_should_never_escape"
    }
  });
  await writeFile(
    join(paths.runsDirectory, state.id, "state.json"),
    `${JSON.stringify(state)}\n`
  );

  const small = await engine.createRun({
    id: "runtime-small",
    requirement: "Small state",
    projectType: "existing",
    hasUi: false
  });
  return { root, paths, large: state, small };
}

function nonConformingSnapshot(): NativeCapabilitySnapshot {
  return {
    version: 2,
    sourceVersion: 2,
    host: "codex",
    adapterVersion: "2.0.0",
    conformance: "non-conforming",
    fallback: "inline",
    contextPolicy: { mode: "fresh-attested", inheritedTurnCountObservable: true },
    toolProfile: {
      mode: "allowlist",
      enforced: true,
      tools: ["read_file", "apply_patch", "run_tests"],
      agentflowMcpEnabled: false
    },
    operations: {
      spawnFresh: "supported",
      bind: "supported",
      send: "supported",
      status: "supported",
      waitAny: "supported",
      collect: "supported",
      interrupt: "supported",
      close: "unsupported",
      archive: "unsupported"
    },
    reasons: ["credential=super_secret_adapter_reason"]
  };
}

function conformingSnapshot(): NativeCapabilitySnapshot {
  const snapshot = nonConformingSnapshot();
  return {
    ...snapshot,
    conformance: "conforming",
    fallback: "none",
    operations: { ...snapshot.operations, close: "supported", archive: "supported" },
    reasons: []
  };
}

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

describe("doctor runtime diagnostics", () => {
  it("reports bounded process, Run, budget, scheduler, cleanup, and live adapter aggregates", async () => {
    const { root } = await runtimeProject();
    const report = await collectDoctorRuntimeDiagnostics({
      projectRoot: root,
      agentflowHome: join(root, ".agentflow-home"),
      host: "codex",
      nativeCapabilitySnapshot: nonConformingSnapshot(),
      now: () => now,
      dependencies: {
        processProbe: async () => ({
          supported: true,
          samples: [
            {
              workingSetBytes: 1_000,
              startedAt: "2026-07-18T07:55:00.000Z",
              commandLine: "node agentflow-mcp.mjs --token process_secret"
            },
            {
              workingSetBytes: 2_000,
              startedAt: "2026-07-18T05:00:00.000Z",
              environment: { NPM_TOKEN: "environment_secret" }
            }
          ]
        }),
        schedulerProbe: async () => ({
          capacity: 1,
          activePermitCount: 1,
          expiredPermitCount: 0,
          circuit: {
            state: "open",
            cooldownRemainingMs: 30_000,
            retryAt: "2026-07-18T08:00:30.000Z"
          }
        })
      }
    });

    expect(report.processes).toEqual({
      status: "available",
      count: 2,
      workingSetSampleCount: 2,
      aggregateWorkingSetBytes: 3_000,
      staleCandidateCount: 1,
      oldestAgeMs: 10_800_000
    });
    expect(report.runs.scanned).toBe(2);
    expect(report.runs.largest[0]).toMatchObject({ stateBytes: expect.any(Number) });
    expect(report.runs.largest[0]?.runHash).toMatch(/^[a-f0-9]{12}$/);
    expect(report.responseBudgets).toMatchObject({
      statusLimitBytes: 8_192,
      mutationLimitBytes: 4_096,
      violationCount: 2
    });
    expect(report.responseBudgets.violations.map((item) => item.profile).sort())
      .toEqual(["receipt", "summary"]);
    expect(report.cleanup).toMatchObject({
      pendingWorkers: 1,
      unsupportedWorkers: 1,
      failedWorkers: 0
    });
    expect(report.scheduler).toMatchObject({
      status: "available",
      capacity: 1,
      activePermitCount: 1,
      cooldownState: "open",
      cooldownRemainingMs: 30_000
    });
    expect(report.nativeAdapter).toEqual({
      liveProbeProvided: true,
      host: "codex",
      adapterVersion: "2.0.0",
      conformance: "non-conforming",
      fallback: "inline",
      freshContextAttested: true,
      toolAllowlistEnforced: true,
      agentflowMcpDisabled: true,
      reasonCount: 1
    });

    const serialized = JSON.stringify(report);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8_192);
    expect(serialized).not.toMatch(/process_secret|environment_secret|adapter_reason|npm_secret|NPM_TOKEN/i);
    expect(serialized).not.toMatch(/commandLine|environment/i);
  });

  it("uses fixed argument-array probes on Windows and POSIX without returning command lines", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const windowsRunner: DoctorProcessCommandRunner = async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: JSON.stringify([{
          workingSetBytes: 4_096,
          startedAt: "2026-07-18T07:00:00.000Z"
        }])
      };
    };
    const windows = await probeAgentFlowMcpProcesses({
      platform: "win32",
      runner: windowsRunner
    });

    expect(calls[0]?.file).toBe("powershell.exe");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive"]);
    expect(windows).toEqual({
      supported: true,
      samples: [{ workingSetBytes: 4_096, startedAt: "2026-07-18T07:00:00.000Z" }]
    });

    const posixRunner: DoctorProcessCommandRunner = async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: [
          "7200 2048 node /home/user/.agentflow/bin/agentflow-mcp.mjs --token raw_secret",
          "30 1024 node unrelated.js"
        ].join("\n")
      };
    };
    const posix = await probeAgentFlowMcpProcesses({ platform: "linux", runner: posixRunner });

    expect(calls[1]).toEqual({ file: "ps", args: ["-eo", "etimes=,rss=,args="] });
    expect(posix).toEqual({
      supported: true,
      samples: [{ workingSetBytes: 2_097_152, ageMs: 7_200_000 }]
    });
    expect(JSON.stringify(posix)).not.toContain("raw_secret");
  });

  it("turns a denied process query into a sanitized unavailable result", async () => {
    const result = await probeAgentFlowMcpProcesses({
      platform: "win32",
      runner: async () => {
        throw new Error("CommandLine contained --token denied_probe_secret");
      }
    });

    expect(result).toEqual({ supported: false, samples: [] });
    expect(JSON.stringify(result)).not.toContain("denied_probe_secret");
  });

  it("degrades to explicit unavailable summaries without exposing probe errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-runtime-empty-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".agentflow", "runs"), { recursive: true });
    const report = await collectDoctorRuntimeDiagnostics({
      projectRoot: root,
      agentflowHome: join(root, ".agentflow-home"),
      host: "vscode",
      dependencies: {
        processProbe: async () => {
          throw new Error("token=probe_failure_secret");
        },
        schedulerProbe: async () => {
          throw new Error("authorization=scheduler_failure_secret");
        }
      }
    });

    expect(report.processes).toEqual({
      status: "unavailable",
      count: 0,
      workingSetSampleCount: 0,
      staleCandidateCount: 0
    });
    expect(report.scheduler).toEqual({ status: "unavailable" });
    expect(report.nativeAdapter).toEqual({ liveProbeProvided: false, host: "vscode" });
    expect(JSON.stringify(report)).not.toMatch(/probe_failure_secret|scheduler_failure_secret|authorization/i);
  });

  it("keeps static Worker profile health separate from live native adapter conformance", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-doctor-runtime-integration-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
    const globalPathEnvironment: GlobalPathEnvironment = {
      platform: process.platform,
      home,
      appData: join(home, "AppData", "Roaming"),
      xdgConfigHome: join(home, ".config"),
      agentflowHome: join(home, ".agentflow"),
      codexHome: join(home, ".codex")
    };
    await executeSetup({
      projectRoot,
      scope: "global",
      hosts: ["codex"],
      assets: await setupAssets(root),
      skipExternalSkills: true
    }, { globalPathEnvironment });
    const runtimeDependencies = {
      processProbe: async () => ({ supported: true, samples: [] }),
      schedulerProbe: async () => ({
        capacity: 1,
        activePermitCount: 0,
        expiredPermitCount: 0,
        circuit: { state: "closed" as const, cooldownRemainingMs: 0 }
      })
    };

    const live = await runDoctor({
      paths: projectPaths(projectRoot),
      scope: "global",
      host: "codex",
      globalPathEnvironment,
      nativeCapabilitySnapshot: conformingSnapshot(),
      runtimeDependencies
    });
    expect(live.installation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "worker-profile", status: "ok" }),
      expect.objectContaining({ id: "native-adapter-live", status: "ok" })
    ]));
    expect(live.runtime.nativeAdapter).toMatchObject({
      liveProbeProvided: true,
      conformance: "conforming"
    });
    expect(live.skillPolicy).toEqual({ status: "legacy", activePolicyCount: 0 });

    const staticOnly = await runDoctor({
      paths: projectPaths(projectRoot),
      scope: "global",
      host: "codex",
      globalPathEnvironment,
      runtimeDependencies
    });
    expect(staticOnly.installation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "worker-profile", status: "ok" }),
      expect.objectContaining({ id: "native-adapter-live", status: "warn" })
    ]));
    expect(staticOnly.runtime.nativeAdapter).toEqual({
      liveProbeProvided: false,
      host: "codex"
    });
  });

  it("loads a bounded adapter snapshot from a file and rejects secret-shaped invalid input", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-adapter-snapshot-"));
    temporaryDirectories.push(root);
    const validPath = join(root, "valid.json");
    const invalidPath = join(root, "invalid.json");
    await Promise.all([
      writeFile(validPath, JSON.stringify(conformingSnapshot())),
      writeFile(invalidPath, JSON.stringify({ token: "must_not_escape", operations: [] }))
    ]);

    await expect(readNativeCapabilitySnapshotFile(validPath)).resolves.toMatchObject({
      host: "codex",
      conformance: "conforming"
    });
    const invalid = await readNativeCapabilitySnapshotFile(invalidPath).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "NATIVE_CAPABILITY_SNAPSHOT_INVALID" });
    expect(JSON.stringify(invalid)).not.toContain("must_not_escape");
  });

  it("rejects a snapshot that claims conformance while enabling AgentFlow MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-adapter-inconsistent-"));
    temporaryDirectories.push(root);
    const inconsistent: NativeCapabilitySnapshot = {
      ...conformingSnapshot(),
      toolProfile: {
        ...conformingSnapshot().toolProfile,
        agentflowMcpEnabled: true
      }
    };
    const report = await collectDoctorRuntimeDiagnostics({
      projectRoot: root,
      agentflowHome: join(root, ".agentflow-home"),
      host: "codex",
      nativeCapabilitySnapshot: inconsistent,
      dependencies: {
        processProbe: async () => ({ supported: false, samples: [] }),
        schedulerProbe: async () => undefined
      }
    });

    expect(report.nativeAdapter).toEqual({
      liveProbeProvided: true,
      host: "codex",
      invalid: true
    });
  });
});
