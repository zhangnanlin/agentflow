import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentFlowError,
  canonicalJson,
  defaultPipeline,
  sha256,
  validatePipeline,
  type AgentFlowEngine,
  type RunState
} from "@agentflow/core";
import * as z from "zod/v4";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createEngine, type ProjectPaths } from "./runtime.js";

const IGNORE_START = "# agentflow:managed:start";
const IGNORE_END = "# agentflow:managed:end";
const IGNORE_BODY = [
  "runtime/",
  "runs/",
  "current-run.json",
  ".start.lock",
  ".start.lock.retired-*",
  ".start.pending.json",
  "start-requests/",
  "*.tmp"
].join("\n");
const RunIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ImmutableInputSchema = z.object({
  requirement: z.string().min(1).max(20_000),
  projectType: z.enum(["new", "existing"]),
  hasUi: z.boolean(),
  requestedRunId: RunIdSchema.optional()
}).strict();
const StartRequestSchema = ImmutableInputSchema.extend({
  requestKey: z.string().min(1).max(256)
}).strict();
const PendingJournalSchema = z.object({
  version: z.literal(1),
  keyHash: HashSchema,
  inputHash: HashSchema,
  runId: RunIdSchema,
  action: z.enum(["started", "resumed"]),
  request: ImmutableInputSchema,
  createdAt: z.iso.datetime({ offset: true })
}).strict();
const RequestRecordSchema = z.object({
  version: z.literal(1),
  keyHash: HashSchema,
  inputHash: HashSchema,
  runId: RunIdSchema,
  action: z.enum(["started", "resumed"]),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true })
}).strict();
const CurrentRunSchema = z.object({ runId: RunIdSchema }).strict();
const LockSchema = z.object({
  version: z.literal(1),
  token: z.string().uuid(),
  pid: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true })
}).strict();

type ImmutableInput = z.infer<typeof ImmutableInputSchema>;
type PendingJournal = z.infer<typeof PendingJournalSchema>;
type RequestRecord = z.infer<typeof RequestRecordSchema>;

export interface StartOrResumeRunInput {
  requirement: string;
  projectType: "new" | "existing";
  hasUi: boolean;
  requestedRunId?: string;
  requestKey: string;
}

export interface StartOrResumeRunResult {
  action: "started" | "resumed";
  projectRoot: string;
  initialized: boolean;
  state: RunState;
}

export interface StartOrResumeRunConflict {
  action: "conflict";
  projectRoot: string;
  initialized: boolean;
  conflict: {
    code: "ACTIVE_RUN_INTENT_CONFLICT" | "REQUESTED_RUN_NOT_FOUND";
    activeRunId: string;
    actions: Array<
      | { action: "resume"; requestedRunId: string }
      | { action: "cancel"; tool: "run_cancel"; runId: string }
      | { action: "supersede"; tool: "run_supersede"; runId: string }
      | { action: "wait"; runId: string }
      | { action: "reconcile"; runId: string }
    >;
  };
}

export type StartOrResumeRunOutcome = StartOrResumeRunResult | StartOrResumeRunConflict;

export type ProjectLifecycleCheckpoint =
  | "after-journal"
  | "after-run-created"
  | "after-current-pointer"
  | "before-request-record";

export interface ProjectLifecycleDependencies {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryMs?: number;
  faultInjector?: (checkpoint: ProjectLifecycleCheckpoint) => void | Promise<void>;
}

