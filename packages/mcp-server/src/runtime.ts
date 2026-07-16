import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AgentFlowEngine,
  AgentFlowError,
  JsonRunStore,
  defaultPipeline,
  validatePipeline,
  type Actor,
  type MutationContext,
  type PipelineDefinition,
  type RunState
} from "@agentflow/core";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export interface ProjectPaths {
  projectRoot: string;
  agentflowDirectory: string;
  runsDirectory: string;
  currentRunPath: string;
  pipelinePath: string;
  configPath: string;
  ignorePath: string;
  startLockPath: string;
  startPendingPath: string;
  startRequestsDirectory: string;
}

export interface MutationArguments {
  runId: string;
  expectedRevision: number;
  idempotencyKey: string;
  actorId: string;
  reason: string;
}

export interface MutationTarget {
  engine: AgentFlowEngine;
  runId: string;
  state: RunState;
  context: MutationContext;
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
    configPath: resolve(agentflowDirectory, "config.yaml"),
    ignorePath: resolve(agentflowDirectory, ".gitignore"),
    startLockPath: resolve(agentflowDirectory, ".start.lock"),
    startPendingPath: resolve(agentflowDirectory, ".start.pending.json"),
    startRequestsDirectory: resolve(agentflowDirectory, "start-requests")
  };
}

export async function loadPipeline(paths: ProjectPaths): Promise<PipelineDefinition> {
  try {
    return validatePipeline(parseYaml(await readFile(paths.pipelinePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPipeline;
    throw error;
  }
}

export async function createEngine(paths: ProjectPaths): Promise<AgentFlowEngine> {
  return new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), await loadPipeline(paths));
}

export async function readCurrentRun(paths: ProjectPaths): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(paths.currentRunPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentFlowError(
        "No current AgentFlow run is selected",
        "CURRENT_RUN_NOT_FOUND",
        { path: paths.currentRunPath }
      );
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as { runId?: unknown };
    if (typeof parsed.runId !== "string") throw new Error("runId must be a string");
    return validateRunId(parsed.runId);
  } catch (error) {
    if (error instanceof AgentFlowError) throw error;
    throw new AgentFlowError(
      "The current AgentFlow run selection is invalid",
      "CURRENT_RUN_INVALID",
      { path: paths.currentRunPath }
    );
  }
}

export async function resolveRunId(runId: string | undefined, paths: ProjectPaths): Promise<string> {
  return validateRunId(runId ?? await readCurrentRun(paths));
}

export async function mutationTarget(
  paths: ProjectPaths,
  input: MutationArguments,
  defaultActor: Actor
): Promise<MutationTarget> {
  const engine = await createEngine(paths);
  const runId = await resolveRunId(input.runId, paths);
  const state = await engine.loadRun(runId);
  return {
    engine,
    runId,
    state,
    context: {
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      actor: {
        id: input.actorId,
        kind: defaultActor.kind
      },
      reason: input.reason
    }
  };
}

function validateRunId(runId: string): string {
  if (runId.length === 0 || runId.length > 160 || !RUN_ID_PATTERN.test(runId)) {
    throw new AgentFlowError("Invalid AgentFlow run ID", "RUN_ID_INVALID", { runId });
  }
  return runId;
}
