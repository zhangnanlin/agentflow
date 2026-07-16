# AgentFlow Global Installation And Lazy Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentFlow install once at user scope for Codex, Cursor, and VS Code, dynamically resolve each MCP call's project, lazily initialize project state on the first changing request, and lead onboarding with an unversioned GitHub npx command.

**Architecture:** Keep the standalone CLI and stdio MCP deployment, move runtime and Skill installation to user-owned paths, and add a stateless per-call project resolver. A journaled project lifecycle operation initializes `.agentflow/`, resumes an unfinished Run, or creates exactly one new Run; the existing Core engine remains authoritative for all downstream state.

**Tech Stack:** TypeScript 7, Node.js 20+, Commander, Zod 4, YAML, smol-toml, Model Context Protocol SDK 1.29, esbuild 0.28, Vitest 4, Git CLI.

## Global Constraints

- Global setup is the default; `setup --scope project` retains AgentFlow 0.2.0 behavior.
- The primary command is `npx --yes github:zhangnanlin/agentflow setup --host codex|cursor|vscode|all`.
- Runtime files default to `~/.agentflow`; personal Skills install under `~/.agents/skills`.
- Codex, Cursor, and VS Code receive user-level AgentFlow and Figma MCP configuration without credentials or `required = true`.
- Every MCP state tool resolves an immutable project context for that call; no mutable global current-project value is allowed.
- Project resolution fails closed for ambiguity, unsafe paths, or an unavailable root.
- Read-only operations never initialize a missing project.
- First-use start-or-resume is locked, journaled, idempotent by request key, and crash-recoverable.
- Project initialization creates lightweight `.agentflow` control/state files only; it does not edit root `.gitignore` or copy runtime, Skills, routing files, or host config.
- Existing fixed-root MCP invocation and project-scoped setup remain compatible.
- Human Gates remain mandatory and Figma is called only by Stages that declare it.
- Implementation follows red-green-refactor; every production behavior begins with an observed failing test.
- The plan authoring baseline is `c682d18a0e2034b6bc759d62f464bec6f007d38a`; the strict AgentFlow plan pins the commit containing this human-readable plan as its implementation baseline.

---

## File Map

- `packages/host-adapter/src/routing.ts`: canonical cross-host routing text and MCP instruction prefix.
- `packages/host-adapter/src/index.ts`: export the routing contract.
- `packages/host-adapter/test/routing.test.ts`: canonical text and prefix coverage.
- `packages/cli/src/auto-router.ts`: render legacy project instruction surfaces from the shared contract.
- `packages/cli/test/auto-router.test.ts`: prove legacy renderers have no copy drift.
- `packages/mcp-server/src/project-root.ts`: stateless dynamic project resolution and client-root validation.
- `packages/mcp-server/src/project-lifecycle.ts`: project bootstrap, start lock, request record, pending journal, atomic pointer, start-or-resume.
- `packages/mcp-server/src/runtime.ts`: initialized-project assertions and path helpers.
- `packages/mcp-server/src/index.ts`: fixed-root compatibility versus dynamic server startup.
- `packages/mcp-server/src/server.ts`: per-call project schemas, project resolver wiring, MCP instructions, and `run_start_or_resume`.
- `packages/mcp-server/test/project-root.test.ts`: root-priority, URI, ambiguity, boundary, Git, and cwd tests.
- `packages/mcp-server/test/project-lifecycle.test.ts`: initialization, idempotency, concurrency, and crash-recovery tests.
- `packages/mcp-server/test/server.test.ts`: MCP instruction, lazy read, start-or-resume, two-project isolation, and legacy regression tests.
- `packages/cli/src/global-paths.ts`: deterministic user runtime, Skill, and host config paths.
- `packages/cli/src/setup.ts`: global/project plan branches and generic per-file safety roots.
- `packages/cli/src/host-config.ts`: optional fixed project arguments and user host target planning.
- `packages/cli/src/host-config-merge.ts`: reuse structural merges for user configuration.
- `packages/cli/src/doctor.ts`: separate installation and project health reporting.
- `packages/cli/src/index.ts`: global-by-default setup, scope-specific option validation, and 0.3.0 CLI version.
- `packages/cli/test/global-paths.test.ts`: Windows/macOS/Linux/env/override path resolution.
- `packages/cli/test/setup.test.ts`: global setup transaction, collision, rollback, and legacy mode.
- `packages/cli/test/host-config.test.ts`: global configurations omit fixed roots and secrets.
- `packages/cli/test/doctor.test.ts`: global install plus uninitialized/invalid project status.
- `packages/cli/test/cli.test.ts`: global setup command, scope validation, and version output.
- `packages/cli/test/distribution.test.ts`: isolated-home packed setup and two-project execution.
- `scripts/build-distribution.mjs`: inject package version into standalone bundles.
- `package.json`, `package-lock.json`: distribution version 0.3.0.
- `.agents/skills/agentflow-auto-router/SKILL.md`: start-or-resume and dynamic-root instructions.
- `.agents/skills/agentflow-auto-router/references/routing-contract.md`: global installation routing contract.
- `.agents/skills/agentflow-orchestrator/SKILL.md`: global MCP startup and project-root guidance.
- `README.md`, `README.zh-CN.md`, `docs/HOST_SETUP.md`, `AGENTFLOW_PROJECT_SPEC.md`: global onboarding, compatibility, migration, and unversioned command.

