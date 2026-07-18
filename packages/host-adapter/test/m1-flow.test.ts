import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  validatePipeline,
  type Actor,
  type MutationContext,
  type RunState,
  type WorkerResult
} from "@agentflow/core";
import {
  CodexThreadAdapter,
  codexHandlesFromRun,
  hashWorkerPrompt,
  type CodexSpawnRequest,
  type CodexThreadClient,
  type CodexThreadSnapshot,
  type SpawnWorkerInput
} from "../src/index.js";

class FakeCodexClient implements CodexThreadClient {
  readonly spawnRequests: CodexSpawnRequest[] = [];
  private readonly snapshots = new Map<string, CodexThreadSnapshot>();

  async spawn(request: CodexSpawnRequest): Promise<{ threadId: string }> {
    this.spawnRequests.push(request);
    const threadId = `codex-thread-${this.spawnRequests.length}`;
    this.snapshots.set(threadId, { status: "running" });
    await Promise.resolve();
    return { threadId };
  }

  async inspect(threadId: string): Promise<CodexThreadSnapshot> {
    const snapshot = this.snapshots.get(threadId);
    if (!snapshot) throw new Error(`Unknown fake Codex thread: ${threadId}`);
    return snapshot;
  }

  async send(_threadId: string, _message: string): Promise<void> {}

  async interrupt(threadId: string, _reason: string): Promise<void> {
    this.snapshots.set(threadId, { status: "interrupted" });
  }

  async close(threadId: string): Promise<void> {
    this.snapshots.set(threadId, { status: "closed" });
  }

  complete(threadId: string, result: WorkerResult): void {
    this.snapshots.set(threadId, { status: result.status, result });
  }
}

const pipeline = validatePipeline({
  id: "m1-flow",
  version: "1",
  name: "Parallel implementation with review",
  stages: [
    { id: "S11", name: "Implementation" },
    { id: "S12", name: "Integration", dependsOn: ["S11"] }
  ]
});

const supervisor: Actor = { id: "supervisor-m1", kind: "supervisor" };

