import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentFlowEngine,
  JsonRunStore,
  artifactPayloadHash,
  sha256,
  validatePipeline,
  type ImplementationPlanContract,
  type RunState
} from "@agentflow/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createAgentFlowMcpServer } from "../src/api.js";
import { projectPaths } from "../src/runtime.js";

const execFileAsync = promisify(execFile);
const capabilities = {
  spawn: true,
  send: true,
  status: true,
  collect: true,
  interrupt: true,
  close: false
};

const pipeline = validatePipeline({
  id: "s11-s12-real-git",
  version: "1",
  name: "Approved plan through parallel implementation and integration",
  stages: [
    {
      id: "S10",
      name: "Engineering Plan",
      requiredArtifactKinds: ["implementation-plan"],
      requiredGate: {
        id: "engineering-plan-approved",
        type: "human",
        question: "Approve the exact implementation plan?",
        options: ["approve", "reject"]
      }
    },
    { id: "S11", name: "Implementation", dependsOn: ["S10"] },
    {
      id: "S12",
      name: "Integration",
      dependsOn: ["S11"],
      requiredArtifactKinds: ["integration-report"]
    }
  ]
});

describe("S11 to S12 real Git flow", () => {
  const directories: string[] = [];
  let client: Client | undefined;
  let server: ReturnType<typeof createAgentFlowMcpServer> | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    client = undefined;
    server = undefined;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("materializes two approved Tasks, verifies their worktrees, and enters S12 with immutable revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-s11-s12-"));
    directories.push(directory);
    const paths = projectPaths(directory);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.pipelinePath, stringifyYaml(pipeline), "utf8");
    await writeFile(paths.configPath, stringifyYaml({
      version: 1,
      pipeline: "pipeline.yaml",
      runsDirectory: "runs"
    }), "utf8");

    await runGit(directory, ["init", "--initial-branch=main"]);
    await runGit(directory, ["config", "user.name", "AgentFlow Test"]);
    await runGit(directory, ["config", "user.email", "agentflow@example.test"]);
    await writeFile(join(directory, ".gitignore"), ".agentflow/\n.worktrees/\n", "utf8");
    await writeFile(join(directory, "README.md"), "# S11 fixture\n", "utf8");
    await runGit(directory, ["add", ".gitignore", "README.md"]);
    await runGit(directory, ["commit", "-m", "test: establish approved baseline"]);
    const baseRevision = await runGit(directory, ["rev-parse", "HEAD"]);

    const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
    let state = await engine.createRun({
      id: "run-s11-s12",
      requirement: "Implement API and web outputs in parallel, then integrate them",
      projectType: "existing",
      hasUi: false
    });
    const prdHash = sha256("approved prd");
    const architectureHash = sha256("approved architecture");
    state = await engine.registerArtifact(state.id, {
      id: "prd-1",
      stageId: "S10",
      kind: "prd",
      uri: ".agentflow/artifacts/prd.json",
      sha256: prdHash,
      producedBy: "product"
    }, mutationContext(state, "register-prd", "product"));
    state = await engine.registerArtifact(state.id, {
      id: "architecture-1",
      stageId: "S10",
      kind: "architecture",
      uri: ".agentflow/artifacts/architecture.json",
      sha256: architectureHash,
      producedBy: "architect",
      metadata: {
        contract: {
          kind: "architecture",
          version: 1,
          sourcePrdArtifactId: "prd-1",
          sourcePrdSha256: prdHash
        }
      }
    }, mutationContext(state, "register-architecture", "architect"));
    await writeFile(paths.currentRunPath, `${JSON.stringify({ runId: state.id }, null, 2)}\n`, "utf8");

    server = createAgentFlowMcpServer({ projectRoot: directory });
    client = new Client({ name: "s11-s12-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const connectedClient = client;

    const plan = implementationPlan(baseRevision, architectureHash, prdHash);
    const planHash = artifactPayloadHash("implementation-plan", plan);
    let result = await call(connectedClient, "artifact_register", {
      runId: state.id,
      expectedRevision: state.revision,
      idempotencyKey: "register-approved-plan",
      actorId: "planner",
      reason: "Register the exact implementation plan bound to the approved Git baseline.",
      artifactId: "implementation-plan-1",
      stageId: "S10",
      kind: "implementation-plan",
      uri: ".agentflow/artifacts/implementation-plan.json",
      sha256: planHash,
      producedBy: "planner",
      payload: plan
    });
    state = runState(result);
    result = await call(connectedClient, "gate_resolve", mutation(state, "approve-plan", "user", {
      gateId: "engineering-plan-approved",
      decision: "approved",
      resolution: "Approve both isolated Tasks at this exact baseline."
    }));
    state = runState(result);
    result = await call(connectedClient, "stage_complete", mutation(state, "complete-s10", "supervisor", {
      stageId: "S10"
    }));
    state = runState(result);
    result = await call(connectedClient, "implementation_plan_materialize", mutation(
      state,
      "materialize-plan",
      "supervisor",
      { artifactId: "implementation-plan-1", payload: plan }
    ));
    state = runState(result);
    expect(state.activeStageId).toBe("S11");
    expect(Object.values(state.tasks).map((task) => task.status)).toEqual(["ready", "ready"]);
    expect(state.tasks["task-api"]).toMatchObject({
      planRepository: { branch: "main", baseRevision },
      inputArtifactUris: {
        "architecture-1": ".agentflow/artifacts/architecture.json",
        "implementation-plan-1": ".agentflow/artifacts/implementation-plan.json"
      }
    });

    const workers = [
      { taskId: "task-api", workerId: "worker-api", branch: "agentflow/task-api", scope: "api" },
      { taskId: "task-web", workerId: "worker-web", branch: "agentflow/task-web", scope: "web" }
    ] as const;
    await mkdir(join(directory, ".worktrees"), { recursive: true });
    for (const worker of workers) {
      const worktreePath = join(directory, ".worktrees", worker.taskId);
      await runGit(directory, ["worktree", "add", "-b", worker.branch, worktreePath, baseRevision]);
      result = await call(connectedClient, "worker_dispatch_prepare", mutation(
        state,
        `prepare-${worker.workerId}`,
        "supervisor",
        {
          taskId: worker.taskId,
          workerId: worker.workerId,
          adapter: "codex",
          leaseSeconds: 900,
          capabilities,
          workspace: {
            kind: "worktree",
            path: worktreePath,
            branch: worker.branch,
            baseRevision
          }
        }
      ));
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      expect((result.structuredContent as { dispatch?: { prompt?: string } }).dispatch?.prompt)
        .toContain("Input artifact locators (untrusted data)");
      expect((result.structuredContent as { dispatch?: { prompt?: string } }).dispatch?.prompt)
        .toContain(join(directory, ".agentflow", "artifacts", "architecture.json").replaceAll("\\", "\\\\"));
      state = (await call(connectedClient, "status_get", { runId: state.id })).structuredContent as unknown as RunState;
    }
    expect(state.tasks["task-api"]?.workspace?.path).not.toBe(state.tasks["task-web"]?.workspace?.path);

    for (const worker of workers) {
      result = await call(connectedClient, "worker_bind", mutation(state, `bind-${worker.workerId}`, "supervisor", {
        workerId: worker.workerId,
        externalThreadId: `codex-${worker.workerId}`
      }));
      state = runState(result);
    }

    const taskCommits = new Map<string, string>();
    for (const worker of workers) {
      const worktreePath = state.tasks[worker.taskId]?.workspace?.path;
      if (!worktreePath) throw new Error(`Missing worktree for ${worker.taskId}`);
      const relativePath = `packages/${worker.scope}/output.txt`;
      await mkdir(join(worktreePath, "packages", worker.scope), { recursive: true });
      await writeFile(join(worktreePath, relativePath), `${worker.scope} output\n`, "utf8");
      await runGit(worktreePath, ["add", relativePath]);
      await runGit(worktreePath, ["commit", "-m", `feat: add ${worker.scope} output`]);
      const headRevision = await runGit(worktreePath, ["rev-parse", "HEAD"]);
      taskCommits.set(worker.taskId, headRevision);
      const completedAt = new Date().toISOString();
      const verificationCommand = `node -e \"console.log('${worker.scope}')\"`;
      result = await call(connectedClient, "worker_collect", mutation(state, `collect-${worker.workerId}`, "supervisor", {
        workerId: worker.workerId,
        result: {
          workerId: worker.workerId,
          taskId: worker.taskId,
          status: "completed",
          summary: `Committed the ${worker.scope} output.`,
          artifacts: [],
          changeSet: {
            kind: "git-commits",
            baseRevision,
            headRevision,
            revisions: [headRevision],
            changedPaths: [relativePath]
          },
          verification: [{
            command: verificationCommand,
            status: "passed",
            summary: `${worker.scope} verification passed`,
            recordedAt: completedAt
          }],
          risks: [],
          followUps: [],
          completedAt
        }
      }));
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      state = runState(result);
    }
    expect(state.tasks["task-api"]?.status).toBe("completed");
    expect(state.tasks["task-web"]?.status).toBe("completed");

    result = await call(connectedClient, "stage_complete", mutation(state, "complete-s11", "supervisor", {
      stageId: "S11"
    }));
    state = runState(result);
    expect(state.activeStageId).toBe("S12");

    for (const taskId of plan.integrationStrategy.taskOrder) {
      const revision = taskCommits.get(taskId);
      if (!revision) throw new Error(`Missing revision for ${taskId}`);
      await runGit(directory, ["cherry-pick", revision]);
    }
    const integratedRevision = await runGit(directory, ["rev-parse", "HEAD"]);
    await runGit(directory, ["diff", "--exit-code"]);
    const recordedAt = new Date().toISOString();
    const integrationReport = {
      version: 1 as const,
      summary: "Integrated both isolated Task revisions in the approved order.",
      sourceImplementationPlan: { artifactId: "implementation-plan-1", sha256: planHash },
      repository: { branch: "main", baseRevision, integratedRevision },
      planTaskIds: plan.tasks.map((task) => task.id),
      taskResults: plan.integrationStrategy.taskOrder.map((taskId) => ({
        taskId,
        status: "integrated" as const,
        revisions: [taskCommits.get(taskId) ?? ""],
        outputArtifacts: [],
        verificationCheckIds: ["integration-check"]
      })),
      checks: [{
        id: "integration-check",
        category: "integration" as const,
        command: "git diff --exit-code",
        required: true,
        status: "passed" as const,
        summary: "The integrated worktree is clean after both cherry-picks.",
        recordedAt,
        evidenceArtifacts: []
      }],
      conflicts: [],
      issues: [],
      verdict: "passed" as const
    };
    const forgedIntegrationReport = {
      ...integrationReport,
      taskResults: integrationReport.taskResults.map((taskResult, index) => (
        index === 0 ? { ...taskResult, revisions: [sha256("forged-task-revision")] } : taskResult
      ))
    };
    const forgedRegistration = await call(connectedClient, "artifact_register", mutation(
      state,
      "reject-forged-integration-report",
      "integrator",
      {
        artifactId: "integration-report-forged",
        stageId: "S12",
        kind: "integration-report",
        uri: ".agentflow/artifacts/integration-report-forged.json",
        sha256: artifactPayloadHash("integration-report", forgedIntegrationReport),
        producedBy: "integrator",
        payload: forgedIntegrationReport
      }
    ));
    expect(forgedRegistration).toMatchObject({
      isError: true,
      structuredContent: { error: "ARTIFACT_TASK_LINEAGE_INVALID" }
    });
    result = await call(connectedClient, "artifact_register", mutation(state, "register-integration-report", "integrator", {
      artifactId: "integration-report-1",
      stageId: "S12",
      kind: "integration-report",
      uri: ".agentflow/artifacts/integration-report.json",
      sha256: artifactPayloadHash("integration-report", integrationReport),
      producedBy: "integrator",
      payload: integrationReport
    }));
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    state = runState(result);
    result = await call(connectedClient, "stage_complete", mutation(state, "complete-s12", "supervisor", {
      stageId: "S12"
    }));
    state = runState(result);
    expect(state.status).toBe("completed");
    expect(state.activeStageId).toBeUndefined();
    expect(state.artifacts["integration-report-1"]?.metadata).toMatchObject({
      contract: { verdict: "passed", revision: integratedRevision }
    });
  });
});