---

### Task 1: Canonical Global Routing Contract

**Files:**
- Create: `packages/host-adapter/src/routing.ts`
- Create: `packages/host-adapter/test/routing.test.ts`
- Modify: `packages/host-adapter/src/index.ts`
- Modify: `packages/cli/src/auto-router.ts`
- Modify: `packages/cli/test/auto-router.test.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/test/server.test.ts`

**Interfaces:**
- Produces: `AGENTFLOW_ROUTER_BODY: string` and `AGENTFLOW_MCP_INSTRUCTIONS: string` from `@agentflow/host-adapter`.
- Consumes: existing `mergeManagedBlock` renderer behavior and `McpServer` constructor options.

- [ ] **Step 1: Write the failing shared routing tests**

```ts
import { describe, expect, it } from "vitest";
import { AGENTFLOW_MCP_INSTRUCTIONS, AGENTFLOW_ROUTER_BODY } from "../src/routing.js";

describe("global routing contract", () => {
  it("front-loads mutation routing, start-or-resume, and human Gates", () => {
    expect(AGENTFLOW_MCP_INSTRUCTIONS.slice(0, 512)).toContain("project-changing");
    expect(AGENTFLOW_MCP_INSTRUCTIONS.slice(0, 512)).toContain("run_start_or_resume");
    expect(AGENTFLOW_MCP_INSTRUCTIONS.slice(0, 512)).toContain("human Gate");
  });

  it("retains exemptions and one-request overrides", () => {
    for (const phrase of ["Pure questions", "read-only", "agentflow:on", "agentflow:off"]) {
      expect(AGENTFLOW_ROUTER_BODY).toContain(phrase);
    }
  });
});
```

- [ ] **Step 2: Run the new test and observe RED**

Run: `npm.cmd test -- packages/host-adapter/test/routing.test.ts`

Expected: FAIL because `src/routing.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared contract and exports**

Create `routing.ts` with one canonical body. Its first paragraph must say, in this order: classify project-changing requests, call `run_start_or_resume`, resume unfinished work, then preserve human Gates. Follow it with exemptions, overrides, project-root ambiguity behavior, Worker delegation, and Artifact registration rules.

```ts
export const AGENTFLOW_ROUTER_BODY = `## AgentFlow automatic routing
- For every project-changing request, load agentflow-auto-router before editing.
- Call run_start_or_resume with the original requirement before other state mutations.
- Resume an unfinished Run and never duplicate it.
- Preserve every human Gate and never infer approval.
- Pure questions, code explanation, read-only inspection, status lookup, and simple non-mutating commands bypass AgentFlow.
- agentflow:on forces routing for one request; agentflow:off bypasses it for one request.`;

