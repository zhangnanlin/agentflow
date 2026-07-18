import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentFlowEngine,
  AgentFlowError,
  JsonRunStore,
  sha256,
  validatePipeline,
  type ChangeReceipt,
  type RunSectionPage,
  type RunState,
  type RunSummary
} from "@agentflow/core";
import { AGENTFLOW_MCP_INSTRUCTIONS } from "@agentflow/host-adapter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createAgentFlowMcpServer } from "../src/api.js";
import { ProjectRootResolver } from "../src/project-root.js";
import { projectPaths } from "../src/runtime.js";

vi.mock("@agentflow/core", async () => import("../../core/src/index.js"));
vi.mock("@agentflow/host-adapter", async () => import("../../host-adapter/src/index.js"));

const pipeline = validatePipeline({
  id: "compact-response-pipeline",
  version: "1",
  name: "Compact response pipeline",
  stages: [{ id: "S0", name: "Work" }]
});
const seededRequirement = "Exercise compact MCP responses with token=supersecretvalue";

describe("compact MCP response profiles", () => {
  let directory: string;
  let client: Client;
  let server: ReturnType<typeof createAgentFlowMcpServer>;
  let revision: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-compact-mcp-"));
    const paths = projectPaths(directory);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.pipelinePath, stringifyYaml(pipeline), "utf8");
    await writeFile(paths.configPath, stringifyYaml({
      version: 1,
      pipeline: "pipeline.yaml",
      runsDirectory: "runs"
    }), "utf8");

    const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
    let state = await engine.createRun({
      id: "run-compact",
      requirement: seededRequirement,
      projectType: "existing",
      hasUi: false
    });
    for (let index = 0; index < 45; index += 1) {
      state = await engine.createTask("run-compact", {
        id: `task-${String(index).padStart(2, "0")}`,
        stageId: "S0",
        title: `Task ${index}`,
        description: "x".repeat(200)
      }, {
        expectedRevision: state.revision,
        idempotencyKey: `seed-task-${index}`,
        actor: { id: "seed", kind: "supervisor" },
        reason: "Seed a deliberately large Run"
      });
    }
    revision = state.revision;
    await writeFile(paths.currentRunPath, `${JSON.stringify({ runId: "run-compact" }, null, 2)}\n`, "utf8");

    server = createAgentFlowMcpServer({ projectRoot: directory });
    client = new Client({ name: "compact-response-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("returns a bounded RunSummary by default and supports explicit full compatibility", async () => {
    revision = await seedLargeRunDimensions(directory, revision);
    const compact = await call(client, "status_get");
    const summary = compact.structuredContent as unknown as RunSummary;

    expect(compact.isError, resultText(compact)).not.toBe(true);
    expect(summary).toMatchObject({ version: 1, runId: "run-compact", revision, lane: "full" });
    expect(summary.currentTasks.length).toBeGreaterThan(0);
    expect(summary.currentTasks.length + summary.currentTaskOverflow).toBe(55);
    expect(summary.liveWorkers.length).toBeGreaterThan(0);
    expect(summary.liveWorkers.length + summary.liveWorkerOverflow).toBe(30);
    expect(summary).not.toHaveProperty("events");
    expect(Buffer.byteLength(resultText(compact), "utf8")).toBeLessThanOrEqual(8_192);

    const full = await call(client, "status_get", { responseProfile: "full" });
    const fullState = full.structuredContent as unknown as RunState;
    expect(fullState.id).toBe("run-compact");
    expect(fullState.events.length).toBeGreaterThanOrEqual(100);
    expect(Object.keys(fullState.tasks)).toHaveLength(55);
    expect(Object.keys(fullState.workers)).toHaveLength(30);
    expect(Object.keys(fullState.artifacts)).toHaveLength(20);
    expect(full.structuredContent).toHaveProperty("events");
    expect(Buffer.byteLength(resultText(full), "utf8")).toBeGreaterThan(8_192);
  });

  it("paginates named sections and events with opaque cursors", async () => {
    const invalidSummary = await call(client, "status_get", {
      responseProfile: "summary",
      pageSize: 5
    });
    expect(invalidSummary.isError).toBe(true);
    expect(invalidSummary.structuredContent).toMatchObject({ error: "RUN_RESPONSE_PROFILE_INVALID" });

    const first = await call(client, "status_get", {
      responseProfile: "section",
      section: "tasks",
      pageSize: 7
    });
    const firstPage = first.structuredContent as unknown as RunSectionPage;
    expect(firstPage).toMatchObject({ section: "tasks", total: 45 });
    expect(firstPage.items).toHaveLength(7);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await call(client, "status_get", {
      responseProfile: "section",
      section: "tasks",
      pageSize: 7,
      cursor: firstPage.nextCursor
    });
    const secondPage = second.structuredContent as unknown as RunSectionPage;
    expect(secondPage.items).toHaveLength(7);
    expect(secondPage.items).not.toEqual(firstPage.items);

    const events = await call(client, "status_get", {
      responseProfile: "events",
      pageSize: 5
    });
    const eventPage = events.structuredContent as unknown as RunSectionPage;
    expect(eventPage.section).toBe("events");
    expect(eventPage.items).toHaveLength(5);
    expect(eventPage.nextCursor).toEqual(expect.any(String));
    expect(resultText(events)).not.toContain("supersecretvalue");

    const mutationResult = await call(client, "task_create", {
      taskId: "cursor-revision-change",
      stageId: "S0",
      title: "Change the revision",
      ...mutation(revision, "cursor-revision-change")
    });
    expect(mutationResult.isError, resultText(mutationResult)).not.toBe(true);

    const staleCursor = await call(client, "status_get", {
      responseProfile: "events",
      cursor: eventPage.nextCursor,
      pageSize: 5
    });
    expect(staleCursor.isError).toBe(true);
    expect(staleCursor.structuredContent).toMatchObject({ error: "RUN_CURSOR_STALE" });

    const changed = await call(client, "status_get", {
      responseProfile: "events",
      afterRevision: revision,
      pageSize: 5
    });
    expect(changed.structuredContent).toMatchObject({
      revision: revision + 1,
      section: "events",
      total: 1,
      items: [expect.objectContaining({ data: { taskId: "cursor-revision-change" } })]
    });

    const unchanged = await call(client, "status_get", {
      responseProfile: "events",
      afterRevision: revision + 1,
      pageSize: 5
    });
    expect(unchanged.structuredContent).toMatchObject({
      revision: revision + 1,
      section: "events",
      items: [],
      total: 0
    });
  });

  it("returns bounded ChangeReceipts for mutations and full state only on request", async () => {
    const compact = await call(client, "task_create", {
      taskId: "compact-mutation",
      stageId: "S0",
      title: "Compact mutation",
      ...mutation(revision, "compact-mutation")
    });
    const receipt = compact.structuredContent as unknown as ChangeReceipt;

    expect(compact.isError, resultText(compact)).not.toBe(true);
    expect(receipt).toMatchObject({
      version: 1,
      runId: "run-compact",
      revision: revision + 1,
      changed: { tasks: ["compact-mutation"] }
    });
    expect(receipt).not.toHaveProperty("events");
    expect(Buffer.byteLength(resultText(compact), "utf8")).toBeLessThanOrEqual(4_096);

    const full = await call(client, "task_create", {
      taskId: "full-mutation",
      stageId: "S0",
      title: "Full mutation",
      responseProfile: "full",
      ...mutation(revision + 1, "full-mutation")
    });
    expect((full.structuredContent as unknown as RunState).tasks["full-mutation"]).toBeDefined();
    expect(full.structuredContent).toHaveProperty("events");
  });

  it("returns a compact summary from start-or-resume and exposes audited lifecycle tools", async () => {
    const resumed = await call(client, "run_start_or_resume", {
      requirement: "  exercise   COMPACT mcp responses with TOKEN=supersecretvalue  ",
      projectType: "existing",
      hasUi: false,
      requestKey: "resume-normalized-intent"
    });
    expect(resumed.isError, resultText(resumed)).not.toBe(true);
    expect(resumed.structuredContent).toMatchObject({
      action: "resumed",
      summary: { runId: "run-compact", revision }
    });
    expect(resumed.structuredContent).not.toHaveProperty("state");

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "run_cancel",
      "run_fail",
      "run_block",
      "run_supersede"
    ]));
    const descriptionBytes = tools.tools.reduce(
      (total, tool) => total + Buffer.byteLength(tool.description ?? "", "utf8"),
      0
    );
    expect(descriptionBytes).toBeLessThanOrEqual(12_288);
    expect(client.getInstructions()).toBe(AGENTFLOW_MCP_INSTRUCTIONS);
    expect(client.getInstructions().match(/## AgentFlow automatic routing/g)).toHaveLength(1);
  });

  it.each([
    ["run_cancel", "cancelled", {}],
    ["run_fail", "failed", {}],
    ["run_block", "blocked", {}],
    ["run_supersede", "superseded", { replacementRunId: "replacement-run" }]
  ] as const)("audits %s through a compact receipt", async (tool, outcome, extra) => {
    revision = await seedLongReceiptTasks(directory, revision);
    const result = await call(client, tool, {
      ...extra,
      ...mutation(revision, `terminal-${outcome}`)
    });
    expect(result.isError, resultText(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      version: 1,
      runId: "run-compact",
      revision: revision + 1,
      status: outcome
    });
    expect(Buffer.byteLength(resultText(result), "utf8")).toBeLessThanOrEqual(4_096);
    const receipt = result.structuredContent as unknown as ChangeReceipt;
    expect(receipt.changed.tasks.length + receipt.changed.overflow.tasks).toBe(75);

    const persisted = await call(client, "status_get", { responseProfile: "full" });
    expect(persisted.structuredContent).toMatchObject({ businessOutcome: outcome });
  });

  it("redacts credential-like AgentFlow error details and keeps unexpected trace IDs", async () => {
    const credentialResolver = {
      resolve: async () => {
        throw new AgentFlowError("Credential lookup failed", "HOST_AUTH_FAILED", {
          apiKey: "sk-live-secret",
          otp: "123456",
          command: "npm config set //registry.npmjs.org/:_authToken=npm_verysecret123",
          nested: { authorization: "Bearer very-secret", safe: "visible" }
        });
      }
    } as unknown as ProjectRootResolver;
    const credentialServer = createAgentFlowMcpServer({ projectRootResolver: credentialResolver });
    const credentialClient = new Client({ name: "credential-error-test", version: "0.1.0" });
    const [credentialClientTransport, credentialServerTransport] = InMemoryTransport.createLinkedPair();
    await credentialServer.connect(credentialServerTransport);
    await credentialClient.connect(credentialClientTransport);
    const credentialResult = await call(credentialClient, "status_get");
    expect(credentialResult.structuredContent).toMatchObject({
      error: "HOST_AUTH_FAILED",
      details: {
        apiKey: "[REDACTED]",
        otp: "[REDACTED]",
        nested: { authorization: "[REDACTED]", safe: "visible" }
      }
    });
    expect(resultText(credentialResult)).not.toContain("sk-live-secret");
    expect(resultText(credentialResult)).not.toContain("very-secret");
    expect(resultText(credentialResult)).not.toContain("123456");
    expect(resultText(credentialResult)).not.toContain("npm_verysecret123");
    await credentialClient.close();
    await credentialServer.close();

    const unexpectedResolver = {
      resolve: async () => { throw new Error("password=hunter2"); }
    } as unknown as ProjectRootResolver;
    const unexpectedServer = createAgentFlowMcpServer({ projectRootResolver: unexpectedResolver });
    const unexpectedClient = new Client({ name: "unexpected-error-test", version: "0.1.0" });
    const [unexpectedClientTransport, unexpectedServerTransport] = InMemoryTransport.createLinkedPair();
    await unexpectedServer.connect(unexpectedServerTransport);
    await unexpectedClient.connect(unexpectedClientTransport);
    const unexpectedResult = await call(unexpectedClient, "status_get");
    expect(unexpectedResult.structuredContent).toMatchObject({
      error: "UNEXPECTED",
      message: "Unexpected AgentFlow MCP failure",
      traceId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    });
    expect(resultText(unexpectedResult)).not.toContain("hunter2");
    await unexpectedClient.close();
    await unexpectedServer.close();
  });
});

