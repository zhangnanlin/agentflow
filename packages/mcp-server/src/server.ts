import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import {
  AgentFlowError,
  ArtifactContractKindSchema,
  artifactPayloadHash,
  isArtifactContractKind,
  validateArtifactPayload,
  sha256,
  ThreadCapabilitiesSchema,
  WorkerChangeSetSchema,
  WorkerResultSchema,
  type ArchitectureContract,
  type Artifact,
  type ArtifactContractKind,
  type Actor,
  type DesignConceptSetContract,
  type FinalManifestContract,
  type ImplementationPlanContract,
  type IntegrationReportContract,
  type PrdContract,
  type QaReportContract,
  type ReleasePlanContract,
  type RunState,
  type WorkerResult,
  type UxArchitectureContract,
  type VerificationRecord
} from "@agentflow/core";
import {
  AGENTFLOW_MCP_INSTRUCTIONS,
  DispatchWorkspaceSchema,
  buildWorkerDispatchInput,
  hashWorkerPrompt,
  renderWorkerPrompt,
  type DispatchWorkspace
} from "@agentflow/host-adapter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { assertProjectInitialized, startOrResumeRun } from "./project-lifecycle.js";
import { ProjectRootResolver } from "./project-root.js";
import {
  loadPipeline,
  mutationTarget,
  projectPaths,
  resolveRunId,
  createEngine
} from "./runtime.js";

const IdentifierSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const VerificationSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().default(""),
  recordedAt: z.iso.datetime({ offset: true })
});

const projectSelectorShape = {
  projectRoot: z.string().min(1).max(4_096).optional()
};

const runSelectorShape = {
  ...projectSelectorShape,
  runId: IdentifierSchema.optional()
};

const mutationShape = {
  ...projectSelectorShape,
  runId: IdentifierSchema,
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(256),
  actorId: IdentifierSchema,
  reason: z.string().min(1).max(2_000)
};

const readAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const;

const execFileAsync = promisify(execFile);

export interface AgentFlowMcpServerOptions {
  projectRoot?: string;
  projectRootResolver?: ProjectRootResolver;
}

