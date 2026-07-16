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
});
