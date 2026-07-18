import { z } from "zod";

const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const IsoDateSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const RepositoryPathSchema = z.string().min(1).max(4_096).superRefine((value, context) => {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized !== value
    || normalized.startsWith("/")
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    context.addIssue({ code: "custom", message: "Repository paths must be normalized, relative, and traversal-free" });
  }
});

export const StageStatusSchema = z.enum([
  "pending",
  "ready",
  "active",
  "completed",
  "blocked",
  "stale",
  "skipped"
]);

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled"
]);

export const RunStatusSchema = z.enum(["active", "blocked", "completed", "cancelled"]);
export const ExecutionStatusSchema = z.enum(["running", "terminal"]);
export const BusinessOutcomeSchema = z.enum(["succeeded", "failed", "blocked", "cancelled", "superseded"]);
export const GateStatusSchema = z.enum(["pending", "approved", "rejected", "stale"]);
export const GateTypeSchema = z.enum(["human", "automatic"]);
export const ActorKindSchema = z.enum(["user", "supervisor", "worker", "system"]);
export const WorkerStatusSchema = z.enum([
  "prepared",
  "starting",
  "running",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "closed",
  "unknown"
]);

export const ThreadCapabilitiesSchema = z.object({
  spawn: z.boolean(),
  send: z.boolean(),
  status: z.boolean(),
  collect: z.boolean(),
  interrupt: z.boolean(),
  close: z.boolean()
});

export const WorkerContextPolicySchema = z.object({
  mode: z.enum(["unknown", "fresh-required", "fresh-attested"]).default("unknown"),
  inheritedTurnCount: z.number().int().nonnegative().optional(),
  promptBytes: z.number().int().nonnegative().optional(),
  agentflowMcpEnabled: z.boolean().optional()
}).strict();

export const CleanupStepSchema = z.object({
  status: z.enum(["pending", "completed", "unsupported", "failed"]),
  at: IsoDateSchema.optional(),
  reason: z.string().min(1).max(2_000).optional()
}).strict();

export const WorkerCleanupSchema = z.object({
  resultCollectedAt: IsoDateSchema.optional(),
  close: CleanupStepSchema,
  archive: CleanupStepSchema,
  permitRelease: CleanupStepSchema,
  completedAt: IsoDateSchema.optional()
}).strict();

export const ResourceStatusSchema = z.enum(["active", "released"]);
export const ResourceOperationStatusSchema = z.enum(["running", "completed", "failed"]);
export const StagePreflightStatusSchema = z.enum(["passed", "blocked"]);

export const RequiredGateSchema = z.object({
  id: IdSchema,
  type: GateTypeSchema,
  question: z.string().min(1),
  options: z.array(z.string().min(1)).default([])
});

export const StageSpecSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  dependsOn: z.array(IdSchema).default([]),
  skills: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  requiredCapabilities: z.array(IdSchema).default([]),
  requiredArtifactKinds: z.array(z.string().min(1)).default([]),
  requiredGate: RequiredGateSchema.optional(),
  skippableWhen: z.array(z.string().min(1)).default([])
});

export const PipelineDefinitionSchema = z.object({
  id: IdSchema,
  version: z.string().min(1),
  name: z.string().min(1),
  stages: z.array(StageSpecSchema).min(1)
});

export const LeaseSchema = z.object({
  owner: IdSchema,
  acquiredAt: IsoDateSchema,
  heartbeatAt: IsoDateSchema,
  expiresAt: IsoDateSchema
});

export const VerificationRecordSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().default(""),
  recordedAt: IsoDateSchema
});

export const WorkerArtifactResultSchema = z.object({
  id: IdSchema,
  kind: z.string().min(1),
  uri: z.string().min(1),
  sha256: Sha256Schema
});

export const WorkerChangeSetSchema = z.object({
  kind: z.literal("git-commits"),
  baseRevision: GitRevisionSchema,
  headRevision: GitRevisionSchema,
  revisions: z.array(GitRevisionSchema).min(1).max(500),
  changedPaths: z.array(RepositoryPathSchema).min(1).max(10_000)
}).strict().superRefine((value, context) => {
  if (value.baseRevision === value.headRevision) {
    context.addIssue({ code: "custom", message: "A Git change set must advance beyond its base revision" });
  }
  if (new Set(value.revisions).size !== value.revisions.length) {
    context.addIssue({ code: "custom", message: "Git change set revisions must be unique" });
  }
  if (value.revisions.at(-1) !== value.headRevision) {
    context.addIssue({ code: "custom", message: "The final Git change set revision must equal headRevision" });
  }
  if (new Set(value.changedPaths).size !== value.changedPaths.length) {
    context.addIssue({ code: "custom", message: "Git change set paths must be unique" });
  }
});

