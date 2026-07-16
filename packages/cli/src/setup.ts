import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AgentFlowError, defaultPipeline } from "@agentflow/core";
import { stringify as stringifyYaml } from "yaml";
import { renderAgentsInstruction, renderCursorRule, renderVsCodeInstruction } from "./auto-router.js";
import type { DistributionAssets } from "./distribution.js";
import { mergeHostConfiguration } from "./host-config-merge.js";
import {
  hostConfigurationTarget,
  type HostClient,
  type HostConfigurationSpec
} from "./host-config.js";

export interface PlannedFile {
  path: string;
  content: Uint8Array;
  source?: string;
}

export interface SetupOptions {
  projectRoot: string;
  hosts: (HostClient | "all")[];
  assets: DistributionAssets;
  dryRun?: boolean;
  skipExternalSkills?: boolean;
}

export interface SetupResult {
  projectRoot: string;
  hosts: HostClient[];
  runtime: { cli: string; mcp: string };
  installedSkills: string[];
  pinnedCommits: Record<string, string>;
  planned: string[];
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
  requiredActions: string[];
}

export interface SetupFileSystem {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SetupDependencies {
  fileSystem?: Partial<SetupFileSystem>;
  gitRunner?: GitRunner;
  nodeVersion?: string;
}

export interface GitRunResult {
  stdout: string;
}

export type GitRunner = (args: string[]) => Promise<GitRunResult>;

export interface SetupPlan {
  projectRoot: string;
  hosts: HostClient[];
  runtime: { cli: string; mcp: string };
  installedSkills: string[];
  pinnedCommits: Record<string, string>;
  files: PlannedFile[];
  snapshots: Map<string, Uint8Array | undefined>;
  skipped: string[];
  requiredActions: string[];
}

interface CollectedFile {
  relativePath: string;
  path: string;
  content: Uint8Array;
}

const hostOrder: HostClient[] = ["codex", "cursor", "vscode"];
const superpowersCommit = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);
const nativeFileSystem: SetupFileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, content) => {
    await writeFile(path, content);
  },
  rename,
  remove: async (path) => {
    await rm(path, { force: true });
  }
};
const nativeGitRunner: GitRunner = async (args) => {
  const result = await execFileAsync("git", args, { encoding: "utf8" });
  return { stdout: result.stdout };
};

