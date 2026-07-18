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
const REQUEST_SIGNAL_PATTERNS: ReadonlyArray<readonly [RoutingSignal, RegExp]> = [
  ["full-override", /(?:\bagentflow\s*:\s*full\b|\bfull(?:\s+lane|\s+override)\b)/u],
  ["release", /(?:\breleas(?:e|es|ed|ing)\b|\brelease\s+plan\b|\u53d1\u884c)/u],
  ["deployment", /(?:\bdeploy(?:s|ed|ing|ment|ments)?\b|\bproduction\s+rollout\b|\u90e8\u7f72|\u4e0a\u7ebf)/u],
  ["migration", /(?:\bmigrat(?:e|es|ed|ing|ion|ions)\b|\bschema\s+migration\b|\u8fc1\u79fb|\u6570\u636e\u5e93\u53d8\u66f4)/u],
  ["destructive-git", /(?:\bforce[-\s]?push\b|\bgit\s+reset\s+--hard\b|\brewrite\s+(?:git\s+)?history\b|\bdelete\s+(?:a\s+)?remote\s+ref\b|\u5f3a\u63a8|\u91cd\u5199[^\n]{0,16}\u5386\u53f2|\u5220\u9664[^\n]{0,16}\u8fdc\u7aef)/u],
  ["security-sensitive", /(?:\bsecurity(?:-sensitive)?\b|\bauthentication\b|\bauthorization\b|\bcredential(?:s)?\b|\bencryption\b|\bpermission\s+boundary\b|\u5b89\u5168|\u9274\u6743|\u8ba4\u8bc1|\u6388\u6743|\u51ed\u636e|\u5bc6\u94a5|\u6743\u9650\u8fb9\u754c)/u],
  ["cross-module-contract", /(?:\bcross[-\s](?:module|package)\s+contract\b|\bpublic\s+api\s+contract\b|\bschema\s+contract\b|\bprotocol\s+change\b|\u8de8\u6a21\u5757[^\n]{0,16}\u5951\u7ea6|\u8de8\u5305[^\n]{0,16}\u5951\u7ea6|\u63a5\u53e3\u5951\u7ea6|\u534f\u8bae\u53d8\u66f4)/u],
  ["publication", /(?:\bpublish(?:es|ed|ing)?\b|\bpackage\s+publication\b|\bnpm\s+publish\b|\u53d1\u5e03(?:\u5305|\u8f6f\u4ef6\u5305))/u],
  ["standard-scope", /(?:\b(?:multiple|several|two)\s+(?:modules|packages|components)\b|\bmulti[-\s](?:module|package|component)\b|\bapi\s+and\s+(?:its\s+)?caller\b|\bclient\s+and\s+server\b|\u591a\u4e2a\u6a21\u5757|\u591a\u6a21\u5757|\u591a\u4e2a\u5305|\u524d\u540e\u7aef)/u]
];

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

export function classifyRoutingSignals(requirement: string): RoutingSignal[] {
  const normalized = requirement.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
  return REQUEST_SIGNAL_PATTERNS
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([signal]) => RoutingSignalSchema.parse(signal))
    .sort();
}

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
