# AgentFlow One-Command Setup And Automatic Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a GitHub-backed `npx` installer that safely configures AgentFlow and automatically routes project-changing requests through the staged workflow in Codex, Cursor, and VS Code.

**Architecture:** Build standalone CLI and MCP ESM bundles, then have `agentflow setup` copy the durable runtime and AgentFlow Skills into the target project. Pure merge/planning modules compute idempotent instruction and MCP configuration updates before a transactional filesystem executor writes anything; host-specific always-on instructions call a shared `agentflow-auto-router` Skill.

**Tech Stack:** TypeScript 7, Node.js 20+, Commander, smol-toml, YAML, Zod, esbuild, Vitest, Git CLI.

## Global Constraints

- The friend-facing command is `npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex|cursor|vscode|all`.
- Project-changing requests enter or resume AgentFlow; pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands do not.
- `agentflow:on` forces routing and `agentflow:off` bypasses it for one request.
- Human Requirements, Design Direction, Design Freeze, and Release Gates remain mandatory.
- Setup never overwrites an unrelated Skill, MCP server, instruction, token, header, OAuth credential, or secret.
- Figma OAuth, Workspace Trust, editor installation, and editor restart remain human actions.
- Generated runtime files live under `.agentflow/runtime/`; generated machine MCP files are ignored by Git.
- Node.js 20 or newer and Git are prerequisites.
- Setup is idempotent, validates the complete write plan first, and rolls back its own writes on failure.
- Runtime distribution cannot depend on unpublished `@agentflow/*` workspace packages.
- Implementation follows red-green-refactor and commits each independently reviewable task.

---

## File Map

- `packages/cli/src/managed-content.ts`: render and merge AgentFlow-owned instruction/TOML marker blocks.
- `packages/cli/src/auto-router.ts`: canonical routing copy and host-specific instruction renderers.
- `packages/cli/src/host-config-merge.ts`: structural JSON/TOML MCP configuration merge with conflict detection.
- `packages/cli/src/setup.ts`: setup planning, safe Skill/runtime copy, atomic execution, rollback, and result contract.
- `packages/cli/src/distribution.ts`: locate packaged assets and describe the durable runtime files.
- `packages/cli/src/index.ts`: expose `setup` and its options.
- `packages/cli/test/managed-content.test.ts`: managed-block behavior.
- `packages/cli/test/auto-router.test.ts`: routing contract and host renderers.
- `packages/cli/test/host-config-merge.test.ts`: three-host merge behavior.
- `packages/cli/test/setup.test.ts`: setup planning, idempotency, dry-run, collision, traversal, and rollback.
- `packages/cli/test/distribution.test.ts`: packed/bundled execution outside the monorepo.
- `.agents/skills/agentflow-auto-router/**`: shared routing Skill and metadata.
- `scripts/build-distribution.mjs`: create standalone CLI/MCP bundles.
- `package.json`, `package-lock.json`, `.npmignore`, `.gitignore`: package/bin/build metadata and portable exclusions.
- `AGENTS.md`, `.cursor/rules/agentflow.mdc`, `.github/copilot-instructions.md`: repository dogfood outputs.
- `README.md`, `docs/HOST_SETUP.md`: one-command onboarding and remaining human steps.
- Remove tracked `.codex/config.toml`, `.cursor/mcp.json`, `.vscode/mcp.json` snapshots.

---

### Task 1: Managed Content And Automatic Router

**Files:**
- Create: `packages/cli/src/managed-content.ts`
- Create: `packages/cli/src/auto-router.ts`
- Create: `packages/cli/test/managed-content.test.ts`
- Create: `packages/cli/test/auto-router.test.ts`
- Create: `.agents/skills/agentflow-auto-router/SKILL.md`
- Create: `.agents/skills/agentflow-auto-router/agents/openai.yaml`
- Create: `.agents/skills/agentflow-auto-router/references/routing-contract.md`

**Interfaces:**
- Produces: `mergeManagedBlock(existing, block, markers): string`, `AGENTFLOW_ROUTER_BODY`, `renderAgentsInstruction()`, `renderCursorRule()`, and `renderVsCodeInstruction()`.
- Consumes: no setup or filesystem code; every function is pure.

- [ ] **Step 1: Write failing managed-content tests**

