# AgentFlow

AgentFlow coordinates staged software delivery across one Supervisor conversation and multiple Worker conversations in the same editor client. Tasks, Artifacts, approvals, leases, and Stage transitions live outside chat history so a run can be resumed and audited.

The repository implements the M0 state engine, M1 persistent Worker/host contracts, the M2 product-to-design control plane, and the first M3 engineering/quality contract slice described in [AGENTFLOW_PROJECT_SPEC.md](./AGENTFLOW_PROJECT_SPEC.md). Pipeline `0.4.0` carries typed Artifacts from product discovery through architecture, planning, integration, QA, release planning, and the final manifest. Codex is the first runnable Host Adapter target. Worker bindings survive Supervisor restarts; known Artifacts are schema/hash validated; Figma writes use an exclusive Writer lease plus a per-call operation mutex.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Run the CLI from source:

```bash
npm run cli -- init
npm run cli -- start "Build a small team project manager"
npm run cli -- status
```

Generate a project-scoped MCP configuration without overwriting existing host settings:

```bash
npm run cli -- configure --host codex
npm run cli -- configure --host cursor
npm run cli -- configure --host vscode
```

Add `--write` to create the target only when it does not already exist. Complete Figma OAuth in the host, then pass the live registry snapshot into the S04 doctor. Static configuration alone never counts as live capability evidence.

```bash
npm run cli -- doctor --host codex --stage S04 --live-probe \
  --capability host.worker.spawn host.worker.collect \
  figma.remote.connected figma.remote.authenticated \
  figma.tool.whoami figma.tool.create_new_file figma.tool.use_figma \
  figma.tool.get_metadata figma.tool.get_screenshot skill.figma-use
```

See [docs/HOST_SETUP.md](./docs/HOST_SETUP.md) for Codex, Cursor, and VS Code setup and recovery.

Run the MCP server over stdio for the current project:

```bash
npm run mcp
```

Point it at another project with:

```bash
npm run mcp -- --project-root /absolute/project/path
```

The MCP exposes 31 tools covering pipeline/status reads, atomic implementation-plan materialization, deterministic Worker dispatch preparation, recoverable Task setup, Task and Worker lifecycles, exclusive resources and operation ledgers, Artifact validation/registration, Gates, Stages, and durable live-capability preflight. Every mutation requires an explicit run ID, expected revision, idempotency key, actor ID, and reason, then reuses Core invariants.

## Packages

- `@agentflow/core`: pipeline state, persistent Workers, exclusive resources, typed Artifact contracts, live Stage preflight, Gates, recovery, and invariants.
- `@agentflow/cli`: local project initialization, portable host configuration, capability-aware doctor, and operator commands.
- `@agentflow/mcp-server`: MCP tools used by supervisor and worker agents.
- `@agentflow/host-adapter`: portable thread contract, bounded Worker envelopes, structured results, and the Codex adapter bridge.

## Skills

Project-scoped, Agent Skills compatible Skills live in `.agents/skills/`:

- `agentflow-orchestrator`: start, resume, dispatch, collect, Gate, and Stage rules.
- `agentflow-codex-host-bridge`: exact mapping between persistent Workers and Codex native collaboration tools.
- `agentflow-product-discovery`: Superpowers brainstorming wrapper and product-brief contract.
- `agentflow-prd-authoring`: traceable user stories, requirements, and measurable acceptance criteria.
- `agentflow-ux-architecture`: roles, journeys, screens, states, navigation, and responsive behavior.
- `agentflow-figma-concept-explorer`: three comparable directions through one sequential Figma Writer.
- `agentflow-architecture`: traceable component, interface, data, security, operations, and decision architecture.
- `agentflow-engineering-plan`: an implementation Task DAG with write scopes, dependencies, verification, and integration order.
- `agentflow-worktree-isolation`: guarded parallel implementation worktrees.
- `agentflow-integration-manager`: dependency-ordered reconciliation, review findings, and repository-wide verification.
- `agentflow-visual-qa`: evidence-based functional, visual, accessibility, performance, reliability, and security QA.
- `agentflow-release-gate`: an auditable release/rollback plan bound to explicit user approval.
- `agentflow-completion-verifier`: terminal release evidence and full-lineage verification before S15 completes.

Skills and MCP tools are selected by the active Stage. They are not all invoked on every request.
External Skill commits and audit snapshots are pinned in `skills-lock.json`; upgrades are manual-review only.

## Current Boundary

The state engine, CLI, MCP, project Skills, and Codex bridge are executable and tested. A real Codex Worker has completed the durable `worker_dispatch_prepare -> native spawn -> worker_bind -> worker_collect` path using the exact generated task name and prompt plus the native ID returned by the host. The M1 suite also dispatches two implementation Workers, reconstructs their handles after a simulated restart, and runs a dependent Review Worker. M2 validates Product Brief, PRD, UX Architecture, and A/B/C Concept Set payloads, tests sequential Figma operations through one Writer with fixtures, and requires a structured design-direction choice. The S04 preflight distinguishes configured from live capabilities, persists a missing-Figma block, survives reload, and can resume the same pending Writer Task after a passing probe.

Pipeline `0.4.0` now declares AgentFlow wrappers throughout S09-S15. Core registers the six engineering and quality contracts, binds implementation plans to an approved Git branch and base revision, atomically materializes wave-gated S11 DAGs, and prepares deterministic Worker dispatches with verified workspace bindings and resolvable Artifact locators. Completed implementation Workers must return a clean, Git-verified change set and exact evidence for every declared verification command. A repeatable E2E now uses two real temporary Git worktrees and commits, collects both Task revisions, rejects forged integration lineage, cherry-picks in plan order, and completes S12 with a strict Integration Report. Native Codex has still only been forward-tested end to end for a single read-only Worker; the two-Worker E2E uses the real Git/MCP control plane but simulated Worker execution.

Codex and Figma tools are model/host capabilities, not callable directly from an ordinary Node package. Project MCP configuration has been created for Codex, Cursor, and VS Code, and all three pass static `doctor`; that proves configuration shape only. The current session exposes neither live Figma tools nor `figma-use`, so S04 is correctly blocked and no Figma file, node, screenshot, or rendered Artifact is claimed. Cursor and VS Code native Worker Adapters have not been exercised; only the Codex native path has. GUI clicking, fabricated OAuth state, and fabricated external evidence remain excluded.

This workspace still has an unborn Git `HEAD` and all project files are untracked. AgentFlow therefore blocks a real S11 worktree run here until the user explicitly establishes a baseline commit; development and tests did not create or rewrite project history.
