import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  AgentFlowEngine,
  JsonRunStore,
  artifactPayloadHash,
  sha256,
  validatePipeline,
  type ArtifactContractKind,
  type PipelineDefinition,
  type RunState
} from "@agentflow/core";
import { AGENTFLOW_MCP_INSTRUCTIONS } from "@agentflow/host-adapter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createAgentFlowMcpServer } from "../src/api.js";
import { ProjectRootResolver } from "../src/project-root.js";
import { projectPaths } from "../src/runtime.js";

vi.mock("@agentflow/core", async () => import("../../core/src/index.js"));
vi.mock("@agentflow/host-adapter", async () => import("../../host-adapter/src/index.js"));

const execFileAsync = promisify(execFile);

const pipeline: PipelineDefinition = validatePipeline({
  id: "contract-pipeline",
  version: "1",
  name: "MCP contract pipeline",
  stages: [
    {
      id: "S0",
      name: "Work",
      requiredArtifactKinds: ["spec"],
      requiredGate: {
        id: "review",
        type: "human",
        question: "Approve the work?"
      }
    },
    {
      id: "S1",
      name: "Optional UI",
      dependsOn: ["S0"],
      requiredCapabilities: ["figma.remote.connected", "figma.tool.use_figma"],
      skippableWhen: ["hasUi=false"]
    },
    {
      id: "S2",
      name: "Done",
      dependsOn: ["S1"]
    }
  ]
});