describe("M1 native multi-worker flow", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("runs two implementation workers in parallel, recovers, then runs review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-m1-"));
    directories.push(directory);
    const engine = new AgentFlowEngine(new JsonRunStore(directory), pipeline);
    const client = new FakeCodexClient();
    const adapter = new CodexThreadAdapter(client);
    const capabilities = await adapter.capabilities();
    let key = 0;
    const context = (state: RunState, actor: Actor, operation: string): MutationContext => ({
      expectedRevision: state.revision,
      idempotencyKey: `${operation}-${++key}`,
      actor,
      reason: operation
    });

    let state = await engine.createRun({ id: "run-m1", requirement: "Implement web and API, then review" });
    state = await engine.createTask(state.id, {
      id: "frontend",
      stageId: "S11",
      title: "Implement the web client",
      writeScopes: ["packages/web/**"]
    }, context(state, supervisor, "create-frontend"));
    state = await engine.createTask(state.id, {
      id: "backend",
      stageId: "S11",
      title: "Implement the API",
      writeScopes: ["packages/api/**"]
    }, context(state, supervisor, "create-backend"));
    state = await engine.createTask(state.id, {
      id: "review",
      stageId: "S11",
      title: "Review the integrated implementation",
      dependsOn: ["frontend", "backend"]
    }, context(state, supervisor, "create-review"));

    const frontend = workerInput("run-m1", "frontend", "worker-frontend", ["packages/web/**"]);
    const backend = workerInput("run-m1", "backend", "worker-backend", ["packages/api/**"]);
    for (const input of [frontend, backend]) {
      const actor: Actor = { id: input.workerId, kind: "worker" };
      state = await engine.claimTask(state.id, input.taskId, input.workerId, 60, context(state, actor, `claim-${input.taskId}`));
      state = await engine.prepareWorker(state.id, {
        workerId: input.workerId,
        taskId: input.taskId,
        adapter: "codex",
        hostTaskName: input.taskName,
        promptHash: hashWorkerPrompt(input),
        capabilities
      }, context(state, supervisor, `prepare-${input.taskId}`));
    }

    const [frontendHandle, backendHandle] = await Promise.all([
      adapter.spawn(frontend),
      adapter.spawn(backend)
    ]);
    state = await engine.bindWorker(
      state.id,
      frontend.workerId,
      frontendHandle.externalThreadId,
      context(state, supervisor, "bind-frontend")
    );
    state = await engine.bindWorker(
      state.id,
      backend.workerId,
      backendHandle.externalThreadId,
      context(state, supervisor, "bind-backend")
    );
    expect(client.spawnRequests).toHaveLength(2);
    expect(state.tasks.frontend?.status).toBe("running");
    expect(state.tasks.backend?.status).toBe("running");
    expect(state.tasks.review?.status).toBe("pending");

    state = await engine.loadRun(state.id);
    const recoveredAdapter = new CodexThreadAdapter(client, codexHandlesFromRun(state));
    await expect(recoveredAdapter.status(frontend.workerId)).resolves.toBe("running");
    await expect(recoveredAdapter.status(backend.workerId)).resolves.toBe("running");

    client.complete(frontendHandle.externalThreadId, completedResult(frontend, "Frontend verified"));
    client.complete(backendHandle.externalThreadId, completedResult(backend, "Backend verified"));
    const [frontendResult, backendResult] = await Promise.all([
      recoveredAdapter.collect(frontend.workerId),
      recoveredAdapter.collect(backend.workerId)
    ]);
    state = await engine.collectWorkerResult(
      state.id,
      frontend.workerId,
      frontendResult,
      context(state, supervisor, "collect-frontend")
    );
    state = await engine.collectWorkerResult(
      state.id,
      backend.workerId,
      backendResult,
      context(state, supervisor, "collect-backend")
    );
    for (const input of [frontend, backend]) {
      await recoveredAdapter.close(input.workerId);
      state = await engine.closeWorker(
        state.id,
        input.workerId,
        "Close collected legacy Worker",
        context(state, supervisor, `close-${input.taskId}`)
      );
      state = await engine.recordWorkerCleanup(state.id, {
        workerId: input.workerId,
        step: "archive",
        status: "unsupported",
        reason: "Legacy Codex adapter has no archive operation"
      }, context(state, supervisor, `archive-${input.taskId}`));
      state = await engine.recordWorkerCleanup(state.id, {
        workerId: input.workerId,
        step: "permitRelease",
        status: "unsupported",
        reason: "Legacy Codex adapter has no host budget permit"
      }, context(state, supervisor, `release-${input.taskId}`));
    }
    expect(state.tasks.review?.status).toBe("ready");

    const review = workerInput("run-m1", "review", "worker-review", []);
    const reviewActor: Actor = { id: review.workerId, kind: "worker" };
    state = await engine.claimTask(state.id, review.taskId, review.workerId, 60, context(state, reviewActor, "claim-review"));
    state = await engine.prepareWorker(state.id, {
      workerId: review.workerId,
      taskId: review.taskId,
      adapter: "codex",
      hostTaskName: review.taskName,
      promptHash: hashWorkerPrompt(review),
      capabilities
    }, context(state, supervisor, "prepare-review"));
    const reviewHandle = await recoveredAdapter.spawn(review);
    state = await engine.bindWorker(
      state.id,
      review.workerId,
      reviewHandle.externalThreadId,
      context(state, supervisor, "bind-review")
    );
    client.complete(reviewHandle.externalThreadId, completedResult(review, "Integration review passed"));
    const reviewResult = await recoveredAdapter.collect(review.workerId);
    state = await engine.collectWorkerResult(
      state.id,
      review.workerId,
      reviewResult,
      context(state, supervisor, "collect-review")
    );
    await recoveredAdapter.close(review.workerId);
    state = await engine.closeWorker(
      state.id,
      review.workerId,
      "Close collected legacy review Worker",
      context(state, supervisor, "close-review")
    );
    state = await engine.recordWorkerCleanup(state.id, {
      workerId: review.workerId,
      step: "archive",
      status: "unsupported",
      reason: "Legacy Codex adapter has no archive operation"
    }, context(state, supervisor, "archive-review"));
    state = await engine.recordWorkerCleanup(state.id, {
      workerId: review.workerId,
      step: "permitRelease",
      status: "unsupported",
      reason: "Legacy Codex adapter has no host budget permit"
    }, context(state, supervisor, "release-review"));
    state = await engine.completeStage(state.id, "S11", context(state, supervisor, "complete-implementation"));

    expect(state.activeStageId).toBe("S12");
    expect(state.tasks.frontend?.status).toBe("completed");
    expect(state.tasks.backend?.status).toBe("completed");
    expect(state.tasks.review?.status).toBe("completed");
    expect(Object.values(state.workers).map((worker) => worker.externalThreadId)).toEqual([
      "codex-thread-1",
      "codex-thread-2",
      "codex-thread-3"
    ]);
  });
});

function workerInput(
  runId: string,
  taskId: string,
  workerId: string,
  allowedPaths: string[]
): SpawnWorkerInput {
  return {
    runId,
    taskId,
    workerId,
    taskName: `${runId}_${taskId}_${workerId}`.replaceAll("-", "_"),
    profile: taskId === "review" ? "reviewer" : "implementation",
    prompt: {
      objective: taskId === "review" ? "Review both completed implementation tasks." : `Complete ${taskId}.`,
      context: [],
      inputArtifacts: [],
      inputArtifactHashes: {},
      inputArtifactKinds: {},
      componentIds: [],
      requirementIds: [],
      allowedPaths,
      forbiddenPaths: [".agentflow/**", ".env"],
      acceptanceCriteria: ["The assigned Task is complete"],
      verificationCommands: ["npm test"],
      expectedOutputs: ["Code and passing tests"],
      requiresWorktree: false,
      workspace: { kind: "project", path: process.cwd() },
      resultSchema: "AgentFlow WorkerResult"
    }
  };
}

function completedResult(input: SpawnWorkerInput, summary: string): WorkerResult {
  const now = new Date().toISOString();
  return {
    workerId: input.workerId,
    taskId: input.taskId,
    status: "completed",
    summary,
    artifacts: [],
    changeSet: null,
    verification: [{ command: "npm test", status: "passed", summary, recordedAt: now }],
    risks: [],
    followUps: [],
    completedAt: now
  };
}
