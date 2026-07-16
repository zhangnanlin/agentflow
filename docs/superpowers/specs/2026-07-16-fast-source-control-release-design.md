# AgentFlow Fast Source-Control Release Design

## Status

- Date: 2026-07-16
- Decision: approved by the user's request to make ordinary Git publication use a fast path
- Scope: automatic routing, release-plan contracts, release Skills, and bilingual user guidance

## Problem

AgentFlow currently treats every release request as a full delivery Run. The release contract also requires a positive observation window, and the release Skills assume an independently dispatched model Worker. That is appropriate for production deployment, but it turns a deterministic `git push` of already verified commits into unnecessary planning, Worker dispatch, repeated approval, and waiting.

## Selected Approach

Separate release work by target kind:

- `source-control`: push existing commits or annotated tags to an ordinary remote.
- `package-registry`: publish an immutable package to a registry.
- `production`: change a running environment, production data, or deployed traffic.

Safe source-control synchronization gets a router fast path. Package publication and production deployment remain AgentFlow releases. A full AgentFlow Run may also end in a source-control release, but it uses immediate ref verification and no timed observation.

## Router Fast Path

A request may bypass AgentFlow only when every requested side effect is one of:

- push the current branch without force;
- push a named existing local branch;
- push an existing local tag;
- create one annotated tag at the already verified current revision and push it.

The fast path is forbidden when the request includes file edits, commits that still need to be created, force push, ref deletion, history rewriting, GitHub Release creation, package publication, migration, environment deployment, or production mutation. `agentflow:on` still forces a Run and `agentflow:off` still bypasses one request.

Before a fast push, the host verifies a clean worktree, exact local revision, remote URL, and fast-forward relationship. Afterwards it reads the remote refs and reports the immutable result. It does not create a model Worker, release plan, or observation timer.

## Release Contract

`release.kind` is an optional backward-compatible discriminator with values `source-control`, `package-registry`, and `production`. Omitted values retain legacy production semantics.

`monitoring.observationWindowMinutes` becomes non-negative:

- `source-control` and `package-registry` require `0` and use immediate verification signals;
- `production` requires a positive value and retains monitored rollout and rollback evidence.

This keeps existing version-1 payloads valid while making new release plans explicit. Source-control release plans still record recovery steps and exact refs, but they do not invent production health checks.

## Human Authorization

An explicit user request such as "push when complete" or "create and push v1.2.3" is valid one-time authorization for the matching safe source-control operation. It cannot authorize a different remote, force push, deletion, package publication, GitHub Release, or deployment. Generic messages such as "continue" or an approval for a different artifact never count.

If a source-control publication is already inside S14, the Supervisor may bind that explicit request to the exact QA-approved revision and release-plan hash without asking the user to repeat the same push instruction. Package and production targets continue to require the exact Release Plan and QA hash Gate.

## Execution And Evidence

Safe Git publication uses deterministic Git commands in the Supervisor process. A model Worker is unnecessary. Immediate evidence contains the pre-push remote ref, local revision, push result, final remote ref, and tag dereference when applicable.

Package and production releases continue to require a separately authorized release Worker. Production completion still requires the configured observation window, health checks, incident state, and rollback evidence.

## Testing

Required automated coverage:

- router text explicitly exempts safe source-control synchronization;
- router text keeps force push, deletion, publication, deployment, and file-changing requests routed;
- `source-control` and `package-registry` accept a zero-minute window and reject a positive window;
- `production` rejects zero and accepts a positive window;
- legacy release plans without `release.kind` remain valid as production plans;
- release and completion Skills state that deterministic source-control pushes need no model Worker or timed observation;
- English and Chinese READMEs describe the same boundary.

## Non-Goals

- Automatically force-pushing or deleting remote refs.
- Skipping QA for commits created by the current requirement.
- Treating package publication or GitHub Release creation as a simple Git push.
- Weakening production deployment Gates, rollback, health, or observation requirements.