function mutation(expectedRevision: number, idempotencyKey: string): Record<string, unknown> {
  return {
    runId: "run-compact",
    expectedRevision,
    idempotencyKey,
    actorId: "supervisor",
    reason: `Compact response test: ${idempotencyKey}`
  };
}

async function seedLargeRunDimensions(directory: string, initialRevision: number): Promise<number> {
  const paths = projectPaths(directory);
  const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
  let state = await engine.loadRun("run-compact");
  expect(state.revision).toBe(initialRevision);
  for (let index = 0; index < 10; index += 1) {
    const taskId = paddedId(`a-task-${index}-`);
    const workerId = paddedId(`a-worker-${index}-`);
    state = await engine.createTask("run-compact", {
      id: taskId,
      stageId: "S0",
      title: `Long identifier Task ${index}`,
      description: "Exercise worst-case summary identifiers",
      waveId: paddedId(`a-wave-${index}-`)
    }, seedContext(state.revision, `long-task-${index}`));
    state = await engine.claimTask(
      "run-compact",
      taskId,
      workerId,
      900,
      seedContext(state.revision, `long-claim-${index}`)
    );
    state = await engine.prepareWorker("run-compact", {
      workerId,
      taskId,
      adapter: paddedId(`a-adapter-${index}-`),
      hostTaskName: `large-long-run-${index}`,
      promptHash: sha256(`long-prompt-${index}`),
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: true
      }
    }, seedContext(state.revision, `long-prepare-${index}`));
  }
  for (let index = 0; index < 20; index += 1) {
    const workerId = `worker-${String(index).padStart(2, "0")}`;
    const taskId = `task-${String(index).padStart(2, "0")}`;
    state = await engine.claimTask("run-compact", taskId, workerId, 900, seedContext(state.revision, `claim-${index}`));
    state = await engine.prepareWorker("run-compact", {
      workerId,
      taskId,
      adapter: "codex",
      hostTaskName: `large-run-${index}`,
      promptHash: sha256(`prompt-${index}`),
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: true
      }
    }, seedContext(state.revision, `prepare-${index}`));
  }
  for (let index = 0; index < 20; index += 1) {
    state = await engine.registerArtifact("run-compact", {
      id: `artifact-${String(index).padStart(2, "0")}`,
      stageId: "S0",
      kind: "fixture",
      uri: `.agentflow/fixtures/artifact-${index}.json`,
      sha256: sha256(`artifact-${index}`),
      producedBy: "seed",
      metadata: {}
    }, seedContext(state.revision, `artifact-${index}`));
  }
  return state.revision;
}

function seedContext(expectedRevision: number, idempotencyKey: string) {
  return {
    expectedRevision,
    idempotencyKey: `large-run-${idempotencyKey}`,
    actor: { id: "seed", kind: "supervisor" as const },
    reason: "Seed the large MCP response fixture"
  };
}

function paddedId(prefix: string): string {
  return `${prefix}${"x".repeat(160 - prefix.length)}`;
}

async function seedLongReceiptTasks(directory: string, initialRevision: number): Promise<number> {
  const paths = projectPaths(directory);
  const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
  let state = await engine.loadRun("run-compact");
  expect(state.revision).toBe(initialRevision);
  for (let index = 0; index < 30; index += 1) {
    state = await engine.createTask("run-compact", {
      id: paddedId(`a-receipt-task-${index}-`),
      stageId: "S0",
      title: `Receipt budget Task ${index}`
    }, seedContext(state.revision, `receipt-task-${index}`));
  }
  return state.revision;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function resultText(result: Awaited<ReturnType<typeof call>>): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}
