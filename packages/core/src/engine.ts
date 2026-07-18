import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  ImplementationPlanContractSchema,
  artifactPayloadHash,
  type ImplementationPlanContract
} from "./contracts.js";
import { invariant } from "./errors.js";
import {
  ArtifactSchema,
  ExclusiveResourceSchema,
  ResourceOperationSchema,
  RunStateSchema,
  StagePreflightSchema,
  TaskSchema,
  TaskWorkspaceSchema,
  VerificationRecordSchema,
  WorkerResultSchema,
  WorkerSchema,
  type Actor,
  type Gate,
  type MutationContext,
  type PipelineDefinition,
  type RoutingSignal,
  type RunState,
  type Task,
  type TaskWorkspace,
  type ThreadCapabilities,
  type VerificationRecord,
  type WorkerResult,
  type WorkerContextPolicy,
  type WorkerStatus
} from "./model.js";
import { downstreamStageIds, readyStages, stageById, validatePipeline } from "./pipeline.js";
import type { RunStore } from "./store.js";
import {
  escalateWorkflow,
  evaluateWorkflowPolicy,
  legacyFullWorkflow,
  requiredArtifactKindsForLane
} from "./workflow-policy.js";

export interface CreateRunInput {
  id?: string;
  requirement: string;
  projectType?: "new" | "existing";
  hasUi?: boolean;
  routingSignals?: RoutingSignal[];
  laneOverride?: "full";
}

export interface CreateTaskInput {
  id: string;
  stageId: string;
  title: string;
  description?: string;
  profile?: string;
  dependsOn?: string[];
  waveId?: string;
  componentIds?: string[];
  requirementIds?: string[];
  writeScopes?: string[];
  forbiddenScopes?: string[];
  inputArtifactHashes?: Record<string, string>;
  inputArtifactKinds?: Record<string, string>;
  inputArtifactUris?: Record<string, string>;
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
  expectedOutputs?: string[];
  requiresWorktree?: boolean;
  risk?: "low" | "medium" | "high";
}

export interface MaterializeImplementationPlanInput {
  artifactId: string;
  targetStageId: string;
  plan: ImplementationPlanContract;
}

export interface RegisterArtifactInput {
  id: string;
  stageId: string;
  kind: string;
  uri: string;
  sha256: string;
  producedBy: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveGateInput {
  gateId: string;
  decision: "approved" | "rejected";
  resolution: string;
  choice?: string;
}

export interface HumanGateInspection {
  state: RunState;
  gate: Gate;
  artifactHashes: Record<string, string>;
}

export interface PrepareWorkerInput {
  workerId: string;
  taskId: string;
  adapter: string;
  protocolVersion?: 1 | 2;
  hostTaskName: string;
  promptHash: string;
  capabilities: ThreadCapabilities;
}

export interface PrepareTaskDispatchInput extends PrepareWorkerInput {
  leaseSeconds: number;
  workspace: Omit<TaskWorkspace, "boundAt">;
}

export interface CompleteInlineTaskInput {
  taskId: string;
  workspace: Omit<TaskWorkspace, "boundAt">;
  result: Omit<WorkerResult, "workerId" | "taskId" | "status" | "completedAt"> & {
    completedAt?: string;
  };
}

export interface ClaimInlineTaskInput {
  taskId: string;
  leaseSeconds: number;
  workspace: Omit<TaskWorkspace, "boundAt">;
}

export interface RecordWorkerCleanupInput {
  workerId: string;
  step: "close" | "archive" | "permitRelease";
  status: "completed" | "unsupported" | "failed";
  reason?: string;
}

export interface NativeWorkerBindingFacts {
  adapterVersion: string;
  contextPolicy: WorkerContextPolicy;
}

export interface WorkerCleanupObservation {
  status: "pending" | "completed" | "unsupported" | "failed";
  at?: string;
  reason?: string;
}

export interface RecordWorkerCleanupReceiptInput {
  workerId: string;
  close: WorkerCleanupObservation;
  archive: WorkerCleanupObservation;
  permitRelease: WorkerCleanupObservation;
}

export interface AcquireResourceInput {
  resourceId: string;
  kind: string;
  resourceKey: string;
  stageId: string;
  taskId: string;
  owner: string;
  leaseSeconds: number;
  metadata?: Record<string, unknown>;
}

export interface FinishResourceOperationInput {
  operationId: string;
  status: "completed" | "failed";
  resultHash?: string;
  affectedNodeIds?: string[];
  summary?: string;
}

export interface ReportStagePreflightInput {
  stageId: string;
  host: string;
  availableCapabilities: string[];
  ttlSeconds: number;
}

export class AgentFlowEngine {
  readonly pipeline: PipelineDefinition;

  constructor(
    private readonly store: RunStore,
    pipeline: PipelineDefinition
  ) {
    this.pipeline = validatePipeline(pipeline);
  }

  async createRun(input: CreateRunInput): Promise<RunState> {
    const now = new Date().toISOString();
    const firstStage = this.pipeline.stages.find((stage) => stage.dependsOn.length === 0);
    invariant(firstStage, "Pipeline has no root stage", "PIPELINE_NO_ROOT");

    const stages = Object.fromEntries(this.pipeline.stages.map((stage) => [
      stage.id,
      {
        id: stage.id,
        status: stage.id === firstStage.id ? "active" as const : "pending" as const,
        ...(stage.id === firstStage.id ? { startedAt: now } : {})
      }
    ]));

    const gates = Object.fromEntries(this.pipeline.stages.flatMap((stage) => stage.requiredGate ? [[
      stage.requiredGate.id,
      {
        ...stage.requiredGate,
        stageId: stage.id,
        status: "pending" as const,
        artifactHashes: {}
      }
    ]] : []));

    const state = RunStateSchema.parse({
      id: input.id ?? `run-${randomUUID()}`,
      pipelineId: this.pipeline.id,
      pipelineVersion: this.pipeline.version,
      requirement: input.requirement,
      projectType: input.projectType ?? "new",
      hasUi: input.hasUi ?? true,
      status: "active",
      workflow: input.routingSignals === undefined && input.laneOverride === undefined
        ? legacyFullWorkflow(this.pipeline.stages.map((stage) => stage.id))
        : evaluateWorkflowPolicy({
          requirement: input.requirement,
          projectType: input.projectType ?? "new",
          hasUi: input.hasUi ?? true,
          signals: input.routingSignals ?? [],
          pipelineId: this.pipeline.id,
          stageIds: this.pipeline.stages.map((stage) => stage.id),
          ...(input.laneOverride === undefined ? {} : { override: input.laneOverride })
        }),
      revision: 0,
      activeStageId: firstStage.id,
      stages,
      preflights: {},
      tasks: {},
      workers: {},
      resources: {},
      artifacts: {},
      gates,
      events: [{
        id: `event-${randomUUID()}`,
        type: "run.created",
        actorId: "system",
        actorKind: "system",
        at: now,
        data: { requirement: input.requirement }
      }],
      idempotency: {},
      createdAt: now,
      updatedAt: now
    });
    return this.store.create(state);
  }

  loadRun(runId: string): Promise<RunState> {
    return this.store.load(runId);
  }