describe("AgentFlow MCP server", () => {
  let directory: string;
  let client: Client | undefined;
  let server: ReturnType<typeof createAgentFlowMcpServer> | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-mcp-test-"));
    const paths = projectPaths(directory);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.pipelinePath, stringifyYaml(pipeline), "utf8");
    await writeFile(paths.configPath, stringifyYaml({
      version: 1,
      pipeline: "pipeline.yaml",
      runsDirectory: "runs"
    }), "utf8");

    const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), pipeline);
    await engine.createRun({
      id: "run-contract",
      requirement: "Exercise the MCP contract",
      hasUi: false
    });
    await writeFile(paths.currentRunPath, `${JSON.stringify({ runId: "run-contract" }, null, 2)}\n`, "utf8");

    server = createAgentFlowMcpServer({ projectRoot: directory, defaultResponseProfile: "full" });
    client = new Client({ name: "agentflow-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("publishes canonical routing instructions", () => {
    expect(requireClient(client).getInstructions()).toBe(AGENTFLOW_MCP_INSTRUCTIONS);
    for (const phrase of [
      "structured_choice_request",
      "gate_decision_request",
      "three independent",
      "one concise text fallback",
      "Never repeat accepted answers"
    ]) {
      expect(requireClient(client).getInstructions()).toContain(phrase);
    }
  });

  it("lists the stable tool contract and executes the full stateful workflow", async () => {
    const connectedClient = requireClient(client);
    const tools = await connectedClient.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "artifact_register",
      "artifact_validate",
      "deterministic_operation_run",
      "gate_decision_request",
      "gate_resolve",
      "implementation_plan_materialize",
      "pipeline_get",
      "resource_acquire",
      "resource_heartbeat",
      "resource_operation_begin",
      "resource_operation_finish",
      "resource_rekey",
      "resource_release",
      "resource_status",
      "run_block",
      "run_cancel",
      "run_fail",
      "run_start_or_resume",
      "run_supersede",
      "stage_complete",
      "stage_preflight_report",
      "stage_skip",
      "status_get",
      "structured_choice_request",
      "task_claim",
      "task_complete",
      "task_create",
      "task_heartbeat",
      "task_retry",
      "task_setup_abort",
      "worker_bind",
      "worker_cleanup_record",
      "worker_close",
      "worker_collect",
      "worker_dispatch_prepare",
      "worker_fail",
      "worker_interrupt",
      "worker_observe",
      "worker_prepare",
      "worker_status"
    ]);
    const taskCreateSchema = tools.tools.find((tool) => tool.name === "task_create")?.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(taskCreateSchema.required).toEqual(expect.arrayContaining([
      "runId",
      "expectedRevision",
      "idempotencyKey",
      "actorId",
      "reason"
    ]));
    expect(taskCreateSchema.properties).not.toHaveProperty("actorKind");
    for (const tool of tools.tools.filter((candidate) => ![
      "artifact_validate",
      "structured_choice_request"
    ].includes(candidate.name))) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      expect(
        schema.properties,
        `${tool.name} must select a project per call: ${JSON.stringify(tool.inputSchema)}`
      ).toHaveProperty("projectRoot");
    }
    const structuredChoice = tools.tools.find((tool) => tool.name === "structured_choice_request");
    expect(structuredChoice?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(structuredChoice?.inputSchema).not.toHaveProperty("properties.projectRoot");
    const gateDecision = tools.tools.find((tool) => tool.name === "gate_decision_request");
    expect(gateDecision?.inputSchema).not.toHaveProperty("properties.question");
    expect(gateDecision?.inputSchema).not.toHaveProperty("properties.options");
    expect(gateDecision?.inputSchema).not.toHaveProperty("properties.decision");
    expect(gateDecision?.inputSchema).not.toHaveProperty("properties.choice");
    expect(gateDecision?.inputSchema).not.toHaveProperty("properties.resolution");

    const pipelineResult = await call(connectedClient, "pipeline_get");
    expect(pipelineResult.isError, JSON.stringify(pipelineResult)).not.toBe(true);
    expect((pipelineResult.structuredContent as unknown as PipelineDefinition).id).toBe("contract-pipeline");

    const initialStatus = await call(connectedClient, "status_get");
    expect(runState(initialStatus).revision).toBe(0);
    expect(runState(initialStatus).activeStageId).toBe("S0");

    let result = await call(connectedClient, "task_create", {
      taskId: "task-1",
      stageId: "S0",
      title: "Produce the specification",
      ...mutation(0, "create-task", "supervisor-1")
    });
    expect(runState(result).tasks["task-1"]?.status).toBe("ready");
    expect(runState(result).idempotency["create-task"]?.reason).toBe("contract test: create-task");
    expect(runState(result).events.at(-1)?.actorKind).toBe("supervisor");

    result = await call(connectedClient, "task_claim", {
      taskId: "task-1",
      workerId: "worker-1",
      leaseSeconds: 60,
      ...mutation(1, "claim-task", "worker-1")
    });
    expect(runState(result).tasks["task-1"]?.status).toBe("running");

    result = await call(connectedClient, "task_heartbeat", {
      taskId: "task-1",
      workerId: "worker-1",
      leaseSeconds: 120,
      ...mutation(2, "heartbeat-task", "worker-1")
    });
    expect(runState(result).tasks["task-1"]?.lease?.owner).toBe("worker-1");

    result = await call(connectedClient, "task_complete", {
      taskId: "task-1",
      workerId: "worker-1",
      verification: [{
        command: "npm test",
        status: "passed",
        summary: "Contract checks passed",
        recordedAt: new Date().toISOString()
      }],
      result: { commit: "abc123" },
      ...mutation(3, "complete-task", "worker-1")
    });
    expect(runState(result).tasks["task-1"]?.status).toBe("completed");

    result = await call(connectedClient, "artifact_register", {
      artifactId: "spec-1",
      stageId: "S0",
      kind: "spec",
      uri: ".agentflow/artifacts/spec.md",
      sha256: sha256("specification"),
      producedBy: "worker-1",
      ...mutation(4, "register-artifact", "worker-1")
    });
    expect(runState(result).artifacts["spec-1"]?.kind).toBe("spec");

    result = await call(connectedClient, "gate_resolve", {
      gateId: "review",
      decision: "approved",
      resolution: "Approved in contract test",
      ...mutation(5, "approve-gate", "user-1")
    });
    expect(runState(result).gates.review?.status).toBe("approved");

    result = await call(connectedClient, "stage_complete", {
      stageId: "S0",
      ...mutation(6, "complete-stage", "supervisor-1")
    });
    expect(runState(result).activeStageId).toBe("S1");

    result = await call(connectedClient, "stage_skip", {
      stageId: "S1",
      reason: "Run has no UI",
      ...mutation(7, "skip-stage", "supervisor-1")
    });
    expect(runState(result).activeStageId).toBe("S2");
    expect(runState(result).revision).toBe(8);

    const retry = await call(connectedClient, "stage_skip", {
      stageId: "S1",
      reason: "Run has no UI",
      ...mutation(7, "skip-stage", "supervisor-1")
    });
    expect(retry.isError).not.toBe(true);
    expect(runState(retry).revision).toBe(8);

    const conflict = await call(connectedClient, "task_create", {
      taskId: "stale-task",
      stageId: "S2",
      title: "Use a stale revision",
      ...mutation(0, "stale-create", "supervisor-1")
    });
    expect(conflict.isError).toBe(true);
    expect((conflict.structuredContent as { error?: string } | undefined)?.error).toBe("REVISION_CONFLICT");
  });

  it("isolates two dynamically selected projects while fixed-root mode remains authoritative", async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;

    const rootA = join(directory, "project-a");
    const rootB = join(directory, "project-b");
    await initializeProject(rootA, "pipeline-a", "run-a");
    await initializeProject(rootB, "pipeline-b", "run-b");

    const resolver = new ProjectRootResolver({
      cwd: directory,
      listRoots: async () => [
        { uri: pathToFileURL(rootA).href },
        { uri: pathToFileURL(rootB).href }
      ]
    });
    server = createAgentFlowMcpServer({ projectRootResolver: resolver, defaultResponseProfile: "full" });
    client = new Client({ name: "agentflow-dynamic-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const connectedClient = requireClient(client);
    expect((await call(connectedClient, "pipeline_get", { projectRoot: rootA })).structuredContent)
      .toMatchObject({ id: "pipeline-a" });
    expect((await call(connectedClient, "pipeline_get", { projectRoot: rootB })).structuredContent)
      .toMatchObject({ id: "pipeline-b" });
    expect(runState(await call(connectedClient, "status_get", { projectRoot: rootA })).id).toBe("run-a");
    expect(runState(await call(connectedClient, "status_get", { projectRoot: rootB })).id).toBe("run-b");

    const changedA = await call(connectedClient, "task_create", {
      projectRoot: rootA,
      taskId: "only-a",
      stageId: "S0",
      title: "Change project A",
      ...mutation(0, "change-a", "supervisor-a", "run-a")
    });
    expect(runState(changedA).tasks["only-a"]?.status).toBe("ready");
    expect(runState(await call(connectedClient, "status_get", { projectRoot: rootB })).tasks)
      .not.toHaveProperty("only-a");

    await client.close();
    await server.close();
    server = createAgentFlowMcpServer({ projectRoot: rootA, projectRootResolver: resolver, defaultResponseProfile: "full" });
    client = new Client({ name: "agentflow-fixed-test", version: "0.1.0" });
    const [fixedClientTransport, fixedServerTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(fixedServerTransport);
    await client.connect(fixedClientTransport);
    expect((await call(requireClient(client), "pipeline_get", { projectRoot: rootB })).structuredContent)
      .toMatchObject({ id: "pipeline-a" });
  });

  it("starts or resumes lazily without allowing read-only initialization", async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;

    const freshRoot = join(directory, "fresh-project");
    await mkdir(freshRoot, { recursive: true });
    server = createAgentFlowMcpServer({ projectRoot: freshRoot, defaultResponseProfile: "full" });
    client = new Client({ name: "agentflow-lifecycle-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const connectedClient = requireClient(client);

    const statusBeforeStart = await call(connectedClient, "status_get");
    expect(statusBeforeStart.isError).toBe(true);
    expect(statusBeforeStart.structuredContent).toMatchObject({ error: "PROJECT_NOT_INITIALIZED" });
    expect(await readdir(freshRoot)).toEqual([]);

    const started = await call(connectedClient, "run_start_or_resume", {
      requirement: "Create a fresh lazy project",
      projectType: "new",
      hasUi: false,
      requestedRunId: "lazy-mcp-run",
      requestKey: "lazy-request-1"
    });
    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toMatchObject({
      action: "started",
      initialized: true,
      state: {
        id: "lazy-mcp-run",
        workflow: { lane: "standard", signals: ["new-project"] }
      }
    });

    const conflict = await call(connectedClient, "run_start_or_resume", {
      requirement: "Continue the existing lazy project",
      projectType: "existing",
      hasUi: false,
      requestKey: "lazy-request-2"
    });
    expect(conflict.structuredContent).toMatchObject({
      action: "conflict",
      initialized: false,
      conflict: { code: "ACTIVE_RUN_INTENT_CONFLICT", activeRunId: "lazy-mcp-run" }
    });
    expect(conflict.structuredContent).not.toHaveProperty("state");

    const resumed = await call(connectedClient, "run_start_or_resume", {
      requirement: "Continue the existing lazy project",
      projectType: "existing",
      hasUi: false,
      requestedRunId: "lazy-mcp-run",
      requestKey: "lazy-request-3"
    });
    expect(resumed.structuredContent).toMatchObject({
      action: "resumed",
      initialized: false,
      state: { id: "lazy-mcp-run" }
    });

    const paths = projectPaths(freshRoot);
    const statePath = join(paths.runsDirectory, "lazy-mcp-run", "state.json");
    const completed = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    completed["status"] = "completed";
    completed["executionStatus"] = "terminal";
    delete completed["activeStageId"];
    await writeFile(statePath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");

    const next = await call(connectedClient, "run_start_or_resume", {
      requirement: "Start the next project change",
      projectType: "existing",
      hasUi: false,
      requestedRunId: "next-mcp-run",
      requestKey: "lazy-request-4"
    });
    expect(next.structuredContent).toMatchObject({
      action: "started",
      initialized: false,
      state: {
        id: "next-mcp-run",
        workflow: { lane: "quick", signals: ["low-risk"] }
      }
    });
  });

  it("atomically prepares a deterministic native dispatch and replays it without duplicate spawn intent", async () => {
    const connectedClient = requireClient(client);
    const verificationCommand = "node -e \"const p=require('./package.json');if(p.name!=='agentflow')process.exit(1)\"";
    let result = await call(connectedClient, "task_create", {
      taskId: "dispatch-task",
      stageId: "S0",
      title: "Verify the package boundary",
      description: "Inspect package.json and return the package name without modifying files.",
      profile: "analysis",
      writeScopes: [],
      forbiddenScopes: [".agentflow/**"],
      acceptanceCriteria: ["The package name is reported from package.json"],
      verificationCommands: [verificationCommand],
      expectedOutputs: ["A structured WorkerResult with verification evidence"],
      requiresWorktree: false,
      ...mutation(0, "create-dispatch-task", "supervisor-1")
    });
    expect(runState(result).tasks["dispatch-task"]?.status).toBe("ready");

    const unverifiedWorktree = await call(connectedClient, "worker_dispatch_prepare", {
      taskId: "dispatch-task",
      workerId: "unverified-worktree-worker",
      adapter: "codex",
      leaseSeconds: 900,
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: false
      },
      workspace: {
        kind: "worktree",
        path: join(directory, ".worktrees", "missing"),
        branch: "agentflow/missing",
        baseRevision: "a".repeat(40)
      },
      ...mutation(1, "reject-unverified-worktree", "supervisor-1")
    });
    expect(unverifiedWorktree.isError).toBe(true);
    expect(unverifiedWorktree.structuredContent).toMatchObject({ error: "TASK_WORKSPACE_GIT_INVALID" });
    expect(runState(await call(connectedClient, "status_get")).revision).toBe(1);

    const dispatchMutation = mutation(1, "prepare-dispatch-task", "supervisor-1");
    result = await call(connectedClient, "worker_dispatch_prepare", {
      taskId: "dispatch-task",
      workerId: "dispatch-worker",
      adapter: "codex",
      leaseSeconds: 900,
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: false
      },
      ...dispatchMutation
    });
    const prepared = result.structuredContent as unknown as {
      revision: number;
      task: { status: string; workspace: { kind: string; path: string } };
      worker: { status: string; promptHash: string; hostTaskName: string };
      dispatch: { taskName: string; prompt: string; promptHash: string; workspace: { path: string } };
    };
    expect(prepared).toMatchObject({
      revision: 2,
      task: { status: "running", workspace: { kind: "project", path: directory } },
      worker: { status: "prepared" },
      dispatch: { workspace: { path: directory } }
    });
    expect(prepared.dispatch.taskName).toMatch(/^[a-z0-9_]{1,100}$/);
    expect(prepared.dispatch.prompt).toContain("Acceptance criteria: [\"The package name is reported from package.json\"]");
    expect(prepared.dispatch.prompt).toContain("additionalProperties");
    expect(prepared.dispatch.promptHash).toBe(prepared.worker.promptHash);

    const replay = await call(connectedClient, "worker_dispatch_prepare", {
      taskId: "dispatch-task",
      workerId: "dispatch-worker",
      adapter: "codex",
      leaseSeconds: 900,
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: false
      },
      ...dispatchMutation
    });
    expect(replay.isError).not.toBe(true);
    expect((replay.structuredContent as { revision?: number }).revision).toBe(2);
    expect((replay.structuredContent as { dispatch?: { promptHash?: string } }).dispatch?.promptHash)
      .toBe(prepared.dispatch.promptHash);

    result = await call(connectedClient, "worker_bind", {
      workerId: "dispatch-worker",
      externalThreadId: "codex-native-thread-1",
      ...mutation(2, "bind-dispatch-worker", "supervisor-1")
    });
    expect(runState(result).workers["dispatch-worker"]).toMatchObject({
      status: "running",
      externalThreadId: "codex-native-thread-1"
    });
    const boundState = runState(result);

    const rejectedTaskCompletion = await call(connectedClient, "task_complete", {
      taskId: "dispatch-task",
      workerId: "dispatch-worker",
      verification: [{
        command: verificationCommand,
        status: "passed",
        summary: "Package boundary verified",
        recordedAt: new Date().toISOString()
      }],
      result: {},
      ...mutation(boundState.revision, "reject-live-worker-task-completion", "dispatch-worker")
    });
    expect(rejectedTaskCompletion).toMatchObject({
      isError: true,
      structuredContent: {
        error: "TASK_WORKER_LIVE",
        details: {
          taskId: "dispatch-task",
          workerId: "dispatch-worker",
          workerStatus: "running"
        }
      }
    });
    expect(runState(await call(connectedClient, "status_get"))).toEqual(boundState);

    const rejectedStageCompletion = await call(connectedClient, "stage_complete", {
      stageId: "S0",
      ...mutation(boundState.revision, "reject-live-worker-stage-completion", "supervisor-1")
    });
    expect(rejectedStageCompletion).toMatchObject({
      isError: true,
      structuredContent: {
        error: "STAGE_WORKER_LIVE",
        details: {
          stageId: "S0",
          taskId: "dispatch-task",
          workerId: "dispatch-worker",
          workerStatus: "running"
        }
      }
    });
    expect(runState(await call(connectedClient, "status_get"))).toEqual(boundState);

    const completedAt = new Date().toISOString();
    result = await call(connectedClient, "worker_collect", {
      workerId: "dispatch-worker",
      result: {
        workerId: "dispatch-worker",
        taskId: "dispatch-task",
        status: "completed",
        summary: "Verified the package boundary.",
        artifacts: [],
        changeSet: null,
        verification: [{
          command: verificationCommand,
          status: "passed",
          summary: "Package boundary verified",
          recordedAt: completedAt
        }],
        risks: [],
        followUps: [],
        completedAt
      },
      ...mutation(boundState.revision, "collect-dispatch-worker", "supervisor-1")
    });
    expect(runState(result)).toMatchObject({
      revision: boundState.revision + 1,
      tasks: { "dispatch-task": { status: "completed" } },
      workers: { "dispatch-worker": { status: "completed" } }
    });
  });

  it("verifies a completed worktree change set against real Git history before collection", async () => {
    const connectedClient = requireClient(client);
    await runGit(directory, ["init", "--initial-branch=main"]);
    await runGit(directory, ["config", "user.name", "AgentFlow Test"]);
    await runGit(directory, ["config", "user.email", "agentflow@example.test"]);
    await writeFile(join(directory, ".gitignore"), ".worktrees/\n", "utf8");
    await writeFile(join(directory, "README.md"), "# Git fixture\n", "utf8");
    await runGit(directory, ["add", ".gitignore", "README.md"]);
    await runGit(directory, ["commit", "-m", "test: establish baseline"]);
    const baseRevision = await runGit(directory, ["rev-parse", "HEAD"]);
    const worktreePath = join(directory, ".worktrees", "task-git");
    const workerBranch = "agentflow/task-git";
    await mkdir(join(directory, ".worktrees"), { recursive: true });
    await runGit(directory, ["worktree", "add", "-b", workerBranch, worktreePath, baseRevision]);

    const verificationCommand = "node -e \"process.exit(0)\"";
    let result = await call(connectedClient, "task_create", {
      taskId: "task-git",
      stageId: "S0",
      title: "Write one isolated output",
      description: "Create the assigned output in the verified worktree.",
      profile: "backend",
      writeScopes: ["packages/task-git/**"],
      forbiddenScopes: [".agentflow/**"],
      acceptanceCriteria: ["The isolated output is committed"],
      verificationCommands: [verificationCommand],
      expectedOutputs: ["One verified Git commit"],
      requiresWorktree: true,
      ...mutation(0, "git-create-task", "supervisor-1")
    });
    expect(runState(result).tasks["task-git"]?.status).toBe("ready");

    result = await call(connectedClient, "worker_dispatch_prepare", {
      taskId: "task-git",
      workerId: "worker-git",
      adapter: "codex",
      leaseSeconds: 900,
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: false
      },
      workspace: {
        kind: "worktree",
        path: worktreePath,
        branch: workerBranch,
        baseRevision
      },
      ...mutation(1, "git-prepare-worker", "supervisor-1")
    });
    expect(result.structuredContent).toMatchObject({
      task: { workspace: { path: worktreePath, branch: workerBranch, baseRevision } },
      worker: { status: "prepared" }
    });
    expect((result.structuredContent as { dispatch?: { prompt?: string } }).dispatch?.prompt)
      .toContain('"changeSet"');

    const outputPath = join(worktreePath, "packages", "task-git", "output.txt");
    await mkdir(join(worktreePath, "packages", "task-git"), { recursive: true });
    await writeFile(outputPath, "verified output\n", "utf8");
    await runGit(worktreePath, ["add", "packages/task-git/output.txt"]);
    await runGit(worktreePath, ["commit", "-m", "feat: add isolated output"]);
    const headRevision = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    const revisions = (await runGit(worktreePath, ["rev-list", "--reverse", `${baseRevision}..${headRevision}`]))
      .split(/\r?\n/).filter(Boolean);
    const replayAfterCommit = await call(connectedClient, "worker_dispatch_prepare", {
      taskId: "task-git",
      workerId: "worker-git",
      adapter: "codex",
      leaseSeconds: 900,
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: false
      },
      workspace: {
        kind: "worktree",
        path: worktreePath,
        branch: workerBranch,
        baseRevision
      },
      ...mutation(1, "git-prepare-worker", "supervisor-1")
    });
    expect(replayAfterCommit.isError, JSON.stringify(replayAfterCommit.structuredContent)).not.toBe(true);
    expect((replayAfterCommit.structuredContent as { revision?: number }).revision).toBe(2);

    result = await call(connectedClient, "worker_bind", {
      workerId: "worker-git",
      externalThreadId: "codex-git-thread",
      ...mutation(2, "git-bind-worker", "supervisor-1")
    });
    expect(runState(result).revision).toBe(3);
    const completedAt = new Date().toISOString();
    const workerResult = {
      workerId: "worker-git",
      taskId: "task-git",
      status: "completed" as const,
      summary: "Committed the isolated output.",
      artifacts: [],
      verification: [{
        command: verificationCommand,
        status: "passed" as const,
        summary: "Verification command passed",
        recordedAt: completedAt
      }],
      risks: [],
      followUps: [],
      completedAt
    };

    const missingChangeSet = await call(connectedClient, "worker_collect", {
      workerId: "worker-git",
      result: { ...workerResult, changeSet: null },
      ...mutation(3, "git-reject-missing-change-set", "supervisor-1")
    });
    expect(missingChangeSet).toMatchObject({
      isError: true,
      structuredContent: { error: "WORKER_CHANGESET_REQUIRED" }
    });

    const forgedPaths = await call(connectedClient, "worker_collect", {
      workerId: "worker-git",
      result: {
        ...workerResult,
        changeSet: {
          kind: "git-commits",
          baseRevision,
          headRevision,
          revisions,
          changedPaths: ["packages/task-git/forged.txt"]
        }
      },
      ...mutation(3, "git-reject-forged-paths", "supervisor-1")
    });
    expect(forgedPaths).toMatchObject({
      isError: true,
      structuredContent: { error: "WORKER_CHANGESET_GIT_MISMATCH" }
    });

    const scratchPath = join(worktreePath, "scratch.txt");
    await writeFile(scratchPath, "uncommitted\n", "utf8");
    const dirtyWorktree = await call(connectedClient, "worker_collect", {
      workerId: "worker-git",
      result: {
        ...workerResult,
        changeSet: {
          kind: "git-commits",
          baseRevision,
          headRevision,
          revisions,
          changedPaths: ["packages/task-git/output.txt"]
        }
      },
      ...mutation(3, "git-reject-dirty-worktree", "supervisor-1")
    });
    expect(dirtyWorktree).toMatchObject({
      isError: true,
      structuredContent: { error: "WORKER_CHANGESET_GIT_MISMATCH" }
    });
    await rm(scratchPath, { force: true });

    result = await call(connectedClient, "worker_collect", {
      workerId: "worker-git",
      result: {
        ...workerResult,
        changeSet: {
          kind: "git-commits",
          baseRevision,
          headRevision,
          revisions,
          changedPaths: ["packages/task-git/output.txt"]
        }
      },
      ...mutation(3, "git-collect-worker", "supervisor-1")
    });
    expect(runState(result).tasks["task-git"]).toMatchObject({
      status: "completed",
      result: { changeSet: { headRevision, changedPaths: ["packages/task-git/output.txt"] } }
    });
  });

  it("lets the Supervisor complete an integration Task on the approved branch without a Worker", async () => {
    const connectedClient = requireClient(client);
    await runGit(directory, ["init", "--initial-branch=main"]);
    await runGit(directory, ["config", "user.name", "AgentFlow Test"]);
    await runGit(directory, ["config", "user.email", "agentflow@example.test"]);
    await writeFile(join(directory, ".gitignore"), ".agentflow/\n", "utf8");
    await writeFile(join(directory, "README.md"), "# Inline fixture\n", "utf8");
    await runGit(directory, ["add", ".gitignore", "README.md"]);
    await runGit(directory, ["commit", "-m", "test: establish inline baseline"]);
    const baseRevision = await runGit(directory, ["rev-parse", "HEAD"]);
    await mkdir(join(directory, "packages", "dependency"), { recursive: true });
    await mkdir(join(directory, "packages", "task-inline"), { recursive: true });
    await writeFile(join(directory, "packages", "dependency", "output.txt"), "dependency output\n", "utf8");
    await runGit(directory, ["add", "packages/dependency/output.txt"]);
    await runGit(directory, ["commit", "-m", "feat: integrate prior dependency"]);

    const verificationCommand = "node -e \"process.exit(0)\"";
    let result = await call(connectedClient, "task_create", {
      taskId: "task-inline",
      stageId: "S0",
      title: "Write one Supervisor-owned output",
      writeScopes: ["packages/task-inline/**"],
      forbiddenScopes: [".agentflow/**"],
      acceptanceCriteria: ["The Supervisor commits the isolated output"],
      verificationCommands: [verificationCommand],
      expectedOutputs: ["One verified Git commit"],
      requiresWorktree: false,
      ...mutation(0, "inline-create-task", "supervisor-1")
    });
    expect(runState(result).tasks["task-inline"]?.status).toBe("ready");

    const statePath = join(projectPaths(directory).runsDirectory, "run-contract", "state.json");
    const rawState = JSON.parse(await readFile(statePath, "utf8")) as {
      tasks: Record<string, Record<string, unknown>>;
    };
    rawState.tasks["task-inline"] = {
      ...rawState.tasks["task-inline"],
      materializedFrom: {
        artifactId: "implementation-plan-inline",
        kind: "implementation-plan",
        sha256: "a".repeat(64)
      },
      planRepository: { branch: "main", baseRevision }
    };
    await writeFile(statePath, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");

    const workspace = { kind: "project" as const, path: directory };
    result = await call(connectedClient, "task_claim", {
      taskId: "task-inline",
      workerId: "supervisor-1",
      leaseSeconds: 900,
      workspace,
      ...mutation(1, "inline-claim-task", "supervisor-1")
    });
    expect(runState(result)).toMatchObject({
      revision: 2,
      tasks: {
        "task-inline": {
          status: "running",
          owner: "supervisor-1",
          ownerKind: "supervisor",
          workspace
        }
      },
      workers: {}
    });

    await writeFile(join(directory, "packages", "task-inline", "output.txt"), "inline output\n", "utf8");
    await runGit(directory, ["add", "packages/task-inline/output.txt"]);
    await runGit(directory, ["commit", "-m", "feat: add inline output"]);
    const headRevision = await runGit(directory, ["rev-parse", "HEAD"]);
    const completedAt = new Date().toISOString();
    const completion = {
      taskId: "task-inline",
      workerId: "supervisor-1",
      workspace,
      verification: [{
        command: verificationCommand,
        status: "passed",
        summary: "Inline verification passed",
        recordedAt: completedAt
      }],
      result: {
        summary: "The Supervisor committed the isolated output.",
        artifacts: [],
        changeSet: {
          kind: "git-commits",
          baseRevision,
          headRevision,
          revisions: [headRevision],
          changedPaths: ["packages/task-inline/output.txt"]
        },
        risks: [],
        followUps: [],
        completedAt
      }
    };
    const forged = await call(connectedClient, "task_complete", {
      ...completion,
      result: {
        ...completion.result,
        changeSet: { ...completion.result.changeSet, changedPaths: ["packages/task-inline/forged.txt"] }
      },
      ...mutation(2, "inline-reject-forged-path", "supervisor-1")
    });
    expect(forged).toMatchObject({
      isError: true,
      structuredContent: { error: "WORKER_CHANGESET_GIT_MISMATCH" }
    });

    result = await call(connectedClient, "task_complete", {
      ...completion,
      ...mutation(2, "inline-complete-task", "supervisor-1")
    });
    expect(runState(result)).toMatchObject({
      revision: 3,
      tasks: {
        "task-inline": {
          status: "completed",
          owner: "supervisor-1",
          ownerKind: "supervisor",
          result: { changeSet: { headRevision } }
        }
      },
      workers: {}
    });
    expect(runState(result).events.at(-1)?.type).toBe("task.completed.inline");
  });

  it("persists a failed live preflight and resumes the same stage after a passing probe", async () => {
    const connectedClient = requireClient(client);
    let result = await call(connectedClient, "artifact_register", {
      artifactId: "spec-1",
      stageId: "S0",
      kind: "spec",
      uri: ".agentflow/artifacts/spec.md",
      sha256: sha256("specification"),
      producedBy: "worker-1",
      ...mutation(0, "preflight-spec", "worker-1")
    });
    result = await call(connectedClient, "gate_resolve", {
      gateId: "review",
      decision: "approved",
      resolution: "Approved before capability probe",
      ...mutation(1, "preflight-gate", "user-1")
    });
    result = await call(connectedClient, "stage_complete", {
      stageId: "S0",
      ...mutation(2, "preflight-enter-s1", "supervisor-1")
    });
    expect(runState(result).activeStageId).toBe("S1");

    result = await call(connectedClient, "stage_preflight_report", {
      stageId: "S1",
      host: "codex",
      availableCapabilities: ["figma.remote.connected"],
      ttlSeconds: 900,
      ...mutation(3, "preflight-block", "supervisor-1")
    });
    expect(runState(result)).toMatchObject({
      status: "blocked",
      activeStageId: "S1",
      stages: { S1: { status: "blocked" } },
      preflights: {
        S1: {
          status: "blocked",
          missingCapabilities: ["figma.tool.use_figma"]
        }
      }
    });

    const persisted = await call(connectedClient, "status_get");
    expect(runState(persisted).preflights.S1?.status).toBe("blocked");

    result = await call(connectedClient, "stage_preflight_report", {
      stageId: "S1",
      host: "codex",
      availableCapabilities: ["figma.remote.connected", "figma.tool.use_figma"],
      ttlSeconds: 900,
      ...mutation(4, "preflight-resume", "supervisor-1")
    });
    expect(runState(result)).toMatchObject({
      status: "active",
      activeStageId: "S1",
      stages: { S1: { status: "active" } },
      preflights: { S1: { status: "passed", missingCapabilities: [] } }
    });
  });

  it("persists a native host worker from prepare through collect and close", async () => {
    const connectedClient = requireClient(client);
    let result = await call(connectedClient, "task_create", {
      taskId: "native-task",
      stageId: "S0",
      title: "Run in a native host thread",
      ...mutation(0, "native-create", "supervisor-1")
    });
    expect(runState(result).tasks["native-task"]?.status).toBe("ready");

    result = await call(connectedClient, "task_claim", {
      taskId: "native-task",
      workerId: "native-worker",
      leaseSeconds: 60,
      ...mutation(1, "native-claim", "native-worker")
    });
    result = await call(connectedClient, "worker_prepare", {
      workerId: "native-worker",
      taskId: "native-task",
      adapter: "codex",
      hostTaskName: "run-contract-native-task-native-worker",
      prompt: "bounded prompt",
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: true
      },
      ...mutation(2, "native-prepare", "supervisor-1")
    });
    expect(runState(result).workers["native-worker"]?.status).toBe("prepared");

    const handleAt = new Date().toISOString();
    const nativeHandle = {
      version: 2,
      host: "codex",
      adapterVersion: "2.0.0",
      workerId: "native-worker",
      taskId: "native-task",
      nativeId: "codex-native-thread",
      taskName: "run-contract-native-task-native-worker",
      status: "starting",
      promptHash: sha256("bounded prompt"),
      promptBytes: Buffer.byteLength("bounded prompt", "utf8"),
      contextPolicy: {
        mode: "fresh-attested",
        inheritedTurnCountObservable: true,
        inheritedTurnCount: 0
      },
      toolProfile: {
        mode: "allowlist",
        enforced: true,
        tools: ["read_file", "apply_patch"],
        agentflowMcpEnabled: false
      },
      capabilities: {
        spawnFresh: "supported",
        bind: "supported",
        send: "supported",
        status: "supported",
        waitAny: "supported",
        collect: "supported",
        interrupt: "supported",
        close: "supported",
        archive: "supported"
      },
      permitId: "00000000-0000-4000-8000-000000000001",
      permitOwnerId: "native-worker-owner",
      cleanup: {
        close: { status: "pending" },
        archive: { status: "pending" },
        permitRelease: { status: "pending" }
      },
      createdAt: handleAt,
      updatedAt: handleAt
    } as const;
    const inheritedBinding = await call(connectedClient, "worker_bind", {
      workerId: "native-worker",
      externalThreadId: "codex-native-thread",
      nativeHandle: {
        ...nativeHandle,
        contextPolicy: { ...nativeHandle.contextPolicy, inheritedTurnCount: 1 }
      },
      ...mutation(3, "native-reject-inherited-bind", "supervisor-1")
    });
    expect(inheritedBinding).toMatchObject({
      isError: true,
      structuredContent: { error: "WORKER_CONTEXT_ISOLATION_INVALID" }
    });

    result = await call(connectedClient, "worker_bind", {
      workerId: "native-worker",
      externalThreadId: "codex-native-thread",
      nativeHandle,
      ...mutation(3, "native-bind", "supervisor-1")
    });
    expect(runState(result).workers["native-worker"]).toMatchObject({
      externalThreadId: "codex-native-thread",
      adapterVersion: "2.0.0",
      contextPolicy: {
        mode: "fresh-attested",
        inheritedTurnCount: 0,
        promptBytes: Buffer.byteLength("bounded prompt", "utf8"),
        agentflowMcpEnabled: false
      }
    });

    const unsafeCancellation = await call(connectedClient, "run_cancel", {
      ...mutation(4, "cancel-live-native-worker", "supervisor-1")
    });
    expect(unsafeCancellation.isError).toBe(true);
    expect(unsafeCancellation.structuredContent).toMatchObject({ error: "RUN_WORKER_LIVE" });

    const persisted = await call(connectedClient, "worker_status", { workerId: "native-worker" });
    expect(persisted.structuredContent).toMatchObject({
      id: "native-worker",
      status: "running",
      externalThreadId: "codex-native-thread"
    });

    result = await call(connectedClient, "resource_acquire", {
      resourceId: "figma-main",
      kind: "figma-file",
      resourceKey: "figma-file-key-contract",
      stageId: "S0",
      taskId: "native-task",
      owner: "native-worker",
      leaseSeconds: 60,
      metadata: { fileKey: "figma-file-key-contract" },
      ...mutation(4, "figma-acquire", "native-worker")
    });
    expect(runState(result).resources["figma-main"]?.status).toBe("active");
    result = await call(connectedClient, "resource_operation_begin", {
      resourceId: "figma-main",
      owner: "native-worker",
      operationId: "figma-op-1",
      tool: "figma.use_figma.write",
      ...mutation(5, "figma-operation-begin", "native-worker")
    });
    result = await call(connectedClient, "resource_operation_finish", {
      resourceId: "figma-main",
      owner: "native-worker",
      operationId: "figma-op-1",
      status: "completed",
      resultHash: sha256("figma result"),
      affectedNodeIds: ["1:2"],
      summary: "Created one concept frame",
      ...mutation(6, "figma-operation-finish", "native-worker")
    });
    const resource = await call(connectedClient, "resource_status", { resourceId: "figma-main" });
    expect(resource.structuredContent).toMatchObject({
      status: "active",
      operations: [{ id: "figma-op-1", status: "completed", affectedNodeIds: ["1:2"] }]
    });
    result = await call(connectedClient, "resource_release", {
      resourceId: "figma-main",
      owner: "native-worker",
      ...mutation(7, "figma-release", "native-worker")
    });
    expect(runState(result).resources["figma-main"]?.status).toBe("released");

    result = await call(connectedClient, "worker_observe", {
      workerId: "native-worker",
      status: "running",
      ...mutation(8, "native-observe", "supervisor-1")
    });
    result = await call(connectedClient, "worker_collect", {
      workerId: "native-worker",
      result: {
        workerId: "native-worker",
        taskId: "native-task",
        status: "completed",
        summary: "Native host work completed with token=mcp-capsule-secret.",
        artifacts: [],
        changeSet: null,
        verification: [{
          command: "npm test",
          status: "passed",
          summary: "Passed",
          recordedAt: new Date().toISOString()
        }],
        risks: [],
        followUps: [],
        completedAt: new Date().toISOString()
      },
      ...mutation(9, "native-collect", "supervisor-1")
    });
    expect(runState(result).tasks["native-task"]?.status).toBe("completed");
    expect(runState(result).workers["native-worker"]?.status).toBe("completed");
    expect(runState(result).tasks["native-task"]?.result).toMatchObject({
      summary: "Native host work completed with token=[REDACTED]"
    });
    expect(JSON.stringify(runState(result))).not.toContain("mcp-capsule-secret");

    result = await call(connectedClient, "worker_close", {
      workerId: "native-worker",
      ...mutation(10, "native-close", "supervisor-1")
    });
    expect(runState(result).workers["native-worker"]?.status).toBe("closed");

    const cleanupAt = new Date().toISOString();
    const cleanupReceipt = {
      version: 1,
      host: "codex",
      adapterVersion: "2.0.0",
      workerId: "native-worker",
      nativeId: "codex-native-thread",
      durableAt: cleanupAt,
      close: { status: "completed", at: cleanupAt },
      archive: {
        status: "unsupported",
        at: cleanupAt,
        reason: "Host has no archive operation; token=cleanup-secret"
      },
      permitRelease: { status: "completed", at: cleanupAt },
      completedAt: cleanupAt,
      completed: true
    } as const;
    const mismatchedCleanup = await call(connectedClient, "worker_cleanup_record", {
      workerId: "native-worker",
      receipt: { ...cleanupReceipt, adapterVersion: "2.0.1" },
      ...mutation(11, "native-reject-cleanup-version", "supervisor-1")
    });
    expect(mismatchedCleanup).toMatchObject({
      isError: true,
      structuredContent: { error: "WORKER_CLEANUP_RECEIPT_MISMATCH" }
    });

    result = await call(connectedClient, "worker_cleanup_record", {
      workerId: "native-worker",
      receipt: cleanupReceipt,
      ...mutation(11, "native-cleanup-record", "supervisor-1")
    });
    const cleanupState = runState(result);
    expect(cleanupState.workers["native-worker"]?.cleanup).toMatchObject({
      close: { status: "completed" },
      archive: { status: "unsupported", reason: "Host has no archive operation; token=[REDACTED]" },
      permitRelease: { status: "completed" },
      completedAt: expect.any(String)
    });
    expect(JSON.stringify(cleanupState)).not.toContain("cleanup-secret");
  });

  it("validates and hash-binds known M2 artifact payloads before registration", async () => {
    const connectedClient = requireClient(client);
    const payload = productBriefPayload();
    const hash = artifactPayloadHash("product-brief", payload);
    const validated = await call(connectedClient, "artifact_validate", { kind: "product-brief", payload });
    expect(validated.structuredContent).toMatchObject({ kind: "product-brief", sha256: hash });

    const invalid = await call(connectedClient, "artifact_validate", {
      kind: "product-brief",
      payload: { ...payload, recommendedApproachId: "missing" }
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: "ARTIFACT_CONTRACT_INVALID" });

    const missingPayload = await call(connectedClient, "artifact_register", {
      artifactId: "brief-1",
      stageId: "S0",
      kind: "product-brief",
      uri: ".agentflow/artifacts/product-brief.json",
      sha256: hash,
      producedBy: "product-worker",
      ...mutation(0, "brief-missing-payload", "product-worker")
    });
    expect(missingPayload.isError).toBe(true);
    expect(missingPayload.structuredContent).toMatchObject({ error: "ARTIFACT_PAYLOAD_REQUIRED" });

    const registered = await call(connectedClient, "artifact_register", {
      artifactId: "brief-1",
      stageId: "S0",
      kind: "product-brief",
      uri: ".agentflow/artifacts/product-brief.json",
      sha256: hash,
      producedBy: "product-worker",
      payload,
      ...mutation(0, "brief-register", "product-worker")
    });
    expect(registered.isError, JSON.stringify(registered.structuredContent)).not.toBe(true);
    expect(runState(registered).artifacts["brief-1"]).toMatchObject({
      sha256: hash,
      metadata: { contract: { kind: "product-brief", version: 1 } }
    });

    const invalidPrd = prdPayload(sha256("wrong brief"));
    const invalidPrdRegistration = await call(connectedClient, "artifact_register", {
      artifactId: "prd-invalid",
      stageId: "S0",
      kind: "prd",
      uri: ".agentflow/artifacts/prd-invalid.json",
      sha256: artifactPayloadHash("prd", invalidPrd),
      producedBy: "product-worker",
      payload: invalidPrd,
      ...mutation(1, "prd-invalid-reference", "product-worker")
    });
    expect(invalidPrdRegistration.isError).toBe(true);
    expect(invalidPrdRegistration.structuredContent).toMatchObject({ error: "ARTIFACT_REFERENCE_INVALID" });

    const prd = prdPayload(hash);
    const registeredPrd = await call(connectedClient, "artifact_register", {
      artifactId: "prd-1",
      stageId: "S0",
      kind: "prd",
      uri: ".agentflow/artifacts/prd.json",
      sha256: artifactPayloadHash("prd", prd),
      producedBy: "product-worker",
      payload: prd,
      ...mutation(1, "prd-register", "product-worker")
    });
    expect(runState(registeredPrd).artifacts["prd-1"]?.kind).toBe("prd");
  });

  it("requires payloads for every known M3 artifact contract", async () => {
    const connectedClient = requireClient(client);
    for (const kind of [
      "architecture",
      "implementation-plan",
      "integration-report",
      "qa-report",
      "release-plan",
      "final-manifest"
    ]) {
      const result = await call(connectedClient, "artifact_register", {
        artifactId: `${kind}-missing-payload`,
        stageId: "S0",
        kind,
        uri: `.agentflow/artifacts/${kind}.json`,
        sha256: sha256(kind),
        producedBy: "delivery-worker",
        ...mutation(0, `missing-${kind}`, "delivery-worker")
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: "ARTIFACT_PAYLOAD_REQUIRED",
        details: { kind }
      });
    }
  });

  it("validates hash, kind, typed evidence, and the complete M3 lineage", async () => {
    const connectedClient = requireClient(client);
    await runGit(directory, ["init", "--initial-branch=main"]);
    await runGit(directory, ["config", "user.name", "AgentFlow Test"]);
    await runGit(directory, ["config", "user.email", "agentflow@example.test"]);
    await writeFile(join(directory, "README.md"), "# M3 lineage fixture\n", "utf8");
    await runGit(directory, ["add", "README.md"]);
    await runGit(directory, ["commit", "-m", "test: establish M3 lineage baseline"]);
    const planBaseRevision = await runGit(directory, ["rev-parse", "HEAD"]);
    const brief = productBriefPayload();
    const briefHash = artifactPayloadHash("product-brief", brief);
    let result = await registerContract(connectedClient, 0, "brief-1", "product-brief", brief);
    let state = runState(result);

    const prd = prdPayload(briefHash);
    const prdHash = artifactPayloadHash("prd", prd);
    result = await registerContract(connectedClient, state.revision, "prd-1", "prd", prd);
    state = runState(result);

    const designManifestHash = sha256("design manifest");
    result = await registerArtifact(
      connectedClient,
      state.revision,
      "design-manifest-1",
      "design-manifest",
      designManifestHash
    );
    state = runState(result);

    const architecture = architecturePayload(prdHash, designManifestHash);
    const invalidHash = await registerContract(
      connectedClient,
      state.revision,
      "architecture-invalid-hash",
      "architecture",
      architecturePayload(sha256("wrong prd"), designManifestHash)
    );
    expect(invalidHash.isError).toBe(true);
    expect(invalidHash.structuredContent).toMatchObject({
      error: "ARTIFACT_REFERENCE_INVALID",
      details: { artifactId: "prd-1", expectedKind: "prd", actualKind: "prd", actualHash: prdHash }
    });

    const invalidKind = await registerContract(
      connectedClient,
      state.revision,
      "architecture-invalid-kind",
      "architecture",
      architecturePayload(prdHash, briefHash, "brief-1")
    );
    expect(invalidKind.isError).toBe(true);
    expect(invalidKind.structuredContent).toMatchObject({
      error: "ARTIFACT_REFERENCE_INVALID",
      details: { artifactId: "brief-1", expectedKind: "design-manifest", actualKind: "product-brief" }
    });

    result = await registerContract(
      connectedClient,
      state.revision,
      "architecture-1",
      "architecture",
      architecture
    );
    state = runState(result);
    const architectureHash = artifactPayloadHash("architecture", architecture);
    expect(state.artifacts["architecture-1"]?.sha256).toBe(architectureHash);

    result = await registerContract(connectedClient, state.revision, "brief-2", "product-brief", brief);
    state = runState(result);
    const prd2 = {
      ...prdPayload(briefHash),
      sourceProductBrief: { artifactId: "brief-2", sha256: briefHash }
    };
    result = await registerContract(connectedClient, state.revision, "prd-2", "prd", prd2);
    state = runState(result);
    const prd2Hash = artifactPayloadHash("prd", prd2);
    const mismatchedPlan = await registerContract(
      connectedClient,
      state.revision,
      "implementation-plan-mismatched-lineage",
      "implementation-plan",
      implementationPlanPayload(architectureHash, prd2Hash, "prd-2", planBaseRevision)
    );
    expect(mismatchedPlan.isError).toBe(true);
    expect(mismatchedPlan.structuredContent).toMatchObject({
      error: "ARTIFACT_REFERENCE_INVALID",
      details: {
        artifactId: "architecture-1",
        fact: "sourcePrdArtifactId",
        expected: "prd-2",
        actual: "prd-1"
      }
    });

    const implementationPlan = implementationPlanPayload(architectureHash, prdHash, "prd-1", planBaseRevision);
    const wrongBaselinePlan = {
      ...implementationPlan,
      repository: { ...implementationPlan.repository, baseRevision: "f".repeat(40) }
    };
    const wrongBaselineResult = await registerContract(
      connectedClient,
      state.revision,
      "implementation-plan-wrong-baseline",
      "implementation-plan",
      wrongBaselinePlan
    );
    expect(wrongBaselineResult).toMatchObject({
      isError: true,
      structuredContent: { error: "PLAN_REPOSITORY_BASE_MISMATCH" }
    });
    const invalidTaskInput = {
      ...implementationPlan,
      tasks: [{
        ...implementationPlan.tasks[0],
        inputArtifacts: [{
          ...implementationPlan.tasks[0]?.inputArtifacts[0],
          kind: "prd"
        }]
      }]
    };
    const invalidTaskInputResult = await registerContract(
      connectedClient,
      state.revision,
      "implementation-plan-invalid-task-input",
      "implementation-plan",
      invalidTaskInput
    );
    expect(invalidTaskInputResult.isError).toBe(true);
    expect(invalidTaskInputResult.structuredContent).toMatchObject({
      error: "ARTIFACT_REFERENCE_INVALID",
      details: { artifactId: "architecture-1", expectedKind: "prd", actualKind: "architecture" }
    });

    result = await registerContract(
      connectedClient,
      state.revision,
      "implementation-plan-1",
      "implementation-plan",
      implementationPlan
    );
    state = runState(result);
    const implementationPlanHash = artifactPayloadHash("implementation-plan", implementationPlan);
    expect(state.artifacts["implementation-plan-1"]?.sha256).toBe(implementationPlanHash);

    result = await registerArtifact(
      connectedClient,
      state.revision,
      "spec-1",
      "spec",
      sha256("materialization spec")
    );
    state = runState(result);
    result = await call(connectedClient, "gate_resolve", {
      gateId: "review",
      decision: "approved",
      resolution: "Approve this exact implementation plan for materialization.",
      ...mutation(state.revision, "approve-materialization-plan", "user-1")
    });
    state = runState(result);
    result = await call(connectedClient, "stage_complete", {
      stageId: "S0",
      ...mutation(state.revision, "complete-plan-stage", "supervisor-1")
    });
    state = runState(result);
    result = await call(connectedClient, "stage_skip", {
      stageId: "S1",
      ...mutation(state.revision, "skip-ui-stage", "supervisor-1")
    });
    state = runState(result);
    result = await call(connectedClient, "implementation_plan_materialize", {
      artifactId: "implementation-plan-1",
      payload: implementationPlan,
      ...mutation(state.revision, "materialize-implementation-plan", "supervisor-1")
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    state = runState(result);
    expect(state.activeStageId).toBe("S2");
    expect(state.tasks["task-service"]).toMatchObject({
      status: "ready",
      profile: "backend",
      waveId: "wave-service",
      verificationCommands: ["npm test -- project-service"],
      inputArtifactKinds: {
        "architecture-1": "architecture",
        "implementation-plan-1": "implementation-plan"
      },
      materializedFrom: {
        artifactId: "implementation-plan-1",
        kind: "implementation-plan",
        sha256: implementationPlanHash
      }
    });

    const lineageEngine = new AgentFlowEngine(new JsonRunStore(projectPaths(directory).runsDirectory), pipeline);
    state = await lineageEngine.prepareTaskDispatch(state.id, {
      workerId: "worker-service",
      taskId: "task-service",
      adapter: "codex",
      hostTaskName: "lineage_service_worker",
      promptHash: "c".repeat(64),
      capabilities: {
        spawn: true,
        send: true,
        status: true,
        collect: true,
        interrupt: true,
        close: false
      },
      leaseSeconds: 900,
      workspace: { kind: "project", path: directory }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "lineage-prepare-service",
      actor: { id: "supervisor-1", kind: "supervisor" },
      reason: "Prepare the materialized lineage Task."
    });
    state = await lineageEngine.bindWorker(state.id, "worker-service", "codex-lineage-service", {
      expectedRevision: state.revision,
      idempotencyKey: "lineage-bind-service",
      actor: { id: "supervisor-1", kind: "supervisor" },
      reason: "Bind the lineage Task to a native identity."
    });
    const serviceRevision = sha256("service-revision");
    const serviceCompletedAt = new Date().toISOString();
    state = await lineageEngine.collectWorkerResult(state.id, "worker-service", {
      workerId: "worker-service",
      taskId: "task-service",
      status: "completed",
      summary: "Implemented the project service.",
      artifacts: [],
      changeSet: {
        kind: "git-commits",
        baseRevision: implementationPlan.repository.baseRevision,
        headRevision: serviceRevision,
        revisions: [serviceRevision],
        changedPaths: ["packages/service/src/projects/index.ts"]
      },
      verification: [{
        command: "npm test -- project-service",
        status: "passed",
        summary: "Project service tests passed",
        recordedAt: serviceCompletedAt
      }],
      risks: [],
      followUps: [],
      completedAt: serviceCompletedAt
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "lineage-collect-service",
      actor: { id: "supervisor-1", kind: "supervisor" },
      reason: "Collect the immutable service revision."
    });

    const integrationReport = integrationReportPayload(implementationPlanHash, planBaseRevision);
    result = await registerContract(
      connectedClient,
      state.revision,
      "integration-report-1",
      "integration-report",
      integrationReport
    );
    state = runState(result);
    const integrationReportHash = artifactPayloadHash("integration-report", integrationReport);
    expect(state.artifacts["integration-report-1"]).toMatchObject({
      sha256: integrationReportHash,
      metadata: { contract: { verdict: "passed", revision: sha256("integrated-revision") } }
    });

    result = await registerArtifact(
      connectedClient,
      state.revision,
      "qa-evidence",
      "test-report",
      sha256("qa-evidence")
    );
    state = runState(result);
    const qaReport = qaReportPayload(integrationReportHash);
    result = await registerContract(connectedClient, state.revision, "qa-report-1", "qa-report", qaReport);
    state = runState(result);
    const qaReportHash = artifactPayloadHash("qa-report", qaReport);
    expect(state.artifacts["qa-report-1"]?.sha256).toBe(qaReportHash);

    result = await registerArtifact(
      connectedClient,
      state.revision,
      "release-bundle",
      "release-bundle",
      sha256("release-bundle")
    );
    state = runState(result);
    const releasePlan = releasePlanPayload(qaReportHash);
    result = await registerContract(connectedClient, state.revision, "release-plan-1", "release-plan", releasePlan);
    state = runState(result);
    const releasePlanHash = artifactPayloadHash("release-plan", releasePlan);
    expect(state.artifacts["release-plan-1"]).toMatchObject({
      sha256: releasePlanHash,
      metadata: { contract: { releaseKind: "production" } }
    });

    result = await registerArtifact(
      connectedClient,
      state.revision,
      "deployment-log",
      "release-evidence",
      sha256("deployment-log")
    );
    state = runState(result);
    result = await registerArtifact(
      connectedClient,
      state.revision,
      "health-report",
      "release-evidence",
      sha256("health-report")
    );
    state = runState(result);

    const lineage = {
      architecture: { artifactId: "architecture-1", sha256: architectureHash },
      implementationPlan: { artifactId: "implementation-plan-1", sha256: implementationPlanHash },
      integrationReport: { artifactId: "integration-report-1", sha256: integrationReportHash },
      qaReport: { artifactId: "qa-report-1", sha256: qaReportHash },
      releasePlan: { artifactId: "release-plan-1", sha256: releasePlanHash }
    };
    const finalManifest = finalManifestPayload(lineage);
    const invalidEvidence = {
      ...finalManifest,
      releaseEvidence: [{ ...finalManifest.releaseEvidence[0], kind: "test-report" }]
    };
    const evidenceFailure = await registerContract(
      connectedClient,
      state.revision,
      "final-manifest-invalid-evidence",
      "final-manifest",
      invalidEvidence
    );
    expect(evidenceFailure.isError).toBe(true);
    expect(evidenceFailure.structuredContent).toMatchObject({
      error: "ARTIFACT_REFERENCE_INVALID",
      details: { artifactId: "deployment-log", expectedKind: "test-report", actualKind: "release-evidence" }
    });

    result = await registerContract(
      connectedClient,
      state.revision,
      "final-manifest-1",
      "final-manifest",
      finalManifest
    );
    expect(runState(result).artifacts["final-manifest-1"]).toMatchObject({
      kind: "final-manifest",
      sha256: artifactPayloadHash("final-manifest", finalManifest),
      metadata: { contract: { kind: "final-manifest", version: 1 } }
    });
  });

  it("rejects a stale M3 source even when its kind and hash match", async () => {
    const connectedClient = requireClient(client);
    const brief = productBriefPayload();
    const briefHash = artifactPayloadHash("product-brief", brief);
    let result = await registerContract(connectedClient, 0, "brief-1", "product-brief", brief, "S0");
    let state = runState(result);

    const prd = prdPayload(briefHash);
    const prdHash = artifactPayloadHash("prd", prd);
    result = await registerContract(connectedClient, state.revision, "prd-1", "prd", prd, "S0");
    state = runState(result);

    const architecture = architecturePayload(prdHash);
    const architectureHash = artifactPayloadHash("architecture", architecture);
    result = await registerContract(
      connectedClient,
      state.revision,
      "architecture-1",
      "architecture",
      architecture,
      "S1"
    );
    state = runState(result);
    expect(state.artifacts["architecture-1"]?.stale).toBe(false);

    const revisedPrd = { ...prd, summary: "Revised approved product requirements." };
    result = await registerContract(
      connectedClient,
      state.revision,
      "prd-1",
      "prd",
      revisedPrd,
      "S0",
      "register-prd-1-revised"
    );
    state = runState(result);
    expect(state.artifacts["architecture-1"]?.stale).toBe(true);

    const invalidPlan = await registerContract(
      connectedClient,
      state.revision,
      "implementation-plan-stale",
      "implementation-plan",
      implementationPlanPayload(architectureHash, artifactPayloadHash("prd", revisedPrd)),
      "S2"
    );
    expect(invalidPlan.isError).toBe(true);
    expect(invalidPlan.structuredContent).toMatchObject({
      error: "ARTIFACT_REFERENCE_INVALID",
      details: {
        artifactId: "architecture-1",
        expectedKind: "architecture",
        actualKind: "architecture",
        actualHash: architectureHash,
        stale: true
      }
    });
  });
});

