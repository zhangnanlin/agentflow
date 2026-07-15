import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  AgentFlowError,
  JsonRunStore,
  defaultPipeline,
  sha256,
  validatePipeline,
  type Actor,
  type MutationContext,
  type RunState
} from "../src/index.js";

const supervisor: Actor = { id: "supervisor-1", kind: "supervisor" };
const user: Actor = { id: "user-1", kind: "user" };
const workerA: Actor = { id: "worker-a", kind: "worker" };
const workerB: Actor = { id: "worker-b", kind: "worker" };
const capabilities = {
  spawn: true,
  send: true,
  status: true,
  collect: true,
  interrupt: true,
  close: true
};

describe("AgentFlowEngine", () => {
  let directory: string;
  let engine: AgentFlowEngine;
  let keyCounter: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-test-"));
    engine = new AgentFlowEngine(new JsonRunStore(directory), defaultPipeline);
    keyCounter = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const context = (state: RunState, actor: Actor = supervisor, operation = "test"): MutationContext => ({
    expectedRevision: state.revision,
    idempotencyKey: `${operation}-${++keyCounter}`,
    actor
  });

  const artifact = async (
    state: RunState,
    stageId: string,
    kind: string,
    content = `${stageId}:${kind}`
  ): Promise<RunState> => engine.registerArtifact(state.id, {
    id: `${stageId.toLowerCase()}-${kind}`,
    stageId,
    kind,
    uri: `.agentflow/${stageId}/${kind}.json`,
    sha256: sha256(content),
    producedBy: "worker-a"
  }, context(state, workerA, "artifact"));

  const completeStage = async (state: RunState, stageId: string): Promise<RunState> => {
    const spec = defaultPipeline.stages.find((candidate) => candidate.id === stageId);
    if (!spec) throw new Error(`Unknown stage ${stageId}`);
    for (const kind of spec.requiredArtifactKinds) state = await artifact(state, stageId, kind);
    if (spec.requiredGate) {
      const actor = spec.requiredGate.type === "human" ? user : supervisor;
      state = await engine.resolveGate(state.id, {
        gateId: spec.requiredGate.id,
        decision: "approved",
        resolution: "approved in test"
      }, context(state, actor, "gate"));
    }
    return engine.completeStage(state.id, stageId, context(state, supervisor, "stage"));
  };

  it("creates a recoverable run with the first stage active", async () => {
    const state = await engine.createRun({ id: "run-create", requirement: "Build a project manager" });

    expect(state.revision).toBe(0);
    expect(state.activeStageId).toBe("S00");
    expect(state.stages.S00?.status).toBe("active");
    expect(state.gates["requirements-approved"]?.type).toBe("human");
    await expect(engine.loadRun(state.id)).resolves.toEqual(state);
  });

  it("rejects cyclic pipeline definitions", () => {
    expect(() => validatePipeline({
      id: "cycle",
      version: "1",
      name: "Cycle",
      stages: [
        { id: "A", name: "A", dependsOn: ["B"] },
        { id: "B", name: "B", dependsOn: ["A"] }
      ]
    })).toThrowError(expect.objectContaining({ code: "PIPELINE_CYCLE" }));
  });

  it("enforces optimistic revisions and makes retries idempotent", async () => {
    let state = await engine.createRun({ id: "run-revision", requirement: "Test revisions" });
    const mutation = context(state, supervisor, "create-task");
    state = await engine.createTask(state.id, {
      id: "task-1",
      stageId: "S00",
      title: "Inspect project"
    }, mutation);

    const retried = await engine.createTask(state.id, {
      id: "task-1",
      stageId: "S00",
      title: "Inspect project"
    }, mutation);
    expect(retried.revision).toBe(state.revision);

    await expect(engine.createTask(state.id, {
      id: "task-2",
      stageId: "S00",
      title: "Stale mutation"
    }, { ...mutation, idempotencyKey: "different-key" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("uses leases and prevents overlapping write scopes", async () => {
    let state = await engine.createRun({ id: "run-leases", requirement: "Parallel work" });
    state = await engine.createTask(state.id, {
      id: "task-a",
      stageId: "S00",
      title: "Write auth UI",
      writeScopes: ["src/auth/**"]
    }, context(state, supervisor, "task-a"));
    state = await engine.createTask(state.id, {
      id: "task-b",
      stageId: "S00",
      title: "Write nested auth form",
      writeScopes: ["src/auth/forms/**"]
    }, context(state, supervisor, "task-b"));
    state = await engine.claimTask(state.id, "task-a", workerA.id, 60, context(state, workerA, "claim-a"));

    await expect(engine.claimTask(state.id, "task-b", workerB.id, 60, context(state, workerB, "claim-b")))
      .rejects.toMatchObject({ code: "WRITE_SCOPE_CONFLICT" });
  });

  it("rejects a typed Task input when its Artifact kind changes without a hash change", async () => {
    let state = await engine.createRun({ id: "run-input-kind", requirement: "Keep typed inputs stable" });
    const hash = sha256("same bytes");
    state = await engine.registerArtifact(state.id, {
      id: "input-1",
      stageId: "S00",
      kind: "architecture",
      uri: ".agentflow/artifacts/input.json",
      sha256: hash,
      producedBy: workerA.id
    }, context(state, workerA, "register-typed-input"));
    await expect(engine.registerArtifact(state.id, {
      id: "input-1",
      stageId: "S01",
      kind: "architecture",
      uri: ".agentflow/artifacts/input.json",
      sha256: hash,
      producedBy: workerA.id
    }, context(state, workerA, "reject-artifact-stage-move"))).rejects.toMatchObject({
      code: "ARTIFACT_STAGE_IMMUTABLE",
      details: { artifactId: "input-1", previousStageId: "S00", nextStageId: "S01" }
    });
    state = await engine.createTask(state.id, {
      id: "typed-task",
      stageId: "S00",
      title: "Consume typed input",
      inputArtifactHashes: { "input-1": hash },
      inputArtifactKinds: { "input-1": "architecture" }
    }, context(state, supervisor, "create-typed-task"));
    state = await engine.registerArtifact(state.id, {
      id: "input-1",
      stageId: "S00",
      kind: "prd",
      uri: ".agentflow/artifacts/input.json",
      sha256: hash,
      producedBy: workerA.id
    }, context(state, workerA, "replace-typed-input-kind"));

    await expect(engine.claimTask(
      state.id,
      "typed-task",
      workerA.id,
      60,
      context(state, workerA, "claim-wrong-kind")
    )).rejects.toMatchObject({
      code: "TASK_INPUT_STALE",
      details: { artifactId: "input-1", expectedKind: "architecture", actualKind: "prd" }
    });
    expect(state.events.find((event) => event.type === "artifact.invalidated-downstream")?.data).toMatchObject({
      artifactId: "input-1",
      previousKind: "architecture",
      nextKind: "prd"
    });
  });

  it("requires passing verification before completing a task", async () => {
    let state = await engine.createRun({ id: "run-verification", requirement: "Verified work" });
    state = await engine.createTask(state.id, {
      id: "task-verified",
      stageId: "S00",
      title: "Implement safely",
      verificationCommands: ["npm test", "npm run typecheck"]
    }, context(state, supervisor, "create"));
    state = await engine.claimTask(state.id, "task-verified", workerA.id, 60, context(state, workerA, "claim"));

    await expect(engine.completeTask(state.id, "task-verified", workerA.id, [], {}, context(state, workerA, "bad-complete")))
      .rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" });

    await expect(engine.completeTask(state.id, "task-verified", workerA.id, [{
      command: "echo ok",
      status: "passed",
      summary: "An unrelated command passed",
      recordedAt: new Date().toISOString()
    }], {}, context(state, workerA, "wrong-command"))).rejects.toMatchObject({
      code: "VERIFICATION_COMMAND_MISSING",
      details: { missingCommands: ["npm test", "npm run typecheck"] }
    });

    state = await engine.completeTask(state.id, "task-verified", workerA.id, [
      {
        command: "npm test",
        status: "passed",
        summary: "All tests passed",
        recordedAt: new Date().toISOString()
      },
      {
        command: "npm run typecheck",
        status: "passed",
        summary: "TypeScript checks passed",
        recordedAt: new Date().toISOString()
      }
    ], { commit: "abc123" }, context(state, workerA, "complete"));
    expect(state.tasks["task-verified"]?.status).toBe("completed");
    expect(state.tasks["task-verified"]?.lease).toBeUndefined();
  });

  it("persists a native worker binding and atomically collects its result", async () => {
    let state = await engine.createRun({ id: "run-worker", requirement: "Run a native worker" });
    state = await engine.createTask(state.id, {
      id: "task-native",
      stageId: "S00",
      title: "Implement through a native thread",
      writeScopes: ["src/native/**"]
    }, context(state, supervisor, "create-native"));
    state = await engine.claimTask(state.id, "task-native", workerA.id, 60, context(state, workerA, "claim-native"));
    state = await engine.prepareWorker(state.id, {
      workerId: workerA.id,
      taskId: "task-native",
      adapter: "codex",
      hostTaskName: "run-worker-task-native-worker-a",
      promptHash: sha256("bounded worker prompt"),
      capabilities
    }, context(state, supervisor, "prepare-native"));
    expect(state.workers[workerA.id]).toMatchObject({ status: "prepared", taskId: "task-native" });
    expect(state.workers[workerA.id]?.externalThreadId).toBeUndefined();

    state = await engine.loadRun(state.id);
    state = await engine.bindWorker(state.id, workerA.id, "codex-thread-123", context(state, supervisor, "bind-native"));
    expect(state.workers[workerA.id]).toMatchObject({
      status: "running",
      externalThreadId: "codex-thread-123"
    });

    state = await engine.collectWorkerResult(state.id, workerA.id, {
      workerId: workerA.id,
      taskId: "task-native",
      status: "completed",
      summary: "Implemented the native integration.",
      artifacts: [],
      changeSet: null,
      verification: [{
        command: "npm test",
        status: "passed",
        summary: "All tests passed",
        recordedAt: new Date().toISOString()
      }],
      risks: [],
      followUps: [],
      completedAt: new Date().toISOString()
    }, context(state, workerA, "collect-native"));

    expect(state.workers[workerA.id]?.status).toBe("completed");
    expect(state.tasks["task-native"]).toMatchObject({ status: "completed", owner: workerA.id });
    expect(state.tasks["task-native"]?.lease).toBeUndefined();
  });

  it("returns an interrupted task to the ready queue for a fresh worker", async () => {
    let state = await engine.createRun({ id: "run-interrupt", requirement: "Retry an interrupted worker" });
    state = await engine.createTask(state.id, {
      id: "task-retry",
      stageId: "S00",
      title: "Retry safely"
    }, context(state, supervisor, "create-retry"));
    state = await engine.claimTask(state.id, "task-retry", workerA.id, 60, context(state, workerA, "claim-first"));
    state = await engine.prepareWorker(state.id, {
      workerId: workerA.id,
      taskId: "task-retry",
      adapter: "codex",
      hostTaskName: "run-interrupt-task-retry-worker-a",
      promptHash: sha256("first prompt"),
      capabilities
    }, context(state, supervisor, "prepare-first"));
    state = await engine.bindWorker(state.id, workerA.id, "codex-thread-first", context(state, supervisor, "bind-first"));
    state = await engine.interruptWorker(
      state.id,
      workerA.id,
      "The worker used a stale contract",
      context(state, supervisor, "interrupt-first")
    );

    expect(state.workers[workerA.id]?.status).toBe("interrupted");
    expect(state.tasks["task-retry"]).toMatchObject({ status: "ready" });
    expect(state.tasks["task-retry"]?.owner).toBeUndefined();
    state = await engine.claimTask(state.id, "task-retry", workerB.id, 60, context(state, workerB, "claim-second"));
    expect(state.tasks["task-retry"]?.owner).toBe(workerB.id);
  });

  it("records a host failure and retries the task without fabricating a worker result", async () => {
    let state = await engine.createRun({ id: "run-host-failure", requirement: "Recover a failed native spawn" });
    state = await engine.createTask(state.id, {
      id: "task-host-failure",
      stageId: "S00",
      title: "Dispatch through the host"
    }, context(state, supervisor, "create-host-failure"));
    state = await engine.claimTask(
      state.id,
      "task-host-failure",
      workerA.id,
      60,
      context(state, workerA, "claim-host-failure")
    );
    state = await engine.prepareWorker(state.id, {
      workerId: workerA.id,
      taskId: "task-host-failure",
      adapter: "codex",
      hostTaskName: "run-host-failure-task-worker-a",
      promptHash: sha256("prompt that could not be spawned"),
      capabilities
    }, context(state, supervisor, "prepare-host-failure"));
    state = await engine.failWorker(
      state.id,
      workerA.id,
      "Codex native spawn returned an error",
      context(state, supervisor, "fail-host-worker")
    );
    expect(state.workers[workerA.id]?.status).toBe("failed");
    expect(state.workers[workerA.id]?.result).toBeUndefined();
    expect(state.tasks["task-host-failure"]?.status).toBe("failed");

    state = await engine.retryTask(
      state.id,
      "task-host-failure",
      "Retry with a fresh native Worker ID",
      context(state, supervisor, "retry-host-task")
    );
    expect(state.tasks["task-host-failure"]?.status).toBe("ready");
    expect(state.tasks["task-host-failure"]?.owner).toBeUndefined();
    state = await engine.claimTask(
      state.id,
      "task-host-failure",
      workerB.id,
      60,
      context(state, workerB, "claim-host-retry")
    );
    expect(state.tasks["task-host-failure"]?.owner).toBe(workerB.id);
  });

  it("enforces native adapter capability degradation in Core", async () => {
    let state = await engine.createRun({ id: "run-capabilities", requirement: "Respect host capabilities" });
    state = await engine.createTask(state.id, {
      id: "task-capabilities",
      stageId: "S00",
      title: "Use a limited host"
    }, context(state, supervisor, "create-capabilities"));
    state = await engine.claimTask(
      state.id,
      "task-capabilities",
      workerA.id,
      60,
      context(state, workerA, "claim-capabilities")
    );
    state = await engine.prepareWorker(state.id, {
      workerId: workerA.id,
      taskId: "task-capabilities",
      adapter: "codex",
      hostTaskName: "run-capabilities-worker-a",
      promptHash: sha256("limited host prompt"),
      capabilities: { ...capabilities, interrupt: false, close: false }
    }, context(state, supervisor, "prepare-capabilities"));
    state = await engine.bindWorker(
      state.id,
      workerA.id,
      "codex-limited-thread",
      context(state, supervisor, "bind-capabilities")
    );

    await expect(engine.interruptWorker(
      state.id,
      workerA.id,
      "unsupported interrupt",
      context(state, supervisor, "interrupt-capabilities")
    )).rejects.toMatchObject({ code: "WORKER_CAPABILITY_UNAVAILABLE" });
    state = await engine.failWorker(
      state.id,
      workerA.id,
      "native task ended without a valid result",
      context(state, supervisor, "fail-capabilities")
    );
    await expect(engine.closeWorker(
      state.id,
      workerA.id,
      "unsupported close",
      context(state, supervisor, "close-capabilities")
    )).rejects.toMatchObject({ code: "WORKER_CAPABILITY_UNAVAILABLE" });
  });

  it("serializes Figma writes with an exclusive resource and operation mutex", async () => {
    let state = await engine.createRun({ id: "run-figma-lock", requirement: "Serialize Figma writers" });
    for (const [taskId, worker] of [["figma-a", workerA], ["figma-b", workerB]] as const) {
      state = await engine.createTask(state.id, {
        id: taskId,
        stageId: "S00",
        title: `Write Figma through ${worker.id}`
      }, context(state, supervisor, `create-${taskId}`));
      state = await engine.claimTask(state.id, taskId, worker.id, 60, context(state, worker, `claim-${taskId}`));
      state = await engine.prepareWorker(state.id, {
        workerId: worker.id,
        taskId,
        adapter: "codex",
        hostTaskName: `run-figma-lock-${taskId}`,
        promptHash: sha256(`${taskId}-prompt`),
        capabilities
      }, context(state, supervisor, `prepare-${taskId}`));
      state = await engine.bindWorker(
        state.id,
        worker.id,
        `codex-thread-${taskId}`,
        context(state, supervisor, `bind-${taskId}`)
      );
    }

    state = await engine.acquireResource(state.id, {
      resourceId: "figma-main",
      kind: "figma-file",
      resourceKey: "figma-file-key-123",
      stageId: "S00",
      taskId: "figma-a",
      owner: workerA.id,
      leaseSeconds: 60,
      metadata: { fileKey: "figma-file-key-123" }
    }, context(state, workerA, "acquire-figma-a"));

    await expect(engine.acquireResource(state.id, {
      resourceId: "figma-other",
      kind: "figma-file",
      resourceKey: "figma-file-key-123",
      stageId: "S00",
      taskId: "figma-b",
      owner: workerB.id,
      leaseSeconds: 60
    }, context(state, workerB, "acquire-figma-b-conflict"))).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });

    state = await engine.beginResourceOperation(
      state.id,
      "figma-main",
      workerA.id,
      "figma-op-1",
      "figma.use_figma.write",
      context(state, workerA, "begin-figma-op-1")
    );
    await expect(engine.beginResourceOperation(
      state.id,
      "figma-main",
      workerA.id,
      "figma-op-2",
      "figma.use_figma.write",
      context(state, workerA, "begin-figma-op-2-conflict")
    )).rejects.toMatchObject({ code: "RESOURCE_OPERATION_ACTIVE" });

    state = await engine.finishResourceOperation(state.id, "figma-main", workerA.id, {
      operationId: "figma-op-1",
      status: "completed",
      resultHash: sha256("created node ids: 1:2,1:3"),
      affectedNodeIds: ["1:2", "1:3"],
      summary: "Created concept A page"
    }, context(state, workerA, "finish-figma-op-1"));
    expect(state.resources["figma-main"]?.operations[0]).toMatchObject({
      status: "completed",
      affectedNodeIds: ["1:2", "1:3"]
    });
    expect(state.resources["figma-main"]?.activeOperationId).toBeUndefined();

    state = await engine.rekeyResource(
      state.id,
      "figma-main",
      workerA.id,
      "figma-file-key-confirmed",
      context(state, workerA, "rekey-figma-file")
    );
    expect(state.resources["figma-main"]?.resourceKey).toBe("figma-file-key-confirmed");

    state = await engine.releaseResource(
      state.id,
      "figma-main",
      workerA.id,
      "Concept writer finished",
      context(state, workerA, "release-figma-a")
    );
    state = await engine.acquireResource(state.id, {
      resourceId: "figma-other",
      kind: "figma-file",
      resourceKey: "figma-file-key-confirmed",
      stageId: "S00",
      taskId: "figma-b",
      owner: workerB.id,
      leaseSeconds: 60
    }, context(state, workerB, "acquire-figma-b"));
    expect(state.resources["figma-main"]?.status).toBe("released");
    expect(state.resources["figma-other"]).toMatchObject({ status: "active", owner: workerB.id });
  });

  it("requires a user actor and required artifacts for human gates", async () => {
    let state = await engine.createRun({ id: "run-gate", requirement: "Approve requirements" });
    state = await completeStage(state, "S00");
    state = await completeStage(state, "S01");

    await expect(engine.resolveGate(state.id, {
      gateId: "requirements-approved",
      decision: "approved",
      resolution: "supervisor tried"
    }, context(state, supervisor, "wrong-actor"))).rejects.toMatchObject({ code: "HUMAN_GATE_REQUIRES_USER" });

    await expect(engine.resolveGate(state.id, {
      gateId: "requirements-approved",
      decision: "approved",
      resolution: "missing PRD"
    }, context(state, user, "missing-artifact"))).rejects.toMatchObject({ code: "GATE_ARTIFACT_MISSING" });

    state = await artifact(state, "S02", "prd");
    state = await engine.resolveGate(state.id, {
      gateId: "requirements-approved",
      decision: "approved",
      resolution: "scope approved"
    }, context(state, user, "approve"));
    state = await engine.completeStage(state.id, "S02", context(state, supervisor, "complete-stage"));
    expect(state.activeStageId).toBe("S03");
  });

  it("requires a structured choice for the design direction gate", async () => {
    let state = await engine.createRun({ id: "run-design-choice", requirement: "Choose one design direction" });
    state = await completeStage(state, "S00");
    state = await completeStage(state, "S01");
    state = await completeStage(state, "S02");
    state = await completeStage(state, "S03");
    state = await artifact(state, "S04", "design-concepts");

    await expect(engine.resolveGate(state.id, {
      gateId: "design-direction-approved",
      decision: "approved",
      resolution: "Direction looks good"
    }, context(state, user, "approve-without-choice"))).rejects.toMatchObject({ code: "GATE_CHOICE_REQUIRED" });

    state = await engine.resolveGate(state.id, {
      gateId: "design-direction-approved",
      decision: "approved",
      choice: "B",
      resolution: "Choose the denser direction"
    }, context(state, user, "approve-choice-b"));
    expect(state.gates["design-direction-approved"]).toMatchObject({
      status: "approved",
      selectedOption: "B"
    });
  });

  it("reopens an approved stage and invalidates downstream work when an artifact changes", async () => {
    let state = await engine.createRun({ id: "run-invalidate", requirement: "Invalidate downstream" });
    state = await completeStage(state, "S00");
    state = await completeStage(state, "S01");
    state = await completeStage(state, "S02");
    expect(state.activeStageId).toBe("S03");

    const previousPrdHash = state.artifacts["s02-prd"]?.sha256;
    if (!previousPrdHash) throw new Error("Expected the PRD artifact");
    state = await engine.createTask(state.id, {
      id: "ux-task",
      stageId: "S03",
      title: "Produce UX architecture",
      inputArtifactHashes: { "s02-prd": previousPrdHash }
    }, context(state, supervisor, "create-ux"));
    state = await engine.claimTask(state.id, "ux-task", workerA.id, 60, context(state, workerA, "claim-ux"));
    state = await engine.completeTask(state.id, "ux-task", workerA.id, [{
      command: "npm test",
      status: "passed",
      summary: "UX contract verified",
      recordedAt: new Date().toISOString()
    }], {}, context(state, workerA, "complete-ux"));
    state = await completeStage(state, "S03");
    expect(state.activeStageId).toBe("S04");

    const nextPrdHash = sha256("changed requirements");

    state = await engine.registerArtifact(state.id, {
      id: "s02-prd",
      stageId: "S02",
      kind: "prd",
      uri: ".agentflow/S02/prd.json",
      sha256: nextPrdHash,
      producedBy: workerA.id
    }, context(state, workerA, "change-prd"));

    expect(state.gates["requirements-approved"]?.status).toBe("stale");
    expect(state.stages.S02?.status).toBe("active");
    expect(state.stages.S03?.status).toBe("stale");
    expect(state.stages.S04?.status).toBe("stale");
    expect(state.tasks["ux-task"]).toMatchObject({
      status: "pending",
      inputArtifactHashes: { "s02-prd": nextPrdHash },
      verification: []
    });
    expect(state.tasks["ux-task"]?.owner).toBeUndefined();
    expect(state.artifacts["s03-ux-architecture"]?.stale).toBe(true);
    expect(state.activeStageId).toBe("S02");

    state = await engine.resolveGate(state.id, {
      gateId: "requirements-approved",
      decision: "approved",
      resolution: "approved changed requirements"
    }, context(state, user, "reapprove-prd"));
    state = await engine.completeStage(state.id, "S02", context(state, supervisor, "recomplete-prd"));
    expect(state.tasks["ux-task"]?.status).toBe("ready");
    await expect(engine.claimTask(
      state.id,
      "ux-task",
      workerB.id,
      60,
      context(state, workerB, "reclaim-ux")
    )).resolves.toMatchObject({
      tasks: { "ux-task": { status: "running", owner: workerB.id } }
    });
  });

  it("does not allow tasks from future stages to be claimed", async () => {
    let state = await engine.createRun({ id: "run-future", requirement: "Future task" });
    state = await engine.createTask(state.id, {
      id: "future-task",
      stageId: "S01",
      title: "Do discovery early"
    }, context(state, supervisor, "create-future"));
    expect(state.tasks["future-task"]?.status).toBe("pending");
    await expect(engine.claimTask(state.id, "future-task", workerA.id, 60, context(state, workerA, "claim-future")))
      .rejects.toMatchObject({ code: "TASK_STAGE_NOT_ACTIVE" });
  });
});

describe("AgentFlowError", () => {
  it("keeps a stable machine-readable code", () => {
    const error = new AgentFlowError("Nope", "NOPE", { value: 1 });
    expect(error.code).toBe("NOPE");
    expect(error.details).toEqual({ value: 1 });
  });
});
