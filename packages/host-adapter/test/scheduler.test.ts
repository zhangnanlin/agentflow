import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostBudgetCoordinator,
  schedulerBudgetKey,
  type PermitAcquireResult
} from "../src/index.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
const startTime = Date.parse("2026-07-18T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("host budget permits", () => {
  it("defaults to one model Worker, avoids nested permits, and bypasses deterministic work", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-permit-");
    const coordinator = new HostBudgetCoordinator({
      homeDirectory,
      host: "codex",
      profile: "default",
      now: () => startTime
    });

    const bypassed = await coordinator.acquire({
      ownerId: "supervisor",
      requestId: "git-readback",
      taskId: "task-git",
      operationKind: "deterministic"
    });
    expect(bypassed).toEqual({ status: "bypassed", reason: "deterministic-operation" });

    const first = await coordinator.acquire({
      ownerId: "worker-a",
      requestId: "spawn-a",
      taskId: "task-a",
      operationKind: "model-worker"
    });
    expect(first).toMatchObject({ status: "acquired", reused: false });

    const retry = await coordinator.acquire({
      ownerId: "worker-a",
      requestId: "spawn-a",
      taskId: "task-a",
      operationKind: "model-worker"
    });
    expect(retry).toMatchObject({ status: "acquired", reused: true });
    expect(acquiredPermitId(retry)).toBe(acquiredPermitId(first));

    await expect(coordinator.acquire({
      ownerId: "worker-a",
      requestId: "spawn-a-nested",
      taskId: "task-a-nested",
      operationKind: "model-worker"
    })).resolves.toMatchObject({ status: "blocked", reason: "owner-active" });
    await expect(coordinator.acquire({
      ownerId: "worker-b",
      requestId: "spawn-b",
      taskId: "task-b",
      operationKind: "model-worker"
    })).resolves.toMatchObject({ status: "blocked", reason: "capacity" });

    const diagnostics = await coordinator.diagnostics();
    expect(diagnostics).toMatchObject({ capacity: 1, activePermitCount: 1, expiredPermitCount: 0 });
    expect(diagnostics.metrics).toEqual(expect.arrayContaining([
      { name: "scheduler.active_permits", unit: "count", value: 1 },
      { name: "scheduler.bypassed_operations", unit: "count", value: 1 }
    ]));
  });

  it("allows only one final permit across concurrent processes", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-process-");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => acquireInChild({
      homeDirectory,
      host: "codex",
      profile: "process-race",
      ownerId: `worker-${index}`,
      requestId: `request-${index}`,
      taskId: `task-${index}`
    })));

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "blocked")).toHaveLength(7);

    const coordinator = new HostBudgetCoordinator({ homeDirectory, host: "codex", profile: "process-race" });
    await expect(coordinator.diagnostics()).resolves.toMatchObject({ activePermitCount: 1 });
  });

  it("reclaims one stale lock without deleting a competing replacement lock", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-stale-lock-");
    const key = schedulerBudgetKey({ host: "codex", profile: "stale-lock-race" });
    const lockDirectory = join(homeDirectory, "scheduler", key, ".lock");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({ token: "stale", pid: 1 }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, old, old);

    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => acquireInChild({
      homeDirectory,
      host: "codex",
      profile: "stale-lock-race",
      ownerId: `stale-worker-${index}`,
      requestId: `stale-request-${index}`,
      taskId: `stale-task-${index}`,
      staleLockMs: 10
    })));

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "blocked")).toHaveLength(5);
  });

  it("requires confirmed expiry recovery and supports heartbeat plus idempotent release", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-expiry-");
    let now = startTime;
    const coordinator = new HostBudgetCoordinator({
      homeDirectory,
      host: "codex",
      profile: "expiry",
      defaultLeaseSeconds: 10,
      now: () => now
    });
    const first = await coordinator.acquire({
      ownerId: "worker-expired",
      requestId: "request-expired",
      taskId: "task-expired",
      operationKind: "model-worker"
    });
    const permitId = acquiredPermitId(first);

    now += 5_000;
    const heartbeat = await coordinator.heartbeat({ permitId, ownerId: "worker-expired", leaseSeconds: 20 });
    expect(Date.parse(heartbeat.expiresAt)).toBe(now + 20_000);
    now += 21_000;

    await expect(coordinator.acquire({
      ownerId: "worker-new",
      requestId: "request-new",
      taskId: "task-new",
      operationKind: "model-worker"
    })).resolves.toMatchObject({ status: "blocked", reason: "expired-unconfirmed" });
    await expect(coordinator.confirmExpired({
      permitId,
      confirmedBy: "supervisor",
      confirmation: "process-exited"
    })).resolves.toMatchObject({ reclaimed: true });

    const replacement = await coordinator.acquire({
      ownerId: "worker-new",
      requestId: "request-new",
      taskId: "task-new",
      operationKind: "model-worker"
    });
    const replacementId = acquiredPermitId(replacement);
    await expect(coordinator.release({ permitId: replacementId, ownerId: "worker-new" }))
      .resolves.toEqual({ released: true, alreadyReleased: false });
    await expect(coordinator.release({ permitId: replacementId, ownerId: "worker-new" }))
      .resolves.toEqual({ released: false, alreadyReleased: true });
  });

  it("keeps diagnostics bounded at maximum configured capacity", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-large-diagnostics-");
    const coordinator = new HostBudgetCoordinator({
      homeDirectory,
      host: "vscode",
      profile: "large-diagnostics",
      capacity: 32,
      now: () => startTime
    });
    for (let index = 0; index < 32; index += 1) {
      await coordinator.acquire({
        ownerId: `worker-large-${index}`,
        requestId: `request-large-${index}`,
        taskId: `task-large-${index}`,
        operationKind: "model-worker"
      });
    }

    const diagnostics = await coordinator.diagnostics();
    expect(diagnostics).toMatchObject({ activePermitCount: 32, permitOverflow: 26 });
    expect(diagnostics.permits).toHaveLength(6);
    expect(Buffer.byteLength(JSON.stringify(diagnostics), "utf8")).toBeLessThanOrEqual(4_096);
  });
});