export function createAgentFlowMcpServer(options: AgentFlowMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "agentflow",
    version: "0.1.0"
  }, {
    instructions: AGENTFLOW_MCP_INSTRUCTIONS
  });
  const resolver = options.projectRoot === undefined
    ? options.projectRootResolver ?? new ProjectRootResolver({
      listRoots: async () => (await server.server.listRoots()).roots
    })
    : new ProjectRootResolver({ fixedRoot: options.projectRoot });
  const pathsFor = async (explicitProjectRoot?: string) => (
    projectPaths((await resolver.resolve(explicitProjectRoot)).projectRoot)
  );
  const targetFor = async (
    input: Parameters<typeof mutationTarget>[1] & { projectRoot?: string | undefined },
    defaultActor: Actor
  ) => {
    const paths = await pathsFor(input.projectRoot);
    await assertProjectInitialized(paths);
    return { paths, target: await mutationTarget(paths, input, defaultActor) };
  };

  server.registerTool("pipeline_get", {
    title: "Get AgentFlow pipeline",
    description: "Return the pipeline definition configured for this project.",
    inputSchema: projectSelectorShape,
    annotations: readAnnotations
  }, async (input) => handleTool(async () => {
    const paths = await pathsFor(input?.projectRoot);
    await assertProjectInitialized(paths);
    return loadPipeline(paths);
  }));

  server.registerTool("status_get", {
    title: "Get AgentFlow run status",
    description: "Return a run state, defaulting to the project's current run.",
    inputSchema: runSelectorShape,
    annotations: readAnnotations
  }, async (input) => handleTool(async () => {
    const paths = await pathsFor(input?.projectRoot);
    await assertProjectInitialized(paths);
    const engine = await createEngine(paths);
    return engine.loadRun(await resolveRunId(input?.runId, paths));
  }));

  server.registerTool("run_start_or_resume", {
    title: "Start or resume an AgentFlow Run",
    description: "Initialize lightweight project state on first changing use, resume unfinished work, or start one new Run.",
    inputSchema: {
      ...projectSelectorShape,
      requirement: z.string().min(1).max(20_000),
      projectType: z.enum(["new", "existing"]),
      hasUi: z.boolean(),
      requestedRunId: IdentifierSchema.optional(),
      requestKey: z.string().min(1).max(256)
    }
  }, async (input) => handleTool(async () => {
    const paths = await pathsFor(input.projectRoot);
    return startOrResumeRun(paths, {
      requirement: input.requirement,
      projectType: input.projectType,
      hasUi: input.hasUi,
      ...(input.requestedRunId === undefined ? {} : { requestedRunId: input.requestedRunId }),
      requestKey: input.requestKey
    });
  }));

  server.registerTool("task_create", {
    title: "Create AgentFlow task",
    description: "Create a task in a pipeline stage through the AgentFlow state engine.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema,
      stageId: IdentifierSchema,
      title: z.string().min(1),
      description: z.string().default(""),
      profile: IdentifierSchema.optional(),
      dependsOn: z.array(IdentifierSchema).default([]),
      waveId: IdentifierSchema.optional(),
      componentIds: z.array(IdentifierSchema).default([]),
      requirementIds: z.array(IdentifierSchema).default([]),
      writeScopes: z.array(z.string().min(1)).default([]),
      forbiddenScopes: z.array(z.string().min(1)).default([]),
      inputArtifactHashes: z.record(IdentifierSchema, Sha256Schema).default({}),
      inputArtifactKinds: z.record(IdentifierSchema, IdentifierSchema).default({}),
      inputArtifactUris: z.record(IdentifierSchema, z.string().min(1)).default({}),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      verificationCommands: z.array(z.string().min(1)).default([]),
      expectedOutputs: z.array(z.string().min(1)).default([]),
      requiresWorktree: z.boolean().default(false),
      risk: z.enum(["low", "medium", "high"]).optional()
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.createTask(target.runId, {
      id: input.taskId,
      stageId: input.stageId,
      title: input.title,
      description: input.description,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      dependsOn: input.dependsOn,
      ...(input.waveId === undefined ? {} : { waveId: input.waveId }),
      componentIds: input.componentIds,
      requirementIds: input.requirementIds,
      writeScopes: input.writeScopes,
      forbiddenScopes: input.forbiddenScopes,
      inputArtifactHashes: input.inputArtifactHashes,
      inputArtifactKinds: input.inputArtifactKinds,
      inputArtifactUris: input.inputArtifactUris,
      acceptanceCriteria: input.acceptanceCriteria,
      verificationCommands: input.verificationCommands,
      expectedOutputs: input.expectedOutputs,
      requiresWorktree: input.requiresWorktree,
      ...(input.risk === undefined ? {} : { risk: input.risk })
    }, target.context);
  }));

  server.registerTool("implementation_plan_materialize", {
    title: "Materialize approved implementation plan",
    description: "Atomically create the active implementation Stage Task DAG from the exact approved implementation-plan payload.",
    inputSchema: {
      ...mutationShape,
      artifactId: IdentifierSchema,
      targetStageId: IdentifierSchema.optional(),
      payload: z.unknown()
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    const plan = validateArtifactPayload("implementation-plan", input.payload) as ImplementationPlanContract;
    validateArtifactReferences("implementation-plan", plan, target.state);
    const targetStageId = resolveStageId(input.targetStageId, target.state.activeStageId, target.runId);
    return target.engine.materializeImplementationPlan(target.runId, {
      artifactId: input.artifactId,
      targetStageId,
      plan
    }, target.context);
  }));

  server.registerTool("task_claim", {
    title: "Claim AgentFlow task",
    description: "Claim a ready task for a worker with a time-bounded lease.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema,
      workerId: IdentifierSchema,
      leaseSeconds: z.number().int().positive().max(86_400).default(900)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.workerId));
    return target.engine.claimTask(
      target.runId,
      input.taskId,
      input.workerId,
      input.leaseSeconds,
      target.context
    );
  }));

  server.registerTool("task_heartbeat", {
    title: "Heartbeat AgentFlow task",
    description: "Renew the lease for a running task owned by a worker.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema,
      workerId: IdentifierSchema,
      leaseSeconds: z.number().int().positive().max(86_400).default(900)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.workerId));
    return target.engine.heartbeatTask(
      target.runId,
      input.taskId,
      input.workerId,
      input.leaseSeconds,
      target.context
    );
  }));

  server.registerTool("task_complete", {
    title: "Complete AgentFlow task",
    description: "Complete a worker-owned task with verification evidence and a structured result.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema,
      workerId: IdentifierSchema,
      verification: z.array(VerificationSchema).min(1),
      result: z.record(z.string(), z.unknown()).default({})
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.workerId));
    return target.engine.completeTask(
      target.runId,
      input.taskId,
      input.workerId,
      input.verification as VerificationRecord[],
      input.result,
      target.context
    );
  }));

  server.registerTool("task_retry", {
    title: "Retry AgentFlow task",
    description: "Reset a blocked or failed task after its prior worker is terminal.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.retryTask(target.runId, input.taskId, input.reason, target.context);
  }));

  server.registerTool("task_setup_abort", {
    title: "Abort AgentFlow Task setup",
    description: "Return a claimed Task to the queue when workspace setup failed before any live Worker was prepared.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema,
      workerId: IdentifierSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.abortTaskSetup(
      target.runId,
      input.taskId,
      input.workerId,
      input.reason,
      target.context
    );
  }));

  server.registerTool("worker_prepare", {
    title: "Prepare AgentFlow worker",
    description: "Persist a claimed worker and bounded prompt hash before invoking the native host spawn operation.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema,
      taskId: IdentifierSchema,
      adapter: IdentifierSchema,
      hostTaskName: z.string().min(1).max(200),
      prompt: z.string().min(1).max(64_000),
      capabilities: ThreadCapabilitiesSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.prepareWorker(target.runId, {
      workerId: input.workerId,
      taskId: input.taskId,
      adapter: input.adapter,
      hostTaskName: input.hostTaskName,
      promptHash: sha256(input.prompt),
      capabilities: input.capabilities
    }, target.context);
  }));

  server.registerTool("worker_dispatch_prepare", {
    title: "Prepare deterministic Worker dispatch",
    description: "Atomically claim a ready Task, bind its verified workspace, persist a prepared Worker, and return the exact native prompt.",
    inputSchema: {
      ...mutationShape,
      taskId: IdentifierSchema,
      workerId: IdentifierSchema,
      adapter: IdentifierSchema.default("codex"),
      leaseSeconds: z.number().int().positive().max(86_400).default(900),
      capabilities: ThreadCapabilitiesSchema,
      workspace: DispatchWorkspaceSchema.optional()
    }
  }, async (input) => handleTool(async () => {
    const { paths, target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    const workspace = input.workspace ?? { kind: "project" as const, path: paths.projectRoot };
    const replayingPreparedDispatch = target.state.idempotency[input.idempotencyKey]?.operation === "worker.dispatch.prepare";
    if (!replayingPreparedDispatch) {
      await verifyDispatchWorkspace(paths.projectRoot, workspace);
      await verifyPlannedRepositoryBase(target.state, input.taskId, workspace);
    }
    const dispatch = buildWorkerDispatchInput(target.state, input.taskId, input.workerId, workspace, paths.projectRoot);
    const prompt = renderWorkerPrompt(dispatch);
    const promptHash = hashWorkerPrompt(dispatch);
    const existing = target.state.workers[input.workerId];
    if (existing && (
      existing.taskId !== input.taskId
      || existing.adapter !== input.adapter
      || existing.hostTaskName !== dispatch.taskName
      || existing.promptHash !== promptHash
      || JSON.stringify(existing.capabilities) !== JSON.stringify(input.capabilities)
    )) {
      throw new AgentFlowError("Prepared Worker does not match the dispatch retry", "WORKER_DISPATCH_RETRY_MISMATCH", {
        workerId: input.workerId,
        taskId: input.taskId
      });
    }
    const state = await target.engine.prepareTaskDispatch(target.runId, {
      workerId: input.workerId,
      taskId: input.taskId,
      adapter: input.adapter,
      hostTaskName: dispatch.taskName,
      promptHash,
      capabilities: input.capabilities,
      leaseSeconds: input.leaseSeconds,
      workspace
    }, target.context);
    return {
      runId: state.id,
      revision: state.revision,
      task: state.tasks[input.taskId],
      worker: state.workers[input.workerId],
      dispatch: {
        adapter: input.adapter,
        taskName: dispatch.taskName,
        profile: dispatch.profile,
        prompt,
        promptHash,
        workspace
      }
    };
  }));

  server.registerTool("worker_bind", {
    title: "Bind AgentFlow worker",
    description: "Bind a prepared worker to the native thread ID returned by the current editor host.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema,
      externalThreadId: z.string().min(1).max(512)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.bindWorker(target.runId, input.workerId, input.externalThreadId, target.context);
  }));

  server.registerTool("worker_status", {
    title: "Get AgentFlow worker status",
    description: "Return the persisted binding and last observed state for one worker.",
    inputSchema: {
      ...runSelectorShape,
      workerId: IdentifierSchema
    },
    annotations: readAnnotations
  }, async ({ projectRoot, runId, workerId }) => handleTool(async () => {
    const paths = await pathsFor(projectRoot);
    await assertProjectInitialized(paths);
    const engine = await createEngine(paths);
    const state = await engine.loadRun(await resolveRunId(runId, paths));
    const worker = state.workers[workerId];
    if (!worker) throw new AgentFlowError(`Worker not found: ${workerId}`, "WORKER_NOT_FOUND", { workerId });
    return worker;
  }));

  server.registerTool("worker_observe", {
    title: "Observe AgentFlow worker",
    description: "Persist a non-terminal status observed through the native host adapter.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema,
      status: z.enum(["starting", "running", "unknown"])
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.observeWorker(target.runId, input.workerId, input.status, target.context);
  }));

  server.registerTool("worker_collect", {
    title: "Collect AgentFlow worker result",
    description: "Validate and persist a terminal native worker result, atomically updating its owned task.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema,
      result: WorkerResultSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    await verifyWorkerChangeSet(target.state, input.workerId, input.result);
    return target.engine.collectWorkerResult(target.runId, input.workerId, input.result, target.context);
  }));

  server.registerTool("worker_interrupt", {
    title: "Interrupt AgentFlow worker",
    description: "Record a confirmed native interruption and return its task to the ready queue when safe.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.interruptWorker(target.runId, input.workerId, input.reason, target.context);
  }));

  server.registerTool("worker_fail", {
    title: "Fail AgentFlow worker",
    description: "Record a native dispatch or protocol failure without fabricating a WorkerResult.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.failWorker(target.runId, input.workerId, input.reason, target.context);
  }));

  server.registerTool("worker_close", {
    title: "Close AgentFlow worker",
    description: "Record a confirmed close for a terminal native worker thread.",
    inputSchema: {
      ...mutationShape,
      workerId: IdentifierSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.closeWorker(target.runId, input.workerId, input.reason, target.context);
  }));

  server.registerTool("resource_acquire", {
    title: "Acquire exclusive AgentFlow resource",
    description: "Acquire a time-bounded exclusive resource for a bound Worker, such as the single Figma file Writer.",
    inputSchema: {
      ...mutationShape,
      resourceId: IdentifierSchema,
      kind: IdentifierSchema,
      resourceKey: z.string().min(1).max(1_024),
      stageId: IdentifierSchema,
      taskId: IdentifierSchema,
      owner: IdentifierSchema,
      leaseSeconds: z.number().int().positive().max(86_400).default(900),
      metadata: z.record(z.string(), z.unknown()).default({})
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.owner));
    return target.engine.acquireResource(target.runId, {
      resourceId: input.resourceId,
      kind: input.kind,
      resourceKey: input.resourceKey,
      stageId: input.stageId,
      taskId: input.taskId,
      owner: input.owner,
      leaseSeconds: input.leaseSeconds,
      metadata: input.metadata
    }, target.context);
  }));

  server.registerTool("resource_heartbeat", {
    title: "Heartbeat exclusive AgentFlow resource",
    description: "Renew an active exclusive resource lease owned by a Worker.",
    inputSchema: {
      ...mutationShape,
      resourceId: IdentifierSchema,
      owner: IdentifierSchema,
      leaseSeconds: z.number().int().positive().max(86_400).default(900)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.owner));
    return target.engine.heartbeatResource(
      target.runId,
      input.resourceId,
      input.owner,
      input.leaseSeconds,
      target.context
    );
  }));

  server.registerTool("resource_rekey", {
    title: "Rekey exclusive AgentFlow resource",
    description: "Replace a provisional resource key with the confirmed external key while retaining the same lease.",
    inputSchema: {
      ...mutationShape,
      resourceId: IdentifierSchema,
      owner: IdentifierSchema,
      resourceKey: z.string().min(1).max(1_024)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.owner));
    return target.engine.rekeyResource(
      target.runId,
      input.resourceId,
      input.owner,
      input.resourceKey,
      target.context
    );
  }));

  server.registerTool("resource_status", {
    title: "Get exclusive AgentFlow resource",
    description: "Return one persisted exclusive resource and its operation history.",
    inputSchema: {
      ...runSelectorShape,
      resourceId: IdentifierSchema
    },
    annotations: readAnnotations
  }, async ({ projectRoot, runId, resourceId }) => handleTool(async () => {
    const paths = await pathsFor(projectRoot);
    await assertProjectInitialized(paths);
    const engine = await createEngine(paths);
    const state = await engine.loadRun(await resolveRunId(runId, paths));
    const resource = state.resources[resourceId];
    if (!resource) throw new AgentFlowError(`Resource not found: ${resourceId}`, "RESOURCE_NOT_FOUND", { resourceId });
    return resource;
  }));

  server.registerTool("resource_operation_begin", {
    title: "Begin exclusive resource operation",
    description: "Reserve the resource operation mutex before one external mutating tool call.",
    inputSchema: {
      ...mutationShape,
      resourceId: IdentifierSchema,
      owner: IdentifierSchema,
      operationId: IdentifierSchema,
      tool: z.string().min(1).max(200)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.owner));
    return target.engine.beginResourceOperation(
      target.runId,
      input.resourceId,
      input.owner,
      input.operationId,
      input.tool,
      target.context
    );
  }));

  server.registerTool("resource_operation_finish", {
    title: "Finish exclusive resource operation",
    description: "Record the external call result and release the per-resource operation mutex.",
    inputSchema: {
      ...mutationShape,
      resourceId: IdentifierSchema,
      owner: IdentifierSchema,
      operationId: IdentifierSchema,
      status: z.enum(["completed", "failed"]),
      resultHash: Sha256Schema.optional(),
      affectedNodeIds: z.array(z.string().min(1).max(512)).max(10_000).default([]),
      summary: z.string().max(4_000).default("")
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.owner));
    return target.engine.finishResourceOperation(target.runId, input.resourceId, input.owner, {
      operationId: input.operationId,
      status: input.status,
      ...(input.resultHash === undefined ? {} : { resultHash: input.resultHash }),
      affectedNodeIds: input.affectedNodeIds,
      summary: input.summary
    }, target.context);
  }));

  server.registerTool("resource_release", {
    title: "Release exclusive AgentFlow resource",
    description: "Release an exclusive resource after all external operations finish.",
    inputSchema: {
      ...mutationShape,
      resourceId: IdentifierSchema,
      owner: IdentifierSchema
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("worker", input.owner));
    return target.engine.releaseResource(target.runId, input.resourceId, input.owner, input.reason, target.context);
  }));

  server.registerTool("artifact_register", {
    title: "Register AgentFlow artifact",
    description: "Register or replace a content-addressed artifact for a pipeline stage.",
    inputSchema: {
      ...mutationShape,
      artifactId: IdentifierSchema,
      stageId: IdentifierSchema,
      kind: z.string().min(1),
      uri: z.string().min(1),
      sha256: Sha256Schema,
      producedBy: IdentifierSchema,
      payload: z.unknown().optional(),
      metadata: z.record(z.string(), z.unknown()).default({})
    }
  }, async (input) => handleTool(async () => {
    const { paths, target } = await targetFor(input, actor("worker", input.producedBy));
    let metadata = input.metadata;
    if (isArtifactContractKind(input.kind)) {
      if (input.payload === undefined) {
        throw new AgentFlowError(
          `Artifact payload is required for contract kind ${input.kind}`,
          "ARTIFACT_PAYLOAD_REQUIRED",
          { kind: input.kind }
        );
      }
      const parsedPayload = validateArtifactPayload(input.kind, input.payload);
      validateArtifactReferences(input.kind, parsedPayload, target.state);
      if (input.kind === "implementation-plan") {
        await verifyImplementationPlanRepository(paths.projectRoot, parsedPayload as ImplementationPlanContract);
      }
      const computedHash = artifactPayloadHash(input.kind, parsedPayload);
      if (computedHash !== input.sha256) {
        throw new AgentFlowError("Artifact payload hash does not match", "ARTIFACT_HASH_MISMATCH", {
          kind: input.kind,
          expected: computedHash,
          actual: input.sha256
        });
      }
      metadata = { ...metadata, contract: contractMetadata(input.kind, parsedPayload) };
    }
    return target.engine.registerArtifact(target.runId, {
      id: input.artifactId,
      stageId: input.stageId,
      kind: input.kind,
      uri: input.uri,
      sha256: input.sha256,
      producedBy: input.producedBy,
      metadata
    }, target.context);
  }));

  server.registerTool("artifact_validate", {
    title: "Validate AgentFlow artifact payload",
    description: "Validate a known AgentFlow JSON artifact contract and return its deterministic SHA-256.",
    inputSchema: {
      kind: ArtifactContractKindSchema,
      payload: z.unknown()
    },
    annotations: readAnnotations
  }, async ({ kind, payload }) => handleTool(async () => {
    const parsed = validateArtifactPayload(kind, payload);
    return { kind, sha256: artifactPayloadHash(kind, parsed), payload: parsed };
  }));

  server.registerTool("gate_resolve", {
    title: "Resolve AgentFlow gate",
    description: "Approve or reject a pipeline gate with an auditable actor and resolution.",
    inputSchema: {
      ...mutationShape,
      gateId: IdentifierSchema,
      decision: z.enum(["approved", "rejected"]),
      choice: z.string().min(1).optional(),
      resolution: z.string().min(1)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("user", "mcp-user"));
    return target.engine.resolveGate(target.runId, {
      gateId: input.gateId,
      decision: input.decision,
      resolution: input.resolution,
      ...(input.choice === undefined ? {} : { choice: input.choice })
    }, target.context);
  }));

  server.registerTool("stage_preflight_report", {
    title: "Report AgentFlow stage preflight",
    description: "Persist a live host capability probe and atomically block or resume the active stage.",
    inputSchema: {
      ...mutationShape,
      stageId: IdentifierSchema,
      host: IdentifierSchema,
      availableCapabilities: z.array(IdentifierSchema).max(500).default([]),
      ttlSeconds: z.number().int().min(30).max(3_600).default(900)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    return target.engine.reportStagePreflight(target.runId, {
      stageId: input.stageId,
      host: input.host,
      availableCapabilities: input.availableCapabilities,
      ttlSeconds: input.ttlSeconds
    }, target.context);
  }));

  server.registerTool("stage_complete", {
    title: "Complete AgentFlow stage",
    description: "Complete an active stage after core verifies tasks, artifacts, and gates.",
    inputSchema: {
      ...mutationShape,
      stageId: IdentifierSchema.optional()
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    const stageId = resolveStageId(input.stageId, target.state.activeStageId, target.runId);
    return target.engine.completeStage(target.runId, stageId, target.context);
  }));

  server.registerTool("stage_skip", {
    title: "Skip AgentFlow stage",
    description: "Skip an active stage when its pipeline conditions allow it.",
    inputSchema: {
      ...mutationShape,
      stageId: IdentifierSchema.optional(),
      reason: z.string().min(1)
    }
  }, async (input) => handleTool(async () => {
    const { target } = await targetFor(input, actor("supervisor", "mcp-supervisor"));
    const stageId = resolveStageId(input.stageId, target.state.activeStageId, target.runId);
    return target.engine.skipStage(target.runId, stageId, input.reason, target.context);
  }));

  return server;
}

