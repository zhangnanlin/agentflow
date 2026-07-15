import { invariant } from "./errors.js";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
  type RunState,
  type StageSpec
} from "./model.js";

export function validatePipeline(input: unknown): PipelineDefinition {
  const pipeline = PipelineDefinitionSchema.parse(input);
  const ids = new Set<string>();

  for (const stage of pipeline.stages) {
    invariant(!ids.has(stage.id), `Duplicate stage id: ${stage.id}`, "PIPELINE_DUPLICATE_STAGE");
    ids.add(stage.id);
  }

  for (const stage of pipeline.stages) {
    for (const dependency of stage.dependsOn) {
      invariant(ids.has(dependency), `Unknown dependency ${dependency} for ${stage.id}`, "PIPELINE_UNKNOWN_DEPENDENCY");
      invariant(dependency !== stage.id, `Stage ${stage.id} cannot depend on itself`, "PIPELINE_SELF_DEPENDENCY");
    }
    invariant(
      new Set(stage.requiredCapabilities).size === stage.requiredCapabilities.length,
      `Stage ${stage.id} has duplicate required capabilities`,
      "PIPELINE_DUPLICATE_CAPABILITY"
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    invariant(!visiting.has(id), `Pipeline contains a cycle at ${id}`, "PIPELINE_CYCLE");
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const stage of pipeline.stages) visit(stage.id);
  return pipeline;
}

export function stageById(pipeline: PipelineDefinition, id: string): StageSpec {
  const stage = pipeline.stages.find((candidate) => candidate.id === id);
  invariant(stage, `Unknown stage: ${id}`, "STAGE_NOT_FOUND", { stageId: id });
  return stage;
}

export function readyStages(pipeline: PipelineDefinition, run: RunState): StageSpec[] {
  return pipeline.stages.filter((stage) => {
    const stageRun = run.stages[stage.id];
    if (!stageRun || !["pending", "ready", "stale"].includes(stageRun.status)) return false;
    return stage.dependsOn.every((dependency) => {
      const dependencyStatus = run.stages[dependency]?.status;
      return dependencyStatus === "completed" || dependencyStatus === "skipped";
    });
  });
}

export function downstreamStageIds(pipeline: PipelineDefinition, sourceId: string): string[] {
  const result = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const stage of pipeline.stages) {
      if (result.has(stage.id) || stage.id === sourceId) continue;
      if (stage.dependsOn.includes(sourceId) || stage.dependsOn.some((id) => result.has(id))) {
        result.add(stage.id);
        changed = true;
      }
    }
  }

  return [...result];
}

export const defaultPipeline = validatePipeline({
  id: "agentflow-default",
  version: "0.4.0",
  name: "AgentFlow default software delivery pipeline",
  stages: [
    { id: "S00", name: "Intake", skills: ["agentflow-orchestrator"], requiredArtifactKinds: ["project-context"] },
    { id: "S01", name: "Discovery", dependsOn: ["S00"], skills: ["brainstorming", "agentflow-product-discovery"], requiredArtifactKinds: ["product-brief"] },
    { id: "S02", name: "PRD", dependsOn: ["S01"], skills: ["agentflow-prd-authoring"], requiredArtifactKinds: ["prd"], requiredGate: { id: "requirements-approved", type: "human", question: "Approve the product scope and requirements?", options: ["approve", "reject"] } },
    { id: "S03", name: "UX Architecture", dependsOn: ["S02"], skills: ["agentflow-ux-architecture", "figma-generate-diagram"], tools: ["figma.generate_diagram"], requiredArtifactKinds: ["ux-architecture"], skippableWhen: ["hasUi=false"] },
    {
      id: "S04",
      name: "Design Concepts",
      dependsOn: ["S03"],
      skills: ["agentflow-figma-concept-explorer", "figma-use"],
      tools: [
        "agentflow.resource",
        "figma.whoami",
        "figma.create_new_file",
        "figma.use_figma",
        "figma.get_metadata",
        "figma.get_screenshot"
      ],
      requiredCapabilities: [
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
      ],
      requiredArtifactKinds: ["design-concepts"],
      requiredGate: {
        id: "design-direction-approved",
        type: "human",
        question: "Choose and approve a design direction?",
        options: ["A", "B", "C", "mixed", "reject"]
      },
      skippableWhen: ["hasUi=false"]
    },
    { id: "S05", name: "Design System", dependsOn: ["S04"], skills: ["figma-use", "figma-generate-library"], tools: ["agentflow.resource", "figma.use_figma", "figma.get_libraries", "figma.search_design_system", "figma.get_metadata", "figma.get_screenshot"], requiredArtifactKinds: ["design-system"], skippableWhen: ["hasUi=false"] },
    { id: "S06", name: "Production Design", dependsOn: ["S05"], skills: ["agentflow-figma-production-design", "figma-use", "figma-generate-design"], tools: ["agentflow.resource", "figma.use_figma", "figma.get_metadata", "figma.get_screenshot"], requiredArtifactKinds: ["production-design"], skippableWhen: ["hasUi=false"] },
    { id: "S07", name: "Design Review", dependsOn: ["S06"], skills: ["agentflow-figma-a11y-review"], requiredArtifactKinds: ["design-review"], requiredGate: { id: "design-freeze-approved", type: "human", question: "Freeze the complete design for implementation?", options: ["approve", "reject"] }, skippableWhen: ["hasUi=false"] },
    { id: "S08", name: "Design Handoff", dependsOn: ["S07"], skills: ["agentflow-design-handoff"], requiredArtifactKinds: ["design-manifest"], skippableWhen: ["hasUi=false"] },
    { id: "S09", name: "Architecture", dependsOn: ["S08"], skills: ["agentflow-architecture"], requiredArtifactKinds: ["architecture"] },
    { id: "S10", name: "Engineering Plan", dependsOn: ["S09"], skills: ["agentflow-engineering-plan", "writing-plans"], requiredArtifactKinds: ["implementation-plan"], requiredGate: { id: "engineering-plan-approved", type: "human", question: "Approve the engineering implementation plan?", options: ["approve", "reject"] } },
    { id: "S11", name: "Implementation", dependsOn: ["S10"], skills: ["agentflow-worktree-isolation", "test-driven-development", "dispatching-parallel-agents"] },
    { id: "S12", name: "Integration", dependsOn: ["S11"], skills: ["agentflow-integration-manager", "requesting-code-review"], requiredArtifactKinds: ["integration-report"] },
    { id: "S13", name: "System QA", dependsOn: ["S12"], skills: ["agentflow-visual-qa", "accessibility", "security-audit"], requiredArtifactKinds: ["qa-report"] },
    { id: "S14", name: "Release", dependsOn: ["S13"], skills: ["agentflow-release-gate", "finishing-a-development-branch"], requiredArtifactKinds: ["release-plan"], requiredGate: { id: "release-approved", type: "human", question: "Approve the release to the target environment?", options: ["approve", "reject"] } },
    { id: "S15", name: "Done", dependsOn: ["S14"], skills: ["agentflow-completion-verifier", "verification-before-completion"], requiredArtifactKinds: ["final-manifest"] }
  ]
});
