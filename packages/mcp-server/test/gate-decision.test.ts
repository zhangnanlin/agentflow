import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentFlowEngine,
  JsonRunStore,
  sha256,
  validatePipeline,
  type MutationContext,
  type RunState
} from "@agentflow/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createAgentFlowMcpServer } from "../src/api.js";
import {
  gateDecisionInputHash,
  mapGateSelection,
  requestGateDecision
} from "../src/gate-decision.js";
import { projectPaths } from "../src/runtime.js";

vi.mock("@agentflow/core", async () => import("../../core/src/index.js"));

const runId = "run-gate";
const gateId = "review";
const baseArguments = {
  runId,
  gateId,
  expectedRevision: 1,
  idempotencyKey: "decide-review",
  actorId: "user-roseee",
  reason: "Approve the reviewed artifact."
};

describe("gate_decision_request", () => {
  let directory: string;
  let client: Client | undefined;
  let server: ReturnType<typeof createAgentFlowMcpServer> | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-gate-decision-"));
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("derives the form from the persisted Gate and resolves approval in one revision", async () => {
    await initialize(["approve", "reject"]);
    const elicitation = vi.fn(async (request: ElicitRequest) => {
      const params = formParams(request);
      expect(params.message).toBe("Approve the work?");
      expect(params.requestedSchema.required).toEqual(["decision"]);
      expect(params.requestedSchema.properties["decision"]).toEqual({
        type: "string",
        title: "Approve the work?",
        oneOf: [
          { const: "approve", title: "approve" },
          { const: "reject", title: "reject" }
        ]
      });
      expect(JSON.stringify(params)).not.toContain(baseArguments.reason);
      return { action: "accept" as const, content: { decision: "approve" } };
    });
    await connect({ elicitation: { form: {} } }, elicitation);

    const result = await callGate(baseArguments);

    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const payload = result.structuredContent as unknown as { outcome: string; state: RunState };
    expect(payload.outcome).toBe("accepted");
    expect(payload.state.revision).toBe(2);
    expect(payload.state.gates[gateId]).toMatchObject({
      status: "approved",
      selectedOption: "approve",
      resolution: baseArguments.reason,
      resolvedBy: "user-roseee",
      resolvedByKind: "user",
      artifactHashes: { "spec-1": sha256("spec-v1") }
    });
    expect(payload.state.events.at(-1)).toMatchObject({
      type: "gate.approved",
      actorId: "user-roseee",
      actorKind: "user"
    });
    expect(elicitation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["A", "approved", "A"],
    ["mixed", "approved", "mixed"],
    ["reject", "rejected", undefined]
  ] as const)("maps persisted selection %s to %s", async (selection, status, selectedOption) => {
    await initialize(["A", "B", "C", "mixed", "reject"]);
    await connect({ elicitation: { form: {} } }, async () => ({
      action: "accept",
      content: { decision: selection }
    }));

    const result = await callGate(baseArguments);
    const state = (result.structuredContent as unknown as { state: RunState }).state;

    expect(state.gates[gateId]?.status).toBe(status);
    expect(state.gates[gateId]?.selectedOption).toBe(selectedOption);
    expect(state.revision).toBe(2);
  });

  it("replays an exact completed key without opening a second form", async () => {
    await initialize(["approve", "reject"]);
    const elicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { decision: "approve" }
    }));
    await connect({ elicitation: { form: {} } }, elicitation);

    const accepted = await callGate(baseArguments);
    const replayed = await callGate(baseArguments);

    expect((accepted.structuredContent as { outcome?: string }).outcome).toBe("accepted");
    expect((replayed.structuredContent as { outcome?: string }).outcome).toBe("replayed");
    expect((replayed.structuredContent as unknown as { state: RunState }).state.revision).toBe(2);
    expect(elicitation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["actor", { actorId: "user-other" }],
    ["reason", { reason: "A different immutable reason." }],
    ["Gate", { gateId: "other-gate" }],
    ["revision", { expectedRevision: 2 }]
  ])("rejects same-key %s changes before another form", async (_label, change) => {
    await initialize(["approve", "reject"]);
    const elicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { decision: "approve" }
    }));
    await connect({ elicitation: { form: {} } }, elicitation);
    await callGate(baseArguments);

    const result = await callGate({ ...baseArguments, ...change });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "IDEMPOTENCY_CONFLICT" });
    expect(elicitation).toHaveBeenCalledTimes(1);
    expect((await loadState()).revision).toBe(2);
  });

  it.each([
    ["decline", { elicitation: { form: {} } }, "declined"],
    ["cancel", { elicitation: { form: {} } }, "cancelled"],
    ["unsupported", {}, "unsupported"]
  ] as const)("keeps the Run byte-identical when the host returns %s", async (action, capabilities, outcome) => {
    await initialize(["approve", "reject"]);
    const before = await readStateBytes();
    await connect(capabilities, action === "unsupported"
      ? undefined
      : async () => ({ action: action as "decline" | "cancel" }));

    const result = await callGate(baseArguments);

    expect((result.structuredContent as { outcome?: string }).outcome).toBe(outcome);
    expect(await readStateBytes()).toEqual(before);
  });

  it("keeps the Run unchanged for malformed accepted content", async () => {
    await initialize(["approve", "reject"]);
    const before = await readStateBytes();
    await connect({ elicitation: { form: {} } }, async () => ({
      action: "accept",
      content: { decision: "undeclared", extra: "do-not-log" }
    }));

    const result = await callGate(baseArguments);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "ELICITATION_RESPONSE_INVALID" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("do-not-log");
    expect(await readStateBytes()).toEqual(before);
  });

  it.each([
    ["abort", new DOMException("aborted", "AbortError"), "cancelled"],
    ["timeout", Object.assign(new Error("timed out"), { code: ErrorCode.RequestTimeout }), "error"],
    ["disconnect", Object.assign(new Error("connection closed"), { code: ErrorCode.ConnectionClosed }), "error"]
  ] as const)("keeps the Run unchanged on elicitation %s", async (_label, failure, expected) => {
    await initialize(["approve", "reject"]);
    const before = await readStateBytes();
    const engine = await createEngine();
    const state = await engine.loadRun(runId);
    const protocol = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async () => { throw failure; }
    };
    const action = requestGateDecision(
      protocol as never,
      engine,
      state,
      baseArguments,
      {
        expectedRevision: 1,
        idempotencyKey: baseArguments.idempotencyKey,
        actor: { id: baseArguments.actorId, kind: "user" },
        reason: baseArguments.reason
      },
      new AbortController().signal
    );

    if (expected === "cancelled") await expect(action).resolves.toEqual({ outcome: "cancelled" });
    else await expect(action).rejects.toBe(failure);
    expect(await readStateBytes()).toEqual(before);
  });

  it("rejects invalid persisted option sets before elicitation", async () => {
    await initialize(["approve"]);
    const elicitation = vi.fn(async () => ({ action: "cancel" as const }));
    await connect({ elicitation: { form: {} } }, elicitation);

    const result = await callGate(baseArguments);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "GATE_OPTIONS_INVALID" });
    expect(elicitation).not.toHaveBeenCalled();
    expect((await loadState()).revision).toBe(1);
  });

  it("rejects stale revision and non-pending Gate states before elicitation", async () => {
    await initialize(["approve", "reject"]);
    const elicitation = vi.fn(async () => ({ action: "cancel" as const }));
    await connect({ elicitation: { form: {} } }, elicitation);

    const stale = await callGate({ ...baseArguments, expectedRevision: 0 });

    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ error: "REVISION_CONFLICT" });
    expect(elicitation).not.toHaveBeenCalled();
  });

  it("rejects missing and automatic Gates before elicitation without changing Run bytes", async () => {
    await initialize(["approve", "reject"], "automatic");
    const before = await readStateBytes();
    const elicitation = vi.fn(async () => ({ action: "cancel" as const }));
    await connect({ elicitation: { form: {} } }, elicitation);

    const missing = await callGate({
      ...baseArguments,
      gateId: "missing",
      idempotencyKey: "missing-gate"
    });
    const automatic = await callGate({
      ...baseArguments,
      idempotencyKey: "automatic-gate"
    });

    expect(missing.structuredContent).toMatchObject({ error: "GATE_NOT_FOUND" });
    expect(automatic.structuredContent).toMatchObject({ error: "GATE_NOT_HUMAN" });
    expect(elicitation).not.toHaveBeenCalled();
    expect(await readStateBytes()).toEqual(before);
  });

  it("rejects an already resolved Gate before elicitation without another revision", async () => {
    await initialize(["approve", "reject"]);
    const engine = await createEngine();
    await engine.resolveGate(runId, {
      gateId,
      decision: "approved",
      choice: "approve",
      resolution: "Already approved"
    }, {
      expectedRevision: 1,
      idempotencyKey: "direct-approval",
      actor: { id: "user-roseee", kind: "user" },
      reason: "Already approved"
    });
    const before = await readStateBytes();
    const elicitation = vi.fn(async () => ({ action: "cancel" as const }));
    await connect({ elicitation: { form: {} } }, elicitation);

    const result = await callGate({
      ...baseArguments,
      expectedRevision: 2,
      idempotencyKey: "resolved-gate"
    });

    expect(result.structuredContent).toMatchObject({ error: "GATE_NOT_PENDING" });
    expect(elicitation).not.toHaveBeenCalled();
    expect(await readStateBytes()).toEqual(before);
  });

  it("does not resolve when an Artifact changes while the form is open", async () => {
    await initialize(["approve", "reject"]);
    const entered = deferred<void>();
    const answer = deferred<{ action: "accept"; content: { decision: string } }>();
    await connect({ elicitation: { form: {} } }, async () => {
      entered.resolve();
      return answer.promise;
    });
    const pending = callGate(baseArguments);
    await entered.promise;
    const engine = await createEngine();
    await engine.registerArtifact(runId, {
      id: "spec-1",
      stageId: "S0",
      kind: "spec",
      uri: "spec.json",
      sha256: sha256("spec-v2"),
      producedBy: "worker-1"
    }, mutationContext(1, "replace-spec"));
    answer.resolve({ action: "accept", content: { decision: "approve" } });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "REVISION_CONFLICT" });
    const state = await loadState();
    expect(state.revision).toBe(2);
    expect(state.gates[gateId]?.status).toBe("pending");
    expect(state.events.filter((event) => event.type.startsWith("gate."))).toHaveLength(0);
  });

  it("allows only one of two concurrent different-key decisions to mutate", async () => {
    await initialize(["approve", "reject"]);
    const bothEntered = barrier(2);
    let callIndex = 0;
    await connect({ elicitation: { form: {} } }, async () => {
      const selection = callIndex++ === 0 ? "approve" : "reject";
      await bothEntered();
      return { action: "accept", content: { decision: selection } };
    });

    const results = await Promise.all([
      callGate({ ...baseArguments, idempotencyKey: "decision-a" }),
      callGate({ ...baseArguments, idempotencyKey: "decision-b" })
    ]);

    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(results.find((result) => result.isError)?.structuredContent).toMatchObject({ error: "REVISION_CONFLICT" });
    const state = await loadState();
    expect(state.revision).toBe(2);
    expect(state.events.filter((event) => event.type.startsWith("gate."))).toHaveLength(1);
  });

  it("reports a concurrent same-key conflicting answer without a false replay", async () => {
    await initialize(["approve", "reject"]);
    const bothEntered = barrier(2);
    let callIndex = 0;
    await connect({ elicitation: { form: {} } }, async () => {
      const selection = callIndex++ === 0 ? "approve" : "reject";
      await bothEntered();
      return { action: "accept", content: { decision: selection } };
    });

    const results = await Promise.all([callGate(baseArguments), callGate(baseArguments)]);

    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(results.find((result) => result.isError)?.structuredContent).toMatchObject({ error: "IDEMPOTENCY_CONFLICT" });
    const state = await loadState();
    expect(state.revision).toBe(2);
    expect(state.events.filter((event) => event.type.startsWith("gate."))).toHaveLength(1);
  });

  it("rejects caller-authored question, options, and decision fields", async () => {
    await initialize(["approve", "reject"]);
    const elicitation = vi.fn(async () => ({ action: "cancel" as const }));
    await connect({ elicitation: { form: {} } }, elicitation);

    const result = await callGate({
      ...baseArguments,
      question: "Trust this caller question?",
      options: ["yes", "no"],
      decision: "approved",
      choice: "yes",
      resolution: "caller supplied"
    });

    expect(result.isError).toBe(true);
    expect(elicitation).not.toHaveBeenCalled();
    expect((await loadState()).revision).toBe(1);
  });

  async function initialize(options: string[], gateType: "human" | "automatic" = "human"): Promise<void> {
    const pipeline = validatePipeline({
      id: "gate-pipeline",
      version: "1",
      name: "Gate pipeline",
      stages: [{
        id: "S0",
        name: "Review",
        requiredArtifactKinds: ["spec"],
        requiredGate: {
          id: gateId,
          type: gateType,
          question: "Approve the work?",
          options
        }
      }]
    });
    const paths = projectPaths(directory);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.pipelinePath, stringifyYaml(pipeline), "utf8");
    await writeFile(paths.configPath, stringifyYaml({
      version: 1,
      pipeline: "pipeline.yaml",
      runsDirectory: "runs"
    }), "utf8");
    const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
    let state = await engine.createRun({ id: runId, requirement: "Exercise Gate choice", hasUi: false });
    state = await engine.registerArtifact(runId, {
      id: "spec-1",
      stageId: "S0",
      kind: "spec",
      uri: "spec.json",
      sha256: sha256("spec-v1"),
      producedBy: "worker-1"
    }, mutationContext(state.revision, "register-spec"));
    expect(state.revision).toBe(1);
    await writeFile(paths.currentRunPath, `${JSON.stringify({ runId }, null, 2)}\n`, "utf8");
  }

  async function connect(
    capabilities: Record<string, unknown>,
    handler: ((request: ElicitRequest) => Promise<unknown>) | undefined
  ): Promise<void> {
    server = createAgentFlowMcpServer({ projectRoot: directory });
    client = new Client(
      { name: "gate-decision-test", version: "1.0.0" },
      { capabilities }
    );
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  async function callGate(arguments_: Record<string, unknown>) {
    if (!client) throw new Error("Client is not connected");
    return client.callTool({ name: "gate_decision_request", arguments: arguments_ });
  }

  async function createEngine(): Promise<AgentFlowEngine> {
    const paths = projectPaths(directory);
    const pipeline = validatePipeline(parseYaml(await readFile(paths.pipelinePath, "utf8")));
    return new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
  }

  async function loadState(): Promise<RunState> {
    return (await createEngine()).loadRun(runId);
  }

  async function readStateBytes(): Promise<Buffer> {
    return readFile(join(projectPaths(directory).runsDirectory, runId, "state.json"));
  }
});