```ts
import { describe, expect, it } from "vitest";
import { AgentFlowError } from "@agentflow/core";
import { mergeManagedBlock } from "../src/managed-content.js";

const markers = { start: "<!-- agentflow:auto-router:start -->", end: "<!-- agentflow:auto-router:end -->" };

describe("managed content", () => {
  it("appends and then replaces exactly one managed block", () => {
    const first = mergeManagedBlock("# Existing\n", "new body", markers);
    expect(first).toContain("# Existing\n");
    expect(first.match(/agentflow:auto-router:start/g)).toHaveLength(1);
    expect(mergeManagedBlock(first, "updated body", markers)).toContain("updated body");
    expect(mergeManagedBlock(first, "updated body", markers)).not.toContain("new body");
  });

  it("rejects malformed or duplicated markers", () => {
    expect(() => mergeManagedBlock(`${markers.start}\nbody`, "next", markers)).toThrowError(AgentFlowError);
    expect(() => mergeManagedBlock(`${markers.start}\na\n${markers.end}\n${markers.start}\nb\n${markers.end}`, "next", markers))
      .toThrowError(expect.objectContaining({ code: "MANAGED_BLOCK_INVALID" }));
  });
});
```

- [ ] **Step 2: Run the managed-content test and observe RED**

Run: `npm.cmd test -- packages/cli/test/managed-content.test.ts`

Expected: FAIL because `../src/managed-content.js` does not exist.

- [ ] **Step 3: Implement the minimal managed-block merge**

```ts
import { AgentFlowError } from "@agentflow/core";

export interface ManagedMarkers { start: string; end: string }

export function mergeManagedBlock(existing: string, body: string, markers: ManagedMarkers): string {
  const starts = existing.split(markers.start).length - 1;
  const ends = existing.split(markers.end).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) {
    throw new AgentFlowError("Managed AgentFlow block is malformed", "MANAGED_BLOCK_INVALID", { starts, ends });
  }
  const block = `${markers.start}\n${body.trim()}\n${markers.end}`;
  if (starts === 0) return `${existing.trimEnd()}${existing.trim().length === 0 ? "" : "\n\n"}${block}\n`;
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end, start) + markers.end.length;
  return `${existing.slice(0, start)}${block}${existing.slice(end)}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
```

- [ ] **Step 4: Run the managed-content test and observe GREEN**

Run: `npm.cmd test -- packages/cli/test/managed-content.test.ts`

Expected: 1 file and 2 tests passed.

- [ ] **Step 5: Write failing router-renderer tests**

```ts
import { describe, expect, it } from "vitest";
import { AGENTFLOW_ROUTER_BODY, renderAgentsInstruction, renderCursorRule, renderVsCodeInstruction } from "../src/auto-router.js";

describe("automatic router contract", () => {
  it("routes mutations, exempts reads, supports overrides, resumes runs, and preserves gates", () => {
    for (const phrase of ["project-changing", "pure questions", "agentflow:on", "agentflow:off", "resume", "human Gate"]) {
      expect(AGENTFLOW_ROUTER_BODY).toContain(phrase);
    }
  });

  it("renders the native always-on surface for each host", () => {
    expect(renderAgentsInstruction()).toContain("agentflow:auto-router:start");
    expect(renderCursorRule()).toMatch(/alwaysApply:\s*true/);
    expect(renderVsCodeInstruction("# Team rules\n")).toContain("# Team rules");
  });
});
```

- [ ] **Step 6: Run router tests and observe RED**

Run: `npm.cmd test -- packages/cli/test/auto-router.test.ts`

Expected: FAIL because `../src/auto-router.js` does not exist.

- [ ] **Step 7: Implement canonical routing copy and renderers**

```ts
import { mergeManagedBlock } from "./managed-content.js";

export const AGENTFLOW_ROUTER_BODY = `## AgentFlow automatic routing
- For every project-changing request, load agentflow-auto-router before editing.
- Pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands bypass AgentFlow.
- agentflow:on forces routing for one request; agentflow:off bypasses it for one request.
- Inspect .agentflow/current-run.json or AgentFlow status_get first. Resume an unfinished Run and never duplicate it.
- If no unfinished Run exists, preserve the user's original requirement and start the correct new/existing and UI/non-UI Run.
- Execute staged work through agentflow-orchestrator and its Workers. Preserve every human Gate and never infer approval.`;