describe("persisted 429 circuit", () => {
  it("honors Retry-After, permits one recovery probe, and closes after success", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-rate-");
    let now = startTime;
    const options = {
      homeDirectory,
      host: "codex",
      profile: "rate-limit",
      now: () => now,
      random: () => 0.5
    };
    const coordinator = new HostBudgetCoordinator(options);
    const first = await coordinator.acquire({
      ownerId: "worker-rate",
      requestId: "request-rate",
      taskId: "task-rate",
      operationKind: "model-worker"
    });
    const firstPermitId = acquiredPermitId(first);
    const circuit = await coordinator.recordRateLimit({
      permitId: firstPermitId,
      ownerId: "worker-rate",
      classification: "provider",
      provider: "provider-account-sensitive",
      retryAfter: "30"
    });
    expect(circuit).toMatchObject({ state: "open", attempt: 1 });
    expect(Date.parse(circuit.retryAt)).toBe(now + 30_000);

    const recoveredProcess = new HostBudgetCoordinator(options);
    await expect(recoveredProcess.acquire({
      ownerId: "worker-blocked",
      requestId: "request-blocked",
      taskId: "task-blocked",
      operationKind: "model-worker"
    })).resolves.toMatchObject({ status: "blocked", reason: "cooldown", retryAt: circuit.retryAt });

    now += 30_000;
    const [left, right] = await Promise.all([
      coordinator.acquire({
        ownerId: "worker-probe-left",
        requestId: "request-probe-left",
        taskId: "task-probe-left",
        operationKind: "model-worker"
      }),
      recoveredProcess.acquire({
        ownerId: "worker-probe-right",
        requestId: "request-probe-right",
        taskId: "task-probe-right",
        operationKind: "model-worker"
      })
    ]);
    const probe = [left, right].find((result) => result.status === "acquired");
    const blocked = [left, right].find((result) => result.status === "blocked");
    expect(probe).toMatchObject({ status: "acquired" });
    expect(blocked).toMatchObject({ status: "blocked", reason: "recovery-probe" });

    const probePermitId = acquiredPermitId(probe as PermitAcquireResult);
    const probeOwner = probe === left ? "worker-probe-left" : "worker-probe-right";
    await expect(coordinator.recordSuccess({ permitId: probePermitId, ownerId: probeOwner }))
      .resolves.toMatchObject({ state: "closed", attempt: 0 });
    await coordinator.release({ permitId: probePermitId, ownerId: probeOwner });
  });

  it("uses bounded exponential backoff with deterministic jitter when Retry-After is absent", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-backoff-");
    let now = startTime;
    const coordinator = new HostBudgetCoordinator({
      homeDirectory,
      host: "cursor",
      profile: "backoff",
      now: () => now,
      random: () => 0.5,
      backoffBaseMs: 1_000,
      backoffMaxMs: 8_000
    });
    const first = await coordinator.acquire({
      ownerId: "worker-backoff-1",
      requestId: "request-backoff-1",
      taskId: "task-backoff-1",
      operationKind: "model-worker"
    });
    const firstCircuit = await coordinator.recordRateLimit({
      permitId: acquiredPermitId(first),
      ownerId: "worker-backoff-1",
      classification: "generic"
    });
    expect(Date.parse(firstCircuit.retryAt) - now).toBe(1_000);

    now = Date.parse(firstCircuit.retryAt);
    const probe = await coordinator.acquire({
      ownerId: "worker-backoff-2",
      requestId: "request-backoff-2",
      taskId: "task-backoff-2",
      operationKind: "model-worker"
    });
    const secondCircuit = await coordinator.recordRateLimit({
      permitId: acquiredPermitId(probe),
      ownerId: "worker-backoff-2",
      classification: "generic"
    });
    expect(secondCircuit.attempt).toBe(2);
    expect(Date.parse(secondCircuit.retryAt) - now).toBe(2_000);
  });

  it("stores only hashed identities and returns bounded stable diagnostics", async () => {
    const homeDirectory = await temporaryHome("agentflow-scheduler-redaction-");
    const secrets = [
      "host-token-very-secret",
      "profile-sk-live-secret",
      "owner-otp-123456",
      "request-bearer-secret",
      "task-password-secret",
      "provider-account-sensitive"
    ];
    const coordinator = new HostBudgetCoordinator({
      homeDirectory,
      host: secrets[0] ?? "host",
      profile: secrets[1] ?? "profile",
      now: () => startTime,
      random: () => 0.5
    });
    const acquired = await coordinator.acquire({
      ownerId: secrets[2] ?? "owner",
      requestId: secrets[3] ?? "request",
      taskId: secrets[4] ?? "task",
      operationKind: "model-worker"
    });
    await coordinator.recordRateLimit({
      permitId: acquiredPermitId(acquired),
      ownerId: secrets[2] ?? "owner",
      classification: "provider",
      provider: secrets[5],
      retryAfter: 15
    });

    const schedulerRoot = join(homeDirectory, "scheduler");
    const persisted = await readTree(schedulerRoot);
    const diagnostics = await coordinator.diagnostics();
    const serializedDiagnostics = JSON.stringify(diagnostics);
    for (const secret of secrets) {
      expect(persisted).not.toContain(secret);
      expect(serializedDiagnostics).not.toContain(secret);
    }
    expect(Buffer.byteLength(serializedDiagnostics, "utf8")).toBeLessThanOrEqual(4_096);
    expect(diagnostics.metrics.every((metric) => metric.name.startsWith("scheduler."))).toBe(true);
    expect(diagnostics.metrics.every((metric) => ["count", "milliseconds"].includes(metric.unit))).toBe(true);
  });
});

