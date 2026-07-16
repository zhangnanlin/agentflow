import { AgentFlowError } from "@agentflow/core";
import { describe, expect, it } from "vitest";
import { mergeManagedBlock } from "../src/managed-content.js";

const markers = {
  start: "<!-- agentflow:auto-router:start -->",
  end: "<!-- agentflow:auto-router:end -->"
};

describe("managed content", () => {
  it("appends and then replaces exactly one managed block", () => {
    const first = mergeManagedBlock("# Existing\n", "new body", markers);

    expect(first).toContain("# Existing\n");
    expect(first.match(/agentflow:auto-router:start/g)).toHaveLength(1);

    const updated = mergeManagedBlock(first, "updated body", markers);
    expect(updated).toContain("updated body");
    expect(updated).not.toContain("new body");
    expect(updated.match(/agentflow:auto-router:start/g)).toHaveLength(1);
  });

  it("rejects malformed or duplicated markers", () => {
    expect(() => mergeManagedBlock(`${markers.start}\nbody`, "next", markers))
      .toThrowError(AgentFlowError);
    expect(() => mergeManagedBlock(
      `${markers.start}\na\n${markers.end}\n${markers.start}\nb\n${markers.end}`,
      "next",
      markers
    )).toThrowError(expect.objectContaining({ code: "MANAGED_BLOCK_INVALID" }));
  });
});
