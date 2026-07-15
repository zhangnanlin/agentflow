import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  artifactPayloadHash,
  sha256,
  validatePipeline,
  type Actor,
  type ImplementationPlanContract,
  type MutationContext,
  type RunState
} from "../src/index.js";

const pipeline = validatePipeline({
  id: "materialization-pipeline",
  version: "1",
  name: "Implementation plan materialization",
  stages: [
    {
      id: "S10",
      name: "Engineering Plan",
      requiredArtifactKinds: ["implementation-plan"],
      requiredGate: {
        id: "engineering-plan-approved",
        type: "human",
        question: "Approve the implementation plan?",
        options: ["approve", "reject"]
      }
    },
    { id: "S11", name: "Implementation", dependsOn: ["S10"] }
  ]
});

const supervisor: Actor = { id: "supervisor-1", kind: "supervisor" };
const user: Actor = { id: "user-1", kind: "user" };

describe("implementation plan materialization", () => {
  const directories: string[] = [];
  let keyCounter = 0;

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const context = (state: RunState, actor: Actor, operation: string): MutationContext => ({
    expectedRevision: state.revision,
    idempotencyKey: `${operation}-${++keyCounter}`,
    actor,
    reason: `materialization test: ${operation}`
  });

  const createEngine = async (): Promise<AgentFlowEngine> => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-materialize-"));
    directories.push(directory);
    return new AgentFlowEngine(new JsonRunStore(directory), pipeline);
  };

  const prepareImplementationStage = async (
    engine: AgentFlowEngine,
    runId: string,
    plan: ImplementationPlanContract
  ): Promise<{ state: RunState; planHash: string }> => {
    let state = await engine.createRun({ id: runId, requirement: "Materialize an approved plan", hasUi: false });
    state = await engine.registerArtifact(state.id, {
      id: "architecture-1",
      stageId: "S10",
      kind: "architecture",
      uri: ".agentflow/artifacts/architecture.json",
      sha256: plan.sourceArchitecture.sha256,
      producedBy: "architect"
    }, context(state, supervisor, "register-architecture"));
    state = await engine.registerArtifact(state.id, {
      id: "prd-1",
      stageId: "S10",
      kind: "prd",
      uri: ".agentflow/artifacts/prd.json",
      sha256: plan.sourcePrd.sha256,
      producedBy: "product"
    }, context(state, supervisor, "register-prd"));
    const planHash = artifactPayloadHash("implementation-plan", plan);
    state = await engine.registerArtifact(state.id, {
      id: "implementation-plan-1",
      stageId: "S10",
      kind: "implementation-plan",
      uri: ".agentflow/artifacts/implementation-plan.json",
      sha256: planHash,
      producedBy: "planner"
    }, context(state, supervisor, "register-plan"));
    state = await engine.resolveGate(state.id, {
      gateId: "engineering-plan-approved",
      decision: "approved",
      resolution: "The user approved this exact plan."
    }, context(state, user, "approve-plan"));
    state = await engine.completeStage(state.id, "S10", context(state, supervisor, "complete-plan-stage"));
    return { state, planHash };
  };

  it("atomically creates a recoverable S11 DAG and makes retries idempotent", async () => {
    const engine = await createEngine();
    const plan = implementationPlan();
    let { state, planHash } = await prepareImplementationStage(engine, "run-materialize", plan);

    const wrongPayload = { ...plan, summary: "A payload with a different deterministic hash." };
    await expect(engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan: wrongPayload
    }, context(state, supervisor, "wrong-plan"))).rejects.toMatchObject({ code: "PLAN_ARTIFACT_INVALID" });
    expect((await engine.loadRun(state.id)).tasks).toEqual({});

    const mutation = context(state, supervisor, "materialize-plan");
    state = await engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan
    }, mutation);
    expect(state.tasks["task-contract"]).toMatchObject({
      status: "ready",
      profile: "backend",
      waveId: "wave-contract",
      verificationCommands: ["npm test -- contract"],
      requiresWorktree: false,
      materializedFrom: {
        artifactId: "implementation-plan-1",
        kind: "implementation-plan",
        sha256: planHash
      },
      inputArtifactKinds: {
        "architecture-1": "architecture",
        "implementation-plan-1": "implementation-plan"
      }
    });
    expect(state.tasks["task-client"]?.status).toBe("pending");
    expect(state.events.at(-1)?.type).toBe("implementation-plan.materialized");

    const retried = await engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan
    }, mutation);
    expect(retried.revision).toBe(state.revision);

    await expect(engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan
    }, context(state, supervisor, "duplicate-plan"))).rejects.toMatchObject({ code: "PLAN_ALREADY_MATERIALIZED" });

    const workerId = "worker-contract";
    state = await engine.claimTask(
      state.id,
      "task-contract",
      workerId,
      60,
      context(state, { id: workerId, kind: "worker" }, "claim-contract")
    );
    await expect(engine.completeTask(state.id, "task-contract", workerId, [{
      command: "npm test -- contract",
      status: "passed",
      summary: "A direct completion tried to bypass WorkerResult",
      recordedAt: new Date().toISOString()
    }], {}, context(state, { id: workerId, kind: "worker" }, "reject-direct-complete")))
      .rejects.toMatchObject({ code: "TASK_WORKER_RESULT_REQUIRED" });
    state = await engine.prepareTaskDispatch(state.id, {
      workerId,
      taskId: "task-contract",
      adapter: "codex",
      hostTaskName: "materialized_contract_worker",
      promptHash: "c".repeat(64),
      capabilities: { spawn: true, send: true, status: true, collect: true, interrupt: true, close: false },
      leaseSeconds: 60,
      workspace: { kind: "project", path: join(tmpdir(), "agentflow-materialization-workspace") }
    }, context(state, supervisor, "prepare-contract"));
    state = await engine.bindWorker(
      state.id,
      workerId,
      "codex-contract-thread",
      context(state, supervisor, "bind-contract")
    );
    const completedAt = new Date().toISOString();
    state = await engine.collectWorkerResult(state.id, workerId, {
      workerId,
      taskId: "task-contract",
      status: "completed",
      summary: "Contract implemented",
      artifacts: [],
      changeSet: {
        kind: "git-commits",
        baseRevision: plan.repository.baseRevision,
        headRevision: "c".repeat(64),
        revisions: ["c".repeat(64)],
        changedPaths: ["packages/contracts/index.ts"]
      },
      verification: [{
        command: "npm test -- contract",
        status: "passed",
        summary: "Contract tests passed",
        recordedAt: completedAt
      }],
      risks: [],
      followUps: [],
      completedAt
    }, context(state, supervisor, "collect-contract"));
    expect(state.tasks["task-client"]?.status).toBe("ready");
  });

  it("cancels an invalidated generation and rematerializes only after renewed approval", async () => {
    const engine = await createEngine();
    const originalPlan = implementationPlan();
    let { state } = await prepareImplementationStage(engine, "run-rematerialize", originalPlan);
    state = await engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan: originalPlan
    }, context(state, supervisor, "materialize-original"));

    const revisedPlan = implementationPlan("Implement the revised shared contract first.");
    const revisedHash = artifactPayloadHash("implementation-plan", revisedPlan);
    state = await engine.registerArtifact(state.id, {
      id: "implementation-plan-1",
      stageId: "S10",
      kind: "implementation-plan",
      uri: ".agentflow/artifacts/implementation-plan.json",
      sha256: revisedHash,
      producedBy: "planner"
    }, context(state, supervisor, "replace-plan"));
    expect(state.tasks["task-contract"]?.status).toBe("cancelled");
    expect(state.tasks["task-client"]?.status).toBe("cancelled");
    expect(state.gates["engineering-plan-approved"]?.status).toBe("stale");
    expect(state.activeStageId).toBe("S10");

    await expect(engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan: revisedPlan
    }, context(state, supervisor, "materialize-before-reapproval")))
      .rejects.toMatchObject({ code: "PLAN_TARGET_STAGE_NOT_ACTIVE" });

    state = await engine.resolveGate(state.id, {
      gateId: "engineering-plan-approved",
      decision: "approved",
      resolution: "The user approved the revised plan."
    }, context(state, user, "approve-revised-plan"));
    state = await engine.completeStage(state.id, "S10", context(state, supervisor, "complete-revised-plan"));
    state = await engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan: revisedPlan
    }, context(state, supervisor, "materialize-revised"));

    expect(state.tasks["task-contract"]).toMatchObject({
      description: "Implement the revised shared contract first.",
      status: "ready",
      materializedFrom: { sha256: revisedHash }
    });
    expect(state.tasks["task-client"]?.status).toBe("pending");
  });

  it("rejects an implementation plan from a Stage without a human approval Gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-materialize-no-gate-"));
    directories.push(directory);
    const noGatePipeline = validatePipeline({
      id: "materialization-no-gate",
      version: "1",
      name: "Reject an unapproved implementation plan",
      stages: [
        { id: "S10", name: "Planning", requiredArtifactKinds: ["implementation-plan"] },
        { id: "S11", name: "Implementation", dependsOn: ["S10"] }
      ]
    });
    const engine = new AgentFlowEngine(new JsonRunStore(directory), noGatePipeline);
    const plan = implementationPlan();
    let state = await engine.createRun({ id: "run-no-plan-gate", requirement: "Reject an unapproved plan" });
    state = await engine.registerArtifact(state.id, {
      id: "architecture-1",
      stageId: "S10",
      kind: "architecture",
      uri: "architecture.json",
      sha256: plan.sourceArchitecture.sha256,
      producedBy: "architect"
    }, context(state, supervisor, "no-gate-architecture"));
    state = await engine.registerArtifact(state.id, {
      id: "prd-1",
      stageId: "S10",
      kind: "prd",
      uri: "prd.json",
      sha256: plan.sourcePrd.sha256,
      producedBy: "product"
    }, context(state, supervisor, "no-gate-prd"));
    state = await engine.registerArtifact(state.id, {
      id: "implementation-plan-1",
      stageId: "S10",
      kind: "implementation-plan",
      uri: "implementation-plan.json",
      sha256: artifactPayloadHash("implementation-plan", plan),
      producedBy: "planner"
    }, context(state, supervisor, "no-gate-plan"));
    state = await engine.completeStage(state.id, "S10", context(state, supervisor, "complete-no-gate-stage"));

    await expect(engine.materializeImplementationPlan(state.id, {
      artifactId: "implementation-plan-1",
      targetStageId: "S11",
      plan
    }, context(state, supervisor, "reject-no-gate-plan"))).rejects.toMatchObject({
      code: "PLAN_GATE_UNAPPROVED"
    });
    expect((await engine.loadRun(state.id)).tasks).toEqual({});
  });
});

