import { existsSync } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageById, type PipelineDefinition } from "@agentflow/core";
import { parse as parseYaml } from "yaml";
import {
  inspectHostConfiguration,
  planHostConfiguration,
  type HostClient,
  type HostConfigurationPlan,
  type HostConfigurationSpec
} from "./host-config.js";
import { loadPipeline, type ProjectPaths } from "./runtime.js";

export type DoctorCheckStatus = "ok" | "warn" | "needs_user" | "blocked";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  status: DoctorCheckStatus;
  host?: HostClient;
  stageId?: string;
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
  host?: HostClient;
  stageId?: string;
  capabilities?: string[];
  liveProbeProvided?: boolean;
}

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

function reportStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((item) => item.status === "blocked")) return "blocked";
  if (checks.some((item) => item.status === "needs_user")) return "needs_user";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "ok";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

async function inspectProjectConfiguration(paths: ProjectPaths, checks: DoctorCheck[]): Promise<void> {
  const projectExists = await pathExists(paths.projectRoot);
  checks.push(check(
    "project",
    projectExists ? "ok" : "blocked",
    projectExists ? paths.projectRoot : `${paths.projectRoot} is missing`
  ));
  const agentflowExists = await pathExists(paths.agentflowDirectory);
  checks.push(check(
    "agentflow-directory",
    agentflowExists ? "ok" : "blocked",
    agentflowExists ? paths.agentflowDirectory : `${paths.agentflowDirectory} is missing`,
    agentflowExists ? undefined : "Run agentflow init."
  ));

  try {
    const parsed = parseYaml(await readFile(paths.configPath, "utf8")) as unknown;
    const valid = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    checks.push(check(
      "agentflow-config",
      valid ? "ok" : "blocked",
      valid ? `${paths.configPath} parsed` : `${paths.configPath} must contain a YAML object`
    ));
  } catch (error) {
    checks.push(check(
      "agentflow-config",
      "blocked",
      `Cannot parse ${paths.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "Run agentflow init or repair config.yaml."
    ));
  }
}

async function inspectSkillLock(paths: ProjectPaths, checks: DoctorCheck[]): Promise<void> {
  const lockPath = resolve(paths.projectRoot, "skills-lock.json");
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
      pinned && hasUseSkill ? undefined : "Pin and review the official Figma MCP Server Guide before S04."
    ));
  } catch (error) {
    checks.push(check(
      "figma-skill-lock",
      "warn",
      `Cannot inspect ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      "Add a reviewed skills-lock.json before using external Figma Skills."
    ));
  }
}

