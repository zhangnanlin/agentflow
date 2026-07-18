import {
  RoutingSignalSchema,
  WorkflowStateSchema,
  type RoutingSignal,
  type WorkflowLane,
  type WorkflowState
} from "./model.js";

export const WORKFLOW_POLICY_VERSION = "2026-07-18.1";

const HIGH_RISK_SIGNALS = new Set<RoutingSignal>([
  "release",
  "deployment",
  "migration",
  "destructive-git",
  "security-sensitive",
  "ui",
  "cross-module-contract",
  "publication",
  "full-override",
  "unsupported-pipeline"
]);
const LANE_RANK: Record<WorkflowLane, number> = { quick: 0, standard: 1, full: 2 };
const QUICK_STAGE_IDS = new Set(["S00", "S11", "S13", "S15"]);
const STANDARD_STAGE_IDS = new Set(["S00", "S01", "S02", "S09", "S10", "S11", "S12", "S13", "S15"]);

export interface WorkflowPolicyInput {
  requirement: string;
  projectType: "new" | "existing";
  hasUi: boolean;
  signals: RoutingSignal[];
  pipelineId: string;
  stageIds: string[];
  override?: "full";
}

export type RecommendedChoiceResult =
  | { status: "pending" }
  | { status: "resolved"; choice: string; source: "explicit" | "recommended" };

export function evaluateWorkflowPolicy(input: WorkflowPolicyInput): WorkflowState {
  const signals = uniqueSignals([
    ...input.signals,
    ...(input.hasUi ? ["ui" as const] : []),
    ...(input.projectType === "new" ? ["new-project" as const] : []),
    ...(input.override === "full" ? ["full-override" as const] : []),
    ...(input.pipelineId === "agentflow-default" ? [] : ["unsupported-pipeline" as const])
  ]);
  if (signals.length === 0) signals.push("low-risk");
  const lane: WorkflowLane = signals.some((signal) => HIGH_RISK_SIGNALS.has(signal))
    ? "full"
    : signals.includes("standard-scope") || signals.includes("new-project")
      ? "standard"
      : "quick";
  const eligibleStageIds = lane === "full"
    ? [...input.stageIds]
    : input.stageIds.filter((stageId) => (lane === "quick" ? QUICK_STAGE_IDS : STANDARD_STAGE_IDS).has(stageId));

  return WorkflowStateSchema.parse({
    policyVersion: WORKFLOW_POLICY_VERSION,
    lane,
    signals,
    explanation: `Selected ${lane} from signals: ${signals.join(", ")}.`,
    eligibleStageIds,
    policySkippedStageIds: [],
    escalations: []
  });
}

export function escalateWorkflow(current: WorkflowState, evidence: WorkflowPolicyInput): WorkflowState {
  const evaluated = evaluateWorkflowPolicy(evidence);
  if (LANE_RANK[evaluated.lane] <= LANE_RANK[current.lane]) return current;
  const signals = uniqueSignals([...current.signals, ...evaluated.signals]);
  return WorkflowStateSchema.parse({
    ...evaluated,
    signals,
    explanation: `Escalated to ${evaluated.lane} from signals: ${signals.join(", ")}.`,
    policySkippedStageIds: current.policySkippedStageIds,
    escalations: current.escalations
  });
}

export function legacyFullWorkflow(stageIds: string[]): WorkflowState {
  return WorkflowStateSchema.parse({
    policyVersion: "legacy-0.4.0",
    lane: "full",
    signals: ["legacy-full"],
    explanation: "Existing callers and migrated Runs retain the complete legacy pipeline.",
    eligibleStageIds: stageIds,
    policySkippedStageIds: [],
    escalations: []
  });
}

export function resolveRecommendedChoice(input: {
  mandatory: boolean;
  recommended: string;
  selected?: string;
}): RecommendedChoiceResult {
  if (input.selected !== undefined) return { status: "resolved", choice: input.selected, source: "explicit" };
  if (input.mandatory) return { status: "pending" };
  return { status: "resolved", choice: input.recommended, source: "recommended" };
}

export function requiredArtifactKindsForLane(
  lane: WorkflowLane,
  stageId: string,
  requiredArtifactKinds: string[]
): string[] {
  if (lane === "full" || stageId === "S00") return requiredArtifactKinds;
  if (stageId === "S15") return [];
  if (lane === "quick" && ["S11", "S13"].includes(stageId)) return [];
  return requiredArtifactKinds;
}

function uniqueSignals(values: RoutingSignal[]): RoutingSignal[] {
  return [...new Set(values.map((value) => RoutingSignalSchema.parse(value)))].sort();
}
