---
name: agentflow-visual-qa
description: Run evidence-based system QA during AgentFlow Stage S13 across functional, end-to-end, visual, accessibility, performance, reliability, and security checks. Use after the integrated revision is fixed and testable. For UI projects compare real rendered states with the frozen design; for non-UI projects omit visual checks explicitly. Do not change release state or deploy.
---

# AgentFlow System QA

Test the exact integrated revision from S12. Keep QA Workers read-only except for generated reports, screenshots, and ephemeral test output.

## Plan Coverage

1. Confirm S13 is active and the Integration Report hash is current.
2. Derive coverage from PRD acceptance criteria, architecture quality attributes, design inventory, security risks, and integration residual risks.
3. Separate automated evidence from manual observations. Never mark a skipped or unavailable check as passed.
4. For UI projects, include representative desktop/mobile viewports, loading/empty/error/permission states, keyboard flow, focus visibility, reflow, contrast, target sizes, reduced motion, and visual comparison against frozen Figma nodes.
5. For services and CLIs, cover API/command behavior, invalid input, auth boundaries, concurrency/idempotency, migrations, failure recovery, logs, and resource limits as applicable.

## Execute Safely

1. Use proven project test and browser tooling; do not hand-roll domain engines or browser automation.
2. Do not send production data, credentials, or destructive requests. Dynamic security checks require an authorized disposable target.
3. Record command/tool, environment, revision, result, timestamp, and concise evidence for every check.
4. Record defects with severity, requirement/state, reproduction, evidence Artifact IDs, and owner. Return blocking defects to the owning Stage; do not hide them in residual risk.

## Report

Write and register `qa-report.json` following [references/qa-report-contract.md](references/qa-report-contract.md). S13 completes only when required coverage is accounted for, blocking accessibility/security/functional defects are zero, and every skipped check has an accepted reason.
