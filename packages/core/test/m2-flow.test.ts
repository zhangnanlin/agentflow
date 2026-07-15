import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  artifactPayloadHash,
  sha256,
  validatePipeline,
  type Actor,
  type ArtifactContractKind,
  type MutationContext,
  type RunState
} from "../src/index.js";

const figmaCapabilities = [
  "host.worker.spawn",
  "host.worker.collect",
  "figma.remote.connected",
  "figma.remote.authenticated",
  "figma.tool.whoami",
  "figma.tool.create_new_file",
  "figma.tool.use_figma",
  "figma.tool.get_metadata",
  "figma.tool.get_screenshot",
  "skill.figma-use"
];

const pipeline = validatePipeline({
  id: "m2-product-design",
  version: "1",
  name: "M2 product and concept flow",
  stages: [
    { id: "S01", name: "Discovery", requiredArtifactKinds: ["product-brief"] },
    {
      id: "S02",
      name: "PRD",
      dependsOn: ["S01"],
      requiredArtifactKinds: ["prd"],
      requiredGate: {
        id: "requirements-approved",
        type: "human",
        question: "Approve requirements?",
        options: ["approve", "reject"]
      }
    },
    { id: "S03", name: "UX Architecture", dependsOn: ["S02"], requiredArtifactKinds: ["ux-architecture"] },
    {
      id: "S04",
      name: "Design Concepts",
      dependsOn: ["S03"],
      requiredCapabilities: figmaCapabilities,
      requiredArtifactKinds: ["design-concepts"],
      requiredGate: {
        id: "design-direction-approved",
        type: "human",
        question: "Choose a direction?",
        options: ["A", "B", "C", "mixed", "reject"]
      }
    }
  ]
});

const supervisor: Actor = { id: "supervisor-m2", kind: "supervisor" };
const user: Actor = { id: "user-m2", kind: "user" };
const writer: Actor = { id: "figma-writer", kind: "worker" };
const capabilities = { spawn: true, send: true, status: true, collect: true, interrupt: true, close: false };