function productBriefPayload() {
  return {
    version: 1,
    title: "Team planner",
    summary: "A focused planner for small teams.",
    projectType: "new",
    users: [{ name: "team lead", needs: ["shared priorities"], context: "weekly planning" }],
    problem: { statement: "Work context is scattered.", evidence: [], impact: "Delivery slows down." },
    outcomes: ["Teams see one current plan"],
    inScope: ["Projects and tasks"],
    outOfScope: ["Portfolio accounting"],
    constraints: [],
    successMetrics: [{ name: "planning time", target: "under 15 minutes", measurement: "session analytics" }],
    approaches: [
      { id: "A", summary: "Board first", benefits: ["Fast scanning"], costs: ["Limited reporting"] },
      { id: "B", summary: "List first", benefits: ["Dense data"], costs: ["Less spatial context"] }
    ],
    recommendedApproachId: "A",
    dependencies: [],
    risks: [],
    openQuestions: [],
    approvedDecisions: []
  };
}

function prdPayload(briefHash: string) {
  return {
    version: 1,
    title: "Team planner",
    summary: "Approved product requirements.",
    sourceProductBrief: { artifactId: "brief-1", sha256: briefHash },
    goals: ["Reduce planning time"],
    nonGoals: ["Enterprise portfolio management"],
    userStories: [{
      id: "story-1",
      actor: "team lead",
      capability: "create a project",
      benefit: "share one plan",
      acceptanceCriteria: ["A valid project appears"]
    }],
    functionalRequirements: [{
      id: "fr-1",
      description: "Create projects",
      priority: "must",
      acceptanceCriteria: ["Empty names are rejected"]
    }],
    nonFunctionalRequirements: [],
    constraints: [],
    dependencies: [],
    risks: [],
    openQuestions: []
  };
}

