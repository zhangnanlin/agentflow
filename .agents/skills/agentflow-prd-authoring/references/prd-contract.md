# PRD Contract

The executable source of truth is `PrdContractSchema` in `@agentflow/core`. Produce this shape:

```json
{
  "version": 1,
  "title": "Product or change name",
  "summary": "Approved requirement summary",
  "sourceProductBrief": { "artifactId": "brief-id", "sha256": "64 lowercase hex characters" },
  "goals": ["measurable desired outcome"],
  "nonGoals": ["explicit exclusion"],
  "userStories": [
    {
      "id": "story-1",
      "actor": "user role",
      "capability": "observable capability",
      "benefit": "user value",
      "acceptanceCriteria": ["verifiable outcome"]
    }
  ],
  "functionalRequirements": [
    {
      "id": "fr-1",
      "description": "required behavior",
      "priority": "must|should|could",
      "acceptanceCriteria": ["verifiable result"]
    }
  ],
  "nonFunctionalRequirements": [
    {
      "id": "nfr-1",
      "category": "performance|security|accessibility|reliability|privacy|operability|other",
      "target": "quantified target",
      "measurement": "test or observation method"
    }
  ],
  "constraints": [],
  "dependencies": [],
  "risks": [],
  "openQuestions": []
}
```

Every must-level requirement needs at least one acceptance criterion. IDs remain stable through later revisions so UX, architecture, implementation Tasks, and tests can trace back to them.