async function assertGitAvailable(gitRunner: GitRunner): Promise<void> {
  try {
    await gitRunner(["--version"]);
  } catch (error) {
    throw new AgentFlowError(
      "Git is required to install and run AgentFlow",
      "SETUP_GIT_UNAVAILABLE",
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function sameOptionalBytes(
  left: Uint8Array | undefined,
  right: Uint8Array | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameBytes(left, right);
}

function assertNodeVersion(version: string): void {
  const major = Number.parseInt(version, 10);
  if (!Number.isSafeInteger(major) || major < 20) {
    throw new AgentFlowError(
      `AgentFlow setup requires Node.js 20 or newer; received ${version}`,
      "SETUP_NODE_UNSUPPORTED",
      { version }
    );
  }
}

function normalizeHosts(values: (HostClient | "all")[]): HostClient[] {
  if (values.length === 0) {
    throw new AgentFlowError("Select at least one host", "SETUP_HOST_REQUIRED");
  }
  const expanded = values.includes("all") ? hostOrder : values;
  const selected = new Set<HostClient>();
  for (const value of expanded) {
    if (value === "all") continue;
    if (!hostOrder.includes(value)) {
      throw new AgentFlowError(`Unsupported host: ${value as string}`, "SETUP_HOST_INVALID");
    }
    selected.add(value);
  }
  return hostOrder.filter((host) => selected.has(host));
}

export function resolveSetupDestination(projectRoot: string, destination: string): string {
  const root = resolve(projectRoot);
  const target = isAbsolute(destination) ? resolve(destination) : resolve(root, destination);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new AgentFlowError(
      `Setup destination escapes the project root: ${destination}`,
      "SETUP_PATH_ESCAPE",
      { projectRoot: root, destination: target }
    );
  }
  return target;
}

async function assertNoLinkedDestination(
  projectRoot: string,
  target: string
): Promise<void> {
  await assertRealDirectory(projectRoot, "Setup path root");
  const pathFromRoot = relative(projectRoot, target);
  let current = projectRoot;
  for (const segment of pathFromRoot.split(sep).filter((value) => value.length > 0)) {
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new AgentFlowError(
          `Setup destination contains a symbolic link: ${current}`,
          "SETUP_PATH_ESCAPE",
          { projectRoot, target, linkedPath: current }
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink() && stats.isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new AgentFlowError(
    `${label} must be a real directory: ${path}`,
    "SETUP_PATH_ESCAPE",
    { path, label }
  );
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function collectFiles(root: string, current = root): Promise<CollectedFile[]> {
  const rootStats = await lstat(current);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new AgentFlowError(
      `Setup source must be a real directory: ${current}`,
      "SETUP_PATH_ESCAPE",
      { sourceRoot: root, source: current }
    );
  }
  const entries = await readdir(current, { withFileTypes: true });
  const collected: CollectedFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AgentFlowError(
        `Setup source contains a symbolic link: ${path}`,
        "SETUP_PATH_ESCAPE",
        { sourceRoot: root, source: path }
      );
    } else if (entry.isDirectory()) {
      collected.push(...await collectFiles(root, path));
    } else if (entry.isFile()) {
      collected.push({
        relativePath: relative(root, path),
        path,
        content: await readFile(path)
      });
    } else {
      throw new AgentFlowError(
        `Setup source contains an unsupported filesystem entry: ${path}`,
        "SETUP_PATH_ESCAPE",
        { sourceRoot: root, source: path }
      );
    }
  }
  return collected;
}

async function readDistributionFile(
  assetsRoot: string,
  path: string
): Promise<Uint8Array> {
  resolveSetupDestination(assetsRoot, path);
  await assertNoLinkedDestination(assetsRoot, path);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AgentFlowError(
      `Distribution asset must be a real file: ${path}`,
      "SETUP_PATH_ESCAPE",
      { assetsRoot, source: path }
    );
  }
  return readFile(path);
}

async function pathIsDirectory(path: string): Promise<boolean | undefined> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertCompatibleSkill(
  skillName: string,
  sourceFiles: CollectedFile[],
  destinationRoot: string
): Promise<void> {
  const destinationKind = await pathIsDirectory(destinationRoot);
  if (destinationKind === undefined) return;
  if (!destinationKind) {
    throw new AgentFlowError(
      `Skill destination is occupied: ${destinationRoot}`,
      "SKILL_COLLISION",
      { skillName, destinationRoot }
    );
  }

  const existingFiles = await collectFiles(destinationRoot);
  const sourceByPath = new Map(sourceFiles.map((file) => [file.relativePath, file.content]));
  const existingByPath = new Map(existingFiles.map((file) => [file.relativePath, file.content]));
  const paths = new Set([...sourceByPath.keys(), ...existingByPath.keys()]);
  const equal = [...paths].every((path) => {
    const source = sourceByPath.get(path);
    const existing = existingByPath.get(path);
    return source !== undefined && existing !== undefined && sameBytes(existing, source);
  });
  if (!equal) {
    throw new AgentFlowError(
      `Skill already exists with different content: ${skillName}`,
      "SKILL_COLLISION",
      { skillName, destinationRoot }
    );
  }
}

function assertSkillName(skillName: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) {
    throw new AgentFlowError(
      `Unsafe Skill name: ${skillName}`,
      "SETUP_PATH_ESCAPE",
      { skillName }
    );
  }
}

