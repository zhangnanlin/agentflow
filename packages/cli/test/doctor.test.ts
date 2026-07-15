import { describe, expect, it } from "vitest";
import { normalizeHostCapabilities } from "../src/doctor.js";

describe("doctor capability normalization", () => {
  it("accepts canonical IDs and explicitly namespaced Figma tool aliases", () => {
    expect(normalizeHostCapabilities([
      "host.worker.spawn",
      "mcp__figma__use_figma",
      "figma.get_screenshot",
      "figma-use",
      "use_figma",
      "mcp__untrusted__use_figma"
    ])).toEqual({
      available: [
        "figma.tool.get_screenshot",
        "figma.tool.use_figma",
        "host.worker.spawn",
        "skill.figma-use"
      ],
      ignored: ["mcp__untrusted__use_figma", "use_figma"]
    });
  });
});
