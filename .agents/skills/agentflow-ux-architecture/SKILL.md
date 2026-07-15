---
name: agentflow-ux-architecture
description: Derive roles, permissions, journeys, screen inventory, navigation, UI states, responsive modes, content/data dependencies, and accessibility requirements from an approved PRD during AgentFlow Stage S03. Use before visual direction or Figma concept work begins.
---

# AgentFlow UX Architecture

Describe how users move through the product without choosing colors, typography, decorative style, or a component library.

## Build The Architecture

1. Confirm S03 is active, the requirements Gate is approved, and the registered PRD hash still matches.
2. Identify roles and permissions from PRD actors. Do not invent privileged roles without a requirement.
3. Create a screen inventory with purpose, route when applicable, supported roles, and required states.
4. Cover loading, empty, ready, error, offline, permission-denied, and partial states when they can occur. Omit impossible states rather than adding boilerplate.
5. Define primary and recovery journeys. Every step references an existing screen and names the action, outcome, and exceptions.
6. Define navigation relationships and responsive modes with numeric boundaries and behavioral changes.
7. Record content, data, and accessibility dependencies.
8. Use Figma `generate_diagram` only as a supplemental journey diagram when available. The JSON contract remains authoritative; do not fabricate a diagram URL.

## Validate And Register

Write human-readable journey/screen documentation plus `ux-architecture.json`. Follow [references/ux-architecture-contract.md](references/ux-architecture-contract.md).

Call `artifact_validate` with kind `ux-architecture`, write the normalized payload, then call `artifact_register` with the returned hash and S03. Complete S03 only after all referenced role and screen IDs validate.

## Stop Boundary

Do not decide visual direction or write to a Figma design file. S04 owns A/B/C concepts and its single Writer.