export const AGENTFLOW_MCP_INSTRUCTIONS = `${AGENTFLOW_ROUTER_BODY}\nUse an explicit absolute projectRoot when the client exposes multiple workspace roots.`;
```

Export both names from `packages/host-adapter/src/index.ts`. Import `AGENTFLOW_ROUTER_BODY` in CLI `auto-router.ts` and remove its local copy.

- [ ] **Step 4: Write a failing MCP instruction test**

Add a server test that inspects the low-level server's initialization options through an injected transport or SDK initialize exchange and expects the instructions to equal `AGENTFLOW_MCP_INSTRUCTIONS`.

Run: `npm.cmd test -- packages/mcp-server/test/server.test.ts -t "publishes canonical routing instructions"`

Expected: FAIL because the server currently supplies no initialization instructions.

- [ ] **Step 5: Publish the shared MCP instructions**

Construct `McpServer` with:

```ts
new McpServer(
  { name: "agentflow", version: AGENTFLOW_VERSION },
  { instructions: AGENTFLOW_MCP_INSTRUCTIONS }
);
```

Keep the version constant temporarily at the current value; Task 5 centralizes distribution versioning.

- [ ] **Step 6: Verify GREEN and existing renderer compatibility**

Run: `npm.cmd test -- packages/host-adapter/test/routing.test.ts packages/cli/test/auto-router.test.ts packages/mcp-server/test/server.test.ts`

Expected: all selected files pass and legacy managed markers remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/host-adapter/src/routing.ts packages/host-adapter/src/index.ts packages/host-adapter/test/routing.test.ts packages/cli/src/auto-router.ts packages/cli/test/auto-router.test.ts packages/mcp-server/src/server.ts packages/mcp-server/test/server.test.ts
git commit -m "feat: share global AgentFlow routing contract"
```

---

### Task 2: Stateless Per-Call Project Resolution

**Files:**
- Create: `packages/mcp-server/src/project-root.ts`
- Create: `packages/mcp-server/test/project-root.test.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/test/server.test.ts`

**Interfaces:**
- Produces: `ProjectRootResolver`, `ProjectRootResolution`, and `ProjectRootResolverDependencies`.
- `ProjectRootResolver.resolve(explicitProjectRoot?: string): Promise<ProjectRootResolution>` returns `{ projectRoot, source }` where source is `fixed|explicit|client-root|git|cwd`.
- Consumes: optional fixed root, `roots/list`, Git runner, cwd, `realpath`, and `lstat` dependencies.

- [ ] **Step 1: Write failing priority and ambiguity tests**

```ts
it("uses fixed, explicit, one client root, Git, then cwd priority", async () => {
  const resolver = new ProjectRootResolver({
    fixedRoot,
    cwd,
    listRoots: async () => [{ uri: pathToFileURL(clientRoot).href }],
    gitTopLevel: async () => gitRoot
  });
  await expect(resolver.resolve(explicitRoot)).resolves.toMatchObject({
    projectRoot: canonicalFixedRoot,
    source: "fixed"
  });
});

it("rejects multiple client roots before writes", async () => {
  const resolver = new ProjectRootResolver({
    cwd,
    listRoots: async () => [rootA, rootB]
  });
  await expect(resolver.resolve()).rejects.toMatchObject({
    code: "PROJECT_ROOT_AMBIGUOUS",
    details: { candidates: [canonicalA, canonicalB] }
  });
});
```

Also cover percent-encoded file URLs, non-file roots, relative/missing/file paths, explicit roots outside advertised roots, one explicit subdirectory inside a root, unavailable `roots/list`, Git failure, and cwd fallback.

- [ ] **Step 2: Run resolver tests and observe RED**

Run: `npm.cmd test -- packages/mcp-server/test/project-root.test.ts`

Expected: FAIL because `project-root.ts` does not exist.

- [ ] **Step 3: Implement minimal resolver behavior**

Use `fileURLToPath(new URL(uri))`, `realpath`, `lstat`, and `path.relative`; do not parse URI or containment with string slicing. Catch only documented unsupported-roots and Git-not-a-repository failures. Sort and deduplicate canonical client roots before ambiguity errors.

```ts
export interface ProjectRootResolution {
  projectRoot: string;
  source: "fixed" | "explicit" | "client-root" | "git" | "cwd";
}

export class ProjectRootResolver {
  constructor(private readonly dependencies: ProjectRootResolverDependencies) {}
  async resolve(explicitProjectRoot?: string): Promise<ProjectRootResolution> {
    if (this.dependencies.fixedRoot !== undefined) {
      return this.resolveCandidate(this.dependencies.fixedRoot, "fixed");
    }
    const clientRoots = await this.clientFileRoots();
    if (explicitProjectRoot !== undefined) {
      const explicit = await this.resolveCandidate(explicitProjectRoot, "explicit");
      this.assertAllowedByClientRoots(explicit.projectRoot, clientRoots);
      return explicit;
    }
    if (clientRoots.length > 1) {
      throw new AgentFlowError("Multiple project roots are available", "PROJECT_ROOT_AMBIGUOUS", {
        candidates: clientRoots
      });
    }
    if (clientRoots.length === 1) {
      return { projectRoot: clientRoots[0]!, source: "client-root" };
    }
    const gitRoot = await this.gitTopLevel();
    return gitRoot === undefined
      ? this.resolveCandidate(this.dependencies.cwd, "cwd")
      : this.resolveCandidate(gitRoot, "git");
  }
}
```

