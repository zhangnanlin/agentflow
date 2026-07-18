import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { sha256 } from "@agentflow/core";
import { z } from "zod";

const IsoDateSchema = z.iso.datetime({ offset: true });
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.string().min(1).max(4_096);
const PermitIdSchema = z.string().uuid();
const ConfirmationSchema = z.enum(["host-terminal", "process-exited"]);

const PermitLeaseSchema = z.object({
  id: PermitIdSchema,
  ownerHash: HashSchema,
  requestHash: HashSchema,
  taskHash: HashSchema,
  acquiredAt: IsoDateSchema,
  heartbeatAt: IsoDateSchema,
  expiresAt: IsoDateSchema
}).strict();

const CircuitSchema = z.object({
  state: z.enum(["closed", "open", "half-open"]),
  attempt: z.number().int().nonnegative(),
  classification: z.enum(["provider", "generic"]).optional(),
  providerHash: HashSchema.optional(),
  openedAt: IsoDateSchema.optional(),
  retryAt: IsoDateSchema.optional(),
  probePermitId: PermitIdSchema.optional(),
  lastRecoveredAt: IsoDateSchema.optional()
}).strict();

const CountersSchema = z.object({
  acquired: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
  reclaimed: z.number().int().nonnegative(),
  rateLimited: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  bypassed: z.number().int().nonnegative()
}).strict();

const ReleaseRecordSchema = z.object({
  permitId: PermitIdSchema,
  at: IsoDateSchema,
  reason: z.enum(["released", "rate-limited", "reclaimed"]),
  confirmation: ConfirmationSchema.optional(),
  actorHash: HashSchema.optional()
}).strict();

