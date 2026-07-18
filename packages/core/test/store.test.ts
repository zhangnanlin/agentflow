import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentFlowEngine, JsonRunStore, defaultPipeline } from "../src/index.js";

describe("JsonRunStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-store-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes valid JSON snapshots atomically", async () => {
    const engine = new AgentFlowEngine(new JsonRunStore(directory), defaultPipeline);
    const state = await engine.createRun({ id: "run-atomic", requirement: "Persist state" });
    const raw = await readFile(join(directory, state.id, "state.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ id: state.id, revision: 0 });
  });

  it("recovers a stale lock file", async () => {
    const store = new JsonRunStore(directory, { staleLockMs: 0 });
    const engine = new AgentFlowEngine(store, defaultPipeline);
    let state = await engine.createRun({ id: "run-stale-lock", requirement: "Recover lock" });
    await writeFile(join(directory, state.id, ".lock"), "stale", "utf8");

    state = await engine.createTask(state.id, {
      id: "task-after-lock",
      stageId: "S00",
      title: "Continue after recovery"
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "recover-lock",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    expect(state.revision).toBe(1);
  });

  it("loads snapshots created before stage preflights were introduced", async () => {
    const store = new JsonRunStore(directory);
    const engine = new AgentFlowEngine(store, defaultPipeline);
    const state = await engine.createRun({ id: "run-legacy-preflight", requirement: "Load legacy state" });
    const path = join(directory, state.id, "state.json");
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete legacy.preflights;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    await expect(store.load(state.id)).resolves.toMatchObject({ preflights: {} });
  });

  it("persists fingerprinted idempotency while loading legacy hashless records", async () => {
    const store = new JsonRunStore(directory);
    const engine = new AgentFlowEngine(store, defaultPipeline);
    let state = await engine.createRun({ id: "run-idempotency-hash", requirement: "Bind retries to inputs" });
    const mutation = {
      expectedRevision: state.revision,
      idempotencyKey: "fingerprinted-create",
      inputHash: "a".repeat(64),
      actor: { id: "supervisor", kind: "supervisor" as const }
    };

    state = await engine.createTask(state.id, {
      id: "fingerprinted-task",
      stageId: "S00",
      title: "Fingerprint replay"
    }, mutation);
    expect(state.idempotency[mutation.idempotencyKey]?.inputHash).toBe(mutation.inputHash);

    const path = join(directory, state.id, "state.json");
    const legacy = JSON.parse(await readFile(path, "utf8")) as {
      idempotency: Record<string, { inputHash?: string }>;
    };
    delete legacy.idempotency[mutation.idempotencyKey]?.inputHash;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    await expect(store.load(state.id)).resolves.toMatchObject({
      idempotency: {
        [mutation.idempotencyKey]: {
          operation: "task.create"
        }
      }
    });
  });

  it("reads bounded projections without rewriting canonical state", async () => {
    const store = new JsonRunStore(directory);
    const engine = new AgentFlowEngine(store, defaultPipeline);
    const state = await engine.createRun({ id: "run-projected-read", requirement: "Read projections" });
    const path = join(directory, state.id, "state.json");
    const before = await readFile(path, "utf8");

    const summary = await store.loadSummary(state.id);
    const events = await store.loadSection(state.id, "events", { pageSize: 1 });
    const after = await readFile(path, "utf8");

    expect(summary).toMatchObject({ runId: state.id, revision: 0, activeStageId: "S00" });
    expect(events.items).toHaveLength(1);
    expect(after).toBe(before);
  });
});
