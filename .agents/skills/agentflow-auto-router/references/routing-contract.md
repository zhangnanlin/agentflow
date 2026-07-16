# AgentFlow Automatic Routing Contract

Apply the first matching row to the current user request. Override tokens are scoped to one request.

| Priority | Request signal | Decision | Required action |
| --- | --- | --- | --- |
| 1 | `agentflow:on` | Route | Resolve the project, then call `run_start_or_resume`. |
| 1 | `agentflow:off` | Bypass | Handle normally and do not mutate AgentFlow state. |
| 2 | Safe source-control sync of existing commits or tags, without file changes | Bypass | Verify the local and remote refs, push without force, then verify the immutable remote refs. |
| 2 | Any requested project mutation | Route | Call `run_start_or_resume` before edits, then use `agentflow-orchestrator`. |
| 3 | Pure question | Bypass | Answer without creating a Run. |
| 3 | Code explanation | Bypass | Explain without changing files. |
| 3 | Read-only inspection | Bypass | Inspect and report without changing files. |
| 3 | Status lookup | Bypass | Report status without starting or advancing a Run. |
| 3 | Simple non-mutating command | Bypass | Run the command without creating a Run. |

Project mutations include creating or modifying code, tests, documentation, configuration, migrations, designs, build outputs intended for the project, package publication, release creation, or deployment state. Force push, ref deletion, and history rewriting always route. A mixed request that asks for file changes and a later push also routes; only synchronization of commits or tags that already exist locally qualifies for the fast path.

The source-control fast path permits a normal branch push, an existing tag push, or creation of one annotated tag at an already verified revision followed by its push. It does not create AgentFlow state, a model Worker, a release plan, or a timed observation. Before the push, require a clean worktree, exact local revision, expected remote, and a fast-forward relationship. Afterwards, read the branch and dereferenced tag refs from the remote.

For a mixed request such as "inspect this failure and fix it", route before the inspection because the requested outcome includes a mutation. For a request such as "inspect this failure and tell me what is wrong", bypass because the requested outcome is read-only.

If both override tokens appear and the user's intent is not otherwise explicit, do not guess which override wins. Ask the user to provide one override token.

Routing is durable model instruction, not transport interception. Higher-priority host or user policy still applies. Once routed, AgentFlow Core and MCP enforce Worker, Artifact, Stage, and human Gate invariants.

Each AgentFlow tool call resolves its own immutable project context. A fixed compatibility root wins first; otherwise use an explicit absolute `projectRoot`, one advertised client root, the Git top level, then the MCP working directory. When the host exposes multiple workspace roots, the caller must supply the intended absolute `projectRoot`; ambiguity fails closed and is never converted into a queue.

Only a routed project-changing request calls `run_start_or_resume`. The call is locked and idempotent inside that project, initializes only lightweight `.agentflow` state when needed, and returns the Run that all subsequent calls must use. Bypassed questions and reads do not initialize state. Independent projects do not share a lifecycle lock and may run concurrently.