async function plannedSkillFiles(
  skillName: string,
  sourceRoot: string,
  projectRoot: string
): Promise<PlannedFile[]> {
  assertSkillName(skillName);
  const destinationRoot = resolveSetupDestination(
    projectRoot,
    join(".agents", "skills", skillName)
  );
  await assertNoLinkedDestination(projectRoot, destinationRoot);
  const sourceFiles = await collectFiles(sourceRoot);
  await assertCompatibleSkill(skillName, sourceFiles, destinationRoot);
  return sourceFiles.map((file) => ({
    path: resolveSetupDestination(destinationRoot, file.relativePath),
    content: file.content,
    source: file.path
  }));
}

async function agentFlowSkillFiles(
  skillsDirectory: string,
  assetsRoot: string,
  projectRoot: string
): Promise<PlannedFile[]> {
  resolveSetupDestination(assetsRoot, skillsDirectory);
  await assertNoLinkedDestination(assetsRoot, skillsDirectory);
  const rootStats = await lstat(skillsDirectory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new AgentFlowError(
      `Distribution Skills path must be a real directory: ${skillsDirectory}`,
      "SETUP_PATH_ESCAPE",
      { assetsRoot, source: skillsDirectory }
    );
  }
  const entries = await readdir(skillsDirectory, { withFileTypes: true });
  const planned: PlannedFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw new AgentFlowError(
        `Distribution Skills path contains a symbolic link: ${entry.name}`,
        "SETUP_PATH_ESCAPE",
        { assetsRoot, source: resolve(skillsDirectory, entry.name) }
      );
    }
    if (!entry.isDirectory()) continue;
    const sourceRoot = resolve(skillsDirectory, entry.name);
    planned.push(...await plannedSkillFiles(entry.name, sourceRoot, projectRoot));
  }
  return planned;
}

interface LockedSuperpowersDependency {
  repository: string;
  skills: string[];
}

function lockDependencies(content: Uint8Array): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(content));
  } catch (error) {
    throw new AgentFlowError(
      "skills-lock.json is not valid JSON",
      "EXTERNAL_SKILL_LOCK_INVALID",
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
  if (typeof parsed !== "object" || parsed === null
    || !("dependencies" in parsed) || !Array.isArray(parsed.dependencies)) {
    throw new AgentFlowError(
      "skills-lock.json must contain a dependencies array",
      "EXTERNAL_SKILL_LOCK_INVALID"
    );
  }
  return parsed.dependencies.filter((value): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && !Array.isArray(value)
  ));
}