async function handleTool(action: () => Promise<object>): Promise<CallToolResult> {
  try {
    return jsonResult(await action());
  } catch (error) {
    return errorResult(error);
  }
}

function jsonResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

function errorResult(error: unknown): CallToolResult {
  const payload = error instanceof AgentFlowError
    ? { error: error.code, message: error.message, details: error.details }
    : error instanceof z.ZodError
      ? { error: "ARTIFACT_CONTRACT_INVALID", message: "Artifact payload does not match its contract", details: { issues: error.issues } }
    : {
        error: "UNEXPECTED",
        message: "Unexpected AgentFlow MCP failure",
        traceId: randomUUID()
      };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  };
}

function actor(kind: Actor["kind"], id: string): Actor {
  return { kind, id };
}

function validateArtifactReferences(kind: ArtifactContractKind, payload: unknown, state: RunState): void {
  if (kind === "prd") {
    const prd = payload as PrdContract;
    requireArtifactReference(state, prd.sourceProductBrief, "product-brief");
    return;
  }
  if (kind === "ux-architecture") {
    const ux = payload as UxArchitectureContract;
    requireArtifactReference(state, ux.sourcePrd, "prd");
    return;
  }
  if (kind === "design-concepts") {
    const concepts = payload as DesignConceptSetContract;
    requireArtifactReference(state, concepts.sourceUxArchitecture, "ux-architecture");
    const resource = state.resources[concepts.writer.resourceId];
    if (!resource || resource.kind !== "figma-file" || resource.owner !== concepts.writer.workerId) {
      throw new AgentFlowError("Design concept Writer resource does not match", "ARTIFACT_RESOURCE_MISMATCH", {
        resourceId: concepts.writer.resourceId,
        workerId: concepts.writer.workerId
      });
    }
    if (resource.status !== "released" || resource.activeOperationId) {
      throw new AgentFlowError("Design concept Writer resource is not safely released", "ARTIFACT_RESOURCE_ACTIVE", {
        resourceId: resource.id,
        status: resource.status,
        activeOperationId: resource.activeOperationId
      });
    }
    const operations = new Map(resource.operations.map((operation) => [operation.id, operation]));
    for (const operationId of concepts.writer.operationIds) {
      if (operations.get(operationId)?.status !== "completed") {
        throw new AgentFlowError("Design concept operation is not completed", "ARTIFACT_OPERATION_INCOMPLETE", {
          resourceId: resource.id,
          operationId
        });
      }
    }
    const affectedNodeIds = new Set(
      concepts.writer.operationIds.flatMap((operationId) => operations.get(operationId)?.affectedNodeIds ?? [])
    );
    for (const concept of concepts.concepts) {
      requireArtifactReference(state, concept.screenshot, "design-screenshot");
      const brief = state.artifacts[concept.briefArtifactId];
      if (!brief || brief.stale) {
        throw new AgentFlowError("Design concept brief is missing or stale", "ARTIFACT_REFERENCE_INVALID", {
          artifactId: concept.briefArtifactId
        });
      }
      for (const nodeId of [concept.figmaPageNodeId, ...concept.representativeNodeIds]) {
        if (!affectedNodeIds.has(nodeId)) {
          throw new AgentFlowError("Design concept node is absent from the Writer ledger", "ARTIFACT_NODE_UNTRACKED", {
            conceptId: concept.id,
            nodeId
          });
        }
      }
    }
    return;
  }
  if (kind === "architecture") {
    const architecture = payload as ArchitectureContract;
    requireArtifactReference(state, architecture.sourcePrd, "prd");
    if (state.hasUi && architecture.sourceDesignManifest === undefined) {
      throw new AgentFlowError("UI architecture must reference the approved design manifest", "ARTIFACT_REFERENCE_INVALID", {
        expectedKind: "design-manifest"
      });
    }
    if (architecture.sourceDesignManifest !== undefined) {
      requireArtifactReference(state, architecture.sourceDesignManifest, "design-manifest");
    }
    return;
  }
  if (kind === "implementation-plan") {
    const plan = payload as ImplementationPlanContract;
    const architectureArtifact = requireArtifactReference(state, plan.sourceArchitecture, "architecture");
    requireArtifactReference(state, plan.sourcePrd, "prd");
    requireContractFact(architectureArtifact, "sourcePrdArtifactId", plan.sourcePrd.artifactId);
    requireContractFact(architectureArtifact, "sourcePrdSha256", plan.sourcePrd.sha256);
    requireTypedArtifactReferences(state, plan.tasks.flatMap((task) => task.inputArtifacts));
    return;
  }
  if (kind === "integration-report") {
    const report = payload as IntegrationReportContract;
    const planArtifact = requireArtifactReference(state, report.sourceImplementationPlan, "implementation-plan");
    requireContractFact(planArtifact, "repositoryBranch", report.repository.branch);
    requireContractFact(planArtifact, "repositoryBaseRevision", report.repository.baseRevision);
    validateIntegrationTaskLineage(state, report, planArtifact);
    requireTypedArtifactReferences(state, report.taskResults.flatMap((result) => result.outputArtifacts));
    requireTypedArtifactReferences(state, report.checks.flatMap((check) => check.evidenceArtifacts));
    return;
  }
  if (kind === "qa-report") {
    const report = payload as QaReportContract;
    const integrationArtifact = requireArtifactReference(state, report.sourceIntegrationReport, "integration-report");
    requireContractFact(integrationArtifact, "revision", report.environment.revision);
    if (report.verdict === "passed") requireContractFact(integrationArtifact, "verdict", "passed");
    requireTypedArtifactReferences(state, report.testCases.flatMap((testCase) => testCase.evidenceArtifacts));
    requireTypedArtifactReferences(state, report.qualityGates.flatMap((gate) => gate.evidenceArtifacts));
    requireTypedArtifactReferences(state, report.findings.flatMap((finding) => finding.evidenceArtifacts));
    return;
  }
  if (kind === "release-plan") {
    const plan = payload as ReleasePlanContract;
    const qaArtifact = requireArtifactReference(state, plan.sourceQaReport, "qa-report");
    requireContractFact(qaArtifact, "verdict", plan.qaVerdict);
    requireContractFact(qaArtifact, "revision", plan.release.revision);
    requireTypedArtifactReferences(state, plan.releaseArtifacts);
    requireTypedArtifactReferences(state, plan.preflightChecks.flatMap((check) => check.evidenceArtifacts));
    return;
  }

  if (kind === "final-manifest") {
    const manifest = payload as FinalManifestContract;
    const planArtifact = requireArtifactReference(state, manifest.lineage.implementationPlan, "implementation-plan");
    requireArtifactReference(state, manifest.lineage.architecture, "architecture");
    const integrationArtifact = requireArtifactReference(state, manifest.lineage.integrationReport, "integration-report");
    const qaArtifact = requireArtifactReference(state, manifest.lineage.qaReport, "qa-report");
    const releaseArtifact = requireArtifactReference(state, manifest.lineage.releasePlan, "release-plan");
    requireContractFact(planArtifact, "sourceArchitectureArtifactId", manifest.lineage.architecture.artifactId);
    requireContractFact(planArtifact, "sourceArchitectureSha256", manifest.lineage.architecture.sha256);
    requireContractFact(integrationArtifact, "sourceImplementationPlanArtifactId", manifest.lineage.implementationPlan.artifactId);
    requireContractFact(integrationArtifact, "sourceImplementationPlanSha256", manifest.lineage.implementationPlan.sha256);
    requireContractFact(qaArtifact, "sourceIntegrationReportArtifactId", manifest.lineage.integrationReport.artifactId);
    requireContractFact(qaArtifact, "sourceIntegrationReportSha256", manifest.lineage.integrationReport.sha256);
    requireContractFact(releaseArtifact, "sourceQaReportArtifactId", manifest.lineage.qaReport.artifactId);
    requireContractFact(releaseArtifact, "sourceQaReportSha256", manifest.lineage.qaReport.sha256);
    requireContractFact(integrationArtifact, "verdict", "passed");
    requireContractFact(qaArtifact, "verdict", "passed");
    requireContractFact(releaseArtifact, "readiness", "ready");
    requireContractFact(releaseArtifact, "releaseId", manifest.release.id);
    requireContractFact(releaseArtifact, "releaseVersion", manifest.release.version);
    requireContractFact(releaseArtifact, "targetEnvironment", manifest.release.targetEnvironment);
    requireContractFact(releaseArtifact, "revision", manifest.release.revision);
    requireTypedArtifactReferences(state, manifest.deployedArtifacts);
    requireTypedArtifactReferences(state, manifest.releaseEvidence);
    requireTypedArtifactReferences(state, manifest.healthChecks.flatMap((check) => check.evidenceArtifacts));
    requireTypedArtifactReferences(state, manifest.incidents.flatMap((incident) => incident.evidenceArtifacts));
    if (manifest.rollback !== undefined) requireTypedArtifactReferences(state, manifest.rollback.evidenceArtifacts);
  }
}

