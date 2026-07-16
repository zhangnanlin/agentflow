# AgentFlow Fast Source-Control Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make safe pushes of existing Git commits and tags immediate while retaining full AgentFlow release controls for package publication and production deployment.

**Architecture:** Extend the canonical routing contract with a narrowly defined source-control synchronization exemption. Add a backward-compatible release target discriminator and zero-minute immediate verification semantics, then align the release/completion Skills and bilingual docs with those deterministic rules.

**Tech Stack:** TypeScript, Zod, Vitest, Markdown Agent Skills, Git.

## Global Constraints

- Safe fast-path operations never include force push, ref deletion, history rewriting, GitHub Release creation, package publication, deployment, migration, or file edits.
- `agentflow:on` and `agentflow:off` retain their current one-request behavior.
- Existing version-1 release plans without `release.kind` remain valid and use production semantics.
- Production releases continue to require a positive observation window and an independently authorized release Worker.
- No new runtime dependency is introduced.

---

### Task 1: Canonical Router Fast Path

**Files:**
- Modify: `packages/host-adapter/test/routing.test.ts`
- Modify: `packages/cli/test/auto-router.test.ts`
- Modify: `packages/host-adapter/src/routing.ts`
- Modify: `.agents/skills/agentflow-auto-router/SKILL.md`
- Modify: `.agents/skills/agentflow-auto-router/references/routing-contract.md`

**Interfaces:**
- Consumes: `AGENTFLOW_ROUTER_BODY` as the one canonical host instruction body.
- Produces: a precise natural-language classifier shared by MCP, Codex, Cursor, and VS Code.

- [ ] **Step 1: Write failing router contract tests**

Add assertions that the canonical body contains `safe source-control sync`, `existing commits or tags`, `force push`, `ref deletion`, `package publication`, and `deployment`, while continuing to contain `run_start_or_resume` and both override tokens.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- packages/host-adapter/test/routing.test.ts packages/cli/test/auto-router.test.ts`

Expected: FAIL because the existing canonical body calls every release project-changing and has no safe Git synchronization boundary.

- [ ] **Step 3: Implement the minimal canonical text change**

Add one exemption line and one fail-closed boundary line to `AGENTFLOW_ROUTER_BODY`. Mirror the same rules in the installed auto-router Skill and routing reference. Do not add a second classifier implementation.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd test -- packages/host-adapter/test/routing.test.ts packages/cli/test/auto-router.test.ts`

Expected: both files pass.

---

### Task 2: Release Target Contract

**Files:**
- Modify: `packages/core/test/contracts.test.ts`
- Modify: `packages/core/src/contracts.ts`
- Modify: `packages/mcp-server/test/server.test.ts`

**Interfaces:**
- Produces: optional `release.kind?: "source-control" | "package-registry" | "production"`.
- Produces: `monitoring.observationWindowMinutes` with non-negative syntax and target-specific semantics.

- [ ] **Step 1: Write failing contract tests**

Create four focused cases from the existing release-plan fixture:

```ts
expect(() => ReleasePlanContractSchema.parse(sourceControlPlan(0))).not.toThrow();
expect(() => ReleasePlanContractSchema.parse(sourceControlPlan(1))).toThrow();
expect(() => ReleasePlanContractSchema.parse(productionPlan(0))).toThrow();
expect(() => ReleasePlanContractSchema.parse(legacyProductionPlan())).not.toThrow();
```

Add the equivalent `package-registry` zero-window assertion. Add one MCP validation assertion proving the normalized hash includes an explicitly supplied kind.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- packages/core/test/contracts.test.ts packages/mcp-server/test/server.test.ts`

Expected: FAIL because `release.kind` is rejected by the strict object and zero-minute monitoring is rejected by `.positive()`.

- [ ] **Step 3: Implement target-specific validation**

Add the optional enum inside `release`, change the observation window to `.nonnegative()`, and add `superRefine` rules:

```ts
const kind = value.release.kind ?? "production";
if (kind === "production" && value.monitoring.observationWindowMinutes === 0) {
  context.addIssue({ code: "custom", message: "Production releases require a positive observation window" });
}
if (kind !== "production" && value.monitoring.observationWindowMinutes !== 0) {
  context.addIssue({ code: "custom", message: `${kind} releases require immediate verification with a zero-minute observation window` });
}
```

Keep `version: 1` and omit defaults so legacy canonical payload hashes are not rewritten merely by parsing.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd test -- packages/core/test/contracts.test.ts packages/mcp-server/test/server.test.ts`

Expected: all focused contract and MCP tests pass.

---

### Task 3: Release And Completion Skill Policy

**Files:**
- Modify: `.agents/skills/agentflow-release-gate/SKILL.md`
- Modify: `.agents/skills/agentflow-release-gate/references/release-plan-contract.md`
- Modify: `.agents/skills/agentflow-completion-verifier/SKILL.md`
- Modify: `.agents/skills/agentflow-completion-verifier/references/final-manifest-contract.md`
- Modify: `packages/cli/test/distribution.test.ts`

**Interfaces:**
- Consumes: the release target kind from Task 2.
- Produces: deterministic source-control execution and evidence rules; preserves Worker-based production execution.

- [ ] **Step 1: Write failing distribution policy assertions**

Assert packaged Skill content states all of the following:

- safe source-control pushes use immediate remote-ref verification;
- they do not create a model Worker or timed observation;
- explicit one-time push/tag instructions can authorize only matching refs;
- package and production targets retain exact Release Gates;
- production retains a separately authorized Worker and positive observation window.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- packages/cli/test/distribution.test.ts`

Expected: FAIL because the current Skills describe one heavyweight release path.

- [ ] **Step 3: Update Skills and reference contracts**

Document the three kinds, authorization rules, deterministic Git preflight/postflight evidence, and production-only observation. Keep generic approvals invalid and forbid broadening a preauthorized source-control operation.

- [ ] **Step 4: Verify GREEN and validate Skills**

Run:

```powershell
npm.cmd test -- packages/cli/test/distribution.test.ts
$env:PYTHONUTF8='1'
python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\agentflow-auto-router
python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\agentflow-release-gate
python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\agentflow-completion-verifier
```

Expected: focused test passes and all three Skills report `Skill is valid!`.

---

### Task 4: Bilingual Guidance And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Produces: matching English and Chinese release behavior documentation.

- [ ] **Step 1: Add failing bilingual documentation assertions**

Extend `packages/cli/test/distribution.test.ts` to require both READMEs to describe safe Git synchronization, forbidden destructive operations, and production-only observation.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- packages/cli/test/distribution.test.ts`

Expected: FAIL because neither README currently documents the fast release boundary.

- [ ] **Step 3: Update both READMEs**

Add a concise release-routing section near automatic routing. Include examples for ordinary `git push`, a push-plus-tag request, package publication, and production deployment. State that a request containing code edits still starts or resumes AgentFlow.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:distribution
git diff --check
```

Expected: every test passes, typecheck/build/distribution exit zero, and no whitespace error is reported.

- [ ] **Step 5: Review the final diff**

Confirm the diff contains only the router contract, release contract, three release-related Skills/references, tests, bilingual docs, design, and plan. Confirm no force-push execution code or production Gate weakening was introduced.

