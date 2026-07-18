import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

export interface ProcessInvocation {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ProcessExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessExecution>;
}

export type OperationTimingName =
  | "authentication"
  | "command"
  | "orchestration"
  | "readback"
  | "total"
  | "transport";

export interface DeterministicOperationReceipt {
  schemaVersion: 1;
  operationId: string;
  kind: string;
  outcome: "blocked" | "completed" | "failed" | "waiting";
  code: string;
  summary: string;
  modelWorkersDispatched: 0;
  evidence: Record<string, unknown>;
  timingsMs: Record<OperationTimingName, number>;
  metrics: Array<{
    name: string;
    unit: "ms";
    value: number;
  }>;
  nextAction?: {
    kind: "authenticate" | "provide-input" | "resolve-approval";
    operationId: string;
  };
}

export interface DeterministicOperationRunnerOptions {
  processRunner?: ProcessRunner;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  processTimeoutMs?: number;
  verificationCommands?: Record<string, VerificationCommandSpec>;
}

export interface VerificationCommandSpec {
  program: string;
  args: string[];
  timeoutMs?: number;
}

type Phase = "command" | "transport" | "readback";

interface MutableTimings {
  command: number;
  transport: number;
  authentication: number;
  readback: number;
}

const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERIFICATION_PROGRAMS = new Set([
  "cargo",
  "dotnet",
  "go",
  "npm",
  "npm.cmd",
  "npx",
  "npx.cmd",
  "tsc",
  "tsc.cmd",
  "vitest",
  "vitest.cmd"
]);
const DENIED_KINDS = new Set([
  "git-force",
  "git-delete-ref",
  "history-rewrite",
  "file-change",
  "release",
  "publication",
  "deployment",
  "migration"
]);
const DENIED_FIELDS = new Set([
  "delete",
  "deploy",
  "fileChanges",
  "force",
  "migrate",
  "publish",
  "release",
  "rewrite"
]);
const ALLOWED_FIELDS: Record<string, Set<string>> = {
  "git-sync": new Set([
    "kind",
    "operationId",
    "repositoryRoot",
    "intent",
    "expectedRevision",
    "remoteName",
    "expectedRemoteUrl",
    "branch",
    "authenticationWaitMs"
  ]),
  verification: new Set(["kind", "operationId", "repositoryRoot", "checks", "verificationId"]),
  readback: new Set([
    "kind",
    "operationId",
    "repositoryRoot",
    "remoteName",
    "expectedRemoteUrl",
    "remoteRef",
    "expectedRevision",
    "authenticationWaitMs"
  ]),
  timer: new Set(["kind", "operationId", "durationMs"]),
  "interactive-wait": new Set(["kind", "operationId", "waitReason"])
};

function emptyTimings(): MutableTimings {
  return { command: 0, transport: 0, authentication: 0, readback: 0 };
}

function finiteMilliseconds(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 4_096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function safeRevision(value: unknown): string | undefined {
  const revision = boundedString(value, 64);
  return revision !== undefined && SHA_PATTERN.test(revision) ? revision : undefined;
}

function observedAuthenticationWait(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 86_400_000
    ? value as number
    : undefined;
}

function safeBranch(value: unknown): string | undefined {
  const branch = boundedString(value, 256);
  if (branch === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    || branch.includes("..")
    || branch.includes("@{")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.endsWith(".lock")) {
    return undefined;
  }
  return branch;
}

function safeRemoteRef(value: unknown): string | undefined {
  const remoteRef = boundedString(value, 512);
  if (remoteRef === undefined) return undefined;
  const match = /^refs\/(?:heads|tags)\/(.+)$/.exec(remoteRef);
  return match !== null && safeBranch(match[1]) !== undefined ? remoteRef : undefined;
}

function safeRemoteUrl(value: unknown): string | undefined {
  const remoteUrl = boundedString(value, 2_048);
  if (remoteUrl === undefined || /[\r\n]/.test(remoteUrl)) return undefined;
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(remoteUrl)) return remoteUrl;
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return undefined;
  }
  const safeSshUser = parsed.protocol === "ssh:" && parsed.username === "git";
  if ((parsed.protocol !== "https:" && !safeSshUser)
    || (parsed.username.length > 0 && !safeSshUser)
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0) {
    return undefined;
  }
  return remoteUrl;
}

