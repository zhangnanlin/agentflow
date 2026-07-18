import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentFlowError,
  migrateRunState,
  projectChangeReceipt,
  projectRunSummary,
  sha256,
  type RunState
} from "@agentflow/core";
import type { NativeCapabilitySnapshot } from "@agentflow/host-adapter";
import type { HostClient } from "./host-config.js";

const STATUS_BUDGET_BYTES = 8_192;
const MUTATION_BUDGET_BYTES = 4_096;
const STALE_AGE_MS = 60 * 60 * 1_000;
const MAX_PROCESS_SAMPLES = 256;
const MAX_RUN_DIRECTORIES = 256;
const MAX_LARGEST_RUNS = 5;
const MAX_BUDGET_VIOLATIONS = 5;
const MAX_STATE_BYTES = 32 * 1_024 * 1_024;
const MAX_TOTAL_STATE_READ_BYTES = 64 * 1_024 * 1_024;
const MAX_EVENTS_PER_RUN = 2_000;
const MCP_COMMAND_PATTERN = /(?:agentflow-mcp(?:\.mjs|\.js)?|packages[\\/]mcp-server[\\/](?:src|dist)[\\/]index\.(?:js|ts))/i;
const execFileAsync = promisify(execFile);

const WINDOWS_PROCESS_SCRIPT = [
  "$pattern = 'agentflow-mcp(?:\\.mjs|\\.js)?|packages[\\\\/]mcp-server[\\\\/](?:src|dist)[\\\\/]index\\.(?:js|ts)'",
  "$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object {",
  "  $started = if ($null -eq $_.CreationDate) { $null } else { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') }",
  "  [pscustomobject]@{ workingSetBytes = [double]$_.WorkingSetSize; startedAt = $started }",
  "})",
  "ConvertTo-Json -InputObject $rows -Compress"
].join("; ");

export interface DoctorProcessSample {
  workingSetBytes?: number;
  startedAt?: string;
  ageMs?: number;
  commandLine?: string;
  environment?: Record<string, string>;
}

export interface DoctorProcessProbeResult {
  supported: boolean;
  samples: DoctorProcessSample[];
}

export interface DoctorProcessCommandResult {
  stdout: string;
}

export type DoctorProcessCommandRunner = (
  file: string,
  args: string[]
) => Promise<DoctorProcessCommandResult>;

export interface DoctorProcessProbeOptions {
  platform?: NodeJS.Platform;
  runner?: DoctorProcessCommandRunner;
}

export interface RuntimeSchedulerSnapshot {
  capacity: number;
  activePermitCount: number;
  expiredPermitCount: number;
  circuit: {
    state: "closed" | "open" | "half-open";
    cooldownRemainingMs: number;
    retryAt?: string;
  };
}

export interface DoctorRuntimeDependencies {
  processProbe?: () => Promise<DoctorProcessProbeResult>;
  schedulerProbe?: () => Promise<RuntimeSchedulerSnapshot | undefined>;
}

export interface DoctorRuntimeOptions {
  projectRoot: string;
  agentflowHome: string;
  host?: HostClient;
  nativeCapabilitySnapshot?: NativeCapabilitySnapshot;
  now?: () => number;
  dependencies?: DoctorRuntimeDependencies;
}

