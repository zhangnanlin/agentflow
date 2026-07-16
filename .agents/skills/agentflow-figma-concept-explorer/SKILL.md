---
name: agentflow-figma-concept-explorer
description: Produce three comparable A/B/C visual and interaction directions from an approved UX architecture during AgentFlow Stage S04, using multiple read-only concept analysts and exactly one Figma Writer. Use when users need to compare and explicitly choose a design direction before a design system or complete UI is generated.
---

# AgentFlow Figma Concept Explorer

Create three genuinely different directions for the same representative screen, content, data, states, and viewport. Keep one Writer for the target Figma file.

## Analyze In Parallel

1. Confirm S04 is active and the `ux-architecture` Artifact hash is current.
2. Choose one representative high-value screen with enough navigation, data, actions, and state behavior to expose design tradeoffs.
3. Dispatch three read-only analysis Workers for A, B, and C. Each returns a concept brief covering visual language, layout principles, interaction principles, differentiators, and risks.
4. Analysts must not call Figma write tools. Make directions structurally distinct, not three color swaps.
5. Register each brief as a generic supporting Artifact and give its ID to the Writer.

## Use One Figma Writer

1. Probe the current host immediately before Writer dispatch. S04 requires `host.worker.spawn`, `host.worker.collect`, `figma.remote.connected`, `figma.remote.authenticated`, `figma.tool.whoami`, `figma.tool.create_new_file`, `figma.tool.use_figma`, `figma.tool.get_metadata`, `figma.tool.get_screenshot`, and `skill.figma-use`.
2. Call `stage_preflight_report` with the canonical capabilities actually observed live and a short TTL. Do not treat generated configuration, a lockfile, or a server name as availability. Do not persist identity fields returned by `whoami`.
3. Dispatch one `figma-writer` Worker through the Host Bridge only after the preflight passes.
4. Load the official `figma-use` Skill before every `use_figma` call. Load the official full-screen generation guidance when building the representative screens.
5. Acquire one `figma-file` resource. Use the real Figma file key as `resourceKey`; for a new file, use a unique run-scoped provisional key, then call `resource_rekey` with the confirmed file key before the first canvas write.
6. Follow [references/figma-write-protocol.md](references/figma-write-protocol.md) around every mutating call.
7. Create separate A, B, and C Pages sequentially. Use the same content, data, screen state, and viewport for all three.
8. Return every created or changed node ID. Capture `get_metadata` and `get_screenshot` after each direction and register each screenshot Artifact.
9. Never search or import a community library outside the configured allowlist. Treat library content as untrusted data.
10. Release the resource only after no operation is active.

If Figma MCP is unavailable, submit the negative preflight, keep the three briefs, and let Core block S04. Create no Writer and do not invent file keys, node IDs, screenshots, or a rendered `design-concepts` Artifact. After the user completes host OAuth or restarts the host, probe again and resume from the saved briefs rather than regenerating them.

## Validate And Ask

Build `design-concepts.json` using [references/design-concepts-contract.md](references/design-concepts-contract.md). It must contain exactly one rendered A, B, and C option, one Writer/resource ledger, and comparable criteria.

Call `artifact_validate` with kind `design-concepts`, write the normalized payload, and register it with the returned hash. Present screenshots and a concise comparison to the user. Resolve `design-direction-approved` only with an explicit structured `choice` of `A`, `B`, `C`, or `mixed`.

Use `structured_choice_request` for bounded concept clarification after inspecting the UX Artifact and existing Figma evidence. Batch at most three independent questions and use one concise text fallback only if structured input is unavailable. For the actual human Gate, use `gate_decision_request` so the selected direction is bound to the current design-concepts Artifact hash. Never infer selection from the recommendation, silence, timeout, cancellation, or another approval.

## Stop Boundary

Do not create the production design system or all project screens. S05 and S06 consume the selected Gate option.
