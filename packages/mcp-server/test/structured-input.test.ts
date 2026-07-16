import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentFlowMcpServer } from "../src/api.js";
import {
  StructuredChoiceRequestSchema,
  requestStructuredChoice,
  type StructuredChoiceRequest
} from "../src/structured-input.js";

const request: StructuredChoiceRequest = {
  message: "Choose the independent setup options.",
  questions: [{
    id: "scope",
    prompt: "Which migration scope should be used?",
    description: "This affects package layout.",
    options: [
      { value: "platform-packages", label: "Platform packages" },
      { value: "scripts-only", label: "Scripts only" }
    ],
    recommended: "platform-packages"
  }]
};

describe("structured_choice_request", () => {
  let directory: string;
  let beforeTree: Record<string, string>;
  let client: Client | undefined;
  let server: ReturnType<typeof createAgentFlowMcpServer> | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-structured-input-"));
    await writeFile(join(directory, "sentinel.txt"), "unchanged\n", "utf8");
    const runDirectory = join(directory, ".agentflow", "runs", "run-existing");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "state.json"), "existing Run bytes\n", "utf8");
    beforeTree = await snapshotTree(directory);
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    expect(await snapshotTree(directory)).toEqual(beforeTree);
    await rm(directory, { recursive: true, force: true });
  });

  it("elicits required titled oneOf fields without preselecting the recommendation", async () => {
    const handler = vi.fn(async (elicitation: Parameters<Parameters<Client["setRequestHandler"]>[1]>[0]) => {
      const params = elicitation.params as {
        mode?: string;
        message: string;
        requestedSchema: {
          type: string;
          required?: string[];
          properties: Record<string, Record<string, unknown>>;
        };
      };
      expect(params.mode).toBe("form");
      expect(params.message).toBe(request.message);
      expect(params.requestedSchema.required).toEqual(["scope"]);
      expect(params.requestedSchema.properties["scope"]).toEqual({
        type: "string",
        title: request.questions[0]?.prompt,
        description: request.questions[0]?.description,
        oneOf: [
          { const: "platform-packages", title: "Platform packages (Recommended)" },
          { const: "scripts-only", title: "Scripts only" }
        ]
      });
      expect(JSON.stringify(params.requestedSchema)).not.toContain("default");
      return { action: "accept" as const, content: { scope: "platform-packages" } };
    });
    await connect({ elicitation: { form: {} } }, handler);

    const result = await call("structured_choice_request", request);

    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toEqual({
      outcome: "accepted",
      answers: { scope: "platform-packages" }
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts the legacy empty elicitation capability and batches three independent questions", async () => {
    const threeQuestions: StructuredChoiceRequest = {
      message: "Choose three options.",
      questions: [
        request.questions[0]!,
        {
          id: "format",
          prompt: "Which format?",
          options: [
            { value: "json", label: "JSON" },
            { value: "yaml", label: "YAML" }
          ]
        },
        {
          id: "mode",
          prompt: "Which mode?",
          options: [
            { value: "safe", label: "Safe" },
            { value: "fast", label: "Fast" }
          ]
        }
      ]
    };
    await connect({ elicitation: {} }, async (elicitation) => {
      const params = elicitation.params as { requestedSchema: { required?: string[] } };
      expect(params.requestedSchema.required).toEqual(["scope", "format", "mode"]);
      return {
        action: "accept",
        content: { scope: "scripts-only", format: "json", mode: "safe" }
      };
    });

    const result = await call("structured_choice_request", threeQuestions);

    expect(result.structuredContent).toEqual({
      outcome: "accepted",
      answers: { scope: "scripts-only", format: "json", mode: "safe" }
    });
  });

  it("returns one data-only fallback when form elicitation is unsupported", async () => {
    await connect({}, undefined);

    const result = await call("structured_choice_request", request);

    expect(result.structuredContent).toEqual({
      outcome: "unsupported",
      fallback: {
        instruction: "Present all questions once and submit only explicit user selections.",
        message: request.message,
        questions: request.questions
      }
    });
  });

  it.each([
    ["decline", "declined"],
    ["cancel", "cancelled"]
  ] as const)("maps host %s to the %s outcome", async (action, outcome) => {
    await connect({ elicitation: { form: {} } }, async () => ({ action }));

    const result = await call("structured_choice_request", request);

    expect(result.structuredContent).toEqual({ outcome });
  });

  it.each([
    ["no questions", { ...request, questions: [] }],
    ["long message", { ...request, message: "x".repeat(1_001) }],
    ["four questions", { ...request, questions: Array.from({ length: 4 }, (_, index) => ({
      ...request.questions[0],
      id: `scope-${index}`
    })) }],
    ["duplicate question IDs", { ...request, questions: [request.questions[0], request.questions[0]] }],
    ["one option", { ...request, questions: [{ ...request.questions[0], options: [request.questions[0]!.options[0]] }] }],
    ["long prompt", { ...request, questions: [{ ...request.questions[0], prompt: "x".repeat(501) }] }],
    ["long description", { ...request, questions: [{ ...request.questions[0], description: "x".repeat(501) }] }],
    ["invalid stable value", { ...request, questions: [{
      ...request.questions[0],
      recommended: "first",
      options: [
        { value: "not stable", label: "First" },
        { value: "first", label: "Second" }
      ]
    }] }],
    ["missing option label", { ...request, questions: [{
      ...request.questions[0],
      recommended: "first",
      options: [
        { value: "first" },
        { value: "second", label: "Second" }
      ]
    }] }],
    ["six options", { ...request, questions: [{
      ...request.questions[0],
      options: Array.from({ length: 6 }, (_, index) => ({ value: `value-${index}`, label: `Value ${index}` }))
    }] }],
    ["duplicate option values", { ...request, questions: [{
      ...request.questions[0],
      options: [
        { value: "same", label: "First" },
        { value: "same", label: "Second" }
      ]
    }] }],
    ["duplicate option labels", { ...request, questions: [{
      ...request.questions[0],
      options: [
        { value: "first", label: "Same" },
        { value: "second", label: "same" }
      ]
    }] }],
    ["blank option label", { ...request, questions: [{
      ...request.questions[0],
      recommended: "first",
      options: [
        { value: "first", label: "   " },
        { value: "second", label: "Second" }
      ]
    }] }],
    ["undeclared recommendation", { ...request, questions: [{
      ...request.questions[0],
      recommended: "missing"
    }] }],
    ["English secret prompt", { ...request, message: "Enter your API key" }],
    ["English payment prompt", { ...request, message: "Enter your credit card number" }],
    ["Chinese payment prompt", { ...request, message: "请输入银行卡号" }],
    ["Chinese secret label", { ...request, questions: [{
      ...request.questions[0],
      options: [
        { value: "first", label: "输入密码" },
        { value: "second", label: "Skip" }
      ]
    }] }]
  ])("rejects %s before opening a form", async (_label, invalid) => {
    const handler = vi.fn(async () => ({
      action: "accept" as const,
      content: { scope: "platform-packages" }
    }));
    await connect({ elicitation: { form: {} } }, handler);

    const result = await call("structured_choice_request", invalid as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    if (_label.includes("secret") || _label.includes("payment")) {
      expect(JSON.stringify(result)).not.toContain(
        _label === "English secret prompt"
          ? "Enter your API key"
          : _label === "English payment prompt"
            ? "Enter your credit card number"
            : _label === "Chinese payment prompt"
              ? "请输入银行卡号"
              : "输入密码"
      );
    }
  });

  it.each([
    ["missing field", {}],
    ["unknown field", { scope: "platform-packages", extra: "value" }],
    ["non-string value", { scope: 1 }],
    ["undeclared value", { scope: "other" }]
  ])("rejects an accepted response with %s without echoing its content", async (_label, content) => {
    await connect({ elicitation: { form: {} } }, async () => ({ action: "accept", content }));

    const result = await call("structured_choice_request", request);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "ELICITATION_RESPONSE_INVALID" });
    for (const value of Object.values(content)) {
      expect(JSON.stringify(result.structuredContent)).not.toContain(String(value));
    }
  });

  it("does not expose a handler exception or mutate the project", async () => {
    await connect({ elicitation: { form: {} } }, async () => {
      throw new Error("private handler detail");
    });

    const result = await call("structured_choice_request", request);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "UNEXPECTED" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("private handler detail");
  });

  it("maps an aborted helper request to cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const protocol = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: vi.fn(async () => ({
        action: "accept" as const,
        content: { scope: "platform-packages" }
      }))
    };

    await expect(requestStructuredChoice(
      protocol as never,
      StructuredChoiceRequestSchema.parse(request),
      controller.signal
    )).resolves.toEqual({ outcome: "cancelled" });
    expect(protocol.elicitInput).not.toHaveBeenCalled();
  });

  it("does not accept a response after the request aborts during elicitation", async () => {
    const controller = new AbortController();
    const protocol = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: vi.fn(async () => {
        controller.abort();
        return {
          action: "accept" as const,
          content: { scope: "platform-packages" }
        };
      })
    };

    await expect(requestStructuredChoice(
      protocol as never,
      StructuredChoiceRequestSchema.parse(request),
      controller.signal
    )).resolves.toEqual({ outcome: "cancelled" });
  });

  async function connect(
    capabilities: Record<string, unknown>,
    handler: ((request: Parameters<Parameters<Client["setRequestHandler"]>[1]>[0]) => Promise<unknown>) | undefined
  ): Promise<void> {
    server = createAgentFlowMcpServer({ projectRoot: directory });
    client = new Client(
      { name: "structured-input-test", version: "1.0.0" },
      { capabilities }
    );
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  async function call(name: string, args: Record<string, unknown>) {
    if (!client) throw new Error("Client is not connected");
    return client.callTool({ name, arguments: args });
  }
});

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await visit(root, "");
  return result;

  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = join(prefix, entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) result[relative.replaceAll("\\", "/")] = (await readFile(absolute)).toString("base64");
    }
  }
}
