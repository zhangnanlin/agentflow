import { canonicalJson, sha256, type ThreadCapabilities } from "@agentflow/core";
import { z } from "zod";
import { ThreadAdapterError } from "./adapter.js";
import {
  SpawnWorkerInputSchema,
  WorkerMessageSchema,
  WorkerResultSchema,
  WorkerStatusSchema,
  type SpawnWorkerInput,
  type WorkerMessage,
  type WorkerResult,
  type WorkerStatus
} from "./model.js";
import {
  HostBudgetCoordinator
} from "./scheduler.js";
import { renderWorkerPrompt } from "./codex.js";

const MAX_ENVELOPE_BYTES = 16_384;
const MAX_CAPSULE_BYTES = 16_384;
const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const IsoDateSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NativeHostIdSchema = z.enum(["codex", "cursor", "vscode"]);
const OperationSupportSchema = z.enum(["supported", "unsupported", "temporarily-unavailable"]);
const CleanupStatusSchema = z.enum(["pending", "completed", "unsupported", "failed"]);
const NativeSpawnResultSchema = z.object({
  nativeId: z.string().min(1).max(512),
  inheritedTurnCount: z.number().int().nonnegative().optional()
}).strict();
export const NativeWorkerCapsuleSchema = WorkerResultSchema.strict();

export const NativeContextPolicySchema = z.object({
  mode: z.enum(["unknown", "fresh-attested"]),
  inheritedTurnCountObservable: z.boolean(),
  inheritedTurnCount: z.number().int().nonnegative().optional()
}).strict();

export const NativeToolProfileSchema = z.object({
  mode: z.enum(["unknown", "allowlist"]),
  enforced: z.boolean(),
  tools: z.array(IdSchema).max(128),
  agentflowMcpEnabled: z.boolean()
}).strict();

const NativeOperationsSchema = z.object({
  spawnFresh: OperationSupportSchema,
  bind: OperationSupportSchema,
  send: OperationSupportSchema,
  status: OperationSupportSchema,
  waitAny: OperationSupportSchema,
  collect: OperationSupportSchema,
  interrupt: OperationSupportSchema,
  close: OperationSupportSchema,
  archive: OperationSupportSchema
}).strict();

export const NativeHostProbeSchema = z.object({
  adapterVersion: z.string().min(1).max(64),
  contextPolicy: NativeContextPolicySchema.omit({ inheritedTurnCount: true }),
  toolProfile: NativeToolProfileSchema,
  operationStatus: NativeOperationsSchema.partial().optional()
}).strict();

export const NativeCapabilitySnapshotSchema = z.object({
  version: z.literal(2),
  sourceVersion: z.union([z.literal(1), z.literal(2)]),
  host: NativeHostIdSchema,
  adapterVersion: z.string().min(1).max(64),
  conformance: z.enum(["conforming", "non-conforming"]),
  fallback: z.enum(["none", "inline", "serial"]),
  contextPolicy: NativeContextPolicySchema.omit({ inheritedTurnCount: true }),
  toolProfile: NativeToolProfileSchema,
  operations: NativeOperationsSchema,
  reasons: z.array(z.string().min(1).max(500)).max(20)
}).strict();

const CleanupStepSchema = z.object({
  status: CleanupStatusSchema,
  at: IsoDateSchema.optional(),
  reason: z.string().min(1).max(2_000).optional()
}).strict();

const NativeHandleCleanupSchema = z.object({
  close: CleanupStepSchema,
  archive: CleanupStepSchema,
  permitRelease: CleanupStepSchema,
  completedAt: IsoDateSchema.optional()
}).strict();

