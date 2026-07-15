---
name: agentflow-completion-verifier
description: Verify actual release execution and produce the terminal AgentFlow final manifest during Stage S15. Use after an approved S14 release plan has been executed by a separately authorized release Worker and the run needs immutable deployment, health, incident, or rollback evidence before completion. Do not deploy, infer success from plan approval, or fabricate external evidence.
---

# AgentFlow Completion Verifier

Use the pinned `verification-before-completion` Skill for evidence discipline, then bind the verified release outcome to AgentFlow's complete Artifact lineage.

## Establish The Outcome

1. Confirm S15 is active, S14 is complete, and `release-approved` is bound to the current Release Plan hash.
2. Require a separately authorized release Worker result or equivalent external execution evidence. An approved plan, merge, tag, build, or successful preflight is not deployment evidence.
3. Match release ID, version, target environment, and immutable revision to the registered Release Plan.
4. Register deployed build references, release logs, health evidence, incidents, and rollback evidence as typed Artifacts before referencing them.
5. Run or inspect the plan's post-release health checks. Record observed timestamps and failures; never mark an unavailable check as passed.

## Build The Manifest

Create `final-manifest.json` following [references/final-manifest-contract.md](references/final-manifest-contract.md). Record exactly one outcome:

- `succeeded`: every health check passed, no unresolved blocker or critical incident exists, and no rollback occurred.
- `rolled-back`: include rollback time, reason, different target revision, and typed evidence.
- `failed`: include failed health evidence or an unresolved incident; do not disguise failure as residual risk.

Call `artifact_validate`, persist the normalized payload and hash, then call `artifact_register` for S15. Complete the Stage only after MCP verifies the full lineage and all typed evidence references.

If release execution never occurred or evidence is incomplete, leave S15 blocked and state the missing evidence. Do not create a placeholder Final Manifest.
