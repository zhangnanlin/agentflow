# Release Plan Contract

The strict `release-plan` JSON payload contains:

- `version`: literal `1`, plus `summary`.
- `sourceQaReport`: Artifact ID and SHA-256, plus the claimed `qaVerdict`.
- `release`: release ID, version, target environment, and immutable revision.
- `releaseArtifacts[]`: typed Artifact IDs, kinds, and SHA-256 values.
- `preflightChecks[]`: ID, description, required flag, status, optional `checkedAt`, and typed evidence.
- `rolloutSteps[]`: ID, description, dependency step IDs, and verification commands.
- `rollback`: owner, different target revision, triggers, steps, and verification commands.
- `monitoring`: owner, observation window, and signals with thresholds and responses.
- `knownRisks[]`: ID, severity, status, description, mitigation, and risk acceptance when accepted.
- `readiness`: `ready` or `blocked`.

Rollout dependencies must exist and be acyclic. Completed preflight checks require `checkedAt`; pending checks cannot have it. A ready plan requires a passed QA verdict, every required preflight passed, no unmitigated blocker or critical risk, and no open high risk.

The MCP also requires the release revision to match the QA-tested revision and binds identity fields into Artifact metadata. Keep detailed changes, migrations, compatibility, rollout timing, and post-release procedures in the companion plan; do not claim they ran and do not add undeclared JSON keys.
