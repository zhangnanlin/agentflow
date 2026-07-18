---
name: agentflow-auto-router
description: Route every project-changing request into AgentFlow while bypassing pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands. Use before editing a project, honor one-request agentflow:on, agentflow:off, and agentflow:full overrides, resume unfinished Runs, and preserve all human Gates.
---

# AgentFlow Auto Router

Classify the user's requested outcome before changing the project. Route qualifying work through `agentflow-orchestrator`; never make direct edits before the routing decision is complete.

## Decide

1. Check the current request for an explicit one-request override.
   - `agentflow:on` forces AgentFlow routing.
   - `agentflow:off` bypasses AgentFlow routing.
   - `agentflow:full` routes the request through the complete Full lane. Preserve the token in the original requirement so `run_start_or_resume` records the override.
2. Without an override, route every project-changing request. This includes new projects, features, bug fixes, refactors, tests, documentation edits, configuration changes, migrations, design work, package publication, and deployment.
3. Bypass AgentFlow for pure questions, code explanation, read-only inspection, status lookup, simple non-mutating commands, and a safe source-control sync that only pushes existing commits or tags without file changes.
4. Treat force push, ref deletion, history rewriting, release creation, package publication, deployment, migration, and any request with file changes as project-changing even when Git is also mentioned.
5. Classify mixed requests by their requested outcome. If the user asks to inspect and then change anything, route the whole request.

Read [references/routing-contract.md](references/routing-contract.md) when the request is ambiguous or when adding a new host instruction surface.

## Route

1. Resolve the project for this request. When the host exposes multiple workspace roots, pass the intended absolute `projectRoot` on this and every later AgentFlow MCP call. Never guess a root or store a mutable global current project.
2. Call `run_start_or_resume` before any other AgentFlow state mutation. Pass the user's original requirement, the new/existing project classification, the UI classification, and a stable request key. This is the only tool allowed to initialize a missing project.
3. Treat the returned project root and Run state as authoritative. Continue the returned unfinished Run rather than creating a duplicate; use the same explicit root for `pipeline_get`, `status_get`, and all later tools.
4. Read the persisted workflow lane, policy version, matched signals, and explanation. Do not replace the deterministic Core decision with a free-form lane choice.
5. Load `agentflow-orchestrator` and let it coordinate the active Stage, bounded Workers, verified Artifacts, and human Gates.
6. Preserve every human Gate. Never infer approval from silence or from a previous, unrelated approval.

## Reduce User Input

Inspect repository and Run evidence before asking anything. For a material bounded choice, use `structured_choice_request` or an already exposed native structured-input control. Batch at most three independent questions, but keep dependent questions sequential. Use one concise text fallback only when structured input is unavailable, and never repeat an accepted answer.

Pending human Gates are not normal clarification. Let `agentflow-orchestrator` use `gate_decision_request` so the persisted Gate and current Artifact hash remain authoritative; never treat a recommendation, silence, timeout, cancellation, or unrelated approval as a decision.

Do not edit project files, dispatch implementation Workers, or skip directly to a later Stage before `run_start_or_resume` has established or resumed the Run. Locks are project-local, so independent projects may proceed concurrently.

## Bypass

When the decision is bypass, handle the request normally without calling `run_start_or_resume`, creating project state, mutating a Run, or loading the orchestrator. For a safe source-control sync, verify a clean worktree, the exact local revision, remote URL, and fast-forward relationship before pushing; then read the remote refs and report the immutable result. Do not create a model Worker, release plan, or observation timer. Read-only MCP tools may report `PROJECT_NOT_INITIALIZED`; that is not permission to initialize. Override tokens apply only to the current user request and do not change future routing.
