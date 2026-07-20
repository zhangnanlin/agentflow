# AgentFlow Adaptive Workflow Operations

This guide describes the verified adaptive routing, interaction, collaboration, rate-control, deterministic-operation, Skill-policy, rollout, and rollback behavior shipped with AgentFlow 0.5.0.

## Lane Selection

`run_start_or_resume` normalizes the original requirement, classifies deterministic request text and supplied project facts (`projectType` and `hasUi`), and persists a policy version, lane, matched signals, explanation, eligible Stages, policy skips, and escalation history.

| Lane | Selection | Eligible Stage IDs |
| --- | --- | --- |
| `quick` | Existing non-UI project with no higher-risk signal | `S00`, `S11`, `S13`, `S15` |
| `standard` | New non-UI project or bounded multi-module scope | `S00`, `S01`, `S02`, `S09`, `S10`, `S11`, `S12`, `S13`, `S15` |
| `full` | UI, migration, destructive Git, security-sensitive work, release, publication, deployment, cross-module contract, unsupported pipeline, or explicit Full override | All configured Stages |

The classifier recognizes the explicit one-request token `agentflow:full`. The router passes the original requirement unchanged, so Core records `full-override`. This override preserves every mandatory Gate.

Existing state without workflow facts migrates additively to `legacy-0.4.0` Full. Existing Artifacts, Gate bindings, events, ownership, and idempotency records remain intact.

## Monotonic Escalation

The Supervisor reads the persisted lane before dispatch. If later repository or Task evidence discovers `standard-scope`, UI, migration, destructive Git, security, release, publication, deployment, or a cross-module contract, it calls `workflow_escalate` with the new deterministic signals and the current revision.

Core can move `quick` to `standard` or `full`, and `standard` to `full`. It never downgrades. The transition records the source lane, destination lane, new signals, timestamp, explanation, and newly eligible Stages. Terminal Runs reject escalation.

## Recommended Defaults And Gates

AgentFlow resolves an unselected non-mandatory choice to its recorded recommendation. It does not ask again after that default or an explicit choice is accepted.

Mandatory human Gates are different. Requirements, design direction, design freeze, engineering plan, and release approval remain pending until the user explicitly decides against the current Artifact hash. Recommendation, silence, timeout, cancellation, disconnect, an unrelated approval, or a stale revision cannot resolve a Gate.

## Supervisor And Native Workers

The Supervisor is the only AgentFlow control-plane participant. In an independent wave it claims one eligible Task itself, dispatches only the other disjoint Tasks, and continues its own work while Workers run.

A delegated Worker must satisfy NativeWorkerProtocol v2:

- Codex, Cursor, or VS Code native task; no AgentFlow-owned Agent CLI process
- zero inherited conversation turns, attested by the native handle
- one bounded, content-addressed Task envelope instead of Supervisor history or full Run state
- enforced repository-tool allowlist with AgentFlow MCP and nested-agent tools disabled
- exact Worker, Task, native ID, task name, prompt hash, adapter version, and prompt-byte binding
- one event-driven `waitAny` or completion notification instead of repeated model polling
- compact structured result capsule; transcripts are rejected and credential patterns are redacted before persistence

If the live adapter cannot prove these facts, AgentFlow does not spawn. The Supervisor executes inline or serially.

## Durable Cleanup

The lifecycle order is fixed:

1. Persist a valid terminal result with `worker_collect`, or persist a confirmed failure or interruption.
2. Close native execution when supported.
3. Archive the child task when supported.
4. Release the exact Worker permit.
5. Persist the complete adapter receipt with `worker_cleanup_record`.

The cleanup receipt must match the bound Worker, native task, host, and adapter version. `unsupported`, `failed`, and `pending` remain truthful states. Resume retries supported incomplete cleanup without redispatching collected work. A completed Codex child task is no longer visible after a confirmed supported archive; AgentFlow audit state remains in the Run.

## Host Budget And 429 Circuits