const markdownMarkers = { start: "<!-- agentflow:auto-router:start -->", end: "<!-- agentflow:auto-router:end -->" };

export function renderAgentsInstruction(existing = ""): string {
  return mergeManagedBlock(existing, AGENTFLOW_ROUTER_BODY, markdownMarkers);
}
export function renderVsCodeInstruction(existing = ""): string {
  return mergeManagedBlock(existing, AGENTFLOW_ROUTER_BODY, markdownMarkers);
}
export function renderCursorRule(): string {
  return `---\ndescription: Route project changes through AgentFlow\nglobs:\nalwaysApply: true\n---\n\n${AGENTFLOW_ROUTER_BODY}\n`;
}
```

- [ ] **Step 8: Add the router Skill and validate it**

Write `SKILL.md` with frontmatter name `agentflow-auto-router`, a description covering every project-changing request, the exact exception list, override tokens, status-first resume behavior, and a prohibition on direct edits before routing. Add matching `agents/openai.yaml` metadata and `references/routing-contract.md` containing the canonical decision table.

Run: `$env:PYTHONUTF8='1'; python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents/skills/agentflow-auto-router`

Expected: `Skill is valid!`

- [ ] **Step 9: Run focused tests and commit**

Run: `npm.cmd test -- packages/cli/test/managed-content.test.ts packages/cli/test/auto-router.test.ts`

Expected: 2 files and all tests passed.

```bash
git add packages/cli/src/managed-content.ts packages/cli/src/auto-router.ts packages/cli/test/managed-content.test.ts packages/cli/test/auto-router.test.ts .agents/skills/agentflow-auto-router
git commit -m "feat(cli): add automatic AgentFlow router"
```

---

### Task 2: Safe Cross-Host MCP Configuration Merge

**Files:**
- Create: `packages/cli/src/host-config-merge.ts`
- Create: `packages/cli/test/host-config-merge.test.ts`
- Modify: `packages/cli/src/host-config.ts`

**Interfaces:**
- Consumes: `HostClient`, `HostConfigurationSpec`, and `renderHostConfiguration` from `host-config.ts`; `mergeManagedBlock` from Task 1.
- Produces: `mergeHostConfiguration(client, existing, spec): string` and exported `hostServerTable(client)`.

- [ ] **Step 1: Write failing JSON and TOML merge tests**

```ts
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { AgentFlowError } from "@agentflow/core";
import { mergeHostConfiguration } from "../src/host-config-merge.js";
import type { HostClient, HostConfigurationSpec } from "../src/host-config.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const projectRoot = resolve(repositoryRoot, "fixtures/example-project");
function spec(client: HostClient): HostConfigurationSpec {
  return { client, projectRoot, agentflowMcpEntryPoint: resolve(repositoryRoot, "bundle/agentflow-mcp.mjs") };
}

describe("host configuration merge", () => {
  it("preserves unrelated Cursor and VS Code settings", () => {
    const cursor = JSON.parse(mergeHostConfiguration("cursor", JSON.stringify({ mcpServers: { other: { command: "other" } }, keep: true }), spec("cursor")));
    expect(cursor.keep).toBe(true);
    expect(cursor.mcpServers).toHaveProperty("other");
    expect(cursor.mcpServers).toHaveProperty("agentflow");
    expect(cursor.mcpServers).toHaveProperty("figma");
  });

  it("preserves unrelated Codex TOML and is idempotent", () => {
    const first = mergeHostConfiguration("codex", "model = \"gpt-test\"\n", spec("codex"));
    expect(first).toContain("model = \"gpt-test\"");
    expect(mergeHostConfiguration("codex", first, spec("codex"))).toBe(first);
  });

  it("rejects a conflicting managed server", () => {
    const existing = JSON.stringify({ mcpServers: { agentflow: { command: "wrong" } } });
    expect(() => mergeHostConfiguration("cursor", existing, spec("cursor")))
      .toThrowError(expect.objectContaining<Partial<AgentFlowError>>({ code: "HOST_CONFIG_CONFLICT" }));
  });
});
```

- [ ] **Step 2: Run merge tests and observe RED**

Run: `npm.cmd test -- packages/cli/test/host-config-merge.test.ts`

Expected: FAIL because `host-config-merge.ts` does not exist.

- [ ] **Step 3: Export the host table name and implement structural merge**

`host-config.ts` exports:

```ts
export function hostServerTable(client: HostClient): "mcp_servers" | "mcpServers" | "servers" {
  return SERVER_TABLES[client];
}
```

`host-config-merge.ts` parses desired JSON/TOML from `renderHostConfiguration(spec)`. For JSON hosts, shallow-copy the top-level object and server table, add missing desired servers, accept deep-equal desired servers, and throw `HOST_CONFIG_CONFLICT` for different existing `agentflow` or `figma` entries. For Codex, parse with `smol-toml`, perform the same conflict check, and append only missing TOML tables inside:

```text
# agentflow:mcp:start
...
# agentflow:mcp:end
```

Use `mergeManagedBlock` with `#` markers when an existing managed block is present. Parse the final text once more before returning it.

