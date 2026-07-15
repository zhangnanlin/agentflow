# UX Architecture Contract

The executable source of truth is `UxArchitectureContractSchema` in `@agentflow/core`.

Required top-level fields:

- `version: 1`
- `sourcePrd: { artifactId, sha256 }`
- `roles[]: { id, name, permissions[] }`
- `screens[]: { id, name, purpose, route?, supportedRoles[], states[] }`
- `journeys[]: { id, roleId, goal, steps[] }`
- `navigation[]: { fromScreenId, toScreenId, trigger }`
- `responsiveModes[]: { id, minWidth, maxWidth?, behavior }`
- `contentDependencies[]`
- `dataDependencies[]`
- `accessibilityRequirements[]`

Each journey step contains `id`, `screenId`, `action`, `outcome`, and optional `exceptions`. Contract validation rejects unknown role and screen references.

Allowed screen states are `loading`, `empty`, `ready`, `error`, `offline`, `permission-denied`, and `partial`.

Responsive modes describe behavioral changes, not device brand names. Avoid overlapping numeric ranges and explain changes to navigation, columns, density, and priority.