const SchedulerStateSchema = z.object({
  version: z.literal(1),
  budgetKey: z.string().regex(/^budget-[a-f0-9]{64}$/),
  capacity: z.number().int().min(1).max(32),
  permits: z.array(PermitLeaseSchema).max(32),
  circuit: CircuitSchema,
  counters: CountersSchema,
  recentReleases: z.array(ReleaseRecordSchema).max(32),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).strict();

const AcquireInputSchema = z.object({
  ownerId: IdentitySchema,
  requestId: IdentitySchema,
  taskId: IdentitySchema,
  operationKind: z.enum(["model-worker", "deterministic"]),
  leaseSeconds: z.number().int().min(1).max(86_400).optional()
}).strict();

const PermitOwnerInputSchema = z.object({
  permitId: PermitIdSchema,
  ownerId: IdentitySchema
}).strict();

const HeartbeatInputSchema = PermitOwnerInputSchema.extend({
  leaseSeconds: z.number().int().min(1).max(86_400).optional()
}).strict();

const ConfirmExpiredInputSchema = z.object({
  permitId: PermitIdSchema,
  confirmedBy: IdentitySchema,
  confirmation: ConfirmationSchema
}).strict();

const RateLimitInputSchema = PermitOwnerInputSchema.extend({
  classification: z.enum(["provider", "generic"]),
  provider: IdentitySchema.optional(),
  retryAfter: z.union([z.number().nonnegative(), z.string().min(1).max(256)]).optional()
}).strict();

const BudgetScopeSchema = z.object({
  host: IdentitySchema,
  profile: IdentitySchema.optional()
}).strict();

type SchedulerState = z.infer<typeof SchedulerStateSchema>;
export type PermitLease = z.infer<typeof PermitLeaseSchema>;
export type RateCircuitSnapshot = z.infer<typeof CircuitSchema> & { cooldownRemainingMs: number };

export type PermitBlockedReason =
  | "capacity"
  | "cooldown"
  | "expired-unconfirmed"
  | "owner-active"
  | "request-active"
  | "recovery-probe";

export type PermitAcquireResult =
  | { status: "bypassed"; reason: "deterministic-operation" }
  | { status: "acquired"; reused: boolean; permit: PermitLease }
  | {
    status: "blocked";
    reason: PermitBlockedReason;
    activePermitCount: number;
    retryAt?: string;
    remediation: string;
  };

export interface SchedulerMetric {
  name: string;
  unit: "count" | "milliseconds";
  value: number;
}

export interface SchedulerDiagnostics {
  version: 1;
  budgetKey: string;
  capacity: number;
  activePermitCount: number;
  expiredPermitCount: number;
  permits: Array<PermitLease & { status: "active" | "expired" }>;
  permitOverflow: number;
  circuit: RateCircuitSnapshot;
  metrics: SchedulerMetric[];
  remediation: string;
  updatedAt: string;
}

export type SchedulerErrorCode =
  | "SCHEDULER_HOME_INVALID"
  | "SCHEDULER_OPTIONS_INVALID"
  | "SCHEDULER_LOCK_INVALID"
  | "SCHEDULER_LOCK_TIMEOUT"
  | "SCHEDULER_STATE_INVALID"
  | "SCHEDULER_CAPACITY_MISMATCH"
  | "PERMIT_NOT_FOUND"
  | "PERMIT_OWNER_MISMATCH"
  | "PERMIT_EXPIRED"
  | "PERMIT_NOT_EXPIRED"
  | "CIRCUIT_PROBE_MISMATCH";

export class SchedulerError extends Error {
  constructor(
    message: string,
    readonly code: SchedulerErrorCode,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

export interface HostBudgetCoordinatorOptions {
  homeDirectory: string;
  host: string;
  profile?: string;
  capacity?: number;
  defaultLeaseSeconds?: number;
  now?: () => number;
  random?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitterRatio?: number;
  maxRetryAfterMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryMs?: number;
}

export interface ConfirmExpiredResult {
  reclaimed: boolean;
  permitId: string;
}

export interface ReleasePermitResult {
  released: boolean;
  alreadyReleased: boolean;
}

export function schedulerBudgetKey(rawScope: { host: string; profile?: string }): string {
  const scope = BudgetScopeSchema.parse(rawScope);
  return `budget-${sha256(JSON.stringify([scope.host, scope.profile ?? "default"]))}`;
}

export class HostBudgetCoordinator {
  readonly budgetKey: string;
  readonly budgetDirectory: string;

  private readonly statePath: string;
  private readonly lockDirectory: string;
  private readonly capacity: number;
  private readonly defaultLeaseSeconds: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitterRatio: number;
  private readonly maxRetryAfterMs: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockRetryMs: number;

  constructor(options: HostBudgetCoordinatorOptions) {
    if (!isAbsolute(options.homeDirectory)) {
      throw new SchedulerError("AgentFlow home directory must be absolute", "SCHEDULER_HOME_INVALID");
    }
    this.capacity = boundedInteger(options.capacity ?? 1, 1, 32, "capacity");
    this.defaultLeaseSeconds = boundedInteger(options.defaultLeaseSeconds ?? 900, 1, 86_400, "defaultLeaseSeconds");
    this.backoffBaseMs = boundedInteger(options.backoffBaseMs ?? 1_000, 1, 3_600_000, "backoffBaseMs");
    this.backoffMaxMs = boundedInteger(options.backoffMaxMs ?? 120_000, this.backoffBaseMs, 3_600_000, "backoffMaxMs");
    this.maxRetryAfterMs = boundedInteger(options.maxRetryAfterMs ?? 3_600_000, this.backoffBaseMs, 86_400_000, "maxRetryAfterMs");
    this.lockTimeoutMs = boundedInteger(options.lockTimeoutMs ?? 5_000, 10, 120_000, "lockTimeoutMs");
    this.staleLockMs = boundedInteger(options.staleLockMs ?? 30_000, 1, 600_000, "staleLockMs");
    this.lockRetryMs = boundedInteger(options.lockRetryMs ?? 10, 1, 1_000, "lockRetryMs");
    this.jitterRatio = options.jitterRatio ?? 0.2;
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 0.5) {
      throw new SchedulerError("jitterRatio must be between 0 and 0.5", "SCHEDULER_OPTIONS_INVALID");
    }
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.budgetKey = schedulerBudgetKey({
      host: options.host,
      ...(options.profile === undefined ? {} : { profile: options.profile })
    });
    const homeDirectory = resolve(options.homeDirectory);
    this.budgetDirectory = join(homeDirectory, "scheduler", this.budgetKey);
    this.statePath = join(this.budgetDirectory, "state.json");
    this.lockDirectory = join(this.budgetDirectory, ".lock");
  }

  acquire(rawInput: z.input<typeof AcquireInputSchema>): Promise<PermitAcquireResult> {
    const input = AcquireInputSchema.parse(rawInput);
    return this.transact((state, now) => {
      if (input.operationKind === "deterministic") {
        state.counters.bypassed += 1;
        return { status: "bypassed", reason: "deterministic-operation" };
      }

      const ownerHash = hashIdentity("owner", input.ownerId);
      const requestHash = hashIdentity("request", input.requestId);
      const taskHash = hashIdentity("task", input.taskId);
      const existingRequest = state.permits.find((permit) => permit.requestHash === requestHash);
      if (existingRequest) {
        if (existingRequest.ownerHash !== ownerHash) {
          return this.blocked(state, "request-active", now);
        }
        if (isExpired(existingRequest, now)) {
          return this.blocked(state, "expired-unconfirmed", now);
        }
        return { status: "acquired", reused: true, permit: structuredClone(existingRequest) };
      }

      const existingOwner = state.permits.find((permit) => permit.ownerHash === ownerHash);
      if (existingOwner) {
        return this.blocked(state, isExpired(existingOwner, now) ? "expired-unconfirmed" : "owner-active", now);
      }
      if (state.circuit.state === "open" && Date.parse(state.circuit.retryAt ?? "") > now) {
        return this.blocked(state, "cooldown", now, state.circuit.retryAt);
      }
      if (state.circuit.state === "half-open") {
        return this.blocked(state, "recovery-probe", now, state.circuit.retryAt);
      }
      if (state.permits.length >= state.capacity) {
        const reason = state.permits.some((permit) => isExpired(permit, now))
          ? "expired-unconfirmed"
          : "capacity";
        return this.blocked(state, reason, now);
      }

      const leaseSeconds = input.leaseSeconds ?? this.defaultLeaseSeconds;
      const permit = PermitLeaseSchema.parse({
        id: randomUUID(),
        ownerHash,
        requestHash,
        taskHash,
        acquiredAt: iso(now),
        heartbeatAt: iso(now),
        expiresAt: iso(now + leaseSeconds * 1_000)
      });
      state.permits.push(permit);
      state.counters.acquired += 1;
      if (state.circuit.state === "open") {
        state.circuit = CircuitSchema.parse({
          ...state.circuit,
          state: "half-open",
          probePermitId: permit.id
        });
      }
      return { status: "acquired", reused: false, permit: structuredClone(permit) };
    });
  }

  heartbeat(rawInput: z.input<typeof HeartbeatInputSchema>): Promise<PermitLease> {
    const input = HeartbeatInputSchema.parse(rawInput);
    return this.transact((state, now) => {
      const permit = requirePermit(state, input.permitId);
      assertOwner(permit, input.ownerId);
      if (isExpired(permit, now)) {
        throw new SchedulerError("Cannot heartbeat an expired permit", "PERMIT_EXPIRED", { permitId: permit.id });
      }
      const leaseSeconds = input.leaseSeconds ?? this.defaultLeaseSeconds;
      permit.heartbeatAt = iso(now);
      permit.expiresAt = iso(now + leaseSeconds * 1_000);
      return structuredClone(permit);
    });
  }

  release(rawInput: z.input<typeof PermitOwnerInputSchema>): Promise<ReleasePermitResult> {
    const input = PermitOwnerInputSchema.parse(rawInput);
    return this.transact((state, now) => {
      const existingRelease = state.recentReleases.some((record) => record.permitId === input.permitId);
      if (existingRelease && !state.permits.some((permit) => permit.id === input.permitId)) {
        return { released: false, alreadyReleased: true };
      }
      const permit = requirePermit(state, input.permitId);
      assertOwner(permit, input.ownerId);
      removePermit(state, permit.id);
      pushRelease(state, { permitId: permit.id, at: iso(now), reason: "released" });
      state.counters.released += 1;
      if (state.circuit.state === "half-open" && state.circuit.probePermitId === permit.id) {
        state.circuit = reopenAfterAbandonedProbe(state.circuit, now, this.backoffBaseMs);
      }
      return { released: true, alreadyReleased: false };
    });
  }

  confirmExpired(rawInput: z.input<typeof ConfirmExpiredInputSchema>): Promise<ConfirmExpiredResult> {
    const input = ConfirmExpiredInputSchema.parse(rawInput);
    return this.transact((state, now) => {
      const permit = requirePermit(state, input.permitId);
      if (!isExpired(permit, now)) {
        throw new SchedulerError("Permit has not expired", "PERMIT_NOT_EXPIRED", { permitId: permit.id });
      }
      removePermit(state, permit.id);
      pushRelease(state, {
        permitId: permit.id,
        at: iso(now),
        reason: "reclaimed",
        confirmation: input.confirmation,
        actorHash: hashIdentity("observer", input.confirmedBy)
      });
      state.counters.reclaimed += 1;
      if (state.circuit.state === "half-open" && state.circuit.probePermitId === permit.id) {
        state.circuit = reopenAfterAbandonedProbe(state.circuit, now, this.backoffBaseMs);
      }
      return { reclaimed: true, permitId: permit.id };
    });
  }

  recordRateLimit(rawInput: z.input<typeof RateLimitInputSchema>): Promise<RateCircuitSnapshot> {
    const input = RateLimitInputSchema.parse(rawInput);
    return this.transact((state, now) => {
      const permit = requirePermit(state, input.permitId);
      assertOwner(permit, input.ownerId);
      removePermit(state, permit.id);
      pushRelease(state, { permitId: permit.id, at: iso(now), reason: "rate-limited" });
      state.counters.released += 1;
      state.counters.rateLimited += 1;
      const attempt = Math.min(1_000, state.circuit.attempt + 1);
      const retryAtMs = retryDeadline(
        input.retryAfter,
        now,
        attempt,
        this.random,
        this.jitterRatio,
        this.backoffBaseMs,
        this.backoffMaxMs,
        this.maxRetryAfterMs
      );
      state.circuit = CircuitSchema.parse({
        state: "open",
        attempt,
        classification: input.classification,
        ...(input.provider === undefined ? {} : { providerHash: hashIdentity("provider", input.provider) }),
        openedAt: iso(now),
        retryAt: iso(retryAtMs)
      });
      return circuitSnapshot(state.circuit, now);
    });
  }

  recordSuccess(rawInput: z.input<typeof PermitOwnerInputSchema>): Promise<RateCircuitSnapshot> {
    const input = PermitOwnerInputSchema.parse(rawInput);
    return this.transact((state, now) => {
      const permit = requirePermit(state, input.permitId);
      assertOwner(permit, input.ownerId);
      if (state.circuit.state === "half-open") {
        if (state.circuit.probePermitId !== permit.id) {
          throw new SchedulerError("Permit is not the active recovery probe", "CIRCUIT_PROBE_MISMATCH", {
            permitId: permit.id
          });
        }
        state.circuit = CircuitSchema.parse({
          state: "closed",
          attempt: 0,
          lastRecoveredAt: iso(now)
        });
        state.counters.recovered += 1;
      }
      return circuitSnapshot(state.circuit, now);
    });
  }

  diagnostics(): Promise<SchedulerDiagnostics> {
    return this.withLock(async () => {
      const now = this.currentTime();
      const state = await this.readState(now);
      const allPermits = state.permits.map((permit) => ({
        ...structuredClone(permit),
        status: isExpired(permit, now) ? "expired" as const : "active" as const
      }));
      const activePermitCount = allPermits.filter((permit) => permit.status === "active").length;
      const expiredPermitCount = allPermits.length - activePermitCount;
      const permits = [...allPermits]
        .sort((left, right) => left.status.localeCompare(right.status) || left.id.localeCompare(right.id))
        .slice(0, 6);
      const circuit = circuitSnapshot(state.circuit, now);
      const metrics: SchedulerMetric[] = [
        { name: "scheduler.active_permits", unit: "count", value: activePermitCount },
        { name: "scheduler.expired_permits", unit: "count", value: expiredPermitCount },
        { name: "scheduler.permit_capacity", unit: "count", value: state.capacity },
        { name: "scheduler.cooldown_remaining", unit: "milliseconds", value: circuit.cooldownRemainingMs },
        { name: "scheduler.permits_acquired", unit: "count", value: state.counters.acquired },
        { name: "scheduler.acquisitions_blocked", unit: "count", value: state.counters.blocked },
        { name: "scheduler.rate_limit_events", unit: "count", value: state.counters.rateLimited },
        { name: "scheduler.permits_reclaimed", unit: "count", value: state.counters.reclaimed },
        { name: "scheduler.bypassed_operations", unit: "count", value: state.counters.bypassed }
      ];
      return {
        version: 1,
        budgetKey: state.budgetKey,
        capacity: state.capacity,
        activePermitCount,
        expiredPermitCount,
        permits,
        permitOverflow: Math.max(0, allPermits.length - permits.length),
        circuit,
        metrics,
        remediation: remediationFor(state, activePermitCount, expiredPermitCount, now),
        updatedAt: state.updatedAt
      };
    });
  }

  private blocked(
    state: SchedulerState,
    reason: PermitBlockedReason,
    now: number,
    retryAt?: string
  ): PermitAcquireResult {
    state.counters.blocked += 1;
    const activePermitCount = state.permits.filter((permit) => !isExpired(permit, now)).length;
    return {
      status: "blocked",
      reason,
      activePermitCount,
      ...(retryAt === undefined ? {} : { retryAt }),
      remediation: blockedRemediation(reason)
    };
  }

  private async transact<T>(update: (state: SchedulerState, now: number) => T): Promise<T> {
    return this.withLock(async () => {
      const now = this.currentTime();
      const state = await this.readState(now);
      const result = update(state, now);
      state.updatedAt = iso(now);
      await this.writeState(state);
      return result;
    });
  }

  private async readState(now: number): Promise<SchedulerState> {
    let source: string;
    try {
      const stateStats = await lstat(this.statePath);
      if (stateStats.isSymbolicLink() || !stateStats.isFile() || stateStats.size > 1_048_576) {
        throw new SchedulerError("Scheduler state path is invalid", "SCHEDULER_STATE_INVALID");
      }
      source = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return freshState(this.budgetKey, this.capacity, now);
      throw error;
    }
    const parsed = SchedulerStateSchema.safeParse(parseJson(source));
    if (!parsed.success || parsed.data.budgetKey !== this.budgetKey) {
      throw new SchedulerError("Scheduler state is invalid", "SCHEDULER_STATE_INVALID", {
        issues: parsed.success ? ["budget key mismatch"] : parsed.error.issues
      });
    }
    if (parsed.data.capacity !== this.capacity) {
      throw new SchedulerError("Scheduler capacity differs from persisted state", "SCHEDULER_CAPACITY_MISMATCH", {
        configuredCapacity: this.capacity,
        persistedCapacity: parsed.data.capacity
      });
    }
    return parsed.data;
  }

  private async writeState(state: SchedulerState): Promise<void> {
    const parsed = SchedulerStateSchema.parse(state);
    const temporary = join(this.budgetDirectory, `state.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.statePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new SchedulerError("Scheduler clock returned an invalid value", "SCHEDULER_OPTIONS_INVALID");
    }
    return Math.floor(value);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.budgetDirectory, { recursive: true });
    const token = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await this.releaseLock(token);
    }
  }

  private async acquireLock(): Promise<string> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    while (true) {
      try {
        await mkdir(this.lockDirectory);
        await writeFile(join(this.lockDirectory, "owner.json"), JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }), { encoding: "utf8", flag: "wx" });
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      try {
        const lockStats = await lstat(this.lockDirectory);
        if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) {
          throw new SchedulerError("Scheduler lock path is invalid", "SCHEDULER_LOCK_INVALID");
        }
        if (Date.now() - lockStats.mtimeMs > this.staleLockMs && await this.retireStaleLock()) {
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new SchedulerError("Timed out waiting for scheduler lock", "SCHEDULER_LOCK_TIMEOUT", {
          budgetKey: this.budgetKey
        });
      }
      await delay(this.lockRetryMs);
    }
  }

  private async releaseLock(token: string): Promise<void> {
    let ownerSource: string;
    try {
      ownerSource = await readFile(join(this.lockDirectory, "owner.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const owner = parseJson(ownerSource) as { token?: unknown };
    if (owner.token !== token) return;
    const tombstone = join(this.budgetDirectory, `.lock.release-${token}`);
    try {
      await rename(this.lockDirectory, tombstone);
      await rm(tombstone, { recursive: true, force: true });
    } catch (error) {
      if (!isRetryableLockRace(error)) throw error;
    }
  }

  private async retireStaleLock(): Promise<boolean> {
    let ownerSource: string;
    try {
      ownerSource = await readFile(join(this.lockDirectory, "owner.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const owner = parseJson(ownerSource) as { token?: unknown };
    if (typeof owner.token !== "string" || owner.token.length < 1 || owner.token.length > 256) {
      throw new SchedulerError("Stale scheduler lock has no valid owner token", "SCHEDULER_LOCK_INVALID");
    }

    try {
      const current = await lstat(this.lockDirectory);
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw new SchedulerError("Scheduler lock path is invalid", "SCHEDULER_LOCK_INVALID");
      }
      if (Date.now() - current.mtimeMs <= this.staleLockMs) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    const retiredName = `.lock.retired-${sha256(owner.token)}`;
    const retiredPath = join(this.budgetDirectory, retiredName);
    const entries = await readdir(this.budgetDirectory);
    if (entries.includes(retiredName)) return false;
    if (entries.filter((entry) => entry.startsWith(".lock.retired-")).length >= 64) {
      throw new SchedulerError("Scheduler has too many retained stale lock generations", "SCHEDULER_LOCK_INVALID", {
        budgetKey: this.budgetKey
      });
    }
    try {
      await rename(this.lockDirectory, retiredPath);
      return true;
    } catch (error) {
      if (isRetryableLockRace(error)) return false;
      throw error;
    }
  }
}

function freshState(budgetKey: string, capacity: number, now: number): SchedulerState {
  return SchedulerStateSchema.parse({
    version: 1,
    budgetKey,
    capacity,
    permits: [],
    circuit: { state: "closed", attempt: 0 },
    counters: {
      acquired: 0,
      blocked: 0,
      released: 0,
      reclaimed: 0,
      rateLimited: 0,
      recovered: 0,
      bypassed: 0
    },
    recentReleases: [],
    createdAt: iso(now),
    updatedAt: iso(now)
  });
}

function requirePermit(state: SchedulerState, permitId: string): PermitLease {
  const permit = state.permits.find((candidate) => candidate.id === permitId);
  if (!permit) throw new SchedulerError("Permit was not found", "PERMIT_NOT_FOUND", { permitId });
  return permit;
}

function assertOwner(permit: PermitLease, ownerId: string): void {
  if (permit.ownerHash !== hashIdentity("owner", ownerId)) {
    throw new SchedulerError("Permit owner does not match", "PERMIT_OWNER_MISMATCH", { permitId: permit.id });
  }
}

function removePermit(state: SchedulerState, permitId: string): void {
  state.permits = state.permits.filter((permit) => permit.id !== permitId);
}

function pushRelease(state: SchedulerState, rawRecord: z.input<typeof ReleaseRecordSchema>): void {
  state.recentReleases.push(ReleaseRecordSchema.parse(rawRecord));
  if (state.recentReleases.length > 32) state.recentReleases.splice(0, state.recentReleases.length - 32);
}

function reopenAfterAbandonedProbe(circuit: SchedulerState["circuit"], now: number, backoffMs: number): SchedulerState["circuit"] {
  return CircuitSchema.parse({
    state: "open",
    attempt: Math.max(1, circuit.attempt),
    classification: circuit.classification ?? "generic",
    ...(circuit.providerHash === undefined ? {} : { providerHash: circuit.providerHash }),
    openedAt: circuit.openedAt ?? iso(now),
    retryAt: iso(now + backoffMs)
  });
}

function retryDeadline(
  retryAfter: number | string | undefined,
  now: number,
  attempt: number,
  random: () => number,
  jitterRatio: number,
  baseMs: number,
  maxMs: number,
  maxRetryAfterMs: number
): number {
  const explicit = parseRetryAfter(retryAfter, now);
  if (explicit !== undefined) return Math.min(now + maxRetryAfterMs, Math.max(now + 1_000, explicit));
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new SchedulerError("Scheduler random source returned an invalid value", "SCHEDULER_OPTIONS_INVALID");
  }
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.min(30, Math.max(0, attempt - 1))));
  const factor = 1 - jitterRatio + (2 * jitterRatio * sample);
  return now + Math.max(1, Math.round(exponential * factor));
}

function parseRetryAfter(value: number | string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return now + value * 1_000;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return now + Number(trimmed) * 1_000;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function circuitSnapshot(circuit: SchedulerState["circuit"], now: number): RateCircuitSnapshot {
  const retryAt = circuit.retryAt === undefined ? undefined : Date.parse(circuit.retryAt);
  return {
    ...structuredClone(circuit),
    cooldownRemainingMs: retryAt === undefined || !Number.isFinite(retryAt) ? 0 : Math.max(0, retryAt - now)
  };
}

function remediationFor(state: SchedulerState, active: number, expired: number, now: number): string {
  if (expired > 0) return "Confirm native ownership is terminal before reclaiming expired permits.";
  if (state.circuit.state === "open" && Date.parse(state.circuit.retryAt ?? "") > now) {
    return "Wait for the persisted rate-limit cooldown before retrying spawn.";
  }
  if (state.circuit.state === "half-open") return "Wait for the single recovery probe to finish.";
  if (active >= state.capacity) return "Wait for an active model Worker permit to be released.";
  return "Scheduler is ready for one eligible model Worker dispatch.";
}

function blockedRemediation(reason: PermitBlockedReason): string {
  if (reason === "cooldown") return "Wait until retryAt before attempting one recovery probe.";
  if (reason === "expired-unconfirmed") return "Confirm the expired owner is terminal, then reclaim its permit.";
  if (reason === "recovery-probe") return "Wait for the active recovery probe to succeed or fail.";
  if (reason === "owner-active") return "Reuse or release the existing owner permit before another dispatch.";
  if (reason === "request-active") return "Use the existing request owner; do not duplicate the dispatch.";
  return "Wait for an active permit to be released.";
}

function isExpired(permit: PermitLease, now: number): boolean {
  return Date.parse(permit.expiresAt) <= now;
}

function hashIdentity(kind: string, value: string): string {
  return sha256(`${kind}\0${value}`);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new SchedulerError("Scheduler JSON is invalid", "SCHEDULER_STATE_INVALID");
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SchedulerError(`${name} must be an integer between ${minimum} and ${maximum}`, "SCHEDULER_OPTIONS_INVALID");
  }
  return value;
}

function isRetryableLockRace(error: unknown): boolean {
  return ["ENOENT", "EEXIST", "ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(
    (error as NodeJS.ErrnoException).code ?? ""
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
