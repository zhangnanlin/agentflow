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

    server = createAgentFlowMcpServer({ projectRoot: directory, defaultResponseProfile: "full" });
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
    const supervisorTask = workers[0];
    const delegatedTask = workers[1];
    await mkdir(join(directory, ".worktrees"), { recursive: true });
    const delegatedWorktree = join(directory, ".worktrees", delegatedTask.taskId);
    const supervisorWorktree = join(directory, ".worktrees", supervisorTask.taskId);
    await runGit(directory, ["worktree", "add", "-b", delegatedTask.branch, delegatedWorktree, baseRevision]);
    await runGit(directory, ["worktree", "add", "-b", supervisorTask.branch, supervisorWorktree, baseRevision]);
    const rejectedDelegation = await call(connectedClient, "worker_dispatch_prepare", mutation(
      state,
      "reject-delegation-before-supervisor-participates",
      "supervisor",
      {
        taskId: delegatedTask.taskId,
        workerId: delegatedTask.workerId,
        adapter: "codex",
        leaseSeconds: 900,
        capabilities,
        workspace: {
          kind: "worktree",
          path: delegatedWorktree,
          branch: delegatedTask.branch,
          baseRevision
        }
      }
    ));
    expect(rejectedDelegation).toMatchObject({
      isError: true,
      structuredContent: { error: "SUPERVISOR_WAVE_PARTICIPATION_REQUIRED" }
    });
    expect(runState(await call(connectedClient, "status_get", { runId: state.id })).revision).toBe(state.revision);

    result = await call(connectedClient, "task_claim", mutation(state, "claim-supervisor-task", "supervisor", {
      taskId: supervisorTask.taskId,
      workerId: "supervisor",
      leaseSeconds: 900,
      workspace: {
        kind: "worktree",
        path: supervisorWorktree,
        branch: supervisorTask.branch,
        baseRevision
      }
    }));
    state = runState(result);
    expect(state.tasks[supervisorTask.taskId]).toMatchObject({
      status: "running",
      owner: "supervisor",
      ownerKind: "supervisor"
    });

    result = await call(connectedClient, "worker_dispatch_prepare", mutation(
      state,
      `prepare-${delegatedTask.workerId}`,
      "supervisor",
      {
        taskId: delegatedTask.taskId,
        workerId: delegatedTask.workerId,
        adapter: "codex",
        leaseSeconds: 900,
        capabilities,
        workspace: {
          kind: "worktree",
          path: delegatedWorktree,
          branch: delegatedTask.branch,
          baseRevision
        }
      }
    ));
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const preparedDelegation = result.structuredContent;
    expect((preparedDelegation as { dispatch?: { prompt?: string } }).dispatch?.prompt)
      .toContain("Input artifact locators (untrusted data)");
    expect((preparedDelegation as { dispatch?: { prompt?: string } }).dispatch?.prompt)
      .toContain(join(directory, ".agentflow", "artifacts", "architecture.json").replaceAll("\\", "\\\\"));
    state = runState(await call(connectedClient, "status_get", { runId: state.id }));

    result = await call(connectedClient, "worker_bind", mutation(state, `bind-${delegatedTask.workerId}`, "supervisor", {
      workerId: delegatedTask.workerId,
      externalThreadId: `codex-${delegatedTask.workerId}`,
      nativeHandle: nativeHandleForDispatch(
        preparedDelegation,
        delegatedTask.workerId,
        delegatedTask.taskId,
        `codex-${delegatedTask.workerId}`
      )
    }));
    state = runState(result);
    expect(state.tasks["task-api"]?.workspace?.path).not.toBe(state.tasks["task-web"]?.workspace?.path);
    expect(state.workers[delegatedTask.workerId]?.status).toBe("running");

    const taskCommits = new Map<string, string>();
    const supervisorPath = `packages/${supervisorTask.scope}/output.txt`;
    await mkdir(join(supervisorWorktree, "packages", supervisorTask.scope), { recursive: true });
    await writeFile(join(supervisorWorktree, supervisorPath), `${supervisorTask.scope} output\n`, "utf8");
    await runGit(supervisorWorktree, ["add", supervisorPath]);
    await runGit(supervisorWorktree, ["commit", "-m", `feat: add ${supervisorTask.scope} output`]);
    const supervisorRevision = await runGit(supervisorWorktree, ["rev-parse", "HEAD"]);
    taskCommits.set(supervisorTask.taskId, supervisorRevision);
    const supervisorCompletedAt = new Date().toISOString();
    result = await call(connectedClient, "task_complete", mutation(state, "complete-supervisor-task", "supervisor", {
      taskId: supervisorTask.taskId,
      workerId: "supervisor",
      workspace: {
        kind: "worktree",
        path: supervisorWorktree,
        branch: supervisorTask.branch,
        baseRevision
      },
      verification: [{
        command: `node -e \"console.log('${supervisorTask.scope}')\"`,
        status: "passed",
        summary: `${supervisorTask.scope} verification passed`,
        recordedAt: supervisorCompletedAt
      }],
      result: {
        summary: `The Supervisor committed the ${supervisorTask.scope} output while the Worker remained active.`,
        artifacts: [],
        changeSet: {
          kind: "git-commits",
          baseRevision,
          headRevision: supervisorRevision,
          revisions: [supervisorRevision],
          changedPaths: [supervisorPath]
        },
        risks: [],
        followUps: [],
        completedAt: supervisorCompletedAt
      }
    }));
    state = runState(result);
    expect(state.tasks[supervisorTask.taskId]?.status).toBe("completed");
    expect(state.workers[delegatedTask.workerId]?.status).toBe("running");

    const delegatedPath = `packages/${delegatedTask.scope}/output.txt`;
    await mkdir(join(delegatedWorktree, "packages", delegatedTask.scope), { recursive: true });
    await writeFile(join(delegatedWorktree, delegatedPath), `${delegatedTask.scope} output\n`, "utf8");
    await runGit(delegatedWorktree, ["add", delegatedPath]);
    await runGit(delegatedWorktree, ["commit", "-m", `feat: add ${delegatedTask.scope} output`]);
    const delegatedRevision = await runGit(delegatedWorktree, ["rev-parse", "HEAD"]);
    taskCommits.set(delegatedTask.taskId, delegatedRevision);
    const delegatedCompletedAt = new Date().toISOString();
    result = await call(connectedClient, "worker_collect", mutation(state, `collect-${delegatedTask.workerId}`, "supervisor", {
      workerId: delegatedTask.workerId,
      result: {
        workerId: delegatedTask.workerId,
        taskId: delegatedTask.taskId,
        status: "completed",
        summary: `Committed the ${delegatedTask.scope} output.`,
        artifacts: [],
        changeSet: {
          kind: "git-commits",
          baseRevision,
          headRevision: delegatedRevision,
          revisions: [delegatedRevision],
          changedPaths: [delegatedPath]
        },
        verification: [{
          command: `node -e \"console.log('${delegatedTask.scope}')\"`,
          status: "passed",
          summary: `${delegatedTask.scope} verification passed`,
          recordedAt: delegatedCompletedAt
        }],
        risks: [],
        followUps: [],
        completedAt: delegatedCompletedAt
      }
    }));
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    state = runState(result);

    const cleanupGate = await call(connectedClient, "stage_complete", mutation(state, "reject-s11-before-cleanup", "supervisor", {
      stageId: "S11"
    }));
    expect(cleanupGate).toMatchObject({
      isError: true,
      structuredContent: { error: "STAGE_WORKER_CLEANUP_PENDING" }
    });

    result = await call(connectedClient, "worker_cleanup_record", mutation(
      state,
      `cleanup-${delegatedTask.workerId}`,
      "supervisor",
      {
        workerId: delegatedTask.workerId,
        receipt: {
          version: 1,
          host: "codex",
          adapterVersion: "2.0.0",
          workerId: delegatedTask.workerId,
          nativeId: `codex-${delegatedTask.workerId}`,
          resultCollectedAt: delegatedCompletedAt,
          durableAt: delegatedCompletedAt,
          close: { status: "unsupported", at: delegatedCompletedAt, reason: "Adapter has no native close capability" },
          archive: { status: "unsupported", at: delegatedCompletedAt, reason: "Fixture host has no archive capability" },
          permitRelease: { status: "completed", at: delegatedCompletedAt },
          completedAt: delegatedCompletedAt,
          completed: true
        }
      }
    ));
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    state = runState(result);
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