export const WorkerResultSchema = z.object({
  workerId: IdSchema,
  taskId: IdSchema,
  status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string().min(1).max(32_000),
  artifacts: z.array(WorkerArtifactResultSchema).default([]),
  changeSet: WorkerChangeSetSchema.nullable().default(null),
  verification: z.array(VerificationRecordSchema).default([]),
  risks: z.array(z.string().max(4_000)).default([]),
  followUps: z.array(z.string().max(4_000)).default([]),
  completedAt: IsoDateSchema
});

export const WorkerSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  adapter: IdSchema,
  adapterVersion: z.string().min(1).max(64).default("1"),
  hostTaskName: z.string().min(1).max(200),
  promptHash: Sha256Schema,
  externalThreadId: z.string().min(1).max(512).optional(),
  status: WorkerStatusSchema,
  capabilities: ThreadCapabilitiesSchema,
  contextPolicy: WorkerContextPolicySchema.default({ mode: "unknown" }),
  result: WorkerResultSchema.optional(),
  cleanup: WorkerCleanupSchema.optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export const ResourceOperationSchema = z.object({
  id: IdSchema,
  tool: z.string().min(1).max(200),
  status: ResourceOperationStatusSchema,
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
  resultHash: Sha256Schema.optional(),
  affectedNodeIds: z.array(z.string().min(1).max(512)).max(10_000).default([]),
  summary: z.string().max(4_000).default("")
});

