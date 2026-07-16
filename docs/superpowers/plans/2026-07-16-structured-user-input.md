# Structured User Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clickable bounded choices and one-interaction human-Gate decisions to AgentFlow while preserving explicit approval, state safety, and the existing global installation.

**Architecture:** The MCP server exposes a read-only `structured_choice_request` and a stateful `gate_decision_request`, both backed by one bounded form-elicitation helper. Gate interaction reads persisted state, waits without holding a Run lock, and finalizes through the existing Core transaction with the original revision and a backward-compatible idempotency input hash.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, MCP TypeScript SDK 1.29.0, Vitest 4, esbuild, JSON file-backed AgentFlow Core.

## Global Constraints

- MCP form elicitation is the cross-mode primary path; host-native structured input is an allowed equivalent only when already exposed.
- Generic clarification is read-only and accepts one to three independent questions with two to five options each.
- No free-form fields, secrets, passwords, API keys, access tokens, payment data, OAuth, browser UI, daemon, or GUI automation.
- Recommendations are display-only and must not emit a JSON Schema default.
- Gate question and options come only from persisted Run state.
- No Run lock may be held while waiting for a human response.
- Every decline, cancel, timeout, disconnect, malformed response, stale revision, and idempotency conflict must produce no Gate mutation.
- Existing Run files remain compatible; new persisted fields are optional.
- Global setup remains one user-level installation with no new MCP entry or per-project setup.
- Follow TDD: observe each focused test fail before adding its implementation, then commit a clean change set.
- The registered implementation-plan JSON binds the exact commit containing this document; the parent approved-design commit is `a0f04943c99c9c33e7f5df2f26f0b13d40a019f0`.

---

## Approved Execution Baseline Correction

The original four serial Tasks shared one pre-Core Git baseline. After the Core Task completed, collecting a later Worker against that same baseline necessarily included dependency commits outside the later Task's write scope. AgentFlow correctly recorded that Worker as blocked instead of fabricating a smaller change set.

The user approved revision `7489ae8fa21ab5b93b1a8b41e93bc58f5e87b4069fc9e8acdb176dcc8d123f0c`, which preserves every product, architecture, safety, test, and release constraint above while correcting only execution ownership:

- Completed Core commit `fadf0314d91c6358f1324813b8565945e45884c3` is the dependency-complete baseline.
- All remaining MCP, guidance, distribution, and documentation work is collected as one bounded `task-structured-input-delivery` change set from that baseline.
- The historical task sections below remain the detailed TDD procedure; their remaining steps execute serially inside the single delivery Task.
- No correction authorizes push, tag, package publication, hosted release, or deployment. The final Release Gate remains mandatory.

---

### Task 1: Core Gate Preflight And Fingerprinted Idempotency

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/store.ts`
- Modify: `packages/core/src/engine.ts`
- Test: `packages/core/test/store.test.ts`
- Test: `packages/core/test/engine.test.ts`

**Interfaces:**
- Consumes: existing `MutationContext`, `IdempotencyRecordSchema`, `JsonRunStore.transact`, `AgentFlowEngine.loadRun`, pipeline `stageById`, and Gate/Artifact models.
- Produces: optional `MutationContext.inputHash`, optional persisted `IdempotencyRecord.inputHash`, and `AgentFlowEngine.inspectHumanGate(runId, gateId, expectedRevision)` returning an immutable valid Gate snapshot.

- [ ] **Step 1: Add failing hashed-replay and legacy-compatibility tests**

Add store/engine cases that create one Task with a 64-character hash, replay it exactly, then retry the same key once without a hash and once with a different hash. Assert exact replay keeps the revision and both incompatible retries return `IDEMPOTENCY_CONFLICT`. Parse a manually downgraded Run JSON after deleting `inputHash` from its records.

```ts
const inputHash = "a".repeat(64);
const mutation: MutationContext = {
  expectedRevision: state.revision,
  idempotencyKey: "fingerprinted-create",
  inputHash,
  actor: supervisor
};
state = await engine.createTask(state.id, {
  id: "fingerprinted-task",
  stageId: "S00",
  title: "Fingerprint replay"
}, mutation);
const replayed = await engine.createTask(state.id, {
  id: "fingerprinted-task",
  stageId: "S00",
  title: "Fingerprint replay"
}, mutation);
expect(replayed.revision).toBe(state.revision);
await expect(engine.createTask(state.id, {
  id: "different-task",
  stageId: "S00",
  title: "Reject different input"
}, { ...mutation, inputHash: "b".repeat(64) }))
  .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