function requireTypedArtifactReferences(
  state: RunState,
  references: readonly { artifactId: string; sha256: string; kind: string }[]
): void {
  for (const reference of references) requireArtifactReference(state, reference, reference.kind);
}

function requireArtifactReference(
  state: RunState,
  reference: { artifactId: string; sha256: string },
  expectedKind: string
): Artifact {
  const artifact = state.artifacts[reference.artifactId];
  if (!artifact || artifact.stale || artifact.kind !== expectedKind || artifact.sha256 !== reference.sha256) {
    throw new AgentFlowError("Artifact reference is missing, stale, or has a different hash", "ARTIFACT_REFERENCE_INVALID", {
      artifactId: reference.artifactId,
      expectedKind,
      expectedHash: reference.sha256,
      actualKind: artifact?.kind,
      actualHash: artifact?.sha256,
      stale: artifact?.stale
    });
  }
  return artifact;
}

function requireContractFact(artifact: Artifact, fact: string, expected: string): void {
  const contract = artifact.metadata["contract"];
  const actual = typeof contract === "object" && contract !== null
    ? (contract as Record<string, unknown>)[fact]
    : undefined;
  if (actual !== expected) {
    throw new AgentFlowError("Artifact contract fact does not match its downstream claim", "ARTIFACT_REFERENCE_INVALID", {
      artifactId: artifact.id,
      fact,
      expected,
      actual
    });
  }
}