Every accepted path must be absolute, canonical, and a directory. When client roots are available, explicit roots must equal or be contained by one root.

- [ ] **Step 4: Verify resolver GREEN**

Run: `npm.cmd test -- packages/mcp-server/test/project-root.test.ts`

Expected: all priority, URI, boundary, and fallback cases pass.

- [ ] **Step 5: Write failing MCP two-project and legacy tests**

Add optional `projectRoot` to a shared `projectSelectorShape`. Instantiate one dynamic server with an injected resolver and call `pipeline_get` or initialized `status_get` for two roots. Assert each call reads only its target. Preserve a test where `createAgentFlowMcpServer({ projectRoot })` ignores a different tool root.

Run: `npm.cmd test -- packages/mcp-server/test/server.test.ts -t "project root"`

Expected: FAIL because handlers still capture one `paths` object.

- [ ] **Step 6: Resolve ProjectPaths inside every stateful handler**

Extend server options:

```ts
export interface AgentFlowMcpServerOptions {
  projectRoot?: string;
  projectRootResolver?: ProjectRootResolver;
}
```

Create the server first, then default the resolver with `server.server.listRoots()` as its roots provider. Add `projectRoot` to read and mutation schemas. Replace captured `paths` with:

```ts
const pathsFor = async (projectRoot?: string) =>
  projectPaths((await resolver.resolve(projectRoot)).projectRoot);
```

Resolve inside every handler that reads project state or Git. Pure `artifact_validate` remains project-independent but accepts no mutable selection. Ensure `worker_dispatch_prepare` and repository validation use that call's paths.

In `index.ts`, treat only `--project-root` or `AGENTFLOW_PROJECT_ROOT` as fixed. With neither, construct a dynamic server instead of fixing `process.cwd()` at startup.

- [ ] **Step 7: Verify dynamic and fixed-root GREEN**

Run: `npm.cmd test -- packages/mcp-server/test/project-root.test.ts packages/mcp-server/test/server.test.ts packages/mcp-server/test/s11-s12-flow.test.ts`

