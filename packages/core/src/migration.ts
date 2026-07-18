import { RunStateSchema, type RunState, type WorkerStatus } from "./model.js";

const LIVE_WORKER_STATUSES = new Set<WorkerStatus>(["prepared", "starting", "running", "unknown"]);

export function migrateRunState(input: unknown): RunState {
  const source = structuredClone(input) as Record<string, unknown>;
  const status = typeof source.status === "string" ? source.status : "active";

  source.schemaVersion = 2;
  source.executionStatus ??= status === "completed" || status === "cancelled" ? "terminal" : "running";
  if (source.businessOutcome === undefined) {
    if (status === "completed") source.businessOutcome = "succeeded";
    if (status === "cancelled") source.businessOutcome = "cancelled";
  }

  const workers = isRecord(source.workers) ? source.workers : {};
  for (const value of Object.values(workers)) {
    if (!isRecord(value)) continue;
    value.adapterVersion ??= "1";
    value.contextPolicy ??= { mode: "unknown" };
    const workerStatus = value.status as WorkerStatus;
    if (!LIVE_WORKER_STATUSES.has(workerStatus) && value.cleanup === undefined) {
      const result = isRecord(value.result) ? value.result : undefined;
      value.cleanup = {
        ...(typeof result?.completedAt === "string" ? { resultCollectedAt: result.completedAt } : {}),
        close: workerStatus === "closed"
          ? { status: "completed", ...(typeof value.updatedAt === "string" ? { at: value.updatedAt } : {}) }
          : { status: "pending" },
        archive: { status: "pending" },
        permitRelease: { status: "pending" }
      };
    }
  }

  return RunStateSchema.parse(source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