async function inspectHostConfig(
  plan: HostConfigurationPlan,
  spec: HostConfigurationSpec,
  checks: DoctorCheck[]
): Promise<void> {
  let configuration: unknown;
  try {
    const content = await readFile(plan.targetPath, "utf8");
    configuration = content;
  } catch (error) {
    checks.push(check(
      "host-config",
      "needs_user",
      `Cannot read ${plan.targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      `Run agentflow configure --host ${spec.client} --write, review the file, then complete OAuth.`
    ));
    return;
  }

  const inspection = inspectHostConfiguration(spec, configuration);
  for (const item of inspection.checks) {
    checks.push(check(
      `host-config.${item.id}`,
      item.ok ? "ok" : "blocked",
      item.detail,
      item.ok ? undefined : `Repair ${plan.targetPath}, then rerun agentflow setup --host ${spec.client}.`
    ));
  }
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

async function inspectAutomaticRouting(
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
    "Run agentflow setup for the current host to install the durable MCP runtime."
  );
  await inspectTextSurface(
    checks,
    "auto-router-skill",
    resolve(paths.projectRoot, ".agents", "skills", "agentflow-auto-router", "SKILL.md"),
    (content) => /name:\s*agentflow-auto-router\b/.test(content),
    "Run agentflow setup to install the agentflow-auto-router Skill."
  );

  const agentsPath = resolve(paths.projectRoot, "AGENTS.md");
  await inspectTextSurface(
    checks,
    "auto-router-agents",
    agentsPath,
    (content) => content.includes("agentflow:auto-router:start"),
    "Run agentflow setup to install the managed AGENTS.md routing block."
  );

  if (!host) return;
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
    `Run agentflow setup --host ${host} to install the host instruction surface.`
  );
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node, 10);
  checks.push(check(
    "node",
    nodeMajor >= 20 ? "ok" : "blocked",
    `Node ${process.versions.node}`,
    nodeMajor >= 20 ? undefined : "Install Node.js 20 or newer."
  ));
  await inspectProjectConfiguration(options.paths, checks);
  await inspectAutomaticRouting(options.paths, options.host, checks);

  let pipeline: PipelineDefinition | undefined;
  try {
    pipeline = await loadPipeline(options.paths);
    checks.push(check("pipeline", "ok", `${pipeline.id}@${pipeline.version} parsed`));
  } catch (error) {
    checks.push(check(
      "pipeline",
      "blocked",
      `Cannot parse ${options.paths.pipelinePath}: ${error instanceof Error ? error.message : String(error)}`
    ));
  }

  await inspectSkillLock(options.paths, checks);

  if (options.host) {
    const spec = durableHostConfigurationSpec(options.host, options.paths.projectRoot);
    await inspectHostConfig(planHostConfiguration(spec), spec, checks);
    if (!checks.some((item) => item.status === "blocked" || item.status === "needs_user")) {
      checks.push(check(
        "host-restart-auth",
        "warn",
        "Static setup is healthy; host restart and Figma OAuth cannot be verified from project files",
        planHostConfiguration(spec).authentication.instructions
      ));
    }
  }

  let required: string[] = [];
  if (options.stageId && pipeline) {
    try {
      required = stageById(pipeline, options.stageId).requiredCapabilities;
      checks.push(check(
        "stage-capability-contract",
        required.length > 0 ? "ok" : "warn",
        required.length > 0
          ? `${options.stageId} requires ${required.length} live capabilities`
          : `${options.stageId} has no live capability requirements`
      ));
    } catch (error) {
      checks.push(check(
        "stage-capability-contract",
        "blocked",
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  const normalized = normalizeHostCapabilities(options.capabilities ?? []);
  const liveProbeProvided = options.liveProbeProvided === true || options.capabilities !== undefined;
  const missing = required.filter((capability) => !normalized.available.includes(capability));
  if (required.length > 0) {
    if (!options.host) {
      checks.push(check(
        "live-capability-host",
        "blocked",
        "A host must be named for a live stage capability probe",
        "Pass --host codex, --host cursor, or --host vscode."
      ));
    }
    if (!liveProbeProvided) {
      checks.push(check(
        "live-capability-probe",
        "blocked",
        "No live host capability snapshot was supplied",
        "Probe the current host tool and Skill registry, call Figma whoami, then rerun doctor with --live-probe and canonical --capability values."
      ));
    } else if (missing.length > 0) {
      checks.push(check(
        "live-capability-probe",
        "blocked",
        `Missing live capabilities: ${missing.join(", ")}`,
        options.host
          ? planHostConfiguration(hostConfigurationSpec(options.host, options.paths.projectRoot)).authentication.instructions
          : "Configure and authenticate Figma in the current host, then probe again."
      ));
    } else {
      checks.push(check(
        "live-capability-probe",
        "ok",
        `All ${required.length} required capabilities were observed live`
      ));
    }
  }
  if (normalized.ignored.length > 0) {
    checks.push(check(
      "capability-identifiers",
      "warn",
      `Ignored non-canonical or untrusted capability names: ${normalized.ignored.join(", ")}`
    ));
  }

  const status = reportStatus(checks);
  return {
    ok: status === "ok" || status === "warn",
    status,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.stageId === undefined ? {} : { stageId: options.stageId }),
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