- [ ] **Step 4: Run focused and existing host tests**

Run: `npm.cmd test -- packages/cli/test/host-config-merge.test.ts packages/cli/test/host-config.test.ts`

Expected: 2 files and all tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/host-config-merge.ts packages/cli/src/host-config.ts packages/cli/test/host-config-merge.test.ts
git commit -m "feat(cli): merge host configuration safely"
```

---

### Task 3: Transactional Setup Planner And Executor

**Files:**
- Create: `packages/cli/src/distribution.ts`
- Create: `packages/cli/src/setup.ts`
- Create: `packages/cli/test/setup.test.ts`
- Modify: `.gitignore`
- Delete from Git: `.codex/config.toml`
- Delete from Git: `.cursor/mcp.json`
- Delete from Git: `.vscode/mcp.json`

**Interfaces:**
- Consumes: router renderers from Task 1 and `mergeHostConfiguration` from Task 2.
- Produces: `SetupOptions`, `SetupResult`, `planSetup(options)`, `executeSetup(options)`, and `resolveDistributionAssets()`.

- [ ] **Step 1: Write failing setup tests for create, dry-run, and idempotency**

```ts
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeSetup } from "../src/setup.js";
import type { DistributionAssets } from "../src/distribution.js";

async function fakeDistributionAssets(root: string): Promise<DistributionAssets> {
  const distribution = join(root, "test-distribution");
  const skillsDirectory = join(distribution, ".agents", "skills");
  await mkdir(join(skillsDirectory, "agentflow-auto-router"), { recursive: true });
  const cliBundle = join(distribution, "bundle", "agentflow-cli.mjs");
  const mcpBundle = join(distribution, "bundle", "agentflow-mcp.mjs");
  const skillsLockPath = join(distribution, "skills-lock.json");
  await mkdir(join(distribution, "bundle"), { recursive: true });
  await Promise.all([
    writeFile(cliBundle, "#!/usr/bin/env node\n"),
    writeFile(mcpBundle, "#!/usr/bin/env node\n"),
    writeFile(join(skillsDirectory, "agentflow-auto-router", "SKILL.md"), "---\nname: agentflow-auto-router\ndescription: Route changes\n---\nRoute changes.\n"),
    writeFile(skillsLockPath, JSON.stringify({ schemaVersion: 1, dependencies: [] }))
  ]);
  return { root: distribution, cliBundle, mcpBundle, skillsDirectory, skillsLockPath };
}

describe("AgentFlow setup", () => {
  it("creates runtime, Skills, host config, and automatic routing idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-setup-"));
    const assets = await fakeDistributionAssets(root);
    const first = await executeSetup({ projectRoot: root, hosts: ["codex"], assets, skipExternalSkills: true });
    expect(first.created).toContain(join(root, ".agentflow/runtime/bin/agentflow-mcp.mjs"));
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("agentflow:auto-router:start");
    expect(await readFile(join(root, ".codex/config.toml"), "utf8")).toContain("agentflow-mcp.mjs");
    const second = await executeSetup({ projectRoot: root, hosts: ["codex"], assets, skipExternalSkills: true });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  it("writes nothing during dry-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-dry-"));
    const result = await executeSetup({ projectRoot: root, hosts: ["all"], assets: await fakeDistributionAssets(root), dryRun: true, skipExternalSkills: true });
    expect(result.planned.length).toBeGreaterThan(0);
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

- [ ] **Step 2: Run setup tests and observe RED**

Run: `npm.cmd test -- packages/cli/test/setup.test.ts`

Expected: FAIL because `setup.ts` and `distribution.ts` do not exist.

- [ ] **Step 3: Implement distribution asset resolution**