  escalateRunWorkflow(
    runId: string,
    signals: RoutingSignal[],
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "workflow.escalate", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a Supervisor or system actor can escalate workflow policy",
        "WORKFLOW_ESCALATE_ACTOR_INVALID"
      );
      const previous = state.workflow;
      const next = escalateWorkflow(previous, {
        requirement: state.requirement,
        projectType: state.projectType,
        hasUi: state.hasUi,
        signals,
        pipelineId: this.pipeline.id,
        stageIds: this.pipeline.stages.map((stage) => stage.id)
      });
      if (next.lane === previous.lane) return state;
      const escalationSignals = next.signals.filter((signal) => !previous.signals.includes(signal));
      state.workflow = {
        ...next,
        policySkippedStageIds: previous.policySkippedStageIds,
        escalations: [...previous.escalations, {
          from: previous.lane,
          to: next.lane,
          signals: escalationSignals,
          at: now
        }]
      };
      this.event(state, "workflow.escalated", context.actor, now, {
        from: previous.lane,
        to: next.lane,
        signals: escalationSignals
      });
      this.restoreNewlyEligibleStages(state, previous.policySkippedStageIds, context.actor, now);
      return state;
    });
  }

  cancelRun(runId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "run.cancel", context, (state, now) => {
      this.assertRunTerminable(state);
      this.terminalizeRun(state, "cancelled", "cancelled", reason, context.actor, now);
      return state;
    });
  }

  supersedeRun(
    runId: string,
    replacementRunId: string,
    reason: string,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "run.supersede", context, (state, now) => {
      invariant(replacementRunId.length > 0 && replacementRunId !== state.id, "Replacement Run ID is invalid", "RUN_REPLACEMENT_INVALID");
      this.assertRunTerminable(state);
      this.terminalizeRun(state, "superseded", "superseded", reason, context.actor, now, { replacementRunId });
      return state;
    });
  }

  failRun(runId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "run.fail", context, (state, now) => {
      this.assertRunTerminable(state);
      this.terminalizeRun(state, "failed", "failed", reason, context.actor, now);
      return state;
    });
  }

  blockRun(runId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "run.block", context, (state, now) => {
      this.assertRunTerminable(state);
      this.terminalizeRun(state, "blocked", "blocked", reason, context.actor, now);
      return state;
    });
  }

  async inspectHumanGate(
    runId: string,
    gateId: string,
    expectedRevision: number
  ): Promise<HumanGateInspection> {
    const state = await this.store.load(runId);
    invariant(
      state.revision === expectedRevision,
      `Expected revision ${expectedRevision}, found ${state.revision}`,
      "REVISION_CONFLICT",
      { expectedRevision, actualRevision: state.revision }
    );
    const gate = state.gates[gateId];
    invariant(gate, `Gate not found: ${gateId}`, "GATE_NOT_FOUND");
    invariant(gate.type === "human", `Gate is not human: ${gateId}`, "GATE_NOT_HUMAN");
    invariant(gate.status === "pending", `Gate is already ${gate.status}`, "GATE_NOT_PENDING");
    invariant(
      state.activeStageId === gate.stageId && state.stages[gate.stageId]?.status === "active",
      `Gate Stage is not active: ${gate.stageId}`,
      "GATE_STAGE_NOT_ACTIVE",
      { gateId, gateStageId: gate.stageId, activeStageId: state.activeStageId }
    );

    const stage = stageById(this.pipeline, gate.stageId);
    const artifacts = Object.values(state.artifacts)
      .filter((artifact) => artifact.stageId === gate.stageId && !artifact.stale);
    const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
    for (const kind of stage.requiredArtifactKinds) {
      invariant(
        artifactKinds.has(kind),
        `Cannot inspect gate without artifact kind: ${kind}`,
        "GATE_ARTIFACT_MISSING",
        { gateId, kind }
      );
    }

    return {
      state,
      gate: structuredClone(gate),
      artifactHashes: Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact.sha256]))
    };
  }

  reportStagePreflight(
    runId: string,
    input: ReportStagePreflightInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "stage.preflight.report", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can report a stage preflight",
        "STAGE_PREFLIGHT_ACTOR_INVALID"
      );
      invariant(
        Number.isSafeInteger(input.ttlSeconds) && input.ttlSeconds >= 30 && input.ttlSeconds <= 3_600,
        "Stage preflight TTL must be between 30 and 3600 seconds",
        "STAGE_PREFLIGHT_TTL_INVALID"
      );
      const stage = stageById(this.pipeline, input.stageId);
      invariant(
        stage.requiredCapabilities.length > 0,
        `Stage does not require a capability preflight: ${input.stageId}`,
        "STAGE_PREFLIGHT_NOT_REQUIRED"
      );
      const stageRun = state.stages[input.stageId];
      invariant(
        state.activeStageId === input.stageId && (stageRun?.status === "active" || stageRun?.status === "blocked"),
        `Stage is not active or blocked: ${input.stageId}`,
        "STAGE_PREFLIGHT_STAGE_INVALID"
      );

      const availableCapabilities = [...new Set(input.availableCapabilities)].sort();
      const missingCapabilities = stage.requiredCapabilities.filter(
        (capability) => !availableCapabilities.includes(capability)
      );
      const status = missingCapabilities.length === 0 ? "passed" as const : "blocked" as const;
      state.preflights[input.stageId] = StagePreflightSchema.parse({
        stageId: input.stageId,
        host: input.host,
        status,
        requiredCapabilities: stage.requiredCapabilities,
        availableCapabilities,
        missingCapabilities,
        checkedBy: context.actor.id,
        checkedAt: now,
        expiresAt: new Date(Date.parse(now) + input.ttlSeconds * 1_000).toISOString(),
        reason: context.reason ?? `Capability preflight ${status}`
      });

      if (status === "blocked") {
        invariant(
          !Object.values(state.workers).some((worker) => {
            const task = state.tasks[worker.taskId];
            return task?.stageId === input.stageId && isLiveWorker(worker.status);
          }),
          "Cannot block a stage while it has a live worker",
          "STAGE_PREFLIGHT_WORKER_ACTIVE"
        );
        invariant(
          !Object.values(state.resources).some(
            (resource) => resource.stageId === input.stageId && resource.status === "active"
          ),
          "Cannot block a stage while it has an active resource",
          "STAGE_PREFLIGHT_RESOURCE_ACTIVE"
        );
        stageRun.status = "blocked";
        state.status = "blocked";
        for (const task of Object.values(state.tasks)) {
          if (task.stageId === input.stageId && task.status === "ready") {
            task.status = "pending";
            task.updatedAt = now;
          }
        }
        this.event(state, "stage.preflight-blocked", context.actor, now, {
          stageId: input.stageId,
          host: input.host,
          missingCapabilities
        });
      } else {
        stageRun.status = "active";
        stageRun.startedAt ??= now;
        state.status = "active";
        this.readyTasksForStage(state, input.stageId, now);
        this.event(state, "stage.preflight-passed", context.actor, now, {
          stageId: input.stageId,
          host: input.host,
          expiresAt: state.preflights[input.stageId]?.expiresAt
        });
      }
      return state;
    });
  }

  createTask(runId: string, input: CreateTaskInput, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "task.create", context, (state, now) => {
      invariant(!state.tasks[input.id], `Task already exists: ${input.id}`, "TASK_EXISTS");
      stageById(this.pipeline, input.stageId);
      for (const dependency of input.dependsOn ?? []) {
        invariant(state.tasks[dependency], `Unknown task dependency: ${dependency}`, "TASK_DEPENDENCY_NOT_FOUND");
      }

      const dependenciesComplete = (input.dependsOn ?? []).every((id) => state.tasks[id]?.status === "completed");
      const stageIsActive = state.stages[input.stageId]?.status === "active";
      state.tasks[input.id] = TaskSchema.parse({
        id: input.id,
        stageId: input.stageId,
        title: input.title,
        description: input.description ?? "",
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        status: dependenciesComplete && stageIsActive ? "ready" : "pending",
        dependsOn: input.dependsOn ?? [],
        ...(input.waveId === undefined ? {} : { waveId: input.waveId }),
        componentIds: input.componentIds ?? [],
        requirementIds: input.requirementIds ?? [],
        writeScopes: input.writeScopes ?? [],
        forbiddenScopes: input.forbiddenScopes ?? [],
        inputArtifactHashes: input.inputArtifactHashes ?? {},
        inputArtifactKinds: input.inputArtifactKinds ?? {},
        inputArtifactUris: input.inputArtifactUris ?? {},
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        verificationCommands: input.verificationCommands ?? [],
        expectedOutputs: input.expectedOutputs ?? [],
        requiresWorktree: input.requiresWorktree ?? false,
        ...(input.risk === undefined ? {} : { risk: input.risk }),
        verification: [],
        createdAt: now,
        updatedAt: now
      });
      this.event(state, "task.created", context.actor, now, { taskId: input.id });
      return state;
    });
  }

  materializeImplementationPlan(
    runId: string,
    input: MaterializeImplementationPlanInput,
    context: MutationContext
  ): Promise<RunState> {
    const plan = ImplementationPlanContractSchema.parse(input.plan);
    const planHash = artifactPayloadHash("implementation-plan", plan);
    return this.mutate(runId, "implementation-plan.materialize", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can materialize an implementation plan",
        "PLAN_MATERIALIZE_ACTOR_INVALID"
      );
      const targetStage = stageById(this.pipeline, input.targetStageId);
      const targetStageRun = state.stages[input.targetStageId];
      invariant(
        state.activeStageId === input.targetStageId && targetStageRun?.status === "active",
        `Implementation target stage is not active: ${input.targetStageId}`,
        "PLAN_TARGET_STAGE_NOT_ACTIVE"
      );

      const artifact = state.artifacts[input.artifactId];
      invariant(
        artifact?.kind === "implementation-plan" && !artifact.stale && artifact.sha256 === planHash,
        `Implementation plan Artifact is missing, stale, or has a different hash: ${input.artifactId}`,
        "PLAN_ARTIFACT_INVALID",
        {
          artifactId: input.artifactId,
          expectedHash: planHash,
          actualHash: artifact?.sha256,
          actualKind: artifact?.kind,
          stale: artifact?.stale
        }
      );
      invariant(
        state.stages[artifact.stageId]?.status === "completed",
        `Implementation plan source stage is not complete: ${artifact.stageId}`,
        "PLAN_SOURCE_STAGE_INCOMPLETE"
      );
      invariant(
        downstreamStageIds(this.pipeline, artifact.stageId).includes(targetStage.id),
        `Target stage ${targetStage.id} is not downstream of plan stage ${artifact.stageId}`,
        "PLAN_TARGET_STAGE_INVALID"
      );

      const sourceStage = stageById(this.pipeline, artifact.stageId);
      invariant(
        sourceStage.requiredGate?.type === "human",
        `Implementation plan source Stage has no human approval Gate: ${sourceStage.id}`,
        "PLAN_GATE_UNAPPROVED"
      );
      const gate = state.gates[sourceStage.requiredGate.id];
      invariant(
        gate?.status === "approved" && gate.artifactHashes[artifact.id] === artifact.sha256,
        `Implementation plan is not bound to an approved Gate: ${sourceStage.requiredGate.id}`,
        "PLAN_GATE_UNAPPROVED"
      );

      const activeTargetTasks = Object.values(state.tasks).filter(
        (task) => task.stageId === targetStage.id && task.status !== "cancelled"
      );
      invariant(
        activeTargetTasks.length === 0,
        `Target stage already has materialized or manually created Tasks: ${targetStage.id}`,
        "PLAN_ALREADY_MATERIALIZED",
        { taskIds: activeTargetTasks.map((task) => task.id) }
      );

      for (const task of plan.tasks) {
        const existing = state.tasks[task.id];
        invariant(
          !existing || (
            existing.status === "cancelled" &&
            existing.stageId === targetStage.id &&
            existing.materializedFrom?.artifactId === artifact.id
          ),
          `Task ID already exists outside this plan generation: ${task.id}`,
          "PLAN_TASK_ID_CONFLICT"
        );
        for (const reference of task.inputArtifacts) {
          const candidate = state.artifacts[reference.artifactId];
          invariant(
            candidate?.kind === reference.kind && candidate.sha256 === reference.sha256 && !candidate.stale,
            `Plan Task input Artifact is missing, stale, or mismatched: ${reference.artifactId}`,
            "PLAN_TASK_INPUT_INVALID",
            {
              taskId: task.id,
              artifactId: reference.artifactId,
              expectedKind: reference.kind,
              expectedHash: reference.sha256,
              actualKind: candidate?.kind,
              actualHash: candidate?.sha256,
              stale: candidate?.stale
            }
          );
        }
      }

      const waveByTask = new Map(
        plan.waves.flatMap((wave) => wave.taskIds.map((taskId) => [taskId, wave.id] as const))
      );
      const waveIndexByTask = new Map(
        plan.waves.flatMap((wave, waveIndex) => wave.taskIds.map((taskId) => [taskId, waveIndex] as const))
      );
      for (const task of plan.tasks) {
        const inputArtifacts = [...task.inputArtifacts, {
          artifactId: artifact.id,
          kind: artifact.kind,
          sha256: artifact.sha256
        }];
        state.tasks[task.id] = TaskSchema.parse({
          id: task.id,
          stageId: targetStage.id,
          title: task.title,
          description: task.description,
          profile: task.profile,
          status: task.dependsOnTaskIds.length === 0 && waveIndexByTask.get(task.id) === 0 ? "ready" : "pending",
          dependsOn: task.dependsOnTaskIds,
          waveId: waveByTask.get(task.id),
          waveIndex: waveIndexByTask.get(task.id),
          componentIds: task.componentIds,
          requirementIds: task.requirementIds,
          writeScopes: task.writeScopes,
          forbiddenScopes: task.forbiddenScopes,
          inputArtifactHashes: Object.fromEntries(inputArtifacts.map((reference) => [reference.artifactId, reference.sha256])),
          inputArtifactKinds: Object.fromEntries(inputArtifacts.map((reference) => [reference.artifactId, reference.kind])),
          inputArtifactUris: Object.fromEntries(inputArtifacts.map((reference) => [
            reference.artifactId,
            state.artifacts[reference.artifactId]?.uri ?? artifact.uri
          ])),
          acceptanceCriteria: task.acceptanceCriteria,
          verificationCommands: task.verificationCommands,
          expectedOutputs: task.expectedOutputs,
          requiresWorktree: task.requiresWorktree,
          risk: task.risk,
          materializedFrom: {
            artifactId: artifact.id,
            kind: artifact.kind,
            sha256: artifact.sha256
          },
          planRepository: plan.repository,
          verification: [],
          createdAt: now,
          updatedAt: now
        });
      }
      this.event(state, "implementation-plan.materialized", context.actor, now, {
        artifactId: artifact.id,
        sha256: artifact.sha256,
        targetStageId: targetStage.id,
        taskIds: plan.tasks.map((task) => task.id)
      });
      return state;
    });
  }

  claimTask(
    runId: string,
    taskId: string,
    workerId: string,
    leaseSeconds: number,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "task.claim", context, (state, now) => {
      const task = this.claimTaskState(state, taskId, workerId, leaseSeconds, now);
      task.ownerKind = "worker";
      this.event(state, "task.claimed", context.actor, now, { taskId, workerId, leaseSeconds });
      return state;
    });
  }

  claimInlineTask(
    runId: string,
    input: ClaimInlineTaskInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "task.claim.inline", context, (state, now) => {
      invariant(context.actor.kind === "supervisor", "Only a Supervisor can claim an inline Task", "TASK_INLINE_ACTOR_INVALID");
      invariant(isAbsolute(input.workspace.path), "Inline Task workspace path must be absolute", "TASK_WORKSPACE_PATH_INVALID", {
        path: input.workspace.path
      });
      const workspace = TaskWorkspaceSchema.parse({ ...input.workspace, boundAt: now });
      const task = state.tasks[input.taskId];
      invariant(task, `Task not found: ${input.taskId}`, "TASK_NOT_FOUND");
      invariant(!task.requiresWorktree || workspace.kind === "worktree", `Task requires an isolated worktree: ${task.id}`, "TASK_WORKTREE_REQUIRED");
      if (task.planRepository && workspace.kind === "worktree") {
        invariant(
          workspace.baseRevision === task.planRepository.baseRevision && workspace.branch !== task.planRepository.branch,
          `Task worktree does not match the approved repository baseline: ${task.id}`,
          "TASK_WORKSPACE_BASE_MISMATCH"
        );
      }
      const claimed = this.claimTaskState(state, input.taskId, context.actor.id, input.leaseSeconds, now);
      claimed.ownerKind = "supervisor";
      claimed.workspace = workspace;
      this.event(state, "task.claimed.inline", context.actor, now, {
        taskId: input.taskId,
        leaseSeconds: input.leaseSeconds,
        workspaceKind: workspace.kind,
        workspacePath: workspace.path
      });
      return state;
    });
  }

  prepareTaskDispatch(
    runId: string,
    input: PrepareTaskDispatchInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "worker.dispatch.prepare", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can prepare a Task dispatch",
        "WORKER_PREPARE_ACTOR_INVALID"
      );
      invariant(isAbsolute(input.workspace.path), "Task workspace path must be absolute", "TASK_WORKSPACE_PATH_INVALID", {
        path: input.workspace.path
      });
      const workspace = TaskWorkspaceSchema.parse({ ...input.workspace, boundAt: now });
      const task = state.tasks[input.taskId];
      invariant(task, `Task not found: ${input.taskId}`, "TASK_NOT_FOUND");
      this.assertSupervisorWaveParticipation(state, task);
      if (task.planRepository && workspace.kind === "worktree") {
        invariant(
          workspace.baseRevision === task.planRepository.baseRevision
          && workspace.branch !== task.planRepository.branch,
          `Task worktree does not match the approved repository baseline: ${input.taskId}`,
          "TASK_WORKSPACE_BASE_MISMATCH",
          {
            taskId: input.taskId,
            expectedBaseRevision: task.planRepository.baseRevision,
            actualBaseRevision: workspace.baseRevision,
            integrationBranch: task.planRepository.branch,
            worktreeBranch: workspace.branch
          }
        );
      }
      const alreadyClaimed = task.status === "running" && task.owner === input.workerId && task.lease !== undefined;
      if (alreadyClaimed) {
        invariant(Date.parse(task.lease?.expiresAt ?? "") > Date.parse(now), "Task lease expired during workspace setup", "TASK_LEASE_EXPIRED");
      }
      invariant(
        !task.requiresWorktree || workspace.kind === "worktree",
        `Task requires an isolated worktree: ${input.taskId}`,
        "TASK_WORKTREE_REQUIRED"
      );
      if (workspace.kind === "worktree") {
        const normalized = normalizeWorkspacePath(workspace.path);
        for (const candidate of Object.values(state.tasks)) {
          if (candidate.id === task.id || candidate.status !== "running" || !candidate.lease || !candidate.workspace) continue;
          if (Date.parse(candidate.lease.expiresAt) <= Date.parse(now)) continue;
          invariant(
            normalizeWorkspacePath(candidate.workspace.path) !== normalized,
            `Worktree is already assigned to running Task ${candidate.id}`,
            "TASK_WORKSPACE_CONFLICT",
            { taskId: task.id, conflictingTaskId: candidate.id, path: workspace.path }
          );
        }
      }

      const claimed = alreadyClaimed
        ? task
        : this.claimTaskState(state, input.taskId, input.workerId, input.leaseSeconds, now);
      claimed.ownerKind = "worker";
      claimed.workspace = workspace;
      this.prepareWorkerState(state, { ...input, protocolVersion: 2 }, now);
      if (!alreadyClaimed) {
        this.event(state, "task.claimed", context.actor, now, {
          taskId: input.taskId,
          workerId: input.workerId,
          leaseSeconds: input.leaseSeconds
        });
      }
      this.event(state, "worker.prepared", context.actor, now, {
        workerId: input.workerId,
        taskId: input.taskId,
        adapter: input.adapter,
        promptHash: input.promptHash,
        workspaceKind: workspace.kind,
        workspacePath: workspace.path
      });
      return state;
    });
  }

  heartbeatTask(
    runId: string,
    taskId: string,
    workerId: string,
    leaseSeconds: number,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "task.heartbeat", context, (state, now) => {
      const task = state.tasks[taskId];
      invariant(task?.status === "running" && task.lease, `Task is not running: ${taskId}`, "TASK_NOT_RUNNING");
      invariant(task.owner === workerId && task.lease.owner === workerId, "Worker does not own task", "TASK_OWNER_MISMATCH");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Task lease has expired", "TASK_LEASE_EXPIRED");
      task.lease.heartbeatAt = now;
      task.lease.expiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      task.updatedAt = now;
      this.event(state, "task.heartbeat", context.actor, now, { taskId, workerId });
      return state;
    });
  }

  completeTask(
    runId: string,
    taskId: string,
    workerId: string,
    verification: VerificationRecord[],
    result: Record<string, unknown>,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "task.complete", context, (state, now) => {
      const task = state.tasks[taskId];
      invariant(task?.status === "running" && task.lease, `Task is not running: ${taskId}`, "TASK_NOT_RUNNING");
      invariant(task.owner === workerId, "Worker does not own task", "TASK_OWNER_MISMATCH");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Task lease has expired", "TASK_LEASE_EXPIRED");
      const liveWorker = Object.values(state.workers)
        .find((worker) => worker.taskId === taskId && isLiveWorker(worker.status));
      invariant(
        !liveWorker,
        `Task still has a live worker: ${taskId}`,
        "TASK_WORKER_LIVE",
        {
          taskId,
          workerId: liveWorker?.id,
          workerStatus: liveWorker?.status
        }
      );
      invariant(
        !task.requiresWorktree && task.materializedFrom?.kind !== "implementation-plan",
        `Implementation Task must complete through a bound WorkerResult: ${taskId}`,
        "TASK_WORKER_RESULT_REQUIRED"
      );
      const records = verification.map((record) => VerificationRecordSchema.parse(record));
      this.completeTaskState(state, taskId, workerId, records, result, now);
      this.event(state, "task.completed", context.actor, now, { taskId, workerId });
      return state;
    });
  }

  completeInlineTask(
    runId: string,
    input: CompleteInlineTaskInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "task.complete.inline", context, (state, now) => {
      invariant(context.actor.kind === "supervisor", "Only a Supervisor can complete an inline Task", "TASK_INLINE_ACTOR_INVALID");
      const task = state.tasks[input.taskId];
      invariant(task?.status === "running" && task.lease, `Task is not running: ${input.taskId}`, "TASK_NOT_RUNNING");
      invariant(task.owner === context.actor.id, "Supervisor does not own the inline Task", "TASK_OWNER_MISMATCH");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Task lease has expired", "TASK_LEASE_EXPIRED");
      invariant(
        !Object.values(state.workers).some((worker) => worker.taskId === task.id && isLiveWorker(worker.status)),
        `Task still has a live worker: ${task.id}`,
        "TASK_WORKER_LIVE"
      );
      invariant(isAbsolute(input.workspace.path), "Inline Task workspace path must be absolute", "TASK_WORKSPACE_PATH_INVALID", {
        path: input.workspace.path
      });
      const workspace = TaskWorkspaceSchema.parse({ ...input.workspace, boundAt: now });
      invariant(!task.requiresWorktree || workspace.kind === "worktree", `Task requires an isolated worktree: ${task.id}`, "TASK_WORKTREE_REQUIRED");
      if (task.planRepository && workspace.kind === "worktree") {
        invariant(
          workspace.baseRevision === task.planRepository.baseRevision && workspace.branch !== task.planRepository.branch,
          `Task worktree does not match the approved repository baseline: ${task.id}`,
          "TASK_WORKSPACE_BASE_MISMATCH"
        );
      }
      if (task.workspace) {
        invariant(
          task.workspace.kind === workspace.kind
          && task.workspace.path === workspace.path
          && task.workspace.branch === workspace.branch
          && task.workspace.baseRevision === workspace.baseRevision,
          `Inline Task workspace changed: ${task.id}`,
          "TASK_WORKSPACE_CONFLICT"
        );
      } else {
        task.workspace = workspace;
      }
      task.ownerKind = "supervisor";

      const result = WorkerResultSchema.parse({
        ...input.result,
        workerId: context.actor.id,
        taskId: task.id,
        status: "completed",
        completedAt: input.result.completedAt ?? now
      });
      this.assertWorkerChangeSet(task, result);
      this.completeTaskState(state, task.id, context.actor.id, result.verification, {
        summary: result.summary,
        artifacts: result.artifacts,
        changeSet: result.changeSet,
        risks: result.risks,
        followUps: result.followUps
      }, now);
      this.event(state, "task.completed.inline", context.actor, now, { taskId: task.id });
      return state;
    });
  }

  retryTask(runId: string, taskId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "task.retry", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can retry a task",
        "TASK_RETRY_ACTOR_INVALID"
      );
      const task = state.tasks[taskId];
      invariant(task, `Task not found: ${taskId}`, "TASK_NOT_FOUND");
      invariant(
        task.status === "blocked" || task.status === "failed",
        `Task cannot be retried from status ${task.status}`,
        "TASK_RETRY_STATUS_INVALID"
      );
      invariant(
        !Object.values(state.workers).some((worker) => worker.taskId === taskId && isLiveWorker(worker.status)),
        `Task still has a live worker: ${taskId}`,
        "TASK_WORKER_LIVE"
      );
      const stageActive = state.stages[task.stageId]?.status === "active";
      const dependenciesComplete = task.dependsOn.every((id) => state.tasks[id]?.status === "completed");
      task.status = stageActive && dependenciesComplete ? "ready" : "pending";
      delete task.owner;
      delete task.lease;
      task.verification = [];
      delete task.result;
      task.updatedAt = now;
      this.event(state, "task.retried", context.actor, now, { taskId, reason });
      return state;
    });
  }

  abortTaskSetup(
    runId: string,
    taskId: string,
    workerId: string,
    reason: string,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "task.setup.abort", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can abort Task setup",
        "TASK_SETUP_ABORT_ACTOR_INVALID"
      );
      const task = state.tasks[taskId];
      invariant(task?.status === "running" && task.lease, `Task is not in setup: ${taskId}`, "TASK_NOT_RUNNING");
      invariant(task.owner === workerId && task.lease.owner === workerId, "Task setup owner does not match", "TASK_OWNER_MISMATCH");
      invariant(
        !Object.values(state.workers).some((worker) => worker.taskId === taskId && isLiveWorker(worker.status)),
        `Task setup already has a live Worker: ${taskId}`,
        "TASK_WORKER_LIVE"
      );
      const dependenciesComplete = task.dependsOn.every((id) => state.tasks[id]?.status === "completed");
      task.status = state.stages[task.stageId]?.status === "active" && dependenciesComplete ? "ready" : "pending";
      delete task.owner;
      delete task.lease;
      delete task.workspace;
      task.verification = [];
      delete task.result;
      task.updatedAt = now;
      this.event(state, "task.setup-aborted", context.actor, now, { taskId, workerId, reason });
      return state;
    });
  }

  prepareWorker(runId: string, input: PrepareWorkerInput, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "worker.prepare", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can prepare a worker",
        "WORKER_PREPARE_ACTOR_INVALID"
      );
      this.prepareWorkerState(state, input, now);
      this.event(state, "worker.prepared", context.actor, now, {
        workerId: input.workerId,
        taskId: input.taskId,
        adapter: input.adapter,
        promptHash: input.promptHash
      });
      return state;
    });
  }

  bindWorker(
    runId: string,
    workerId: string,
    externalThreadId: string,
    context: MutationContext,
    nativeFacts?: NativeWorkerBindingFacts
  ): Promise<RunState> {
    return this.mutate(runId, "worker.bind", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can bind a worker",
        "WORKER_BIND_ACTOR_INVALID"
      );
      const worker = state.workers[workerId];
      invariant(worker, `Worker not found: ${workerId}`, "WORKER_NOT_FOUND");
      invariant(
        worker.status === "prepared" || worker.status === "starting",
        `Worker cannot be bound from status ${worker.status}`,
        "WORKER_BIND_STATUS_INVALID"
      );
      const task = state.tasks[worker.taskId];
      invariant(task?.status === "running" && task.owner === workerId && task.lease, "Worker no longer owns a running task", "TASK_OWNER_MISMATCH");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Task lease expired before native binding", "TASK_LEASE_EXPIRED");
      invariant(
        !Object.values(state.workers).some((candidate) => (
          candidate.id !== workerId &&
          candidate.adapter === worker.adapter &&
          candidate.externalThreadId === externalThreadId
        )),
        `External thread is already bound: ${externalThreadId}`,
        "EXTERNAL_THREAD_BOUND"
      );
      worker.externalThreadId = externalThreadId;
      if (nativeFacts !== undefined) {
        worker.adapterVersion = nativeFacts.adapterVersion;
        worker.contextPolicy = nativeFacts.contextPolicy;
      }
      worker.status = "running";
      worker.updatedAt = now;
      this.event(state, "worker.bound", context.actor, now, { workerId, externalThreadId, adapter: worker.adapter });
      return state;
    });
  }

  observeWorker(
    runId: string,
    workerId: string,
    status: "starting" | "running" | "unknown",
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "worker.observe", context, (state, now) => {
      const worker = state.workers[workerId];
      invariant(worker, `Worker not found: ${workerId}`, "WORKER_NOT_FOUND");
      invariant(isLiveWorker(worker.status), `Worker is already terminal: ${worker.status}`, "WORKER_TERMINAL");
      invariant(worker.capabilities.status, "Worker adapter cannot observe native status", "WORKER_CAPABILITY_UNAVAILABLE");
      if (status !== "starting") {
        invariant(worker.externalThreadId, "Observed worker is not bound to an external thread", "WORKER_NOT_BOUND");
      }
      worker.status = status;
      worker.updatedAt = now;
      this.event(state, "worker.observed", context.actor, now, { workerId, status });
      return state;
    });
  }

  collectWorkerResult(
    runId: string,
    workerId: string,
    rawResult: WorkerResult,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "worker.collect", context, (state, now) => {
      const worker = state.workers[workerId];
      invariant(worker, `Worker not found: ${workerId}`, "WORKER_NOT_FOUND");
      invariant(isLiveWorker(worker.status), `Worker is already terminal: ${worker.status}`, "WORKER_TERMINAL");
      invariant(worker.capabilities.collect, "Worker adapter cannot collect native results", "WORKER_CAPABILITY_UNAVAILABLE");
      invariant(worker.externalThreadId, "Worker is not bound to an external thread", "WORKER_NOT_BOUND");
      const result = WorkerResultSchema.parse(rawResult);
      invariant(result.workerId === workerId, "Worker result ID does not match", "WORKER_RESULT_ID_MISMATCH");
      invariant(result.taskId === worker.taskId, "Worker result task does not match", "WORKER_RESULT_TASK_MISMATCH");
      if (context.actor.kind === "worker") {
        invariant(context.actor.id === workerId, "Worker cannot submit another worker's result", "WORKER_RESULT_ACTOR_MISMATCH");
      } else {
        invariant(
          context.actor.kind === "supervisor" || context.actor.kind === "system",
          "Actor cannot collect a worker result",
          "WORKER_COLLECT_ACTOR_INVALID"
        );
      }

      const task = state.tasks[worker.taskId];
      invariant(task?.status === "running" && task.lease, `Task is not running: ${worker.taskId}`, "TASK_NOT_RUNNING");
      invariant(task.owner === workerId, "Worker no longer owns the task", "TASK_OWNER_MISMATCH");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Task lease expired before result collection", "TASK_LEASE_EXPIRED");
      this.assertWorkerChangeSet(task, result);
      worker.status = result.status;
      worker.result = result;
      worker.cleanup = {
        resultCollectedAt: now,
        close: worker.capabilities.close
          ? { status: "pending" }
          : { status: "unsupported", reason: "Adapter has no native close capability" },
        archive: { status: "pending" },
        permitRelease: { status: "pending" }
      };
      worker.updatedAt = now;

      if (result.status === "completed") {
        this.completeTaskState(state, task.id, workerId, result.verification, {
          summary: result.summary,
          artifacts: result.artifacts,
          changeSet: result.changeSet,
          risks: result.risks,
          followUps: result.followUps
        }, now);
      } else {
        task.status = result.status;
        task.verification = result.verification;
        task.result = {
          summary: result.summary,
          artifacts: result.artifacts,
          changeSet: result.changeSet,
          risks: result.risks,
          followUps: result.followUps
        };
        delete task.lease;
        task.updatedAt = now;
      }
      this.event(state, `worker.${result.status}`, context.actor, now, {
        workerId,
        taskId: task.id,
        artifactIds: result.artifacts.map((artifact) => artifact.id)
      });
      return state;
    });
  }

  failWorker(runId: string, workerId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "worker.fail", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can fail a worker",
        "WORKER_FAIL_ACTOR_INVALID"
      );
      const worker = state.workers[workerId];
      invariant(worker, `Worker not found: ${workerId}`, "WORKER_NOT_FOUND");
      invariant(isLiveWorker(worker.status), `Worker is already terminal: ${worker.status}`, "WORKER_TERMINAL");
      worker.status = "failed";
      worker.cleanup ??= worker.externalThreadId === undefined
        ? {
            close: { status: "unsupported", reason: "No native Worker was bound" },
            archive: { status: "unsupported", reason: "No native Worker was bound" },
            permitRelease: { status: "unsupported", reason: "No bound Worker permit exists" },
            completedAt: now
          }
        : this.initialWorkerCleanup(worker.capabilities.close);
      worker.updatedAt = now;
      const task = state.tasks[worker.taskId];
      if (task?.status === "running" && task.owner === workerId) {
        task.status = "failed";
        task.verification = [];
        task.result = { summary: reason };
        delete task.lease;
        task.updatedAt = now;
      }
      this.event(state, "worker.failed", context.actor, now, { workerId, taskId: worker.taskId, reason });
      return state;
    });
  }

  interruptWorker(runId: string, workerId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "worker.interrupt", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can interrupt a worker",
        "WORKER_INTERRUPT_ACTOR_INVALID"
      );
      const worker = state.workers[workerId];
      invariant(worker, `Worker not found: ${workerId}`, "WORKER_NOT_FOUND");
      invariant(isLiveWorker(worker.status), `Worker is already terminal: ${worker.status}`, "WORKER_TERMINAL");
      invariant(worker.capabilities.interrupt, "Worker adapter cannot interrupt native work", "WORKER_CAPABILITY_UNAVAILABLE");
      worker.status = "interrupted";
      worker.cleanup ??= this.initialWorkerCleanup(worker.capabilities.close);
      worker.updatedAt = now;
      const task = state.tasks[worker.taskId];
      if (task?.status === "running" && task.owner === workerId) {
        const stageActive = state.stages[task.stageId]?.status === "active";
        const dependenciesComplete = task.dependsOn.every((id) => state.tasks[id]?.status === "completed");
        task.status = stageActive && dependenciesComplete ? "ready" : "pending";
        delete task.owner;
        delete task.lease;
        task.verification = [];
        delete task.result;
        task.updatedAt = now;
      }
      this.event(state, "worker.interrupted", context.actor, now, { workerId, taskId: worker.taskId, reason });
      return state;
    });
  }

  closeWorker(runId: string, workerId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "worker.close", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a supervisor or system actor can close a worker",
        "WORKER_CLOSE_ACTOR_INVALID"
      );
      const worker = state.workers[workerId];
      invariant(worker, `Worker not found: ${workerId}`, "WORKER_NOT_FOUND");
      invariant(!isLiveWorker(worker.status), `Worker must be terminal before close: ${worker.status}`, "WORKER_NOT_TERMINAL");
      invariant(worker.status !== "closed", `Worker is already closed: ${workerId}`, "WORKER_ALREADY_CLOSED");
      invariant(worker.capabilities.close, "Worker adapter cannot close native work", "WORKER_CAPABILITY_UNAVAILABLE");
      worker.status = "closed";
      worker.cleanup ??= this.initialWorkerCleanup(worker.capabilities.close);
      worker.cleanup.close = { status: "completed", at: now };
      worker.updatedAt = now;
      this.event(state, "worker.closed", context.actor, now, { workerId, taskId: worker.taskId, reason });
      return state;
    });
  }

  recordWorkerCleanup(
    runId: string,
    input: RecordWorkerCleanupInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "worker.cleanup.record", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a Supervisor or system actor can record Worker cleanup",
        "WORKER_CLEANUP_ACTOR_INVALID"
      );
      const worker = state.workers[input.workerId];
      invariant(worker, `Worker not found: ${input.workerId}`, "WORKER_NOT_FOUND");
      invariant(!isLiveWorker(worker.status), `Worker must be terminal before cleanup: ${worker.status}`, "WORKER_NOT_TERMINAL");
      invariant(worker.cleanup, `Worker has no collected cleanup state: ${worker.id}`, "WORKER_CLEANUP_MISSING");
      worker.cleanup[input.step] = {
        status: input.status,
        at: now,
        ...(input.reason === undefined ? {} : { reason: input.reason })
      };
      const terminalSteps = [worker.cleanup.close, worker.cleanup.archive, worker.cleanup.permitRelease];
      if (terminalSteps.every((step) => step.status === "completed" || step.status === "unsupported")) {
        worker.cleanup.completedAt = now;
      } else {
        delete worker.cleanup.completedAt;
      }
      worker.updatedAt = now;
      this.event(state, "worker.cleanup.recorded", context.actor, now, {
        workerId: worker.id,
        taskId: worker.taskId,
        step: input.step,
        status: input.status
      });
      return state;
    });
  }

  recordWorkerCleanupReceipt(
    runId: string,
    input: RecordWorkerCleanupReceiptInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "worker.cleanup.receipt.record", context, (state, now) => {
      invariant(
        context.actor.kind === "supervisor" || context.actor.kind === "system",
        "Only a Supervisor or system actor can record Worker cleanup",
        "WORKER_CLEANUP_ACTOR_INVALID"
      );
      const worker = state.workers[input.workerId];
      invariant(worker, `Worker not found: ${input.workerId}`, "WORKER_NOT_FOUND");
      invariant(!isLiveWorker(worker.status), `Worker must be terminal before cleanup: ${worker.status}`, "WORKER_NOT_TERMINAL");
      invariant(worker.cleanup, `Worker has no collected cleanup state: ${worker.id}`, "WORKER_CLEANUP_MISSING");

      for (const step of ["close", "archive", "permitRelease"] as const) {
        const observation = input[step];
        worker.cleanup[step] = {
          status: observation.status,
          at: observation.at ?? now,
          ...(observation.reason === undefined ? {} : { reason: observation.reason })
        };
      }
      const terminalSteps = [worker.cleanup.close, worker.cleanup.archive, worker.cleanup.permitRelease];
      if (terminalSteps.every((step) => step.status === "completed" || step.status === "unsupported")) {
        worker.cleanup.completedAt = now;
      } else {
        delete worker.cleanup.completedAt;
      }
      worker.updatedAt = now;
      this.event(state, "worker.cleanup.receipt.recorded", context.actor, now, {
        workerId: worker.id,
        taskId: worker.taskId,
        close: input.close.status,
        archive: input.archive.status,
        permitRelease: input.permitRelease.status,
        completed: worker.cleanup.completedAt !== undefined
      });
      return state;
    });
  }

  acquireResource(runId: string, input: AcquireResourceInput, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "resource.acquire", context, (state, now) => {
      invariant(
        Number.isSafeInteger(input.leaseSeconds) && input.leaseSeconds > 0 && input.leaseSeconds <= 86_400,
        "Resource lease seconds must be between 1 and 86400",
        "RESOURCE_LEASE_INVALID"
      );
      this.assertResourceActor(input.owner, context.actor);
      const task = state.tasks[input.taskId];
      invariant(task?.status === "running" && task.owner === input.owner, "Resource owner must own a running task", "RESOURCE_TASK_OWNER_INVALID");
      invariant(task.stageId === input.stageId, "Resource stage must match the owner task", "RESOURCE_STAGE_MISMATCH");
      invariant(state.stages[input.stageId]?.status === "active", `Resource stage is not active: ${input.stageId}`, "RESOURCE_STAGE_NOT_ACTIVE");
      this.assertStagePreflight(state, input.stageId, now);
      const worker = state.workers[input.owner];
      invariant(
        worker?.taskId === input.taskId && ["running", "unknown"].includes(worker.status),
        "Resource owner must be a bound live worker",
        "RESOURCE_WORKER_INVALID"
      );

      const existing = state.resources[input.resourceId];
      if (existing) {
        invariant(
          existing.kind === input.kind && existing.resourceKey === input.resourceKey,
          `Resource ID is already assigned: ${input.resourceId}`,
          "RESOURCE_ID_CONFLICT"
        );
        invariant(
          existing.status === "released" || Date.parse(existing.lease.expiresAt) <= Date.parse(now),
          `Resource is already active: ${input.resourceId}`,
          "RESOURCE_ALREADY_ACTIVE"
        );
        invariant(!existing.activeOperationId, "Expired resource still has an active operation", "RESOURCE_OPERATION_ACTIVE");
      }

      for (const candidate of Object.values(state.resources)) {
        if (
          candidate.id === input.resourceId ||
          candidate.kind !== input.kind ||
          candidate.resourceKey !== input.resourceKey ||
          candidate.status !== "active"
        ) continue;
        const expired = Date.parse(candidate.lease.expiresAt) <= Date.parse(now);
        if (expired && !candidate.activeOperationId) {
          candidate.status = "released";
          candidate.updatedAt = now;
          continue;
        }
        invariant(false, `Resource is owned by ${candidate.owner}`, "RESOURCE_CONFLICT", {
          resourceId: candidate.id,
          owner: candidate.owner
        });
      }

      const lease = {
        owner: input.owner,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.parse(now) + input.leaseSeconds * 1000).toISOString()
      };
      state.resources[input.resourceId] = ExclusiveResourceSchema.parse({
        id: input.resourceId,
        kind: input.kind,
        resourceKey: input.resourceKey,
        stageId: input.stageId,
        taskId: input.taskId,
        owner: input.owner,
        status: "active",
        lease,
        operations: existing?.operations ?? [],
        metadata: input.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      this.event(state, "resource.acquired", context.actor, now, {
        resourceId: input.resourceId,
        kind: input.kind,
        resourceKey: input.resourceKey,
        owner: input.owner,
        leaseSeconds: input.leaseSeconds
      });
      return state;
    });
  }

  heartbeatResource(
    runId: string,
    resourceId: string,
    owner: string,
    leaseSeconds: number,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "resource.heartbeat", context, (state, now) => {
      invariant(
        Number.isSafeInteger(leaseSeconds) && leaseSeconds > 0 && leaseSeconds <= 86_400,
        "Resource lease seconds must be between 1 and 86400",
        "RESOURCE_LEASE_INVALID"
      );
      this.assertResourceActor(owner, context.actor);
      const resource = state.resources[resourceId];
      invariant(resource?.status === "active", `Resource is not active: ${resourceId}`, "RESOURCE_NOT_ACTIVE");
      invariant(resource.owner === owner && resource.lease.owner === owner, "Resource owner does not match", "RESOURCE_OWNER_MISMATCH");
      invariant(Date.parse(resource.lease.expiresAt) > Date.parse(now), "Resource lease has expired", "RESOURCE_LEASE_EXPIRED");
      resource.lease.heartbeatAt = now;
      resource.lease.expiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      resource.updatedAt = now;
      this.event(state, "resource.heartbeat", context.actor, now, { resourceId, owner, leaseSeconds });
      return state;
    });
  }

  rekeyResource(
    runId: string,
    resourceId: string,
    owner: string,
    resourceKey: string,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "resource.rekey", context, (state, now) => {
      this.assertResourceActor(owner, context.actor);
      const resource = state.resources[resourceId];
      invariant(resource?.status === "active", `Resource is not active: ${resourceId}`, "RESOURCE_NOT_ACTIVE");
      invariant(resource.owner === owner, "Resource owner does not match", "RESOURCE_OWNER_MISMATCH");
      invariant(state.stages[resource.stageId]?.status === "active", `Resource stage is not active: ${resource.stageId}`, "RESOURCE_STAGE_NOT_ACTIVE");
      this.assertStagePreflight(state, resource.stageId, now);
      const task = state.tasks[resource.taskId];
      invariant(task?.status === "running" && task.owner === owner && task.lease, "Resource task is not owned and running", "RESOURCE_TASK_OWNER_INVALID");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Resource task lease has expired", "TASK_LEASE_EXPIRED");
      const worker = state.workers[owner];
      invariant(
        worker?.taskId === resource.taskId && ["running", "unknown"].includes(worker.status),
        "Resource owner is not a bound live worker",
        "RESOURCE_WORKER_INVALID"
      );
      invariant(Date.parse(resource.lease.expiresAt) > Date.parse(now), "Resource lease has expired", "RESOURCE_LEASE_EXPIRED");
      invariant(!resource.activeOperationId, "Cannot rekey a resource with an active operation", "RESOURCE_OPERATION_ACTIVE");
      for (const candidate of Object.values(state.resources)) {
        if (
          candidate.id !== resourceId &&
          candidate.kind === resource.kind &&
          candidate.resourceKey === resourceKey &&
          candidate.status === "active"
        ) {
          invariant(false, `Resource key is already owned by ${candidate.owner}`, "RESOURCE_CONFLICT", {
            resourceId: candidate.id,
            owner: candidate.owner
          });
        }
      }
      const previousResourceKey = resource.resourceKey;
      resource.resourceKey = resourceKey;
      resource.updatedAt = now;
      this.event(state, "resource.rekeyed", context.actor, now, {
        resourceId,
        owner,
        previousResourceKey,
        resourceKey
      });
      return state;
    });
  }

  beginResourceOperation(
    runId: string,
    resourceId: string,
    owner: string,
    operationId: string,
    tool: string,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "resource.operation.begin", context, (state, now) => {
      this.assertResourceActor(owner, context.actor);
      const resource = state.resources[resourceId];
      invariant(resource?.status === "active", `Resource is not active: ${resourceId}`, "RESOURCE_NOT_ACTIVE");
      invariant(resource.owner === owner, "Resource owner does not match", "RESOURCE_OWNER_MISMATCH");
      invariant(state.stages[resource.stageId]?.status === "active", `Resource stage is not active: ${resource.stageId}`, "RESOURCE_STAGE_NOT_ACTIVE");
      this.assertStagePreflight(state, resource.stageId, now);
      const task = state.tasks[resource.taskId];
      invariant(task?.status === "running" && task.owner === owner && task.lease, "Resource task is not owned and running", "RESOURCE_TASK_OWNER_INVALID");
      invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Resource task lease has expired", "TASK_LEASE_EXPIRED");
      const worker = state.workers[owner];
      invariant(
        worker?.taskId === resource.taskId && ["running", "unknown"].includes(worker.status),
        "Resource owner is not a bound live worker",
        "RESOURCE_WORKER_INVALID"
      );
      invariant(Date.parse(resource.lease.expiresAt) > Date.parse(now), "Resource lease has expired", "RESOURCE_LEASE_EXPIRED");
      invariant(!resource.activeOperationId, `Resource already has an active operation: ${resource.activeOperationId}`, "RESOURCE_OPERATION_ACTIVE");
      invariant(
        !resource.operations.some((operation) => operation.id === operationId),
        `Resource operation already exists: ${operationId}`,
        "RESOURCE_OPERATION_EXISTS"
      );
      if (resource.operations.length >= 500) resource.operations.splice(0, resource.operations.length - 499);
      resource.operations.push(ResourceOperationSchema.parse({
        id: operationId,
        tool,
        status: "running",
        startedAt: now,
        affectedNodeIds: [],
        summary: ""
      }));
      resource.activeOperationId = operationId;
      resource.updatedAt = now;
      this.event(state, "resource.operation.started", context.actor, now, { resourceId, operationId, tool });
      return state;
    });
  }

  finishResourceOperation(
    runId: string,
    resourceId: string,
    owner: string,
    input: FinishResourceOperationInput,
    context: MutationContext
  ): Promise<RunState> {
    return this.mutate(runId, "resource.operation.finish", context, (state, now) => {
      this.assertResourceActor(owner, context.actor);
      const resource = state.resources[resourceId];
      invariant(resource?.status === "active", `Resource is not active: ${resourceId}`, "RESOURCE_NOT_ACTIVE");
      invariant(resource.owner === owner, "Resource owner does not match", "RESOURCE_OWNER_MISMATCH");
      invariant(resource.activeOperationId === input.operationId, "Resource operation is not active", "RESOURCE_OPERATION_MISMATCH");
      const operation = resource.operations.find((candidate) => candidate.id === input.operationId);
      invariant(operation?.status === "running", `Resource operation is not running: ${input.operationId}`, "RESOURCE_OPERATION_NOT_RUNNING");
      if (input.status === "completed") {
        invariant(input.resultHash, "Completed resource operation requires a result hash", "RESOURCE_RESULT_HASH_REQUIRED");
      }
      operation.status = input.status;
      operation.completedAt = now;
      if (input.resultHash !== undefined) operation.resultHash = input.resultHash;
      operation.affectedNodeIds = input.affectedNodeIds ?? [];
      operation.summary = input.summary ?? "";
      delete resource.activeOperationId;
      resource.updatedAt = now;
      this.event(state, `resource.operation.${input.status}`, context.actor, now, {
        resourceId,
        operationId: input.operationId,
        resultHash: input.resultHash,
        affectedNodeCount: operation.affectedNodeIds.length
      });
      return state;
    });
  }

  releaseResource(runId: string, resourceId: string, owner: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "resource.release", context, (state, now) => {
      this.assertResourceActor(owner, context.actor);
      const resource = state.resources[resourceId];
      invariant(resource?.status === "active", `Resource is not active: ${resourceId}`, "RESOURCE_NOT_ACTIVE");
      invariant(resource.owner === owner, "Resource owner does not match", "RESOURCE_OWNER_MISMATCH");
      invariant(!resource.activeOperationId, "Cannot release a resource with an active operation", "RESOURCE_OPERATION_ACTIVE");
      resource.status = "released";
      resource.updatedAt = now;
      this.event(state, "resource.released", context.actor, now, { resourceId, owner, reason });
      return state;
    });
  }

  registerArtifact(runId: string, input: RegisterArtifactInput, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "artifact.register", context, (state, now) => {
      stageById(this.pipeline, input.stageId);
      const previous = state.artifacts[input.id];
      invariant(
        previous === undefined || previous.stageId === input.stageId,
        `Artifact Stage cannot change after registration: ${input.id}`,
        "ARTIFACT_STAGE_IMMUTABLE",
        { artifactId: input.id, previousStageId: previous?.stageId, nextStageId: input.stageId }
      );
      const artifact = ArtifactSchema.parse({
        ...input,
        stale: false,
        metadata: input.metadata ?? {},
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      });
      state.artifacts[input.id] = artifact;

      if (previous && (previous.sha256 !== artifact.sha256 || previous.kind !== artifact.kind)) {
        this.invalidateForArtifactChange(
          state,
          input.id,
          previous.sha256,
          artifact.sha256,
          previous.kind,
          artifact.kind,
          now
        );
      }
      this.event(state, "artifact.registered", context.actor, now, { artifactId: input.id, sha256: input.sha256 });
      return state;
    });
  }

  resolveGate(runId: string, input: ResolveGateInput, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "gate.resolve", context, (state, now) => {
      const gate = state.gates[input.gateId];
      invariant(gate, `Gate not found: ${input.gateId}`, "GATE_NOT_FOUND");
      invariant(gate.status === "pending" || gate.status === "stale" || gate.status === "rejected", `Gate is already ${gate.status}`, "GATE_NOT_PENDING");
      if (gate.type === "human") {
        invariant(context.actor.kind === "user", "Human gates require a user actor", "HUMAN_GATE_REQUIRES_USER");
      } else {
        invariant(context.actor.kind === "system" || context.actor.kind === "supervisor", "Automatic gates require system or supervisor", "AUTOMATIC_GATE_ACTOR_INVALID");
      }

      if (input.decision === "approved") {
        const selectableOptions = gate.options.filter((option) => !["approve", "approved", "reject", "rejected"].includes(option.toLowerCase()));
        if (selectableOptions.length > 0) {
          invariant(input.choice, `Gate requires a selected option: ${gate.id}`, "GATE_CHOICE_REQUIRED");
          invariant(selectableOptions.includes(input.choice), `Invalid gate option: ${input.choice}`, "GATE_CHOICE_INVALID", {
            gateId: gate.id,
            allowedOptions: selectableOptions
          });
        } else if (input.choice !== undefined) {
          invariant(gate.options.includes(input.choice), `Invalid gate option: ${input.choice}`, "GATE_CHOICE_INVALID");
        }
        const stage = stageById(this.pipeline, gate.stageId);
        const artifactKinds = new Set(
          Object.values(state.artifacts)
            .filter((artifact) => artifact.stageId === gate.stageId && !artifact.stale)
            .map((artifact) => artifact.kind)
        );
        for (const kind of stage.requiredArtifactKinds) {
          invariant(artifactKinds.has(kind), `Cannot approve gate without artifact kind: ${kind}`, "GATE_ARTIFACT_MISSING");
        }
      }

      gate.status = input.decision;
      gate.resolution = input.resolution;
      if (input.decision === "approved" && input.choice !== undefined) gate.selectedOption = input.choice;
      else delete gate.selectedOption;
      gate.resolvedBy = context.actor.id;
      gate.resolvedByKind = context.actor.kind;
      gate.resolvedAt = now;
      gate.artifactHashes = Object.fromEntries(
        Object.values(state.artifacts)
          .filter((artifact) => artifact.stageId === gate.stageId && !artifact.stale)
          .map((artifact) => [artifact.id, artifact.sha256])
      );
      this.event(state, `gate.${input.decision}`, context.actor, now, { gateId: gate.id });
      return state;
    });
  }

  completeStage(runId: string, stageId: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "stage.complete", context, (state, now) => {
      const stage = stageById(this.pipeline, stageId);
      const stageRun = state.stages[stageId];
      invariant(stageRun?.status === "active", `Stage is not active: ${stageId}`, "STAGE_NOT_ACTIVE");
      this.assertStagePreflight(state, stageId, now);
      const tasks = Object.values(state.tasks).filter((task) => task.stageId === stageId);
      const taskIds = new Set(tasks.map((task) => task.id));
      const liveWorker = Object.values(state.workers)
        .find((worker) => taskIds.has(worker.taskId) && isLiveWorker(worker.status));
      invariant(
        !liveWorker,
        `Stage still has a live worker: ${stageId}`,
        "STAGE_WORKER_LIVE",
        {
          stageId,
          taskId: liveWorker?.taskId,
          workerId: liveWorker?.id,
          workerStatus: liveWorker?.status
        }
      );
      const pendingCleanupWorkerId = pendingTerminalCleanup(state)
        .find((workerId) => taskIds.has(state.workers[workerId]?.taskId ?? ""));
      invariant(
        pendingCleanupWorkerId === undefined,
        `Stage still has pending terminal Worker cleanup: ${stageId}`,
        "STAGE_WORKER_CLEANUP_PENDING",
        {
          stageId,
          workerId: pendingCleanupWorkerId,
          taskId: pendingCleanupWorkerId === undefined
            ? undefined
            : state.workers[pendingCleanupWorkerId]?.taskId
        }
      );
      invariant(tasks.every((task) => task.status === "completed" || task.status === "cancelled"), "Stage has incomplete tasks", "STAGE_TASKS_INCOMPLETE");

      const artifactKinds = new Set(
        Object.values(state.artifacts)
          .filter((artifact) => artifact.stageId === stageId && !artifact.stale)
          .map((artifact) => artifact.kind)
      );
      for (const kind of requiredArtifactKindsForLane(state.workflow.lane, stageId, stage.requiredArtifactKinds)) {
        invariant(artifactKinds.has(kind), `Missing required artifact kind: ${kind}`, "STAGE_ARTIFACT_MISSING", { stageId, kind });
      }
      if (stage.requiredGate) {
        const gate = state.gates[stage.requiredGate.id];
        invariant(gate?.status === "approved", `Required gate is not approved: ${stage.requiredGate.id}`, "STAGE_GATE_UNAPPROVED");
        for (const [artifactId, hash] of Object.entries(gate.artifactHashes)) {
          invariant(state.artifacts[artifactId]?.sha256 === hash, `Approved artifact changed: ${artifactId}`, "GATE_ARTIFACT_CHANGED");
        }
      }

      stageRun.status = "completed";
      stageRun.completedAt = now;
      delete stageRun.staleReason;
      this.event(state, "stage.completed", context.actor, now, { stageId });

      this.advanceRun(state, context.actor, now);
      return state;
    });
  }

  skipStage(runId: string, stageId: string, reason: string, context: MutationContext): Promise<RunState> {
    return this.mutate(runId, "stage.skip", context, (state, now) => {
      const stage = stageById(this.pipeline, stageId);
      const stageRun = state.stages[stageId];
      invariant(stageRun?.status === "active", `Stage is not active: ${stageId}`, "STAGE_NOT_ACTIVE");
      invariant(
        stage.skippableWhen.includes("hasUi=false") && !state.hasUi,
        `Stage cannot be skipped under current run conditions: ${stageId}`,
        "STAGE_NOT_SKIPPABLE"
      );
      stageRun.status = "skipped";
      stageRun.completedAt = now;
      this.event(state, "stage.skipped", context.actor, now, { stageId, reason });
      this.advanceRun(state, context.actor, now);
      return state;
    });
  }

  private advanceRun(state: RunState, actor: Actor, now: string): void {
    while (true) {
      const next = readyStages(this.pipeline, state)[0];
      if (!next) {
        invariant(
          this.pipeline.stages.every((stage) => ["completed", "skipped"].includes(state.stages[stage.id]?.status ?? "")),
          "No Stage is ready but the Run still has unfinished Stages",
          "NO_READY_STAGE"
        );
        this.assertRunTerminable(state);
        this.terminalizeRun(state, "completed", "succeeded", "All eligible Stages completed", actor, now);
        return;
      }

      const nextRun = state.stages[next.id];
      invariant(nextRun, `Missing stage state: ${next.id}`, "STAGE_STATE_MISSING");
      if (!state.workflow.eligibleStageIds.includes(next.id)) {
        nextRun.status = "skipped";
        nextRun.startedAt ??= now;
        nextRun.completedAt = now;
        delete nextRun.staleReason;
        if (!state.workflow.policySkippedStageIds.includes(next.id)) {
          state.workflow.policySkippedStageIds.push(next.id);
        }
        for (const task of Object.values(state.tasks)) {
          if (task.stageId !== next.id || !["pending", "ready"].includes(task.status)) continue;
          task.status = "cancelled";
          task.updatedAt = now;
        }
        this.event(state, "stage.skipped", actor, now, {
          stageId: next.id,
          reason: "workflow-policy",
          lane: state.workflow.lane,
          policyVersion: state.workflow.policyVersion
        });
        continue;
      }

      nextRun.status = "active";
      nextRun.startedAt = now;
      delete nextRun.completedAt;
      delete nextRun.staleReason;
      state.activeStageId = next.id;
      this.readyTasksForStage(state, next.id, now);
      this.event(state, "stage.started", actor, now, { stageId: next.id });
      return;
    }
  }

  private restoreNewlyEligibleStages(
    state: RunState,
    previouslySkippedStageIds: string[],
    actor: Actor,
    now: string
  ): void {
    const newlyEligible = previouslySkippedStageIds.filter((stageId) => state.workflow.eligibleStageIds.includes(stageId));
    if (newlyEligible.length === 0) return;
    const indexes = new Map(this.pipeline.stages.map((stage, index) => [stage.id, index]));
    const earliestIndex = Math.min(...newlyEligible.map((stageId) => indexes.get(stageId) ?? Number.MAX_SAFE_INTEGER));
    const affectedStageIds = new Set(this.pipeline.stages.slice(earliestIndex).map((stage) => stage.id));
    const materialArtifact = Object.values(state.artifacts)
      .find((artifact) => affectedStageIds.has(artifact.stageId) && !artifact.stale);
    const materialTask = Object.values(state.tasks)
      .find((task) => affectedStageIds.has(task.stageId) && ["running", "completed", "failed", "blocked"].includes(task.status));
    const materialGate = Object.values(state.gates)
      .find((gate) => affectedStageIds.has(gate.stageId) && gate.status !== "pending");
    const materialStage = this.pipeline.stages
      .find((stage) => affectedStageIds.has(stage.id) && state.stages[stage.id]?.status === "completed");
    const activeResource = Object.values(state.resources)
      .find((resource) => affectedStageIds.has(resource.stageId) && resource.status === "active");
    invariant(
      !materialArtifact && !materialTask && !materialGate && !materialStage && !activeResource,
      "Workflow escalation discovered material downstream work and requires explicit replanning",
      "WORKFLOW_ESCALATION_REPLAN_REQUIRED",
      {
        artifactId: materialArtifact?.id,
        taskId: materialTask?.id,
        gateId: materialGate?.id,
        stageId: materialStage?.id,
        resourceId: activeResource?.id
      }
    );

    const activeStageId = state.activeStageId;
    if (activeStageId && affectedStageIds.has(activeStageId)) {
      const activeStage = state.stages[activeStageId];
      if (activeStage?.status === "active") {
        activeStage.status = "pending";
        delete activeStage.startedAt;
      }
      for (const task of Object.values(state.tasks)) {
        if (task.stageId === activeStageId && task.status === "ready") {
          task.status = "pending";
          task.updatedAt = now;
        }
      }
      delete state.activeStageId;
    }
    for (const stageId of newlyEligible) {
      const stage = state.stages[stageId];
      if (!stage) continue;
      stage.status = "pending";
      delete stage.startedAt;
      delete stage.completedAt;
      delete stage.staleReason;
      for (const task of Object.values(state.tasks)) {
        if (task.stageId === stageId && task.status === "cancelled") {
          task.status = "pending";
          task.updatedAt = now;
        }
      }
    }
    state.workflow.policySkippedStageIds = state.workflow.policySkippedStageIds
      .filter((stageId) => !newlyEligible.includes(stageId));
    this.event(state, "workflow.stages-restored", actor, now, { stageIds: newlyEligible });
    this.advanceRun(state, actor, now);
  }

  private assertRunTerminable(state: RunState): void {
    invariant(state.executionStatus !== "terminal", `Run is already terminal: ${state.id}`, "RUN_TERMINAL");
    const liveWorker = Object.values(state.workers).find((worker) => isLiveWorker(worker.status));
    invariant(!liveWorker, `Run still has a live Worker: ${liveWorker?.id}`, "RUN_WORKER_LIVE", {
      workerId: liveWorker?.id,
      taskId: liveWorker?.taskId,
      status: liveWorker?.status
    });
    const runningTask = Object.values(state.tasks).find((task) => task.status === "running");
    invariant(!runningTask, `Run still has a running Task: ${runningTask?.id}`, "RUN_TASK_LIVE", {
      taskId: runningTask?.id,
      owner: runningTask?.owner,
      ownerKind: runningTask?.ownerKind
    });
    const activeOperation = Object.values(state.resources).find((resource) => resource.activeOperationId !== undefined);
    invariant(!activeOperation, `Run still has an external operation: ${activeOperation?.activeOperationId}`, "RUN_RESOURCE_OPERATION_LIVE", {
      resourceId: activeOperation?.id,
      operationId: activeOperation?.activeOperationId
    });
    const activeResource = Object.values(state.resources).find((resource) => resource.status === "active");
    invariant(!activeResource, `Run still has an active resource: ${activeResource?.id}`, "RUN_RESOURCE_ACTIVE", {
      resourceId: activeResource?.id,
      owner: activeResource?.owner
    });
    const cleanupWorkerIds = pendingTerminalCleanup(state);
    invariant(cleanupWorkerIds.length === 0, "Run still has pending terminal Worker cleanup", "RUN_CLEANUP_PENDING", {
      workerIds: cleanupWorkerIds
    });
  }

  private terminalizeRun(
    state: RunState,
    status: Exclude<RunState["status"], "active">,
    outcome: NonNullable<RunState["businessOutcome"]>,
    reason: string,
    actor: Actor,
    now: string,
    data: Record<string, unknown> = {}
  ): void {
    state.status = status;
    state.executionStatus = "terminal";
    state.businessOutcome = outcome;
    delete state.activeStageId;
    for (const task of Object.values(state.tasks)) {
      if (!["pending", "ready"].includes(task.status)) continue;
      task.status = "cancelled";
      delete task.lease;
      task.updatedAt = now;
    }
    this.event(state, `run.${status}`, actor, now, { reason, ...data });
  }

  private initialWorkerCleanup(closeSupported: boolean): NonNullable<RunState["workers"][string]["cleanup"]> {
    return {
      close: closeSupported
        ? { status: "pending" }
        : { status: "unsupported", reason: "Adapter has no native close capability" },
      archive: { status: "pending" },
      permitRelease: { status: "pending" }
    };
  }

  private mutate(
    runId: string,
    operation: string,
    context: MutationContext,
    update: (state: RunState, now: string) => RunState
  ): Promise<RunState> {
    return this.store.transact(runId, { ...context, operation }, (state) => update(state, new Date().toISOString()));
  }

  private invalidateForArtifactChange(
    state: RunState,
    artifactId: string,
    previousHash: string,
    nextHash: string,
    previousKind: string,
    nextKind: string,
    now: string
  ): void {
    const artifact = state.artifacts[artifactId];
    if (!artifact) return;
    const downstream = new Set(downstreamStageIds(this.pipeline, artifact.stageId));

    for (const gate of Object.values(state.gates)) {
      if (
        gate.artifactHashes[artifactId] === previousHash ||
        (downstream.has(gate.stageId) && gate.status !== "pending")
      ) {
        gate.status = "stale";
        gate.resolution = `Upstream artifact ${artifactId} changed after this decision`;
      }
    }

    for (const candidate of Object.values(state.artifacts)) {
      if (downstream.has(candidate.stageId)) {
        candidate.stale = true;
        candidate.updatedAt = now;
      }
    }

    for (const task of Object.values(state.tasks)) {
      if (!downstream.has(task.stageId) || task.status === "cancelled") continue;
      if (task.materializedFrom?.artifactId === artifactId) {
        task.status = "cancelled";
        delete task.owner;
        delete task.lease;
        task.verification = [];
        delete task.result;
        task.updatedAt = now;
        continue;
      }
      if (task.inputArtifactHashes[artifactId] === previousHash) {
        task.inputArtifactHashes[artifactId] = nextHash;
      }
      task.status = "pending";
      delete task.owner;
      delete task.lease;
      task.verification = [];
      delete task.result;
      task.updatedAt = now;
    }

    for (const worker of Object.values(state.workers)) {
      const task = state.tasks[worker.taskId];
      if (task && downstream.has(task.stageId) && isLiveWorker(worker.status)) {
        worker.status = "interrupted";
        worker.updatedAt = now;
      }
    }

    for (const stageId of downstream) {
      delete state.preflights[stageId];
      const stage = state.stages[stageId];
      if (stage && stage.status !== "skipped") {
        stage.status = "stale";
        stage.staleReason = artifactChangeReason(artifactId, previousHash, nextHash, previousKind, nextKind);
        delete stage.completedAt;
      }
    }
    const sourceStage = state.stages[artifact.stageId];
    if (sourceStage) {
      sourceStage.status = "active";
      sourceStage.startedAt = now;
      sourceStage.staleReason = `Artifact ${artifactId} changed and requires renewed approval`;
      delete sourceStage.completedAt;
      state.activeStageId = artifact.stageId;
    }
    state.status = "active";
    state.executionStatus = "running";
    delete state.businessOutcome;
    this.event(state, "artifact.invalidated-downstream", { id: "system", kind: "system" }, now, {
      artifactId,
      previousHash,
      nextHash,
      previousKind,
      nextKind
    });
  }

  private event(
    state: RunState,
    type: string,
    actor: Actor,
    at: string,
    data: Record<string, unknown>
  ): void {
    state.events.push({ id: `event-${randomUUID()}`, type, actorId: actor.id, actorKind: actor.kind, at, data });
    if (state.events.length > 1_000) state.events.splice(0, state.events.length - 1_000);
  }

  private assertWorkerChangeSet(task: Task, result: WorkerResult): void {
    if (
      result.status === "completed"
      && (task.requiresWorktree || task.materializedFrom?.kind === "implementation-plan")
    ) {
      invariant(
        result.changeSet !== null,
        `Completed implementation Task must record a Git change set: ${task.id}`,
        "WORKER_CHANGESET_REQUIRED",
        { taskId: task.id }
      );
    }
    if (result.changeSet === null) return;
    invariant(task.workspace, `Task has no bound workspace: ${task.id}`, "WORKER_CHANGESET_WORKSPACE_MISSING", {
      taskId: task.id
    });
    const expectedBaseRevision = task.planRepository?.baseRevision ?? task.workspace.baseRevision;
    if (expectedBaseRevision !== undefined) {
      invariant(
        result.changeSet.baseRevision === expectedBaseRevision,
        "Worker change set base revision does not match the bound workspace",
        "WORKER_CHANGESET_BASE_MISMATCH",
        {
          taskId: task.id,
          expectedBaseRevision,
          actualBaseRevision: result.changeSet.baseRevision
        }
      );
    }
    for (const path of result.changeSet.changedPaths) {
      invariant(
        task.writeScopes.some((scope) => scopeContainsPath(scope, path)),
        `Worker change set path is outside the Task write scopes: ${path}`,
        "WORKER_CHANGESET_PATH_FORBIDDEN",
        { taskId: task.id, path, writeScopes: task.writeScopes }
      );
      invariant(
        !task.forbiddenScopes.some((scope) => scopeContainsPath(scope, path)),
        `Worker change set path is explicitly forbidden: ${path}`,
        "WORKER_CHANGESET_PATH_FORBIDDEN",
        { taskId: task.id, path, forbiddenScopes: task.forbiddenScopes }
      );
    }
  }

  private claimTaskState(
    state: RunState,
    taskId: string,
    workerId: string,
    leaseSeconds: number,
    now: string
  ): Task {
    invariant(
      Number.isSafeInteger(leaseSeconds) && leaseSeconds >= 1 && leaseSeconds <= 86_400,
      "Task lease seconds must be a safe integer between 1 and 86400",
      "TASK_LEASE_INVALID",
      { leaseSeconds }
    );
    const task = state.tasks[taskId];
    invariant(task, `Task not found: ${taskId}`, "TASK_NOT_FOUND");
    invariant(state.stages[task.stageId]?.status === "active", `Task stage is not active: ${task.stageId}`, "TASK_STAGE_NOT_ACTIVE");
    this.assertStagePreflight(state, task.stageId, now);
    const expired = task.lease ? Date.parse(task.lease.expiresAt) <= Date.parse(now) : false;
    invariant(task.status === "ready" || (task.status === "running" && expired), `Task is not claimable: ${task.status}`, "TASK_NOT_CLAIMABLE");
    invariant(task.dependsOn.every((id) => state.tasks[id]?.status === "completed"), "Task dependencies are incomplete", "TASK_DEPENDENCIES_INCOMPLETE");
    for (const [artifactId, hash] of Object.entries(task.inputArtifactHashes)) {
      const artifact = state.artifacts[artifactId];
      const expectedKind = task.inputArtifactKinds[artifactId];
      invariant(
        artifact?.sha256 === hash && !artifact.stale && (expectedKind === undefined || artifact.kind === expectedKind),
        `Task input artifact changed: ${artifactId}`,
        "TASK_INPUT_STALE",
        {
          artifactId,
          expectedHash: hash,
          actualHash: artifact?.sha256,
          expectedKind,
          actualKind: artifact?.kind,
          stale: artifact?.stale
        }
      );
    }

    for (const candidate of Object.values(state.tasks)) {
      if (candidate.id === task.id || candidate.status !== "running" || !candidate.lease) continue;
      if (Date.parse(candidate.lease.expiresAt) <= Date.parse(now)) continue;
      invariant(
        !scopesConflict(task.writeScopes, candidate.writeScopes),
        `Write scope conflicts with running task ${candidate.id}`,
        "WRITE_SCOPE_CONFLICT",
        { taskId, conflictingTaskId: candidate.id }
      );
    }

    task.status = "running";
    task.owner = workerId;
    task.lease = {
      owner: workerId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString()
    };
    task.updatedAt = now;
    return task;
  }

  private prepareWorkerState(state: RunState, input: PrepareWorkerInput, now: string): void {
    invariant(!state.workers[input.workerId], `Worker already exists: ${input.workerId}`, "WORKER_EXISTS");
    const task = state.tasks[input.taskId];
    invariant(task?.status === "running" && task.lease, `Task is not running: ${input.taskId}`, "TASK_NOT_RUNNING");
    invariant(task.owner === input.workerId, "Prepared worker must own the task lease", "TASK_OWNER_MISMATCH");
    invariant(Date.parse(task.lease.expiresAt) > Date.parse(now), "Task lease expired before Worker preparation", "TASK_LEASE_EXPIRED");
    invariant(
      !task.requiresWorktree || task.workspace?.kind === "worktree",
      `Task requires a bound worktree before Worker preparation: ${input.taskId}`,
      "TASK_WORKTREE_REQUIRED"
    );
    invariant(
      !Object.values(state.workers).some((worker) => worker.taskId === input.taskId && isLiveWorker(worker.status)),
      `Task already has a live worker: ${input.taskId}`,
      "TASK_WORKER_EXISTS"
    );
    state.workers[input.workerId] = WorkerSchema.parse({
      id: input.workerId,
      taskId: input.taskId,
      adapter: input.adapter,
      protocolVersion: input.protocolVersion ?? 1,
      hostTaskName: input.hostTaskName,
      promptHash: input.promptHash,
      status: "prepared",
      capabilities: input.capabilities,
      createdAt: now,
      updatedAt: now
    });
  }

  private completeTaskState(
    state: RunState,
    taskId: string,
    workerId: string,
    verification: VerificationRecord[],
    result: Record<string, unknown>,
    now: string
  ): void {
    const task = state.tasks[taskId];
    invariant(task?.status === "running", `Task is not running: ${taskId}`, "TASK_NOT_RUNNING");
    invariant(task.owner === workerId, "Worker does not own task", "TASK_OWNER_MISMATCH");
    const records = verification.map((record) => VerificationRecordSchema.parse(record));
    invariant(
      records.length > 0 && records.every((record) => record.status === "passed"),
      "Completion requires passing verification evidence",
      "VERIFICATION_REQUIRED"
    );
    const missingCommands = task.verificationCommands.filter(
      (command) => !records.some((record) => record.command === command && record.status === "passed")
    );
    invariant(
      missingCommands.length === 0,
      "Completion evidence does not cover every declared verification command",
      "VERIFICATION_COMMAND_MISSING",
      { taskId, missingCommands }
    );
    task.status = "completed";
    task.verification = records;
    task.result = result;
    delete task.lease;
    task.updatedAt = now;

    for (const candidate of Object.values(state.tasks)) {
      if (
        candidate.status === "pending" &&
        state.stages[candidate.stageId]?.status === "active" &&
        candidate.dependsOn.every((id) => state.tasks[id]?.status === "completed") &&
        this.isTaskWaveReady(state, candidate)
      ) {
        candidate.status = "ready";
        candidate.updatedAt = now;
      }
    }
  }

  private isTaskWaveReady(state: RunState, task: Task): boolean {
    const waveIndex = task.waveIndex;
    if (waveIndex === undefined || task.materializedFrom === undefined) return true;
    return !Object.values(state.tasks).some((candidate) => (
      candidate.id !== task.id
      && candidate.stageId === task.stageId
      && candidate.materializedFrom?.artifactId === task.materializedFrom?.artifactId
      && candidate.materializedFrom?.sha256 === task.materializedFrom?.sha256
      && candidate.waveIndex !== undefined
      && candidate.waveIndex < waveIndex
      && candidate.status !== "completed"
      && candidate.status !== "cancelled"
    ));
  }

  private assertSupervisorWaveParticipation(state: RunState, task: Task): void {
    if (task.waveId === undefined || task.materializedFrom?.kind !== "implementation-plan") return;
    const supervisorTask = Object.values(state.tasks).find((candidate) => (
      candidate.id !== task.id
      && candidate.stageId === task.stageId
      && candidate.waveId === task.waveId
      && candidate.materializedFrom?.artifactId === task.materializedFrom?.artifactId
      && candidate.materializedFrom?.sha256 === task.materializedFrom?.sha256
      && candidate.ownerKind === "supervisor"
      && !["pending", "ready", "cancelled"].includes(candidate.status)
    ));
    invariant(
      supervisorTask !== undefined,
      `A Supervisor-owned Task must start before delegating wave ${task.waveId}`,
      "SUPERVISOR_WAVE_PARTICIPATION_REQUIRED",
      { taskId: task.id, waveId: task.waveId }
    );
  }

  private assertResourceActor(owner: string, actor: Actor): void {
    invariant(
      (actor.kind === "worker" && actor.id === owner) || actor.kind === "supervisor" || actor.kind === "system",
      "Actor cannot operate this exclusive resource",
      "RESOURCE_ACTOR_INVALID",
      { owner, actorId: actor.id, actorKind: actor.kind }
    );
  }

  private assertStagePreflight(state: RunState, stageId: string, now: string): void {
    const stage = stageById(this.pipeline, stageId);
    if (stage.requiredCapabilities.length === 0) return;
    const preflight = state.preflights[stageId];
    invariant(
      preflight?.status === "passed" && preflight.missingCapabilities.length === 0,
      `Stage capability preflight has not passed: ${stageId}`,
      "STAGE_PREFLIGHT_REQUIRED",
      { stageId, requiredCapabilities: stage.requiredCapabilities }
    );
    invariant(
      Date.parse(preflight.expiresAt) > Date.parse(now),
      `Stage capability preflight has expired: ${stageId}`,
      "STAGE_PREFLIGHT_EXPIRED",
      { stageId, expiresAt: preflight.expiresAt }
    );
  }

  private readyTasksForStage(state: RunState, stageId: string, now: string): void {
    for (const task of Object.values(state.tasks)) {
      if (
        task.stageId === stageId &&
        task.status === "pending" &&
        task.dependsOn.every((id) => state.tasks[id]?.status === "completed")
      ) {
        task.status = "ready";
        task.updatedAt = now;
      }
    }
  }
}