describe("Gate decision helpers", () => {
  it("maps reject aliases and approved named choices deterministically", () => {
    expect(mapGateSelection("reject")).toEqual({ decision: "rejected" });
    expect(mapGateSelection("REJECTED")).toEqual({ decision: "rejected" });
    expect(mapGateSelection("A")).toEqual({ decision: "approved", choice: "A" });
    expect(mapGateSelection("approve")).toEqual({ decision: "approved", choice: "approve" });
  });

  it("hashes every immutable Gate input without including the idempotency key", () => {
    const first = gateDecisionInputHash(baseArguments);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(gateDecisionInputHash({ ...baseArguments, idempotencyKey: "another-key" })).toBe(first);
    expect(gateDecisionInputHash({ ...baseArguments, actorId: "user-other" })).not.toBe(first);
    expect(gateDecisionInputHash({ ...baseArguments, reason: "Different" })).not.toBe(first);
    expect(gateDecisionInputHash({ ...baseArguments, gateId: "other" })).not.toBe(first);
    expect(gateDecisionInputHash({ ...baseArguments, expectedRevision: 2 })).not.toBe(first);
  });
});

type ElicitRequest = Parameters<Parameters<Client["setRequestHandler"]>[1]>[0];

function formParams(request: ElicitRequest): {
  message: string;
  requestedSchema: {
    required?: string[];
    properties: Record<string, Record<string, unknown>>;
  };
} {
  return request.params as never;
}

function mutationContext(expectedRevision: number, idempotencyKey: string): MutationContext {
  return {
    expectedRevision,
    idempotencyKey,
    actor: { id: "worker-1", kind: "worker" },
    reason: idempotencyKey
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function barrier(count: number): () => Promise<void> {
  const ready = deferred<void>();
  let arrivals = 0;
  return async () => {
    arrivals += 1;
    if (arrivals === count) ready.resolve();
    await ready.promise;
  };
}