export const NativeWorkerHandleSchema = z.object({
  version: z.literal(2),
  host: NativeHostIdSchema,
  adapterVersion: z.string().min(1).max(64),
  workerId: IdSchema,
  taskId: IdSchema,
  nativeId: z.string().min(1).max(512),
  taskName: z.string().min(1).max(100),
  status: WorkerStatusSchema,
  promptHash: Sha256Schema,
  promptBytes: z.number().int().min(1).max(MAX_ENVELOPE_BYTES),
  contextPolicy: NativeContextPolicySchema,
  toolProfile: NativeToolProfileSchema,
  capabilities: NativeOperationsSchema,
  permitId: z.string().uuid(),
  permitOwnerId: z.string().min(1).max(4_096),
  capsuleHash: Sha256Schema.optional(),
  resultCollectedAt: IsoDateSchema.optional(),
  durableTerminal: z.enum(["result", "interruption", "failure"]).optional(),
  terminalObservedAt: IsoDateSchema.optional(),
  durableAt: IsoDateSchema.optional(),
  cleanup: NativeHandleCleanupSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).strict();

export const NativeCleanupReceiptSchema = z.object({
  version: z.literal(1),
  host: NativeHostIdSchema,
  adapterVersion: z.string().min(1).max(64),
  workerId: IdSchema,
  nativeId: z.string().min(1).max(512),
  resultCollectedAt: IsoDateSchema.optional(),
  durableAt: IsoDateSchema,
  close: CleanupStepSchema,
  archive: CleanupStepSchema,
  permitRelease: CleanupStepSchema,
  completedAt: IsoDateSchema.optional(),
  completed: z.boolean()
}).strict();

export interface NativeHostProbe extends z.infer<typeof NativeHostProbeSchema> {}
export interface NativeWorkerHandle extends z.infer<typeof NativeWorkerHandleSchema> {}
export interface NativeCleanupReceipt extends z.infer<typeof NativeCleanupReceiptSchema> {}
export type NativeCapabilitySnapshot = z.infer<typeof NativeCapabilitySnapshotSchema>;
export type NativeHostId = z.infer<typeof NativeHostIdSchema>;
export type NativeTerminalKind = "result" | "interruption" | "failure";

export interface NativeSpawnRequest {
  runId: string;
  taskId: string;
  workerId: string;
  requestId: string;
  taskName: string;
  prompt: string;
  promptHash: string;
  promptBytes: number;
  freshContext: true;
  inheritConversation: false;
  toolProfile: z.infer<typeof NativeToolProfileSchema>;
}

export interface NativeThreadSnapshot {
  status: WorkerStatus;
  result?: unknown;
}

export interface NativeWaitSnapshot {
  nativeId: string;
  status: WorkerStatus;
}

export interface NativeHostClient {
  probe(): Promise<NativeHostProbe>;
  spawnFresh(request: NativeSpawnRequest): Promise<{ nativeId: string; inheritedTurnCount?: number }>;
  inspect(nativeId: string): Promise<NativeThreadSnapshot>;
  waitAny(nativeIds: string[], signal?: AbortSignal): Promise<NativeWaitSnapshot>;
  send?(nativeId: string, message: string): Promise<void>;
  interrupt?(nativeId: string, reason: string): Promise<void>;
  close?(nativeId: string): Promise<void>;
  archive?(nativeId: string): Promise<void>;
}

export interface NativeWorkerAdapterOptions {
  budget: HostBudgetCoordinator;
  fallbackMode?: "inline" | "serial";
  permitLeaseSeconds?: number;
}

export type NativeSpawnFallbackReason =
  | "adapter-non-conforming"
  | "envelope-too-large"
  | "unsafe-envelope"
  | "permit-unavailable"
  | "cooldown"
  | "rate-limited";

export type NativeSpawnOutcome =
  | { status: "spawned"; reused: boolean; handle: NativeWorkerHandle }
  | {
    status: "fallback";
    mode: "inline" | "serial";
    reason: NativeSpawnFallbackReason;
    remediation: string;
    capabilities: NativeCapabilitySnapshot;
    retryAt?: string;
  };

export interface NativeWaitResult {
  workerId: string;
  nativeId: string;
  status: WorkerStatus;
}

export interface NativeWorkerProtocolV2 {
  readonly id: NativeHostId;
  readonly version: 2;
  probe(): Promise<NativeCapabilitySnapshot>;
  spawnFresh(input: SpawnWorkerInput): Promise<NativeSpawnOutcome>;
  bind(handle: NativeWorkerHandle): void;
  snapshotHandles(): NativeWorkerHandle[];
  send(workerId: string, message: WorkerMessage): Promise<void>;
  status(workerId: string): Promise<WorkerStatus>;
  waitAny(workerIds: string[], signal?: AbortSignal): Promise<NativeWaitResult>;
  collect(workerId: string): Promise<WorkerResult>;
  interrupt(workerId: string, reason: string): Promise<void>;
  heartbeat(workerId: string, leaseSeconds?: number): Promise<void>;
  confirmDurableTerminal(workerId: string, kind: NativeTerminalKind): void;
  close(workerId: string, input: { supervisorNativeId: string }): Promise<void>;
  archive(workerId: string, supervisorNativeId: string): Promise<void>;
  cleanup(workerId: string, input: { supervisorNativeId: string }): Promise<NativeCleanupReceipt>;
}

export class NativeRateLimitError extends Error {
  readonly classification: "provider" | "generic";
  readonly provider?: string;
  readonly retryAfter?: number | string;

  constructor(input: {
    classification: "provider" | "generic";
    provider?: string;
    retryAfter?: number | string;
  }) {
    super("Native host rate limit");
    this.name = "NativeRateLimitError";
    this.classification = input.classification;
    if (input.provider !== undefined) this.provider = input.provider;
    if (input.retryAfter !== undefined) this.retryAfter = input.retryAfter;
  }
}

export class NativeWorkerAdapter implements NativeWorkerProtocolV2 {
  readonly version = 2 as const;
  private readonly handles = new Map<string, NativeWorkerHandle>();
  private readonly fallbackMode: "inline" | "serial";
  private readonly permitLeaseSeconds: number;

  constructor(
    readonly id: NativeHostId,
    private readonly client: NativeHostClient,
    private readonly options: NativeWorkerAdapterOptions,
    restoredHandles: NativeWorkerHandle[] = []
  ) {
    this.fallbackMode = options.fallbackMode ?? "serial";
    this.permitLeaseSeconds = options.permitLeaseSeconds ?? 900;
    for (const handle of restoredHandles) this.bind(handle);
  }

  async probe(): Promise<NativeCapabilitySnapshot> {
    const raw = NativeHostProbeSchema.parse(await this.client.probe());
    const operation = (
      name: keyof z.infer<typeof NativeOperationsSchema>,
      available: boolean
    ): z.infer<typeof OperationSupportSchema> => (
      available ? raw.operationStatus?.[name] ?? "supported" : "unsupported"
    );
    const operations = NativeOperationsSchema.parse({
      spawnFresh: operation("spawnFresh", typeof this.client.spawnFresh === "function"),
      bind: "supported",
      send: operation("send", typeof this.client.send === "function"),
      status: operation("status", typeof this.client.inspect === "function"),
      waitAny: operation("waitAny", typeof this.client.waitAny === "function"),
      collect: operation("collect", typeof this.client.inspect === "function"),
      interrupt: operation("interrupt", typeof this.client.interrupt === "function"),
      close: operation("close", typeof this.client.close === "function"),
      archive: operation("archive", typeof this.client.archive === "function")
    });
    const reasons: string[] = [];
    if (raw.contextPolicy.mode !== "fresh-attested") reasons.push("Host does not attest a fresh context.");
    if (raw.toolProfile.mode !== "allowlist" || !raw.toolProfile.enforced) {
      reasons.push("Host does not enforce an allowlisted Worker tool profile.");
    }
    if (raw.toolProfile.tools.length === 0) reasons.push("Worker tool allowlist is empty.");
    if (raw.toolProfile.agentflowMcpEnabled || raw.toolProfile.tools.some(isAgentFlowTool)) {
      reasons.push("Worker tool profile includes AgentFlow MCP.");
    }
    for (const operation of ["spawnFresh", "send", "status", "waitAny", "collect", "interrupt", "close"] as const) {
      if (operations[operation] !== "supported") reasons.push(`Required native operation is unavailable: ${operation}.`);
    }
    const conforming = reasons.length === 0;
    return NativeCapabilitySnapshotSchema.parse({
      version: 2,
      sourceVersion: 2,
      host: this.id,
      adapterVersion: raw.adapterVersion,
      conformance: conforming ? "conforming" : "non-conforming",
      fallback: conforming ? "none" : this.fallbackMode,
      contextPolicy: raw.contextPolicy,
      toolProfile: raw.toolProfile,
      operations,
      reasons
    });
  }

  async spawnFresh(rawInput: SpawnWorkerInput): Promise<NativeSpawnOutcome> {
    const input = SpawnWorkerInputSchema.parse(rawInput);
    const probe = await this.probe();
    if (probe.conformance !== "conforming") {
      return this.fallback("adapter-non-conforming", "Execute the Task inline or serially on the Supervisor.", probe);
    }
    const prompt = renderNativeWorkerPrompt(input, probe.toolProfile);
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > MAX_ENVELOPE_BYTES) {
      return this.fallback("envelope-too-large", "Reduce the Task envelope before native dispatch.", probe);
    }
    if (containsConversationEnvelope(input)) {
      return this.fallback("unsafe-envelope", "Remove inherited conversation or full Run state from Worker context.", probe);
    }
    const promptHash = sha256(prompt);
    const existing = this.handles.get(input.workerId);
    if (existing !== undefined) {
      if (existing.taskId !== input.taskId || existing.promptHash !== promptHash) {
        throw new ThreadAdapterError("Native Worker retry does not match the existing handle", "WORKER_ALREADY_EXISTS", {
          workerId: input.workerId
        });
      }
      return { status: "spawned", reused: true, handle: structuredClone(existing) };
    }

    const permitOwnerId = `${this.id}:${input.runId}:${input.workerId}`;
    const requestId = `native-spawn:${input.runId}:${input.taskId}:${input.workerId}:${promptHash}`;
    const acquired = await this.options.budget.acquire({
      ownerId: permitOwnerId,
      requestId,
      taskId: input.taskId,
      operationKind: "model-worker",
      leaseSeconds: this.permitLeaseSeconds
    });
    if (acquired.status !== "acquired") {
      if (acquired.status === "bypassed") {
        throw new ThreadAdapterError("Model Worker permit was unexpectedly bypassed", "CAPABILITY_UNAVAILABLE");
      }
      return this.fallback(
        acquired.reason === "cooldown" || acquired.reason === "recovery-probe" ? "cooldown" : "permit-unavailable",
        acquired.remediation,
        probe,
        acquired.retryAt
      );
    }

    let spawned: { nativeId: string; inheritedTurnCount?: number };
    try {
      spawned = await this.client.spawnFresh({
        runId: input.runId,
        taskId: input.taskId,
        workerId: input.workerId,
        requestId,
        taskName: input.taskName,
        prompt,
        promptHash,
        promptBytes,
        freshContext: true,
        inheritConversation: false,
        toolProfile: probe.toolProfile
      });
    } catch (error) {
      if (error instanceof NativeRateLimitError) {
        const circuit = await this.options.budget.recordRateLimit({
          permitId: acquired.permit.id,
          ownerId: permitOwnerId,
          classification: error.classification,
          ...(error.provider === undefined ? {} : { provider: error.provider }),
          ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter })
        });
        return this.fallback("rate-limited", "Wait for the persisted host cooldown before retrying.", probe, circuit.retryAt);
      }
      await this.options.budget.release({ permitId: acquired.permit.id, ownerId: permitOwnerId });
      throw error;
    }

    const parsedSpawn = NativeSpawnResultSchema.safeParse(spawned);
    if (!parsedSpawn.success) {
      if (typeof spawned.nativeId === "string" && spawned.nativeId.length > 0) {
        await this.abortInheritedSpawn(spawned.nativeId);
      }
      await this.options.budget.release({ permitId: acquired.permit.id, ownerId: permitOwnerId });
      throw new ThreadAdapterError("Native host returned an invalid Worker binding", "WORKER_RESULT_INVALID", {
        workerId: input.workerId,
        issues: parsedSpawn.error.issues
      });
    }
    const validSpawn = parsedSpawn.data;
    const duplicateNativeId = [...this.handles.values()].find((handle) => handle.nativeId === validSpawn.nativeId);
    if (duplicateNativeId !== undefined) {
      await this.options.budget.release({ permitId: acquired.permit.id, ownerId: permitOwnerId });
      throw new ThreadAdapterError("Native host reused an ID bound to another Worker", "WORKER_ALREADY_EXISTS", {
        workerId: input.workerId,
        nativeId: validSpawn.nativeId,
        existingWorkerId: duplicateNativeId.workerId
      });
    }

    const inheritedTurnCount = validSpawn.inheritedTurnCount;
    if (
      inheritedTurnCount !== 0
      || (probe.contextPolicy.inheritedTurnCountObservable && inheritedTurnCount === undefined)
    ) {
      await this.abortInheritedSpawn(validSpawn.nativeId);
      await this.options.budget.release({ permitId: acquired.permit.id, ownerId: permitOwnerId });
      throw new ThreadAdapterError(
        "Native Worker inherited Supervisor conversation turns",
        "CONTEXT_INHERITANCE_DETECTED",
        { workerId: input.workerId, inheritedTurnCount }
      );
    }
    try {
      await this.options.budget.recordSuccess({
        permitId: acquired.permit.id,
        ownerId: permitOwnerId
      });
    } catch (error) {
      await this.abortInheritedSpawn(validSpawn.nativeId);
      await this.options.budget.release({ permitId: acquired.permit.id, ownerId: permitOwnerId }).catch(() => undefined);
      throw error;
    }

    const now = new Date().toISOString();
    const handle = NativeWorkerHandleSchema.parse({
      version: 2,
      host: this.id,
      adapterVersion: probe.adapterVersion,
      workerId: input.workerId,
      taskId: input.taskId,
      nativeId: validSpawn.nativeId,
      taskName: input.taskName,
      status: "starting",
      promptHash,
      promptBytes,
      contextPolicy: {
        ...probe.contextPolicy,
        ...(inheritedTurnCount === undefined ? {} : { inheritedTurnCount })
      },
      toolProfile: probe.toolProfile,
      capabilities: probe.operations,
      permitId: acquired.permit.id,
      permitOwnerId,
      cleanup: pendingCleanup(),
      createdAt: now,
      updatedAt: now
    });
    this.bind(handle);
    return { status: "spawned", reused: false, handle: structuredClone(handle) };
  }

  bind(rawHandle: NativeWorkerHandle): void {
    const handle = NativeWorkerHandleSchema.parse(rawHandle);
    if (handle.host !== this.id) {
      throw new ThreadAdapterError("Native Worker belongs to a different host", "WORKER_RESULT_INVALID", {
        workerId: handle.workerId,
        expectedHost: this.id,
        actualHost: handle.host
      });
    }
    const existing = this.handles.get(handle.workerId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(handle)) {
      throw new ThreadAdapterError(`Worker already exists: ${handle.workerId}`, "WORKER_ALREADY_EXISTS");
    }
    const duplicateNativeId = [...this.handles.values()].find((candidate) => (
      candidate.workerId !== handle.workerId && candidate.nativeId === handle.nativeId
    ));
    if (duplicateNativeId !== undefined) {
      throw new ThreadAdapterError("Native ID is already bound to another Worker", "WORKER_ALREADY_EXISTS", {
        nativeId: handle.nativeId
      });
    }
    this.handles.set(handle.workerId, structuredClone(handle));
  }

  snapshotHandles(): NativeWorkerHandle[] {
    return [...this.handles.values()].map((handle) => structuredClone(handle));
  }

  async send(workerId: string, rawMessage: WorkerMessage): Promise<void> {
    if (this.client.send === undefined) throw capabilityUnavailable(this.id, "send");
    const handle = this.getHandle(workerId);
    const message = WorkerMessageSchema.parse(rawMessage);
    await this.client.send(handle.nativeId, JSON.stringify(message));
  }

  async status(workerId: string): Promise<WorkerStatus> {
    const handle = this.getHandle(workerId);
    const snapshot = await this.client.inspect(handle.nativeId);
    const status = WorkerStatusSchema.parse(snapshot.status);
    this.updateStatus(handle, status);
    return status;
  }

  async waitAny(workerIds: string[], signal?: AbortSignal): Promise<NativeWaitResult> {
    if (!Array.isArray(workerIds) || workerIds.length < 1 || workerIds.length > 32 || new Set(workerIds).size !== workerIds.length) {
      throw new ThreadAdapterError("waitAny requires one to 32 unique Worker IDs", "WORKER_RESULT_INVALID");
    }
    const handles = workerIds.map((workerId) => this.getHandle(workerId));
    const stopHeartbeats = this.startPermitHeartbeats(handles);
    let snapshot: NativeWaitSnapshot;
    try {
      snapshot = await this.client.waitAny(handles.map((handle) => handle.nativeId), signal);
    } finally {
      await stopHeartbeats();
    }
    const handle = handles.find((candidate) => candidate.nativeId === snapshot.nativeId);
    if (handle === undefined) {
      throw new ThreadAdapterError("waitAny returned an unrelated native task", "WORKER_RESULT_INVALID", {
        nativeId: snapshot.nativeId
      });
    }
    const status = WorkerStatusSchema.parse(snapshot.status);
    this.updateStatus(handle, status);
    return { workerId: handle.workerId, nativeId: handle.nativeId, status };
  }

  async collect(workerId: string): Promise<WorkerResult> {
    const handle = this.getHandle(workerId);
    const snapshot = await this.client.inspect(handle.nativeId);
    const status = WorkerStatusSchema.parse(snapshot.status);
    if (!isTerminalResultStatus(status)) {
      throw new ThreadAdapterError(`Worker is not terminal: ${workerId}`, "WORKER_NOT_TERMINAL", {
        workerId,
        status
      });
    }
    if (containsTranscriptData(snapshot.result)) {
      throw new ThreadAdapterError("Worker result contains transcript-shaped data", "WORKER_RESULT_INVALID", {
        workerId
      });
    }
    const parsed = NativeWorkerCapsuleSchema.safeParse(snapshot.result);
    if (
      !parsed.success
      || parsed.data.workerId !== workerId
      || parsed.data.taskId !== handle.taskId
      || parsed.data.status !== status
    ) {
      throw new ThreadAdapterError("Worker returned an invalid native result capsule", "WORKER_RESULT_INVALID", {
        workerId,
        issues: parsed.success ? ["workerId, taskId, or status mismatch"] : parsed.error.issues
      });
    }
    const capsule = redactWorkerResult(parsed.data);
    const capsuleBytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
    if (capsuleBytes > MAX_CAPSULE_BYTES) {
      throw new ThreadAdapterError("Worker result capsule exceeds the native protocol budget", "WORKER_RESULT_INVALID", {
        workerId,
        capsuleBytes,
        maximumBytes: MAX_CAPSULE_BYTES
      });
    }
    const capsuleHash = sha256(canonicalJson(parsed.data));
    if (handle.capsuleHash !== undefined && handle.capsuleHash !== capsuleHash) {
      throw new ThreadAdapterError("Worker result capsule changed after collection", "WORKER_RESULT_INVALID", {
        workerId
      });
    }
    const now = new Date().toISOString();
    this.handles.set(workerId, NativeWorkerHandleSchema.parse({
      ...handle,
      status,
      capsuleHash,
      resultCollectedAt: handle.resultCollectedAt ?? now,
      terminalObservedAt: handle.terminalObservedAt ?? now,
      updatedAt: now
    }));
    return capsule;
  }

  async interrupt(workerId: string, reason: string): Promise<void> {
    if (this.client.interrupt === undefined) throw capabilityUnavailable(this.id, "interrupt");
    const handle = this.getHandle(workerId);
    await this.client.interrupt(handle.nativeId, reason);
    this.updateStatus(handle, "interrupted");
  }

  async heartbeat(workerId: string, leaseSeconds?: number): Promise<void> {
    const handle = this.getHandle(workerId);
    await this.options.budget.heartbeat({
      permitId: handle.permitId,
      ownerId: handle.permitOwnerId,
      ...(leaseSeconds === undefined ? {} : { leaseSeconds })
    });
  }

  confirmDurableTerminal(workerId: string, kind: NativeTerminalKind): void {
    const handle = this.getHandle(workerId);
    if (handle.durableTerminal !== undefined) {
      if (handle.durableTerminal !== kind) {
        throw new ThreadAdapterError("Worker terminal persistence kind changed", "RESULT_NOT_PERSISTED", {
          workerId,
          existingKind: handle.durableTerminal,
          requestedKind: kind
        });
      }
      return;
    }
    if (kind === "result" && handle.capsuleHash === undefined) {
      throw new ThreadAdapterError("Worker result has not been collected", "RESULT_NOT_PERSISTED", { workerId });
    }
    if (kind === "interruption" && handle.status !== "interrupted") {
      throw new ThreadAdapterError("Worker interruption has not been confirmed", "RESULT_NOT_PERSISTED", { workerId });
    }
    if (kind === "failure" && handle.status !== "failed") {
      throw new ThreadAdapterError("Worker failure has not been confirmed", "RESULT_NOT_PERSISTED", { workerId });
    }
    const now = new Date().toISOString();
    this.handles.set(workerId, NativeWorkerHandleSchema.parse({
      ...handle,
      durableTerminal: kind,
      durableAt: now,
      updatedAt: now
    }));
  }

  async close(workerId: string, input: { supervisorNativeId: string }): Promise<void> {
    await this.refreshCleanupCapabilities(workerId);
    const handle = this.requireDurable(workerId);
    this.assertNotSupervisor(handle, input.supervisorNativeId);
    await this.performClose(handle);
  }

  async archive(workerId: string, supervisorNativeId: string): Promise<void> {
    await this.refreshCleanupCapabilities(workerId);
    const handle = this.requireDurable(workerId);
    this.assertNotSupervisor(handle, supervisorNativeId);
    if (!isCleanupStepDone(handle.cleanup.close)) {
      throw new ThreadAdapterError("Native close must complete before archive", "CLEANUP_ORDER_INVALID", { workerId });
    }
    await this.performArchive(handle);
  }

  async cleanup(workerId: string, input: { supervisorNativeId: string }): Promise<NativeCleanupReceipt> {
    await this.refreshCleanupCapabilities(workerId);
    let handle = this.requireDurable(workerId);
    this.assertNotSupervisor(handle, input.supervisorNativeId);
    await this.performClose(handle);
    handle = this.getHandle(workerId);
    if (handle.cleanup.close.status === "failed") return cleanupReceipt(handle);
    await this.performArchive(handle);
    handle = this.getHandle(workerId);
    if (handle.cleanup.archive.status === "failed") return cleanupReceipt(handle);
    await this.performPermitRelease(handle);
    return cleanupReceipt(this.getHandle(workerId));
  }

  private fallback(
    reason: NativeSpawnFallbackReason,
    remediation: string,
    capabilities: NativeCapabilitySnapshot,
    retryAt?: string
  ): NativeSpawnOutcome {
    return {
      status: "fallback",
      mode: this.fallbackMode,
      reason,
      remediation,
      capabilities,
      ...(retryAt === undefined ? {} : { retryAt })
    };
  }

  private getHandle(workerId: string): NativeWorkerHandle {
    const handle = this.handles.get(workerId);
    if (handle === undefined) {
      throw new ThreadAdapterError(`Worker not found: ${workerId}`, "WORKER_NOT_FOUND", { workerId });
    }
    return handle;
  }

  private requireDurable(workerId: string): NativeWorkerHandle {
    const handle = this.getHandle(workerId);
    if (handle.durableTerminal === undefined) {
      throw new ThreadAdapterError("Worker terminal result is not durably persisted", "RESULT_NOT_PERSISTED", {
        workerId
      });
    }
    return handle;
  }

  private assertNotSupervisor(handle: NativeWorkerHandle, supervisorNativeId: string): void {
    if (handle.nativeId === supervisorNativeId) {
      throw new ThreadAdapterError("Refusing to clean up the Supervisor native task", "SUPERVISOR_TASK_PROTECTED", {
        workerId: handle.workerId,
        nativeId: handle.nativeId
      });
    }
  }

  private updateStatus(handle: NativeWorkerHandle, status: WorkerStatus): void {
    const now = new Date().toISOString();
    this.handles.set(handle.workerId, NativeWorkerHandleSchema.parse({
      ...handle,
      status,
      ...(isNativeTerminal(status) && handle.terminalObservedAt === undefined ? { terminalObservedAt: now } : {}),
      updatedAt: now
    }));
  }

  private async performClose(rawHandle: NativeWorkerHandle): Promise<void> {
    let handle = this.getHandle(rawHandle.workerId);
    if (isCleanupStepDone(handle.cleanup.close)) return;
    const now = new Date().toISOString();
    if (handle.capabilities.close !== "supported") {
      this.setCleanupStep(handle, "close", handle.capabilities.close === "temporarily-unavailable"
        ? {
          status: "failed",
          at: now,
          reason: "Native close is temporarily unavailable."
        }
        : { status: "unsupported", at: now, reason: "Host has no native close operation." });
      return;
    }
    if (this.client.close === undefined) {
      this.setCleanupStep(handle, "close", { status: "unsupported", at: now, reason: "Host has no native close operation." });
      return;
    }
    try {
      await this.client.close(handle.nativeId);
      handle = this.getHandle(handle.workerId);
      this.setCleanupStep(handle, "close", { status: "completed", at: now });
      this.updateStatus(this.getHandle(handle.workerId), "closed");
    } catch (error) {
      this.setCleanupStep(handle, "close", {
        status: "failed",
        at: now,
        reason: boundedErrorMessage(error)
      });
    }
  }

  private async performArchive(rawHandle: NativeWorkerHandle): Promise<void> {
    const handle = this.getHandle(rawHandle.workerId);
    if (isCleanupStepDone(handle.cleanup.archive)) return;
    const now = new Date().toISOString();
    if (handle.capabilities.archive !== "supported") {
      this.setCleanupStep(handle, "archive", handle.capabilities.archive === "temporarily-unavailable"
        ? {
          status: "failed",
          at: now,
          reason: "Native archive is temporarily unavailable."
        }
        : { status: "unsupported", at: now, reason: "Host has no native archive operation." });
      return;
    }
    if (this.client.archive === undefined) {
      this.setCleanupStep(handle, "archive", { status: "unsupported", at: now, reason: "Host has no native archive operation." });
      return;
    }
    try {
      await this.client.archive(handle.nativeId);
      this.setCleanupStep(this.getHandle(handle.workerId), "archive", { status: "completed", at: now });
    } catch (error) {
      this.setCleanupStep(this.getHandle(handle.workerId), "archive", {
        status: "failed",
        at: now,
        reason: boundedErrorMessage(error)
      });
    }
  }

  private async performPermitRelease(rawHandle: NativeWorkerHandle): Promise<void> {
    const handle = this.getHandle(rawHandle.workerId);
    if (handle.cleanup.permitRelease.status === "completed") return;
    const now = new Date().toISOString();
    try {
      await this.options.budget.release({ permitId: handle.permitId, ownerId: handle.permitOwnerId });
      this.setCleanupStep(this.getHandle(handle.workerId), "permitRelease", { status: "completed", at: now });
      const updated = this.getHandle(handle.workerId);
      if (isCleanupComplete(updated.cleanup)) {
        this.handles.set(handle.workerId, NativeWorkerHandleSchema.parse({
          ...updated,
          cleanup: { ...updated.cleanup, completedAt: now },
          updatedAt: now
        }));
      }
    } catch (error) {
      this.setCleanupStep(this.getHandle(handle.workerId), "permitRelease", {
        status: "failed",
        at: now,
        reason: boundedErrorMessage(error)
      });
    }
  }

  private setCleanupStep(
    handle: NativeWorkerHandle,
    step: "close" | "archive" | "permitRelease",
    value: z.infer<typeof CleanupStepSchema>
  ): void {
    const now = new Date().toISOString();
    this.handles.set(handle.workerId, NativeWorkerHandleSchema.parse({
      ...handle,
      cleanup: { ...handle.cleanup, [step]: value },
      updatedAt: now
    }));
  }

  private async abortInheritedSpawn(nativeId: string): Promise<void> {
    await this.client.interrupt?.(nativeId, "Fresh-context attestation failed").catch(() => undefined);
    await this.client.close?.(nativeId).catch(() => undefined);
    await this.client.archive?.(nativeId).catch(() => undefined);
  }

  private async refreshCleanupCapabilities(workerId: string): Promise<void> {
    const snapshot = await this.probe();
    const handle = this.getHandle(workerId);
    const now = new Date().toISOString();
    this.handles.set(workerId, NativeWorkerHandleSchema.parse({
      ...handle,
      adapterVersion: snapshot.adapterVersion,
      capabilities: snapshot.operations,
      updatedAt: now
    }));
  }

  private startPermitHeartbeats(handles: NativeWorkerHandle[]): () => Promise<void> {
    const intervalMs = Math.max(250, Math.min(30_000, Math.floor(this.permitLeaseSeconds * 1_000 / 3)));
    let pending = Promise.resolve();
    let failure: unknown;
    const timer = setInterval(() => {
      pending = pending.then(async () => {
        for (const handle of handles) {
          await this.options.budget.heartbeat({
            permitId: handle.permitId,
            ownerId: handle.permitOwnerId,
            leaseSeconds: this.permitLeaseSeconds
          });
        }
      }).catch((error: unknown) => {
        failure ??= error;
      });
    }, intervalMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await pending;
      if (failure !== undefined) throw failure;
    };
  }
}

