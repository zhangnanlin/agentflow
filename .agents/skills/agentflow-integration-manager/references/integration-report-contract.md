# Integration Report Contract

The strict `integration-report` JSON payload contains:

- `version`: literal `1`, plus `summary`.
- `sourceImplementationPlan`: Artifact ID and SHA-256.
- `repository`: branch, immutable base revision, and immutable integrated revision.
- `planTaskIds[]` and `taskResults[]`: each Task's status, revisions, typed output Artifact references, verification check IDs, and optional exclusion reason.
- `checks[]`: ID, category, command, required flag, status, summary, `recordedAt`, and typed evidence Artifact references.
- `conflicts[]`: ID, involved Task IDs, status, and resolution.
- `issues[]`: ID, severity, status, description, and disposition.
- `verdict`: `passed` or `failed`.

Task results must cover the materialized plan generation exactly once and reference declared checks. Integrated Task revisions must exactly equal the ordered revisions in that Task's collected Git change set and share the plan's approved base revision; excluded Tasks require reasons. A passed report requires all Tasks integrated, every required check passed, all conflicts resolved, and no unresolved blocker or critical issue.

Record path-level reconciliation and worktree cleanup in the human-readable report or referenced evidence. Do not add undeclared keys to the strict JSON payload.
