import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  requestStructuredChoice,
  type StructuredChoiceRequest
} from "../src/structured-input.js";

const request: StructuredChoiceRequest = {
  message: "Choose three independent options.",
  questions: Array.from({ length: 3 }, (_, questionIndex) => ({
    id: `question-${questionIndex}`,
    prompt: `Question ${questionIndex}`,
    options: Array.from({ length: 5 }, (_, optionIndex) => ({
      value: `q${questionIndex}-option-${optionIndex}`,
      label: `Question ${questionIndex} option ${optionIndex}`
    })),
    recommended: `q${questionIndex}-option-0`
  }))
};

describe("structured input local performance", () => {
  it("keeps three-question validation, form construction, and response mapping below 100ms p95", async () => {
    const protocol = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async () => ({
        action: "accept" as const,
        content: {
          "question-0": "q0-option-0",
          "question-1": "q1-option-0",
          "question-2": "q2-option-0"
        }
      })
    };
    const signal = new AbortController().signal;
    const durations: number[] = [];

    for (let index = 0; index < 250; index += 1) {
      const startedAt = performance.now();
      const outcome = await requestStructuredChoice(protocol as never, request, signal);
      durations.push(performance.now() - startedAt);
      expect(outcome.outcome).toBe("accepted");
    }

    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(100);
  });
});