function architecturePayload(prdHash: string, designHash?: string, designArtifactId = "design-manifest-1") {
  return {
    version: 1,
    title: "Team planner architecture",
    summary: "A single service owns project behavior.",
    sourcePrd: { artifactId: "prd-1", sha256: prdHash },
    ...(designHash === undefined
      ? {}
      : { sourceDesignManifest: { artifactId: designArtifactId, sha256: designHash } }),
    principles: ["Keep project behavior behind one stable boundary"],
    components: [{
      id: "project-service",
      name: "Project service",
      kind: "service",
      responsibilities: ["Validate and persist projects"],
      requirementIds: ["fr-1"]
    }],
    interfaces: [],
    dataStores: [],
    decisions: [{
      id: "adr-1",
      title: "Centralize project behavior",
      decision: "Use one project service",
      rationale: "Keeps validation consistent",
      consequences: ["The service is a shared dependency"],
      status: "accepted"
    }],
    requirementCoverage: [{
      requirementId: "fr-1",
      componentIds: ["project-service"],
      verificationApproach: "Service and integration tests"
    }],
    risks: []
  };
}

function implementationPlanPayload(
  architectureHash: string,
  prdHash: string,
  prdArtifactId = "prd-1",
  baseRevision = sha256("base-revision")
) {
  return {
    version: 1,
    title: "Team planner implementation plan",
    summary: "Implement and verify the project service.",
    sourceArchitecture: { artifactId: "architecture-1", sha256: architectureHash },
    sourcePrd: { artifactId: prdArtifactId, sha256: prdHash },
    repository: { branch: "main", baseRevision },
    scope: { requirementIds: ["fr-1"], componentIds: ["project-service"] },
    tasks: [{
      id: "task-service",
      title: "Implement project service",
      description: "Validate and persist projects behind the service boundary.",
      profile: "backend",
      componentIds: ["project-service"],
      requirementIds: ["fr-1"],
      dependsOnTaskIds: [],
      inputArtifacts: [{ artifactId: "architecture-1", kind: "architecture", sha256: architectureHash }],
      writeScopes: ["packages/service/src/projects/**"],
      forbiddenScopes: ["packages/web/**"],
      acceptanceCriteria: ["A valid project is persisted"],
      verificationCommands: ["npm test -- project-service"],
      expectedOutputs: ["Project service implementation and tests"],
      requiresWorktree: false,
      risk: "low"
    }],
    waves: [{
      id: "wave-service",
      taskIds: ["task-service"],
      exitCriteria: ["Project service tests pass"]
    }],
    integrationStrategy: {
      taskOrder: ["task-service"],
      conflictPolicy: "The integration owner resolves shared contract changes.",
      verificationCommands: ["npm test", "npm run build"]
    }
  };
}

