import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTFLOW_MCP_INSTRUCTIONS,
  AGENTFLOW_ROUTER_BODY
} from "../src/routing.js";

describe("global routing contract", () => {
  it("front-loads mutation routing, start-or-resume, and human Gates", () => {
    const prefix = AGENTFLOW_MCP_INSTRUCTIONS.slice(0, 512);

    expect(prefix).toContain("project-changing");
    expect(prefix).toContain("run_start_or_resume");
    expect(prefix).toContain("human Gate");
  });

  it("retains exemptions and one-request overrides", () => {
    for (const phrase of [
      "Pure questions",
      "read-only",
      "agentflow:on",
      "agentflow:off"
    ]) {
      expect(AGENTFLOW_ROUTER_BODY).toContain(phrase);
    }
  });

  it("fast-paths only safe synchronization of existing Git refs", () => {
    for (const phrase of [
      "safe source-control sync",
      "existing commits or tags",
      "force push",
      "ref deletion",
      "package publication",
      "deployment"
    ]) {
      expect(AGENTFLOW_ROUTER_BODY).toContain(phrase);
    }
  });

  it("publishes the canonical low-friction structured-input priority", () => {
    for (const phrase of [
      "Inspect repository and Run evidence first",
      "mandatory or non-mandatory",
      "recommended default without asking",
      "structured_choice_request",
      "genuinely blocking material choice without a safe default",
      "three independent",
      "gate_decision_request",
      "one concise text fallback",
      "Never repeat accepted answers",
      "recommendation, silence, timeout, cancellation, or unrelated approval"
    ]) {
      expect(AGENTFLOW_MCP_INSTRUCTIONS).toContain(phrase);
    }
    expect(AGENTFLOW_MCP_INSTRUCTIONS)
      .not.toContain("Use structured_choice_request for material bounded choices across modes");
  });

  it("keeps every decision-producing Skill aligned with structured choices and Artifact-bound Gates", async () => {
    const choiceSkills = [
      ".agents/skills/agentflow-auto-router/SKILL.md",
      ".agents/skills/agentflow-auto-router/references/routing-contract.md",
      ".agents/skills/agentflow-product-discovery/SKILL.md",
      ".agents/skills/agentflow-prd-authoring/SKILL.md",
      ".agents/skills/agentflow-figma-concept-explorer/SKILL.md",
      ".agents/skills/agentflow-engineering-plan/SKILL.md",
      ".agents/skills/agentflow-orchestrator/SKILL.md",
      ".agents/skills/agentflow-release-gate/SKILL.md",
      ".agents/skills/agentflow-codex-host-bridge/references/codex-tool-map.md"
    ];
    for (const path of choiceSkills) {
      const content = await readFile(resolve(path), "utf8");
      expect(content, path).toContain("structured_choice_request");
      expect(content, path).toMatch(/recommend(?:ation|ed default).{0,100}without asking/is);
      expect(content, path).toMatch(/blocking material choice without a safe (?:recommended )?default/is);
    }

    const gateSkills = [
      ".agents/skills/agentflow-prd-authoring/SKILL.md",
      ".agents/skills/agentflow-figma-concept-explorer/SKILL.md",
      ".agents/skills/agentflow-engineering-plan/SKILL.md",
      ".agents/skills/agentflow-orchestrator/SKILL.md",
      ".agents/skills/agentflow-release-gate/SKILL.md"
    ];
    for (const path of gateSkills) {
      const content = await readFile(resolve(path), "utf8");
      expect(content, path).toContain("gate_decision_request");
      expect(content, path).toMatch(/Artifact.{0,40}hash/is);
    }

    const bridge = await readFile(resolve(".agents/skills/agentflow-codex-host-bridge/SKILL.md"), "utf8");
    const toolMap = await readFile(resolve(".agents/skills/agentflow-codex-host-bridge/references/codex-tool-map.md"), "utf8");
    for (const content of [bridge, toolMap]) {
      expect(content).toContain("host.user-input.structured");
      expect(content).toContain("Default mode");
      expect(content).toContain("user-owned");
      expect(content).toContain("GUI");
    }
  });
});
