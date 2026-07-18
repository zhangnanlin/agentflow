import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostBudgetCoordinator,
  type NativeCleanupReceipt,
  type NativeHostClient,
  type NativeHostProbe,
  type NativeSpawnRequest,
  type NativeWorkerProtocolV2,
  type SpawnWorkerInput,
  type WorkerResult
} from "../src/index.js";

const hash = "a".repeat(64);

export class FakeNativeHost implements NativeHostClient {
  readonly spawnFresh = vi.fn(async (request: NativeSpawnRequest) => ({
    nativeId: `${this.host}-native-${request.workerId}`,
    inheritedTurnCount: 0
  }));
  readonly inspect = vi.fn(async (nativeId: string) => ({
    status: this.statuses.get(nativeId) ?? "running" as const,
    result: this.results.get(nativeId)
  }));
  readonly waitAny = vi.fn(async (nativeIds: string[]) => {
    const nativeId = nativeIds[0]!;
    return {
      nativeId,
      status: this.statuses.get(nativeId) ?? "running" as const
    };
  });
  readonly send = vi.fn(async () => undefined);
  readonly interrupt = vi.fn(async (nativeId: string) => {
    this.statuses.set(nativeId, "interrupted");
  });
  readonly close = vi.fn(async () => undefined);
  readonly archive = vi.fn(async () => undefined);
  readonly statuses = new Map<string, "running" | "completed" | "blocked" | "failed" | "interrupted">();
  readonly results = new Map<string, WorkerResult>();

  constructor(
    readonly host: "codex" | "cursor" | "vscode",
    private readonly archiveSupported: boolean
  ) {
    if (!archiveSupported) this.archive = undefined as never;
  }

  probe = vi.fn(async (): Promise<NativeHostProbe> => ({
    adapterVersion: "2.0.0",
    contextPolicy: {
      mode: "fresh-attested",
      inheritedTurnCountObservable: true
    },
    toolProfile: {
      mode: "allowlist",
      enforced: true,
      tools: ["read_file", "apply_patch", "run_tests"],
      agentflowMcpEnabled: false
    }
  }));

  complete(workerId: string, taskId = "task-1"): void {
    const nativeId = `${this.host}-native-${workerId}`;
    this.statuses.set(nativeId, "completed");
    this.results.set(nativeId, workerResult(workerId, taskId));
  }
}

export type NativeAdapterFactory = (
  host: FakeNativeHost,
  budget: HostBudgetCoordinator
) => NativeWorkerProtocolV2;