function integrationReportPayload(
  implementationPlanHash: string,
  baseRevision = sha256("base-revision")
) {
  return {
    version: 1,
    summary: "The planned service task was integrated and verified.",
    sourceImplementationPlan: {
      artifactId: "implementation-plan-1",
      sha256: implementationPlanHash
    },
    repository: {
      branch: "main",
      baseRevision,
      integratedRevision: sha256("integrated-revision")
    },
    planTaskIds: ["task-service"],
    taskResults: [{
      taskId: "task-service",
      status: "integrated",
      revisions: [sha256("service-revision")],
      outputArtifacts: [],
      verificationCheckIds: ["integration-check"]
    }],
    checks: [{
      id: "integration-check",
      category: "integration",
      command: "npm test",
      required: true,
      status: "passed",
      summary: "Integration tests passed",
      recordedAt: "2026-07-15T09:00:00.000Z",
      evidenceArtifacts: []
    }],
    conflicts: [],
    issues: [],
    verdict: "passed"
  };
}

function qaReportPayload(integrationReportHash: string) {
  const evidence = artifactReference("qa-evidence", "test-report");
  return {
    version: 1,
    summary: "Required functional and security coverage passed.",
    sourceIntegrationReport: { artifactId: "integration-report-1", sha256: integrationReportHash },
    environment: {
      name: "staging",
      revision: sha256("integrated-revision"),
      baseUrl: "https://staging.example.test"
    },
    requirementIds: ["fr-1"],
    testCases: [{
      id: "qa-fr-1",
      name: "Create a project",
      category: "functional",
      requirementIds: ["fr-1"],
      required: true,
      status: "passed",
      observedResult: "A valid project was persisted.",
      recordedAt: "2026-07-15T09:05:00.000Z",
      evidenceArtifacts: [evidence]
    }],
    qualityGates: [{
      id: "qa-security",
      name: "Security baseline",
      category: "security",
      required: true,
      status: "passed",
      summary: "No release-blocking findings",
      recordedAt: "2026-07-15T09:10:00.000Z",
      evidenceArtifacts: [evidence]
    }],
    findings: [],
    verdict: "passed"
  };
}