function validateIntegrationTaskLineage(
  state: RunState,
  report: IntegrationReportContract,
  planArtifact: Artifact
): void {
  const tasks = Object.values(state.tasks).filter((task) => (
    task.materializedFrom?.artifactId === planArtifact.id
    && task.materializedFrom.sha256 === planArtifact.sha256
  ));
  const runtimeTaskIds = tasks.map((task) => task.id).sort();
  const reportedTaskIds = [...report.planTaskIds].sort();
  if (JSON.stringify(runtimeTaskIds) !== JSON.stringify(reportedTaskIds)) {
    throw new AgentFlowError("Integration report does not cover the materialized plan generation", "ARTIFACT_TASK_LINEAGE_INVALID", {
      planArtifactId: planArtifact.id,
      runtimeTaskIds,
      reportedTaskIds
    });
  }
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const taskResult of report.taskResults) {
    if (taskResult.status !== "integrated") continue;
    const task = tasksById.get(taskResult.taskId);
    const parsedChangeSet = WorkerChangeSetSchema.safeParse(task?.result?.["changeSet"]);
    if (
      task?.status !== "completed"
      || !parsedChangeSet.success
      || parsedChangeSet.data.baseRevision !== report.repository.baseRevision
      || JSON.stringify(parsedChangeSet.data.revisions) !== JSON.stringify(taskResult.revisions)
    ) {
      throw new AgentFlowError("Integration Task revision does not match its collected Worker change set", "ARTIFACT_TASK_LINEAGE_INVALID", {
        taskId: taskResult.taskId,
        taskStatus: task?.status,
        expectedBaseRevision: parsedChangeSet.success ? parsedChangeSet.data.baseRevision : undefined,
        reportBaseRevision: report.repository.baseRevision,
        expectedRevisions: parsedChangeSet.success ? parsedChangeSet.data.revisions : [],
        reportedRevisions: taskResult.revisions
      });
    }
  }
}