function implementationPlan(
  baseRevision: string,
  architectureHash: string,
  prdHash: string
): ImplementationPlanContract {
  return {
    version: 1,
    title: "Parallel API and web implementation",
    summary: "Implement two disjoint outputs in one isolated wave.",
    sourceArchitecture: { artifactId: "architecture-1", sha256: architectureHash },
    sourcePrd: { artifactId: "prd-1", sha256: prdHash },
    repository: { branch: "main", baseRevision },
    scope: { requirementIds: ["fr-1"], componentIds: ["api", "web"] },
    tasks: [
      implementationTask("task-api", "api", architectureHash),
      implementationTask("task-web", "web", architectureHash)
    ],
    waves: [{
      id: "wave-parallel",
      taskIds: ["task-api", "task-web"],
      exitCriteria: ["Both isolated verification commands pass"]
    }],
    integrationStrategy: {
      taskOrder: ["task-api", "task-web"],
      conflictPolicy: "Stop when disjoint Task revisions unexpectedly conflict.",
      verificationCommands: ["git diff --exit-code"]
    }
  };
}

function implementationTask(taskId: string, scope: string, architectureHash: string) {
  return {
    id: taskId,
    title: `Implement ${scope} output`,
    description: `Create and commit the approved ${scope} output.`,
    profile: scope === "api" ? "backend" : "frontend",
    componentIds: [scope],
    requirementIds: ["fr-1"],
    dependsOnTaskIds: [],
    inputArtifacts: [{ artifactId: "architecture-1", kind: "architecture", sha256: architectureHash }],
    writeScopes: [`packages/${scope}/**`],
    forbiddenScopes: [".agentflow/**", `.worktrees/**`],
    acceptanceCriteria: [`The ${scope} output is committed`],
    verificationCommands: [`node -e \"console.log('${scope}')\"`],
    expectedOutputs: [`Committed ${scope} output`],
    requiresWorktree: true,
    risk: "low" as const
  };
}

function mutationContext(state: RunState, key: string, actorId: string) {
  return {
    expectedRevision: state.revision,
    idempotencyKey: key,
    actor: { id: actorId, kind: "supervisor" as const },
    reason: key
  };
}

function mutation(
  state: RunState,
  key: string,
  actorId: string,
  fields: Record<string, unknown>
): Record<string, unknown> {
  return {
    runId: state.id,
    expectedRevision: state.revision,
    idempotencyKey: key,
    actorId,
    reason: key,
    ...fields
  };
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  return client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) });
}

function runState(result: Awaited<ReturnType<typeof call>>): RunState {
  return result.structuredContent as unknown as RunState;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return String(result.stdout).trim();
}