```ts
export interface DistributionAssets {
  root: string;
  cliBundle: string;
  mcpBundle: string;
  skillsDirectory: string;
  skillsLockPath: string;
}

export async function resolveDistributionAssets(moduleUrl = import.meta.url): Promise<DistributionAssets> {
  const directory = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(directory, ".."), resolve(directory, "../.."), resolve(directory, "../../..")];
  for (const root of candidates) {
    const assets = { root, cliBundle: resolve(root, "bundle/agentflow-cli.mjs"), mcpBundle: resolve(root, "bundle/agentflow-mcp.mjs"), skillsDirectory: resolve(root, ".agents/skills"), skillsLockPath: resolve(root, "skills-lock.json") };
    if ((await Promise.all(Object.values(assets).slice(1).map(pathExists))).every(Boolean)) return assets;
  }
  throw new AgentFlowError("AgentFlow distribution assets are missing", "DISTRIBUTION_ASSETS_MISSING");
}
```

- [ ] **Step 4: Implement a pure setup plan**

Define:

```ts
export interface PlannedFile { path: string; content: Uint8Array; source?: string }
export interface SetupOptions { projectRoot: string; hosts: (HostClient | "all")[]; assets: DistributionAssets; dryRun?: boolean; skipExternalSkills?: boolean }
export interface SetupResult { projectRoot: string; hosts: HostClient[]; planned: string[]; created: string[]; updated: string[]; unchanged: string[]; skipped: string[]; requiredActions: string[] }
```

`planSetup` resolves the project root, rejects any destination outside it, plans runtime bundle copies, default `.agentflow` YAML, AgentFlow-owned Skill files, `AGENTS.md`, selected host instructions, and merged MCP configuration. It reads every existing destination before returning and throws on any Skill collision whose bytes differ.

- [ ] **Step 5: Write failing rollback and path-safety tests**

Add tests that inject a writer failing on the second rename and assert the original `AGENTS.md` is restored and the new runtime file is absent. Add a fake source symlink and `../escape` destination fixture and expect `SETUP_PATH_ESCAPE` before writes.

Run: `npm.cmd test -- packages/cli/test/setup.test.ts`

Expected: FAIL because transaction rollback and path validation are not implemented.

- [ ] **Step 6: Implement atomic apply and rollback**

`executeSetup` first computes and validates the entire plan. For each changed path, store the prior bytes or an absent sentinel, write a same-directory temporary file named with `.agentflow-tmp-${randomUUID()}`, and rename it atomically. On error, restore prior bytes through the same mechanism in reverse order and remove files created by this invocation. Always remove temporary files. Dry-run returns paths without calling the writer.

- [ ] **Step 7: Add pinned Superpowers staging**

When external Skills are enabled, read `skills-lock.json`, locate `obra-superpowers`, clone into `mkdtemp`, checkout exactly `d884ae04edebef577e82ff7c4e143debd0bbec99`, verify `git rev-parse HEAD`, reject symbolic links, and copy only the declared Skill directories into the same setup plan. Inject the Git runner in tests; the unit suite never uses the network.

- [ ] **Step 8: Remove machine snapshots and ignore generated files**

Add to `.gitignore`:

```gitignore
.codex/config.toml
.cursor/mcp.json
.vscode/mcp.json
bundle/
```

Remove the three tracked machine-specific files with `apply_patch`; do not delete local directories recursively.

- [ ] **Step 9: Run setup tests and commit**

Run: `npm.cmd test -- packages/cli/test/setup.test.ts packages/cli/test/host-config-merge.test.ts packages/cli/test/auto-router.test.ts`

Expected: all focused tests passed.

```bash
git add .gitignore packages/cli/src/distribution.ts packages/cli/src/setup.ts packages/cli/test/setup.test.ts
git add -u .codex/config.toml .cursor/mcp.json .vscode/mcp.json
git commit -m "feat(cli): add transactional AgentFlow setup"
```

---

### Task 4: CLI Command And Setup End-To-End Flow

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `executeSetup`, `resolveDistributionAssets`, and existing `initializeProject`, `createEngine`, and `writeCurrentRun`.
- Produces: public `agentflow setup` command and setup-aware doctor checks.

- [ ] **Step 1: Write a failing CLI setup test**