export function nativeAdapterConformance(
  hostId: "codex" | "cursor" | "vscode",
  archiveSupported: boolean,
  factory: NativeAdapterFactory
): void {
  describe(`${hostId} NativeWorkerProtocol v2 conformance`, () => {
    let home: string;
    let host: FakeNativeHost;
    let budget: HostBudgetCoordinator;
    let adapter: NativeWorkerProtocolV2;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), `agentflow-${hostId}-native-`));
      host = new FakeNativeHost(hostId, archiveSupported);
      budget = new HostBudgetCoordinator({ homeDirectory: home, host: hostId });
      adapter = factory(host, budget);
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("attests fresh context, bounded tools, and provider-neutral operations", async () => {
      const probe = await adapter.probe();
      expect(probe).toMatchObject({
        version: 2,
        host: hostId,
        conformance: "conforming",
        contextPolicy: { mode: "fresh-attested" },
        toolProfile: { mode: "allowlist", enforced: true, agentflowMcpEnabled: false },
        operations: {
          spawnFresh: "supported",
          bind: "supported",
          status: "supported",
          waitAny: "supported",
          collect: "supported",
          interrupt: "supported",
          close: "supported",
          archive: archiveSupported ? "supported" : "unsupported"
        }
      });
      expect(probe.toolProfile.tools.join(" ").toLowerCase()).not.toContain("agentflow");
    });

    it("spawns once with zero inherited turns and a bounded isolated envelope", async () => {
      const first = await adapter.spawnFresh(spawnInput());
      expect(first).toMatchObject({
        status: "spawned",
        reused: false,
        handle: {
          host: hostId,
          adapterVersion: "2.0.0",
          workerId: "worker-1",
          taskId: "task-1",
          promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          promptBytes: expect.any(Number),
          contextPolicy: { mode: "fresh-attested", inheritedTurnCount: 0 },
          toolProfile: { agentflowMcpEnabled: false },
          capabilities: {
            spawnFresh: "supported",
            waitAny: "supported",
            close: "supported",
            archive: archiveSupported ? "supported" : "unsupported"
          }
        }
      });
      if (first.status !== "spawned") throw new Error("Expected a native spawn");
      expect(first.handle.promptBytes).toBeLessThanOrEqual(16_384);
      expect(host.spawnFresh).toHaveBeenCalledTimes(1);
      expect(host.spawnFresh.mock.calls[0]?.[0]).toMatchObject({
        freshContext: true,
        inheritConversation: false,
        toolProfile: { agentflowMcpEnabled: false }
      });
      expect(host.spawnFresh.mock.calls[0]?.[0].prompt).not.toContain("Supervisor transcript");
      expect(host.spawnFresh.mock.calls[0]?.[0].prompt).not.toContain("AgentFlow automatic routing");
      expect(host.spawnFresh.mock.calls[0]?.[0].prompt).not.toContain("pipelineId");

      const replay = await adapter.spawnFresh(spawnInput());
      expect(replay).toMatchObject({ status: "spawned", reused: true });
      expect(host.spawnFresh).toHaveBeenCalledTimes(1);
      await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 1 });
    });

    it("waits for any worker once, collects one transcript-free capsule, then cleans up in order", async () => {
      const spawned = await adapter.spawnFresh(spawnInput());
      if (spawned.status !== "spawned") throw new Error("Expected a native spawn");
      host.complete("worker-1");

      await expect(adapter.waitAny(["worker-1"])).resolves.toMatchObject({
        workerId: "worker-1",
        status: "completed"
      });
      expect(host.waitAny).toHaveBeenCalledTimes(1);
      const capsule = await adapter.collect("worker-1");
      expect(capsule).toMatchObject({ workerId: "worker-1", taskId: "task-1", status: "completed" });
      expect(JSON.stringify(capsule).toLowerCase()).not.toContain("transcript");
      expect(Buffer.byteLength(JSON.stringify(capsule), "utf8")).toBeLessThanOrEqual(16_384);

      await expect(adapter.cleanup("worker-1", { supervisorNativeId: "supervisor-native" }))
        .rejects.toMatchObject({ code: "RESULT_NOT_PERSISTED" });
      expect(host.close).not.toHaveBeenCalled();
      adapter.confirmDurableTerminal("worker-1", "result");
      await expect(adapter.cleanup("worker-1", { supervisorNativeId: spawned.handle.nativeId }))
        .rejects.toMatchObject({ code: "SUPERVISOR_TASK_PROTECTED" });

      const cleaned = await adapter.cleanup("worker-1", { supervisorNativeId: "supervisor-native" });
      expect(cleaned).toMatchObject({
        adapterVersion: "2.0.0",
        workerId: "worker-1",
        resultCollectedAt: expect.any(String),
        durableAt: expect.any(String),
        close: { status: "completed" },
        archive: { status: archiveSupported ? "completed" : "unsupported" },
        permitRelease: { status: "completed" },
        completedAt: expect.any(String),
        completed: true
      } satisfies Partial<NativeCleanupReceipt>);
      expect(host.close).toHaveBeenCalledTimes(1);
      if (archiveSupported) expect(host.archive).toHaveBeenCalledTimes(1);
      else expect(host.archive).toBeUndefined();
      await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 0 });

      await adapter.cleanup("worker-1", { supervisorNativeId: "supervisor-native" });
      expect(host.close).toHaveBeenCalledTimes(1);
      if (archiveSupported) expect(host.archive).toHaveBeenCalledTimes(1);
    });

    it("confirms interruption without fabricating a Worker result", async () => {
      await adapter.spawnFresh(spawnInput());
      await adapter.interrupt("worker-1", "Stop requested by Supervisor");
      expect(host.interrupt).toHaveBeenCalledTimes(1);
      adapter.confirmDurableTerminal("worker-1", "interruption");
      await expect(adapter.cleanup("worker-1", { supervisorNativeId: "supervisor-native" }))
        .resolves.toMatchObject({ completed: true });
    });

    it("steers only the bound native child task", async () => {
      const spawned = await adapter.spawnFresh(spawnInput());
      if (spawned.status !== "spawned") throw new Error("Expected a native spawn");
      await adapter.send("worker-1", {
        kind: "correction",
        body: "Use the frozen API contract.",
        data: {}
      });

      expect(host.send).toHaveBeenCalledTimes(1);
      expect(host.send.mock.calls[0]?.[0]).toBe(spawned.handle.nativeId);
      expect(host.send.mock.calls[0]?.[1]).toContain("frozen API contract");
    });

    it("restores a persisted binding without spawning a duplicate", async () => {
      const spawned = await adapter.spawnFresh(spawnInput());
      if (spawned.status !== "spawned") throw new Error("Expected a native spawn");
      const restored = factory(host, budget);
      restored.bind(adapter.snapshotHandles()[0]!);

      await expect(restored.status("worker-1")).resolves.toBe("running");
      await expect(restored.spawnFresh(spawnInput())).resolves.toMatchObject({
        status: "spawned",
        reused: true
      });
      expect(host.spawnFresh).toHaveBeenCalledTimes(1);
    });

    it("leaves cleanup pending after a host failure and resumes idempotently", async () => {
      await adapter.spawnFresh(spawnInput());
      host.complete("worker-1");
      await adapter.collect("worker-1");
      adapter.confirmDurableTerminal("worker-1", "result");
      host.close.mockRejectedValueOnce(new Error("native close token=verysecretvalue"));

      const failed = await adapter.cleanup("worker-1", { supervisorNativeId: "supervisor-native" });
      expect(failed).toMatchObject({ close: { status: "failed" }, completed: false });
      expect(JSON.stringify(failed)).not.toContain("verysecretvalue");
      if (archiveSupported) expect(host.archive).toHaveBeenCalledTimes(0);
      else expect(host.archive).toBeUndefined();
      await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 1 });

      await expect(adapter.cleanup("worker-1", { supervisorNativeId: "supervisor-native" }))
        .resolves.toMatchObject({ completed: true });
      expect(host.close).toHaveBeenCalledTimes(2);
      await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 0 });
    });
  });
}

