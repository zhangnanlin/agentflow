# Architecture Contract

The strict `architecture` JSON payload contains:

- `version`: literal `1`.
- `title`, `summary`, and non-empty `principles[]`.
- `sourcePrd`: upstream Artifact ID and SHA-256.
- `sourceDesignManifest`: optional Artifact ID and SHA-256; include it for UI runs.
- `components[]`: ID, name, kind, responsibilities, and owned requirement IDs.
- `interfaces[]`: ID, source and target component IDs, protocol, contract, and security behavior.
- `dataStores[]`: ID, name, owner component, data classification, and retention.
- `decisions[]`: ID, title, decision, rationale, consequences, status, and optional replacement decision ID.
- `requirementCoverage[]`: requirement ID, component IDs, and verification approach.
- `risks[]`: ID, likelihood, impact, mitigation, and optional owner component.

Component, interface, data-store, decision, coverage, and risk IDs must be unique. Interfaces, stores, risks, and coverage may reference only declared components. Component requirement IDs and `requirementCoverage` must agree in both directions. A superseded decision must identify a declared replacement; an accepted decision cannot do so.

Keep system context, detailed API/data/security/operations analysis, considered ADR options, assumptions, and open questions in the companion human-readable architecture document. Do not add undeclared keys to the strict JSON payload.
