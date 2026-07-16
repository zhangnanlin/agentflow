---
name: agentflow-completion-verifier
description: Verify actual source-control, package, or production release execution and produce the terminal AgentFlow final manifest during Stage S15. Use after an approved S14 plan has deterministic source-control evidence or a separately authorized package/production Worker result. Do not release, infer success from plan approval, or fabricate external evidence.
---

# AgentFlow Completion Verifier

Use the pinned `verification-before-completion` Skill for evidence discipline, then bind the verified release outcome to AgentFlow's complete Artifact lineage.

## Establish The Outcome

1. Confirm S15 is active, S14 is complete, and `release-approved` is bound to the current Release Plan hash.
2. Read `release.kind`, treating an omitted kind as `production`.
3. For `source-control`, accept deterministic Git execution evidence without a model Worker: require the exact local revision, pre-push remote ref, push result, final branch ref, and dereferenced tag ref when applicable. Its zero-minute observation window means immediate ref verification is terminal evidence.
4. For `package-registry`, require immutable registry or hosted-release evidence with immediate verification. For `production`, require a separately authorized release Worker result or equivalent external execution evidence plus the positive observation window. An approved plan, merge, tag, build, or successful preflight is not production deployment evidence.
5. Match release ID, version, target environment, and immutable revision to the registered Release Plan.
6. Register released Artifact references, execution logs, verification evidence, incidents, and rollback evidence as typed Artifacts before referencing them.
7. Run or inspect the plan's target-appropriate checks. Record observed timestamps and failures; never mark an unavailable check as passed.

## Build The Manifest

Create `final-manifest.json` following [references/final-manifest-contract.md](references/final-manifest-contract.md). Record exactly one outcome:

- `succeeded`: every health check passed, no unresolved blocker or critical incident exists, and no rollback occurred.
- `rolled-back`: include rollback time, reason, different target revision, and typed evidence.
- `failed`: include failed health evidence or an unresolved incident; do not disguise failure as residual risk.

Call `artifact_validate`, persist the normalized payload and hash, then call `artifact_register` for S15. Complete the Stage only after MCP verifies the full lineage and all typed evidence references.

If release execution never occurred or evidence is incomplete, leave S15 blocked and state the missing evidence. Do not create a placeholder Final Manifest.