function contractMetadata(kind: ArtifactContractKind, payload: unknown): Record<string, unknown> {
  const base = { kind, version: 1 };
  if (kind === "architecture") {
    const architecture = payload as ArchitectureContract;
    return {
      ...base,
      sourcePrdArtifactId: architecture.sourcePrd.artifactId,
      sourcePrdSha256: architecture.sourcePrd.sha256,
      ...(architecture.sourceDesignManifest === undefined
        ? {}
        : {
            sourceDesignManifestArtifactId: architecture.sourceDesignManifest.artifactId,
            sourceDesignManifestSha256: architecture.sourceDesignManifest.sha256
          })
    };
  }
  if (kind === "implementation-plan") {
    const plan = payload as ImplementationPlanContract;
    return {
      ...base,
      sourceArchitectureArtifactId: plan.sourceArchitecture.artifactId,
      sourceArchitectureSha256: plan.sourceArchitecture.sha256,
      sourcePrdArtifactId: plan.sourcePrd.artifactId,
      sourcePrdSha256: plan.sourcePrd.sha256,
      repositoryBranch: plan.repository.branch,
      repositoryBaseRevision: plan.repository.baseRevision
    };
  }
  if (kind === "integration-report") {
    const report = payload as IntegrationReportContract;
    return {
      ...base,
      sourceImplementationPlanArtifactId: report.sourceImplementationPlan.artifactId,
      sourceImplementationPlanSha256: report.sourceImplementationPlan.sha256,
      verdict: report.verdict,
      revision: report.repository.integratedRevision
    };
  }
  if (kind === "qa-report") {
    const report = payload as QaReportContract;
    return {
      ...base,
      sourceIntegrationReportArtifactId: report.sourceIntegrationReport.artifactId,
      sourceIntegrationReportSha256: report.sourceIntegrationReport.sha256,
      verdict: report.verdict,
      revision: report.environment.revision
    };
  }
  if (kind === "release-plan") {
    const plan = payload as ReleasePlanContract;
    return {
      ...base,
      sourceQaReportArtifactId: plan.sourceQaReport.artifactId,
      sourceQaReportSha256: plan.sourceQaReport.sha256,
      readiness: plan.readiness,
      qaVerdict: plan.qaVerdict,
      releaseId: plan.release.id,
      releaseVersion: plan.release.version,
      targetEnvironment: plan.release.targetEnvironment,
      revision: plan.release.revision
    };
  }
  if (kind === "final-manifest") {
    const manifest = payload as FinalManifestContract;
    return { ...base, outcome: manifest.release.outcome, revision: manifest.release.revision };
  }
  return base;
}

