import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  defaultPipeline,
  escalateWorkflow,
  evaluateWorkflowPolicy,
  resolveRecommendedChoice
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function engine() {
  const directory = await mkdtemp(join(tmpdir(), "agentflow-routing-"));
  temporaryDirectories.push(directory);
  return new AgentFlowEngine(new JsonRunStore(directory), defaultPipeline);
}

describe("workflow policy", () => {
  it("selects a four-stage Quick lane for a low-risk existing project change", () => {
    const result = evaluateWorkflowPolicy({
      requirement: "Change one isolated parser",
      projectType: "existing",
      hasUi: false,
      signals: [],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    });

    expect(result).toMatchObject({
      lane: "quick",
      policyVersion: "2026-07-18.1",
      signals: ["low-risk"]
    });
    expect(result.eligibleStageIds).toEqual(["S00", "S11", "S13", "S15"]);
    expect(result.eligibleStageIds).toHaveLength(4);
    expect(evaluateWorkflowPolicy({
      requirement: "Change one isolated parser",
      projectType: "existing",
      hasUi: false,
      signals: [],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    })).toEqual(result);
  });

  it("selects Standard for a bounded multi-module behavior change", () => {
    const result = evaluateWorkflowPolicy({
      requirement: "Change a bounded API and its caller",
      projectType: "existing",
      hasUi: false,
      signals: ["standard-scope"],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    });

    expect(result.lane).toBe("standard");
    expect(result.eligibleStageIds).toEqual(["S00", "S01", "S02", "S09", "S10", "S11", "S12", "S13", "S15"]);
  });

  it.each([
    "release",
    "deployment",
    "migration",
    "destructive-git",
    "security-sensitive",
    "ui",
    "cross-module-contract",
    "publication"
  ] as const)("selects Full for high-risk signal %s", (signal) => {
    const result = evaluateWorkflowPolicy({
      requirement: "Handle " + signal,
      projectType: "existing",
      hasUi: signal === "ui",
      signals: [signal],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    });

    expect(result.lane).toBe("full");
    expect(result.eligibleStageIds).toEqual(defaultPipeline.stages.map((stage) => stage.id));
  });

  it("only escalates and never downgrades", () => {
    const quick = evaluateWorkflowPolicy({
      requirement: "Start small",
      projectType: "existing",
      hasUi: false,
      signals: [],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    });
    const full = escalateWorkflow(quick, {
      requirement: "Migration discovered",
      projectType: "existing",
      hasUi: false,
      signals: ["migration"],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    });
    const unchanged = escalateWorkflow(full, {
      requirement: "Later isolated detail",
      projectType: "existing",
      hasUi: false,
      signals: [],
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    });

    expect(full.lane).toBe("full");
    expect(unchanged).toEqual(full);
  });

  it("normalizes signal order for deterministic routing evidence", () => {
    const input = {
      requirement: "Migrate a cross-module contract",
      projectType: "existing" as const,
      hasUi: false,
      pipelineId: defaultPipeline.id,
      stageIds: defaultPipeline.stages.map((stage) => stage.id)
    };

    expect(evaluateWorkflowPolicy({
      ...input,
      signals: ["migration", "cross-module-contract"]
    })).toEqual(evaluateWorkflowPolicy({
      ...input,
      signals: ["cross-module-contract", "migration"]
    }));
  });

  it("uses recommendations only for non-mandatory choices", () => {
    expect(resolveRecommendedChoice({ mandatory: false, recommended: "quick" })).toEqual({
      status: "resolved",
      choice: "quick",
      source: "recommended"
    });
    expect(resolveRecommendedChoice({ mandatory: true, recommended: "approve" })).toEqual({
      status: "pending"
    });
    expect(resolveRecommendedChoice({ mandatory: true, recommended: "approve", selected: "reject" })).toEqual({
      status: "resolved",
      choice: "reject",
      source: "explicit"
    });
  });
});

describe("lane-aware Stage activation", () => {
  it("automatically skips ineligible Quick stages after intake", async () => {
    const flow = await engine();
    let state = await flow.createRun({
      id: "run-quick-stages",
      requirement: "Small change",
      projectType: "existing",
      hasUi: false,
      routingSignals: []
    });
    state = await flow.registerArtifact(state.id, {
      id: "context",
      stageId: "S00",
      kind: "project-context",
      uri: "context.json",
      sha256: "a".repeat(64),
      producedBy: "supervisor"
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "register-context",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await flow.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete-intake",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(state.workflow.lane).toBe("quick");
    expect(state.activeStageId).toBe("S11");
    expect(Object.values(state.stages).filter((stage) => stage.status === "active")).toHaveLength(1);
    expect(state.workflow.policySkippedStageIds).toEqual(["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10"]);
  });

  it("activates Full stages when risk is discovered before advancement", async () => {
    const flow = await engine();
    let state = await flow.createRun({
      id: "run-escalated-stages",
      requirement: "Small change",
      projectType: "existing",
      hasUi: false,
      routingSignals: []
    });
    state = await flow.escalateRunWorkflow(state.id, ["migration", "cross-module-contract"], {
      expectedRevision: state.revision,
      idempotencyKey: "escalate-migration",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await flow.registerArtifact(state.id, {
      id: "context",
      stageId: "S00",
      kind: "project-context",
      uri: "context.json",
      sha256: "b".repeat(64),
      producedBy: "supervisor"
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "register-context",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await flow.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete-intake",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(state.workflow.lane).toBe("full");
    expect(state.activeStageId).toBe("S01");
    expect(state.workflow.escalations).toHaveLength(1);
  });

  it("reopens untouched policy-skipped stages when later evidence escalates the lane", async () => {
    const flow = await engine();
    let state = await flow.createRun({
      id: "run-late-escalation",
      requirement: "Small change",
      projectType: "existing",
      hasUi: false,
      routingSignals: []
    });
    state = await flow.registerArtifact(state.id, {
      id: "context",
      stageId: "S00",
      kind: "project-context",
      uri: "context.json",
      sha256: "c".repeat(64),
      producedBy: "supervisor"
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "register-context",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    state = await flow.completeStage(state.id, "S00", {
      expectedRevision: state.revision,
      idempotencyKey: "complete-intake",
      actor: { id: "supervisor", kind: "supervisor" }
    });
    expect(state.activeStageId).toBe("S11");

    state = await flow.escalateRunWorkflow(state.id, ["migration", "cross-module-contract"], {
      expectedRevision: state.revision,
      idempotencyKey: "escalate-after-intake",
      actor: { id: "supervisor", kind: "supervisor" }
    });

    expect(state.workflow.lane).toBe("full");
    expect(state.activeStageId).toBe("S01");
    expect(state.stages.S01?.status).toBe("active");
    expect(state.stages.S11?.status).toBe("pending");
    expect(state.workflow.policySkippedStageIds).toEqual([]);
    expect(state.workflow.escalations[0]?.signals).toEqual(["cross-module-contract", "migration"]);
  });
});