```

- [ ] **Step 2: Run the focused Core tests and confirm red**

Run: `npm.cmd test -- packages/core/test/store.test.ts packages/core/test/engine.test.ts`

Expected: compilation or assertion failure because `MutationContext.inputHash` and strict hash comparison do not exist.

- [ ] **Step 3: Add the optional persisted hash and strict replay comparison**

Add `inputHash: Sha256Schema.optional()` to `IdempotencyRecordSchema` and `inputHash?: string` to `MutationContext`. In `JsonRunStore.transact`, keep the operation comparison and add the hash invariant before returning a prior record:

```ts
if (prior) {
  invariant(
    prior.operation === options.operation,
    `Idempotency key already used for ${prior.operation}`,
    "IDEMPOTENCY_CONFLICT",
    { idempotencyKey: options.idempotencyKey }
  );
  invariant(
    prior.inputHash === options.inputHash,
    "Idempotency key input does not match the recorded operation",
    "IDEMPOTENCY_CONFLICT",
    { idempotencyKey: options.idempotencyKey }
  );
  return current;
}
```

When writing the new record, conditionally spread `inputHash` only when present. Both absent remains the legacy match; one absent and one present conflicts.

- [ ] **Step 4: Add failing read-only human-Gate inspection tests**

Create a Run advanced to S02 with its PRD Artifact. Assert `inspectHumanGate` returns the pending `requirements-approved` Gate and current Artifact hashes without changing raw state bytes. Add separate assertions for stale revision, missing Gate, automatic Gate, already approved Gate, Gate outside the active Stage, and missing required Artifact.

```ts
const before = await readFile(join(directory, state.id, "state.json"), "utf8");
const inspected = await engine.inspectHumanGate(
  state.id,
  "requirements-approved",
  state.revision
);
expect(inspected.gate).toMatchObject({
  id: "requirements-approved",
  type: "human",
  status: "pending"
});
expect(inspected.artifactHashes).toEqual({ "s02-prd": state.artifacts["s02-prd"]?.sha256 });
expect(await readFile(join(directory, state.id, "state.json"), "utf8")).toBe(before);
```

- [ ] **Step 5: Implement `inspectHumanGate` using existing invariants**

The method loads once, requires the exact expected revision, pending human Gate, active matching Stage, and every `requiredArtifactKinds` entry, then returns cloned Gate data and the non-stale Stage Artifact hash map. It must call no mutation method and emit no event.

```ts
export interface HumanGateInspection {
  state: RunState;
  gate: Gate;
  artifactHashes: Record<string, string>;
}
```

- [ ] **Step 6: Run focused verification and commit**

Run: `npm.cmd test -- packages/core/test/store.test.ts packages/core/test/engine.test.ts`

Run: `npm.cmd exec -- tsc -p packages/core/test/tsconfig.json --pretty false`

Expected: both commands pass.

Commit:

```powershell
git add -- packages/core/src/model.ts packages/core/src/store.ts packages/core/src/engine.ts packages/core/test/store.test.ts packages/core/test/engine.test.ts
git commit -m "feat(core): preflight human gate decisions"
```

---

### Task 2: MCP Structured Choice And Gate Decision Tools

**Files:**
- Create: `packages/mcp-server/src/structured-input.ts`
- Create: `packages/mcp-server/src/gate-decision.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/test/structured-input.test.ts`
- Create: `packages/mcp-server/test/gate-decision.test.ts`
- Create: `packages/mcp-server/test/structured-input.performance.test.ts`
- Test: `packages/mcp-server/test/server.test.ts`

**Interfaces:**
- Consumes: `McpServer.server.getClientCapabilities`, `McpServer.server.elicitInput`, MCP `RequestHandlerExtra.signal`, `AgentFlowEngine.inspectHumanGate`, `AgentFlowEngine.resolveGate`, `canonicalJson`, and `sha256`.
- Produces: `StructuredChoiceRequestSchema`, `requestStructuredChoice`, `gateDecisionInputHash`, `mapGateSelection`, MCP tools `structured_choice_request` and `gate_decision_request`, and discriminated outcomes.

- [ ] **Step 1: Write failing generic form and no-mutation integration tests**

Build a linked in-memory client advertising `{ elicitation: { form: {} } }`, install an `ElicitRequestSchema` handler, and assert the requested schema contains required titled `oneOf` fields and no `default`. Return accepted values and assert the tool result is `{ outcome: "accepted", answers }`.

Add table cases for one and three questions, duplicate IDs/values/labels, invalid recommendations, 1 or 6 options, sensitive terms, decline, cancel, unsupported capability, missing field, unknown field, non-string value, undeclared value, handler exception, and AbortSignal. Snapshot the temporary directory before and after every generic call.

```ts
client = new Client(
  { name: "structured-input-test", version: "1.0.0" },
  { capabilities: { elicitation: { form: {} } } }
);
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  expect(request.params.mode).toBe("form");
  expect(request.params.requestedSchema.required).toEqual(["scope"]);
  return { action: "accept", content: { scope: "platform-packages" } };
});
```

- [ ] **Step 2: Run generic tests and confirm red**

Run: `npm.cmd test -- packages/mcp-server/test/structured-input.test.ts packages/mcp-server/test/server.test.ts`

Expected: failures because the helper and `structured_choice_request` tool are absent.

- [ ] **Step 3: Implement the bounded structured-input helper**

Define exact Zod limits from the approved design. Reject secret-bearing English and Chinese phrases in message, prompt, description, label, and value. Build `oneOf` titles with the recommendation first and suffixed `(Recommended)`, but never set a default.

```ts
export type StructuredChoiceOutcome =
  | { outcome: "accepted"; answers: Record<string, string> }
  | { outcome: "declined" }
  | { outcome: "cancelled" }
  | { outcome: "unsupported"; fallback: StructuredChoiceFallback };