function remoteFingerprint(remoteUrl: string): string {
  return createHash("sha256").update(remoteUrl).digest("hex");
}

function parseRemoteRevision(stdout: string, remoteRef: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const [revision, ref] = line.trim().split(/\s+/, 2);
    if (ref === remoteRef && SHA_PATTERN.test(revision ?? "")) return revision;
  }
  return undefined;
}

function authenticationFailure(execution: ProcessExecution): boolean {
  const text = `${execution.stderr}\n${execution.stdout}`;
  return /authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|credential.*(?:missing|required)/i.test(text);
}

function deniedRequest(request: Record<string, unknown>): boolean {
  if (typeof request.kind === "string" && DENIED_KINDS.has(request.kind)) return true;
  return Object.entries(request).some(([key, value]) => (
    DENIED_FIELDS.has(key) && value !== false && value !== undefined && value !== null
  ));
}

function safeVerificationCommand(spec: VerificationCommandSpec): boolean {
  if (!VERIFICATION_PROGRAMS.has(spec.program)
    || !Array.isArray(spec.args) || spec.args.length === 0 || spec.args.length > 64
    || spec.args.some((argument) => (
      typeof argument !== "string" || argument.length === 0 || argument.length > 1_024 || /[\0\r\n]/.test(argument)
    ))
    || (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs)
      || spec.timeoutMs < 1 || spec.timeoutMs > 300_000))) {
    return false;
  }
  const args = spec.args.map((argument) => argument.toLowerCase());
  if (args.some((argument) => /^(?:--force(?:=.*)?|-f|-u|--update(?:=.*)?|--update-snapshot(?:=.*)?|--write(?:=.*)?|publish|deploy|release|migrate|install|ci|add|remove|update|exec)$/.test(argument))) {
    return false;
  }
  if (spec.program === "npm" || spec.program === "npm.cmd") {
    return args[0] === "test"
      || (args[0] === "run" && /^(?:test|typecheck|lint|check|verify)(?::[a-z0-9._-]+)?$/.test(args[1] ?? ""));
  }
  if (spec.program === "npx" || spec.program === "npx.cmd") {
    return args[0] === "vitest" || args[0] === "tsc";
  }
  if (spec.program === "cargo") return args[0] === "test" || args[0] === "check";
  if (spec.program === "go") return args[0] === "test";
  if (spec.program === "dotnet") return args[0] === "test";
  return spec.program.startsWith("vitest") || spec.program.startsWith("tsc");
}

function verificationCommandMap(
  commands: Record<string, VerificationCommandSpec> | undefined,
  defaultTimeoutMs: number
): Map<string, Required<VerificationCommandSpec>> {
  const result = new Map<string, Required<VerificationCommandSpec>>();
  for (const [id, spec] of Object.entries(commands ?? {})) {
    if (!OPERATION_ID_PATTERN.test(id) || !safeVerificationCommand(spec)) {
      throw new Error(`Verification ${id} is not a safe verification command`);
    }
    result.set(id, {
      program: spec.program,
      args: [...spec.args],
      timeoutMs: spec.timeoutMs ?? defaultTimeoutMs
    });
  }
  return result;
}

function nativeProcessRunner(now: () => number): ProcessRunner {
  return {
    run: async (invocation) => new Promise((resolveExecution) => {
      const startedAt = now();
      execFile(invocation.program, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        timeout: invocation.timeoutMs,
        maxBuffer: 64 * 1_024,
        windowsHide: true,
        encoding: "utf8"
      }, (error, stdout, stderr) => {
        const processError = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number } | null;
        const numericExitCode = typeof processError?.code === "number" ? processError.code : 1;
        resolveExecution({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode: error === null ? 0 : numericExitCode,
          durationMs: finiteMilliseconds(now() - startedAt),
          ...(processError?.killed === true || processError?.code === "ETIMEDOUT" ? { timedOut: true } : {})
        });
      });
    })
  };
}

