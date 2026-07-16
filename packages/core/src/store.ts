import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentFlowError, invariant } from "./errors.js";
import { RunStateSchema, type MutationContext, type RunState } from "./model.js";

export interface TransactionOptions extends MutationContext {
  operation: string;
}

export interface RunStore {
  create(state: RunState): Promise<RunState>;
  load(runId: string): Promise<RunState>;
  transact(
    runId: string,
    options: TransactionOptions,
    mutate: (state: RunState) => RunState
  ): Promise<RunState>;
}

export interface JsonRunStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class JsonRunStore implements RunStore {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(
    private readonly rootDirectory: string,
    options: JsonRunStoreOptions = {}
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async create(state: RunState): Promise<RunState> {
    const parsed = RunStateSchema.parse(state);
    const path = this.statePath(parsed.id);
    await mkdir(dirname(path), { recursive: true });

    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.close();
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AgentFlowError(`Run already exists: ${parsed.id}`, "RUN_EXISTS", { runId: parsed.id });
      }
      throw error;
    }
  }

  async load(runId: string): Promise<RunState> {
    try {
      return RunStateSchema.parse(JSON.parse(await readFile(this.statePath(runId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentFlowError(`Run not found: ${runId}`, "RUN_NOT_FOUND", { runId });
      }
      throw error;
    }
  }

  async transact(
    runId: string,
    options: TransactionOptions,
    mutate: (state: RunState) => RunState
  ): Promise<RunState> {
    return this.withLock(runId, async () => {
      const current = await this.load(runId);
      const prior = current.idempotency[options.idempotencyKey];
      if (prior) {
        invariant(
          prior.operation === options.operation,
          `Idempotency key already used for ${prior.operation}`,
          "IDEMPOTENCY_CONFLICT",
          { idempotencyKey: options.idempotencyKey }
        );
        invariant(
          prior.inputHash === options.inputHash,
          "Idempotency key input does not match the recorded operation",
          "IDEMPOTENCY_CONFLICT",
          {
            idempotencyKey: options.idempotencyKey,
            recordedInputHash: prior.inputHash,
            requestedInputHash: options.inputHash
          }
        );
        return current;
      }

      invariant(
        current.revision === options.expectedRevision,
        `Expected revision ${options.expectedRevision}, found ${current.revision}`,
        "REVISION_CONFLICT",
        { expectedRevision: options.expectedRevision, actualRevision: current.revision }
      );

      const next = mutate(structuredClone(current));
      const now = new Date().toISOString();
      next.revision = current.revision + 1;
      next.updatedAt = now;
      next.idempotency[options.idempotencyKey] = {
        operation: options.operation,
        actorId: options.actor.id,
        ...(options.inputHash === undefined ? {} : { inputHash: options.inputHash }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        recordedAt: now
      };

      const parsed = RunStateSchema.parse(next);
      await this.atomicWrite(this.statePath(runId), parsed);
      return parsed;
    });
  }

  private statePath(runId: string): string {
    return join(this.rootDirectory, runId, "state.json");
  }

  private lockPath(runId: string): string {
    return join(this.rootDirectory, runId, ".lock");
  }

  private async atomicWrite(path: string, state: RunState): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private async withLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(runId);
    await mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;

    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > this.staleLockMs) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new AgentFlowError(`Timed out waiting for run lock: ${runId}`, "LOCK_TIMEOUT", { runId });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    try {
      return await action();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}