export async function requestStructuredChoice(
  protocol: McpServer["server"],
  input: StructuredChoiceRequest,
  signal: AbortSignal
): Promise<StructuredChoiceOutcome>;
```

Treat an absent elicitation capability as unsupported and an empty legacy elicitation capability as form-capable. Pass `signal` to `elicitInput`. Validate the accepted result again for exact keys and declared string values; throw `AgentFlowError` with `ELICITATION_RESPONSE_INVALID` without echoing raw content.

- [ ] **Step 4: Register the read-only generic tool and turn its tests green**

Register `structured_choice_request` with `readOnlyHint`, `idempotentHint`, and `openWorldHint: false`. Its handler must not call `pathsFor`, `targetFor`, or any state engine function.

Run: `npm.cmd test -- packages/mcp-server/test/structured-input.test.ts packages/mcp-server/test/server.test.ts`

Expected: generic schema, outcome, fallback, security, and no-mutation cases pass.

- [ ] **Step 5: Write failing persisted Gate integration tests**

Create custom pipelines for approve/reject and A/B/C/mixed/reject Gates. Assert the elicitation request contains only persisted question/options, an accepted answer increments exactly one revision, uses the user actor, emits the existing Gate event, and binds current Artifact hashes.

Add exact replay without a second client handler call; changed actor/reason/Gate/revision with the same key; decline/cancel/unsupported/malformed/abort/timeout; Artifact replacement while the form is open; two concurrent accepted calls with different keys; and concurrent same-key conflicting answers.

- [ ] **Step 6: Implement Gate fingerprinting, preflight, mapping, and registration**

Compute the non-reversible hash from canonical JSON of operation, Run, Gate, expected revision, actor, and reason. Check a prior record before revision inspection. Accept no question/options/decision/choice/resolution fields in the tool schema.

```ts
export function mapGateSelection(value: string): {
  decision: "approved" | "rejected";
  choice?: string;
} {
  const normalized = value.toLowerCase();
  return normalized === "reject" || normalized === "rejected"
    ? { decision: "rejected" }
    : { decision: "approved", choice: value };
}
```

Use the original revision and `{ ...target.context, inputHash }` for `resolveGate`. An exact recorded replay returns `{ outcome: "replayed", state }` before opening a form. After finalization, compare the persisted status/choice with the attempted selection so a concurrent same-key conflicting answer becomes `IDEMPOTENCY_CONFLICT` rather than a false success.

- [ ] **Step 7: Add and run the deterministic performance test**

Validate and map a three-question/five-option request repeatedly, sort the recorded local durations, and assert the p95 is below 100 milliseconds. Do not include MCP transport or user wait.

Run: `npm.cmd test -- packages/mcp-server/test/structured-input.performance.test.ts`

Expected: pass with measured p95 below 100 milliseconds.

- [ ] **Step 8: Run focused verification and commit**

Run: `npm.cmd test -- packages/mcp-server/test/structured-input.test.ts packages/mcp-server/test/gate-decision.test.ts packages/mcp-server/test/structured-input.performance.test.ts packages/mcp-server/test/server.test.ts`

Run: `npm.cmd exec -- tsc -p packages/mcp-server/test/tsconfig.json --pretty false`

Expected: both commands pass.

Commit:

```powershell
git add -- packages/mcp-server/src/structured-input.ts packages/mcp-server/src/gate-decision.ts packages/mcp-server/src/server.ts packages/mcp-server/test/structured-input.test.ts packages/mcp-server/test/gate-decision.test.ts packages/mcp-server/test/structured-input.performance.test.ts packages/mcp-server/test/server.test.ts
git commit -m "feat(mcp): add structured user choices"
```

---

### Task 3: Structured Input Skill And Host Guidance

**Files:**
- Modify: `packages/host-adapter/src/routing.ts`
- Test: `packages/host-adapter/test/routing.test.ts`
- Test: `packages/cli/test/auto-router.test.ts`
- Modify: `.agents/skills/agentflow-auto-router/SKILL.md`
- Modify: `.agents/skills/agentflow-auto-router/references/routing-contract.md`
- Modify: `.agents/skills/agentflow-product-discovery/SKILL.md`
- Modify: `.agents/skills/agentflow-prd-authoring/SKILL.md`
- Modify: `.agents/skills/agentflow-figma-concept-explorer/SKILL.md`
- Modify: `.agents/skills/agentflow-engineering-plan/SKILL.md`
- Modify: `.agents/skills/agentflow-orchestrator/SKILL.md`
- Modify: `.agents/skills/agentflow-release-gate/SKILL.md`
- Modify: `.agents/skills/agentflow-codex-host-bridge/SKILL.md`
- Modify: `.agents/skills/agentflow-codex-host-bridge/references/codex-tool-map.md`

**Interfaces:**
- Consumes: stable MCP tool names and outcomes from Task 2.
- Produces: one canonical priority policy for material questions, fallback, Gate decisions, Default-mode Codex behavior, and resume handling.

- [ ] **Step 1: Write failing canonical policy assertions**

Assert MCP initialization and routing tests contain `structured_choice_request`, `gate_decision_request`, `three independent`, `one concise text fallback`, and the explicit no-inference rule. Read each decision-producing Skill and assert it names the correct tool and preserves Artifact-hash approval.

- [ ] **Step 2: Run guidance tests and confirm red**

Run: `npm.cmd test -- packages/host-adapter/test/routing.test.ts packages/cli/test/auto-router.test.ts packages/mcp-server/test/server.test.ts`

Expected: policy assertions fail because current guidance only describes chat questions and `gate_resolve`.

- [ ] **Step 3: Update the canonical priority and bounded-question rules**

Use these semantics consistently:

1. Inspect repository and Run evidence first.
2. Use `structured_choice_request` for material bounded choices across modes.
3. Permit an exposed native structured-input control as an equivalent.
4. Batch no more than three independent questions; ask dependent questions later.
5. Use `gate_decision_request` for pending human Gates.
6. Use one text fallback only after structured input is unavailable.
7. Never repeat accepted answers or infer from recommendation, silence, timeout, cancellation, or unrelated approval.

Keep the MCP initialization prefix focused on routing so existing first-512-character tests remain meaningful; append structured-input guidance after the routing body.

- [ ] **Step 4: Update Codex capability and recovery guidance**

Document `host.user-input.structured` independently from Worker spawn/status/collect capabilities. Default-mode MCP elicitation requires no mode switch. A resumed supervisor reloads persisted Gate state before retrying, does not create a user-owned task, and never automates the GUI.

- [ ] **Step 5: Run focused tests and validate every edited Skill**

Run: `npm.cmd test -- packages/host-adapter/test/routing.test.ts packages/cli/test/auto-router.test.ts packages/mcp-server/test/server.test.ts`

Run:

```powershell
$env:PYTHONUTF8='1'
@('agentflow-auto-router','agentflow-product-discovery','agentflow-prd-authoring','agentflow-figma-concept-explorer','agentflow-engineering-plan','agentflow-orchestrator','agentflow-release-gate','agentflow-codex-host-bridge') | ForEach-Object {
  python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py (Join-Path '.agents\skills' $_)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: tests pass and each validator prints a valid Skill result.

- [ ] **Step 6: Commit**

```powershell
git add -- packages/host-adapter/src/routing.ts packages/host-adapter/test/routing.test.ts packages/cli/test/auto-router.test.ts .agents/skills
git commit -m "docs(agentflow): prefer structured user input"
```

---

### Task 4: Versioned Global Distribution And Bilingual Documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/mcp-server/src/server.ts`
- Test: `packages/cli/test/distribution.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/HOST_SETUP.md`
- Modify: `AGENTFLOW_PROJECT_SPEC.md`

**Interfaces:**
- Consumes: completed Core, MCP tools, and installed Skill policy from Tasks 1-3.
- Produces: version 0.4.0 standalone runtime, packed tool/Skill verification, unchanged setup workflow, and English/Chinese operator guidance.

- [ ] **Step 1: Add failing distribution and documentation assertions**

Change the expected distribution version to `0.4.0`. Assert source and packed tool lists include both new tools and every prior tool. Assert both READMEs and host setup mention clickable choices, at most three independent questions, explicit one-click Gates, safe cancellation, fallback, and the unchanged global setup command.

- [ ] **Step 2: Run the distribution test and confirm red**

Run: `npm.cmd test -- packages/cli/test/distribution.test.ts`

Expected: failures for version, tool list, and missing bilingual behavior text.

- [ ] **Step 3: Update version identity and upgrade behavior**

Set root `package.json` and both root entries in `package-lock.json` to `0.4.0`. Change the unbundled MCP fallback version to `0.4.0`; the distribution build continues injecting the root version.

Document that existing users rerun:

```powershell
npx --yes github:zhangnanlin/agentflow setup --host codex
```

A host restart may be needed to load the new bundle. Individual projects do not rerun setup and no new MCP server or OAuth flow is introduced.

- [ ] **Step 4: Update English, Chinese, host, and project documentation**

Describe normal choice, Gate choice, unsupported fallback, cancellation/conflict safety, non-sensitive-only input, and optional native controls. Preserve the explicit human-Gate and Artifact-hash rules.

- [ ] **Step 5: Run full repository and packed-install verification**

Run in order:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:distribution
npm.cmd pack --dry-run --json
$env:PYTHONUTF8='1'
Get-ChildItem .agents/skills -Directory | Sort-Object Name | ForEach-Object {
  python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: all commands exit 0; packed install reports version 0.4.0, both new tools, all updated Skills, project isolation, and no credentials.

- [ ] **Step 6: Check the complete change set and commit**

Run: `git diff --check fadf0314d91c6358f1324813b8565945e45884c3..HEAD`

Expected: no output.

Commit:

```powershell
git add -- package.json package-lock.json packages/mcp-server/src/server.ts packages/cli/test/distribution.test.ts README.md README.zh-CN.md docs/HOST_SETUP.md AGENTFLOW_PROJECT_SPEC.md
git commit -m "docs: ship structured input guidance"
```

Do not push, tag, publish a package, create a hosted release, or deploy in this Task.

---

## Requirement And Risk Coverage

| Area | Task | Evidence |
|---|---|---|
| `fr-1`, `fr-2` generic bounded choices | Task 2 | Form schema, accepted mapping, fallback, project-tree diff tests |
| `fr-3`, `fr-4` persisted Gate transaction | Tasks 1-2 | Read-only preflight, Core event/revision/Artifact assertions |
| `fr-5` all non-accepted paths | Tasks 1-2 | Byte-equivalent Run and concurrent conflict tests |
| `fr-6`, `fr-7` Skills and Codex bridge | Task 3 | Canonical text assertions and Skill validation |
| `fr-8` global distribution and docs | Task 4 | Full build, pack, global install, bilingual assertions |
| Host capability inconsistency | Task 2 | Capable, empty-legacy, absent, malformed, and thrown-handler cases |
| Long wait/disconnect | Task 2 | AbortSignal, timeout, disconnect, and zero-mutation evidence |
| Stale Gate/Artifact | Tasks 1-2 | Preflight and post-elicitation revision conflict tests |
| Same-key race | Tasks 1-2 | Fingerprinted store replay and concurrent outcome comparison |
| Over-questioning/guidance drift | Tasks 3-4 | Policy assertions, installed Skill checks, bilingual docs |
| Sensitive prompt | Task 2 | English/Chinese sensitive-term and no-content-leak tests |

## Integration

Execute the four Tasks serially on `main`; every Task starts from the prior clean commit. S12 re-runs the complete verification set, inspects commit ancestry and changed paths, and resolves review findings before QA. Unexpected user changes stop the current Task for reconciliation and are never reverted.