describe("M2 product-to-Figma concept flow", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("validates product artifacts and enforces one sequential Figma writer before direction choice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-m2-"));
    directories.push(directory);
    const engine = new AgentFlowEngine(new JsonRunStore(directory), pipeline);
    let key = 0;
    const context = (state: RunState, actor: Actor, operation: string): MutationContext => ({
      expectedRevision: state.revision,
      idempotencyKey: `${operation}-${++key}`,
      actor,
      reason: operation
    });

    let state = await engine.createRun({ id: "run-m2", requirement: "Design a small-team project planner" });
    const brief = productBrief();
    state = await registerContract(engine, state, "brief-1", "S01", "product-brief", brief, context);
    state = await engine.completeStage(state.id, "S01", context(state, supervisor, "complete-discovery"));

    const briefHash = artifactPayloadHash("product-brief", brief);
    const prd = prdPayload(briefHash);
    state = await registerContract(engine, state, "prd-1", "S02", "prd", prd, context);
    state = await engine.resolveGate(state.id, {
      gateId: "requirements-approved",
      decision: "approved",
      resolution: "Scope approved for UX"
    }, context(state, user, "approve-requirements"));
    state = await engine.completeStage(state.id, "S02", context(state, supervisor, "complete-prd"));

    const prdHash = artifactPayloadHash("prd", prd);
    const ux = uxPayload(prdHash);
    state = await registerContract(engine, state, "ux-1", "S03", "ux-architecture", ux, context);
    state = await engine.completeStage(state.id, "S03", context(state, supervisor, "complete-ux"));
    expect(state.activeStageId).toBe("S04");

    state = await engine.createTask(state.id, {
      id: "figma-concepts",
      stageId: "S04",
      title: "Render comparable A, B, and C concepts"
    }, context(state, supervisor, "create-figma-writer-task"));
    state = await engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: ["host.worker.spawn", "host.worker.collect"],
      ttlSeconds: 900
    }, context(state, supervisor, "figma-not-exposed"));
    expect(state).toMatchObject({ status: "blocked", activeStageId: "S04" });
    expect(state.tasks["figma-concepts"]?.status).toBe("pending");
    expect(state.workers).toEqual({});
    expect(state.resources).toEqual({});
    expect(state.artifacts["design-concepts"]).toBeUndefined();
    expect(state.gates["design-direction-approved"]?.status).toBe("pending");

    state = await engine.loadRun(state.id);
    state = await engine.reportStagePreflight(state.id, {
      stageId: "S04",
      host: "codex",
      availableCapabilities: figmaCapabilities,
      ttlSeconds: 900
    }, context(state, supervisor, "figma-live-after-oauth"));
    expect(state).toMatchObject({ status: "active", activeStageId: "S04" });
    expect(state.tasks["figma-concepts"]?.status).toBe("ready");
    state = await engine.claimTask(
      state.id,
      "figma-concepts",
      writer.id,
      300,
      context(state, writer, "claim-figma-writer")
    );
    state = await engine.prepareWorker(state.id, {
      workerId: writer.id,
      taskId: "figma-concepts",
      adapter: "codex",
      hostTaskName: "af_run_m2_figma_concepts_writer",
      promptHash: sha256("render A B C sequentially"),
      capabilities
    }, context(state, supervisor, "prepare-figma-writer"));
    state = await engine.bindWorker(
      state.id,
      writer.id,
      "codex-figma-writer-thread",
      context(state, supervisor, "bind-figma-writer")
    );
    state = await engine.acquireResource(state.id, {
      resourceId: "figma-main",
      kind: "figma-file",
      resourceKey: "figma-file-key-m2",
      stageId: "S04",
      taskId: "figma-concepts",
      owner: writer.id,
      leaseSeconds: 300,
      metadata: { fileKey: "figma-file-key-m2" }
    }, context(state, writer, "acquire-figma-file"));

    for (const [label, index] of [["A", 1], ["B", 2], ["C", 3]] as const) {
      const operationId = `render-${label.toLowerCase()}`;
      state = await engine.beginResourceOperation(
        state.id,
        "figma-main",
        writer.id,
        operationId,
        "figma.use_figma.write",
        context(state, writer, `begin-${operationId}`)
      );
      state = await engine.finishResourceOperation(state.id, "figma-main", writer.id, {
        operationId,
        status: "completed",
        resultHash: sha256(`figma-result-${label}`),
        affectedNodeIds: [`page:${index}`, `screen:${index}`],
        summary: `Rendered direction ${label}`
      }, context(state, writer, `finish-${operationId}`));
      state = await engine.registerArtifact(state.id, {
        id: `concept-${label.toLowerCase()}-shot`,
        stageId: "S04",
        kind: "design-screenshot",
        uri: `.agentflow/artifacts/concept-${label.toLowerCase()}.png`,
        sha256: sha256(`screenshot-${label}`),
        producedBy: writer.id
      }, context(state, writer, `register-shot-${label}`));
    }
    state = await engine.releaseResource(
      state.id,
      "figma-main",
      writer.id,
      "All three concept writes completed",
      context(state, writer, "release-figma-file")
    );
    state = await engine.collectWorkerResult(state.id, writer.id, {
      workerId: writer.id,
      taskId: "figma-concepts",
      status: "completed",
      summary: "Rendered and validated three comparable concepts.",
      artifacts: [],
      changeSet: null,
      verification: [{
        command: "get_metadata + get_screenshot for A, B, C",
        status: "passed",
        summary: "All concepts rendered",
        recordedAt: new Date().toISOString()
      }],
      risks: [],
      followUps: [],
      completedAt: new Date().toISOString()
    }, context(state, supervisor, "collect-figma-writer"));

    const concepts = conceptSet(artifactPayloadHash("ux-architecture", ux));
    state = await registerContract(engine, state, "concept-set-1", "S04", "design-concepts", concepts, context);
    await expect(engine.resolveGate(state.id, {
      gateId: "design-direction-approved",
      decision: "approved",
      resolution: "Prefer the dense operational layout"
    }, context(state, user, "approve-without-direction"))).rejects.toMatchObject({ code: "GATE_CHOICE_REQUIRED" });

    state = await engine.resolveGate(state.id, {
      gateId: "design-direction-approved",
      decision: "approved",
      choice: "B",
      resolution: "Prefer the dense operational layout"
    }, context(state, user, "approve-direction-b"));
    state = await engine.completeStage(state.id, "S04", context(state, supervisor, "complete-concepts"));

    expect(state.status).toBe("completed");
    expect(state.gates["design-direction-approved"]?.selectedOption).toBe("B");
    expect(state.resources["figma-main"]).toMatchObject({ status: "released", owner: writer.id });
    expect(state.resources["figma-main"]?.operations.map((operation) => operation.id)).toEqual(["render-a", "render-b", "render-c"]);
  });
});