```ts
it("runs setup for one host and optionally starts the first Run", async () => {
  const projectRoot = await createTemporaryProject();
  const result = parseOutput<SetupResult>(await runCli(
    projectRoot, "setup", "--host", "codex", "--skip-external-skills", "--start", "Build a notes app"
  ));
  expect(result.hosts).toEqual(["codex"]);
  expect(result.run).toMatchObject({ requirement: "Build a notes app", activeStageId: "S00" });
  expect(JSON.parse(await readFile(join(projectRoot, ".agentflow/current-run.json"), "utf8"))).toHaveProperty("runId");
});
```

- [ ] **Step 2: Run the CLI test and observe RED**

Run: `npm.cmd test -- packages/cli/test/cli.test.ts -t "runs setup"`

Expected: FAIL because Commander has no `setup` command.

- [ ] **Step 3: Add the setup command**

Register Commander options exactly as the design. Normalize `--host all` to all three hosts. Resolve assets, call `executeSetup`, and when `--start` is present create exactly one Run after successful setup. Reject `--no-ui` without `--start`, and reject `--project-type` without `--start` to avoid unused options.

The JSON result extends `SetupResult` with optional:

```ts
run?: { id: string; requirement: string; activeStageId: string | null; revision: number }
```

- [ ] **Step 4: Add doctor checks for the router and durable runtime**

Doctor checks the selected project's durable MCP bundle, `agentflow-auto-router/SKILL.md`, `AGENTS.md`, and the selected host instruction file. Static doctor returns a targeted warning when host restart or Figma authentication is the only remaining human action.

- [ ] **Step 5: Run CLI and doctor tests**

Run: `npm.cmd test -- packages/cli/test/cli.test.ts packages/cli/test/doctor.test.ts packages/cli/test/host-config.test.ts`

