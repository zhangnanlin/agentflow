---
name: agentflow-prd-authoring
description: Convert an approved AgentFlow product brief into a traceable, testable PRD during Stage S02. Use when product discovery is complete and the project needs goals, non-goals, user stories, prioritized functional requirements, measurable non-functional requirements, dependencies, risks, and acceptance criteria before UX or engineering begins.
---

# AgentFlow PRD Authoring

Derive requirements from the approved Product Brief. Do not publish an issue, choose a UI direction, select a framework, or start implementation.

## Author

1. Confirm S02 is active and read the exact `product-brief` Artifact plus SHA-256.
2. Preserve approved scope and decisions. Put unresolved items in `openQuestions`; never promote an assumption into a requirement.
3. Define goals and explicit non-goals.
4. Write user stories with an actor, capability, benefit, and observable acceptance criteria.
5. Give every functional requirement a stable ID, `must|should|could` priority, and acceptance criteria.
6. Express non-functional requirements as a target plus measurement method. Include accessibility, security, privacy, reliability, and performance only where relevant; avoid empty boilerplate.
7. Record dependencies, risks, constraints, and remaining questions.

## Validate And Register

Write `prd.md` and `prd.json` with equivalent information. Follow [references/prd-contract.md](references/prd-contract.md).

1. Call `artifact_validate` with kind `prd` and the JSON payload.
2. Write the normalized payload returned by validation and use its returned SHA-256.
3. Call `artifact_register` with the same payload, hash, S02, and kind `prd`.
4. Present scope, highest-risk assumptions, and open questions to the user.
5. After inspecting the brief and repository evidence, apply the safe recommended default without asking for any non-mandatory clarification and record its source plus rationale. Use `structured_choice_request` only for a genuinely blocking material choice without a safe default. Batch at most three independent questions, keep dependent questions sequential, and use one concise text fallback only when structured input is unavailable. Never repeat an accepted answer.
6. Request `requirements-approved` with `gate_decision_request` and resolve it only from an explicit user decision bound to the current PRD Artifact hash. Recommendation, silence, timeout, cancellation, or unrelated approval never counts.

## Stop Boundary

After S02 approval, stop. Do not generate journeys, screens, Figma nodes, architecture, or implementation Tasks. The Orchestrator activates S03.