async function registerContract(
  engine: AgentFlowEngine,
  state: RunState,
  artifactId: string,
  stageId: string,
  kind: ArtifactContractKind,
  payload: unknown,
  context: (state: RunState, actor: Actor, operation: string) => MutationContext
): Promise<RunState> {
  return engine.registerArtifact(state.id, {
    id: artifactId,
    stageId,
    kind,
    uri: `.agentflow/artifacts/${artifactId}.json`,
    sha256: artifactPayloadHash(kind, payload),
    producedBy: "supervisor-m2",
    metadata: { contract: { kind, version: 1 } }
  }, context(state, supervisor, `register-${artifactId}`));
}

function productBrief() {
  return {
    version: 1 as const,
    title: "Team planner",
    summary: "A project planner for small teams.",
    projectType: "new" as const,
    users: [{ name: "team lead", needs: ["shared priorities"], context: "weekly planning" }],
    problem: { statement: "Plans are scattered.", evidence: [], impact: "Coordination is slow." },
    outcomes: ["One current plan"],
    inScope: ["Projects and tasks"],
    outOfScope: ["Portfolio finance"],
    constraints: [],
    successMetrics: [{ name: "planning time", target: "under 15 minutes", measurement: "session analytics" }],
    approaches: [
      { id: "A", summary: "Board first", benefits: ["Scannable"], costs: ["Less dense"] },
      { id: "B", summary: "List first", benefits: ["Dense"], costs: ["Less spatial"] }
    ],
    recommendedApproachId: "A",
    dependencies: [], risks: [], openQuestions: [], approvedDecisions: []
  };
}

function prdPayload(briefHash: string) {
  return {
    version: 1 as const,
    title: "Team planner",
    summary: "Approved requirements.",
    sourceProductBrief: { artifactId: "brief-1", sha256: briefHash },
    goals: ["Reduce planning time"],
    nonGoals: ["Enterprise portfolio management"],
    userStories: [{
      id: "story-1", actor: "team lead", capability: "create a project", benefit: "share a plan",
      acceptanceCriteria: ["A valid project appears"]
    }],
    functionalRequirements: [{
      id: "fr-1", description: "Create projects", priority: "must" as const,
      acceptanceCriteria: ["Empty names are rejected"]
    }],
    nonFunctionalRequirements: [{
      id: "nfr-a11y", category: "accessibility" as const, target: "WCAG 2.2 AA", measurement: "axe and keyboard checks"
    }],
    constraints: [], dependencies: [], risks: [], openQuestions: []
  };
}

function uxPayload(prdHash: string) {
  return {
    version: 1 as const,
    sourcePrd: { artifactId: "prd-1", sha256: prdHash },
    roles: [{ id: "lead", name: "Team lead", permissions: ["manage projects"] }],
    screens: [{
      id: "project-board", name: "Project board", purpose: "Plan work", route: "/projects/:id",
      supportedRoles: ["lead"], states: ["loading", "empty", "ready", "error"] as const
    }],
    journeys: [{
      id: "plan", roleId: "lead", goal: "Plan work",
      steps: [{ id: "open", screenId: "project-board", action: "Open project", outcome: "Board shown", exceptions: [] }]
    }],
    navigation: [],
    responsiveModes: [{ id: "mobile", minWidth: 0, maxWidth: 767, behavior: "Single column" }],
    contentDependencies: [], dataDependencies: ["Project API"], accessibilityRequirements: ["Keyboard operable"]
  };
}

function conceptSet(uxHash: string) {
  const option = (label: "A" | "B" | "C", index: number) => ({
    id: `concept-${label.toLowerCase()}`,
    label,
    title: `Direction ${label}`,
    briefArtifactId: `concept-${label.toLowerCase()}-brief`,
    visualLanguage: `Language ${label}`,
    layoutPrinciples: ["Clear hierarchy"],
    interactionPrinciples: ["Visible status"],
    differentiators: [`Difference ${label}`],
    risks: [],
    figmaPageNodeId: `page:${index}`,
    representativeNodeIds: [`screen:${index}`],
    screenshot: { artifactId: `concept-${label.toLowerCase()}-shot`, sha256: sha256(`screenshot-${label}`) }
  });
  return {
    version: 1 as const,
    sourceUxArchitecture: { artifactId: "ux-1", sha256: uxHash },
    figmaFile: { fileKey: "figma-file-key-m2", url: "https://www.figma.com/design/figma-file-key-m2/AgentFlow" },
    representativeScreenId: "project-board",
    concepts: [option("A", 1), option("B", 2), option("C", 3)],
    comparisonCriteria: [
      { id: "clarity", name: "Clarity", description: "Ease of scanning" },
      { id: "density", name: "Density", description: "Information visible at once" }
    ],
    writer: { workerId: writer.id, resourceId: "figma-main", operationIds: ["render-a", "render-b", "render-c"] }
  };
}
