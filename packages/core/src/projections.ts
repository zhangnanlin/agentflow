import { z } from "zod";
import { canonicalJson } from "./contracts.js";
import { RunStateSchema, type RunState } from "./model.js";

const IdSchema = z.string().min(1).max(160);
const SUMMARY_ITEM_LIMIT = 10;
const RECEIPT_ITEM_LIMIT = 30;

export const RunSectionSchema = z.enum(["stages", "tasks", "workers", "artifacts", "gates", "events", "idempotency"]);

const TaskSummarySchema = z.object({
  id: IdSchema,
  status: z.string().min(1),
  waveId: IdSchema.optional(),
  owner: IdSchema.optional()
}).strict();

const WorkerSummarySchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  status: z.string().min(1),
  adapter: IdSchema
}).strict();

export const RunSummarySchema = z.object({
  version: z.literal(1),
  runId: IdSchema,
  revision: z.number().int().nonnegative(),
  status: z.string().min(1),
  executionStatus: z.string().min(1),
  businessOutcome: z.string().min(1).optional(),
  activeStageId: IdSchema.optional(),
  currentTasks: z.array(TaskSummarySchema),
  currentTaskOverflow: z.number().int().nonnegative(),
  liveWorkers: z.array(WorkerSummarySchema),
  liveWorkerOverflow: z.number().int().nonnegative(),
  pendingGateId: IdSchema.optional(),
  blockers: z.array(z.string().min(1).max(300)),
  blockerOverflow: z.number().int().nonnegative(),
  nextAction: z.string().min(1).max(500)
}).strict();

const ChangedEntitiesSchema = z.object({
  stages: z.array(IdSchema),
  tasks: z.array(IdSchema),
  workers: z.array(IdSchema),
  artifacts: z.array(IdSchema),
  gates: z.array(IdSchema),
  overflow: z.object({
    stages: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    workers: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    gates: z.number().int().nonnegative()
  }).strict()
}).strict();

export const ChangeReceiptSchema = z.object({
  version: z.literal(1),
  runId: IdSchema,
  revision: z.number().int().nonnegative(),
  status: z.string().min(1),
  activeStageId: IdSchema.optional(),
  changed: ChangedEntitiesSchema,
  nextAction: z.string().min(1).max(500)
}).strict();

export const RunSectionPageSchema = z.object({
  version: z.literal(1),
  runId: IdSchema,
  revision: z.number().int().nonnegative(),
  section: RunSectionSchema,
  items: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).optional()
}).strict();

export type RunSection = z.infer<typeof RunSectionSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type ChangeReceipt = z.infer<typeof ChangeReceiptSchema>;
export type RunSectionPage = z.infer<typeof RunSectionPageSchema>;

export interface RunSectionOptions {
  cursor?: string;
  pageSize?: number;
}

export function projectRunSummary(rawState: RunState): RunSummary {
  const state = RunStateSchema.parse(rawState);
  const currentTasks = Object.values(state.tasks)
    .filter((task) => !["completed", "cancelled"].includes(task.status))
    .sort((left, right) => left.id.localeCompare(right.id));
  const liveWorkers = Object.values(state.workers)
    .filter((worker) => ["prepared", "starting", "running", "unknown"].includes(worker.status))
    .sort((left, right) => left.id.localeCompare(right.id));
  const pendingGate = Object.values(state.gates)
    .find((gate) => gate.status === "pending" && gate.stageId === state.activeStageId);
  const blockers = [
    ...Object.values(state.stages).filter((stage) => stage.status === "blocked").map((stage) => `stage:${stage.id}`),
    ...Object.values(state.tasks).filter((task) => ["blocked", "failed"].includes(task.status)).map((task) => `task:${task.id}`)
  ].sort();

  return RunSummarySchema.parse({
    version: 1,
    runId: state.id,
    revision: state.revision,
    status: state.status,
    executionStatus: state.executionStatus,
    ...(state.businessOutcome === undefined ? {} : { businessOutcome: state.businessOutcome }),
    ...(state.activeStageId === undefined ? {} : { activeStageId: state.activeStageId }),
    currentTasks: currentTasks.slice(0, SUMMARY_ITEM_LIMIT).map((task) => ({
      id: task.id,
      status: task.status,
      ...(task.waveId === undefined ? {} : { waveId: task.waveId }),
      ...(task.owner === undefined ? {} : { owner: task.owner })
    })),
    currentTaskOverflow: Math.max(0, currentTasks.length - SUMMARY_ITEM_LIMIT),
    liveWorkers: liveWorkers.slice(0, SUMMARY_ITEM_LIMIT).map((worker) => ({
      id: worker.id,
      taskId: worker.taskId,
      status: worker.status,
      adapter: worker.adapter
    })),
    liveWorkerOverflow: Math.max(0, liveWorkers.length - SUMMARY_ITEM_LIMIT),
    ...(pendingGate === undefined ? {} : { pendingGateId: pendingGate.id }),
    blockers: blockers.slice(0, SUMMARY_ITEM_LIMIT),
    blockerOverflow: Math.max(0, blockers.length - SUMMARY_ITEM_LIMIT),
    nextAction: nextAction(state, pendingGate?.id, currentTasks, liveWorkers)
  });
}

