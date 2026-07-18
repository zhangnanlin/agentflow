import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentFlowMcpServer } from "../src/api.js";
import {
  DeterministicOperationRunner,
  operationDurationP95,
  type DeterministicOperationReceipt,
  type ProcessExecution,
  type ProcessInvocation,
  type ProcessRunner
} from "../src/deterministic-operations.js";

vi.mock("@agentflow/core", async () => import("../../core/src/index.js"));
vi.mock("@agentflow/host-adapter", async () => import("../../host-adapter/src/index.js"));

const revision = "c".repeat(40);
const temporaryDirectories: string[] = [];

class RecordingProcessRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];

  constructor(private readonly executions: ProcessExecution[] = []) {}

  async run(invocation: ProcessInvocation): Promise<ProcessExecution> {
    this.invocations.push(invocation);
    return this.executions.shift() ?? { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("deterministic no-Worker operations", () => {
  it.each([
    "git-force",
    "git-delete-ref",
    "history-rewrite",
    "file-change",
    "release",
    "publication",
    "deployment",
    "migration"
  ])("denies %s before process launch", async (kind) => {
    const processRunner = new RecordingProcessRunner();
    const receipt = await new DeterministicOperationRunner({ processRunner }).run({
      kind,
      operationId: `denied-${kind}`,
      repositoryRoot: "C:/work/repository"
    });

    expect(receipt).toMatchObject({
      kind,
      outcome: "blocked",
      code: "OPERATION_DENIED",
      modelWorkersDispatched: 0
    });
    expect(processRunner.invocations).toEqual([]);
  });

  it("denies unsafe effects attached to an otherwise safe Git request", async () => {
    const processRunner = new RecordingProcessRunner();
    const receipt = await new DeterministicOperationRunner({ processRunner }).run({
      kind: "git-sync",
      operationId: "unsafe-force-flag",
      repositoryRoot: "C:/work/repository",
      intent: "push-existing-commit",
      expectedRevision: revision,
      remoteName: "origin",
      expectedRemoteUrl: "https://example.test/repository.git",
      branch: "main",
      force: true
    });

    expect(receipt).toMatchObject({ outcome: "blocked", code: "OPERATION_DENIED" });
    expect(processRunner.invocations).toEqual([]);
  });

  it("runs allowlisted verification checks and external Git readback", async () => {
    const verificationProcess = new RecordingProcessRunner([
      { stdout: "", stderr: "", exitCode: 0, durationMs: 3 },
      { stdout: `${revision}\n`, stderr: "", exitCode: 0, durationMs: 4 }
    ]);
    const runner = new DeterministicOperationRunner({ processRunner: verificationProcess });
    const verification = await runner.run({
      kind: "verification",
      operationId: "verify-repository",
      repositoryRoot: "C:/work/repository",
      checks: [
        { kind: "git-clean" },
        { kind: "git-revision", expectedRevision: revision }
      ]
    });

    expect(verification).toMatchObject({
      outcome: "completed",
      evidence: {
        checks: [
          { kind: "git-clean", status: "passed" },
          { kind: "git-revision", status: "passed", revision }
        ]
      },
      timingsMs: { command: 7, transport: 0, readback: 0 }
    });

    const readbackProcess = new RecordingProcessRunner([
      {
        stdout: "https://example.test/repository.git\n",
        stderr: "",
        exitCode: 0,
        durationMs: 2
      },
      {
        stdout: `${revision}\trefs/heads/main\n`,
        stderr: "",
        exitCode: 0,
        durationMs: 8
      }
    ]);
    const readback = await new DeterministicOperationRunner({ processRunner: readbackProcess }).run({
      kind: "readback",
      operationId: "read-remote-main",
      repositoryRoot: "C:/work/repository",
      remoteName: "origin",
      expectedRemoteUrl: "https://example.test/repository.git",
      remoteRef: "refs/heads/main",
      expectedRevision: revision,
      authenticationWaitMs: 1_000
    });

    expect(readback).toMatchObject({
      outcome: "completed",
      evidence: { remoteName: "origin", remoteRef: "refs/heads/main", remoteRevision: revision },
      timingsMs: { command: 2, authentication: 1_000, readback: 8 }
    });
  });

  it("runs only pre-registered verification command arrays", async () => {
    const processRunner = new RecordingProcessRunner([
      { stdout: "tests passed\n", stderr: "", exitCode: 0, durationMs: 12 }
    ]);
    const runner = new DeterministicOperationRunner({
      processRunner,
      verificationCommands: {
        "unit-tests": { program: "npm.cmd", args: ["test"], timeoutMs: 30_000 }
      }
    });
    const completed = await runner.run({
      kind: "verification",
      operationId: "run-unit-tests",
      repositoryRoot: "C:/work/repository",
      verificationId: "unit-tests"
    });

    expect(completed).toMatchObject({
      outcome: "completed",
      code: "VERIFICATION_COMPLETED",
      evidence: { verificationId: "unit-tests", status: "passed" },
      timingsMs: { command: 12 }
    });
    expect(processRunner.invocations).toEqual([expect.objectContaining({
      program: "npm.cmd",
      args: ["test"],
      env: { CI: "1" },
      timeoutMs: 30_000
    })]);

    const deniedProcess = new RecordingProcessRunner();
    const denied = await new DeterministicOperationRunner({ processRunner: deniedProcess }).run({
      kind: "verification",
      operationId: "unknown-verification",
      repositoryRoot: "C:/work/repository",
      verificationId: "unit-tests"
    });
    expect(denied).toMatchObject({ outcome: "blocked", code: "VERIFICATION_NOT_ALLOWLISTED" });
    expect(deniedProcess.invocations).toEqual([]);

    expect(() => new DeterministicOperationRunner({
      verificationCommands: {
        unsafe: { program: "npm.cmd", args: ["run", "deploy"] }
      }
    })).toThrow("safe verification command");
    expect(() => new DeterministicOperationRunner({
      verificationCommands: {
        "snapshot-update": { program: "npx.cmd", args: ["vitest", "-u"] }
      }
    })).toThrow("safe verification command");
  });

  it("keeps timers and interactive waits in one host operation", async () => {
    const slept: number[] = [];
    const runner = new DeterministicOperationRunner({
      sleep: async (milliseconds) => { slept.push(milliseconds); }
    });
    const timer = await runner.run({
      kind: "timer",
      operationId: "bounded-timer",
      durationMs: 25
    });
    const wait = await runner.run({
      kind: "interactive-wait",
      operationId: "wait-for-user-auth",
      waitReason: "authentication"
    });

    expect(slept).toEqual([25]);
    expect(timer).toMatchObject({
      outcome: "completed",
      modelWorkersDispatched: 0,
      evidence: { durationMs: 25 }
    });
    expect(wait).toMatchObject({
      outcome: "waiting",
      code: "INTERACTIVE_WAIT",
      modelWorkersDispatched: 0,
      nextAction: { kind: "authenticate", operationId: "wait-for-user-auth" }
    });
  });

  it("computes p95 from sanitized orchestration timings", () => {
    const receipts = Array.from({ length: 100 }, (_value, index) => ({
      timingsMs: { orchestration: index === 99 ? 119_000 : 5_000 + index }
    })) as DeterministicOperationReceipt[];

    expect(operationDurationP95(receipts, "orchestration")).toBeLessThanOrEqual(120_000);
  });

  it("exposes one compact MCP operation tool without requiring a Run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-deterministic-mcp-"));
    temporaryDirectories.push(directory);
    const slept: number[] = [];
    const operationRunner = new DeterministicOperationRunner({
      sleep: async (milliseconds) => { slept.push(milliseconds); }
    });
    const server = createAgentFlowMcpServer({ projectRoot: directory, deterministicOperationRunner: operationRunner });
    const client = new Client({ name: "deterministic-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.filter((tool) => tool.name === "deterministic_operation_run")).toHaveLength(1);
      const result = await client.callTool({
        name: "deterministic_operation_run",
        arguments: { operationId: "mcp-timer", kind: "timer", durationMs: 10 }
      });

      expect(result.structuredContent).toMatchObject({
        operationId: "mcp-timer",
        kind: "timer",
        outcome: "completed",
        modelWorkersDispatched: 0
      });
      expect(slept).toEqual([10]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
