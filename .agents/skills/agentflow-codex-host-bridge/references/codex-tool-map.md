# Codex Native Tool Map

Use the current host's equivalent operation when names differ. Never substitute GUI automation.

| AgentFlow capability | Codex collaboration operation | Persistence step |
|---|---|---|
| `spawn` | Spawn a subagent/background task with a bounded prompt | `worker_dispatch_prepare`, native spawn, then `worker_bind` |
| `send` | Send a message to a running Worker; use follow-up for an idle Worker | No status change; retain an audit summary outside raw prompt logs |
| `status` | List or inspect native Workers | `worker_observe` for non-terminal state |
| `collect` | One event-driven wait for and read of the terminal structured result | `worker_collect` |
| `interrupt` | Interrupt the native Worker | `worker_interrupt` after confirmation |
| `close` | Close native execution when exposed | Record the confirmed close in `worker_cleanup_record` |
| `archive` | Archive/remove a completed Codex child task when exposed | Record the confirmed archive in `worker_cleanup_record` |

## Structured User Input

`host.user-input.structured` is a user interaction capability, not a Worker lifecycle capability. In Codex Default mode, prefer `structured_choice_request` or an already exposed native structured-input control for bounded choices and `gate_decision_request` for pending human Gates. Do not create a user-owned task and never use GUI automation to collect a choice. On resume, reload the persisted Gate first and do not ask again after an accepted response.

For a bound live Worker, never substitute `task_complete` for `worker_collect`. Any valid terminal structured result, including `blocked` or `failed`, goes through `worker_collect`; a confirmed native or protocol failure without a valid result goes through `worker_fail`; a confirmed native interruption goes through `worker_interrupt`. Task completion does not prove that the native Worker stopped.

## Codex Collaboration Defaults

- Prefer the native collaboration/subagent API for internal Worker Tasks.
- Do not create a user-owned top-level Codex task unless the user explicitly requested one.
- Use an exact task name such as `af_<run>_<task>_<worker>`, normalized to lowercase letters, digits, and underscores.
- Require a fresh native task with exactly zero inherited turns. If the host cannot attest this, do not dispatch and use inline or serial Supervisor execution.
- Bind the stable native agent/thread identifier, not a display title.
- Bind the complete native v2 handle and require an enforced tool allowlist with AgentFlow MCP disabled.
- Use list/inspect by ID after binding; use the exact task name only to recover a prepared-but-unbound dispatch.
- While native Workers run, keep executing the Supervisor-owned Task for the same independent wave; do not spend repeated model turns polling.

## Recovery Decisions

| AgentFlow record | Native lookup | Action |
|---|---|---|
| prepared, no ID | exactly one name match | bind that native ID |
| prepared, no ID | no match | replay the original prepare key, spawn once with the returned prompt, then bind |
| prepared, no ID | multiple matches | stop and reconcile |
| running, bound ID | native running | observe running and continue heartbeat |
| running, bound ID | native terminal with valid JSON | collect |
| running, bound ID | native missing | mark unknown and report; do not respawn automatically |
| live Worker | native terminal with invalid JSON or confirmed failure without a valid result | fail Worker, then retry Task with a fresh Worker ID when allowed |
| live Worker | native interruption confirmed | record the interruption; redispatch only after AgentFlow readies the Task |
| Task appears terminal, Worker is live | any | inspect by bound ID; call `worker_fail` or `worker_interrupt` only after the corresponding failure or interruption is confirmed, and stop for state reconciliation without completing the Stage if a valid result cannot be collected from the non-running Task |
| claimed setup, no Worker | worktree creation or prepare failed | preserve the error and call `task_setup_abort` |
| terminal result collected, cleanup pending | native task found | close, archive when supported, release its permit, then persist the exact `worker_cleanup_record` receipt |
| terminal result collected, cleanup pending | native operation unsupported | persist `unsupported`; never fabricate success or redispatch |
| terminal and cleanup complete | any | do not redispatch |

When the lease is near expiry, heartbeat only after confirming that the bound native Worker still exists and owns the same Task.
Before `stage_complete`, reload AgentFlow status, require no `prepared`, `starting`, `running`, or `unknown` Worker whose Task belongs to the Stage, and reconcile every supported pending cleanup step.