function releasePlanPayload(qaReportHash: string) {
  return {
    version: 1,
    summary: "Deploy one immutable build with monitored rollback.",
    sourceQaReport: { artifactId: "qa-report-1", sha256: qaReportHash },
    qaVerdict: "passed",
    release: {
      id: "release-1",
      version: "1.0.0",
      targetEnvironment: "production",
      revision: sha256("integrated-revision")
    },
    releaseArtifacts: [artifactReference("release-bundle", "release-bundle")],
    preflightChecks: [{
      id: "preflight-backup",
      description: "Verify a current database backup",
      required: true,
      status: "passed",
      checkedAt: "2026-07-15T09:20:00.000Z",
      evidenceArtifacts: []
    }],
    rolloutSteps: [{
      id: "deploy-production",
      description: "Deploy the verified release",
      dependsOnStepIds: [],
      verificationCommands: ["check production health"]
    }],
    rollback: {
      owner: "release-owner",
      targetRevision: sha256("base-revision"),
      triggers: ["Error rate exceeds the release threshold"],
      steps: ["Restore the previous immutable release"],
      verificationCommands: ["check production health"]
    },
    monitoring: {
      owner: "on-call",
      observationWindowMinutes: 30,
      signals: [{
        id: "error-rate",
        name: "HTTP error rate",
        threshold: "Less than two percent",
        response: "Stop rollout and roll back"
      }]
    },
    knownRisks: [],
    readiness: "ready"
  };
}