export const ExclusiveResourceSchema = z.object({
  id: IdSchema,
  kind: IdSchema,
  resourceKey: z.string().min(1).max(1_024),
  stageId: IdSchema,
  taskId: IdSchema,
  owner: IdSchema,
  status: ResourceStatusSchema,
  lease: LeaseSchema,
  activeOperationId: IdSchema.optional(),
  operations: z.array(ResourceOperationSchema).max(500).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export const TaskWorkspaceSchema = z.object({
  kind: z.enum(["project", "worktree"]),
  path: z.string().min(1).max(4_096),
  branch: z.string().min(1).max(512).optional(),
  baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  boundAt: IsoDateSchema
}).strict().superRefine((value, context) => {
  if (value.kind === "worktree" && (value.branch === undefined || value.baseRevision === undefined)) {
    context.addIssue({ code: "custom", message: "A worktree workspace requires branch and baseRevision" });
  }
  if (value.kind === "project" && (value.branch !== undefined || value.baseRevision !== undefined)) {
    context.addIssue({ code: "custom", message: "A project workspace cannot declare worktree branch metadata" });
  }
});

export const TaskSchema = z.object({
  id: IdSchema,
  stageId: IdSchema,
  title: z.string().min(1),
  description: z.string().default(""),
  profile: IdSchema.optional(),
  status: TaskStatusSchema,
  dependsOn: z.array(IdSchema).default([]),
  waveId: IdSchema.optional(),
  waveIndex: z.number().int().nonnegative().optional(),
  componentIds: z.array(IdSchema).default([]),
  requirementIds: z.array(IdSchema).default([]),
  writeScopes: z.array(z.string().min(1)).default([]),
  forbiddenScopes: z.array(z.string().min(1)).default([]),
  inputArtifactHashes: z.record(IdSchema, Sha256Schema).default({}),
  inputArtifactKinds: z.record(IdSchema, IdSchema).default({}),
  inputArtifactUris: z.record(IdSchema, z.string().min(1)).default({}),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  verificationCommands: z.array(z.string().min(1)).default([]),
  expectedOutputs: z.array(z.string().min(1)).default([]),
  requiresWorktree: z.boolean().default(false),
  risk: z.enum(["low", "medium", "high"]).optional(),
  materializedFrom: z.object({
    artifactId: IdSchema,
    kind: IdSchema,
    sha256: Sha256Schema
  }).strict().optional(),
  planRepository: z.object({
    branch: z.string().min(1),
    baseRevision: GitRevisionSchema
  }).strict().optional(),
  workspace: TaskWorkspaceSchema.optional(),
  owner: IdSchema.optional(),
  ownerKind: z.enum(["supervisor", "worker"]).optional(),
  lease: LeaseSchema.optional(),
  verification: z.array(VerificationRecordSchema).default([]),
  result: z.record(z.string(), z.unknown()).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export const ArtifactSchema = z.object({
  id: IdSchema,
  stageId: IdSchema,
  kind: z.string().min(1),
  uri: z.string().min(1),
  sha256: Sha256Schema,
  producedBy: IdSchema,
  stale: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export const GateSchema = z.object({
  id: IdSchema,
  stageId: IdSchema,
  type: GateTypeSchema,
  question: z.string().min(1),
  options: z.array(z.string().min(1)).default([]),
  status: GateStatusSchema,
  artifactHashes: z.record(IdSchema, Sha256Schema).default({}),
  selectedOption: z.string().min(1).optional(),
  resolution: z.string().optional(),
  resolvedBy: IdSchema.optional(),
  resolvedByKind: ActorKindSchema.optional(),
  resolvedAt: IsoDateSchema.optional()
});

export const StageRunSchema = z.object({
  id: IdSchema,
  status: StageStatusSchema,
  startedAt: IsoDateSchema.optional(),
  completedAt: IsoDateSchema.optional(),
  staleReason: z.string().optional()
});

export const StagePreflightSchema = z.object({
  stageId: IdSchema,
  host: IdSchema,
  status: StagePreflightStatusSchema,
  requiredCapabilities: z.array(IdSchema),
  availableCapabilities: z.array(IdSchema),
  missingCapabilities: z.array(IdSchema),
  checkedBy: IdSchema,
  checkedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  reason: z.string().min(1).max(2_000)
});

export const RunEventSchema = z.object({
  id: IdSchema,
  type: z.string().min(1),
  actorId: IdSchema,
  actorKind: ActorKindSchema,
  at: IsoDateSchema,
  data: z.record(z.string(), z.unknown()).default({})
});

export const IdempotencyRecordSchema = z.object({
  operation: z.string().min(1),
  actorId: IdSchema,
  inputHash: Sha256Schema.optional(),
  reason: z.string().min(1).optional(),
  recordedAt: IsoDateSchema
});

export const RunStateSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  id: IdSchema,
  pipelineId: IdSchema,
  pipelineVersion: z.string().min(1),
  requirement: z.string().min(1),
  projectType: z.enum(["new", "existing"]),
  hasUi: z.boolean(),
  status: RunStatusSchema,
  executionStatus: ExecutionStatusSchema.default("running"),
  businessOutcome: BusinessOutcomeSchema.optional(),
  revision: z.number().int().nonnegative(),
  activeStageId: IdSchema.optional(),
  stages: z.record(IdSchema, StageRunSchema),
  preflights: z.record(IdSchema, StagePreflightSchema).default({}),
  tasks: z.record(IdSchema, TaskSchema).default({}),
  workers: z.record(IdSchema, WorkerSchema).default({}),
  resources: z.record(IdSchema, ExclusiveResourceSchema).default({}),
  artifacts: z.record(IdSchema, ArtifactSchema).default({}),
  gates: z.record(IdSchema, GateSchema).default({}),
  events: z.array(RunEventSchema).default([]),
  idempotency: z.record(z.string(), IdempotencyRecordSchema).default({}),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export type ActorKind = z.infer<typeof ActorKindSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>;
export type CleanupStep = z.infer<typeof CleanupStepSchema>;
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type GateType = z.infer<typeof GateTypeSchema>;
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
export type ExclusiveResource = z.infer<typeof ExclusiveResourceSchema>;
export type ResourceOperation = z.infer<typeof ResourceOperationSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type StageSpec = z.infer<typeof StageSpecSchema>;
export type StagePreflight = z.infer<typeof StagePreflightSchema>;
export type StagePreflightStatus = z.infer<typeof StagePreflightStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskWorkspace = z.infer<typeof TaskWorkspaceSchema>;
export type ThreadCapabilities = z.infer<typeof ThreadCapabilitiesSchema>;
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
export type Worker = z.infer<typeof WorkerSchema>;
export type WorkerCleanup = z.infer<typeof WorkerCleanupSchema>;
export type WorkerContextPolicy = z.infer<typeof WorkerContextPolicySchema>;
export type WorkerChangeSet = z.infer<typeof WorkerChangeSetSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export interface Actor {
  id: string;
  kind: ActorKind;
}

export interface MutationContext {
  expectedRevision: number;
  idempotencyKey: string;
  inputHash?: string;
  actor: Actor;
  reason?: string;
}
