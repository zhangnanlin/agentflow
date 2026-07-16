import { AgentFlowError } from "@agentflow/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const IdentifierSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

const sensitivePatterns = [
  /\bpassword\b/i,
  /\bpasscode\b/i,
  /\bapi[-_\s]?key\b/i,
  /\btoken\b/i,
  /\bsecret\b/i,
  /\bcredentials?\b/i,
  /\bprivate[-_\s]?key\b/i,
  /\b(?:credit|debit)[-_\s]?card\b/i,
  /\bcard[-_\s]?(?:number|cvv|cvc)\b/i,
  /\bbank[-_\s]?account\b/i,
  /密码|口令|密钥|秘钥|令牌|凭证|私钥|验证码|银行卡|信用卡|卡号|安全码/u
];

function nonSensitiveString(maximum: number) {
  return z.string().min(1).max(maximum).superRefine((value, context) => {
    if (value.trim().length === 0) {
      context.addIssue({ code: "custom", message: "Choice text must not be blank" });
    }
    if (sensitivePatterns.some((pattern) => pattern.test(value))) {
      context.addIssue({
        code: "custom",
        message: "Sensitive input fields are not allowed"
      });
    }
  });
}

const StructuredChoiceOptionSchema = z.object({
  value: IdentifierSchema.superRefine((value, context) => {
    if (sensitivePatterns.some((pattern) => pattern.test(value))) {
      context.addIssue({ code: "custom", message: "Sensitive input fields are not allowed" });
    }
  }),
  label: nonSensitiveString(160)
}).strict();

const StructuredChoiceQuestionSchema = z.object({
  id: IdentifierSchema,
  prompt: nonSensitiveString(500),
  description: nonSensitiveString(500).optional(),
  options: z.array(StructuredChoiceOptionSchema).min(2).max(5),
  recommended: IdentifierSchema.optional()
}).strict().superRefine((question, context) => {
  const values = new Set<string>();
  const labels = new Set<string>();
  for (const [index, option] of question.options.entries()) {
    if (values.has(option.value)) {
      context.addIssue({ code: "custom", path: ["options", index, "value"], message: "Option values must be unique" });
    }
    values.add(option.value);
    const normalizedLabel = option.label.trim().toLocaleLowerCase("en-US");
    if (labels.has(normalizedLabel)) {
      context.addIssue({ code: "custom", path: ["options", index, "label"], message: "Option labels must be unique" });
    }
    labels.add(normalizedLabel);
  }
  if (question.recommended !== undefined && !values.has(question.recommended)) {
    context.addIssue({ code: "custom", path: ["recommended"], message: "Recommended value must be declared" });
  }
});

export const StructuredChoiceRequestSchema = z.object({
  message: nonSensitiveString(1_000),
  questions: z.array(StructuredChoiceQuestionSchema).min(1).max(3)
}).strict().superRefine((request, context) => {
  const ids = new Set<string>();
  for (const [index, question] of request.questions.entries()) {
    if (ids.has(question.id)) {
      context.addIssue({ code: "custom", path: ["questions", index, "id"], message: "Question IDs must be unique" });
    }
    ids.add(question.id);
  }
});

export type StructuredChoiceRequest = z.infer<typeof StructuredChoiceRequestSchema>;
export type StructuredChoiceFallback = {
  instruction: string;
  message: string;
  questions: StructuredChoiceRequest["questions"];
};
export type StructuredChoiceOutcome =
  | { outcome: "accepted"; answers: Record<string, string> }
  | { outcome: "declined" }
  | { outcome: "cancelled" }
  | { outcome: "unsupported"; fallback: StructuredChoiceFallback };

export function buildStructuredChoiceForm(input: StructuredChoiceRequest) {
  const properties: Record<string, {
    type: "string";
    title: string;
    description?: string;
    oneOf: Array<{ const: string; title: string }>;
  }> = {};
  for (const question of input.questions) {
    const orderedOptions = question.recommended === undefined
      ? question.options
      : [
          ...question.options.filter((option) => option.value === question.recommended),
          ...question.options.filter((option) => option.value !== question.recommended)
        ];
    properties[question.id] = {
      type: "string",
      title: question.prompt,
      ...(question.description === undefined ? {} : { description: question.description }),
      oneOf: orderedOptions.map((option) => ({
        const: option.value,
        title: option.value === question.recommended
          ? `${option.label} (Recommended)`
          : option.label
      }))
    };
  }
  return {
    type: "object" as const,
    properties,
    required: input.questions.map((question) => question.id)
  };
}

export async function requestStructuredChoice(
  protocol: McpServer["server"],
  rawInput: StructuredChoiceRequest,
  signal: AbortSignal
): Promise<StructuredChoiceOutcome> {
  const input = StructuredChoiceRequestSchema.parse(rawInput);
  if (signal.aborted) return { outcome: "cancelled" };
  if (!supportsFormElicitation(protocol.getClientCapabilities()?.elicitation)) {
    return {
      outcome: "unsupported",
      fallback: {
        instruction: "Present all questions once and submit only explicit user selections.",
        message: input.message,
        questions: structuredClone(input.questions)
      }
    };
  }

  let result: Awaited<ReturnType<McpServer["server"]["elicitInput"]>>;
  try {
    result = await protocol.elicitInput({
      mode: "form",
      message: input.message,
      requestedSchema: buildStructuredChoiceForm(input)
    }, { signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return { outcome: "cancelled" };
    if (isInvalidResponseError(error)) throw invalidResponseError();
    throw error;
  }

  if (signal.aborted) return { outcome: "cancelled" };
  if (result.action === "decline") return { outcome: "declined" };
  if (result.action === "cancel") return { outcome: "cancelled" };
  return {
    outcome: "accepted",
    answers: validateAnswers(input, result.content)
  };
}

function supportsFormElicitation(capability: unknown): boolean {
  if (capability === undefined || capability === null || typeof capability !== "object" || Array.isArray(capability)) {
    return false;
  }
  const record = capability as Record<string, unknown>;
  if (Object.keys(record).length === 0) return true;
  return record["form"] !== undefined;
}

function validateAnswers(
  input: StructuredChoiceRequest,
  content: unknown
): Record<string, string> {
  if (content === null || typeof content !== "object" || Array.isArray(content)) throw invalidResponseError();
  const record = content as Record<string, unknown>;
  const expectedIds = new Set(input.questions.map((question) => question.id));
  if (Object.keys(record).length !== expectedIds.size || Object.keys(record).some((key) => !expectedIds.has(key))) {
    throw invalidResponseError();
  }
  const answers: Record<string, string> = {};
  for (const question of input.questions) {
    const value = record[question.id];
    if (typeof value !== "string" || !question.options.some((option) => option.value === value)) {
      throw invalidResponseError();
    }
    answers[question.id] = value;
  }
  return answers;
}

function invalidResponseError(): AgentFlowError {
  return new AgentFlowError(
    "The elicitation response did not match the declared choices",
    "ELICITATION_RESPONSE_INVALID"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isInvalidResponseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === ErrorCode.InvalidParams;
}