function pinnedCommits(content: Uint8Array): Record<string, string> {
  const commits: Record<string, string> = {};
  for (const dependency of lockDependencies(content)) {
    if (typeof dependency.id === "string" && typeof dependency.commit === "string") {
      commits[dependency.id] = dependency.commit;
    }
  }
  return Object.fromEntries(Object.entries(commits).sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

function lockedSuperpowers(content: Uint8Array): LockedSuperpowersDependency {
  const dependency = lockDependencies(content).find((value) => (
    value.id === "obra-superpowers"
  ));
  if (typeof dependency !== "object" || dependency === null) {
    throw new AgentFlowError(
      "skills-lock.json does not declare obra-superpowers",
      "EXTERNAL_SKILL_LOCK_MISSING"
    );
  }
  const repository = "repository" in dependency ? dependency.repository : undefined;
  const commit = "commit" in dependency ? dependency.commit : undefined;
  const rawSkills = "skills" in dependency ? dependency.skills : undefined;
  if (typeof repository !== "string" || repository.length === 0
    || commit !== superpowersCommit || !Array.isArray(rawSkills)) {
    throw new AgentFlowError(
      "obra-superpowers lock entry is invalid or not pinned to the approved commit",
      "EXTERNAL_SKILL_LOCK_INVALID",
      { expectedCommit: superpowersCommit, actualCommit: commit }
    );
  }
  const skills = rawSkills.map((value: unknown) => (
    typeof value === "object" && value !== null && "name" in value
      ? value.name
      : undefined
  ));
  if (skills.some((name) => typeof name !== "string")) {
    throw new AgentFlowError(
      "obra-superpowers lock entry contains an invalid Skill",
      "EXTERNAL_SKILL_LOCK_INVALID"
    );
  }
  const uniqueSkills = [...new Set(skills as string[])];
  uniqueSkills.forEach(assertSkillName);
  return { repository, skills: uniqueSkills };
}

async function externalSkillFiles(
  lockContent: Uint8Array,
  projectRoot: string,
  gitRunner: GitRunner
): Promise<PlannedFile[]> {
  const dependency = lockedSuperpowers(lockContent);
  const staging = await mkdtemp(join(tmpdir(), "agentflow-superpowers-"));
  const checkout = resolve(staging, "checkout");
  try {
    await gitRunner(["clone", "--no-checkout", dependency.repository, checkout]);
    await assertRealDirectory(checkout, "Superpowers checkout");
    await gitRunner(["-C", checkout, "checkout", "--detach", superpowersCommit]);
    const revision = (await gitRunner(["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
    if (revision !== superpowersCommit) {
      throw new AgentFlowError(
        "Superpowers checkout does not match the approved commit",
        "EXTERNAL_SKILL_COMMIT_MISMATCH",
        { expectedCommit: superpowersCommit, actualCommit: revision }
      );
    }

    const planned: PlannedFile[] = [];
    for (const skillName of dependency.skills) {
      const sourceRoot = resolveSetupDestination(
        checkout,
        join("skills", skillName)
      );
      await assertNoLinkedDestination(checkout, sourceRoot);
      planned.push(...await plannedSkillFiles(skillName, sourceRoot, projectRoot));
    }
    return planned;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function existingText(projectRoot: string, path: string): Promise<string> {
  await assertNoLinkedDestination(projectRoot, path);
  const content = await readOptional(path);
  return content === undefined
    ? ""
    : new TextDecoder("utf-8", { ignoreBOM: true }).decode(content);
}

/** Build and validate the complete target write plan without mutating the project. */
export async function planSetup(
  options: SetupOptions,
  dependencies: SetupDependencies = {}
): Promise<SetupPlan> {
  assertNodeVersion(dependencies.nodeVersion ?? process.versions.node);
  const gitRunner = dependencies.gitRunner ?? nativeGitRunner;
  await assertGitAvailable(gitRunner);
  const projectRoot = resolve(options.projectRoot);
  const rootKind = await pathIsDirectory(projectRoot);
  if (!rootKind) {
    throw new AgentFlowError(
      `Project root must be an existing directory: ${projectRoot}`,
      "SETUP_PROJECT_ROOT_INVALID",
      { projectRoot }
    );
  }
  try {
    await access(projectRoot, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    throw new AgentFlowError(
      `Project root is not readable and writable: ${projectRoot}`,
      "SETUP_PROJECT_ROOT_INACCESSIBLE",
      { projectRoot, cause: error instanceof Error ? error.message : String(error) }
    );
  }
  await assertRealDirectory(options.assets.root, "Distribution root");
  const hosts = normalizeHosts(options.hosts);
  const files: PlannedFile[] = [];
  const snapshots = new Map<string, Uint8Array | undefined>();
  const skipped: string[] = [];
  const requiredActions = new Set<string>();
  const destinations = new Set<string>();

  const add = async (file: PlannedFile): Promise<void> => {
    const path = resolveSetupDestination(projectRoot, file.path);
    await assertNoLinkedDestination(projectRoot, path);
    if (destinations.has(path)) {
      throw new AgentFlowError(
        `Setup planned the same destination twice: ${path}`,
        "SETUP_PLAN_DUPLICATE",
        { path }
      );
    }
    destinations.add(path);
    snapshots.set(path, await readOptional(path));
    files.push({ ...file, path });
  };

  const agentsPath = resolveSetupDestination(projectRoot, "AGENTS.md");
  await add({
    path: agentsPath,
    content: text(renderAgentsInstruction(await existingText(projectRoot, agentsPath)))
  });

  if (hosts.includes("cursor")) {
    const cursorRulePath = resolveSetupDestination(
      projectRoot,
      ".cursor/rules/agentflow.mdc"
    );
    const cursorRule = await existingText(projectRoot, cursorRulePath);
    await add({
      path: cursorRulePath,
      content: text(renderCursorRule(cursorRule))
    });
  }
  if (hosts.includes("vscode")) {
    const instructionPath = resolveSetupDestination(projectRoot, ".github/copilot-instructions.md");
    await add({
      path: instructionPath,
      content: text(renderVsCodeInstruction(await existingText(projectRoot, instructionPath)))
    });
  }

  const runtimeCli = resolveSetupDestination(projectRoot, ".agentflow/runtime/bin/agentflow-cli.mjs");
  const runtimeMcp = resolveSetupDestination(projectRoot, ".agentflow/runtime/bin/agentflow-mcp.mjs");
  await add({
    path: runtimeCli,
    content: await readDistributionFile(options.assets.root, options.assets.cliBundle),
    source: options.assets.cliBundle
  });
  await add({
    path: runtimeMcp,
    content: await readDistributionFile(options.assets.root, options.assets.mcpBundle),
    source: options.assets.mcpBundle
  });

  const configPath = resolveSetupDestination(projectRoot, ".agentflow/config.yaml");
  const pipelinePath = resolveSetupDestination(projectRoot, ".agentflow/pipeline.yaml");
  const defaults: PlannedFile[] = [
    {
      path: configPath,
      content: text(stringifyYaml({ version: 1, pipeline: "pipeline.yaml", runsDirectory: "runs" }))
    },
    { path: pipelinePath, content: text(stringifyYaml(defaultPipeline)) }
  ];
  for (const file of defaults) {
    await assertNoLinkedDestination(projectRoot, file.path);
    if (await readOptional(file.path) === undefined) await add(file);
    else skipped.push(file.path);
  }

  const lockPath = resolveSetupDestination(projectRoot, "skills-lock.json");
  const lockContent = await readDistributionFile(options.assets.root, options.assets.skillsLockPath);
  const resolvedPinnedCommits = pinnedCommits(lockContent);
  await assertNoLinkedDestination(projectRoot, lockPath);
  const existingLock = await readOptional(lockPath);
  if (existingLock !== undefined && !sameBytes(existingLock, lockContent)) {
    throw new AgentFlowError(
      `A different skills-lock.json already exists: ${lockPath}`,
      "SKILLS_LOCK_CONFLICT",
      { lockPath }
    );
  }
  await add({ path: lockPath, content: lockContent, source: options.assets.skillsLockPath });

  for (const skillFile of await agentFlowSkillFiles(
    options.assets.skillsDirectory,
    options.assets.root,
    projectRoot
  )) {
    await add(skillFile);
  }
  if (!options.skipExternalSkills) {
    for (const skillFile of await externalSkillFiles(
      lockContent,
      projectRoot,
      gitRunner
    )) {
      await add(skillFile);
    }
  }

  for (const host of hosts) {
    const spec: HostConfigurationSpec = {
      client: host,
      projectRoot,
      agentflowMcpEntryPoint: runtimeMcp
    };
    const hostPath = resolveSetupDestination(
      projectRoot,
      hostConfigurationTarget(host, projectRoot)
    );
    await add({
      path: hostPath,
      content: text(mergeHostConfiguration(
        host,
        await existingText(projectRoot, hostPath),
        spec
      ))
    });
    const action = (() => {
      switch (host) {
        case "codex": return "Restart Codex if needed and authenticate Figma with `codex mcp login figma`.";
        case "cursor": return "Restart Cursor if needed and authenticate Figma from MCP settings.";
        case "vscode": return "Restart VS Code if needed, start Figma from MCP: List Servers, and complete Allow Access.";
      }
    })();
    requiredActions.add(action);
  }

  const skillsRoot = resolveSetupDestination(projectRoot, ".agents/skills");
  const installedSkills = [...new Set(files.flatMap((file) => {
    const pathFromSkills = relative(skillsRoot, file.path);
    if (pathFromSkills === ".." || pathFromSkills.startsWith(`..${sep}`)
      || isAbsolute(pathFromSkills)) return [];
    const [skillName] = pathFromSkills.split(sep);
    return skillName ? [skillName] : [];
  }))].sort();

  return {
    projectRoot,
    hosts,
    runtime: { cli: runtimeCli, mcp: runtimeMcp },
    installedSkills,
    pinnedCommits: resolvedPinnedCommits,
    files,
    snapshots,
    skipped,
    requiredActions: [...requiredActions]
  };
}

async function atomicReplace(
  path: string,
  content: Uint8Array,
  fileSystem: SetupFileSystem
): Promise<void> {
  await fileSystem.mkdir(dirname(path));
  const temporary = resolve(dirname(path), `.agentflow-tmp-${randomUUID()}`);
  let renamed = false;
  try {
    await fileSystem.writeFile(temporary, content);
    await fileSystem.rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await fileSystem.remove(temporary);
  }
}

/** Apply the validated plan atomically and restore this invocation's writes on failure. */
export async function executeSetup(
  options: SetupOptions,
  dependencies: SetupDependencies = {}
): Promise<SetupResult> {
  const plan = await planSetup(options, dependencies);
  const fileSystem: SetupFileSystem = {
    ...nativeFileSystem,
    ...dependencies.fileSystem
  };
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const applied: Array<{
    path: string;
    previous: Uint8Array | undefined;
    content: Uint8Array;
  }> = [];

  if (!options.dryRun) {
    try {
      for (const file of plan.files) {
        const previous = plan.snapshots.get(file.path);
        await assertNoLinkedDestination(plan.projectRoot, file.path);
        const current = await readOptional(file.path);
        if (!sameOptionalBytes(current, previous)) {
          throw new AgentFlowError(
            `Setup target changed after planning: ${file.path}`,
            "SETUP_TARGET_CHANGED",
            { path: file.path }
          );
        }
        if (sameBytes(previous, file.content)) {
          unchanged.push(file.path);
          continue;
        }
        await atomicReplace(file.path, file.content, fileSystem);
        applied.push({ path: file.path, previous, content: file.content });
        (previous === undefined ? created : updated).push(file.path);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const file of applied.reverse()) {
        try {
          await assertNoLinkedDestination(plan.projectRoot, file.path);
          if (!sameBytes(await readOptional(file.path), file.content)) {
            throw new AgentFlowError(
              `Setup target changed before rollback: ${file.path}`,
              "SETUP_TARGET_CHANGED",
              { path: file.path }
            );
          }
          if (file.previous === undefined) await fileSystem.remove(file.path);
          else await atomicReplace(file.path, file.previous, fileSystem);
        } catch (rollbackError) {
          rollbackErrors.push(
            `${file.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AgentFlowError(
          "AgentFlow setup failed and rollback was incomplete",
          "SETUP_ROLLBACK_FAILED",
          {
            cause: error instanceof Error ? error.message : String(error),
            rollbackErrors
          }
        );
      }
      throw error;
    }
  } else {
    for (const file of plan.files) {
      if (sameBytes(plan.snapshots.get(file.path), file.content)) unchanged.push(file.path);
    }
  }

  return {
    projectRoot: plan.projectRoot,
    hosts: plan.hosts,
    runtime: plan.runtime,
    installedSkills: plan.installedSkills,
    pinnedCommits: plan.pinnedCommits,
    planned: plan.files.map((file) => file.path),
    created,
    updated,
    unchanged,
    skipped: plan.skipped,
    requiredActions: plan.requiredActions
  };
}
