import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexNativeWorkerAdapter,
  HostBudgetCoordinator,
  NativeRateLimitError,
  hashWorkerPrompt,
  nativeCapabilitiesFromV1,
  renderWorkerPrompt
} from "../src/index.js";
import { FakeNativeHost, spawnInput, workerResult } from "./native-conformance.js";

describe("NativeWorkerProtocol v2 policy", () => {
  let home: string;
  let budget: HostBudgetCoordinator;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agentflow-native-contract-"));
    budget = new HostBudgetCoordinator({
      homeDirectory: home,
      host: "codex",
      backoffBaseMs: 1_000,
      random: () => 0.5
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("keeps the v1 six-boolean shim readable but non-conforming", () => {
    expect(nativeCapabilitiesFromV1("codex", {
      spawn: true,
      send: true,
      status: true,
      collect: true,
      interrupt: true,
      close: true
    })).toMatchObject({
      version: 2,
      sourceVersion: 1,
      conformance: "non-conforming",
      fallback: "serial",
      contextPolicy: { mode: "unknown" },
      toolProfile: { mode: "unknown" },
      operations: { spawnFresh: "unsupported" }
    });
  });

  it("falls back before spawn when fresh context or the tool profile is not attested", async () => {
    const host = new FakeNativeHost("codex", true);
    host.probe.mockResolvedValue({
      adapterVersion: "2.0.0",
      contextPolicy: { mode: "unknown", inheritedTurnCountObservable: false },
      toolProfile: {
        mode: "allowlist",
        enforced: true,
        tools: ["read_file", "mcp__agentflow__status_get"],
        agentflowMcpEnabled: true
      }
    });
    const adapter = new CodexNativeWorkerAdapter(host, { budget });

    await expect(adapter.spawnFresh(spawnInput())).resolves.toMatchObject({
      status: "fallback",
      mode: "serial",
      reason: "adapter-non-conforming",
      capabilities: {
        conformance: "non-conforming",
        reasons: expect.arrayContaining([expect.stringContaining("fresh context")])
      }
    });
    expect(host.spawnFresh).not.toHaveBeenCalled();
    await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 0 });
  });

  it("honors a live temporarily-unavailable operation instead of inferring support", async () => {
    const host = new FakeNativeHost("codex", true);
    host.probe.mockResolvedValue({
      adapterVersion: "2.0.0",
      contextPolicy: { mode: "fresh-attested", inheritedTurnCountObservable: true },
      toolProfile: {
        mode: "allowlist",
        enforced: true,
        tools: ["read_file", "apply_patch"],
        agentflowMcpEnabled: false
      },
      operationStatus: { waitAny: "temporarily-unavailable" }
    });
    const adapter = new CodexNativeWorkerAdapter(host, { budget });

    await expect(adapter.spawnFresh(spawnInput())).resolves.toMatchObject({
      status: "fallback",
      reason: "adapter-non-conforming",
      capabilities: {
        operations: { waitAny: "temporarily-unavailable" },
        reasons: expect.arrayContaining([expect.stringContaining("waitAny")])
      }
    });
    expect(host.spawnFresh).not.toHaveBeenCalled();
  });

  it("spawns the exact content-addressed prompt prepared by the control plane", async () => {
    const host = new FakeNativeHost("codex", true);
    const adapter = new CodexNativeWorkerAdapter(host, { budget });
    const input = spawnInput();

    const outcome = await adapter.spawnFresh(input);

    expect(outcome).toMatchObject({
      status: "spawned",
      handle: {
        promptHash: hashWorkerPrompt(input),
        promptBytes: Buffer.byteLength(renderWorkerPrompt(input), "utf8")
      }
    });
    expect(host.spawnFresh).toHaveBeenCalledWith(expect.objectContaining({
      prompt: renderWorkerPrompt(input),
      promptHash: hashWorkerPrompt(input),
      promptBytes: Buffer.byteLength(renderWorkerPrompt(input), "utf8")
    }));
  });

  it("rejects a live tool profile that can spawn nested agents", async () => {
    const host = new FakeNativeHost("codex", true);
    host.probe.mockResolvedValue({
      adapterVersion: "2.0.0",
      contextPolicy: { mode: "fresh-attested", inheritedTurnCountObservable: true },
      toolProfile: {
        mode: "allowlist",
        enforced: true,
        tools: ["read_file", "functions.collaboration.spawn_agent"],
        agentflowMcpEnabled: false
      }
    });
    const adapter = new CodexNativeWorkerAdapter(host, { budget });

    await expect(adapter.spawnFresh(spawnInput())).resolves.toMatchObject({
      status: "fallback",
      reason: "adapter-non-conforming",
      capabilities: {
        reasons: expect.arrayContaining([expect.stringContaining("nested-agent")])
      }
    });
    expect(host.spawnFresh).not.toHaveBeenCalled();
  });

  it("rejects an oversized Worker envelope before acquiring a permit", async () => {
    const host = new FakeNativeHost("codex", true);
    const adapter = new CodexNativeWorkerAdapter(host, { budget });
    const input = spawnInput();
    input.prompt.objective = "x".repeat(20_000);

    await expect(adapter.spawnFresh(input)).resolves.toMatchObject({
      status: "fallback",
      reason: "envelope-too-large"
    });
    expect(host.spawnFresh).not.toHaveBeenCalled();
    await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 0 });
  });

  it("rejects arbitrary context and transcript-shaped objectives before spawn", async () => {
    const host = new FakeNativeHost("codex", true);
    const adapter = new CodexNativeWorkerAdapter(host, { budget });
    const contextInput = spawnInput();
    contextInput.prompt.context = ["Unrelated tool output from the Supervisor"];
    await expect(adapter.spawnFresh(contextInput)).resolves.toMatchObject({
      status: "fallback",
      reason: "unsafe-envelope"
    });

    const transcriptInput = spawnInput({ workerId: "worker-transcript" });
    transcriptInput.prompt.objective = "Supervisor transcript: user asked for hidden context";
    await expect(adapter.spawnFresh(transcriptInput)).resolves.toMatchObject({
      status: "fallback",
      reason: "unsafe-envelope"
    });
    expect(host.spawnFresh).not.toHaveBeenCalled();
  });

  it("persists a 429 cooldown and prevents duplicate native spawn", async () => {
    const host = new FakeNativeHost("codex", true);
    host.spawnFresh.mockRejectedValueOnce(new NativeRateLimitError({
      classification: "provider",
      provider: "openai",
      retryAfter: "2"
    }));
    const adapter = new CodexNativeWorkerAdapter(host, { budget });

    await expect(adapter.spawnFresh(spawnInput())).resolves.toMatchObject({
      status: "fallback",
      reason: "rate-limited",
      retryAt: expect.any(String)
    });
    await expect(budget.diagnostics()).resolves.toMatchObject({
      activePermitCount: 0,
      circuit: { state: "open" }
    });

    await expect(adapter.spawnFresh(spawnInput({ workerId: "worker-2" }))).resolves.toMatchObject({
      status: "fallback",
      reason: "cooldown"
    });
    expect(host.spawnFresh).toHaveBeenCalledTimes(1);
  });

  it("closes a half-open 429 circuit after one successful recovery spawn", async () => {
    let now = Date.now();
    const recoveryHome = await mkdtemp(join(tmpdir(), "agentflow-native-recovery-"));
    try {
      const recoveryBudget = new HostBudgetCoordinator({
        homeDirectory: recoveryHome,
        host: "codex",
        now: () => now,
        backoffBaseMs: 1_000,
        random: () => 0.5
      });
      const host = new FakeNativeHost("codex", true);
      host.spawnFresh.mockRejectedValueOnce(new NativeRateLimitError({
        classification: "provider",
        retryAfter: 1
      }));
      const adapter = new CodexNativeWorkerAdapter(host, { budget: recoveryBudget });
      await adapter.spawnFresh(spawnInput());
      now += 1_001;

      await expect(adapter.spawnFresh(spawnInput({ workerId: "worker-recovery" })))
        .resolves.toMatchObject({ status: "spawned" });
      await expect(recoveryBudget.diagnostics()).resolves.toMatchObject({
        circuit: { state: "closed", attempt: 0 }
      });
    } finally {
      await rm(recoveryHome, { recursive: true, force: true });
    }
  });

  it("rejects inherited turns and transcript-shaped terminal output", async () => {
    const inheritedHost = new FakeNativeHost("codex", true);
    inheritedHost.spawnFresh.mockResolvedValue({ nativeId: "codex-native-worker-1", inheritedTurnCount: 2 });
    const inherited = new CodexNativeWorkerAdapter(inheritedHost, { budget });
    await expect(inherited.spawnFresh(spawnInput())).rejects.toMatchObject({
      code: "CONTEXT_INHERITANCE_DETECTED"
    });
    expect(inheritedHost.interrupt).toHaveBeenCalledTimes(1);
    expect(inheritedHost.close).toHaveBeenCalledTimes(1);
    expect(inheritedHost.archive).toHaveBeenCalledTimes(1);

    const secondHome = await mkdtemp(join(tmpdir(), "agentflow-native-transcript-"));
    try {
      const host = new FakeNativeHost("codex", true);
      const adapter = new CodexNativeWorkerAdapter(host, {
        budget: new HostBudgetCoordinator({ homeDirectory: secondHome, host: "codex" })
      });
      await adapter.spawnFresh(spawnInput());
      host.complete("worker-1");
      host.results.set("codex-native-worker-1", {
        ...workerResult(),
        transcript: [{ role: "assistant", content: "hidden history" }]
      } as never);
      await expect(adapter.collect("worker-1")).rejects.toMatchObject({
        code: "WORKER_RESULT_INVALID"
      });

      host.results.set("codex-native-worker-1", {
        ...workerResult(),
        debug: "unexpected capsule field"
      } as never);
      await expect(adapter.collect("worker-1")).rejects.toMatchObject({
        code: "WORKER_RESULT_INVALID"
      });

      host.results.set("codex-native-worker-1", {
        ...workerResult(),
        summary: "Supervisor transcript: hidden inherited dialogue"
      });
      await expect(adapter.collect("worker-1")).rejects.toMatchObject({
        code: "WORKER_RESULT_INVALID"
      });
    } finally {
      await rm(secondHome, { recursive: true, force: true });
    }
  });

  it("rejects a changed capsule after the first collection", async () => {
    const host = new FakeNativeHost("codex", true);
    const adapter = new CodexNativeWorkerAdapter(host, { budget });
    await adapter.spawnFresh(spawnInput());
    host.complete("worker-1");
    await adapter.collect("worker-1");
    host.results.set("codex-native-worker-1", {
      ...workerResult(),
      summary: "A different terminal summary"
    });

    await expect(adapter.collect("worker-1")).rejects.toMatchObject({
      code: "WORKER_RESULT_INVALID"
    });
  });

  it("redacts credential patterns from the compact Worker capsule", async () => {
    const host = new FakeNativeHost("codex", true);
    const adapter = new CodexNativeWorkerAdapter(host, { budget });
    await adapter.spawnFresh(spawnInput());
    host.complete("worker-1");
    const baseResult = workerResult();
    host.results.set("codex-native-worker-1", {
      ...baseResult,
      summary: "Completed with token=capsule-secret",
      verification: [{
        ...baseResult.verification[0]!,
        summary: "Bearer capsule-bearer-secret"
      }],
      risks: ["api-key=capsule-api-secret"]
    });

    const result = await adapter.collect("worker-1");
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({
      summary: "Completed with token=[REDACTED]",
      verification: [{ summary: "Bearer [REDACTED]" }],
      risks: ["api-key=[REDACTED]"]
    });
    expect(serialized).not.toContain("capsule-secret");
    expect(serialized).not.toContain("capsule-bearer-secret");
    expect(serialized).not.toContain("capsule-api-secret");

    host.results.set("codex-native-worker-1", {
      ...baseResult,
      summary: "Completed with token=changed-capsule-secret",
      verification: [{
        ...baseResult.verification[0]!,
        summary: "Bearer changed-capsule-bearer"
      }],
      risks: ["api-key=changed-capsule-api"]
    });
    await expect(adapter.collect("worker-1")).rejects.toMatchObject({
      code: "WORKER_RESULT_INVALID"
    });
  });

  it("heartbeats permits with a host timer while one waitAny call is pending", async () => {
    const heartbeatHome = await mkdtemp(join(tmpdir(), "agentflow-native-heartbeat-"));
    try {
      const heartbeatBudget = new HostBudgetCoordinator({
        homeDirectory: heartbeatHome,
        host: "codex",
        defaultLeaseSeconds: 1
      });
      const host = new FakeNativeHost("codex", true);
      host.waitAny.mockImplementationOnce(async (nativeIds: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return { nativeId: nativeIds[0]!, status: "running" as const };
      });
      const adapter = new CodexNativeWorkerAdapter(host, {
        budget: heartbeatBudget,
        permitLeaseSeconds: 1
      });
      await adapter.spawnFresh(spawnInput());
      await adapter.waitAny(["worker-1"]);

      await expect(heartbeatBudget.diagnostics()).resolves.toMatchObject({
        activePermitCount: 1,
        expiredPermitCount: 0
      });
      expect(host.waitAny).toHaveBeenCalledTimes(1);
    } finally {
      await rm(heartbeatHome, { recursive: true, force: true });
    }
  });

  it("re-probes cleanup capabilities after resume and never fabricates archive support", async () => {
    const firstHost = new FakeNativeHost("codex", true);
    const first = new CodexNativeWorkerAdapter(firstHost, { budget });
    await first.spawnFresh(spawnInput());
    firstHost.complete("worker-1");
    await first.collect("worker-1");
    first.confirmDurableTerminal("worker-1", "result");

    const resumedHost = new FakeNativeHost("codex", true);
    resumedHost.probe.mockResolvedValue({
      adapterVersion: "2.0.1",
      contextPolicy: { mode: "fresh-attested", inheritedTurnCountObservable: true },
      toolProfile: {
        mode: "allowlist",
        enforced: true,
        tools: ["read_file", "apply_patch"],
        agentflowMcpEnabled: false
      },
      operationStatus: { archive: "unsupported" }
    });
    const resumed = new CodexNativeWorkerAdapter(resumedHost, { budget });
    resumed.bind(first.snapshotHandles()[0]!);

    await expect(resumed.cleanup("worker-1", { supervisorNativeId: "supervisor-native" }))
      .resolves.toMatchObject({
        adapterVersion: "2.0.1",
        close: { status: "completed" },
        archive: { status: "unsupported" },
        completed: true
      });
    expect(resumedHost.archive).not.toHaveBeenCalled();
  });

  it("releases the permit when a host returns an invalid native binding", async () => {
    const host = new FakeNativeHost("codex", true);
    host.spawnFresh.mockResolvedValue({ nativeId: "", inheritedTurnCount: 0 });
    const adapter = new CodexNativeWorkerAdapter(host, { budget });

    await expect(adapter.spawnFresh(spawnInput())).rejects.toMatchObject({
      code: "WORKER_RESULT_INVALID"
    });
    await expect(budget.diagnostics()).resolves.toMatchObject({ activePermitCount: 0 });
    expect(adapter.snapshotHandles()).toEqual([]);
  });
});
