import { z } from "zod";
import {
  ThreadCapabilitiesSchema,
  WorkerResultSchema,
  WorkerStatusSchema
} from "@agentflow/core";

export {
  ThreadCapabilitiesSchema,
  WorkerResultSchema,
  WorkerStatusSchema
} from "@agentflow/core";
export type {
  ThreadCapabilities,
  WorkerResult,
  WorkerStatus
} from "@agentflow/core";

const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const IsoDateSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const DispatchWorkspaceSchema = z.object({
  kind: z.enum(["project", "worktree"]),
  path: z.string().min(1).max(4_096),
  branch: z.string().min(1).max(512).optional(),
  baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/).optional()
}).strict().superRefine((value, context) => {
  if (value.kind === "worktree" && (value.branch === undefined || value.baseRevision === undefined)) {
    context.addIssue({ code: "custom", message: "A worktree dispatch requires branch and baseRevision" });
  }
  if (value.kind === "project" && (value.branch !== undefined || value.baseRevision !== undefined)) {
    context.addIssue({ code: "custom", message: "A project dispatch cannot include worktree metadata" });
  }
});

export const WorkerMessageSchema = z.object({
  kind: z.enum(["instruction", "correction", "context", "cancel"]),
  body: z.string().min(1).max(32_000),
  correlationId: IdSchema.optional(),
  data: z.record(z.string(), z.unknown()).default({})
});

export const WorkerInputArtifactSchema = z.object({
  id: IdSchema,
  kind: IdSchema,
  sha256: Sha256Schema,
  uri: z.string().min(1).max(4_096)
}).strict();

export const WorkerPromptSchema = z.object({
  objective: z.string().min(1).max(32_000),
  context: z.array(z.string().max(8_000)).max(50).default([]),
  inputArtifacts: z.array(WorkerInputArtifactSchema).max(200).default([]),
  inputArtifactHashes: z.record(IdSchema, Sha256Schema).default({}),
  inputArtifactKinds: z.record(IdSchema, IdSchema).default({}),
  waveId: IdSchema.optional(),
  componentIds: z.array(IdSchema).max(200).default([]),
  requirementIds: z.array(IdSchema).max(500).default([]),
  allowedPaths: z.array(z.string().min(1)).max(200).default([]),
  forbiddenPaths: z.array(z.string().min(1)).max(200).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(8_000)).max(200).default([]),
  verificationCommands: z.array(z.string().min(1).max(4_000)).max(50).default([]),
  expectedOutputs: z.array(z.string().min(1).max(8_000)).max(200).default([]),
  requiresWorktree: z.boolean().default(false),
  workspace: DispatchWorkspaceSchema,
  risk: z.enum(["low", "medium", "high"]).optional(),
  resultSchema: z.string().min(1).max(32_000)
});

export const SpawnWorkerInputSchema = z.object({
  runId: IdSchema,
  taskId: IdSchema,
  workerId: IdSchema,
  taskName: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
  profile: IdSchema,
  prompt: WorkerPromptSchema
});

export const WorkerHandleSchema = z.object({
  adapter: IdSchema,
  workerId: IdSchema,
  taskId: IdSchema,
  externalThreadId: z.string().min(1).max(512),
  status: WorkerStatusSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export type SpawnWorkerInput = z.infer<typeof SpawnWorkerInputSchema>;
export type DispatchWorkspace = z.infer<typeof DispatchWorkspaceSchema>;
export type WorkerHandle = z.infer<typeof WorkerHandleSchema>;
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
