import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  sha256,
  validatePipeline,
  type Actor,
  type MutationContext,
  type RunState
} from "../src/index.js";

const pipeline = validatePipeline({
  id: "preflight-pipeline",
  version: "1",
  name: "Preflight pipeline",
  stages: [{
    id: "S04",
    name: "Design Concepts",
    requiredCapabilities: [
      "host.worker.spawn",
      "figma.remote.connected",
      "figma.remote.authenticated",
      "figma.tool.use_figma",
      "skill.figma-use"
    ]
  }]
});

const supervisor: Actor = { id: "supervisor-preflight", kind: "supervisor" };
const writer: Actor = { id: "figma-writer", kind: "worker" };
const threadCapabilities = {
  spawn: true,
  send: true,
  status: true,
  collect: true,
  interrupt: true,
  close: false
};
const allCapabilities = pipeline.stages[0]?.requiredCapabilities ?? [];

describe("stage capability preflight", () => {
  let directory: string;
  let store: JsonRunStore;
  let engine: AgentFlowEngine;
  let key: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-preflight-"));
    store = new JsonRunStore(directory);
    engine = new AgentFlowEngine(store, pipeline);
    key = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const context = (state: RunState, actor: Actor, reason: string): MutationContext => ({
    expectedRevision: state.revision,
    idempotencyKey: `${reason}-${++key}`,
    actor,
    reason
  });

  it("blocks on missing live capabilities, survives reload, and resumes without duplicating work", async () => {
    let state = await engine.createRun({ id: "run-preflight-recovery", requirement: "Render Figma concepts" });
    state = await engine.createTask(state.id, {
      id: "figma-concepts",
      stageId: "S04",
      title: "Render A, B, and C"
    }, context(state, supervisor, "create-writer-task"));

    await expect(engine.claimTask(
      state.id,
      "figma-concepts",
      writer.id,
      300,
      context(state, writer, "claim-without-preflight")
    )).rejects.toMatchObject({ code: "STAGE_PREFLIGHT_REQUIRED" });

    state = await engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: ["host.worker.spawn"],
      ttlSeconds: 900
    }, context(state, supervisor, "figma-unavailable"));
    expect(state).toMatchObject({ status: "blocked", activeStageId: "S04" });
    expect(state.stages.S04?.status).toBe("blocked");
    expect(state.tasks["figma-concepts"]?.status).toBe("pending");
    expect(state.preflights.S04).toMatchObject({
      status: "blocked",
      availableCapabilities: ["host.worker.spawn"],
      missingCapabilities: [
        "figma.remote.connected",
        "figma.remote.authenticated",
        "figma.tool.use_figma",
        "skill.figma-use"
      ]
    });
    expect(state.workers).toEqual({});
    expect(state.resources).toEqual({});

    const recovered = new AgentFlowEngine(new JsonRunStore(directory), pipeline);
    state = await recovered.loadRun(state.id);
    expect(state.stages.S04?.status).toBe("blocked");

    state = await recovered.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: allCapabilities,
      ttlSeconds: 900
    }, context(state, supervisor, "figma-recovered"));
    expect(state).toMatchObject({ status: "active", activeStageId: "S04" });
    expect(state.stages.S04?.status).toBe("active");
    expect(state.tasks["figma-concepts"]?.status).toBe("ready");

    state = await recovered.claimTask(
      state.id,
      "figma-concepts",
      writer.id,
      300,
      context(state, writer, "claim-after-recovery")
    );
    state = await recovered.prepareWorker(state.id, {
      workerId: writer.id,
      taskId: "figma-concepts",
      adapter: "codex",
      hostTaskName: "af_run_preflight_figma_writer",
      promptHash: sha256("bounded writer prompt"),
      capabilities: threadCapabilities
    }, context(state, supervisor, "prepare-writer"));
    state = await recovered.bindWorker(
      state.id,
      writer.id,
      "codex-thread-preflight",
      context(state, supervisor, "bind-writer")
    );
    state = await recovered.acquireResource(state.id, {
      resourceId: "figma-main",
      kind: "figma-file",
      resourceKey: "run-preflight-provisional",
      stageId: "S04",
      taskId: "figma-concepts",
      owner: writer.id,
      leaseSeconds: 300
    }, context(state, writer, "acquire-figma"));
    state = await recovered.beginResourceOperation(
      state.id,
      "figma-main",
      writer.id,
      "render-a",
      "figma.use_figma.write",
      context(state, writer, "begin-render-a")
    );
    expect(state.resources["figma-main"]?.activeOperationId).toBe("render-a");
  });

  it("rejects an unsafe block while a writer is live and preserves the passing snapshot", async () => {
    let state = await engine.createRun({ id: "run-preflight-live", requirement: "Protect live writer" });
    state = await engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: allCapabilities,
      ttlSeconds: 900
    }, context(state, supervisor, "preflight-pass"));
    state = await engine.createTask(state.id, {
      id: "figma-concepts",
      stageId: "S04",
      title: "Render concepts"
    }, context(state, supervisor, "create-task"));
    state = await engine.claimTask(state.id, "figma-concepts", writer.id, 300, context(state, writer, "claim-task"));
    state = await engine.prepareWorker(state.id, {
      workerId: writer.id,
      taskId: "figma-concepts",
      adapter: "codex",
      hostTaskName: "af_live_writer",
      promptHash: sha256("writer"),
      capabilities: threadCapabilities
    }, context(state, supervisor, "prepare-live-writer"));
    state = await engine.bindWorker(state.id, writer.id, "codex-live-thread", context(state, supervisor, "bind-live-writer"));

    await expect(engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: [],
      ttlSeconds: 900
    }, context(state, supervisor, "probe-failed-mid-write"))).rejects.toMatchObject({
      code: "STAGE_PREFLIGHT_WORKER_ACTIVE"
    });

    const persisted = await engine.loadRun(state.id);
    expect(persisted.revision).toBe(state.revision);
    expect(persisted.stages.S04?.status).toBe("active");
    expect(persisted.preflights.S04?.status).toBe("passed");
  });

  it("requires supervisor authority and rejects expired evidence at the use boundary", async () => {
    let state = await engine.createRun({ id: "run-preflight-expiry", requirement: "Expire live evidence" });
    await expect(engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: allCapabilities,
      ttlSeconds: 900
    }, context(state, writer, "worker-preflight"))).rejects.toMatchObject({ code: "STAGE_PREFLIGHT_ACTOR_INVALID" });

    state = await engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: allCapabilities,
      ttlSeconds: 900
    }, context(state, supervisor, "preflight-pass"));
    state = await engine.createTask(state.id, {
      id: "figma-concepts",
      stageId: "S04",
      title: "Render concepts"
    }, context(state, supervisor, "create-task"));
    state = await store.transact(state.id, {
      ...context(state, supervisor, "expire-preflight"),
      operation: "test.preflight.expire"
    }, (current) => {
      const preflight = current.preflights.S04;
      if (!preflight) throw new Error("Expected S04 preflight");
      preflight.expiresAt = "2000-01-01T00:00:00.000Z";
      return current;
    });

    await expect(engine.claimTask(
      state.id,
      "figma-concepts",
      writer.id,
      300,
      context(state, writer, "claim-expired")
    )).rejects.toMatchObject({ code: "STAGE_PREFLIGHT_EXPIRED" });
  });
});