export async function assertProjectInitialized(paths: ProjectPaths): Promise<void> {
  await assertControlTreeUnlinked(paths);
  let configSource: string;
  let pipelineSource: string;
  try {
    [configSource, pipelineSource] = await Promise.all([
      readFile(paths.configPath, "utf8"),
      readFile(paths.pipelinePath, "utf8")
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentFlowError(
        "AgentFlow is not initialized for this project",
        "PROJECT_NOT_INITIALIZED",
        { projectRoot: paths.projectRoot }
      );
    }
    throw error;
  }

  validateConfig(configSource, paths);
  validatePipelineSource(pipelineSource, paths);
}

export async function startOrResumeRun(
  paths: ProjectPaths,
  rawInput: StartOrResumeRunInput,
  dependencies: ProjectLifecycleDependencies = {}
): Promise<StartOrResumeRunOutcome> {
  const input = parseStartRequest(rawInput);
  await assertControlTreeUnlinked(paths);
  await mkdir(paths.agentflowDirectory, { recursive: true });
  await assertControlTreeUnlinked(paths);
  const lockToken = await acquireStartLock(paths, dependencies);
  const stopHeartbeat = startLockHeartbeat(paths, lockToken, dependencies.staleLockMs ?? 30_000);
  try {
    await assertControlTreeUnlinked(paths);
    return await startOrResumeLocked(paths, input, dependencies);
  } finally {
    await stopHeartbeat();
    await releaseStartLock(paths, lockToken);
  }
}

async function startOrResumeLocked(
  paths: ProjectPaths,
  input: z.infer<typeof StartRequestSchema>,
  dependencies: ProjectLifecycleDependencies
): Promise<StartOrResumeRunOutcome> {
  const immutable = immutableInput(input);
  const keyHash = sha256(input.requestKey);
  const inputHash = sha256(canonicalJson(immutable));
  const recordPath = requestRecordPath(paths, keyHash);
  const existingRecord = await readRequestRecord(recordPath, paths, keyHash);
  if (existingRecord !== undefined) {
    assertRequestMatch(existingRecord, keyHash, inputHash, input.requestKey);
    await assertProjectInitialized(paths);
    const engine = await createEngine(paths);
    return resultFromRecord(paths, existingRecord, await loadRunForRecord(engine, existingRecord, paths), false);
  }

  const pending = await readPendingJournal(paths);
  if (pending !== undefined) {
    await assertProjectInitialized(paths);
    await recoverPendingJournal(paths, pending);
    const recoveredRecord = await readRequestRecord(recordPath, paths, keyHash);
    if (recoveredRecord !== undefined) {
      assertRequestMatch(recoveredRecord, keyHash, inputHash, input.requestKey);
      const engine = await createEngine(paths);
      return resultFromRecord(
        paths,
        recoveredRecord,
        await loadRunForRecord(engine, recoveredRecord, paths),
        false
      );
    }
  }

  const initialized = await initializeControlFiles(paths);
  const engine = await createEngine(paths);
  const current = await loadCurrentRun(paths, engine);
  if (input.requestedRunId !== undefined) {
    const requested = await loadOptionalRun(engine, input.requestedRunId);
    if (requested !== undefined) {
      return persistOperation(
        paths,
        engine,
        input,
        keyHash,
        inputHash,
        requested.id,
        "resumed",
        initialized,
        dependencies
      );
    }
    if (current !== undefined && isRunUnfinished(current)) {
      return intentConflict(paths, initialized, current.id, "REQUESTED_RUN_NOT_FOUND");
    }
  }
  if (current !== undefined && isRunUnfinished(current)) {
    if (!sameNormalizedIntent(current, input)) {
      return intentConflict(paths, initialized, current.id, "ACTIVE_RUN_INTENT_CONFLICT");
    }
    return persistOperation(paths, engine, input, keyHash, inputHash, current.id, "resumed", initialized, dependencies);
  }

  const runId = input.requestedRunId ?? `run-${randomUUID()}`;
  await assertRunIdAvailable(engine, runId);
  return persistOperation(paths, engine, input, keyHash, inputHash, runId, "started", initialized, dependencies);
}

async function persistOperation(
  paths: ProjectPaths,
  engine: AgentFlowEngine,
  input: z.infer<typeof StartRequestSchema>,
  keyHash: string,
  inputHash: string,
  runId: string,
  action: "started" | "resumed",
  initialized: boolean,
  dependencies: ProjectLifecycleDependencies
): Promise<StartOrResumeRunResult> {
  const createdAt = new Date().toISOString();
  const journal = PendingJournalSchema.parse({
    version: 1,
    keyHash,
    inputHash,
    runId,
    action,
    request: immutableInput(input),
    createdAt
  });
  await atomicWrite(paths.startPendingPath, journal);
  await checkpoint(dependencies, "after-journal");

  let state: RunState;
  if (action === "started") {
    state = await engine.createRun({
      id: runId,
      requirement: input.requirement,
      projectType: input.projectType,
      hasUi: input.hasUi
    });
    await checkpoint(dependencies, "after-run-created");
    await atomicWrite(paths.currentRunPath, { runId });
    await checkpoint(dependencies, "after-current-pointer");
  } else {
    state = await engine.loadRun(runId);
    if (input.requestedRunId !== undefined) {
      await atomicWrite(paths.currentRunPath, { runId });
      await checkpoint(dependencies, "after-current-pointer");
    }
  }

  await checkpoint(dependencies, "before-request-record");
  const record = completedRecord(journal);
  await atomicWrite(requestRecordPath(paths, keyHash), record);
  await rm(paths.startPendingPath, { force: true });
  return { action, projectRoot: paths.projectRoot, initialized, state };
}

async function recoverPendingJournal(paths: ProjectPaths, pending: PendingJournal): Promise<void> {
  const recordPath = requestRecordPath(paths, pending.keyHash);
  const existingRecord = await readRequestRecord(recordPath, paths, pending.keyHash);
  if (existingRecord !== undefined) {
    assertRequestMatch(existingRecord, pending.keyHash, pending.inputHash, pending.keyHash);
  }

  const engine = await createEngine(paths);
  const pointer = await readCurrentPointer(paths);
  const explicitlySelectedPendingRun = pending.request.requestedRunId === pending.runId;
  if (pointer !== undefined && pointer !== pending.runId && !explicitlySelectedPendingRun) {
    throw journalError(paths, "Pending Run conflicts with current-run.json", {
      pendingRunId: pending.runId,
      currentRunId: pointer
    });
  }

  let state: RunState;
  try {
    state = await engine.loadRun(pending.runId);
  } catch (error) {
    if (!isAgentFlowCode(error, "RUN_NOT_FOUND") || pending.action !== "started") {
      throw journalError(paths, "Pending Run state is unavailable", { runId: pending.runId });
    }
    state = await engine.createRun({
      id: pending.runId,
      requirement: pending.request.requirement,
      projectType: pending.request.projectType,
      hasUi: pending.request.hasUi
    });
  }
  if (
    pending.action === "started"
    && (state.requirement !== pending.request.requirement
      || state.projectType !== pending.request.projectType
      || state.hasUi !== pending.request.hasUi)
  ) {
    throw journalError(paths, "Pending Run state does not match its immutable request", {
      runId: pending.runId
    });
  }

  if (pointer === undefined || explicitlySelectedPendingRun) {
    await atomicWrite(paths.currentRunPath, { runId: pending.runId });
  }
  if (existingRecord === undefined) await atomicWrite(recordPath, completedRecord(pending));
  await rm(paths.startPendingPath, { force: true });
}

async function initializeControlFiles(paths: ProjectPaths): Promise<boolean> {
  const [pipelineSource, configSource] = await Promise.all([
    readOptional(paths.pipelinePath),
    readOptional(paths.configPath)
  ]);
  if (pipelineSource !== undefined) validatePipelineSource(pipelineSource, paths);
  if (configSource !== undefined) validateConfig(configSource, paths);

  const createdPipeline = await createIfMissing(
    paths.pipelinePath,
    stringifyYaml(defaultPipeline),
    async (source) => validatePipelineSource(source, paths)
  );
  const createdConfig = await createIfMissing(
    paths.configPath,
    stringifyYaml({ version: 1, pipeline: "pipeline.yaml", runsDirectory: "runs" }),
    async (source) => validateConfig(source, paths)
  );
  await mkdir(paths.runsDirectory, { recursive: true });
  await mkdir(paths.startRequestsDirectory, { recursive: true });

  const existingIgnore = await readOptional(paths.ignorePath);
  const mergedIgnore = mergeIgnore(existingIgnore ?? "");
  if (existingIgnore === undefined) {
    try {
      await writeFile(paths.ignorePath, mergedIgnore, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const racedIgnore = await readFile(paths.ignorePath, "utf8");
      const racedMerged = mergeIgnore(racedIgnore);
      if (racedIgnore !== racedMerged) await atomicWriteText(paths.ignorePath, racedMerged);
    }
  } else if (existingIgnore !== mergedIgnore) {
    await atomicWriteText(paths.ignorePath, mergedIgnore);
  }
  return createdPipeline || createdConfig;
}

async function acquireStartLock(
  paths: ProjectPaths,
  dependencies: ProjectLifecycleDependencies
): Promise<string> {
  const lockTimeoutMs = dependencies.lockTimeoutMs ?? 5_000;
  const staleLockMs = dependencies.staleLockMs ?? 30_000;
  const lockRetryMs = dependencies.lockRetryMs ?? 25;
  const deadline = Date.now() + lockTimeoutMs;
  const token = randomUUID();

  while (true) {
    try {
      const handle = await open(paths.startLockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          createdAt: new Date().toISOString()
        })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (!isTransientLockContentionCode(code)) throw error;
        if (Date.now() >= deadline) throw startLockTimeout(paths);
        await delay(lockRetryMs);
        continue;
      }
      let evidence: StartLockEvidence | undefined;
      try {
        evidence = await readStartLockEvidence(paths);
      } catch (evidenceError) {
        if (!isTransientLockContentionCode((evidenceError as NodeJS.ErrnoException).code)) throw evidenceError;
        await delay(lockRetryMs);
        continue;
      }
      if (evidence === undefined) continue;
      if (Date.now() - evidence.mtimeMs > staleLockMs && await retireStartLock(paths, evidence)) continue;
      if (Date.now() >= deadline) {
        throw startLockTimeout(paths);
      }
      await delay(lockRetryMs);
    }
  }
}

