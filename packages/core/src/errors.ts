export class AgentFlowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AgentFlowError";
  }
}
export function invariant(
  condition: unknown,
  message: string,
  code: string,
  details: Record<string, unknown> = {}
): asserts condition {
  if (!condition) {
    throw new AgentFlowError(message, code, details);
  }
}
