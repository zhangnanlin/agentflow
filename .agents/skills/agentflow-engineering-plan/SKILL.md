---
name: agentflow-engineering-plan
description: Convert an approved AgentFlow architecture into an executable, dependency-aware engineering plan during Stage S10. Use when work must be split into bounded implementation, migration, test, documentation, and review Tasks with paths, inputs, verification, and worktree decisions before any coding begins. Wrap the pinned Superpowers writing-plans Skill and stop at the human engineering-plan Gate.
---

# AgentFlow Engineering Plan

Use the pinned `writing-plans` Skill for planning discipline, then adapt its output to AgentFlow's persistent Task and Artifact contracts.

## Build The Task DAG

1. Confirm S10 is active and the Architecture Artifact hash is current.
2. Inspect the repository paths named by the architecture. Do not plan against guessed modules.
3. Record the integration branch and full current Git base revision in the plan. Stop when the repository has no commit baseline or the intended base is not explicit.
4. Split work into small Tasks with one observable outcome each.
5. Give every Task explicit dependencies, input Artifact hashes, allowed write paths, forbidden paths, verification commands, and expected outputs.
6. Separate shared contracts or migrations from dependent frontend/backend work so dependency order is enforceable.
7. Mark Tasks that may run concurrently and prove their write scopes do not overlap. Require `agentflow-worktree-isolation` for two or more concurrent writers.
8. Include integration, negative tests, security checks, docs, data migration/rollback, and review Tasks when relevant.
9. Map each must-level requirement, architecture decision, and high-risk item to at least one Task and verification command.

## Validate And Gate

Write `implementation-plan.json` following [references/implementation-plan-contract.md](references/implementation-plan-contract.md). Validate and register it before presenting a concise plan summary to the user.

Inspect architecture, repository, and Run evidence before asking. Use `structured_choice_request` for material bounded planning choices, with at most three independent questions and one concise text fallback only when structured input is unavailable. Never repeat an accepted answer.

Request `engineering-plan-approved` with `gate_decision_request` and resolve it only from an explicit user decision bound to the current implementation-plan Artifact hash. Recommendation, silence, timeout, cancellation, and unrelated approval never count. Do not create S11 Tasks or edit production code before approval.

After approval, leave Task creation to the Supervisor. It must complete S10, confirm S11 is active, and call `implementation_plan_materialize` once with the exact registered payload. Do not loop over `task_create`; the atomic materializer is the only supported plan-to-runtime handoff.