export class DeterministicOperationRunner {
  private readonly now: () => number;
  private readonly processRunner: ProcessRunner;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly processTimeoutMs: number;
  private readonly verificationCommands: Map<string, Required<VerificationCommandSpec>>;

  constructor(options: DeterministicOperationRunnerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.processRunner = options.processRunner ?? nativeProcessRunner(this.now);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
      setTimeout(resolveSleep, milliseconds);
    }));
    this.processTimeoutMs = options.processTimeoutMs ?? 120_000;
    this.verificationCommands = verificationCommandMap(
      options.verificationCommands,
      this.processTimeoutMs
    );
  }

  async run(input: unknown): Promise<DeterministicOperationReceipt> {
    const startedAt = this.now();
    const timings = emptyTimings();
    const request = isRecord(input) ? input : {};
    const kind = typeof request.kind === "string" ? request.kind : "invalid";
    const operationId = typeof request.operationId === "string"
      && OPERATION_ID_PATTERN.test(request.operationId)
      ? request.operationId
      : "invalid-operation";

    if (deniedRequest(request)) {
      return this.finish(startedAt, timings, operationId, kind, "blocked", "OPERATION_DENIED",
        "The requested operation is not allowed on the deterministic fast path.");
    }
    const allowedFields = ALLOWED_FIELDS[kind];
    if (allowedFields === undefined || operationId === "invalid-operation"
      || Object.keys(request).some((field) => !allowedFields.has(field))) {
      return this.finish(startedAt, timings, operationId, kind, "blocked", "OPERATION_INVALID",
        "The deterministic operation request is invalid or outside its typed allowlist.");
    }

    switch (kind) {
      case "git-sync": return this.runGitSync(request, startedAt, timings, operationId);
      case "verification": return this.runVerification(request, startedAt, timings, operationId);
      case "readback": return this.runReadback(request, startedAt, timings, operationId);
      case "timer": return this.runTimer(request, startedAt, timings, operationId);
      case "interactive-wait": return this.runInteractiveWait(request, startedAt, timings, operationId);
      default:
        return this.finish(startedAt, timings, operationId, kind, "blocked", "OPERATION_INVALID",
          "The deterministic operation request is invalid.");
    }
  }

  private async executeProcess(
    program: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    phase: Phase,
    timings: MutableTimings
  ): Promise<ProcessExecution> {
    let execution: ProcessExecution;
    try {
      execution = await this.processRunner.run({
        program,
        args,
        cwd: resolve(cwd),
        env,
        timeoutMs
      });
    } catch {
      execution = { stdout: "", stderr: "", exitCode: 1, durationMs: 0 };
    }
    timings[phase] += finiteMilliseconds(execution.durationMs);
    return execution;
  }

  private executeGit(
    repositoryRoot: string,
    args: string[],
    phase: Phase,
    timings: MutableTimings
  ): Promise<ProcessExecution> {
    return this.executeProcess("git", args, repositoryRoot, {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    }, this.processTimeoutMs, phase, timings);
  }

  private async runGitSync(
    request: Record<string, unknown>,
    startedAt: number,
    timings: MutableTimings,
    operationId: string
  ): Promise<DeterministicOperationReceipt> {
    const repositoryRoot = boundedString(request.repositoryRoot);
    const expectedRevision = safeRevision(request.expectedRevision);
    const remoteName = boundedString(request.remoteName, 128);
    const expectedRemoteUrl = safeRemoteUrl(request.expectedRemoteUrl);
    const branch = safeBranch(request.branch);
    const authenticationWaitMs = observedAuthenticationWait(request.authenticationWaitMs);
    if (repositoryRoot === undefined || request.intent !== "push-existing-commit"
      || expectedRevision === undefined || remoteName === undefined
      || !REMOTE_NAME_PATTERN.test(remoteName) || expectedRemoteUrl === undefined
      || branch === undefined || authenticationWaitMs === undefined) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "OPERATION_INVALID",
        "The safe Git synchronization request is incomplete or invalid.");
    }
    timings.authentication = authenticationWaitMs;
    const remoteRef = `refs/heads/${branch}`;

    const status = await this.executeGit(repositoryRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"], "command", timings);
    if (status.exitCode !== 0) return this.processFailure(startedAt, timings, operationId, "git-sync", status);
    if (status.stdout.trim().length > 0) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_WORKTREE_DIRTY",
        "The repository contains uncommitted or untracked changes.");
    }

    const head = await this.executeGit(repositoryRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"], "command", timings);
    if (head.exitCode !== 0) return this.processFailure(startedAt, timings, operationId, "git-sync", head);
    if (head.stdout.trim() !== expectedRevision) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_REVISION_MISMATCH",
        "The repository HEAD does not match the requested immutable revision.");
    }

    const currentBranch = await this.executeGit(repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "HEAD"], "command", timings);
    if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== branch) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_BRANCH_MISMATCH",
        "The checked out branch does not match the requested branch.");
    }

    const remoteUrl = await this.executeGit(repositoryRoot,
      ["remote", "get-url", "--push", remoteName], "command", timings);
    if (remoteUrl.exitCode !== 0) return this.processFailure(startedAt, timings, operationId, "git-sync", remoteUrl);
    const actualRemoteUrl = safeRemoteUrl(remoteUrl.stdout.trim());
    if (actualRemoteUrl === undefined || actualRemoteUrl !== expectedRemoteUrl) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_REMOTE_MISMATCH",
        "The configured push remote does not match the reviewed remote identity.");
    }

    const remoteBefore = await this.executeGit(repositoryRoot,
      ["ls-remote", "--exit-code", "--refs", remoteName, remoteRef], "transport", timings);
    if (remoteBefore.exitCode !== 0) {
      if (authenticationFailure(remoteBefore)) return this.authenticationWait(startedAt, timings, operationId, "git-sync");
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_REMOTE_REF_UNAVAILABLE",
        "The existing remote branch could not be read safely.");
    }
    const previousRemoteRevision = parseRemoteRevision(remoteBefore.stdout, remoteRef);
    if (previousRemoteRevision === undefined) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_REMOTE_REF_UNAVAILABLE",
        "The existing remote branch did not return an immutable revision.");
    }

    const ancestor = await this.executeGit(repositoryRoot,
      ["merge-base", "--is-ancestor", previousRemoteRevision, expectedRevision], "command", timings);
    if (ancestor.exitCode !== 0) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_NOT_FAST_FORWARD",
        "The requested revision is not a fast-forward of the remote branch.");
    }

    const push = await this.executeGit(repositoryRoot,
      ["push", "--porcelain", remoteName, `${expectedRevision}:${remoteRef}`], "transport", timings);
    if (push.exitCode !== 0) {
      if (authenticationFailure(push)) return this.authenticationWait(startedAt, timings, operationId, "git-sync");
      return this.finish(startedAt, timings, operationId, "git-sync", "failed", "GIT_PUSH_FAILED",
        "Git rejected the safe existing-commit push.");
    }

    const readback = await this.executeGit(repositoryRoot,
      ["ls-remote", "--exit-code", "--refs", remoteName, remoteRef], "readback", timings);
    if (readback.exitCode !== 0) {
      if (authenticationFailure(readback)) return this.authenticationWait(startedAt, timings, operationId, "git-sync");
      return this.finish(startedAt, timings, operationId, "git-sync", "failed", "GIT_READBACK_FAILED",
        "The remote revision could not be read back after transport.");
    }
    const remoteRevision = parseRemoteRevision(readback.stdout, remoteRef);
    if (remoteRevision !== expectedRevision) {
      return this.finish(startedAt, timings, operationId, "git-sync", "blocked", "GIT_READBACK_MISMATCH",
        "The immutable remote readback does not match the pushed revision.");
    }

    return this.finish(startedAt, timings, operationId, "git-sync", "completed", "GIT_SYNC_COMPLETED",
      "The existing commit was synchronized and verified by immutable remote readback.", {
        localRevision: expectedRevision,
        previousRemoteRevision,
        remoteRevision,
        remoteName,
        remoteFingerprint: remoteFingerprint(expectedRemoteUrl),
        branch
      });
  }

  private async runVerification(
    request: Record<string, unknown>,
    startedAt: number,
    timings: MutableTimings,
    operationId: string
  ): Promise<DeterministicOperationReceipt> {
    const repositoryRoot = boundedString(request.repositoryRoot);
    const verificationId = request.verificationId === undefined
      ? undefined
      : boundedString(request.verificationId, 160);
    if (repositoryRoot === undefined) {
      return this.finish(startedAt, timings, operationId, "verification", "blocked", "OPERATION_INVALID",
        "The deterministic verification request is invalid.");
    }
    if (verificationId !== undefined) {
      if (request.checks !== undefined || !OPERATION_ID_PATTERN.test(verificationId)) {
        return this.finish(startedAt, timings, operationId, "verification", "blocked", "OPERATION_INVALID",
          "The registered verification request is invalid.");
      }
      const command = this.verificationCommands.get(verificationId);
      if (command === undefined) {
        return this.finish(startedAt, timings, operationId, "verification", "blocked",
          "VERIFICATION_NOT_ALLOWLISTED", "The requested verification command is not registered by the host.");
      }
      const execution = await this.executeProcess(
        command.program,
        command.args,
        repositoryRoot,
        { CI: "1" },
        command.timeoutMs,
        "command",
        timings
      );
      if (execution.exitCode !== 0) {
        return this.finish(startedAt, timings, operationId, "verification", "failed",
          execution.timedOut === true ? "PROCESS_TIMEOUT" : "VERIFICATION_FAILED",
          execution.timedOut === true
            ? "The registered verification command timed out."
            : "The registered verification command failed without exposing raw output.",
          { verificationId, status: "failed" });
      }
      return this.finish(startedAt, timings, operationId, "verification", "completed",
        "VERIFICATION_COMPLETED", "The registered deterministic verification command passed.", {
          verificationId,
          status: "passed"
        });
    }
    if (request.verificationId !== undefined || !Array.isArray(request.checks)
      || request.checks.length === 0 || request.checks.length > 16) {
      return this.finish(startedAt, timings, operationId, "verification", "blocked", "OPERATION_INVALID",
        "The deterministic verification request is invalid.");
    }
    const evidence: Array<Record<string, unknown>> = [];
    for (const rawCheck of request.checks) {
      if (!isRecord(rawCheck) || typeof rawCheck.kind !== "string") {
        return this.finish(startedAt, timings, operationId, "verification", "blocked", "OPERATION_INVALID",
          "The deterministic verification check is invalid.");
      }
      if (rawCheck.kind === "git-clean" && Object.keys(rawCheck).length === 1) {
        const status = await this.executeGit(repositoryRoot,
          ["status", "--porcelain=v1", "--untracked-files=all"], "command", timings);
        if (status.exitCode !== 0) return this.processFailure(startedAt, timings, operationId, "verification", status);
        if (status.stdout.trim().length > 0) {
          return this.finish(startedAt, timings, operationId, "verification", "blocked", "VERIFICATION_FAILED",
            "The repository cleanliness verification failed.", { checks: [...evidence, { kind: "git-clean", status: "failed" }] });
        }
        evidence.push({ kind: "git-clean", status: "passed" });
        continue;
      }
      if (rawCheck.kind === "git-revision" && Object.keys(rawCheck).length === 2) {
        const expectedRevision = safeRevision(rawCheck.expectedRevision);
        if (expectedRevision === undefined) {
          return this.finish(startedAt, timings, operationId, "verification", "blocked", "OPERATION_INVALID",
            "The Git revision verification is invalid.");
        }
        const head = await this.executeGit(repositoryRoot,
          ["rev-parse", "--verify", "HEAD^{commit}"], "command", timings);
        if (head.exitCode !== 0) return this.processFailure(startedAt, timings, operationId, "verification", head);
        if (head.stdout.trim() !== expectedRevision) {
          return this.finish(startedAt, timings, operationId, "verification", "blocked", "VERIFICATION_FAILED",
            "The immutable revision verification failed.", {
              checks: [...evidence, { kind: "git-revision", status: "failed" }]
            });
        }
        evidence.push({ kind: "git-revision", status: "passed", revision: expectedRevision });
        continue;
      }
      return this.finish(startedAt, timings, operationId, "verification", "blocked", "OPERATION_INVALID",
        "Only allowlisted read-only verification checks are supported.");
    }
    return this.finish(startedAt, timings, operationId, "verification", "completed", "VERIFICATION_COMPLETED",
      "All deterministic verification checks passed.", { checks: evidence });
  }

  private async runReadback(
    request: Record<string, unknown>,
    startedAt: number,
    timings: MutableTimings,
    operationId: string
  ): Promise<DeterministicOperationReceipt> {
    const repositoryRoot = boundedString(request.repositoryRoot);
    const remoteName = boundedString(request.remoteName, 128);
    const expectedRemoteUrl = safeRemoteUrl(request.expectedRemoteUrl);
    const remoteRef = safeRemoteRef(request.remoteRef);
    const expectedRevision = request.expectedRevision === undefined
      ? undefined
      : safeRevision(request.expectedRevision);
    const authenticationWaitMs = observedAuthenticationWait(request.authenticationWaitMs);
    if (repositoryRoot === undefined || remoteName === undefined || !REMOTE_NAME_PATTERN.test(remoteName)
      || expectedRemoteUrl === undefined || remoteRef === undefined
      || (request.expectedRevision !== undefined && expectedRevision === undefined)
      || authenticationWaitMs === undefined) {
      return this.finish(startedAt, timings, operationId, "readback", "blocked", "OPERATION_INVALID",
        "The deterministic readback request is invalid.");
    }
    timings.authentication = authenticationWaitMs;
    const remoteUrl = await this.executeGit(repositoryRoot,
      ["remote", "get-url", "--push", remoteName], "command", timings);
    if (remoteUrl.exitCode !== 0) return this.processFailure(startedAt, timings, operationId, "readback", remoteUrl);
    if (safeRemoteUrl(remoteUrl.stdout.trim()) !== expectedRemoteUrl) {
      return this.finish(startedAt, timings, operationId, "readback", "blocked", "GIT_REMOTE_MISMATCH",
        "The readback remote does not match the reviewed remote identity.");
    }
    const readback = await this.executeGit(repositoryRoot,
      ["ls-remote", "--exit-code", "--refs", remoteName, remoteRef], "readback", timings);
    if (readback.exitCode !== 0) {
      if (authenticationFailure(readback)) return this.authenticationWait(startedAt, timings, operationId, "readback");
      return this.finish(startedAt, timings, operationId, "readback", "failed", "GIT_READBACK_FAILED",
        "The requested immutable remote ref could not be read.");
    }
    const remoteRevision = parseRemoteRevision(readback.stdout, remoteRef);
    if (remoteRevision === undefined || (expectedRevision !== undefined && remoteRevision !== expectedRevision)) {
      return this.finish(startedAt, timings, operationId, "readback", "blocked", "GIT_READBACK_MISMATCH",
        "The immutable remote readback did not match the expected revision.");
    }
    return this.finish(startedAt, timings, operationId, "readback", "completed", "READBACK_COMPLETED",
      "The immutable remote revision was read successfully.", {
        remoteName,
        remoteRef,
        remoteRevision,
        remoteFingerprint: remoteFingerprint(expectedRemoteUrl)
      });
  }

  private async runTimer(
    request: Record<string, unknown>,
    startedAt: number,
    timings: MutableTimings,
    operationId: string
  ): Promise<DeterministicOperationReceipt> {
    if (!Number.isInteger(request.durationMs) || (request.durationMs as number) < 1
      || (request.durationMs as number) > 300_000) {
      return this.finish(startedAt, timings, operationId, "timer", "blocked", "OPERATION_INVALID",
        "The host timer duration must be between 1 and 300000 milliseconds.");
    }
    const durationMs = request.durationMs as number;
    await this.sleep(durationMs);
    timings.command += durationMs;
    return this.finish(startedAt, timings, operationId, "timer", "completed", "TIMER_COMPLETED",
      "The bounded host-side timer completed without model polling.", { durationMs });
  }

  private runInteractiveWait(
    request: Record<string, unknown>,
    startedAt: number,
    timings: MutableTimings,
    operationId: string
  ): DeterministicOperationReceipt {
    const reason = request.waitReason;
    if (reason !== "authentication" && reason !== "user-input" && reason !== "approval") {
      return this.finish(startedAt, timings, operationId, "interactive-wait", "blocked", "OPERATION_INVALID",
        "The interactive wait reason is invalid.");
    }
    const nextKind = reason === "authentication"
      ? "authenticate"
      : reason === "approval" ? "resolve-approval" : "provide-input";
    return this.finish(startedAt, timings, operationId, "interactive-wait", "waiting", "INTERACTIVE_WAIT",
      "The host operation is waiting for one explicit interactive action.", { waitReason: reason }, {
        kind: nextKind,
        operationId
      });
  }

  private authenticationWait(
    startedAt: number,
    timings: MutableTimings,
    operationId: string,
    kind: string
  ): DeterministicOperationReceipt {
    return this.finish(startedAt, timings, operationId, kind, "waiting", "GIT_AUTHENTICATION_REQUIRED",
      "Git authentication is required before this deterministic operation can continue.", {}, {
        kind: "authenticate",
        operationId
      });
  }

  private processFailure(
    startedAt: number,
    timings: MutableTimings,
    operationId: string,
    kind: string,
    execution: ProcessExecution
  ): DeterministicOperationReceipt {
    if (authenticationFailure(execution)) return this.authenticationWait(startedAt, timings, operationId, kind);
    return this.finish(startedAt, timings, operationId, kind, "failed",
      execution.timedOut === true ? "PROCESS_TIMEOUT" : "PROCESS_FAILED",
      execution.timedOut === true
        ? "A bounded deterministic process timed out."
        : "A deterministic process failed without exposing raw command output.");
  }

  private finish(
    startedAt: number,
    timings: MutableTimings,
    operationId: string,
    kind: string,
    outcome: DeterministicOperationReceipt["outcome"],
    code: string,
    summary: string,
    evidence: Record<string, unknown> = {},
    nextAction?: DeterministicOperationReceipt["nextAction"]
  ): DeterministicOperationReceipt {
    const measured = finiteMilliseconds(this.now() - startedAt);
    const accounted = timings.command + timings.transport + timings.authentication + timings.readback;
    const total = Math.max(measured, accounted);
    const timingRecord: Record<OperationTimingName, number> = {
      authentication: timings.authentication,
      command: timings.command,
      orchestration: Math.max(0, total - accounted),
      readback: timings.readback,
      total,
      transport: timings.transport
    };
    return {
      schemaVersion: 1,
      operationId,
      kind,
      outcome,
      code,
      summary,
      modelWorkersDispatched: 0,
      evidence,
      timingsMs: timingRecord,
      metrics: (Object.keys(timingRecord) as OperationTimingName[]).map((name) => ({
        name: `deterministic_operation.${name}.duration`,
        unit: "ms",
        value: timingRecord[name]
      })),
      ...(nextAction === undefined ? {} : { nextAction })
    };
  }
}

export function operationDurationP95(
  receipts: DeterministicOperationReceipt[],
  timing: OperationTimingName
): number {
  if (receipts.length === 0) return 0;
  const values = receipts.map((receipt) => finiteMilliseconds(receipt.timingsMs[timing]))
    .sort((left, right) => left - right);
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
}
