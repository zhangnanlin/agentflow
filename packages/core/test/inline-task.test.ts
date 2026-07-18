import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentFlowEngine, JsonRunStore, defaultPipeline } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function materializedTask(id: string) {
  const directory = await mkdtemp(join(tmpdir(), "agentflow-inline-claim-"));
  directories.push(directory);
  const store = new JsonRunStore(directory);
  const engine = new AgentFlowEngine(store, defaultPipeline);
  let state = await engine.createRun({ id, requirement: "Inline worktree", hasUi: false });
  state = await engine.createTask(state.id, {
    id: "task-inline",
    stageId: "S00",
    title: "Inline",
    writeScopes: ["packages/core"],
    acceptanceCriteria: ["Complete"],
    verificationCommands: ["verify"],
    expectedOutputs: ["commit"],
    requiresWorktree: true
  }, {
    expectedRevision: state.revision,
    idempotencyKey: "create",
    actor: { id: "supervisor-root", kind: "supervisor" }
  });
  const path = join(directory, state.id, "state.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as { tasks: Record<string, Record<string, unknown>> };
  raw.tasks["task-inline"] = {
    ...raw.tasks["task-inline"],
    materializedFrom: { artifactId: "plan", kind: "implementation-plan", sha256: "c".repeat(64) },
    planRepository: { branch: "main", baseRevision: "a".repeat(40) }
  };
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return { directory, engine, state: await engine.loadRun(state.id) };
}

describe("Supervisor inline Task ownership", () => {
  it("claims and binds an approved worktree without creating a Worker", async () => {
    const { directory, engine, state } = await materializedTask("run-inline-claim");
    const worktree = join(directory, "worktree");
    const claimed = await engine.claimInlineTask(state.id, {
      taskId: "task-inline",
      leaseSeconds: 900,
      workspace: {
        kind: "worktree",
        path: worktree,
        branch: "codex/task-inline",
        baseRevision: "a".repeat(40)
      }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "claim-inline",
      actor: { id: "supervisor-root", kind: "supervisor" }
    });

    expect(claimed.tasks["task-inline"]).toMatchObject({
      status: "running",
      owner: "supervisor-root",
      ownerKind: "supervisor",
      workspace: {
        kind: "worktree",
        path: worktree,
        branch: "codex/task-inline",
        baseRevision: "a".repeat(40)
      }
    });
    expect(claimed.workers).toEqual({});
  });

  it("rejects a project checkout for a Task that requires a worktree", async () => {
    const { directory, engine, state } = await materializedTask("run-inline-reject");
    await expect(engine.claimInlineTask(state.id, {
      taskId: "task-inline",
      leaseSeconds: 900,
      workspace: { kind: "project", path: directory }
    }, {
      expectedRevision: state.revision,
      idempotencyKey: "claim-inline",
      actor: { id: "supervisor-root", kind: "supervisor" }
    })).rejects.toMatchObject({ code: "TASK_WORKTREE_REQUIRED" });
  });
});
