import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  defaultPipeline,
  type Actor,
  type MutationContext,
  type RunState,
  type ThreadCapabilities
} from "../src/index.js";

const supervisor: Actor = { id: "supervisor-1", kind: "supervisor" };
const capabilities: ThreadCapabilities = {
  spawn: true,
  send: true,
  status: true,
  collect: true,
  interrupt: true,
  close: false
};

describe("atomic Task dispatch preparation", () => {
  const directories: string[] = [];
  let keyCounter = 0;

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const context = (state: RunState, operation: string): MutationContext => ({
    expectedRevision: state.revision,
    idempotencyKey: `${operation}-${++keyCounter}`,
    actor: supervisor,
    reason: `dispatch test: ${operation}`
  });

  const setup = async (id: string): Promise<{ engine: AgentFlowEngine; state: RunState; projectRoot: string }> => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-dispatch-"));
    directories.push(directory);
    const engine = new AgentFlowEngine(new JsonRunStore(join(directory, "runs")), defaultPipeline);
    const state = await engine.createRun({ id, requirement: "Prepare a native Worker" });
    return { engine, state, projectRoot: directory };
  };

  it("claims the Task, binds its workspace, and persists a prepared Worker in one revision", async () => {
    const { engine, projectRoot } = await setup("run-dispatch");
    let state = await engine.loadRun("run-dispatch");
    state = await engine.createTask(state.id, {
      id: "task-1",
      stageId: "S00",
      title: "Inspect the project",
      description: "Return a bounded project inspection.",
      profile: "analysis",
      writeScopes: ["docs/**"],
      acceptanceCriteria: ["The project boundary is recorded"],
      verificationCommands: ["npm test"],
      expectedOutputs: ["Inspection summary"]
    }, context(state, "create-task"));

    const mutation = context(state, "prepare-dispatch");
    state = await engine.prepareTaskDispatch(state.id, {
      workerId: "worker-1",
      taskId: "task-1",
      adapter: "codex",
      hostTaskName: "run_dispatch_task_1_worker_1_1234567890",
      promptHash: "a".repeat(64),
      capabilities,
      leaseSeconds: 900,
      workspace: { kind: "project", path: projectRoot }
    }, mutation);

    expect(state.revision).toBe(2);
    expect(state.tasks["task-1"]).toMatchObject({
      status: "running",
      owner: "worker-1",
      workspace: { kind: "project", path: projectRoot }
    });
    expect(state.workers["worker-1"]).toMatchObject({
      status: "prepared",
      taskId: "task-1",
      adapter: "codex",
      promptHash: "a".repeat(64)
    });
    expect(state.events.slice(-2).map((event) => event.type)).toEqual(["task.claimed", "worker.prepared"]);

    const retried = await engine.prepareTaskDispatch(state.id, {
      workerId: "worker-1",
      taskId: "task-1",
      adapter: "codex",
      hostTaskName: "run_dispatch_task_1_worker_1_1234567890",
      promptHash: "a".repeat(64),
      capabilities,
      leaseSeconds: 900,
      workspace: { kind: "project", path: projectRoot }
    }, mutation);
    expect(retried.revision).toBe(state.revision);
  });

  it("requires a real worktree binding and prevents concurrent workspace reuse", async () => {
    const { engine, projectRoot } = await setup("run-worktree-dispatch");
    let state = await engine.loadRun("run-worktree-dispatch");
    for (const taskId of ["task-a", "task-b"]) {
      state = await engine.createTask(state.id, {
        id: taskId,
        stageId: "S00",
        title: `Implement ${taskId}`,
        description: "Implement in an isolated workspace.",
        profile: "backend",
        writeScopes: [`packages/${taskId}/**`],
        acceptanceCriteria: ["The assigned change is complete"],
        verificationCommands: ["npm test"],
        expectedOutputs: ["Code and tests"],
        requiresWorktree: true
      }, context(state, `create-${taskId}`));
    }

    state = await engine.claimTask(
      state.id,
      "task-a",
      "worker-a",
      900,
      context(state, "claim-task-a-for-worktree-setup")
    );
    await expect(engine.prepareWorker(state.id, {
      workerId: "worker-a",
      taskId: "task-a",
      adapter: "codex",
      hostTaskName: "legacy_worktree_bypass",
      promptHash: "a".repeat(64),
      capabilities
    }, context(state, "reject-legacy-worktree-bypass"))).rejects.toMatchObject({
      code: "TASK_WORKTREE_REQUIRED"
    });
    state = await engine.abortTaskSetup(
      state.id,
      "task-a",
      "worker-a",
      "The legacy path could not bind a verified worktree.",
      context(state, "abort-failed-worktree-setup")
    );
    expect(state.tasks["task-a"]).toMatchObject({ status: "ready" });
    expect(state.tasks["task-a"]?.owner).toBeUndefined();

    await expect(engine.prepareTaskDispatch(state.id, {
      workerId: "worker-a",
      taskId: "task-a",
      adapter: "codex",
      hostTaskName: "task_a_worker_a",
      promptHash: "a".repeat(64),
      capabilities,
      leaseSeconds: 900,
      workspace: { kind: "project", path: projectRoot }
    }, context(state, "reject-shared-project"))).rejects.toMatchObject({ code: "TASK_WORKTREE_REQUIRED" });
    expect((await engine.loadRun(state.id)).workers).toEqual({});

    const worktreePath = join(projectRoot, ".worktrees", "task-a");
    state = await engine.prepareTaskDispatch(state.id, {
      workerId: "worker-a",
      taskId: "task-a",
      adapter: "codex",
      hostTaskName: "task_a_worker_a",
      promptHash: "a".repeat(64),
      capabilities,
      leaseSeconds: 900,
      workspace: {
        kind: "worktree",
        path: worktreePath,
        branch: "agentflow/task-a",
        baseRevision: "b".repeat(40)
      }
    }, context(state, "prepare-task-a"));

    await expect(engine.prepareTaskDispatch(state.id, {
      workerId: "worker-b",
      taskId: "task-b",
      adapter: "codex",
      hostTaskName: "task_b_worker_b",
      promptHash: "b".repeat(64),
      capabilities,
      leaseSeconds: 900,
      workspace: {
        kind: "worktree",
        path: worktreePath,
        branch: "agentflow/task-b",
        baseRevision: "b".repeat(40)
      }
    }, context(state, "reject-worktree-reuse"))).rejects.toMatchObject({
      code: "TASK_WORKSPACE_CONFLICT",
      details: { taskId: "task-b", conflictingTaskId: "task-a", path: worktreePath }
    });
    const persisted = await engine.loadRun(state.id);
    expect(persisted.tasks["task-b"]?.status).toBe("ready");
    expect(persisted.workers["worker-b"]).toBeUndefined();

    state = await engine.bindWorker(
      persisted.id,
      "worker-a",
      "codex-worktree-thread-a",
      context(persisted, "bind-task-a")
    );
    const completedAt = new Date().toISOString();
    const result = {
      workerId: "worker-a",
      taskId: "task-a",
      status: "completed" as const,
      summary: "Implemented task-a in its isolated worktree.",
      artifacts: [],
      verification: [{
        command: "npm test",
        status: "passed" as const,
        summary: "Task verification passed",
        recordedAt: completedAt
      }],
      risks: [],
      followUps: [],
      completedAt
    };
    await expect(engine.collectWorkerResult(
      state.id,
      "worker-a",
      { ...result, changeSet: null },
      context(state, "reject-missing-change-set")
    )).rejects.toMatchObject({ code: "WORKER_CHANGESET_REQUIRED" });
    await expect(engine.collectWorkerResult(state.id, "worker-a", {
      ...result,
      changeSet: {
        kind: "git-commits",
        baseRevision: "b".repeat(40),
        headRevision: "c".repeat(40),
        revisions: ["c".repeat(40)],
        changedPaths: ["packages/task-b/index.ts"]
      }
    }, context(state, "reject-out-of-scope-change"))).rejects.toMatchObject({
      code: "WORKER_CHANGESET_PATH_FORBIDDEN"
    });

    state = await engine.collectWorkerResult(state.id, "worker-a", {
      ...result,
      changeSet: {
        kind: "git-commits",
        baseRevision: "b".repeat(40),
        headRevision: "c".repeat(40),
        revisions: ["c".repeat(40)],
        changedPaths: ["packages/task-a/index.ts"]
      }
    }, context(state, "collect-task-a"));
    expect(state.tasks["task-a"]?.result).toMatchObject({
      changeSet: { headRevision: "c".repeat(40), changedPaths: ["packages/task-a/index.ts"] }
    });
  });
});