function artifactReference(artifactId: string, kind: string) {
  return { artifactId, kind, sha256: sha256(artifactId) };
}

function finalManifestPayload(lineage: {
  architecture: { artifactId: string; sha256: string };
  implementationPlan: { artifactId: string; sha256: string };
  integrationReport: { artifactId: string; sha256: string };
  qaReport: { artifactId: string; sha256: string };
  releasePlan: { artifactId: string; sha256: string };
}) {
  return {
    version: 1,
    summary: "Release 1.0.0 is deployed and healthy.",
    lineage,
    release: {
      id: "release-1",
      version: "1.0.0",
      targetEnvironment: "production",
      revision: sha256("integrated-revision"),
      releasedAt: "2026-07-15T09:30:00.000Z",
      outcome: "succeeded"
    },
    deployedArtifacts: [{
      artifactId: "release-bundle",
      kind: "release-bundle",
      sha256: sha256("release-bundle")
    }],
    releaseEvidence: [{
      artifactId: "deployment-log",
      kind: "release-evidence",
      sha256: sha256("deployment-log")
    }],
    healthChecks: [{
      id: "production-health",
      name: "Production health",
      status: "passed",
      checkedAt: "2026-07-15T09:35:00.000Z",
      summary: "Health indicators are within thresholds",
      evidenceArtifacts: [{
        artifactId: "health-report",
        kind: "release-evidence",
        sha256: sha256("health-report")
      }]
    }],
    incidents: []
  };
}