export function projectChangeReceipt(rawPrevious: RunState, rawNext: RunState): ChangeReceipt {
  const previous = RunStateSchema.parse(rawPrevious);
  const next = RunStateSchema.parse(rawNext);
  const stages = changedIds(previous.stages, next.stages);
  const tasks = changedIds(previous.tasks, next.tasks);
  const workers = changedIds(previous.workers, next.workers);
  const artifacts = changedIds(previous.artifacts, next.artifacts);
  const gates = changedIds(previous.gates, next.gates);
  const summary = projectRunSummary(next);

  return ChangeReceiptSchema.parse({
    version: 1,
    runId: next.id,
    revision: next.revision,
    status: next.status,
    ...(next.activeStageId === undefined ? {} : { activeStageId: next.activeStageId }),
    changed: {
      stages: stages.slice(0, RECEIPT_ITEM_LIMIT),
      tasks: tasks.slice(0, RECEIPT_ITEM_LIMIT),
      workers: workers.slice(0, RECEIPT_ITEM_LIMIT),
      artifacts: artifacts.slice(0, RECEIPT_ITEM_LIMIT),
      gates: gates.slice(0, RECEIPT_ITEM_LIMIT),
      overflow: {
        stages: Math.max(0, stages.length - RECEIPT_ITEM_LIMIT),
        tasks: Math.max(0, tasks.length - RECEIPT_ITEM_LIMIT),
        workers: Math.max(0, workers.length - RECEIPT_ITEM_LIMIT),
        artifacts: Math.max(0, artifacts.length - RECEIPT_ITEM_LIMIT),
        gates: Math.max(0, gates.length - RECEIPT_ITEM_LIMIT)
      }
    },
    nextAction: summary.nextAction
  });
}

export function projectRunSection(
  rawState: RunState,
  rawSection: RunSection,
  options: RunSectionOptions = {}
): RunSectionPage {
  const state = RunStateSchema.parse(rawState);
  const section = RunSectionSchema.parse(rawSection);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const offset = decodeCursor(options.cursor, section);
  const items = sectionItems(state, section);
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;

  return RunSectionPageSchema.parse({
    version: 1,
    runId: state.id,
    revision: state.revision,
    section,
    items: page,
    total: items.length,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(section, nextOffset) } : {})
  });
}

function nextAction(
  state: RunState,
  pendingGateId: string | undefined,
  currentTasks: Array<RunState["tasks"][string]>,
  liveWorkers: Array<RunState["workers"][string]>
): string {
  if (pendingGateId) return `Resolve mandatory Gate ${pendingGateId}`;
  const ready = currentTasks.find((task) => task.status === "ready");
  if (ready) return `Execute ready Task ${ready.id}`;
  if (liveWorkers.length > 0) return `Wait for ${liveWorkers.length} native Worker result${liveWorkers.length === 1 ? "" : "s"}`;
  if (state.activeStageId) return `Complete or advance Stage ${state.activeStageId}`;
  return `Run is ${state.businessOutcome ?? state.status}`;
}

function changedIds<T>(previous: Record<string, T>, next: Record<string, T>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((id) => entityFingerprint(previous[id]) !== entityFingerprint(next[id]))
    .sort();
}

function entityFingerprint(value: unknown): string {
  return value === undefined ? "missing" : `present:${canonicalJson(value)}`;
}

function sectionItems(state: RunState, section: RunSection): unknown[] {
  if (section === "events") return state.events;
  const record = state[section];
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function encodeCursor(section: RunSection, offset: number): string {
  return Buffer.from(JSON.stringify({ section, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, section: RunSection): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object"
      || parsed === null
      || (parsed as { section?: unknown }).section !== section
      || !Number.isSafeInteger((parsed as { offset?: unknown }).offset)
      || Number((parsed as { offset: number }).offset) < 0
    ) throw new Error("invalid cursor");
    return Number((parsed as { offset: number }).offset);
  } catch {
    throw new Error(`Invalid ${section} cursor`);
  }
}
