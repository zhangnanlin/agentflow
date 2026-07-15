# Product Brief Contract

The executable source of truth is `ProductBriefContractSchema` in `@agentflow/core`. Use the same information in Markdown and JSON. The JSON object must contain:

```json
{
  "version": 1,
  "title": "working product or change name",
  "summary": "one-paragraph approved intent",
  "projectType": "new|existing",
  "users": [
    { "name": "primary user group", "needs": ["observable need"], "context": "usage context" }
  ],
  "problem": {
    "statement": "current problem without prescribing a solution",
    "evidence": ["known evidence or explicitly labeled hypothesis"],
    "impact": "why solving it matters"
  },
  "outcomes": ["user or business outcome"],
  "inScope": ["capability or behavior"],
  "outOfScope": ["explicit non-goal"],
  "constraints": ["technical, legal, time, platform, or policy constraint"],
  "successMetrics": [
    { "name": "metric", "target": "measurable target", "measurement": "how it will be measured" }
  ],
  "approaches": [
    { "id": "A", "summary": "approach", "benefits": ["benefit"], "costs": ["cost or risk"] }
  ],
  "recommendedApproachId": "A",
  "dependencies": ["external dependency"],
  "risks": ["known product risk"],
  "openQuestions": ["unresolved question"],
  "approvedDecisions": ["decision explicitly confirmed by the user"]
}
```

Quality checks:

- Scope items describe observable behavior, not implementation tasks.
- Every success metric has a target and measurement method.
- Non-goals prevent likely scope drift.
- Evidence and hypotheses are distinguishable.
- The recommendation explains meaningful tradeoffs.
- No open question is silently answered in `approvedDecisions`.
