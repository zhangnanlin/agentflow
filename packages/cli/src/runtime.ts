import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AgentFlowError,
  AgentFlowEngine,
  JsonRunStore,
  defaultPipeline,
  validatePipeline,
  type Actor,
  type MutationContext,
  type PipelineDefinition,
  type RunState
} from "@agentflow/core";

export interface ProjectPaths {
  projectRoot: string;
  agentflowDirectory: string;
  runsDirectory: string;
  currentRunPath: string;
  pipelinePath: string;
  configPath: string;
}

export function projectPaths(projectRoot = process.cwd()): ProjectPaths {
  const root = resolve(projectRoot);
  const agentflowDirectory = resolve(root, ".agentflow");
  return {
    projectRoot: root,
    agentflowDirectory,
    runsDirectory: resolve(agentflowDirectory, "runs"),
    currentRunPath: resolve(agentflowDirectory, "current-run.json"),
    pipelinePath: resolve(agentflowDirectory, "pipeline.yaml"),
    configPath: resolve(agentflowDirectory, "config.yaml")
  };
}

export async function initializeProject(paths = projectPaths()): Promise<void> {
  await mkdir(paths.runsDirectory, { recursive: true });
  await writeFile(paths.pipelinePath, stringifyYaml(defaultPipeline), { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await writeFile(paths.configPath, stringifyYaml({
    version: 1,
    pipeline: "pipeline.yaml",
    runsDirectory: "runs"
  }), { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

export async function loadPipeline(paths = projectPaths()): Promise<PipelineDefinition> {
  try {
    return validatePipeline(parseYaml(await readFile(paths.pipelinePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPipeline;
    throw error;
  }
}

export async function createEngine(paths = projectPaths()): Promise<AgentFlowEngine> {
  return new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), await loadPipeline(paths));
}

export async function writeCurrentRun(runId: string, paths = projectPaths()): Promise<void> {
  await mkdir(paths.agentflowDirectory, { recursive: true });
  await writeFile(paths.currentRunPath, `${JSON.stringify({ runId }, null, 2)}\n`, "utf8");
}

export async function readCurrentRun(paths = projectPaths()): Promise<string> {
  const parsed = JSON.parse(await readFile(paths.currentRunPath, "utf8")) as { runId?: unknown };
  if (typeof parsed.runId !== "string" || parsed.runId.length === 0) {
    throw new Error(`Invalid current run file: ${paths.currentRunPath}`);
  }
  return parsed.runId;
}

export async function resolveRunId(value: string | undefined, paths = projectPaths()): Promise<string> {
  return value ?? readCurrentRun(paths);
}

export function mutationContext(
  state: RunState,
  actor: Actor,
  options: { revision?: number; idempotencyKey?: string }
): MutationContext {
  return {
    expectedRevision: options.revision ?? state.revision,
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    actor
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function parseJsonRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new AgentFlowError(
      "Expected valid JSON",
      "INVALID_JSON",
      { reason: error instanceof Error ? error.message : String(error) }
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentFlowError("Expected a JSON object", "INVALID_JSON_OBJECT");
  }
  return parsed as Record<string, unknown>;
}
