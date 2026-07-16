---
name: agentflow-auto-router
description: Route every project-changing request into AgentFlow while bypassing pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands. Use before editing a project, honor one-request agentflow:on and agentflow:off overrides, resume unfinished Runs, and preserve all human Gates.
---

# AgentFlow Auto Router

Classify the user's requested outcome before changing the project. Route qualifying work through `agentflow-orchestrator`; never make direct edits before the routing decision is complete.

## Decide

1. Check the current request for an explicit one-request override.
   - `agentflow:on` forces AgentFlow routing.
   - `agentflow:off` bypasses AgentFlow routing.
2. Without an override, route every project-changing request. This includes new projects, features, bug fixes, refactors, tests, documentation edits, configuration changes, migrations, design work, and releases.
3. Bypass AgentFlow only for pure questions, code explanation, read-only inspection, status lookup, and simple commands that do not modify the project.
4. Classify mixed requests by their requested outcome. If the user asks to inspect and then change anything, route the whole request.

Read [references/routing-contract.md](references/routing-contract.md) when the request is ambiguous or when adding a new host instruction surface.

## Route

1. Inspect `.agentflow/current-run.json` or call AgentFlow `status_get` before starting work.
2. If an unfinished Run exists, resume that Run. Never create a duplicate Run for the same ongoing requirement.
3. If no unfinished Run exists, preserve the user's original requirement exactly and start the appropriate new/existing-project and UI/non-UI profile.
4. Load `agentflow-orchestrator` and let it coordinate the staged workflow and bounded Workers.
5. Preserve every human Gate. Never infer approval from silence or from a previous, unrelated approval.

Do not edit project files, dispatch implementation Workers, or skip directly to a later Stage before the Supervisor has established or resumed the Run.

## Bypass

When the decision is bypass, handle the request normally without creating, mutating, or resuming an AgentFlow Run. Override tokens apply only to the current user request and do not change future routing.
