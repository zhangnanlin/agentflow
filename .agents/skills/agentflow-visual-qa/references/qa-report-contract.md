# QA Report Contract

The strict `qa-report` JSON payload contains:

- `version`: literal `1`, plus `summary`.
- `sourceIntegrationReport`: Artifact ID and SHA-256.
- `environment`: name, tested immutable revision, and optional base URL.
- `requirementIds[]`: the complete required QA scope.
- `testCases[]`: ID, name, quality category, requirement IDs, required flag, status, observed result, `recordedAt`, and typed evidence Artifact references.
- `qualityGates[]`: ID, name, category, required flag, status, summary, `recordedAt`, and typed evidence Artifact references.
- `findings[]`: ID, optional test-case ID, severity, status, description, evidence, and risk acceptance when accepted.
- `verdict`: `passed`, `failed`, or `blocked`.

Each requirement must be covered by a required test case. A passed report requires all required cases and gates to pass, no unresolved blocker or critical finding, and no open high finding. Accepted findings require an approver, reason, and optional expiry.

Represent functional, regression, performance, security, accessibility, visual, reliability, and operability evidence with categories. Keep viewports, Figma comparisons, reproduction steps, skipped-check rationale, and residual-risk detail in evidence Artifacts or the human-readable report; do not add undeclared JSON keys.
