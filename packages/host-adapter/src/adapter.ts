import type {
  SpawnWorkerInput,
  ThreadCapabilities,
  WorkerHandle,
  WorkerMessage,
  WorkerResult,
  WorkerStatus
} from "./model.js";

export type ThreadAdapterErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "WORKER_ALREADY_EXISTS"
  | "WORKER_NOT_FOUND"
  | "WORKER_NOT_TERMINAL"
  | "WORKER_RESULT_INVALID"
  | "TASK_NOT_DISPATCHABLE"
  | "WORKSPACE_INVALID";

export class ThreadAdapterError extends Error {
  constructor(
    message: string,
    readonly code: ThreadAdapterErrorCode,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ThreadAdapterError";
  }
}

export interface ThreadAdapter {
  readonly id: string;
  capabilities(): Promise<ThreadCapabilities>;
  spawn(input: SpawnWorkerInput): Promise<WorkerHandle>;
  send(workerId: string, message: WorkerMessage): Promise<void>;
  status(workerId: string): Promise<WorkerStatus>;
  collect(workerId: string): Promise<WorkerResult>;
  interrupt(workerId: string, reason: string): Promise<void>;
  close(workerId: string): Promise<void>;
}

export function requireCapability(
  capabilities: ThreadCapabilities,
  capability: keyof ThreadCapabilities,
  adapterId: string
): void {
  if (!capabilities[capability]) {
    throw new ThreadAdapterError(
      `Adapter ${adapterId} does not support ${capability}`,
      "CAPABILITY_UNAVAILABLE",
      { adapterId, capability }
    );
  }
}