export interface DoctorRuntimeDiagnostics {
  version: 1;
  generatedAt: string;
  processes: {
    status: "available" | "unavailable";
    count: number;
    workingSetSampleCount: number;
    aggregateWorkingSetBytes?: number;
    staleCandidateCount: number;
    oldestAgeMs?: number;
  };
  runs: {
    scanned: number;
    scanOverflow: number;
    parsed: number;
    parseFailures: number;
    readSkipped: number;
    largest: Array<{ runHash: string; stateBytes: number }>;
  };
  responseBudgets: {
    statusLimitBytes: number;
    mutationLimitBytes: number;
    violationCount: number;
    violations: Array<{
      runHash: string;
      profile: "summary" | "receipt";
      responseBytes: number;
      limitBytes: number;
    }>;
    violationOverflow: number;
  };
  cleanup: {
    pendingWorkers: number;
    unsupportedWorkers: number;
    failedWorkers: number;
    completedWorkers: number;
    staleLiveWorkers: number;
  };
  scheduler: {
    status: "available" | "unavailable";
    capacity?: number;
    activePermitCount?: number;
    expiredPermitCount?: number;
    cooldownState?: "closed" | "open" | "half-open";
    cooldownRemainingMs?: number;
    retryAt?: string;
  };
  nativeAdapter: {
    liveProbeProvided: boolean;
    host?: HostClient;
    adapterVersion?: string;
    conformance?: "conforming" | "non-conforming";
    fallback?: "none" | "inline" | "serial";
    freshContextAttested?: boolean;
    toolAllowlistEnforced?: boolean;
    agentflowMcpDisabled?: boolean;
    reasonCount?: number;
    invalid?: boolean;
  };
}

const nativeProcessRunner: DoctorProcessCommandRunner = async (file, args) => {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1_048_576
  });
  return { stdout: result.stdout };
};

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : undefined;
}

function safeIso(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined;
}

function windowsSamples(stdout: string): DoctorProcessSample[] {
  let parsed: unknown;
  try {
    parsed = stdout.trim().length === 0 ? [] : JSON.parse(stdout);
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.slice(0, MAX_PROCESS_SAMPLES).flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const workingSetBytes = finiteNonnegative(record.workingSetBytes);
    const startedAt = safeIso(record.startedAt);
    if (workingSetBytes === undefined && startedAt === undefined) return [];
    return [{
      ...(workingSetBytes === undefined ? {} : { workingSetBytes }),
      ...(startedAt === undefined ? {} : { startedAt })
    }];
  });
}

function posixElapsedMs(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000;
}

function posixSamples(stdout: string): DoctorProcessSample[] {
  const samples: DoctorProcessSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\d+)\s+([\s\S]+)$/.exec(line);
    if (!match) continue;
    const [, elapsed, rss, command] = match;
    if (elapsed === undefined || rss === undefined || command === undefined
      || !MCP_COMMAND_PATTERN.test(command)) continue;
    const ageMs = posixElapsedMs(elapsed);
    const rssKiB = Number(rss);
    if (ageMs === undefined || !Number.isSafeInteger(rssKiB) || rssKiB < 0) continue;
    samples.push({
      workingSetBytes: Math.min(Number.MAX_SAFE_INTEGER, rssKiB * 1_024),
      ageMs
    });
    if (samples.length >= MAX_PROCESS_SAMPLES) break;
  }
  return samples;
}

/** Inspect AgentFlow MCP processes with fixed argument arrays and return no command text. */
export async function probeAgentFlowMcpProcesses(
  options: DoctorProcessProbeOptions = {}
): Promise<DoctorProcessProbeResult> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? nativeProcessRunner;
  try {
    if (platform === "win32") {
      const result = await runner("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_PROCESS_SCRIPT
      ]);
      return { supported: true, samples: windowsSamples(result.stdout) };
    }
    if (platform === "linux") {
      const result = await runner("ps", ["-eo", "etimes=,rss=,args="]);
      return { supported: true, samples: posixSamples(result.stdout) };
    }
    if (platform === "darwin") {
      const result = await runner("ps", ["-axo", "etime=,rss=,command="]);
      return { supported: true, samples: posixSamples(result.stdout) };
    }
  } catch {
    return { supported: false, samples: [] };
  }
  return { supported: false, samples: [] };
}