async function verifyWorkerChangeSet(state: RunState, workerId: string, result: WorkerResult): Promise<void> {
  const changeSet = result.changeSet;
  if (changeSet === null) return;
  const worker = state.workers[workerId];
  const task = worker === undefined ? undefined : state.tasks[worker.taskId];
  const workspace = task?.workspace;
  if (!worker || !task || !workspace) {
    throw new AgentFlowError("Worker change set has no bound Task workspace", "WORKER_CHANGESET_WORKSPACE_MISSING", {
      workerId,
      taskId: worker?.taskId
    });
  }

  try {
    const options = { encoding: "utf8" as const, windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
    const [headResult, branchResult, revisionsResult, pathsResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", workspace.path, "rev-parse", "HEAD"], options),
      execFileAsync("git", ["-C", workspace.path, "branch", "--show-current"], options),
      execFileAsync("git", ["-C", workspace.path, "rev-list", "--reverse", `${changeSet.baseRevision}..${changeSet.headRevision}`], options),
      execFileAsync("git", ["-C", workspace.path, "diff", "--no-renames", "--name-only", "-z", changeSet.baseRevision, changeSet.headRevision], options),
      execFileAsync("git", ["-C", workspace.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], options)
    ]);
    await execFileAsync(
      "git",
      ["-C", workspace.path, "merge-base", "--is-ancestor", changeSet.baseRevision, changeSet.headRevision],
      options
    );
    const actualHead = String(headResult.stdout).trim();
    const actualBranch = String(branchResult.stdout).trim();
    const actualRevisions = String(revisionsResult.stdout).split(/\r?\n/).filter(Boolean);
    const actualPaths = String(pathsResult.stdout).split("\0").filter(Boolean).sort();
    const dirtyEntries = String(statusResult.stdout).split("\0").filter(Boolean);
    const expectedPaths = [...changeSet.changedPaths].sort();
    if (
      actualHead !== changeSet.headRevision
      || (workspace.branch !== undefined && actualBranch !== workspace.branch)
      || JSON.stringify(actualRevisions) !== JSON.stringify(changeSet.revisions)
      || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
      || dirtyEntries.length > 0
    ) {
      throw new AgentFlowError("Worker Git change set does not match the bound workspace", "WORKER_CHANGESET_GIT_MISMATCH", {
        workerId,
        taskId: task.id,
        expectedBranch: workspace.branch,
        actualBranch,
        expectedHead: changeSet.headRevision,
        actualHead,
        expectedRevisions: changeSet.revisions,
        actualRevisions,
        expectedPaths,
        actualPaths,
        dirtyEntries
      });
    }
  } catch (error) {
    if (error instanceof AgentFlowError) throw error;
    throw new AgentFlowError("Unable to verify the Worker Git change set", "WORKER_CHANGESET_GIT_INVALID", {
      workerId,
      taskId: task.id,
      workspace: workspace.path,
      message: error instanceof Error ? error.message : "git verification failed"
    });
  }
}

