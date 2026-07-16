# AgentFlow 0.4.0 Complete Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one QA-ready commit and deterministic tarball for the complete public AgentFlow 0.4.0 release without performing external release mutations before the final Release Gate.

**Architecture:** The root manifest is the only public npm package; standalone bundles keep it independent of private workspace packages. Repository preparation and verification happen as reviewed source work, while Git refs, the Draft-to-public GitHub Release sequence, and npm publication remain separate operations authorized only by the later Release Plan Gate.

**Tech Stack:** Node.js 20+, npm, TypeScript, Vitest, esbuild, Markdown, Git, GitHub REST.

## Global Constraints

- Root version and public registry identity are exactly `agentflow@0.4.0`; the annotated Git tag is exactly `v0.4.0`.
- Publish only the portable root package. Every `@agentflow/*` workspace remains private and absent from the tarball.
- Package metadata is `UNLICENSED`; do not add or imply a license grant.
- Do not print, persist, pack, or register npm tokens, GitHub bearer tokens, browser codes, `.npmrc` contents, or credential-manager secrets.
- S11 source work may not push, tag, create a GitHub Release, publish npm, unpublish, deploy, force, delete refs, or rewrite history.
- The later external sequence is normal main push, annotated tag and ref readback, Draft GitHub Release, exact tarball npm publication, registry and clean-install verification, then public GitHub Release.
- There is no production deployment target for this CLI/MCP distribution.

---

### Task 1: Prepare And Verify The Public Distribution

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/cli/test/distribution.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/HOST_SETUP.md`
- Commit: `docs/superpowers/plans/2026-07-16-complete-public-release.md`

**Interfaces:**
- Consumes: Architecture `975fe5a9cfe3d370b8e1413a8b20d00e8a901ffa856f5e77b882b5d68747a5a9`, PRD `7d84be3c9b6b189cf6817861b7657724e1684500c903f6108398774daafb5b12`, clean `main` baseline `e2939a18deb9e2cf185ebc32ee1f98182749466b`.
- Produces: one immutable candidate commit plus `npm pack` filename, version, file list, shasum, and integrity for integration, QA, and final Release Plan binding.

- [ ] **Step 1: Add failing public-manifest and documentation assertions**

Extend `packages/cli/test/distribution.test.ts` to parse the root manifest and root lock entry and require this exact public metadata:

```ts
expect(packageJson).toMatchObject({
  name: "agentflow",
  version: "0.4.0",
  license: "UNLICENSED",
  publishConfig: { access: "public" },
  repository: {
    type: "git",
    url: "git+https://github.com/zhangnanlin/agentflow.git"
  },
  bugs: { url: "https://github.com/zhangnanlin/agentflow/issues" },
  homepage: "https://github.com/zhangnanlin/agentflow#readme"
});
expect(packageJson.private).toBeUndefined();
expect(lockJson.packages[""]).toMatchObject({
  name: "agentflow",
  version: "0.4.0",
  license: "UNLICENSED"
});
```

Require all three installation documents to contain the primary command `npx --yes agentflow@0.4.0 setup --host codex` and immutable alternative `npx --yes github:zhangnanlin/agentflow#v0.4.0 setup --host codex`. Keep existing global setup, project routing, restart, Figma OAuth, structured-choice, and Gate assertions.

For the dry-run file manifest, reject any path beginning with `packages/`, `.agentflow/`, `.codex/`, `.cursor/`, or `.vscode/`, any `.npmrc`, and unrelated development files. For the installed packed tree, scan text content for credential value patterns such as npm `_authToken=` entries, GitHub classic tokens, and fine-grained GitHub token prefixes without treating ordinary documentation words as secrets.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
npm.cmd test -- packages/cli/test/distribution.test.ts
```

Expected: FAIL because the root manifest is still private, public repository/license metadata is absent, and the documents still make the moving GitHub branch command primary.

- [ ] **Step 3: Implement the minimal public manifest and lock change**

Remove `private` only from the root `package.json`; do not edit workspace manifests. Add exactly:

```json
{
  "license": "UNLICENSED",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/zhangnanlin/agentflow.git"
  },
  "bugs": { "url": "https://github.com/zhangnanlin/agentflow/issues" },
  "homepage": "https://github.com/zhangnanlin/agentflow#readme"
}
```

Synchronize the lock without running publication or changing dependencies:

```powershell
npm.cmd install --package-lock-only --ignore-scripts
```

Review `package-lock.json` and keep only root metadata changes. Confirm `packages/cli`, `packages/core`, `packages/host-adapter`, and `packages/mcp-server` still declare `private: true`.

- [ ] **Step 4: Update immutable bilingual installation guidance**

In `README.md`, `README.zh-CN.md`, and `docs/HOST_SETUP.md`, make this the primary install/update command:

```bash
npx --yes agentflow@0.4.0 setup --host codex
```

Show this separately as the immutable Git tag alternative:

```bash
npx --yes github:zhangnanlin/agentflow#v0.4.0 setup --host codex
```

Use `cursor`, `vscode`, or `all` consistently, preserve project-scope compatibility and environment-variable examples, and retain the rule that Figma OAuth is host-managed and requested only when a UI Stage needs it.

- [ ] **Step 5: Run the focused test and confirm GREEN**

```powershell
npm.cmd test -- packages/cli/test/distribution.test.ts
```

Expected: PASS, including public metadata, lock, docs, package allowlist, packed CLI/MCP smoke, and credential-pattern checks.

- [ ] **Step 6: Run complete repository and package verification**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:distribution
npm.cmd pack --dry-run --json
npm.cmd audit --omit=dev --audit-level=high
```

Expected: all tests pass; typecheck and both builds exit zero; pack reports `agentflow@0.4.0` with only approved root distribution files; the production dependency audit reports no high-or-higher vulnerability.

- [ ] **Step 7: Validate every packaged Skill and source diff**

```powershell
$env:PYTHONUTF8='1'
Get-ChildItem .agents/skills -Directory | Sort-Object Name | ForEach-Object {
  python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
git diff --check e2939a18deb9e2cf185ebc32ee1f98182749466b..HEAD
```

Expected: every AgentFlow Skill reports `Skill is valid!` and Git reports no whitespace error.

- [ ] **Step 8: Commit the bounded release preparation**

```powershell
git add -- package.json package-lock.json packages/cli/test/distribution.test.ts README.md README.zh-CN.md docs/HOST_SETUP.md docs/superpowers/plans/2026-07-16-complete-public-release.md
git commit -m "release: prepare public AgentFlow 0.4.0 package"
git status --short
```

Expected: one new commit on `main` and an empty status. Do not push or create `v0.4.0`; S12 and S13 must first bind integration and QA evidence to this exact commit, and S14 must present the current Release Plan for a separate explicit decision.

## Requirement Coverage

The one Task owns `fr-1` through `fr-8` and `nfr-1` through `nfr-5`. S11 produces the public manifest, portable bytes, docs, tests, and exact candidate identity. S12-S13 independently verify that identity. S14 owns the current release plan and final human authorization. S15 may report success only after reading back Git, GitHub, and npm evidence.
