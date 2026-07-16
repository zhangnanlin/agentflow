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
    expect(() => mergeManagedBlock(
      `${markers.end}\nbody\n${markers.start}`,
      "next",
      markers
    )).toThrowError(expect.objectContaining({ code: "MANAGED_BLOCK_INVALID" }));
  });

  it("preserves bytes and whitespace outside the managed block", () => {
    const prefix = "# Team\r\n\r\n\r\n";
    const suffix = "\r\n\r\n\r\n# Tail\r\n\r\n";
    const existing = `${prefix}${markers.start}\r\nold\r\n${markers.end}${suffix}`;

    const updated = mergeManagedBlock(existing, "new", markers);

    expect(updated.startsWith(prefix)).toBe(true);
    expect(updated.endsWith(suffix)).toBe(true);
    expect(updated).toContain(`${markers.start}\r\nnew\r\n${markers.end}`);
  });
});