function isLiveWorker(status: WorkerStatus): boolean {
  return ["prepared", "starting", "running", "unknown"].includes(status);
}

export function pendingTerminalCleanup(state: Pick<RunState, "workers">): string[] {
  return Object.values(state.workers)
    .filter((worker) => !isLiveWorker(worker.status) && worker.cleanup !== undefined)
    .filter((worker) => {
      const cleanup = worker.cleanup;
      if (!cleanup || cleanup.completedAt !== undefined) return false;
      return [cleanup.close, cleanup.archive, cleanup.permitRelease]
        .some((step) => step.status === "pending" || step.status === "failed");
    })
    .map((worker) => worker.id)
    .sort();
}

function normalizeScope(scope: string): string {
  return scope.replaceAll("\\", "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
}

function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function scopesConflict(left: string[], right: string[]): boolean {
  return left.some((leftScope) => right.some((rightScope) => {
    const a = normalizeScope(leftScope);
    const b = normalizeScope(rightScope);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }));
}

function scopeContainsPath(scope: string, path: string): boolean {
  const root = normalizeScope(scope.slice(0, firstWildcardIndex(scope)));
  if (root.length === 0) return true;
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
}

function firstWildcardIndex(scope: string): number {
  const index = scope.search(/[*?\[]/);
  return index === -1 ? scope.length : index;
}

function artifactChangeReason(
  artifactId: string,
  previousHash: string,
  nextHash: string,
  previousKind: string,
  nextKind: string
): string {
  if (previousHash === nextHash) {
    return `Upstream artifact ${artifactId} changed kind from ${previousKind} to ${nextKind}`;
  }
  return `Upstream artifact ${artifactId} changed from ${previousHash} to ${nextHash}`;
}
