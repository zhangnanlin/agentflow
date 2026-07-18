import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOrResumeRun } from "../src/project-lifecycle.js";
import { createEngine, projectPaths } from "../src/runtime.js";

vi.mock("@agentflow/core", async () => import("../../core/src/index.js"));

const baseRequest = {
  requirement: "Implement compact and intelligent MCP orchestration",
  projectType: "existing" as const,
  hasUi: false,
  requestKey: "initial-request"
};

describe("project lifecycle v2 intent and lock semantics", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentflow-project-v2-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["Fix one isolated parser", "existing", false, "quick", ["low-risk"]],
    ["Update multiple modules without changing a public contract", "existing", false, "standard", ["standard-scope"]],
    ["Create a new command line service", "new", false, "standard", ["new-project"]],
    ["Perform a database migration", "existing", false, "full", ["migration"]],
    ["Refresh the application screen", "existing", true, "full", ["ui"]],
    ["agentflow:full fix one isolated parser", "existing", false, "full", ["full-override"]]
  ] as const)("starts %s in the %s lane", async (requirement, projectType, hasUi, lane, signals) => {
    const started = await startOrResumeRun(projectPaths(root), {
      requirement,
      projectType,
      hasUi,
      requestKey: `lane-${lane}`
    });

    expect(started).toMatchObject({
      action: "started",
      state: {
        workflow: {
          lane,
          policyVersion: "2026-07-18.1",
          signals
        }
      }
    });
  });

  it("recreates the same adaptive lane while recovering a start journal", async () => {
    const paths = projectPaths(root);
    await expect(startOrResumeRun(paths, {
      requirement: "Update multiple modules without changing a public contract",
      projectType: "existing",
      hasUi: false,
      requestKey: "recover-standard-lane"
    }, {
      faultInjector: (checkpoint) => {
        if (checkpoint === "after-journal") throw new Error("simulated crash after journal");
      }
    })).rejects.toThrow("simulated crash after journal");

    const recovered = await startOrResumeRun(paths, {
      requirement: "Update multiple modules without changing a public contract",
      projectType: "existing",
      hasUi: false,
      requestKey: "recover-standard-lane"
    });
    expect(recovered).toMatchObject({
      action: "started",
      state: { workflow: { lane: "standard", signals: ["standard-scope"] } }
    });
  });

  it("resumes the same normalized implicit intent", async () => {
    const paths = projectPaths(root);
    const started = await startOrResumeRun(paths, {
      ...baseRequest,
      requestedRunId: "normalized-run"
    });
    const resumed = await startOrResumeRun(paths, {
      ...baseRequest,
      requirement: "  implement   COMPACT and intelligent mcp orchestration  ",
      requestKey: "normalized-retry"
    });

    expect(resumed).toMatchObject({ action: "resumed", state: { id: started.state.id } });
  });

  it("returns compact actions instead of an unrelated active Run", async () => {
    const paths = projectPaths(root);
    await startOrResumeRun(paths, { ...baseRequest, requestedRunId: "active-run" });

    const conflict = await startOrResumeRun(paths, {
      ...baseRequest,
      requirement: "Publish an unrelated package release",
      requestKey: "unrelated-implicit-request"
    });

    expect(conflict).toMatchObject({
      action: "conflict",
      projectRoot: paths.projectRoot,
      conflict: {
        code: "ACTIVE_RUN_INTENT_CONFLICT",
        activeRunId: "active-run",
        actions: expect.arrayContaining([
          expect.objectContaining({ action: "resume", requestedRunId: "active-run" }),
          expect.objectContaining({ action: "cancel", tool: "run_cancel" }),
          expect.objectContaining({ action: "supersede", tool: "run_supersede" })
        ])
      }
    });
    expect(conflict).not.toHaveProperty("state");
    expect(Buffer.byteLength(JSON.stringify(conflict), "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("resumes an explicitly requested existing Run instead of the current Run", async () => {
    const paths = projectPaths(root);
    const current = await startOrResumeRun(paths, { ...baseRequest, requestedRunId: "current-run" });
    const engine = await createEngine(paths);
    await engine.createRun({
      id: "requested-run",
      requirement: "A separately tracked change",
      projectType: "existing",
      hasUi: false
    });

    const resumed = await startOrResumeRun(paths, {
      requirement: "A separately tracked change",
      projectType: "existing",
      hasUi: false,
      requestedRunId: "requested-run",
      requestKey: "resume-requested-run"
    });

    expect(current.state.id).toBe("current-run");
    expect(resumed).toMatchObject({ action: "resumed", state: { id: "requested-run" } });
    expect(JSON.parse(await readFile(paths.currentRunPath, "utf8"))).toEqual({ runId: "requested-run" });
  });

  it("starts a new Run after an audited blocked terminal outcome", async () => {
    const paths = projectPaths(root);
    const started = await startOrResumeRun(paths, { ...baseRequest, requestedRunId: "blocked-run" });
    if (started.action !== "started") throw new Error("Expected the fixture Run to start");
    const engine = await createEngine(paths);
    await engine.blockRun(started.state.id, "External dependency is unavailable", {
      expectedRevision: started.state.revision,
      idempotencyKey: "block-terminal-run",
      actor: { id: "supervisor", kind: "supervisor" },
      reason: "Exercise terminal blocked lifecycle"
    });

    const next = await startOrResumeRun(paths, {
      ...baseRequest,
      requirement: "Start unrelated work after the blocked outcome",
      requestedRunId: "after-blocked-run",
      requestKey: "after-blocked-request"
    });
    expect(next).toMatchObject({ action: "started", state: { id: "after-blocked-run" } });
  });

  it("heartbeats a live start lock so a waiter cannot retire it as stale", async () => {
    const paths = projectPaths(root);
    let releaseCheckpoint!: () => void;
    let enteredCheckpoint!: () => void;
    const checkpointEntered = new Promise<void>((resolve) => { enteredCheckpoint = resolve; });
    const checkpointRelease = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });

    const holder = startOrResumeRun(paths, {
      ...baseRequest,
      requestedRunId: "heartbeat-holder"
    }, {
      staleLockMs: 20,
      lockTimeoutMs: 1_000,
      lockRetryMs: 2,
      faultInjector: async (checkpoint) => {
        if (checkpoint === "after-journal") {
          enteredCheckpoint();
          await checkpointRelease;
        }
      }
    });
    await checkpointEntered;
    await new Promise((resolve) => setTimeout(resolve, 60));

    await expect(startOrResumeRun(paths, {
      ...baseRequest,
      requestKey: "heartbeat-waiter"
    }, {
      staleLockMs: 20,
      lockTimeoutMs: 40,
      lockRetryMs: 2
    })).rejects.toMatchObject({ code: "PROJECT_START_LOCK_TIMEOUT" });

    releaseCheckpoint();
    await expect(holder).resolves.toMatchObject({ action: "started", state: { id: "heartbeat-holder" } });
  });

  it("does not let late stale-lock reclaimers move a replacement generation", async () => {
    const paths = projectPaths(root);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.startLockPath, "stale-generation", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.startLockPath, old, old);
    const dependencies = { staleLockMs: 20, lockTimeoutMs: 10_000, lockRetryMs: 1 };

    const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (
      startOrResumeRun(paths, {
        ...baseRequest,
        requestKey: `reclaimer-${index}`
      }, dependencies)
    )));
    expect(
      settled.every((result) => result.status === "fulfilled"),
      JSON.stringify(settled.map((result) => result.status === "rejected"
        ? { status: result.status, reason: String(result.reason) }
        : { status: result.status, action: result.value.action }))
    ).toBe(true);
    const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

    expect(new Set(results.map((result) => result.action === "conflict"
      ? result.conflict.activeRunId
      : result.state.id))).toHaveLength(1);
    const runDirectories = await readdir(paths.runsDirectory, { withFileTypes: true });
    expect(runDirectories.filter((entry) => entry.isDirectory())).toHaveLength(1);
  });
});
