import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  RunStateSchema,
  defaultPipeline,
  projectChangeReceipt,
  projectRunSection,
  projectRunSummary
} from "../src/index.js";

function largeRun() {
  const now = new Date().toISOString();
  const tasks = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
    const id = `task-${index}`;
    return [id, {
      id,
      stageId: "S00",
      title: `Task ${index}`,
      description: "Bounded task",
      status: index < 15 ? "ready" : "running",
      dependsOn: [],
      writeScopes: ["packages/core"],
      forbiddenScopes: [],
      inputArtifactHashes: {},
      inputArtifactKinds: {},
      inputArtifactUris: {},
      acceptanceCriteria: ["Complete"],
      verificationCommands: ["npm run typecheck"],
      expectedOutputs: ["Result"],
      requiresWorktree: false,
      ...(index < 15 ? {} : {
        owner: `worker-${index}`,
        lease: { owner: `worker-${index}`, acquiredAt: now, heartbeatAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }
      }),
      verification: [],
      createdAt: now,
      updatedAt: now
    }];
  }));
  const workers = Object.fromEntries(Array.from({ length: 15 }, (_, offset) => {
    const index = offset + 15;
    const id = `worker-${index}`;
    return [id, {
      id,
      taskId: `task-${index}`,
      adapter: "codex",
      hostTaskName: `task_${index}`,
      promptHash: `${index.toString(16).padStart(2, "0")}`.repeat(32),
      externalThreadId: `thread-${index}`,
      status: "running",
      capabilities: { spawn: true, send: true, status: true, collect: true, interrupt: true, close: true },
      createdAt: now,
      updatedAt: now
    }];
  }));
  const artifacts = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`artifact-${index}`, {
    id: `artifact-${index}`,
    stageId: "S00",
    kind: "fixture",
    uri: `.agentflow/artifacts/${index}.json`,
    sha256: `${index.toString(16).padStart(2, "0")}`.repeat(32),
    producedBy: "fixture",
    stale: false,
    metadata: {},
    createdAt: now,
    updatedAt: now
  }]));
  return RunStateSchema.parse({
    id: "run-large",
    pipelineId: "agentflow-default",
    pipelineVersion: "0.4.0",
    requirement: "Project a large Run",
    projectType: "existing",
    hasUi: false,
    status: "active",
    revision: 40,
    activeStageId: "S00",
    stages: { S00: { id: "S00", status: "active", startedAt: now } },
    preflights: {},
    tasks,
    workers,
    resources: {},
    artifacts,
    gates: {},
    events: Array.from({ length: 120 }, (_, index) => ({
      id: `event-${index}`,
      type: "fixture.event",
      actorId: "system",
      actorKind: "system",
      at: now,
      data: { index, text: "x".repeat(100) }
    })),
    idempotency: {},
    createdAt: now,
    updatedAt: now
  });
}