function processDiagnostics(
  result: DoctorProcessProbeResult | undefined,
  now: number
): DoctorRuntimeDiagnostics["processes"] {
  if (!result?.supported) {
    return {
      status: "unavailable",
      count: 0,
      workingSetSampleCount: 0,
      staleCandidateCount: 0
    };
  }
  const samples = result.samples.slice(0, MAX_PROCESS_SAMPLES);
  const workingSets = samples.flatMap((sample) => {
    const bytes = finiteNonnegative(sample.workingSetBytes);
    return bytes === undefined ? [] : [bytes];
  });
  const ages = samples.flatMap((sample) => {
    const explicit = finiteNonnegative(sample.ageMs);
    if (explicit !== undefined) return [explicit];
    const startedAt = safeIso(sample.startedAt);
    return startedAt === undefined ? [] : [Math.max(0, now - Date.parse(startedAt))];
  });
  const aggregate = workingSets.reduce((sum, value) => (
    Math.min(Number.MAX_SAFE_INTEGER, sum + value)
  ), 0);
  return {
    status: "available",
    count: samples.length,
    workingSetSampleCount: workingSets.length,
    ...(workingSets.length === 0 ? {} : { aggregateWorkingSetBytes: aggregate }),
    staleCandidateCount: ages.filter((age) => age >= STALE_AGE_MS).length,
    ...(ages.length === 0 ? {} : { oldestAgeMs: Math.max(...ages) })
  };
}

interface RunEntry {
  directoryName: string;
  runHash: string;
  statePath: string;
  stateBytes: number;
}