Expected: all CLI/doctor tests passed.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/doctor.ts packages/cli/test/cli.test.ts packages/cli/test/doctor.test.ts
git commit -m "feat(cli): expose one-command setup"
```

---

### Task 5: Standalone GitHub `npx` Distribution

**Files:**
- Create: `scripts/build-distribution.mjs`
- Create: `.npmignore`
- Create: `packages/cli/test/distribution.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/cli/src/doctor.ts`

**Interfaces:**
- Consumes: CLI and MCP TypeScript entry points plus `resolveDistributionAssets`.
- Produces: root `agentflow` bin and standalone `bundle/agentflow-cli.mjs` / `bundle/agentflow-mcp.mjs`.

- [ ] **Step 1: Write a failing packed-distribution test**

The test runs `node scripts/build-distribution.mjs`, creates `const execFileAsync = promisify(execFile)`, then executes:

```ts
const setup = await execFileAsync(process.execPath, [resolve(root, "bundle/agentflow-cli.mjs"), "--project-root", target, "setup", "--host", "codex", "--skip-external-skills"]);
expect(JSON.parse(setup.stdout)).toMatchObject({ hosts: ["codex"] });
const doctor = await execFileAsync(process.execPath, [resolve(root, "bundle/agentflow-cli.mjs"), "--project-root", target, "doctor", "--host", "codex"]);
expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true });
```

It then runs `npm.cmd pack --dry-run --json` and asserts the file list includes both bundles, `.agents/skills/agentflow-auto-router/SKILL.md`, and `skills-lock.json`, while excluding `.codex/config.toml`, `.cursor/mcp.json`, and `.vscode/mcp.json`.

- [ ] **Step 2: Run the distribution test and observe RED**

Run: `npm.cmd test -- packages/cli/test/distribution.test.ts`

Expected: FAIL because there is no distribution builder or bundle.

- [ ] **Step 3: Add esbuild and the distribution builder**

Run: `npm.cmd install --save-dev esbuild@0.28.1`

`scripts/build-distribution.mjs` calls esbuild twice with `bundle: true`, `platform: "node"`, `format: "esm"`, `target: "node20"`, source maps, legal comments preserved, and a Node shebang banner. Entry points are `packages/cli/src/index.ts` and `packages/mcp-server/src/index.ts`; outputs are the two canonical bundle paths.

- [ ] **Step 4: Expose the root bin and package files**

Update root `package.json` with:

```json
"bin": { "agentflow": "bundle/agentflow-cli.mjs" },
"files": ["bundle", ".agents/skills", "skills-lock.json", "README.md", "docs/HOST_SETUP.md"],
"scripts": {
  "build:distribution": "node scripts/build-distribution.mjs",
  "prepare": "npm run build:distribution",
  "setup": "npm run build:distribution && node bundle/agentflow-cli.mjs setup"
}
```

Preserve all existing scripts. `.npmignore` excludes source tests, local runtime state, worktrees, machine MCP files, logs, and coverage while retaining the package `files` allowlist.

- [ ] **Step 5: Make doctor prefer the colocated MCP bundle**

`resolveAgentFlowMcpEntryPoint` first checks `resolve(dirname(fileURLToPath(import.meta.url)), "agentflow-mcp.mjs")`; it falls back to the existing workspace resolution only when that file is absent. Setup copies this exact file into the target durable runtime before rendering host configuration.

- [ ] **Step 6: Run distribution, CLI, and full tests**

Run:

```powershell
npm.cmd run build:distribution
npm.cmd test -- packages/cli/test/distribution.test.ts packages/cli/test/cli.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Expected: standalone setup/doctor passes outside the monorepo; all repository tests, typecheck, and build pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-distribution.mjs .npmignore package.json package-lock.json packages/cli/src/doctor.ts packages/cli/test/distribution.test.ts
git commit -m "build: add standalone AgentFlow distribution"
```

---

### Task 6: Dogfood Rules, Documentation, And Final Verification

**Files:**
- Create: `AGENTS.md`
- Create: `.cursor/rules/agentflow.mdc`
- Create: `.github/copilot-instructions.md`
- Modify: `README.md`
- Modify: `docs/HOST_SETUP.md`
- Modify: `AGENTFLOW_PROJECT_SPEC.md`

**Interfaces:**
- Consumes: canonical router renderers and final CLI command.
- Produces: checked-in portable instructions and friend-facing onboarding.

- [ ] **Step 1: Generate and verify repository dogfood instructions**

Run the bundled CLI setup against this repository with `--host all --skip-external-skills`. Confirm the three instruction surfaces exactly match the canonical renderers and that ignored machine MCP files are not staged.

- [ ] **Step 2: Rewrite onboarding around one command**

README begins with prerequisites and:

```bash
npx --yes github:zhangnanlin/agentflow#v0.2.0 setup --host codex
```

Document `cursor`, `vscode`, `all`, `--dry-run`, `--start`, `agentflow:on/off`, automatic routing scope, host restart, Figma OAuth, contributor workflow, and the fact that tag creation is pending until the release Gate.

- [ ] **Step 3: Update host setup and project status**

Remove the old delete-and-regenerate workaround. Document safe merge behavior, durable runtime path, automatic router diagnostics, Figma live preflight, and recovery. Update the project spec to mark one-command distribution and automatic routing implemented while keeping Cursor/VS Code native Worker execution and live Figma evidence as explicit remaining boundaries.

- [ ] **Step 4: Validate every Skill**

Run:

```powershell
$env:PYTHONUTF8='1'
Get-ChildItem .agents/skills -Directory | Sort-Object Name | ForEach-Object {
  python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: 14 `Skill is valid!` results.

- [ ] **Step 5: Run final repository and distribution verification**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:distribution
npm.cmd run cli -- doctor --host codex
npm.cmd run cli -- doctor --host cursor
npm.cmd run cli -- doctor --host vscode
npm.cmd pack --dry-run --json
git diff --check
git status --short
```

Expected: all tests pass, TypeScript/build/bundles pass, all three doctors are healthy, package contents are portable, diff check is empty, and only intended tracked changes remain.

- [ ] **Step 6: Request broad code review and fix every blocking finding**

Review from merge base `bdbd61f` through HEAD against the approved design. The reviewer must check setup transaction safety, config preservation, path/symlink escape handling, packaged runtime durability, router scope, and missing tests. Re-run focused tests after every fix.

- [ ] **Step 7: Commit documentation and dogfood output**

```bash
git add AGENTS.md .cursor/rules/agentflow.mdc .github/copilot-instructions.md README.md docs/HOST_SETUP.md AGENTFLOW_PROJECT_SPEC.md
git commit -m "docs: add one-command AgentFlow onboarding"
```

- [ ] **Step 8: Prepare release handoff**

Do not push `v0.2.0`, publish npm, or create a Git tag automatically. Present the verified commit, package dry-run, exact GitHub `npx` command, rollback procedure, and residual risks for an explicit release decision.