async function verifyImplementationPlanRepository(
  projectRoot: string,
  plan: ImplementationPlanContract
): Promise<void> {
  try {
    const options = { encoding: "utf8" as const, windowsHide: true };
    const [head, branch] = await Promise.all([
      execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], options),
      execFileAsync("git", ["-C", projectRoot, "branch", "--show-current"], options)
    ]);
    const actualHead = String(head.stdout).trim();
    const actualBranch = String(branch.stdout).trim();
    if (actualHead !== plan.repository.baseRevision || actualBranch !== plan.repository.branch) {
      throw new AgentFlowError("Implementation plan repository baseline does not match the project checkout", "PLAN_REPOSITORY_BASE_MISMATCH", {
        expectedBaseRevision: plan.repository.baseRevision,
        actualBaseRevision: actualHead,
        expectedBranch: plan.repository.branch,
        actualBranch
      });
    }
  } catch (error) {
    if (error instanceof AgentFlowError) throw error;
    throw new AgentFlowError("Unable to verify the implementation plan repository baseline", "PLAN_REPOSITORY_GIT_INVALID", {
      projectRoot,
      message: error instanceof Error ? error.message : "git verification failed"
    });
  }
}

async function verifyPlannedRepositoryBase(
  state: RunState,
  taskId: string,
  workspace: DispatchWorkspace
): Promise<void> {
  const planned = state.tasks[taskId]?.planRepository;
  if (!planned) return;
  if (workspace.kind === "worktree") {
    if (workspace.baseRevision !== planned.baseRevision || workspace.branch === planned.branch) {
      throw new AgentFlowError("Worktree does not match the approved repository baseline", "TASK_WORKSPACE_BASE_MISMATCH", {
        taskId,
        expectedBaseRevision: planned.baseRevision,
        actualBaseRevision: workspace.baseRevision,
        integrationBranch: planned.branch,
        worktreeBranch: workspace.branch
      });
    }
    return;
  }
  try {
    const options = { encoding: "utf8" as const, windowsHide: true };
    const [head, branch] = await Promise.all([
      execFileAsync("git", ["-C", workspace.path, "rev-parse", "HEAD"], options),
      execFileAsync("git", ["-C", workspace.path, "branch", "--show-current"], options)
    ]);
    const actualHead = String(head.stdout).trim();
    const actualBranch = String(branch.stdout).trim();
    if (actualHead !== planned.baseRevision || actualBranch !== planned.branch) {
      throw new AgentFlowError("Project workspace does not match the approved repository baseline", "TASK_WORKSPACE_BASE_MISMATCH", {
        taskId,
        expectedBaseRevision: planned.baseRevision,
        actualBaseRevision: actualHead,
        expectedBranch: planned.branch,
        actualBranch
      });
    }
  } catch (error) {
    if (error instanceof AgentFlowError) throw error;
    throw new AgentFlowError("Unable to verify the approved repository baseline", "TASK_WORKSPACE_GIT_INVALID", {
      taskId,
      workspace: workspace.path,
      message: error instanceof Error ? error.message : "git verification failed"
    });
  }
}

async function verifyDispatchWorkspace(projectRoot: string, workspace: DispatchWorkspace): Promise<void> {
  const expectedPath = normalizeHostPath(resolvePath(workspace.path));
  const rootPath = normalizeHostPath(resolvePath(projectRoot));
  if (workspace.kind === "project") {
    if (expectedPath !== rootPath) {
      throw new AgentFlowError("Project workspace must be the configured project root", "TASK_WORKSPACE_INVALID", {
        expected: projectRoot,
        actual: workspace.path
      });
    }
    return;
  }
  if (expectedPath === rootPath) {
    throw new AgentFlowError("An isolated worktree cannot be the main project workspace", "TASK_WORKSPACE_INVALID", {
      path: workspace.path
    });
  }

  let output: string;
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true
    });
    output = String(result.stdout);
  } catch (error) {
    throw new AgentFlowError("Unable to verify the Git worktree registry", "TASK_WORKSPACE_GIT_INVALID", {
      projectRoot,
      message: error instanceof Error ? error.message : "git worktree list failed"
    });
  }

  const records = output.trim().split(/\r?\n\r?\n/).map((block) => Object.fromEntries(
    block.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(" ");
      return separator === -1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    })
  ));
  const record = records.find((candidate) => (
    typeof candidate["worktree"] === "string"
    && normalizeHostPath(resolvePath(candidate["worktree"])) === expectedPath
  ));
  const expectedBranch = workspace.branch;
  const actualBranch = typeof record?.["branch"] === "string"
    ? record["branch"].replace(/^refs\/heads\//, "")
    : undefined;
  if (!record || record["HEAD"] !== workspace.baseRevision || actualBranch !== expectedBranch) {
    throw new AgentFlowError("Workspace is not the recorded Git worktree generation", "TASK_WORKSPACE_GIT_MISMATCH", {
      path: workspace.path,
      expectedBranch,
      actualBranch,
      expectedBaseRevision: workspace.baseRevision,
      actualHead: record?.["HEAD"]
    });
  }
}

function normalizeHostPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveStageId(
  requestedStageId: string | undefined,
  activeStageId: string | undefined,
  runId: string
): string {
  const stageId = requestedStageId ?? activeStageId;
  if (!stageId) {
    throw new AgentFlowError("Run has no active stage", "RUN_NO_ACTIVE_STAGE", { runId });
  }
  return stageId;
}
