# Implementation Plan Contract

The strict `implementation-plan` JSON payload contains:

- `version`: literal `1`, plus `title` and `summary`.
- `sourceArchitecture` and `sourcePrd`: Artifact IDs and SHA-256 values.
- `repository`: the approved integration branch and immutable full Git base revision.
- `scope`: all requirement IDs and architecture component IDs covered by the plan.
- `tasks[]`: ID, title, description, Worker `profile`, component IDs, requirement IDs, dependency Task IDs, typed input Artifact IDs/kinds/hashes, `writeScopes`, `forbiddenScopes`, acceptance criteria, verification commands, expected outputs, `requiresWorktree`, and risk.
- `waves[]`: ordered groups of Task IDs with exit criteria.
- `integrationStrategy`: every Task ID in dependency-respecting order, conflict policy, and repository-wide verification commands.

Task, wave, input Artifact, path, and verification identifiers must be unique where applicable. Dependencies must exist and be acyclic. Every scoped component and requirement must be owned by at least one Task. Every Task appears in exactly one wave and once in the integration order.

Two or more writable Tasks in one wave must all require worktrees and have disjoint write scopes. Scope comparison is conservative: equal, nested, or wildcard roots that may overlap are rejected. Keep broader assumptions and open questions in the human-readable plan; do not add undeclared JSON keys.

## Runtime Materialization

After the bound human Gate is approved and S11 becomes active, call `implementation_plan_materialize` with the registered Artifact ID and exact payload. Core recomputes the payload hash and creates the complete DAG in one transaction.

Each Runtime Task persists its profile, wave and wave index, component and requirement IDs, dependencies, typed input IDs/kinds/hashes/URIs, write and forbidden scopes, acceptance criteria, verification commands, expected outputs, worktree decision, risk, approved repository baseline, and source plan ID/hash. The source plan is automatically added as a Task input. Later waves remain pending until every earlier-wave Task is completed or cancelled, even when a later Task has no explicit dependency.

An identical idempotency retry returns the original state. A different retry cannot duplicate the DAG. If the source plan hash changes, its generated Tasks are cancelled; only renewed human approval and a new atomic materialization can replace them.