function implementationPlan(contractDescription = "Implement the shared contract first."): ImplementationPlanContract {
  const architectureHash = sha256("architecture");
  const prdHash = sha256("prd");
  return {
    version: 1,
    title: "Materialized implementation plan",
    summary: "Build a shared contract before its client.",
    sourceArchitecture: { artifactId: "architecture-1", sha256: architectureHash },
    sourcePrd: { artifactId: "prd-1", sha256: prdHash },
    repository: { branch: "main", baseRevision: sha256("base-revision") },
    scope: { requirementIds: ["fr-1"], componentIds: ["contract", "client"] },
    tasks: [
      {
        id: "task-contract",
        title: "Implement shared contract",
        description: contractDescription,
        profile: "backend",
        componentIds: ["contract"],
        requirementIds: ["fr-1"],
        dependsOnTaskIds: [],
        inputArtifacts: [{ artifactId: "architecture-1", kind: "architecture", sha256: architectureHash }],
        writeScopes: ["packages/contracts/**"],
        forbiddenScopes: ["packages/client/**"],
        acceptanceCriteria: ["The shared contract is validated"],
        verificationCommands: ["npm test -- contract"],
        expectedOutputs: ["Shared contract and tests"],
        requiresWorktree: false,
        risk: "medium"
      },
      {
        id: "task-client",
        title: "Implement contract client",
        description: "Consume the approved shared contract.",
        profile: "frontend",
        componentIds: ["client"],
        requirementIds: ["fr-1"],
        dependsOnTaskIds: [],
        inputArtifacts: [{ artifactId: "architecture-1", kind: "architecture", sha256: architectureHash }],
        writeScopes: ["packages/client/**"],
        forbiddenScopes: ["packages/contracts/**"],
        acceptanceCriteria: ["The client consumes the shared contract"],
        verificationCommands: ["npm test -- client"],
        expectedOutputs: ["Contract client and tests"],
        requiresWorktree: false,
        risk: "low"
      }
    ],
    waves: [
      { id: "wave-contract", taskIds: ["task-contract"], exitCriteria: ["Contract tests pass"] },
      { id: "wave-client", taskIds: ["task-client"], exitCriteria: ["Client tests pass"] }
    ],
    integrationStrategy: {
      taskOrder: ["task-contract", "task-client"],
      conflictPolicy: "Integrate the shared contract before its client.",
      verificationCommands: ["npm test", "npm run build"]
    }
  };
}
