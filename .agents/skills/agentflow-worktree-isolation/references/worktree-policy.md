# Worktree Policy

Read this reference before creating or cleaning a code Worker's workspace.

## Naming

- Branch: `agentflow/<run-id>/<task-id>`
- Default local path: `.worktrees/<run-id>/<task-id>`
- Normalize each segment to lowercase ASCII letters, digits, and hyphens. Reject empty, `.` and `..` segments.
- Record the resolved absolute path and verify it remains inside the selected worktree root.

## Safe Command Sequence

Inspect first:

```text
git rev-parse --show-toplevel
git status --short
git rev-parse HEAD
git worktree list --porcelain
git check-ignore -q .worktrees
```

After preflight and Task claim:

```text
git worktree add <absolute-path> -b agentflow/<run-id>/<task-id> <base-commit>
git -C <absolute-path> status --short
```

Pass command arguments as an argument array when the host API supports it. Do not concatenate untrusted IDs into a shell command.

## Runtime Record

Persist at least:

```json
{
  "runId": "run-id",
  "taskId": "task-id",
  "workerId": "worker-id",
  "branch": "agentflow/run-id/task-id",
  "worktreePath": "absolute verified path",
  "baseCommit": "full commit hash",
  "allowedPaths": ["scoped/**"],
  "forbiddenPaths": [".agentflow/**", ".env"],
  "createdAt": "ISO-8601 timestamp"
}
```

The base commit must equal the approved implementation plan baseline. Completion records a clean `git-commits` change set containing `baseRevision`, `headRevision`, the ordered commit list, and normalized repository-relative changed paths.

## Cleanup Ownership

Only the Integration Manager may clean a completed worktree after its verified commit change set is collected and integration verification passes. Before a recursive move or delete on Windows, resolve the absolute path again and prove it is inside the configured worktree root. Use native PowerShell filesystem operations end to end; never enumerate paths in one shell and delete them in another.