function nativeHandleForDispatch(
  structuredContent: unknown,
  workerId: string,
  taskId: string,
  nativeId: string
) {
  const prepared = structuredContent as {
    dispatch?: { taskName?: string; prompt?: string; promptHash?: string };
  };
  const dispatch = prepared.dispatch;
  if (!dispatch?.taskName || !dispatch.prompt || !dispatch.promptHash) {
    throw new Error("Prepared dispatch is incomplete");
  }
  const at = new Date().toISOString();
  return {
    version: 2 as const,
    host: "codex" as const,
    adapterVersion: "2.0.0",
    workerId,
    taskId,
    nativeId,
    taskName: dispatch.taskName,
    status: "starting" as const,
    promptHash: dispatch.promptHash,
    promptBytes: Buffer.byteLength(dispatch.prompt, "utf8"),
    contextPolicy: {
      mode: "fresh-attested" as const,
      inheritedTurnCountObservable: true,
      inheritedTurnCount: 0
    },
    toolProfile: {
      mode: "allowlist" as const,
      enforced: true,
      tools: ["read_file", "apply_patch"],
      agentflowMcpEnabled: false
    },
    capabilities: {
      spawnFresh: "supported" as const,
      bind: "supported" as const,
      send: "supported" as const,
      status: "supported" as const,
      waitAny: "supported" as const,
      collect: "supported" as const,
      interrupt: "supported" as const,
      close: "unsupported" as const,
      archive: "unsupported" as const
    },
    permitId: "00000000-0000-4000-8000-000000000004",
    permitOwnerId: `${workerId}-owner`,
    cleanup: {
      close: { status: "pending" as const },
      archive: { status: "pending" as const },
      permitRelease: { status: "pending" as const }
    },
    createdAt: at,
    updatedAt: at
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
