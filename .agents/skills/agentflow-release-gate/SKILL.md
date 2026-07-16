---
name: agentflow-release-gate
description: Prepare an auditable release plan and enforce the final human release decision during AgentFlow Stage S14. Use after System QA passes to assemble version, target, changes, migrations, rollout, observability, rollback, approvals, and verification evidence. Never deploy, publish, merge, tag, or mutate production before the bound user Gate is approved.
---

# AgentFlow Release Gate

Treat a passing QA recommendation as necessary but not sufficient for release. Deployment authority remains absent until the user explicitly approves the release plan bound to its Artifact hash.

## Classify The Target

Set `release.kind` before planning:

- `source-control` changes only ordinary branch or annotated-tag refs for commits that already exist locally.
- `package-registry` publishes an immutable package or creates a hosted release object.
- `production` changes a running environment, production data, or deployed traffic.

Omitted kinds retain legacy `production` behavior. Never classify force push, ref deletion, history rewriting, package publication, release creation, migration, or deployment as a safe Git synchronization.

## Prepare The Plan

1. Confirm S14 is active and the QA Report, integrated revision, and upstream approval hashes are current.
2. Identify the exact version/revision, target environment, release owner, included changes, compatibility, migrations, feature flags, dependencies, and maintenance constraints.
3. Define staged rollout, health signals, alert thresholds, smoke checks, abort conditions, rollback commands/procedure, data restoration limits, and post-release verification.
4. Separate pre-release checks from commands that create external side effects.
5. Record unresolved residual risks and required acknowledgements. Do not translate silence into acceptance.

For `source-control`, use `monitoring.observationWindowMinutes: 0` and immediate remote-ref verification. Record the local revision, pre-push remote ref, exact push command, final branch ref, and dereferenced tag ref when present. A deterministic safe source-control push does not require a model Worker or a timed observation. The Supervisor may execute the bounded Git commands directly after authorization.

For `package-registry`, also use a zero-minute window but require immediate immutable registry or hosted-release evidence and the exact Release Gate. For `production`, require a positive observation window, health and rollback signals, and a separately authorized release Worker.

## Gate

Write and register `release-plan.json` following [references/release-plan-contract.md](references/release-plan-contract.md). Present the target, revision, migrations, rollout, rollback, and risks to the user.

Use `structured_choice_request` only for bounded release-plan clarification after inspecting QA, repository, and Run evidence. For the release Gate itself, use `gate_decision_request` so the decision is bound to the current Release Plan Artifact hash and requires one explicit interaction.

Resolve `release-approved` only from explicit authorization. A prior user instruction such as "push when complete" or "create and push v1.2.3" may authorize one matching `source-control` plan at the exact QA-approved revision; bind the original instruction, plan hash, QA hash, remote, and refs in the Gate resolution. Generic "continue" messages, recommendation, silence, timeout, cancellation, and approval for another artifact never count, and the operation cannot broaden beyond the named refs. `package-registry` and `production` always require approval of the current Release Plan and QA hashes after they are presented. If structured input is unavailable, use one concise text fallback only once.

A rejection keeps release tools unavailable. After approval, source-control uses the bounded deterministic path above. Package and production execution require a separately authorized release Worker that runs only the recorded plan and persists external evidence; this Skill itself does not publish packages or deploy production.