export function nativeCapabilitiesFromV1(
  host: NativeHostId,
  capabilities: ThreadCapabilities,
  fallback: "inline" | "serial" = "serial"
): NativeCapabilitySnapshot {
  return NativeCapabilitySnapshotSchema.parse({
    version: 2,
    sourceVersion: 1,
    host,
    adapterVersion: "1",
    conformance: "non-conforming",
    fallback,
    contextPolicy: { mode: "unknown", inheritedTurnCountObservable: false },
    toolProfile: { mode: "unknown", enforced: false, tools: [], agentflowMcpEnabled: false },
    operations: {
      spawnFresh: "unsupported",
      bind: "supported",
      send: capabilities.send ? "supported" : "unsupported",
      status: capabilities.status ? "supported" : "unsupported",
      waitAny: "unsupported",
      collect: capabilities.collect ? "supported" : "unsupported",
      interrupt: capabilities.interrupt ? "supported" : "unsupported",
      close: capabilities.close ? "supported" : "unsupported",
      archive: "unsupported"
    },
    reasons: [
      "Legacy capabilities do not attest fresh context.",
      "Legacy capabilities do not attest a Worker tool allowlist.",
      "Legacy capabilities do not provide waitAny or completion notification."
    ]
  });
}

export function renderNativeWorkerPrompt(
  input: SpawnWorkerInput,
  toolProfile: z.infer<typeof NativeToolProfileSchema>
): string {
  return [
    renderWorkerPrompt(input),
    "",
    "Native context policy: fresh context required; inherited conversation disabled.",
    `Worker tool allowlist: ${canonicalJson(toolProfile.tools)}`,
    "AgentFlow MCP: disabled. The Supervisor alone owns control-plane mutations."
  ].join("\n");
}

