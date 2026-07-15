---
name: agentflow-architecture
description: Produce a traceable software architecture and ADR set during AgentFlow Stage S09 from approved product, design-handoff, and repository evidence. Use for new systems or meaningful existing-system changes that need boundaries, APIs, data, security, reliability, observability, deployment shape, and explicit tradeoffs before engineering planning. Do not use to implement production code.
---

# AgentFlow Architecture

Treat approved Artifact hashes and the current repository as inputs. Do not invent external services, credentials, or operational guarantees.

## Establish Context

1. Confirm S09 is active and upstream Artifacts are current.
2. For existing projects, inspect runtime boundaries, package manifests, schemas, migrations, tests, deployment files, and relevant ADRs before proposing changes.
3. For UI projects, consume the frozen `design-manifest`; for non-UI projects, consume the approved PRD and any skipped-stage record.
4. Record assumptions and unresolved decisions instead of silently choosing high-impact infrastructure.

## Define The Architecture

1. Describe system boundaries, modules, ownership, and dependency direction.
2. Define API contracts, data ownership, consistency rules, migrations, and compatibility strategy where applicable.
3. Map each must-level requirement and NFR to one or more architecture decisions.
4. Cover authentication, authorization, secrets, privacy, abuse cases, failure modes, retry/idempotency behavior, observability, operability, and rollback.
5. Write ADRs with context, considered options, decision, consequences, and reversal conditions.
6. Keep implementation choices compatible with the repository unless a documented decision justifies migration.

## Persist And Stop

Write human-readable architecture documentation plus `architecture.json` following [references/architecture-contract.md](references/architecture-contract.md). Call `artifact_validate`, persist its normalized payload and hash, then call `artifact_register` for S09.

Stop after the Architecture Artifact is valid. Do not create the engineering Task DAG or edit production code; S10 owns planning.
