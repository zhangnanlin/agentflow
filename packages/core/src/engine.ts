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
  type MutationContext,
  type PipelineDefinition,
  type RunState,
  type Task,
  type TaskWorkspace,
  type ThreadCapabilities,
  type VerificationRecord,
  type WorkerResult,
  type WorkerStatus
} from "./model.js";
import { downstreamStageIds, readyStages, stageById, validatePipeline } from "./pipeline.js";
import type { RunStore } from "./store.js";

export interface CreateRunInput {
  id?: string;
  requirement: string;
  projectType?: "new" | "existing";
  hasUi?: boolean;
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

export interface PrepareWorkerInput {
  workerId: string;
  taskId: string;
  adapter: string;
  hostTaskName: string;
  promptHash: string;
  capabilities: ThreadCapabilities;
}

export interface PrepareTaskDispatchInput extends PrepareWorkerInput {
  leaseSeconds: number;
  workspace: Omit<TaskWorkspace, "boundAt">;
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
      this.claimTaskState(state, taskId, workerId, leaseSeconds, now);
      this.event(state, "task.claimed", context.actor, now, { taskId, workerId, leaseSeconds });
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
      claimed.workspace = workspace;
      this.prepareWorkerState(state, input, now);
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
    context: MutationContext
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
      worker.updatedAt = now;
      this.event(state, "worker.closed", context.actor, now, { workerId, taskId: worker.taskId, reason });
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
      invariant(tasks.every((task) => task.status === "completed" || task.status === "cancelled"), "Stage has incomplete tasks", "STAGE_TASKS_INCOMPLETE");

      const artifactKinds = new Set(
        Object.values(state.artifacts)
          .filter((artifact) => artifact.stageId === stageId && !artifact.stale)
          .map((artifact) => artifact.kind)
      );
      for (const kind of stage.requiredArtifactKinds) {
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

      const next = readyStages(this.pipeline, state)[0];
      if (next) {
        const nextRun = state.stages[next.id];
        invariant(nextRun, `Missing stage state: ${next.id}`, "STAGE_STATE_MISSING");
        nextRun.status = "active";
        nextRun.startedAt = now;
        delete nextRun.staleReason;
        state.activeStageId = next.id;
        this.readyTasksForStage(state, next.id, now);
        this.event(state, "stage.started", context.actor, now, { stageId: next.id });
      } else {
        state.status = "completed";
        delete state.activeStageId;
        this.event(state, "run.completed", context.actor, now, {});
      }
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
      const next = readyStages(this.pipeline, state)[0];
      invariant(next, `No stage became ready after skipping ${stageId}`, "NO_READY_STAGE");
      const nextRun = state.stages[next.id];
      invariant(nextRun, `Missing stage state: ${next.id}`, "STAGE_STATE_MISSING");
      nextRun.status = "active";
      nextRun.startedAt = now;
      state.activeStageId = next.id;
      this.readyTasksForStage(state, next.id, now);
      return state;
    });
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
