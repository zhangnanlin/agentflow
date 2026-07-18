import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  pendingTerminalCleanup,
  type PipelineDefinition
} from "../src/index.js";

const oneStagePipeline: PipelineDefinition = {
  id: "one-stage",
  version: "1",
  name: "One stage",
  stages: [{
    id: "S00",
    name: "Only",
    description: "",
    dependsOn: [],
    skills: [],
    tools: [],
    requiredCapabilities: [],
    requiredArtifactKinds: [],
    skippableWhen: []
  }]
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(id: string) {
  const directory = await mkdtemp(join(tmpdir(), "agentflow-lifecycle-v2-"));
  directories.push(directory);
  const engine = new AgentFlowEngine(new JsonRunStore(directory), oneStagePipeline);
  const state = await engine.createRun({ id, requirement: id });
  return { directory, engine, state };
}

describe("truthful Run lifecycle", () => {
  it("records successful terminal execution separately from lifecycle status", async () => {
    const { engine, state } = await setup("run-success");
    const completed = await engine.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(completed).toMatchObject({
      status: "completed",
      executionStatus: "terminal",
      businessOutcome: "succeeded"
    });
  });

  it("cancels and supersedes idle Runs in one mutation", async () => {
    const cancelledSetup = await setup("run-cancel");
    const cancelled = await cancelledSetup.engine.cancelRun(cancelledSetup.state.id, "No longer needed", {
      expectedRevision: cancelledSetup.state.revision,
      idempotencyKey: "cancel",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    expect(cancelled).toMatchObject({ status: "cancelled", executionStatus: "terminal", businessOutcome: "cancelled" });

    const supersededSetup = await setup("run-supersede");
    const superseded = await supersededSetup.engine.supersedeRun(
      supersededSetup.state.id,
      "run-replacement",
      "Requirement changed",
      {
        expectedRevision: supersededSetup.state.revision,
        idempotencyKey: "supersede",
        actor: { id: "supervisor", kind: "supervisor" }
      }
    );
    expect(superseded).toMatchObject({ status: "superseded", executionStatus: "terminal", businessOutcome: "superseded" });
    expect(superseded.events.at(-1)).toMatchObject({ type: "run.superseded", data: { replacementRunId: "run-replacement" } });
  });

  it("records a failed business outcome without reporting success", async () => {
    const { engine, state } = await setup("run-failed");
    const failed = await engine.failRun(state.id, "Verification failed", {
      expectedRevision: state.revision,
      idempotencyKey: "fail",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(failed).toMatchObject({ status: "failed", executionStatus: "terminal", businessOutcome: "failed" });
  });

  it("records a blocked terminal outcome explicitly", async () => {
    const { engine, state } = await setup("run-blocked");
    const blocked = await engine.blockRun(state.id, "Waiting on an external dependency", {
      expectedRevision: state.revision,
      idempotencyKey: "block",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(blocked).toMatchObject({ status: "blocked", executionStatus: "terminal", businessOutcome: "blocked" });
  });

  it("returns a completed Run to running when an upstream Artifact changes", async () => {
    const { engine, state: created } = await setup("run-reopened");
    let state = await engine.registerArtifact(created.id, {
      id: "source",
      stageId: "S00",
      kind: "source",
      uri: "source.json",
      sha256: "d".repeat(64),
      producedBy: "supervisor"
    }, {
      expectedRevision: created.revision,
      idempotencyKey: "register-source",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete-before-change",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    expect(state).toMatchObject({ status: "completed", executionStatus: "terminal", businessOutcome: "succeeded" });

    state = await engine.registerArtifact(state.id, {
      id: "source",
      stageId: "S00",
      kind: "source",
      uri: "source.json",
      sha256: "e".repeat(64),
      producedBy: "supervisor"
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "replace-source",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(state).toMatchObject({ status: "active", executionStatus: "running", activeStageId: "S00" });
    expect(state.businessOutcome).toBeUndefined();
  });

  it("refuses to cancel a Run with a live Worker", async () => {
    const { engine } = await setup("run-live-worker");
    let state = await engine.loadRun("run-live-worker");
    state = await engine.createTask(state.id, {
      id: "task-live",
      stageId: "S00",
      title: "Live",
      verificationCommands: ["verify"]
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "create",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.claimTask(state.id, "task-live", "worker-live", 900, {
      expectedRevision: state.revision,
      idempotencyKey: "claim",
      actor: { id: "worker-live", kind: "worker" }
    });
    state = await engine.prepareWorker(state.id, {
      workerId: "worker-live",
      taskId: "task-live",
      adapter: "codex",
      hostTaskName: "task_live",
      promptHash: "a".repeat(64),
      capabilities: { spawn: true, send: true, status: true, collect: true, interrupt: true, close: true }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "prepare",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    await expect(engine.cancelRun(state.id, "Hide live work", {
      expectedRevision: state.revision,
      idempotencyKey: "cancel",
      actor: { id: "supervisor", kind: "supervisor" }
    })).rejects.toMatchObject({ code: "RUN_WORKER_LIVE" });
  });

  it("refuses to hide a partial external operation after its Worker becomes terminal", async () => {
    const { engine } = await setup("run-live-operation");
    let state = await engine.loadRun("run-live-operation");
    state = await engine.createTask(state.id, {
      id: "task-operation",
      stageId: "S00",
      title: "External operation",
      verificationCommands: ["verify"]
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "create-operation",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.claimTask(state.id, "task-operation", "worker-operation", 900, {
      expectedRevision: state.revision,
      idempotencyKey: "claim-operation",
      actor: { id: "worker-operation", kind: "worker" }
    });
    state = await engine.prepareWorker(state.id, {
      workerId: "worker-operation",
      taskId: "task-operation",
      adapter: "codex",
      hostTaskName: "task_operation",
      promptHash: "c".repeat(64),
      capabilities: { spawn: true, send: true, status: true, collect: true, interrupt: true, close: true }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "prepare-operation",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.bindWorker(state.id, "worker-operation", "thread-operation", {
      expectedRevision: state.revision,
      idempotencyKey: "bind-operation",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.acquireResource(state.id, {
      resourceId: "external-resource",
      kind: "external-document",
      resourceKey: "document-1",
      stageId: "S00",
      taskId: "task-operation",
      owner: "worker-operation",
      leaseSeconds: 900
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "acquire-operation",
      actor: { id: "worker-operation", kind: "worker" }
    });
    state = await engine.beginResourceOperation(
      state.id,
      "external-resource",
      "worker-operation",
      "write-operation",
      "external.write",
      {
        expectedRevision: state.revision,
        idempotencyKey: "begin-operation",
        actor: { id: "worker-operation", kind: "worker" }
      }
    );
    state = await engine.collectWorkerResult(state.id, "worker-operation", {
      workerId: "worker-operation",
      taskId: "task-operation",
      status: "completed",
      summary: "Worker returned while the external write remained unresolved",
      artifacts: [],
      changeSet: null,
      verification: [{ command: "verify", status: "passed", summary: "passed", recordedAt: new Date().toISOString() }],
      risks: ["External operation still running"],
      followUps: [],
      completedAt: new Date().toISOString()
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "collect-operation",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    await expect(engine.cancelRun(state.id, "Hide partial write", {
      expectedRevision: state.revision,
      idempotencyKey: "cancel-operation",
      actor: { id: "supervisor", kind: "supervisor" }
    })).rejects.toMatchObject({ code: "RUN_RESOURCE_OPERATION_LIVE" });
  });
});

describe("terminal Worker cleanup facts", () => {
  it("terminalizes cleanup truthfully when native spawn failed before binding", async () => {
    const { engine } = await setup("run-unbound-worker-failure");
    let state = await engine.loadRun("run-unbound-worker-failure");
    state = await engine.createTask(state.id, {
      id: "task-unbound",
      stageId: "S00",
      title: "Unbound",
      verificationCommands: ["verify"]
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "create-unbound",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.claimTask(state.id, "task-unbound", "worker-unbound", 900, {
      expectedRevision: state.revision,
      idempotencyKey: "claim-unbound",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.prepareWorker(state.id, {
      workerId: "worker-unbound",
      taskId: "task-unbound",
      adapter: "codex",
      hostTaskName: "task_unbound",
      promptHash: "c".repeat(64),
      capabilities: { spawn: true, send: true, status: true, collect: true, interrupt: true, close: true }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "prepare-unbound",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    state = await engine.failWorker(state.id, "worker-unbound", "Native spawn was never created", {
      expectedRevision: state.revision,
      idempotencyKey: "fail-unbound",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(state.workers["worker-unbound"]).toMatchObject({
      status: "failed",
      cleanup: {
        close: { status: "unsupported" },
        archive: { status: "unsupported" },
        permitRelease: { status: "unsupported" },
        completedAt: expect.any(String)
      }
    });
    expect(pendingTerminalCleanup(state)).toEqual([]);
  });

  it("records confirmed cleanup steps without redispatching the Task", async () => {
    const { engine } = await setup("run-cleanup");
    let state = await engine.loadRun("run-cleanup");
    state = await engine.createTask(state.id, {
      id: "task-cleanup",
      stageId: "S00",
      title: "Cleanup",
      verificationCommands: ["verify"]
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "create",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.claimTask(state.id, "task-cleanup", "worker-cleanup", 900, {
      expectedRevision: state.revision,
      idempotencyKey: "claim",
      actor: { id: "worker-cleanup", kind: "worker" }
    });
    state = await engine.prepareWorker(state.id, {
      workerId: "worker-cleanup",
      taskId: "task-cleanup",
      adapter: "codex",
      hostTaskName: "task_cleanup",
      promptHash: "b".repeat(64),
      capabilities: { spawn: true, send: true, status: true, collect: true, interrupt: true, close: true }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "prepare",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.bindWorker(state.id, "worker-cleanup", "thread-cleanup", {
      expectedRevision: state.revision,
      idempotencyKey: "bind",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await engine.collectWorkerResult(state.id, "worker-cleanup", {
      workerId: "worker-cleanup",
      taskId: "task-cleanup",
      status: "completed",
      summary: "done",
      artifacts: [],
      changeSet: null,
      verification: [{ command: "verify", status: "passed", summary: "passed", recordedAt: new Date().toISOString() }],
      risks: [],
      followUps: [],
      completedAt: new Date().toISOString()
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "collect",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(pendingTerminalCleanup(state)).toEqual(["worker-cleanup"]);
    await expect(engine.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete-before-cleanup",
      actor: { id: "supervisor", kind: "supervisor" }
    })).rejects.toMatchObject({ code: "STAGE_WORKER_CLEANUP_PENDING" });

    for (const [index, step] of ["close", "archive", "permitRelease"].entries()) {
      state = await engine.recordWorkerCleanup(state.id, {
        workerId: "worker-cleanup",
        step: step as "close" | "archive" | "permitRelease",
        status: step === "archive" ? "unsupported" : "completed",
        ...(step === "archive" ? { reason: "Host has no archive capability" } : {})
      }, {
        expectedRevision: state.revision,
        idempotencyKey: "cleanup-" + index,
        actor: { id: "supervisor", kind: "supervisor" }
      });
    }

    expect(pendingTerminalCleanup(state)).toEqual([]);
    expect(state.workers["worker-cleanup"]).toMatchObject({
      status: "completed",
      cleanup: {
        close: { status: "completed" },
        archive: { status: "unsupported" },
        permitRelease: { status: "completed" }
      }
    });
    state = await engine.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete-after-cleanup",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    expect(state).toMatchObject({ status: "completed", executionStatus: "terminal", businessOutcome: "succeeded" });
  });
});
