import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  stageById,
  validatePipeline,
  type PipelineDefinition
} from "@agentflow/core";
import { parse as parseYaml } from "yaml";
import {
  globalInstallationPaths,
  type GlobalInstallationPaths,
  type GlobalPathEnvironment
} from "./global-paths.js";
import {
  inspectHostConfiguration,
  planHostConfiguration,
  type HostClient,
  type HostConfigurationPlan,
  type HostConfigurationSpec
} from "./host-config.js";
import { createEngine, type ProjectPaths } from "./runtime.js";
import type { GitRunner, SetupScope } from "./setup.js";

export type DoctorCheckStatus = "ok" | "warn" | "needs_user" | "blocked";
export type DoctorOverallStatus = "ok" | "warn" | "blocked";
export type ProjectDoctorStatus = "initialized" | "not-initialized" | "invalid";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorSection {
  status: DoctorOverallStatus;
  checks: DoctorCheck[];
}

export interface ProjectDoctorSection {
  status: ProjectDoctorStatus;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  ok: boolean;
  status: DoctorOverallStatus;
  scope: SetupScope;
  host?: HostClient;
  stageId?: string;
  installation: DoctorSection;
  project: ProjectDoctorSection;
  checks: DoctorCheck[];
  capabilities: {
    liveProbeProvided: boolean;
    required: string[];
    available: string[];
    missing: string[];
    ignored: string[];
  };
}

export interface DoctorOptions {
  paths: ProjectPaths;
  scope?: SetupScope;
  host?: HostClient;
  stageId?: string;
  capabilities?: string[];
  liveProbeProvided?: boolean;
  gitRunner?: GitRunner;
  globalPathEnvironment?: GlobalPathEnvironment;
  vscodeConfig?: string;
}

interface ProjectInspection {
  status: ProjectDoctorStatus;
  checks: DoctorCheck[];
  pipeline?: PipelineDefinition;
}

const execFileAsync = promisify(execFile);
const nativeGitRunner: GitRunner = async (args) => {
  const result = await execFileAsync("git", args, { encoding: "utf8" });
  return { stdout: result.stdout };
};

const FIGMA_TOOL_NAMES = new Set([
  "whoami",
  "create_new_file",
  "upload_assets",
  "download_assets",
  "generate_diagram",
  "generate_figma_design",
  "get_libraries",
  "get_metadata",
  "get_screenshot",
  "search_design_system",
  "use_figma"
]);

function check(
  id: string,
  status: DoctorCheckStatus,
  detail: string,
  remediation?: string
): DoctorCheck {
  return { id, status, detail, ...(remediation === undefined ? {} : { remediation }) };
}

function reportStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  if (checks.some((item) => item.status === "blocked")) return "blocked";
  if (checks.some((item) => item.status === "warn" || item.status === "needs_user")) {
    return "warn";
  }
  return "ok";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function inspectGit(checks: DoctorCheck[], gitRunner: GitRunner): Promise<void> {
  try {
    const result = await gitRunner(["--version"]);
    checks.push(check("git", "ok", result.stdout.trim() || "Git is available"));
  } catch (error) {
    checks.push(check(
      "git",
      "blocked",
      `Git is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      "Install Git and ensure it is available on PATH."
    ));
  }
}

export function processGlobalPathEnvironment(): GlobalPathEnvironment {
  return {
    platform: process.platform,
    home: homedir(),
    ...(process.env.APPDATA === undefined ? {} : { appData: process.env.APPDATA }),
    ...(process.env.XDG_CONFIG_HOME === undefined
      ? {}
      : { xdgConfigHome: process.env.XDG_CONFIG_HOME }),
    ...(process.env.AGENTFLOW_HOME === undefined
      ? {}
      : { agentflowHome: process.env.AGENTFLOW_HOME }),
    ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME })
  };
}

export function resolveAgentFlowMcpEntryPoint(projectRoot: string): string {
  const colocated = resolve(dirname(fileURLToPath(import.meta.url)), "agentflow-mcp.mjs");
  if (existsSync(colocated)) return colocated;
  try {
    return resolve(dirname(fileURLToPath(import.meta.resolve("@agentflow/mcp-server"))), "index.js");
  } catch {
    const sibling = fileURLToPath(new URL("../../mcp-server/dist/index.js", import.meta.url));
    return sibling || resolve(projectRoot, "packages", "mcp-server", "dist", "index.js");
  }
}

export function hostConfigurationSpec(client: HostClient, projectRoot: string): HostConfigurationSpec {
  return {
    client,
    projectRoot,
    agentflowMcpEntryPoint: resolveAgentFlowMcpEntryPoint(projectRoot)
  };
}

export function durableAgentFlowMcpEntryPoint(projectRoot: string): string {
  return resolve(projectRoot, ".agentflow", "runtime", "bin", "agentflow-mcp.mjs");
}

function durableHostConfigurationSpec(
  client: HostClient,
  projectRoot: string
): HostConfigurationSpec {
  return {
    client,
    projectRoot,
    agentflowMcpEntryPoint: durableAgentFlowMcpEntryPoint(projectRoot)
  };
}

export function normalizeHostCapabilities(values: string[]): { available: string[]; ignored: string[] } {
  const available = new Set<string>();
  const ignored = new Set<string>();
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (value.length === 0) continue;
    if (
      value.startsWith("figma.remote.")
      || value.startsWith("figma.tool.")
      || value.startsWith("host.worker.")
      || value.startsWith("skill.")
    ) {
      available.add(value);
      continue;
    }
    if (value === "figma-use") {
      available.add("skill.figma-use");
      continue;
    }
    const match = /^(?:mcp__figma__|figma[.:/])([a-z0-9_]+)$/i.exec(value);
    const toolName = match?.[1]?.toLowerCase();
    if (toolName && FIGMA_TOOL_NAMES.has(toolName)) {
      available.add(`figma.tool.${toolName}`);
      continue;
    }
    ignored.add(value);
  }
  return { available: [...available].sort(), ignored: [...ignored].sort() };
}

async function inspectProject(paths: ProjectPaths): Promise<ProjectInspection> {
  const checks: DoctorCheck[] = [];
  if (!await pathExists(paths.projectRoot)) {
    checks.push(check("project", "blocked", `${paths.projectRoot} is missing`));
    return { status: "invalid", checks };
  }
  checks.push(check("project", "ok", paths.projectRoot));

  let agentflowStats;
  try {
    agentflowStats = await lstat(paths.agentflowDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push(check(
        "agentflow-directory",
        "warn",
        `${paths.agentflowDirectory} is not initialized`,
        "The first project-changing request initializes AgentFlow automatically."
      ));
      return { status: "not-initialized", checks };
    }
    checks.push(check(
      "agentflow-directory",
      "blocked",
      `Cannot inspect ${paths.agentflowDirectory}: ${error instanceof Error ? error.message : String(error)}`
    ));
    return { status: "invalid", checks };
  }
  if (!agentflowStats.isDirectory()) {
    checks.push(check(
      "agentflow-directory",
      "blocked",
      `${paths.agentflowDirectory} must be a directory`
    ));
    return { status: "invalid", checks };
  }
  checks.push(check("agentflow-directory", "ok", paths.agentflowDirectory));

  try {
    const parsed = parseYaml(await readFile(paths.configPath, "utf8")) as unknown;
    const valid = isRecord(parsed)
      && parsed.version === 1
      && parsed.pipeline === "pipeline.yaml"
      && parsed.runsDirectory === "runs";
    checks.push(check(
      "agentflow-config",
      valid ? "ok" : "blocked",
      valid ? `${paths.configPath} parsed` : `${paths.configPath} has an invalid schema`,
      valid ? undefined : "Repair config.yaml or reinitialize an empty project."
    ));
  } catch (error) {
    checks.push(check(
      "agentflow-config",
      "blocked",
      `Cannot parse ${paths.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "Repair config.yaml or reinitialize an empty project."
    ));
  }

  let pipeline: PipelineDefinition | undefined;
  try {
    pipeline = validatePipeline(parseYaml(await readFile(paths.pipelinePath, "utf8")));
    checks.push(check("pipeline", "ok", `${pipeline.id}@${pipeline.version} parsed`));
  } catch (error) {
    checks.push(check(
      "pipeline",
      "blocked",
      `Cannot parse ${paths.pipelinePath}: ${error instanceof Error ? error.message : String(error)}`,
      "Repair pipeline.yaml before resuming AgentFlow."
    ));
  }

  try {
    const parsed = JSON.parse(await readFile(paths.currentRunPath, "utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.runId !== "string" || parsed.runId.length === 0) {
      throw new Error("runId must be a non-empty string");
    }
    const state = await (await createEngine(paths)).loadRun(parsed.runId);
    checks.push(check("current-run", "ok", `${state.id}@${state.revision}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push(check(
        "current-run",
        "warn",
        `${paths.currentRunPath} does not exist; no Run has started yet`
      ));
    } else {
      checks.push(check(
        "current-run",
        "blocked",
        `Cannot load ${paths.currentRunPath}: ${error instanceof Error ? error.message : String(error)}`,
        "Repair the current Run pointer without deleting existing Run history."
      ));
    }
  }

  return {
    status: checks.some((item) => item.status === "blocked") ? "invalid" : "initialized",
    checks,
    ...(pipeline === undefined ? {} : { pipeline })
  };
}

async function inspectSkillLock(lockPath: string, checks: DoctorCheck[]): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
      dependencies?: Array<{ id?: unknown; commit?: unknown; skills?: Array<{ name?: unknown }> }>;
    };
    const figma = parsed.dependencies?.find((dependency) => dependency.id === "figma-mcp-server-guide");
    const pinned = typeof figma?.commit === "string" && figma.commit.length === 40;
    const hasUseSkill = figma?.skills?.some((skill) => skill.name === "figma-use") === true;
    checks.push(check(
      "figma-skill-lock",
      pinned && hasUseSkill ? "ok" : "warn",
      pinned && hasUseSkill
        ? `figma-use is pinned in ${lockPath}`
        : `${lockPath} does not pin the figma-use skill`,
      pinned && hasUseSkill
        ? undefined
        : "Pin and review the official Figma MCP Server Guide before S04."
    ));
  } catch (error) {
    checks.push(check(
      "figma-skill-lock",
      "warn",
      `Cannot inspect ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      "Install a reviewed skills-lock.json before using external Figma Skills."
    ));
  }
}

async function inspectHostConfig(
  plan: HostConfigurationPlan,
  spec: HostConfigurationSpec,
  checks: DoctorCheck[]
): Promise<boolean> {
  let configuration: unknown;
  try {
    configuration = await readFile(plan.targetPath, "utf8");
  } catch (error) {
    checks.push(check(
      "host-config",
      "needs_user",
      `Cannot read ${plan.targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      `Run agentflow setup --host ${spec.client}, review the merged file, then complete OAuth.`
    ));
    return false;
  }

  const inspection = inspectHostConfiguration(spec, configuration);
  for (const item of inspection.checks) {
    checks.push(check(
      `host-config.${item.id}`,
      item.ok ? "ok" : "blocked",
      item.detail,
      item.ok
        ? undefined
        : `Repair ${plan.targetPath}, then rerun agentflow setup --host ${spec.client}.`
    ));
  }
  return inspection.ok;
}

async function inspectTextSurface(
  checks: DoctorCheck[],
  id: string,
  path: string,
  valid: (content: string) => boolean,
  remediation: string
): Promise<void> {
  try {
    const stats = await lstat(path);
    const content = stats.isFile() ? await readFile(path, "utf8") : "";
    const ok = stats.isFile() && valid(content);
    checks.push(check(
      id,
      ok ? "ok" : "blocked",
      ok ? `${path} is installed` : `${path} is missing required AgentFlow content`,
      ok ? undefined : remediation
    ));
  } catch (error) {
    checks.push(check(
      id,
      "blocked",
      `Cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
      remediation
    ));
  }
}

async function inspectProjectInstallation(
  paths: ProjectPaths,
  host: HostClient | undefined,
  checks: DoctorCheck[]
): Promise<void> {
  const runtimePath = durableAgentFlowMcpEntryPoint(paths.projectRoot);
  await inspectTextSurface(
    checks,
    "durable-mcp-runtime",
    runtimePath,
    (content) => content.length > 0,
    "Run agentflow setup --scope project for the current host."
  );
  await inspectTextSurface(
    checks,
    "auto-router-skill",
    resolve(paths.projectRoot, ".agents", "skills", "agentflow-auto-router", "SKILL.md"),
    (content) => /name:\s*agentflow-auto-router\b/.test(content),
    "Run agentflow setup --scope project to install the agentflow-auto-router Skill."
  );

  const agentsPath = resolve(paths.projectRoot, "AGENTS.md");
  await inspectTextSurface(
    checks,
    "auto-router-agents",
    agentsPath,
    (content) => content.includes("agentflow:auto-router:start"),
    "Run agentflow setup --scope project to install the managed AGENTS.md routing block."
  );

  if (host) {
    const instruction = (() => {
      switch (host) {
        case "codex":
          return {
            path: agentsPath,
            valid: (content: string) => content.includes("agentflow:auto-router:start")
          };
        case "cursor":
          return {
            path: resolve(paths.projectRoot, ".cursor", "rules", "agentflow.mdc"),
            valid: (content: string) => /alwaysApply:\s*true/.test(content)
              && content.includes("agentflow-auto-router")
          };
        case "vscode":
          return {
            path: resolve(paths.projectRoot, ".github", "copilot-instructions.md"),
            valid: (content: string) => content.includes("agentflow:auto-router:start")
          };
      }
    })();
    await inspectTextSurface(
      checks,
      `auto-router-instruction.${host}`,
      instruction.path,
      instruction.valid,
      `Run agentflow setup --scope project --host ${host}.`
    );
  }

  await inspectSkillLock(resolve(paths.projectRoot, "skills-lock.json"), checks);
  if (host) {
    const spec = durableHostConfigurationSpec(host, paths.projectRoot);
    const plan = planHostConfiguration(spec);
    if (await inspectHostConfig(plan, spec, checks)) {
      checks.push(check(
        "host-restart-auth",
        "warn",
        "Static setup is healthy; host restart and Figma OAuth require a live host check",
        plan.authentication.instructions
      ));
    }
  }
}

function globalHostTarget(paths: GlobalInstallationPaths, host: HostClient): string {
  switch (host) {
    case "codex": return paths.codexConfig;
    case "cursor": return paths.cursorConfig;
    case "vscode": return paths.vscodeConfig;
  }
}

function globalHostPlan(
  spec: HostConfigurationSpec,
  targetPath: string
): HostConfigurationPlan {
  const authentication = planHostConfiguration({
    ...spec,
    projectRoot: dirname(targetPath)
  }).authentication;
  return {
    client: spec.client,
    targetPath,
    content: "",
    authentication
  };
}

async function inspectGlobalInstallation(
  paths: GlobalInstallationPaths,
  host: HostClient | undefined,
  checks: DoctorCheck[]
): Promise<void> {
  await inspectTextSurface(
    checks,
    "global-cli-runtime",
    paths.runtimeCli,
    (content) => content.length > 0,
    "Run global agentflow setup again to restore the CLI runtime."
  );
  await inspectTextSurface(
    checks,
    "global-mcp-runtime",
    paths.runtimeMcp,
    (content) => content.length > 0,
    "Run global agentflow setup again to restore the MCP runtime."
  );
  await inspectTextSurface(
    checks,
    "auto-router-skill",
    resolve(paths.skillsRoot, "agentflow-auto-router", "SKILL.md"),
    (content) => /name:\s*agentflow-auto-router\b/.test(content),
    "Run global agentflow setup again to restore the routing Skill."
  );
  await inspectTextSurface(
    checks,
    "global-install-manifest",
    paths.installManifest,
    (content) => {
      try {
        const manifest = JSON.parse(content) as unknown;
        return isRecord(manifest)
          && typeof manifest.version === "string"
          && isRecord(manifest.runtime)
          && manifest.runtime.cli === paths.runtimeCli
          && manifest.runtime.mcp === paths.runtimeMcp;
      } catch {
        return false;
      }
    },
    "Run global agentflow setup again to restore install metadata."
  );
  await inspectSkillLock(paths.skillsLock, checks);

  if (host) {
    const spec: HostConfigurationSpec = {
      client: host,
      agentflowMcpEntryPoint: paths.runtimeMcp
    };
    const plan = globalHostPlan(spec, globalHostTarget(paths, host));
    if (await inspectHostConfig(plan, spec, checks)) {
      checks.push(check(
        "host-restart-auth",
        "warn",
        "Static setup is healthy; host restart and Figma OAuth require a live host check",
        plan.authentication.instructions
      ));
    }
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const scope = options.scope ?? "project";
  const installationChecks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node, 10);
  installationChecks.push(check(
    "node",
    nodeMajor >= 20 ? "ok" : "blocked",
    `Node ${process.versions.node}`,
    nodeMajor >= 20 ? undefined : "Install Node.js 20 or newer."
  ));
  await inspectGit(installationChecks, options.gitRunner ?? nativeGitRunner);

  if (scope === "global") {
    const globalPaths = globalInstallationPaths(
      options.globalPathEnvironment ?? processGlobalPathEnvironment(),
      options.vscodeConfig === undefined ? {} : { vscodeConfig: options.vscodeConfig }
    );
    await inspectGlobalInstallation(globalPaths, options.host, installationChecks);
  } else {
    await inspectProjectInstallation(options.paths, options.host, installationChecks);
  }

  const project = await inspectProject(options.paths);
  let required: string[] = [];
  if (options.stageId) {
    if (project.pipeline === undefined) {
      installationChecks.push(check(
        "stage-capability-contract",
        "blocked",
        `Cannot inspect ${options.stageId} until the project pipeline is valid`
      ));
    } else {
      try {
        required = stageById(project.pipeline, options.stageId).requiredCapabilities;
        installationChecks.push(check(
          "stage-capability-contract",
          required.length > 0 ? "ok" : "warn",
          required.length > 0
            ? `${options.stageId} requires ${required.length} live capabilities`
            : `${options.stageId} has no live capability requirements`
        ));
      } catch (error) {
        installationChecks.push(check(
          "stage-capability-contract",
          "blocked",
          error instanceof Error ? error.message : String(error)
        ));
      }
    }
  }

  const normalized = normalizeHostCapabilities(options.capabilities ?? []);
  const liveProbeProvided = options.liveProbeProvided === true || options.capabilities !== undefined;
  const missing = required.filter((capability) => !normalized.available.includes(capability));
  if (required.length > 0) {
    if (!options.host) {
      installationChecks.push(check(
        "live-capability-host",
        "blocked",
        "A host must be named for a live stage capability probe",
        "Pass --host codex, --host cursor, or --host vscode."
      ));
    }
    if (!liveProbeProvided) {
      installationChecks.push(check(
        "live-capability-probe",
        "blocked",
        "No live host capability snapshot was supplied",
        "Probe the current host registry and Figma whoami, then rerun doctor with --live-probe and canonical --capability values."
      ));
    } else if (missing.length > 0) {
      installationChecks.push(check(
        "live-capability-probe",
        "blocked",
        `Missing live capabilities: ${missing.join(", ")}`,
        "Configure and authenticate Figma in the current host, then probe again."
      ));
    } else {
      installationChecks.push(check(
        "live-capability-probe",
        "ok",
        `All ${required.length} required capabilities were observed live`
      ));
    }
  }
  if (normalized.ignored.length > 0) {
    installationChecks.push(check(
      "capability-identifiers",
      "warn",
      `Ignored non-canonical or untrusted capability names: ${normalized.ignored.join(", ")}`
    ));
  }

  const installationStatus = reportStatus(installationChecks);
  const projectCheckStatus = reportStatus(project.checks);
  const status: DoctorOverallStatus = installationStatus === "blocked" || project.status === "invalid"
    ? "blocked"
    : installationStatus === "warn"
      || project.status === "not-initialized"
      || projectCheckStatus === "warn"
      ? "warn"
      : "ok";
  const checks = [...installationChecks, ...project.checks];

  return {
    ok: status !== "blocked",
    status,
    scope,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.stageId === undefined ? {} : { stageId: options.stageId }),
    installation: { status: installationStatus, checks: installationChecks },
    project: { status: project.status, checks: project.checks },
    checks,
    capabilities: {
      liveProbeProvided,
      required,
      available: normalized.available,
      missing,
      ignored: normalized.ignored
    }
  };
}