Model dispatch uses a process-safe scheduler under the AgentFlow home directory. A sanitized hash of host and optional profile identifies the shared budget. Default capacity is one active model Worker.

Permits have bounded leases and host-side heartbeats. The first classified 429 opens a persisted cooldown and creates no duplicate Worker. `Retry-After` is honored within configured bounds; otherwise AgentFlow uses bounded exponential backoff with jitter. A half-open circuit allows one recovery probe. Doctor reports capacity, active and expired permits, cooldown state, and remaining cooldown without returning provider secrets.

## Deterministic Operations

`deterministic_operation_run` handles typed, allowlisted work without a model Worker:

- clean fast-forward Git branch synchronization with remote readback
- allowlisted verification commands
- repository or remote-ref readback
- bounded timers
- explicit authentication, user-input, or approval waits

Receipts always report `modelWorkersDispatched: 0` and separate orchestration, command, transport, authentication, readback, and total timings. Force push, ref deletion, history rewrite, file changes, release creation, package publication, deployment, and migration are denied. A request that needs file edits or a new commit stays in the AgentFlow Run.

## Bounded MCP Responses

`status_get` defaults to a bounded `summary`; mutations default to a bounded `receipt`. Named `section` pages and revision- or cursor-based `events` avoid repeatedly serializing the full Run. `responseProfile: full` remains available for explicit compatibility.

The acceptance fixtures enforce an 8192-byte summary budget and a 4096-byte mutation-receipt budget. Worker envelopes and compact Worker result capsules are each capped at 16 KB.

## Reviewed Skills

`skills-lock.json` uses manual-review-only policy. An enabled non-bundled orchestration Skill must have an immutable full commit SHA, license, review date, approval and audit evidence, content SHA-256, reviewed scripts, bounded tool scope, adapter compatibility, and restrictions that preserve Core safety and human Gates.

`skills.sh` is read-only discovery input. Candidate metadata may be compared for immutable provenance, license, and audit evidence, but discovery never installs, enables, or executes a Skill. A human-reviewed lock update is required.

## Diagnostics

Run Doctor against the intended project:

```bash
node ~/.agentflow/bin/agentflow-cli.mjs \
  --project-root /absolute/project/path doctor --host codex
```

Add `--adapter-snapshot /absolute/path/native-capability.json` only when the live host bridge produced a bounded NativeCapabilitySnapshot v2 file. Static profiles are setup evidence, not live conformance.

Doctor reports MCP process pressure, largest Runs, response-budget violations, scheduler permits and cooldown, native adapter conformance, cleanup backlog, and Skill policy. It excludes raw process command lines, environment values, credentials, OTPs, and adapter reason text.

## Rollout

1. Preview setup with `npx --yes agentflow@0.5.0 setup --host codex --dry-run`.
2. Run normal setup, restart the host, and retain the Supervisor AgentFlow MCP configuration.
3. Run Doctor and confirm project resolution, response budgets, scheduler capacity, and static Worker profiles.
4. Enable native delegation only when the live adapter reports fresh-context and tool-policy conformance. Otherwise keep inline or serial fallback.
5. Observe persisted lane explanations, 429 cooldowns, and cleanup receipts before increasing any configured Worker capacity above the default one.

## Rollback

- Add `agentflow:full` to a new request to retain the complete pipeline. Existing migrated Runs already remain legacy Full.
- Request `responseProfile: full` only for clients that still need the complete RunState.
- Disable native delegation at the adapter boundary while retaining the Supervisor MCP; non-conforming adapters fall back inline or serially, never to a custom model process.
- Keep scheduler capacity at one. Do not delete scheduler or Run audit state to simulate rollback.
- Preserve `.agentflow/config.yaml`, `.agentflow/pipeline.yaml`, `.agentflow/current-run.json`, and `.agentflow/runs/`. Migrations are additive and are not destructively reversed.
- For installation rollback and 0.2 compatibility, follow [Host Setup](./HOST_SETUP.md#project-scope-compatibility) and remove only AgentFlow-owned entries after stopping their MCP processes.