Expected: dynamic projects are isolated and all fixed-root flows pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/src/project-root.ts packages/mcp-server/src/index.ts packages/mcp-server/src/server.ts packages/mcp-server/test/project-root.test.ts packages/mcp-server/test/server.test.ts
git commit -m "feat(mcp): resolve projects per tool call"
```

---

### Task 3: Journaled Lazy Project And Run Lifecycle

**Files:**
- Create: `packages/mcp-server/src/project-lifecycle.ts`
- Create: `packages/mcp-server/test/project-lifecycle.test.ts`
- Modify: `packages/mcp-server/src/runtime.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/test/server.test.ts`

**Interfaces:**
- Produces: `startOrResumeRun(paths, input, dependencies?)` and `assertProjectInitialized(paths)`.
- Input: `{ requirement, projectType, hasUi, requestedRunId?, requestKey }`.
- Result: `{ action: "started"|"resumed", projectRoot, initialized, state }`.
- Consumes: `AgentFlowEngine`, `JsonRunStore`, default pipeline/config, canonical JSON hashing, atomic filesystem primitives, and the resolved `ProjectPaths`.

- [ ] **Step 1: Write failing no-mutation and bootstrap tests**

```ts
it("keeps read-only inspection non-mutating", async () => {
  const paths = projectPaths(root);
  await expect(assertProjectInitialized(paths)).rejects.toMatchObject({
    code: "PROJECT_NOT_INITIALIZED"
  });
  await expect(lstat(paths.agentflowDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("creates only lightweight control and state files", async () => {
  const result = await startOrResumeRun(projectPaths(root), {
    ...request,
    requestedRunId: "lazy-run"
  });
  expect(result.action).toBe("started");
  expect(await tree(root)).toEqual([
    ".agentflow/.gitignore",
    ".agentflow/config.yaml",
    ".agentflow/current-run.json",
    ".agentflow/runs/lazy-run/state.json",
    ".agentflow/pipeline.yaml"
  ]);
});
```

- [ ] **Step 2: Run lifecycle tests and observe RED**

Run: `npm.cmd test -- packages/mcp-server/test/project-lifecycle.test.ts`

Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 3: Implement validated project bootstrap**

Extend MCP `ProjectPaths` with config, nested ignore, operation lock, pending journal, and start-request directory paths. Create missing config and pipeline with `flag: "wx"`; parse and validate existing YAML. Merge the nested ignore file through an AgentFlow-owned marker and include:

```gitignore
runtime/
runs/
current-run.json
.start.lock
.start.pending.json
start-requests/
*.tmp
```

Use same-directory temporary files and `rename` for changed existing content. Never edit root `.gitignore`.

- [ ] **Step 4: Write failing idempotency, concurrency, and recovery tests**

Cover:

- two concurrent calls with different keys produce one active current Run;
- one key retried with the same input returns its recorded Run;
- one key reused with different immutable input returns `IDEMPOTENCY_CONFLICT`;
- an injected crash after journal, after Run creation, after current pointer, and before request-record completion recovers one Run;
- a stale operation lock is reclaimed and a live lock times out;
- invalid config, pipeline, pointer, journal, or request record fails closed.

Run: `npm.cmd test -- packages/mcp-server/test/project-lifecycle.test.ts`

Expected: new cases FAIL before lock, journal, and request records exist.

- [ ] **Step 5: Implement the locked state machine**

Use `.agentflow/.start.lock` with exclusive open and bounded stale detection. Hash immutable request fields with `canonicalJson` and `sha256`. Compute each completed request record with ``resolve(paths.startRequestsDirectory, `${sha256(requestKey)}.json`)``; store only key hash, input hash, Run ID, action, and timestamps.

While holding the lock:

1. validate a completed request record or reject mismatched input;
2. validate/recover a pending journal;
3. initialize control files;
4. load and resume an unfinished current Run when present;
5. otherwise persist pending data, create the predetermined Run ID, atomically write current pointer, persist the completed request record, and remove pending data.

Release the lock in `finally`. Never treat a missing pointer as permission to discard a valid pending journal.

- [ ] **Step 6: Verify lifecycle GREEN**

Run: `npm.cmd test -- packages/mcp-server/test/project-lifecycle.test.ts`

Expected: all bootstrap, concurrency, idempotency, fault-injection, and invalid-state cases pass.

- [ ] **Step 7: Add failing MCP run_start_or_resume tests**

Register a mutating tool with schema:

```ts
{
  projectRoot: z.string().optional(),
  requirement: z.string().min(1).max(20_000),
  projectType: z.enum(["new", "existing"]),
  hasUi: z.boolean(),
  requestedRunId: IdentifierSchema.optional(),
  requestKey: z.string().min(1).max(256)
}
```

Prove a fresh root starts, the second requirement resumes the unfinished Run, completed current work permits a new Run, and `status_get` before first use creates nothing.

Run: `npm.cmd test -- packages/mcp-server/test/server.test.ts -t "start or resume"`

Expected: FAIL because the tool and initialized-project guard are absent.

- [ ] **Step 8: Wire the tool and read guards**

Resolve paths per call, invoke `startOrResumeRun`, and return the structured result through `handleTool`. Add `assertProjectInitialized` before `pipeline_get`, `status_get`, and every existing stateful operation; `run_start_or_resume` is the only MCP entry that bootstraps.

- [ ] **Step 9: Verify MCP and Core regressions**

Run: `npm.cmd test -- packages/mcp-server/test/project-lifecycle.test.ts packages/mcp-server/test/server.test.ts packages/mcp-server/test/s11-s12-flow.test.ts packages/core/test`

Expected: all lifecycle, MCP, and Core tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-server/src/project-lifecycle.ts packages/mcp-server/src/runtime.ts packages/mcp-server/src/server.ts packages/mcp-server/test/project-lifecycle.test.ts packages/mcp-server/test/server.test.ts
git commit -m "feat(mcp): initialize projects on first changing request"
```

---

### Task 4: Transactional User-Global Setup

**Files:**
- Create: `packages/cli/src/global-paths.ts`
- Create: `packages/cli/test/global-paths.test.ts`
- Modify: `packages/cli/src/setup.ts`
- Modify: `packages/cli/src/host-config.ts`
- Modify: `packages/cli/src/host-config-merge.ts`
- Modify: `packages/cli/test/setup.test.ts`
- Modify: `packages/cli/test/host-config.test.ts`
- Modify: `packages/cli/test/host-config-merge.test.ts`

**Interfaces:**
- Produces: `globalInstallationPaths(environment, overrides)`, global `SetupScope`, and a global `SetupPlan` whose files carry exact safety roots.
- Consumes: distribution assets, existing safe Skill collection, host structural merge, atomic replace, rollback, and injected filesystem/Git dependencies.

- [ ] **Step 1: Write failing cross-platform global path tests**

```ts
expect(globalInstallationPaths({ platform: "win32", home, appData })).toMatchObject({
  runtimeRoot: join(home, ".agentflow"),
  skillsRoot: join(home, ".agents", "skills"),
  codexConfig: join(home, ".codex", "config.toml"),
  cursorConfig: join(home, ".cursor", "mcp.json"),
  vscodeConfig: join(appData, "Code", "User", "mcp.json")
});
```

Add macOS, Linux/XDG, `AGENTFLOW_HOME`, `CODEX_HOME`, and absolute `vscodeConfig` override cases. Reject relative/empty overrides and missing required environment roots.

- [ ] **Step 2: Run path tests and observe RED**

Run: `npm.cmd test -- packages/cli/test/global-paths.test.ts`

Expected: FAIL because `global-paths.ts` does not exist.

- [ ] **Step 3: Implement deterministic global paths**

Use `homedir`, `process.platform`, `APPDATA`, `XDG_CONFIG_HOME`, and `resolve`. Return exact runtime CLI/MCP, manifest, lock, Skill, and host-config paths. Keep environment access injectable; never read credentials.

- [ ] **Step 4: Write failing global setup tests**

With an isolated fake home and fake distribution, assert:

- runtime bundles and install metadata land under global runtime root;
- AgentFlow and lock-declared Skills land under personal Skills root;
- selected user host configs contain global bundle paths and no `--project-root`;
- the project directory remains empty;
- `all`, repeat, and dry-run behavior;
- existing unrelated Skills/config remain unchanged;
- conflicting Skill/server, linked parent, traversal, target swap, and injected later rename fail safely;
- install metadata contains expected non-secret fields and rejects sensitive keys.

Run: `npm.cmd test -- packages/cli/test/setup.test.ts -t "global"`

Expected: FAIL because setup has no global scope.

- [ ] **Step 5: Generalize the write plan safety root**

Add `safetyRoot` to each internal `PlannedFile`. Existing project plans set it to project root. Global files set it to runtime root, home root, or the exact host-config parent directory. Replace every executor-time assumption that all destinations sit under `projectRoot` with per-file containment and link validation.

Keep snapshots, duplicate-destination detection, target-change checks, atomic rename, and reverse rollback unchanged in semantics. The plan must validate every destination before its first write.

- [ ] **Step 6: Add the global plan branch**

Extend setup options with `scope: "global"|"project"` and injected global path environment. Global planning:

1. copies CLI/MCP to runtime `bin`;
2. copies lock data and writes `install.json` with version, revision-or-bundle hash, runtime paths, selected hosts, Skill names, and commits;
3. installs AgentFlow and external Skills under personal Skills;
4. renders user host configurations with a `HostConfigurationSpec` that has no project root;
5. does not create project config, pipeline, instructions, runtime, Skills, or host files.

Change `HostConfigurationSpec.projectRoot` to optional and render `--project-root` only when present. Keep absolute MCP entry validation.

- [ ] **Step 7: Verify global and legacy GREEN**

Run: `npm.cmd test -- packages/cli/test/global-paths.test.ts packages/cli/test/setup.test.ts packages/cli/test/host-config.test.ts packages/cli/test/host-config-merge.test.ts`

Expected: all global cases pass and every existing project setup case remains passing.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/global-paths.ts packages/cli/src/setup.ts packages/cli/src/host-config.ts packages/cli/src/host-config-merge.ts packages/cli/test/global-paths.test.ts packages/cli/test/setup.test.ts packages/cli/test/host-config.test.ts packages/cli/test/host-config-merge.test.ts
git commit -m "feat(cli): install AgentFlow once at user scope"
```

---

### Task 5: CLI, Doctor, Version, And Distribution Integration

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/cli/test/doctor.test.ts`
- Modify: `packages/cli/test/distribution.test.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `scripts/build-distribution.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: global-by-default CLI setup, explicit project scope, structured `{ installation, project }` doctor output, and version `0.3.0` in package/CLI/MCP bundles.
- Consumes: global setup planner, project setup compatibility branch, project lifecycle, distribution asset resolver, and host doctor checks.

- [ ] **Step 1: Write failing CLI scope and version tests**

Add cases that run `setup --host codex --skip-external-skills` with isolated HOME/CODEX_HOME and assert global paths plus an untouched project. Add `--scope project` to the existing setup/start test. Reject `--start`, `--project-type`, or `--no-ui` in global scope. Assert `--version` is `0.3.0`.

Run: `npm.cmd test -- packages/cli/test/cli.test.ts -t "global|scope|version"`

Expected: FAIL because setup defaults to project and reports 0.2.0.

- [ ] **Step 2: Implement scope-specific CLI behavior**

Add `--scope global|project` defaulting to `global` and `--vscode-config`. Pass an injected/real global environment to setup. Project-only options require project scope; global setup runs global doctor and never creates a Run. Keep `start` and `init` as explicit project operations.

Use one exported `AGENTFLOW_VERSION` fallback value of `0.3.0` in source builds. Configure esbuild `define` from root `package.json` so both standalone entries receive the package version.

- [ ] **Step 3: Write failing doctor section tests**

Cover:

- healthy global runtime/Skill/config with project `not-initialized` and overall non-blocking result;
- initialized project with valid config/pipeline/current Run;
- invalid config/pipeline as blocking;
- global missing runtime or router Skill as blocking;
- restart/OAuth uncertainty as warning;
- explicit project-scope legacy doctor.

Run: `npm.cmd test -- packages/cli/test/doctor.test.ts`

Expected: FAIL because doctor only understands project-installed runtime and Skills.

- [ ] **Step 4: Split installation and project doctor evidence**

Refactor shared checks without deleting existing live capability normalization. Global setup's doctor result must have:

```ts
{
  ok: boolean;
  status: "ok" | "warn" | "blocked";
  installation: { status: string; checks: DoctorCheck[] };
  project: { status: "initialized" | "not-initialized" | "invalid"; checks: DoctorCheck[] };
}
```

Missing project state is non-blocking; malformed state is blocking. Report exact global and project paths. Do not infer Figma authentication from config.

- [ ] **Step 5: Write failing packed two-project test**

Build the distribution, execute global setup under a temporary home, and use the packed MCP server API or an SDK client against two temporary initialized roots. Start one Run in each and assert isolated state trees. Verify no runtime, Skills, or host config exists in either project.

Run: `npm.cmd test -- packages/cli/test/distribution.test.ts`

Expected: FAIL until global CLI and dynamic MCP bundles are integrated.

- [ ] **Step 6: Update distribution version and build injection**

Set root package and lock version to `0.3.0`. Read package JSON in `build-distribution.mjs` and pass:

```js
define: { __AGENTFLOW_VERSION__: JSON.stringify(packageJson.version) }
```

to both builds. Ensure source tests use the same fallback and MCP initialization reports 0.3.0.

- [ ] **Step 7: Verify integration GREEN**

Run:

```powershell
npm.cmd test -- packages/cli/test/cli.test.ts packages/cli/test/doctor.test.ts packages/cli/test/distribution.test.ts
npm.cmd run typecheck
npm.cmd run build:distribution
node bundle/agentflow-cli.mjs --version
```

Expected: focused integration tests pass, TypeScript passes, bundles build, and CLI prints `0.3.0`.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/doctor.ts packages/cli/test/cli.test.ts packages/cli/test/doctor.test.ts packages/cli/test/distribution.test.ts packages/mcp-server/src/server.ts scripts/build-distribution.mjs package.json package-lock.json
git commit -m "feat(cli): expose global setup and lazy project diagnostics"
```

---

### Task 6: Skills, Bilingual Documentation, Migration, And Full Verification

**Files:**
- Modify: `.agents/skills/agentflow-auto-router/SKILL.md`
- Modify: `.agents/skills/agentflow-auto-router/references/routing-contract.md`
- Modify: `.agents/skills/agentflow-orchestrator/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/HOST_SETUP.md`
- Modify: `AGENTFLOW_PROJECT_SPEC.md`
- Modify: `packages/cli/test/distribution.test.ts`

**Interfaces:**
- Consumes: final setup/doctor/start-or-resume commands and generated paths.
- Produces: accurate implicit routing guidance, English/Chinese friend onboarding, migration instructions, and final distribution assertions.

- [ ] **Step 1: Write failing documentation and Skill contract assertions**

In distribution or a focused documentation test, assert:

```ts
for (const readme of [english, chinese]) {
  expect(readme).toContain("npx --yes github:zhangnanlin/agentflow setup --host codex");
  expect(readme).not.toContain("github:zhangnanlin/agentflow#v0.2.0 setup");
}
expect(routerSkill).toContain("run_start_or_resume");
expect(routerSkill).toContain("multiple workspace roots");
```

Also reject stale claims that setup copies runtime to `.agentflow/runtime` by default.

Run: `npm.cmd test -- packages/cli/test/distribution.test.ts -t "documentation"`

Expected: FAIL against current 0.2.0 docs and Skills.

- [ ] **Step 2: Update automatic-routing Skills**

The router must:

1. classify the request;
2. call `run_start_or_resume` only for a changing request;
3. pass explicit absolute `projectRoot` when multiple roots are present;
4. continue the current Run when returned;
5. load the orchestrator and preserve Gates;
6. leave reads and questions non-mutating.

The orchestrator must treat per-call project resolution and the returned Run as source of truth. Keep Worker lifecycle and Artifact rules unchanged.

- [ ] **Step 3: Rewrite English and Chinese onboarding**

Lead both READMEs with:

```bash
npx --yes github:zhangnanlin/agentflow setup --host codex
```

Document `all`, global paths, first changing use, read-only behavior, Figma OAuth once per host, `AGENTFLOW_HOME`, `CODEX_HOME`, `--vscode-config`, global doctor, project compatibility scope, and that the unversioned command follows `main`. Explain immutable Git tags without making a not-yet-approved tag the primary command.

- [ ] **Step 4: Update host setup and project spec**

Describe exact user config paths, dynamic project priority, multi-root remediation, project tree, global rollback, existing 0.2.0 precedence, and a manual migration that never deletes `.agentflow/runs`. Mark global installation and lazy initialization implemented only after tests prove them.

- [ ] **Step 5: Verify documentation GREEN and validate every Skill**

Run:

```powershell
npm.cmd test -- packages/cli/test/distribution.test.ts
$env:PYTHONUTF8='1'
Get-ChildItem .agents/skills -Directory | Sort-Object Name | ForEach-Object {
  python C:\Users\Roseee\.codex\skills\.system\skill-creator\scripts\quick_validate.py $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: distribution/documentation tests pass and every AgentFlow Skill prints `Skill is valid!`.

- [ ] **Step 6: Run complete repository verification**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:distribution
npm.cmd pack --dry-run --json
git diff --check
```

Expected: zero failing tests, successful TypeScript/build/bundles, package contains both READMEs/global Skills/bundles, and no whitespace errors.

- [ ] **Step 7: Run isolated global smoke checks**

Use temporary HOME/AGENTFLOW_HOME/CODEX_HOME and two temporary Git repositories. Execute the packed CLI global setup for Codex, then invoke start-or-resume for each project and doctor. Verify separate Run trees, no project runtime/Skills/config, and non-secret global manifest. Remove only the temporary directories.

- [ ] **Step 8: Request broad code review and resolve every finding**

Review from the strict plan base through HEAD. Required focus: user-home path containment, rollback across multiple roots, host config preservation, MCP root trust, multi-thread isolation, journal crash windows, request-key conflicts, read-only non-mutation, legacy setup compatibility, and documentation truthfulness. Add a failing regression test before every behavior fix.

- [ ] **Step 9: Commit**

```bash
git add .agents/skills/agentflow-auto-router/SKILL.md .agents/skills/agentflow-auto-router/references/routing-contract.md .agents/skills/agentflow-orchestrator/SKILL.md README.md README.zh-CN.md docs/HOST_SETUP.md AGENTFLOW_PROJECT_SPEC.md packages/cli/test/distribution.test.ts
git commit -m "docs: make global AgentFlow setup the default"
```

- [ ] **Step 10: Prepare release evidence without publishing**

Record the integrated commit, full command results, package file list, setup manifest scan, two-project evidence, host doctor results, compatibility result, residual host-profile risks, rollback procedure, and exact unversioned command. Do not push main, create a tag, or publish without the Stage S14 Release Gate.

---

## Execution Order

Run the six Tasks serially in the listed order. They intentionally overlap on
`packages/mcp-server/src/server.ts`, `packages/cli/src/setup.ts`, and
distribution tests, so parallel writable worktrees would add conflict risk
without reducing the critical path. Each Task ends with focused green tests and
one reviewable commit. Repository-wide verification and independent review occur
after Task 6 before integration is considered complete.
