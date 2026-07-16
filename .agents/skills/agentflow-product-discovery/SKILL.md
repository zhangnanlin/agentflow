---
name: agentflow-product-discovery
description: Clarify an ambiguous product request into an approved, testable AgentFlow product brief during Stage S01. Use for a new project or a meaningful existing-product change that needs user, problem, scope, constraints, success metrics, and approach decisions before PRD, UX, Figma, architecture, planning, or implementation begins.
---

# AgentFlow Product Discovery

Use the installed Superpowers `brainstorming` Skill as the dialogue method, then adapt its output to the AgentFlow product-brief contract. Do not let brainstorming continue into `writing-plans` or implementation.

## Discover

1. Confirm the active Stage is S01 and read S00 `project-context` by URI and hash.
2. For an existing project, inspect the relevant repository behavior, current design system, documentation, and constraints before proposing changes.
3. Inspect repository and Run evidence first. For material bounded tradeoffs, use `structured_choice_request` or an exposed native equivalent; batch at most three independent questions and ask dependent questions later.
4. Establish users, problem, desired outcome, current behavior, scope, non-goals, constraints, risks, dependencies, success metrics, and unresolved decisions.
5. Present two or three viable approaches with tradeoffs and a recommendation. Avoid visual styling decisions that belong to the Figma concept Stage.
6. Show the consolidated brief to the user and obtain explicit confirmation before registering it.

If structured input is unavailable, ask one concise text fallback once. Never repeat an accepted answer or infer one from the recommendation, silence, timeout, or cancellation.

## Produce

Write both `product-brief.md` for people and `product-brief.json` for automation. Follow [references/product-brief-schema.md](references/product-brief-schema.md). Keep uncertain statements in `openQuestions`; do not turn assumptions into requirements.

Call `artifact_validate` with kind `product-brief`, write the normalized payload, and register one S01 Artifact with the returned hash and the same payload. If the user changes a confirmed decision, update both files and register the new validated hash so Core can invalidate dependent approvals.

## Stop Boundary

After the brief is accepted, complete only S01. Do not call Figma tools, generate a PRD, choose a framework, create an engineering plan, open worktrees, or write product code. The Orchestrator selects the next Stage and its Skills.