function pendingCleanup(): z.infer<typeof NativeHandleCleanupSchema> {
  return {
    close: { status: "pending" },
    archive: { status: "pending" },
    permitRelease: { status: "pending" }
  };
}

function cleanupReceipt(handle: NativeWorkerHandle): NativeCleanupReceipt {
  return NativeCleanupReceiptSchema.parse({
    version: 1,
    host: handle.host,
    adapterVersion: handle.adapterVersion,
    workerId: handle.workerId,
    nativeId: handle.nativeId,
    ...(handle.resultCollectedAt === undefined ? {} : { resultCollectedAt: handle.resultCollectedAt }),
    durableAt: handle.durableAt,
    close: handle.cleanup.close,
    archive: handle.cleanup.archive,
    permitRelease: handle.cleanup.permitRelease,
    ...(handle.cleanup.completedAt === undefined ? {} : { completedAt: handle.cleanup.completedAt }),
    completed: handle.cleanup.completedAt !== undefined
  });
}

function isCleanupStepDone(step: z.infer<typeof CleanupStepSchema>): boolean {
  return step.status === "completed" || step.status === "unsupported";
}

function isCleanupComplete(cleanup: z.infer<typeof NativeHandleCleanupSchema>): boolean {
  return isCleanupStepDone(cleanup.close)
    && isCleanupStepDone(cleanup.archive)
    && cleanup.permitRelease.status === "completed";
}

