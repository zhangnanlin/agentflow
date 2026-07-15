# Final Manifest Contract

The strict `final-manifest` JSON payload contains:

- `version`: literal `1`, plus `summary`.
- `lineage`: current Artifact IDs and SHA-256 values for architecture, implementation plan, integration report, QA report, and release plan.
- `release`: release ID, version, target environment, immutable revision, `releasedAt`, and outcome.
- `deployedArtifacts[]` and `releaseEvidence[]`: typed Artifact IDs, kinds, and SHA-256 values.
- `healthChecks[]`: ID, name, status, `checkedAt`, summary, and typed evidence.
- `incidents[]`: ID, severity, status, description, and typed evidence.
- `rollback`: required only for `rolled-back`; time, reason, different target revision, and typed evidence.

A successful outcome requires every health check to pass, no unresolved blocker or critical incident, and no rollback record. A rolled-back outcome requires rollback evidence. A failed outcome must have failed health evidence or an unresolved incident.

MCP registration rejects stale, missing, wrong-kind, or wrong-hash references. It also checks the direct source ID/hash chain between every lineage Artifact and requires matching integration/QA verdicts, release readiness, release identity, target, and revision.
