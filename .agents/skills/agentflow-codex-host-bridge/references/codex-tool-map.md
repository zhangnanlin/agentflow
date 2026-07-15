# Codex Native Tool Map

Use the current host's equivalent operation when names differ. Never substitute GUI automation.

| AgentFlow capability | Codex collaboration operation | Persistence step |
|---|---|---|
| `spawn` | Spawn a subagent/background task with a bounded prompt | `worker_dispatch_prepare`, native spawn, then `worker_bind` |
| `send` | Send a message to a running Worker; use follow-up for an idle Worker | No status change; retain an audit summary outside raw prompt logs |
| `status` | List or inspect native Workers | `worker_observe` for non-terminal state |
| `collect` | Wait for and read the terminal structured result | `worker_collect` |
| `interrupt` | Interrupt the native Worker | `worker_interrupt` after confirmation |
| `close` | Often unavailable for Codex subagents | Keep false; do not simulate it |

## Codex Collaboration Defaults

- Prefer the native collaboration/subagent API for internal Worker Tasks.
- Do not create a user-owned top-level Codex task unless the user explicitly requested one.
- Use an exact task name such as `af_<run>_<task>_<worker>`, normalized to lowercase letters, digits, and underscores.
- Pass no inherited turns when possible. The AgentFlow dispatch envelope must contain the necessary context.
- Bind the stable native agent/thread identifier, not a display title.
- Use list/inspect by ID after binding; use the exact task name only to recover a prepared-but-unbound dispatch.

## Recovery Decisions

| AgentFlow record | Native lookup | Action |
|---|---|---|
| prepared, no ID | exactly one name match | bind that native ID |
| prepared, no ID | no match | replay the original prepare key, spawn once with the returned prompt, then bind |
| prepared, no ID | multiple matches | stop and reconcile |
| running, bound ID | native running | observe running and continue heartbeat |
| running, bound ID | native terminal with valid JSON | collect |
| running, bound ID | native missing | mark unknown and report; do not respawn automatically |
| live Worker | native terminal with invalid JSON | fail Worker, retry Task with a fresh Worker ID |
| claimed setup, no Worker | worktree creation or prepare failed | preserve the error and call `task_setup_abort` |
| terminal | any | do not redispatch |

When the lease is near expiry, heartbeat only after confirming that the bound native Worker still exists and owns the same Task.
