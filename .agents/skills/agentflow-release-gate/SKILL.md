---
name: agentflow-release-gate
description: Prepare an auditable release plan and enforce the final human release decision during AgentFlow Stage S14. Use after System QA passes to assemble version, target, changes, migrations, rollout, observability, rollback, approvals, and verification evidence. Never deploy, publish, merge, tag, or mutate production before the bound user Gate is approved.
---

# AgentFlow Release Gate

Treat a passing QA recommendation as necessary but not sufficient for release. Deployment authority remains absent until the user explicitly approves the release plan bound to its Artifact hash.

## Prepare The Plan

1. Confirm S14 is active and the QA Report, integrated revision, and upstream approval hashes are current.
2. Identify the exact version/revision, target environment, release owner, included changes, compatibility, migrations, feature flags, dependencies, and maintenance constraints.
3. Define staged rollout, health signals, alert thresholds, smoke checks, abort conditions, rollback commands/procedure, data restoration limits, and post-release verification.
4. Separate pre-release checks from commands that create external side effects.
5. Record unresolved residual risks and required acknowledgements. Do not translate silence into acceptance.

## Gate

Write and register `release-plan.json` following [references/release-plan-contract.md](references/release-plan-contract.md). Present the target, revision, migrations, rollout, rollback, and risks to the user.

Resolve `release-approved` only from an explicit user approval bound to the current Release Plan and QA hashes. A rejection keeps deployment tools unavailable. After approval, a separately authorized release Worker may execute only the recorded plan and must persist deployment evidence; this Skill itself does not deploy.
