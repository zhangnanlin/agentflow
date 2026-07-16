import { describe, expect, it } from "vitest";
import {
  AGENTFLOW_ROUTER_BODY,
  renderAgentsInstruction,
  renderCursorRule,
  renderVsCodeInstruction
} from "../src/auto-router.js";

describe("automatic router contract", () => {
  it("routes mutations, exempts reads, supports overrides, resumes runs, and preserves gates", () => {
    for (const phrase of [
      "project-changing",
      "Pure questions",
      "agentflow:on",
      "agentflow:off",
      "Resume",
      "human Gate"
    ]) {
      expect(AGENTFLOW_ROUTER_BODY).toContain(phrase);
    }
  });

  it("renders the native always-on surface for each host", () => {
    expect(renderAgentsInstruction()).toContain("agentflow:auto-router:start");
    expect(renderCursorRule()).toMatch(/alwaysApply:\s*true/);
    expect(renderCursorRule()).toContain("agentflow:auto-router:start");
    expect(renderVsCodeInstruction("# Team rules\n")).toContain("# Team rules");
  });

  it("updates only the managed Cursor block", () => {
    const existing = `${renderCursorRule()}\n# Team suffix\n`;

    expect(renderCursorRule(existing)).toBe(existing);
  });
});