function acquiredPermitId(result: PermitAcquireResult): string {
  if (result.status !== "acquired") throw new Error(`Expected an acquired permit, got ${result.status}`);
  return result.permit.id;
}

async function acquireInChild(input: {
  homeDirectory: string;
  host: string;
  profile: string;
  ownerId: string;
  requestId: string;
  taskId: string;
  staleLockMs?: number;
}): Promise<PermitAcquireResult> {
  const schedulerUrl = pathToFileURL(resolve("packages/host-adapter/src/scheduler.ts")).href;
  const script = [
    `import { HostBudgetCoordinator } from ${JSON.stringify(schedulerUrl)};`,
    `const input = ${JSON.stringify(input)};`,
    "const coordinator = new HostBudgetCoordinator({",
    "  homeDirectory: input.homeDirectory,",
    "  host: input.host,",
    "  profile: input.profile,",
    "  staleLockMs: input.staleLockMs",
    "});",
    "const result = await coordinator.acquire({",
    "  ownerId: input.ownerId,",
    "  requestId: input.requestId,",
    "  taskId: input.taskId,",
    "  operationKind: 'model-worker'",
    "});",
    "console.log(JSON.stringify(result));"
  ].join("\n");
  const { stdout } = await execFile(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    script
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
  return JSON.parse(stdout.trim()) as PermitAcquireResult;
}

async function readTree(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) parts.push(await readTree(path));
    else parts.push(await readFile(path, "utf8"));
  }
  return parts.join("\n");
}