async function releaseStartLock(paths: ProjectPaths, token: string): Promise<void> {
  const evidence = await readStartLockEvidence(paths);
  if (evidence === undefined) return;
  try {
    if (LockSchema.parse(JSON.parse(evidence.source)).token === token) await retireStartLock(paths, evidence);
  } catch {
    // A changed lock no longer belongs to this invocation and must be preserved.
  }
}

interface StartLockEvidence {
  identity: string;
  source: string;
  mtimeMs: number;
}

async function readStartLockEvidence(paths: ProjectPaths): Promise<StartLockEvidence | undefined> {
  try {
    const stats = await lstat(paths.startLockPath);
    if (stats.isSymbolicLink()) throw linkedControlPathError(paths, paths.startLockPath);
    const source = await readFile(paths.startLockPath, "utf8");
    return {
      identity: sha256(canonicalJson({
        source,
        size: stats.size,
        mtimeMs: stats.mtimeMs
      })),
      source,
      mtimeMs: stats.mtimeMs
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function retireStartLock(paths: ProjectPaths, evidence: StartLockEvidence): Promise<boolean> {
  const retiredPath = resolve(paths.agentflowDirectory, `.start.lock.retired-${evidence.identity}`);
  try {
    await link(paths.startLockPath, retiredPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || isTransientLockContentionCode(code)) return false;
    throw error;
  }

  const retiredEvidence = await readLockEvidenceAtPath(paths, retiredPath);
  if (retiredEvidence?.identity !== evidence.identity) {
    await rm(retiredPath, { force: true });
    return false;
  }

  try {
    await rm(paths.startLockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (isTransientLockContentionCode(code)) {
      await rm(retiredPath, { force: true });
      return false;
    }
    throw error;
  } finally {
    await pruneRetiredStartLocks(paths);
  }
  return true;
}

function startLockTimeout(paths: ProjectPaths): AgentFlowError {
  return new AgentFlowError(
    "Timed out waiting for the AgentFlow project start lock",
    "PROJECT_START_LOCK_TIMEOUT",
    { projectRoot: paths.projectRoot, lockPath: paths.startLockPath }
  );
}

function isTransientLockContentionCode(code: string | undefined): boolean {
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function readLockEvidenceAtPath(
  paths: ProjectPaths,
  path: string
): Promise<StartLockEvidence | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw linkedControlPathError(paths, path);
    const source = await readFile(path, "utf8");
    return {
      identity: sha256(canonicalJson({
        source,
        size: stats.size,
        mtimeMs: stats.mtimeMs
      })),
      source,
      mtimeMs: stats.mtimeMs
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function startLockHeartbeat(
  paths: ProjectPaths,
  token: string,
  staleLockMs: number
): () => Promise<void> {
  const intervalMs = Math.max(5, Math.min(1_000, Math.floor(staleLockMs / 3)));
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(() => heartbeatStartLock(paths, token)).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

async function heartbeatStartLock(paths: ProjectPaths, token: string): Promise<void> {
  let handle;
  try {
    handle = await open(paths.startLockPath, "r+");
    const source = await handle.readFile({ encoding: "utf8" });
    if (LockSchema.parse(JSON.parse(source)).token !== token) return;
    const now = new Date();
    await handle.utimes(now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Heartbeats are advisory. Ownership is verified again before release.
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pruneRetiredStartLocks(paths: ProjectPaths): Promise<void> {
  const names = (await readdir(paths.agentflowDirectory))
    .filter((name) => name.startsWith(".start.lock.retired-"));
  if (names.length <= 128) return;
  const candidates = await Promise.all(names.map(async (name) => {
    const path = resolve(paths.agentflowDirectory, name);
    try {
      return { path, mtimeMs: (await lstat(path)).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  const oldest = candidates
    .filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== undefined)
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .slice(0, Math.max(0, candidates.length - 128));
  await Promise.all(oldest.map((candidate) => rm(candidate.path, { force: true })));
}

async function assertControlTreeUnlinked(paths: ProjectPaths): Promise<void> {
  let rootStats;
  try {
    rootStats = await lstat(paths.agentflowDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw linkedControlPathError(paths, paths.agentflowDirectory);
  }
  if (!rootStats.isDirectory()) {
    throw new AgentFlowError(
      "AgentFlow control path must be a directory",
      "PROJECT_CONTROL_PATH_INVALID",
      { projectRoot: paths.projectRoot, path: paths.agentflowDirectory }
    );
  }
  await assertDirectoryTreeUnlinked(paths, paths.agentflowDirectory);
}

async function assertDirectoryTreeUnlinked(paths: ProjectPaths, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink()) throw linkedControlPathError(paths, path);
    if (stats.isDirectory()) await assertDirectoryTreeUnlinked(paths, path);
  }
}

function linkedControlPathError(paths: ProjectPaths, path: string): AgentFlowError {
  return new AgentFlowError(
    "AgentFlow control paths must not contain symbolic links",
    "PROJECT_CONTROL_PATH_LINKED",
    { projectRoot: paths.projectRoot, path }
  );
}

function sameNormalizedIntent(state: RunState, input: ImmutableInput): boolean {
  return normalizeRequirement(state.requirement) === normalizeRequirement(input.requirement)
    && state.hasUi === input.hasUi;
}

function normalizeRequirement(requirement: string): string {
  return requirement.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function isRunUnfinished(state: RunState): boolean {
  return state.executionStatus === "running";
}

function intentConflict(
  paths: ProjectPaths,
  initialized: boolean,
  activeRunId: string,
  code: StartOrResumeRunConflict["conflict"]["code"]
): StartOrResumeRunConflict {
  return {
    action: "conflict",
    projectRoot: paths.projectRoot,
    initialized,
    conflict: {
      code,
      activeRunId,
      actions: [
        { action: "resume", requestedRunId: activeRunId },
        { action: "cancel", tool: "run_cancel", runId: activeRunId },
        { action: "supersede", tool: "run_supersede", runId: activeRunId },
        { action: "wait", runId: activeRunId },
        { action: "reconcile", runId: activeRunId }
      ]
    }
  };
}

async function loadOptionalRun(engine: AgentFlowEngine, runId: string): Promise<RunState | undefined> {
  try {
    return await engine.loadRun(runId);
  } catch (error) {
    if (isAgentFlowCode(error, "RUN_NOT_FOUND")) return undefined;
    throw error;
  }
}

async function loadCurrentRun(paths: ProjectPaths, engine: AgentFlowEngine): Promise<RunState | undefined> {
  const runId = await readCurrentPointer(paths);
  if (runId === undefined) return undefined;
  try {
    return await engine.loadRun(runId);
  } catch (error) {
    throw new AgentFlowError("current-run.json references an invalid Run", "CURRENT_RUN_INVALID", {
      projectRoot: paths.projectRoot,
      runId,
      message: error instanceof Error ? error.message : "Run loading failed"
    });
  }
}

async function readCurrentPointer(paths: ProjectPaths): Promise<string | undefined> {
  const source = await readOptional(paths.currentRunPath);
  if (source === undefined) return undefined;
  try {
    return CurrentRunSchema.parse(JSON.parse(source)).runId;
  } catch (error) {
    throw new AgentFlowError("current-run.json is invalid", "CURRENT_RUN_INVALID", {
      projectRoot: paths.projectRoot,
      message: error instanceof Error ? error.message : "pointer parsing failed"
    });
  }
}

async function assertRunIdAvailable(engine: AgentFlowEngine, runId: string): Promise<void> {
  try {
    await engine.loadRun(runId);
  } catch (error) {
    if (isAgentFlowCode(error, "RUN_NOT_FOUND")) return;
    throw error;
  }
  throw new AgentFlowError(`Run already exists: ${runId}`, "RUN_EXISTS", { runId });
}

async function readPendingJournal(paths: ProjectPaths): Promise<PendingJournal | undefined> {
  const source = await readOptional(paths.startPendingPath);
  if (source === undefined) return undefined;
  try {
    const pending = PendingJournalSchema.parse(JSON.parse(source));
    const expectedInputHash = sha256(canonicalJson(pending.request));
    if (
      pending.inputHash !== expectedInputHash
      || (pending.action === "started"
        && pending.request.requestedRunId !== undefined
        && pending.request.requestedRunId !== pending.runId)
    ) {
      throw new Error("journal integrity fields do not match");
    }
    return pending;
  } catch (error) {
    throw journalError(paths, "The pending start journal is invalid", {
      message: error instanceof Error ? error.message : "journal parsing failed"
    });
  }
}

async function readRequestRecord(
  path: string,
  paths: ProjectPaths,
  expectedKeyHash: string
): Promise<RequestRecord | undefined> {
  const source = await readOptional(path);
  if (source === undefined) return undefined;
  try {
    const record = RequestRecordSchema.parse(JSON.parse(source));
    if (record.keyHash !== expectedKeyHash) throw new Error("request key hash does not match its record path");
    return record;
  } catch (error) {
    throw new AgentFlowError("The AgentFlow start request record is invalid", "PROJECT_START_REQUEST_INVALID", {
      projectRoot: paths.projectRoot,
      path,
      message: error instanceof Error ? error.message : "request record parsing failed"
    });
  }
}

function assertRequestMatch(record: RequestRecord, keyHash: string, inputHash: string, requestKey: string): void {
  if (record.keyHash !== keyHash || record.inputHash !== inputHash) {
    throw new AgentFlowError(
      "AgentFlow requestKey was already used with different immutable input",
      "IDEMPOTENCY_CONFLICT",
      { requestKeyHash: sha256(requestKey), runId: record.runId }
    );
  }
}

async function loadRunForRecord(
  engine: AgentFlowEngine,
  record: RequestRecord,
  paths: ProjectPaths
): Promise<RunState> {
  try {
    return await engine.loadRun(record.runId);
  } catch (error) {
    throw new AgentFlowError("Start request record references an unavailable Run", "PROJECT_START_REQUEST_INVALID", {
      projectRoot: paths.projectRoot,
      runId: record.runId,
      message: error instanceof Error ? error.message : "Run loading failed"
    });
  }
}

function resultFromRecord(
  paths: ProjectPaths,
  record: RequestRecord,
  state: RunState,
  initialized: boolean
): StartOrResumeRunResult {
  return {
    action: record.action,
    projectRoot: paths.projectRoot,
    initialized,
    state
  };
}

function parseStartRequest(input: StartOrResumeRunInput): z.infer<typeof StartRequestSchema> {
  try {
    return StartRequestSchema.parse(input);
  } catch (error) {
    throw new AgentFlowError("Invalid run_start_or_resume input", "PROJECT_START_INPUT_INVALID", {
      message: error instanceof Error ? error.message : "input validation failed"
    });
  }
}

function immutableInput(input: z.infer<typeof StartRequestSchema>): ImmutableInput {
  return ImmutableInputSchema.parse({
    requirement: input.requirement,
    projectType: input.projectType,
    hasUi: input.hasUi,
    ...(input.requestedRunId === undefined ? {} : { requestedRunId: input.requestedRunId })
  });
}

function completedRecord(journal: PendingJournal): RequestRecord {
  return RequestRecordSchema.parse({
    version: 1,
    keyHash: journal.keyHash,
    inputHash: journal.inputHash,
    runId: journal.runId,
    action: journal.action,
    createdAt: journal.createdAt,
    completedAt: new Date().toISOString()
  });
}

function requestRecordPath(paths: ProjectPaths, keyHash: string): string {
  return resolve(paths.startRequestsDirectory, `${keyHash}.json`);
}

function validateConfig(source: string, paths: ProjectPaths): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new AgentFlowError("AgentFlow config.yaml is invalid", "PROJECT_CONFIG_INVALID", {
      projectRoot: paths.projectRoot,
      message: error instanceof Error ? error.message : "config parsing failed"
    });
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as Record<string, unknown>)["version"] !== 1
    || (parsed as Record<string, unknown>)["pipeline"] !== "pipeline.yaml"
    || (parsed as Record<string, unknown>)["runsDirectory"] !== "runs"
  ) {
    throw new AgentFlowError("AgentFlow config.yaml is invalid", "PROJECT_CONFIG_INVALID", {
      projectRoot: paths.projectRoot
    });
  }
}

function validatePipelineSource(source: string, paths: ProjectPaths): void {
  try {
    validatePipeline(parseYaml(source));
  } catch (error) {
    throw new AgentFlowError("AgentFlow pipeline.yaml is invalid", "PROJECT_PIPELINE_INVALID", {
      projectRoot: paths.projectRoot,
      message: error instanceof Error ? error.message : "pipeline validation failed"
    });
  }
}

async function createIfMissing(
  path: string,
  content: string,
  validateExisting: (source: string) => Promise<void>
): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await validateExisting(await readFile(path, "utf8"));
    return false;
  }
}

function mergeIgnore(existing: string): string {
  const block = `${IGNORE_START}\n${IGNORE_BODY}\n${IGNORE_END}`;
  const start = existing.indexOf(IGNORE_START);
  const end = existing.indexOf(IGNORE_END);
  if (start >= 0 && end >= start) {
    const suffixStart = end + IGNORE_END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(suffixStart)}`.replace(/\s*$/, "\n");
  }
  const prefix = existing.length === 0 ? "" : `${existing.replace(/\s*$/, "")}\n\n`;
  return `${prefix}${block}\n`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function checkpoint(
  dependencies: ProjectLifecycleDependencies,
  value: ProjectLifecycleCheckpoint
): Promise<void> {
  await dependencies.faultInjector?.(value);
}

function journalError(
  paths: ProjectPaths,
  message: string,
  details: Record<string, unknown>
): AgentFlowError {
  return new AgentFlowError(message, "PROJECT_START_JOURNAL_INVALID", {
    projectRoot: paths.projectRoot,
    ...details
  });
}

function isAgentFlowCode(error: unknown, code: string): boolean {
  return error instanceof AgentFlowError && error.code === code;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