function isAgentFlowTool(tool: string): boolean {
  return /agentflow/iu.test(tool);
}

function containsConversationEnvelope(input: SpawnWorkerInput): boolean {
  if (input.prompt.context.length > 0) return true;
  const boundedTaskText = canonicalJson({
    objective: input.prompt.objective,
    context: input.prompt.context
  });
  return /supervisor\s+transcript|conversation\s+history|"role"\s*:\s*"(?:assistant|user)"/iu.test(boundedTaskText)
    || (/"pipelineId"/u.test(boundedTaskText) && /"events"/u.test(boundedTaskText));
}

function containsTranscriptData(value: unknown, depth = 0): boolean {
  if (typeof value === "string") {
    return /supervisor\s+transcript|conversation\s+history|prior\s+worker\s+transcript/iu.test(value);
  }
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsTranscriptData(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    /^(?:conversation|history|messages|transcript)$/iu.test(key)
    || containsTranscriptData(nested, depth + 1)
  ));
}

function isTerminalResultStatus(status: WorkerStatus): status is "completed" | "blocked" | "failed" {
  return status === "completed" || status === "blocked" || status === "failed";
}

function isNativeTerminal(status: WorkerStatus): boolean {
  return isTerminalResultStatus(status) || status === "interrupted" || status === "closed";
}

function capabilityUnavailable(host: NativeHostId, operation: string): ThreadAdapterError {
  return new ThreadAdapterError(`Adapter ${host} does not support ${operation}`, "CAPABILITY_UNAVAILABLE", {
    host,
    operation
  });
}

function boundedErrorMessage(error: unknown): string {
  return redactCredentialText(error instanceof Error ? error.message : "Native cleanup failed")
    .slice(0, 2_000);
}

function redactWorkerResult(result: WorkerResult): WorkerResult {
  return NativeWorkerCapsuleSchema.parse(redactCapsuleValue(result));
}

function redactCapsuleValue(value: unknown): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (Array.isArray(value)) return value.map(redactCapsuleValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactCapsuleValue(entry)]));
  }
  return value;
}

function redactCredentialText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9_]{8,}\b/giu, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{12,}\b/gu, "[REDACTED]")
    .replace(/\b((?:_?auth)?token|otp|password|secret|api[-_]?key)\s*[:=]\s*([^\s&]+)/giu, "$1=[REDACTED]")
    .replace(/https:\/\/([^:\s/@]+):([^@\s]+)@/giu, "https://$1:[REDACTED]@");
}
