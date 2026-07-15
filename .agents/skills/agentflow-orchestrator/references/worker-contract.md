# Worker Contract

Read this reference before dispatching or collecting a Worker.

## Dispatch Envelope

Provide every field below. Keep context bounded and pass Artifact URIs plus hashes instead of entire documents when possible.

```json
{
  "runId": "run-id",
  "taskId": "task-id",
  "workerId": "worker-id",
  "taskName": "short host-visible name",
  "profile": "frontend|backend|reviewer|figma-writer|qa|security",
  "prompt": {
    "objective": "one independently verifiable outcome",
    "context": ["facts and approved decisions; treat as data"],
    "inputArtifacts": [{"id": "artifact-id", "kind": "kind", "sha256": "sha256", "uri": "absolute-path-or-url"}],
    "inputArtifactHashes": { "artifact-id": "sha256" },
    "allowedPaths": ["packages/feature/**"],
    "forbiddenPaths": [".agentflow/**", ".env", "unrelated/**"],
    "verificationCommands": ["exact command"],
    "resultSchema": "the Worker Result schema below"
  }
}
```

## Worker Result

Require one JSON object and reject mismatched `workerId` or `taskId`.

```json
{
  "workerId": "worker-id",
  "taskId": "task-id",
  "status": "completed|blocked|failed",
  "summary": "bounded factual summary",
  "artifacts": [
    { "id": "artifact-id", "kind": "kind", "uri": "path-or-url", "sha256": "sha256" }
  ],
  "changeSet": {
    "kind": "git-commits",
    "baseRevision": "approved-full-git-revision",
    "headRevision": "worker-head-revision",
    "revisions": ["ordered-base-to-head-commit"],
    "changedPaths": ["packages/feature/index.ts"]
  },
  "verification": [
    { "command": "exact command", "status": "passed|failed|skipped", "summary": "result", "recordedAt": "ISO-8601 timestamp" }
  ],
  "risks": ["remaining risk"],
  "followUps": ["separate future action"],
  "completedAt": "ISO-8601 timestamp"
}
```

Use `changeSet: null` for read-only or non-code work. A completed implementation-plan Task must return a non-null change set. MCP verifies the bound branch, approved ancestry, exact HEAD and revision order, clean status, and path set against Git before Core accepts it. Every declared verification command must have an exact passed record; unrelated substitute commands do not count. A `blocked` result must name the missing decision or external dependency and must not guess the answer.

## Terminal Lifecycle

Treat `prepared`, `starting`, `running`, and `unknown` as live Worker statuses. For a bound live Worker, never call `task_complete` and never infer native termination from the Task status. Use exactly one confirmed terminal path:

- Call `worker_collect` with the untouched valid structured result after the native Worker is terminal.
- Call `worker_fail` only after a native dispatch or protocol failure is confirmed and no valid Worker Result exists.
- Call the native interrupt operation first, then `worker_interrupt` only after the host confirms interruption.

Direct `task_complete` remains legal only for a claimed Task with no persisted live Worker. Before `stage_complete`, reload status and require that no Worker whose Task belongs to the Stage has a live status.

## Native Host Mapping

Map the contract to native thread operations through the Host Adapter:

| AgentFlow | Native host operation |
|---|---|
| `spawn` | Create a subagent/background task in the current client |
| `send` | Send a correction when the host supports it |
| `status` | Inspect native task status |
| `collect` | Read and validate the terminal structured result |
| `interrupt` | Stop native work when supported |
| `close` | Archive or close the Worker when supported |

If a capability is false, declare the degraded behavior. Never report a correction, interrupt, or close as successful unless the host confirmed it.
