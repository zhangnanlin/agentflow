import { describe, expect, it } from "vitest";
import { defaultPipeline } from "../src/index.js";

describe("AgentFlow default M3 pipeline", () => {
  it("binds every engineering and quality stage to its wrapper, artifact, and gate", () => {
    expect(defaultPipeline.version).toBe("0.4.0");
    const stages = Object.fromEntries(defaultPipeline.stages.map((stage) => [stage.id, stage]));

    expect(stages["S09"]).toMatchObject({
      skills: ["agentflow-architecture"],
      requiredArtifactKinds: ["architecture"]
    });
    expect(stages["S10"]).toMatchObject({
      skills: ["agentflow-engineering-plan", "writing-plans"],
      requiredArtifactKinds: ["implementation-plan"],
      requiredGate: { id: "engineering-plan-approved", type: "human" }
    });
    expect(stages["S11"]?.skills).toEqual(expect.arrayContaining([
      "agentflow-worktree-isolation",
      "test-driven-development",
      "dispatching-parallel-agents"
    ]));
    expect(stages["S12"]).toMatchObject({
      skills: ["agentflow-integration-manager", "requesting-code-review"],
      requiredArtifactKinds: ["integration-report"]
    });
    expect(stages["S13"]).toMatchObject({
      skills: ["agentflow-visual-qa", "accessibility", "security-audit"],
      requiredArtifactKinds: ["qa-report"]
    });
    expect(stages["S14"]).toMatchObject({
      skills: ["agentflow-release-gate", "finishing-a-development-branch"],
      requiredArtifactKinds: ["release-plan"],
      requiredGate: { id: "release-approved", type: "human" }
    });
    expect(stages["S15"]).toMatchObject({
      skills: ["agentflow-completion-verifier", "verification-before-completion"],
      requiredArtifactKinds: ["final-manifest"]
    });
  });
});
