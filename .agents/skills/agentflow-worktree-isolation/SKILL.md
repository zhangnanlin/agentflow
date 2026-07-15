---
name: agentflow-worktree-isolation
description: Prepare and guard Git worktrees for AgentFlow implementation Workers during Stage S11. Use when two or more writable code Tasks can run concurrently, when an implementation Task explicitly requires branch isolation, or when validating that proposed Task write scopes are safe. Do not trigger for read-only research, Figma work, or a single serial Task already isolated by the host.
---

# AgentFlow Worktree Isolation

Create one isolated branch and worktree per writable Task. Follow [references/worktree-policy.md](references/worktree-policy.md) for naming, records, cleanup, and Windows handling.

## Preflight

1. Confirm the active Stage is S11 and the Task is ready.
2. Resolve the Git top level, current base commit, worktree list, repository status, and repository-local worktree convention.
3. Require the full current commit to equal the implementation plan's approved `repository.baseRevision`; a missing or different baseline blocks dispatch.
4. Verify `.worktrees/` or the selected directory is ignored before creating anything. Request approval before changing `.gitignore`; never commit that change automatically.
5. Compare all active `writeScopes`. Stop dispatch when scopes are equal, nested, ambiguous, or touch a shared generated file, migration chain, lockfile, or integration branch.
6. Run the repository's baseline verification in the base checkout. Report pre-existing failures before continuing.

## Create And Bind

1. Use deterministic, sanitized names derived from run ID and Task ID.
2. Claim the Task immediately before creating its workspace so write-scope conflict checks and lease ownership remain authoritative.
3. Create the branch and worktree from the recorded base commit with native Git commands.
4. Call `worker_dispatch_prepare` with Task ID, Worker ID, branch, absolute worktree path, base commit, lease, and live Adapter capabilities. MCP verifies the path against `git worktree list --porcelain` before binding it to Runtime state.
5. Give the Worker access only to its worktree. Always forbid `.agentflow/**`, secret files, other worktrees, and unrelated paths.
6. Heartbeat the lease during long setup or implementation.

If setup fails before a Worker is prepared, preserve the Git error and call `task_setup_abort` with the claimed Task and Worker IDs. Never wait for lease expiry or silently fall back to the project checkout.

## Dependencies

Do not install dependencies merely because a worktree was created. When installation is required:

- Require an existing lockfile and an approved registry.
- Prefer frozen or immutable installation.
- Disable lifecycle scripts by default, such as `npm ci --ignore-scripts`.
- Ask for approval before allowing scripts, downloads outside the package manager, or lockfile changes.

## Finish

Run every exact verification command declared on the Task, commit only allowed paths, and require a clean worktree. Return `changeSet.kind=git-commits` with the approved base revision, current HEAD, ordered `base..HEAD` revisions, and changed paths. A missing commit, dirty worktree, substituted command, or path outside scope cannot be reported as completed. Do not merge, delete branches, or remove worktrees; the Integration Stage owns those actions after results are collected.

Never run destructive reset, recursive cleanup, or cross-shell path deletion. If setup fails, preserve evidence and return `blocked` or `failed` instead of silently using the main checkout.
