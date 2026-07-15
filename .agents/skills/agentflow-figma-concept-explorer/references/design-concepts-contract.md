# Design Concepts Contract

The executable source of truth is `DesignConceptSetContractSchema` in `@agentflow/core`.

Required fields:

- `version: 1`
- `sourceUxArchitecture: { artifactId, sha256 }`
- `figmaFile: { fileKey, url }`
- `representativeScreenId`
- exactly three `concepts`, containing labels A, B, and C once each
- at least two `comparisonCriteria`
- `writer: { workerId, resourceId, operationIds }`

Each concept contains:

```json
{
  "id": "concept-a",
  "label": "A",
  "title": "Direction title",
  "briefArtifactId": "concept-a-brief",
  "visualLanguage": "visual principles",
  "layoutPrinciples": ["principle"],
  "interactionPrinciples": ["principle"],
  "differentiators": ["meaningful difference"],
  "risks": [],
  "figmaPageNodeId": "real returned node ID",
  "representativeNodeIds": ["real returned node ID"],
  "screenshot": { "artifactId": "concept-a-shot", "sha256": "64 lowercase hex characters" }
}
```

Do not store the selected direction in this Artifact. The immutable candidate set is approved through the Gate's structured `selectedOption`, so changing the candidate Artifact correctly makes approval stale.
