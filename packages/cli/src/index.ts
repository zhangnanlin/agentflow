#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  AgentFlowError,
  sha256,
  type Actor,
  type RunState,
  type VerificationRecord
} from "@agentflow/core";
import {
  createEngine,
  initializeProject,
  mutationContext,
  parseJsonRecord,
  printJson,
  projectPaths,
  readCurrentRun,
  resolveRunId,
  writeCurrentRun
} from "./runtime.js";
import { hostConfigurationSpec, runDoctor } from "./doctor.js";
import { planHostConfiguration, type HostClient } from "./host-config.js";
import { resolveDistributionAssets } from "./distribution.js";
import { executeSetup } from "./setup.js";

const program = new Command()
  .name("agentflow")
  .description("Coordinate staged multi-thread agent development workflows")
  .version("0.2.0")
  .option("--project-root <path>", "project root", process.cwd());

function paths() {
  return projectPaths(resolve(program.opts<{ projectRoot: string }>().projectRoot));
}

function actor(kind: Actor["kind"], id?: string): Actor {
  return { kind, id: id ?? `${kind}-cli` };
}

function parseInteger(value: string, minimum: number, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new InvalidArgumentError(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function mutationOptions(command: Command): { revision?: number; idempotencyKey?: string } {
  return command.optsWithGlobals<{ revision?: number; idempotencyKey?: string }>();
}

function addMutationOptions(command: Command): Command {
  return command
    .option("--revision <number>", "expected state revision", (value) => parseInteger(value, 0, "revision"))
    .option("--idempotency-key <key>", "stable retry key");
}

function parseSetupHost(value: string): HostClient | "all" {
  if (!["codex", "cursor", "vscode", "all"].includes(value)) {
    throw new InvalidArgumentError("host must be codex, cursor, vscode, or all");
  }
  return value as HostClient | "all";
}

program.command("setup")
  .description("install AgentFlow runtime, Skills, routing, and host configuration")
  .requiredOption("--host <host>", "editor host", parseSetupHost)
  .option("--dry-run", "validate and report the setup plan without writing")
  .option("--skip-external-skills", "do not install pinned external Skills")
  .option("--start <requirement>", "start the first Run after setup succeeds")
  .addOption(new Option("--project-type <type>").choices(["new", "existing"]))
  .option("--no-ui", "mark the started project as having no UI")
  .action(async (options: {
    host: HostClient | "all";
    dryRun?: boolean;
    skipExternalSkills?: boolean;
    start?: string;
    projectType?: "new" | "existing";
    ui: boolean;
  }) => {
    if (options.start === undefined && (options.ui === false || options.projectType !== undefined)) {
      throw new AgentFlowError(
        "--no-ui and --project-type require --start",
        "SETUP_OPTION_REQUIRES_START"
      );
    }
    if (options.dryRun && options.start !== undefined) {
      throw new AgentFlowError(
        "--dry-run cannot be combined with --start",
        "SETUP_DRY_RUN_START_CONFLICT"
      );
    }

    const setup = await executeSetup({
      projectRoot: paths().projectRoot,
      hosts: [options.host],
      assets: await resolveDistributionAssets(),
      dryRun: options.dryRun === true,
      skipExternalSkills: options.skipExternalSkills === true
    });

    if (options.start === undefined) {
      printJson(setup);
      return;
    }

    await initializeProject(paths());
    const engine = await createEngine(paths());
    let state: RunState | undefined;
    let currentRunId: string | undefined;
    try {
      currentRunId = await readCurrentRun(paths());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentRunId !== undefined) {
      const current = await engine.loadRun(currentRunId);
      if (current.activeStageId !== null) state = current;
    }
    if (state === undefined) {
      state = await engine.createRun({
        requirement: options.start,
        projectType: options.projectType ?? "new",
        hasUi: options.ui
      });
      await writeCurrentRun(state.id, paths());
    }
    printJson({
      ...setup,
      run: {
        id: state.id,
        requirement: state.requirement,
        activeStageId: state.activeStageId,
        revision: state.revision
      }
    });
  });

program.command("init")
  .description("initialize AgentFlow files in the project")
  .action(async () => {
    await initializeProject(paths());
    printJson({ initialized: true, directory: paths().agentflowDirectory });
  });

program.command("doctor")
  .description("check local AgentFlow prerequisites")
  .addOption(new Option("--host <host>", "current editor host").choices(["codex", "cursor", "vscode"]))
  .option("--stage <stage-id>", "check the live capability contract for one stage")
  .option("--capability <ids...>", "canonical capabilities observed in the current host")
  .option("--live-probe", "declare that the current host registry was probed, even when it exposed no capabilities")
  .action(async (options: {
    host?: HostClient;
    stage?: string;
    capability?: string[];
    liveProbe?: boolean;
  }) => {
    const report = await runDoctor({
      paths: paths(),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.stage === undefined ? {} : { stageId: options.stage }),
      ...(options.capability === undefined ? {} : { capabilities: options.capability }),
      liveProbeProvided: options.liveProbe === true
    });
    printJson(report);
    if (!report.ok) process.exitCode = 1;
  });

program.command("configure")
  .description("generate a project-scoped AgentFlow and Figma MCP configuration")
  .requiredOption("--host <host>", "editor host", (value) => {
    if (!["codex", "cursor", "vscode"].includes(value)) {
      throw new InvalidArgumentError("host must be codex, cursor, or vscode");
    }
    return value as HostClient;
  })
  .option("--write", "create the host configuration when the target does not already exist")
  .action(async (options: { host: HostClient; write?: boolean }) => {
    const plan = planHostConfiguration(hostConfigurationSpec(options.host, paths().projectRoot));
    let written = false;
    let alreadyPresent = false;
    if (options.write) {
      await mkdir(dirname(plan.targetPath), { recursive: true });
      try {
        await writeFile(plan.targetPath, plan.content, { encoding: "utf8", flag: "wx" });
        written = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(plan.targetPath, "utf8");
        if (existing !== plan.content) {
          throw new AgentFlowError(
            `Host configuration already exists: ${plan.targetPath}`,
            "HOST_CONFIG_EXISTS",
            {
              targetPath: plan.targetPath,
              remediation: "Run agentflow doctor for a structured inspection and merge the generated server entries without overwriting unrelated settings."
            }
          );
        }
        alreadyPresent = true;
      }
    }
    printJson({ ...plan, written, alreadyPresent });
  });

program.command("start")
  .description("start a new pipeline run")
  .argument("<requirement>")
  .option("--id <run-id>")
  .addOption(new Option("--project-type <type>").choices(["new", "existing"]).default("new"))
  .option("--no-ui", "mark the project as having no UI")
  .action(async (requirement: string, options: { id?: string; projectType: "new" | "existing"; ui: boolean }) => {
    await initializeProject(paths());
    const engine = await createEngine(paths());
    const state = await engine.createRun({
      ...(options.id === undefined ? {} : { id: options.id }),
      requirement,
      projectType: options.projectType,
      hasUi: options.ui
    });
    await writeCurrentRun(state.id, paths());
    printJson(state);
  });

program.command("status")
  .description("show a run, defaulting to the current run")
  .argument("[run-id]")
  .action(async (runId?: string) => {
    const engine = await createEngine(paths());
    printJson(await engine.loadRun(await resolveRunId(runId, paths())));
  });

const task = program.command("task").description("manage tasks");

addMutationOptions(task.command("create")
  .argument("<task-id>")
  .requiredOption("--stage <stage-id>")
  .requiredOption("--title <title>")
  .option("--description <description>", "", "")
  .option("--depends-on <ids...>", "task dependencies", [])
  .option("--write-scope <scopes...>", "allowed write scopes", [])
  .option("--forbidden-scope <scopes...>", "forbidden scopes", []))
  .action(async (taskId: string, options: {
    stage: string; title: string; description: string; dependsOn: string[]; writeScope: string[]; forbiddenScope: string[];
    runId?: string; revision?: string; idempotencyKey?: string;
  }, command: Command) => {
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    printJson(await engine.createTask(runId, {
      id: taskId,
      stageId: options.stage,
      title: options.title,
      description: options.description,
      dependsOn: options.dependsOn,
      writeScopes: options.writeScope,
      forbiddenScopes: options.forbiddenScope
    }, mutationContext(state, actor("supervisor"), mutationOptions(command))));
  });

addMutationOptions(task.command("claim")
  .argument("<task-id>")
  .requiredOption("--worker <worker-id>")
  .option("--lease-seconds <seconds>", "lease duration", (value) => parseInteger(value, 1, "lease seconds"), 900))
  .action(async (taskId: string, options: { worker: string; leaseSeconds: number }, command: Command) => {
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    printJson(await engine.claimTask(runId, taskId, options.worker, options.leaseSeconds, mutationContext(state, actor("worker", options.worker), mutationOptions(command))));
  });

addMutationOptions(task.command("heartbeat")
  .argument("<task-id>")
  .requiredOption("--worker <worker-id>")
  .option("--lease-seconds <seconds>", "renewed lease duration", (value) => parseInteger(value, 1, "lease seconds"), 900))
  .action(async (taskId: string, options: { worker: string; leaseSeconds: number }, command: Command) => {
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    printJson(await engine.heartbeatTask(runId, taskId, options.worker, options.leaseSeconds, mutationContext(state, actor("worker", options.worker), mutationOptions(command))));
  });

addMutationOptions(task.command("complete")
  .argument("<task-id>")
  .requiredOption("--worker <worker-id>")
  .requiredOption("--verification-command <command>")
  .option("--verification-summary <summary>", "", "passed")
  .option("--result <json>", "result JSON object", "{}"))
  .action(async (taskId: string, options: { worker: string; verificationCommand: string; verificationSummary: string; result: string }, command: Command) => {
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    const verification: VerificationRecord[] = [{
      command: options.verificationCommand,
      status: "passed",
      summary: options.verificationSummary,
      recordedAt: new Date().toISOString()
    }];
    printJson(await engine.completeTask(runId, taskId, options.worker, verification, parseJsonRecord(options.result), mutationContext(state, actor("worker", options.worker), mutationOptions(command))));
  });

addMutationOptions(program.command("artifact")
  .description("register or replace an artifact")
  .argument("<artifact-id>")
  .requiredOption("--stage <stage-id>")
  .requiredOption("--kind <kind>")
  .requiredOption("--uri <uri>")
  .option("--content <text>", "content to hash")
  .option("--sha256 <hash>", "precomputed sha256")
  .option("--producer <id>", "producer actor", "worker-cli")
  .option("--metadata <json>", "metadata JSON object", "{}"))
  .action(async (artifactId: string, options: { stage: string; kind: string; uri: string; content?: string; sha256?: string; producer: string; metadata: string }, command: Command) => {
    if (!options.sha256 && options.content === undefined) throw new Error("Provide --sha256 or --content");
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    printJson(await engine.registerArtifact(runId, {
      id: artifactId,
      stageId: options.stage,
      kind: options.kind,
      uri: options.uri,
      sha256: options.sha256 ?? sha256(options.content ?? ""),
      producedBy: options.producer,
      metadata: parseJsonRecord(options.metadata)
    }, mutationContext(state, actor("worker", options.producer), mutationOptions(command))));
  });

const gate = program.command("gate").description("resolve gates");
for (const decision of ["approve", "reject"] as const) {
  addMutationOptions(gate.command(decision)
    .argument("<gate-id>")
    .option("--resolution <text>", "decision notes", decision)
    .option("--choice <option>", "selected gate option")
    .option("--user <user-id>", "user actor id", "user-cli"))
    .action(async (gateId: string, options: { resolution: string; choice?: string; user: string }, command: Command) => {
      const engine = await createEngine(paths());
      const runId = await readCurrentRun(paths());
      const state = await engine.loadRun(runId);
      printJson(await engine.resolveGate(runId, {
        gateId,
        decision: decision === "approve" ? "approved" : "rejected",
        resolution: options.resolution,
        ...(options.choice === undefined ? {} : { choice: options.choice })
      }, mutationContext(state, actor("user", options.user), mutationOptions(command))));
    });
}

const stage = program.command("stage").description("manage the active stage");
addMutationOptions(stage.command("complete").argument("[stage-id]"))
  .action(async (stageId: string | undefined, _options: unknown, command: Command) => {
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    const resolvedStage = stageId ?? state.activeStageId;
    if (!resolvedStage) throw new Error("Run has no active stage");
    printJson(await engine.completeStage(runId, resolvedStage, mutationContext(state, actor("supervisor"), mutationOptions(command))));
  });

addMutationOptions(stage.command("skip").argument("[stage-id]").requiredOption("--reason <text>"))
  .action(async (stageId: string | undefined, options: { reason: string }, command: Command) => {
    const engine = await createEngine(paths());
    const runId = await readCurrentRun(paths());
    const state = await engine.loadRun(runId);
    const resolvedStage = stageId ?? state.activeStageId;
    if (!resolvedStage) throw new Error("Run has no active stage");
    printJson(await engine.skipStage(runId, resolvedStage, options.reason, mutationContext(state, actor("supervisor"), mutationOptions(command))));
  });

program.configureOutput({ outputError: (message, write) => write(message) });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof AgentFlowError) {
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message, details: error.details })}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({ error: "UNEXPECTED", message: error instanceof Error ? error.message : String(error), traceId: randomUUID() })}\n`);
  }
  process.exitCode = 1;
}