interface RunDiagnosticsResult {
  runs: DoctorRuntimeDiagnostics["runs"];
  responseBudgets: DoctorRuntimeDiagnostics["responseBudgets"];
  cleanup: DoctorRuntimeDiagnostics["cleanup"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanupDiagnostics(
  state: RunState,
  now: number,
  target: DoctorRuntimeDiagnostics["cleanup"]
): void {
  const live = new Set(["prepared", "starting", "running", "unknown"]);
  for (const worker of Object.values(state.workers)) {
    if (live.has(worker.status)) {
      const updatedAt = Date.parse(worker.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt >= STALE_AGE_MS) {
        target.staleLiveWorkers += 1;
      }
      continue;
    }
    const cleanup = worker.cleanup;
    if (!cleanup) {
      target.pendingWorkers += 1;
      continue;
    }
    const steps = [cleanup.close, cleanup.archive, cleanup.permitRelease];
    if (steps.some((step) => step.status === "pending")) target.pendingWorkers += 1;
    if (steps.some((step) => step.status === "unsupported")) target.unsupportedWorkers += 1;
    if (steps.some((step) => step.status === "failed")) target.failedWorkers += 1;
    if (cleanup.completedAt !== undefined) target.completedWorkers += 1;
  }
}

function addViolation(
  target: DoctorRuntimeDiagnostics["responseBudgets"],
  violation: DoctorRuntimeDiagnostics["responseBudgets"]["violations"][number]
): void {
  target.violationCount += 1;
  if (target.violations.length < MAX_BUDGET_VIOLATIONS) target.violations.push(violation);
  else target.violationOverflow += 1;
}

function projectionDiagnostics(
  state: RunState,
  runHash: string,
  target: DoctorRuntimeDiagnostics["responseBudgets"]
): void {
  const summaryBytes = Buffer.byteLength(JSON.stringify(projectRunSummary(state)), "utf8");
  if (summaryBytes > STATUS_BUDGET_BYTES) {
    addViolation(target, {
      runHash,
      profile: "summary",
      responseBytes: summaryBytes,
      limitBytes: STATUS_BUDGET_BYTES
    });
  }
  const previous = structuredClone(state);
  previous.stages = {};
  previous.tasks = {};
  previous.workers = {};
  previous.artifacts = {};
  previous.gates = {};
  const receiptBytes = Buffer.byteLength(
    JSON.stringify(projectChangeReceipt(previous, state)),
    "utf8"
  );
  if (receiptBytes > MUTATION_BUDGET_BYTES) {
    addViolation(target, {
      runHash,
      profile: "receipt",
      responseBytes: receiptBytes,
      limitBytes: MUTATION_BUDGET_BYTES
    });
  }
}

function recordedResponseDiagnostics(
  state: RunState,
  runHash: string,
  target: DoctorRuntimeDiagnostics["responseBudgets"]
): void {
  for (const event of state.events.slice(-MAX_EVENTS_PER_RUN)) {
    if (!isRecord(event.data)) continue;
    const responseBytes = finiteNonnegative(event.data.responseBytes);
    const rawProfile = event.data.responseProfile;
    const profile = rawProfile === "summary" || rawProfile === "status"
      ? "summary" as const
      : rawProfile === "receipt" || rawProfile === "mutation"
        ? "receipt" as const
        : undefined;
    if (responseBytes === undefined || profile === undefined) continue;
    const limitBytes = profile === "summary" ? STATUS_BUDGET_BYTES : MUTATION_BUDGET_BYTES;
    if (responseBytes > limitBytes) {
      addViolation(target, { runHash, profile, responseBytes, limitBytes });
    }
  }
}

async function runEntries(projectRoot: string): Promise<{ entries: RunEntry[]; overflow: number }> {
  const runsDirectory = join(projectRoot, ".agentflow", "runs");
  let directories;
  try {
    directories = (await readdir(runsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], overflow: 0 };
    throw error;
  }
  const selected = directories.slice(0, MAX_RUN_DIRECTORIES);
  const entries: RunEntry[] = [];
  for (const directory of selected) {
    const statePath = join(runsDirectory, directory.name, "state.json");
    try {
      const stats = await lstat(statePath);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      entries.push({
        directoryName: directory.name,
        runHash: sha256(`run:${directory.name}`).slice(0, 12),
        statePath,
        stateBytes: stats.size
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { entries, overflow: Math.max(0, directories.length - selected.length) };
}

async function inspectRuns(projectRoot: string, now: number): Promise<RunDiagnosticsResult> {
  const { entries, overflow } = await runEntries(projectRoot);
  const sorted = [...entries].sort((left, right) => (
    right.stateBytes - left.stateBytes || left.runHash.localeCompare(right.runHash)
  ));
  const responseBudgets: DoctorRuntimeDiagnostics["responseBudgets"] = {
    statusLimitBytes: STATUS_BUDGET_BYTES,
    mutationLimitBytes: MUTATION_BUDGET_BYTES,
    violationCount: 0,
    violations: [],
    violationOverflow: 0
  };
  const cleanup: DoctorRuntimeDiagnostics["cleanup"] = {
    pendingWorkers: 0,
    unsupportedWorkers: 0,
    failedWorkers: 0,
    completedWorkers: 0,
    staleLiveWorkers: 0
  };
  let parsed = 0;
  let parseFailures = 0;
  let readSkipped = 0;
  let readBytes = 0;
  for (const entry of sorted) {
    if (entry.stateBytes > MAX_STATE_BYTES
      || readBytes + entry.stateBytes > MAX_TOTAL_STATE_READ_BYTES) {
      readSkipped += 1;
      continue;
    }
    try {
      const serialized = await readFile(entry.statePath, "utf8");
      readBytes += entry.stateBytes;
      const state = migrateRunState(JSON.parse(serialized));
      parsed += 1;
      projectionDiagnostics(state, entry.runHash, responseBudgets);
      recordedResponseDiagnostics(state, entry.runHash, responseBudgets);
      cleanupDiagnostics(state, now, cleanup);
    } catch {
      parseFailures += 1;
    }
  }
  return {
    runs: {
      scanned: entries.length,
      scanOverflow: overflow,
      parsed,
      parseFailures,
      readSkipped,
      largest: sorted.slice(0, MAX_LARGEST_RUNS).map((entry) => ({
        runHash: entry.runHash,
        stateBytes: entry.stateBytes
      }))
    },
    responseBudgets,
    cleanup
  };
}

async function defaultSchedulerProbe(
  agentflowHome: string,
  host: HostClient | undefined
): Promise<RuntimeSchedulerSnapshot | undefined> {
  if (host === undefined) return undefined;
  const adapter = await import("@agentflow/host-adapter");
  if (typeof adapter.schedulerBudgetKey !== "function"
    || typeof adapter.HostBudgetCoordinator !== "function") return undefined;
  const budgetKey = adapter.schedulerBudgetKey({ host });
  const statePath = join(agentflowHome, "scheduler", budgetKey, "state.json");
  try {
    const stats = await lstat(statePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        capacity: 1,
        activePermitCount: 0,
        expiredPermitCount: 0,
        circuit: { state: "closed", cooldownRemainingMs: 0 }
      };
    }
    throw error;
  }
  const diagnostics = await new adapter.HostBudgetCoordinator({
    homeDirectory: agentflowHome,
    host
  }).diagnostics();
  return {
    capacity: diagnostics.capacity,
    activePermitCount: diagnostics.activePermitCount,
    expiredPermitCount: diagnostics.expiredPermitCount,
    circuit: {
      state: diagnostics.circuit.state,
      cooldownRemainingMs: diagnostics.circuit.cooldownRemainingMs,
      ...(diagnostics.circuit.retryAt === undefined
        ? {}
        : { retryAt: diagnostics.circuit.retryAt })
    }
  };
}

function schedulerDiagnostics(
  snapshot: RuntimeSchedulerSnapshot | undefined
): DoctorRuntimeDiagnostics["scheduler"] {
  if (snapshot === undefined) return { status: "unavailable" };
  const retryAt = safeIso(snapshot.circuit.retryAt);
  return {
    status: "available",
    capacity: Math.max(0, Math.round(snapshot.capacity)),
    activePermitCount: Math.max(0, Math.round(snapshot.activePermitCount)),
    expiredPermitCount: Math.max(0, Math.round(snapshot.expiredPermitCount)),
    cooldownState: snapshot.circuit.state,
    cooldownRemainingMs: Math.max(0, Math.round(snapshot.circuit.cooldownRemainingMs)),
    ...(retryAt === undefined ? {} : { retryAt })
  };
}

function adapterDiagnostics(
  host: HostClient | undefined,
  snapshot: NativeCapabilitySnapshot | undefined
): DoctorRuntimeDiagnostics["nativeAdapter"] {
  if (snapshot === undefined) {
    return { liveProbeProvided: false, ...(host === undefined ? {} : { host }) };
  }
  if (!isNativeCapabilitySnapshot(snapshot) || (host !== undefined && snapshot.host !== host)) {
    return {
      liveProbeProvided: true,
      ...(host === undefined ? {} : { host }),
      invalid: true
    };
  }
  const value = snapshot;
  const freshContextAttested = value.contextPolicy.mode === "fresh-attested";
  const toolAllowlistEnforced = value.toolProfile.mode === "allowlist"
    && value.toolProfile.enforced
    && value.toolProfile.tools.length > 0;
  const agentflowMcpDisabled = !value.toolProfile.agentflowMcpEnabled
    && value.toolProfile.tools.every((tool) => !/agentflow/i.test(tool));
  const requiredOperations = ["spawnFresh", "send", "status", "waitAny", "collect", "interrupt", "close"] as const;
  const actuallyConforming = freshContextAttested
    && toolAllowlistEnforced
    && agentflowMcpDisabled
    && requiredOperations.every((operation) => value.operations[operation] === "supported");
  const declarationIsCoherent = value.conformance === (actuallyConforming ? "conforming" : "non-conforming")
    && (actuallyConforming
      ? value.fallback === "none" && value.reasons.length === 0
      : value.fallback !== "none" && value.reasons.length > 0);
  if (!declarationIsCoherent) {
    return { liveProbeProvided: true, host: value.host, invalid: true };
  }
  return {
    liveProbeProvided: true,
    host: value.host,
    adapterVersion: value.adapterVersion,
    conformance: value.conformance,
    fallback: value.fallback,
    freshContextAttested,
    toolAllowlistEnforced,
    agentflowMcpDisabled,
    reasonCount: value.reasons.length
  };
}

function isNativeCapabilitySnapshot(value: unknown): value is NativeCapabilitySnapshot {
  if (!isRecord(value)) return false;
  if (value.version !== 2 || value.sourceVersion !== 1 && value.sourceVersion !== 2) return false;
  if (!(["codex", "cursor", "vscode"] as unknown[]).includes(value.host)) return false;
  if (typeof value.adapterVersion !== "string" || value.adapterVersion.length === 0
    || value.adapterVersion.length > 64) return false;
  if (value.conformance !== "conforming" && value.conformance !== "non-conforming") return false;
  if (!(["none", "inline", "serial"] as unknown[]).includes(value.fallback)) return false;
  const contextPolicy = recordValue(value.contextPolicy);
  const toolProfile = recordValue(value.toolProfile);
  const operations = recordValue(value.operations);
  if (!contextPolicy || !toolProfile || !operations) return false;
  if (contextPolicy.mode !== "unknown" && contextPolicy.mode !== "fresh-attested") return false;
  if (typeof contextPolicy.inheritedTurnCountObservable !== "boolean") return false;
  if (toolProfile.mode !== "unknown" && toolProfile.mode !== "allowlist") return false;
  if (typeof toolProfile.enforced !== "boolean" || typeof toolProfile.agentflowMcpEnabled !== "boolean") {
    return false;
  }
  if (!Array.isArray(toolProfile.tools) || toolProfile.tools.length > 128
    || !toolProfile.tools.every((tool) => typeof tool === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(tool))) return false;
  const operationNames = [
    "spawnFresh", "bind", "send", "status", "waitAny", "collect", "interrupt", "close", "archive"
  ];
  const support = new Set(["supported", "unsupported", "temporarily-unavailable"]);
  if (Object.keys(operations).length !== operationNames.length
    || !operationNames.every((name) => support.has(operations[name] as string))) return false;
  return Array.isArray(value.reasons) && value.reasons.length <= 20
    && value.reasons.every((reason) => typeof reason === "string" && reason.length > 0 && reason.length <= 500);
}

/** Read one small host-produced capability snapshot without retaining invalid content. */
export async function readNativeCapabilitySnapshotFile(
  path: string
): Promise<NativeCapabilitySnapshot> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 65_536) throw new Error("invalid");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isNativeCapabilitySnapshot(parsed)) throw new Error("invalid");
    return structuredClone(parsed);
  } catch {
    throw new AgentFlowError(
      "Native adapter capability snapshot is missing, invalid, linked, or oversized",
      "NATIVE_CAPABILITY_SNAPSHOT_INVALID"
    );
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Collect one bounded, redacted diagnostic snapshot for doctor output. */
export async function collectDoctorRuntimeDiagnostics(
  options: DoctorRuntimeOptions
): Promise<DoctorRuntimeDiagnostics> {
  const now = options.now?.() ?? Date.now();
  const processProbe = options.dependencies?.processProbe
    ?? (() => probeAgentFlowMcpProcesses());
  const schedulerProbe = options.dependencies?.schedulerProbe
    ?? (() => defaultSchedulerProbe(options.agentflowHome, options.host));
  const [processResult, schedulerResult, runResult] = await Promise.all([
    processProbe().catch(() => undefined),
    schedulerProbe().catch(() => undefined),
    inspectRuns(options.projectRoot, now).catch((): RunDiagnosticsResult => ({
      runs: {
        scanned: 0,
        scanOverflow: 0,
        parsed: 0,
        parseFailures: 0,
        readSkipped: 0,
        largest: []
      },
      responseBudgets: {
        statusLimitBytes: STATUS_BUDGET_BYTES,
        mutationLimitBytes: MUTATION_BUDGET_BYTES,
        violationCount: 0,
        violations: [],
        violationOverflow: 0
      },
      cleanup: {
        pendingWorkers: 0,
        unsupportedWorkers: 0,
        failedWorkers: 0,
        completedWorkers: 0,
        staleLiveWorkers: 0
      }
    }))
  ]);
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    processes: processDiagnostics(processResult, now),
    runs: runResult.runs,
    responseBudgets: runResult.responseBudgets,
    cleanup: runResult.cleanup,
    scheduler: schedulerDiagnostics(schedulerResult),
    nativeAdapter: adapterDiagnostics(options.host, options.nativeCapabilitySnapshot)
  };
}
