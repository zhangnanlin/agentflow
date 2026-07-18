import { describe, expect, it } from "vitest";
import {
  DeterministicOperationRunner,
  type ProcessExecution,
  type ProcessInvocation,
  type ProcessRunner
} from "../src/deterministic-operations.js";

const localRevision = "b".repeat(40);
const remoteRevision = "a".repeat(40);

class ScriptedProcessRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];

  constructor(private readonly executions: ProcessExecution[]) {}

  async run(invocation: ProcessInvocation): Promise<ProcessExecution> {
    this.invocations.push(invocation);
    const execution = this.executions.shift();
    if (execution === undefined) throw new Error("Unexpected process invocation");
    return execution;
  }
}

function execution(
  stdout = "",
  durationMs = 1,
  exitCode = 0,
  stderr = ""
): ProcessExecution {
  return { stdout, stderr, exitCode, durationMs };
}

function gitSyncRequest() {
  return {
    kind: "git-sync" as const,
    operationId: "sync-existing-main",
    repositoryRoot: "C:/work/repository",
    intent: "push-existing-commit" as const,
    expectedRevision: localRevision,
    remoteName: "origin",
    expectedRemoteUrl: "https://example.test/team/repository.git",
    branch: "main"
  };
}

describe("safe existing-commit Git synchronization", () => {
  it("checks every invariant, pushes an explicit revision, and verifies immutable readback", async () => {
    const processRunner = new ScriptedProcessRunner([
      execution("", 2),
      execution(`${localRevision}\n`, 2),
      execution("main\n", 2),
      execution("https://example.test/team/repository.git\n", 2),
      execution(`${remoteRevision}\trefs/heads/main\n`, 20),
      execution("", 2),
      execution("To example.test\n", 30),
      execution(`${localRevision}\trefs/heads/main\n`, 25)
    ]);
    const runner = new DeterministicOperationRunner({
      processRunner,
      now: (() => {
        const values = [0, 90];
        return () => values.shift() ?? 90;
      })()
    });

    const receipt = await runner.run(gitSyncRequest());

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      operationId: "sync-existing-main",
      kind: "git-sync",
      outcome: "completed",
      modelWorkersDispatched: 0,
      evidence: {
        localRevision,
        previousRemoteRevision: remoteRevision,
        remoteRevision: localRevision,
        remoteName: "origin",
        branch: "main"
      },
      timingsMs: {
        total: 90,
        orchestration: 5,
        command: 10,
        transport: 50,
        authentication: 0,
        readback: 25
      }
    });
    expect(receipt.metrics.map((metric) => metric.name)).toEqual([
      "deterministic_operation.authentication.duration",
      "deterministic_operation.command.duration",
      "deterministic_operation.orchestration.duration",
      "deterministic_operation.readback.duration",
      "deterministic_operation.total.duration",
      "deterministic_operation.transport.duration"
    ]);
    expect(Buffer.byteLength(JSON.stringify(receipt), "utf8")).toBeLessThanOrEqual(4_096);
    expect(processRunner.invocations.map(({ program, args }) => [program, args])).toEqual([
      ["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
      ["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
      ["git", ["symbolic-ref", "--quiet", "--short", "HEAD"]],
      ["git", ["remote", "get-url", "--push", "origin"]],
      ["git", ["ls-remote", "--exit-code", "--refs", "origin", "refs/heads/main"]],
      ["git", ["merge-base", "--is-ancestor", remoteRevision, localRevision]],
      ["git", ["push", "--porcelain", "origin", `${localRevision}:refs/heads/main`]],
      ["git", ["ls-remote", "--exit-code", "--refs", "origin", "refs/heads/main"]]
    ]);
    expect(processRunner.invocations.every((invocation) => (
      invocation.env.GIT_TERMINAL_PROMPT === "0" && !("shell" in invocation)
    ))).toBe(true);
  });

  it("blocks dirty state before any remote command", async () => {
    const processRunner = new ScriptedProcessRunner([execution(" M README.md\n")]);
    const receipt = await new DeterministicOperationRunner({ processRunner })
      .run(gitSyncRequest());

    expect(receipt).toMatchObject({ outcome: "blocked", code: "GIT_WORKTREE_DIRTY" });
    expect(processRunner.invocations).toHaveLength(1);
  });

  it.each([
    ["local revision", [
      execution(),
      execution(`${remoteRevision}\n`)
    ], "GIT_REVISION_MISMATCH"],
    ["remote identity", [
      execution(),
      execution(`${localRevision}\n`),
      execution("main\n"),
      execution("https://other.test/repository.git\n")
    ], "GIT_REMOTE_MISMATCH"],
    ["fast-forward relation", [
      execution(),
      execution(`${localRevision}\n`),
      execution("main\n"),
      execution("https://example.test/team/repository.git\n"),
      execution(`${remoteRevision}\trefs/heads/main\n`),
      execution("", 1, 1)
    ], "GIT_NOT_FAST_FORWARD"],
    ["immutable readback", [
      execution(),
      execution(`${localRevision}\n`),
      execution("main\n"),
      execution("https://example.test/team/repository.git\n"),
      execution(`${remoteRevision}\trefs/heads/main\n`),
      execution(),
      execution(),
      execution(`${remoteRevision}\trefs/heads/main\n`)
    ], "GIT_READBACK_MISMATCH"]
  ])("fails closed on %s", async (_label, executions, code) => {
    const receipt = await new DeterministicOperationRunner({
      processRunner: new ScriptedProcessRunner(executions)
    }).run(gitSyncRequest());

    expect(receipt).toMatchObject({ outcome: "blocked", code });
  });

  it("returns one explicit authentication wait without leaking credentials", async () => {
    const secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const processRunner = new ScriptedProcessRunner([
      execution(),
      execution(`${localRevision}\n`),
      execution("main\n"),
      execution("https://example.test/team/repository.git\n"),
      execution("", 12, 128, `fatal: Authentication failed for https://user:${secret}@example.test`)
    ]);

    const receipt = await new DeterministicOperationRunner({ processRunner })
      .run(gitSyncRequest());
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      outcome: "waiting",
      code: "GIT_AUTHENTICATION_REQUIRED",
      nextAction: { kind: "authenticate", operationId: "sync-existing-main" },
      modelWorkersDispatched: 0
    });
    expect(processRunner.invocations).toHaveLength(5);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("user:");
  });
});