describe("Run projections", () => {
  it("keeps default summary output below 8 KiB", () => {
    const summary = projectRunSummary(largeRun());
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThanOrEqual(8_192);
    expect(summary.currentTasks).toHaveLength(10);
    expect(summary.currentTaskOverflow).toBe(20);
    expect(summary.liveWorkers).toHaveLength(10);
    expect(summary.liveWorkerOverflow).toBe(5);
    expect(summary.nextAction.length).toBeGreaterThan(0);
  });

  it("keeps mutation receipts below 4 KiB while reporting changed entities", () => {
    const previous = largeRun();
    const next = structuredClone(previous);
    next.revision += 1;
    for (const task of Object.values(next.tasks)) task.status = "completed";
    for (const worker of Object.values(next.workers)) worker.status = "completed";

    const receipt = projectChangeReceipt(previous, RunStateSchema.parse(next));

    expect(Buffer.byteLength(JSON.stringify(receipt), "utf8")).toBeLessThanOrEqual(4_096);
    expect(receipt.changed.tasks.length).toBeGreaterThan(0);
    expect(receipt.changed.workers.length).toBeGreaterThan(0);
    expect(receipt.revision).toBe(41);
  });

  it("reports added and removed entities without serializing undefined", () => {
    const previous = largeRun();
    const next = structuredClone(previous);
    next.revision += 1;
    const added = structuredClone(next.tasks["task-1"]!);
    added.id = "task-added";
    next.tasks[added.id] = added;
    delete next.tasks["task-0"];

    const receipt = projectChangeReceipt(previous, RunStateSchema.parse(next));

    expect(receipt.changed.tasks).toContain("task-added");
    expect(receipt.changed.tasks).toContain("task-0");
  });

  it("pages sections and events with opaque cursors", () => {
    const state = largeRun();
    const first = projectRunSection(state, "tasks", { pageSize: 5 });
    const second = projectRunSection(state, "tasks", { pageSize: 5, cursor: first.nextCursor });
    const events = projectRunSection(state, "events", { pageSize: 7 });

    expect(first.items).toHaveLength(5);
    expect(second.items).toHaveLength(5);
    expect(second.items).not.toEqual(first.items);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(events.items).toHaveLength(7);
    expect(events.nextCursor).toBeTypeOf("string");
  });
});

describe("Supervisor inline Task completion", () => {
  it("completes a materialized implementation Task without fabricating a Worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-inline-"));
    try {
      const store = new JsonRunStore(directory);
      const engine = new AgentFlowEngine(store, defaultPipeline);
      let state = await engine.createRun({ id: "run-inline", requirement: "Execute inline", hasUi: false });
      state = await engine.createTask(state.id, {
        id: "task-inline",
        stageId: "S00",
        title: "Inline implementation",
        writeScopes: ["packages/core"],
        forbiddenScopes: ["agentflow-0.4.0.tgz"],
        acceptanceCriteria: ["Complete inline"],
        verificationCommands: ["npm run typecheck"],
        expectedOutputs: ["Core change"]
      }, {
        expectedRevision: state.revision,
        idempotencyKey: "create-inline",
        actor: { id: "supervisor-root", kind: "supervisor" }
      });
      state = await engine.claimTask(state.id, "task-inline", "supervisor-root", 900, {
        expectedRevision: state.revision,
        idempotencyKey: "claim-inline",
        actor: { id: "supervisor-root", kind: "worker" }
      });
      const path = join(directory, state.id, "state.json");
      const raw = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      raw.tasks["task-inline"] = {
        ...raw.tasks["task-inline"],
        materializedFrom: { artifactId: "plan", kind: "implementation-plan", sha256: "c".repeat(64) },
        planRepository: { branch: "main", baseRevision: "a".repeat(40) }
      };
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

      const completed = await engine.completeInlineTask(state.id, {
        taskId: "task-inline",
        workspace: { kind: "project", path: directory },
        result: {
          summary: "Implemented directly by the Supervisor",
          artifacts: [],
          changeSet: {
            kind: "git-commits",
            baseRevision: "a".repeat(40),
            headRevision: "b".repeat(40),
            revisions: ["b".repeat(40)],
            changedPaths: ["packages/core/src/model.ts"]
          },
          verification: [{
            command: "npm run typecheck",
            status: "passed",
            summary: "passed",
            recordedAt: new Date().toISOString()
          }],
          risks: [],
          followUps: []
        }
      }, {
        expectedRevision: state.revision,
        idempotencyKey: "complete-inline",
        actor: { id: "supervisor-root", kind: "supervisor" }
      });

      expect(completed.tasks["task-inline"]).toMatchObject({
        status: "completed",
        owner: "supervisor-root",
        ownerKind: "supervisor",
        workspace: { kind: "project", path: directory },
        result: { summary: "Implemented directly by the Supervisor" }
      });
      expect(completed.workers).toEqual({});
      expect(completed.events.at(-1)).toMatchObject({ type: "task.completed.inline", actorKind: "supervisor" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