export function spawnInput(overrides: Partial<SpawnWorkerInput> = {}): SpawnWorkerInput {
  return {
    runId: "run-1",
    taskId: "task-1",
    workerId: "worker-1",
    taskName: "implement_api",
    profile: "backend",
    prompt: {
      objective: "Implement the approved API contract.",
      context: [],
      inputArtifacts: [{ id: "prd-1", kind: "prd", sha256: hash, uri: "prd.json" }],
      inputArtifactHashes: { "prd-1": hash },
      inputArtifactKinds: { "prd-1": "prd" },
      componentIds: ["api"],
      requirementIds: ["fr-1"],
      allowedPaths: ["packages/api/**"],
      forbiddenPaths: [".agentflow/**", ".env"],
      acceptanceCriteria: ["The approved API behavior is implemented"],
      verificationCommands: ["npm test -- packages/api"],
      expectedOutputs: ["API implementation and tests"],
      requiresWorktree: false,
      workspace: { kind: "project", path: resolve(".") },
      resultSchema: "{ workerId, taskId, status, summary, artifacts, changeSet, verification, risks, followUps, completedAt }"
    },
    ...overrides
  };
}

export function workerResult(workerId = "worker-1", taskId = "task-1"): WorkerResult {
  return {
    workerId,
    taskId,
    status: "completed",
    summary: "Implemented and tested the API.",
    artifacts: [],
    changeSet: null,
    verification: [{
      command: "npm test -- packages/api",
      status: "passed",
      summary: "12 tests passed",
      recordedAt: new Date().toISOString()
    }],
    risks: [],
    followUps: [],
    completedAt: new Date().toISOString()
  };
}
