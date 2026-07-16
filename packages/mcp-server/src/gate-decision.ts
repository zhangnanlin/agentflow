import {
  AgentFlowError,
  canonicalJson,
  sha256,
  type AgentFlowEngine,
  type MutationContext,
  type RunState
} from "@agentflow/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  StructuredChoiceRequestSchema,
  requestStructuredChoice,
  type StructuredChoiceOutcome
} from "./structured-input.js";

const IdentifierSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const GateDecisionRequestSchema = z.object({
  projectRoot: z.string().min(1).max(4_096).optional(),
  runId: IdentifierSchema,
  gateId: IdentifierSchema,
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(256),
  actorId: IdentifierSchema,
  reason: z.string().min(1).max(2_000)
}).strict();

export type GateDecisionRequest = z.infer<typeof GateDecisionRequestSchema>;
export type GateDecisionOutcome =
  | { outcome: "accepted"; state: RunState }
  | { outcome: "replayed"; state: RunState }
  | Exclude<StructuredChoiceOutcome, { outcome: "accepted" }>;

export function gateDecisionInputHash(input: GateDecisionRequest): string {
  return sha256(canonicalJson({
    operation: "gate.resolve",
    runId: input.runId,
    gateId: input.gateId,
    expectedRevision: input.expectedRevision,
    actorId: input.actorId,
    reason: input.reason
  }));
}

export function mapGateSelection(value: string): {
  decision: "approved" | "rejected";
  choice?: string;
} {
  const normalized = value.toLowerCase();
  return normalized === "reject" || normalized === "rejected"
    ? { decision: "rejected" }
    : { decision: "approved", choice: value };
}

export async function requestGateDecision(
  protocol: McpServer["server"],
  engine: AgentFlowEngine,
  initialState: RunState,
  input: GateDecisionRequest,
  context: MutationContext,
  signal: AbortSignal
): Promise<GateDecisionOutcome> {
  const inputHash = gateDecisionInputHash(input);
  const prior = initialState.idempotency[input.idempotencyKey];
  if (prior !== undefined) {
    if (prior.operation !== "gate.resolve" || prior.inputHash !== inputHash) {
      throw new AgentFlowError(
        "Idempotency key input does not match the recorded Gate decision",
        "IDEMPOTENCY_CONFLICT",
        { idempotencyKey: input.idempotencyKey }
      );
    }
    return { outcome: "replayed", state: initialState };
  }

  const inspection = await engine.inspectHumanGate(input.runId, input.gateId, input.expectedRevision);
  const choiceRequest = persistedGateChoiceRequest(inspection.gate.question, inspection.gate.options);
  const choiceOutcome = await requestStructuredChoice(protocol, choiceRequest, signal);
  if (choiceOutcome.outcome !== "accepted") return choiceOutcome;

  const selection = choiceOutcome.answers["decision"];
  if (selection === undefined) {
    throw new AgentFlowError(
      "The Gate elicitation response did not include a decision",
      "ELICITATION_RESPONSE_INVALID"
    );
  }
  const mapped = mapGateSelection(selection);
  if (signal.aborted) return { outcome: "cancelled" };
  const state = await engine.resolveGate(input.runId, {
    gateId: input.gateId,
    decision: mapped.decision,
    resolution: input.reason,
    ...(mapped.choice === undefined ? {} : { choice: mapped.choice })
  }, { ...context, inputHash });

  const resolvedGate = state.gates[input.gateId];
  const matches = resolvedGate?.status === mapped.decision
    && (mapped.decision === "rejected" || resolvedGate.selectedOption === mapped.choice);
  if (!matches) {
    throw new AgentFlowError(
      "Concurrent Gate decision conflicts with the accepted selection",
      "IDEMPOTENCY_CONFLICT",
      { idempotencyKey: input.idempotencyKey, gateId: input.gateId }
    );
  }
  return { outcome: "accepted", state };
}

function persistedGateChoiceRequest(
  question: string,
  options: string[]
): z.infer<typeof StructuredChoiceRequestSchema> {
  const uniqueValues = new Set(options);
  const uniqueLabels = new Set(options.map((option) => option.toLocaleLowerCase("en-US")));
  if (
    options.length < 2
    || options.length > 5
    || uniqueValues.size !== options.length
    || uniqueLabels.size !== options.length
  ) {
    throw invalidGateOptions();
  }
  const parsed = StructuredChoiceRequestSchema.safeParse({
    message: question,
    questions: [{
      id: "decision",
      prompt: question,
      options: options.map((option) => ({ value: option, label: option }))
    }]
  });
  if (!parsed.success) throw invalidGateOptions();
  return parsed.data;
}

function invalidGateOptions(): AgentFlowError {
  return new AgentFlowError(
    "Persisted Gate options are not a valid bounded choice set",
    "GATE_OPTIONS_INVALID"
  );
}