async function registerContract(
  client: Client,
  expectedRevision: number,
  artifactId: string,
  kind: ArtifactContractKind,
  payload: unknown,
  stageId = "S0",
  idempotencyKey = `register-${artifactId}`
) {
  return call(client, "artifact_register", {
    artifactId,
    stageId,
    kind,
    uri: `.agentflow/artifacts/${artifactId}.json`,
    sha256: artifactPayloadHash(kind, payload),
    producedBy: "delivery-worker",
    payload,
    ...mutation(expectedRevision, idempotencyKey, "delivery-worker")
  });
}

async function registerArtifact(
  client: Client,
  expectedRevision: number,
  artifactId: string,
  kind: string,
  hash: string,
  stageId = "S0"
) {
  return call(client, "artifact_register", {
    artifactId,
    stageId,
    kind,
    uri: `.agentflow/artifacts/${artifactId}`,
    sha256: hash,
    producedBy: "delivery-worker",
    ...mutation(expectedRevision, `register-${artifactId}`, "delivery-worker")
  });
}

function mutation(
  expectedRevision: number,
  idempotencyKey: string,
  actorId: string,
  runId = "run-contract"
): Record<string, unknown> {
  return {
    runId,
    expectedRevision,
    idempotencyKey,
    actorId,
    reason: `contract test: ${idempotencyKey}`
  };
}

async function initializeProject(root: string, pipelineId: string, runId: string): Promise<void> {
  const paths = projectPaths(root);
  const projectPipeline = validatePipeline({
    ...pipeline,
    id: pipelineId,
    name: `Dynamic ${pipelineId}`
  });
  await mkdir(paths.agentflowDirectory, { recursive: true });
  await writeFile(paths.pipelinePath, stringifyYaml(projectPipeline), "utf8");
  await writeFile(paths.configPath, stringifyYaml({
    version: 1,
    pipeline: "pipeline.yaml",
    runsDirectory: "runs"
  }), "utf8");
  const engine = new AgentFlowEngine(new JsonRunStore(paths.runsDirectory), projectPipeline);
  await engine.createRun({ id: runId, requirement: `Exercise ${pipelineId}`, hasUi: false });
  await writeFile(paths.currentRunPath, `${JSON.stringify({ runId }, null, 2)}\n`, "utf8");
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  return client.callTool({
    name,
    arguments: args ?? {}
  });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return String(result.stdout).trim();
}

function runState(result: Awaited<ReturnType<typeof call>>): RunState {
  return result.structuredContent as unknown as RunState;
}

function requireClient(value: Client | undefined): Client {
  if (!value) throw new Error("MCP client is not connected");
  return value;
}
