import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@agentflow/core";
import {
  assertProjectInitialized,
  startOrResumeRun,
  type ProjectLifecycleCheckpoint,
  type StartOrResumeRunInput
} from "../src/project-lifecycle.js";
import { projectPaths } from "../src/runtime.js";

const request: StartOrResumeRunInput = {
  requirement: "Build a globally routed AgentFlow project",
  projectType: "new",
  hasUi: false,
  requestKey: "request-1"
};

describe("project lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentflow-lifecycle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps read-only inspection non-mutating", async () => {
    const paths = projectPaths(root);

    await expect(assertProjectInitialized(paths)).rejects.toMatchObject({
      code: "PROJECT_NOT_INITIALIZED",
      details: { projectRoot: root }
    });
    await expect(lstat(paths.agentflowDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates only lightweight control and state files", async () => {
    const paths = projectPaths(root);
    const result = await startOrResumeRun(paths, {
      ...request,
      requestedRunId: "lazy-run"
    });

    expect(result).toMatchObject({
      action: "started",
      projectRoot: root,
      initialized: true,
      state: {
        id: "lazy-run",
        requirement: request.requirement,
        projectType: "new",
        hasUi: false,
        status: "active"
      }
    });
    await expect(assertProjectInitialized(paths)).resolves.toBeUndefined();

    const entries = await tree(root);
    expect(entries).toEqual(expect.arrayContaining([
      ".agentflow/.gitignore",
      ".agentflow/config.yaml",
      ".agentflow/current-run.json",
      ".agentflow/pipeline.yaml",
      ".agentflow/runs/lazy-run/state.json"
    ]));
    expect(entries.filter((entry) => entry.startsWith(".agentflow/start-requests/"))).toHaveLength(1);
    expect(entries).not.toContain(".gitignore");
    expect(entries.some((entry) => entry.startsWith(".agentflow/runtime/"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith(".agents/"))).toBe(false);

    const nestedIgnore = await readFile(paths.ignorePath, "utf8");
    for (const ignored of [
      "runtime/",
      "runs/",
      "current-run.json",
      ".start.lock",
      ".start.pending.json",
      "start-requests/",
      "*.tmp"
    ]) {
      expect(nestedIgnore).toContain(ignored);
    }
    await expect(lstat(join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent first use into one active Run", async () => {
    const paths = projectPaths(root);
    const [first, second] = await Promise.all([
      startOrResumeRun(paths, { ...request, requestKey: "concurrent-a", requestedRunId: "run-a" }),
      startOrResumeRun(paths, { ...request, requestKey: "concurrent-b", requestedRunId: "run-b" })
    ]);

    expect(new Set([first.state.id, second.state.id]).size).toBe(1);
    expect([first.action, second.action].sort()).toEqual(["resumed", "started"]);
    const runDirectories = await readdir(paths.runsDirectory, { withFileTypes: true });
    expect(runDirectories.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toHaveLength(1);
  });

  it("replays one request key and rejects immutable input conflicts", async () => {
    const paths = projectPaths(root);
    const first = await startOrResumeRun(paths, { ...request, requestedRunId: "stable-run" });
    const replay = await startOrResumeRun(paths, { ...request, requestedRunId: "stable-run" });

    expect(replay).toMatchObject({ action: "started", initialized: false, state: { id: first.state.id } });
    await expect(startOrResumeRun(paths, {
      ...request,
      requirement: "A different immutable requirement",
      requestedRunId: "stable-run"
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("resumes unfinished work and starts a new Run after completion", async () => {
    const paths = projectPaths(root);
    const first = await startOrResumeRun(paths, { ...request, requestedRunId: "first-run" });
    const resumed = await startOrResumeRun(paths, {
      ...request,
      requirement: "Continue with another changing request",
      requestKey: "request-2",
      requestedRunId: "ignored-while-active"
    });
    expect(resumed).toMatchObject({ action: "resumed", state: { id: first.state.id } });

    const statePath = join(paths.runsDirectory, first.state.id, "state.json");
    const completed = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    completed["status"] = "completed";
    delete completed["activeStageId"];
    await writeFile(statePath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");

    const next = await startOrResumeRun(paths, {
      ...request,
      requirement: "Start the next completed-project change",
      requestKey: "request-3",
      requestedRunId: "second-run"
    });
    expect(next).toMatchObject({ action: "started", state: { id: "second-run" } });
  });

  it.each<ProjectLifecycleCheckpoint>([
    "after-journal",
    "after-run-created",
    "after-current-pointer",
    "before-request-record"
  ])("recovers one Run after interruption at %s", async (checkpoint) => {
    const paths = projectPaths(root);
    const interrupted = { ...request, requestedRunId: "recover-run" };
    await expect(startOrResumeRun(paths, interrupted, {
      faultInjector: async (observed) => {
        if (observed === checkpoint) throw new Error(`interrupted at ${checkpoint}`);
      }
    })).rejects.toThrow(`interrupted at ${checkpoint}`);

    const recovered = await startOrResumeRun(paths, interrupted);
    expect(recovered).toMatchObject({ action: "started", state: { id: "recover-run" } });
    await expect(lstat(paths.startPendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    const runDirectories = await readdir(paths.runsDirectory, { withFileTypes: true });
    expect(runDirectories.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
      .toEqual(["recover-run"]);
  });

  it("rejects a pending journal whose immutable input hash was changed", async () => {
    const paths = projectPaths(root);
    const interrupted = { ...request, requestedRunId: "tamper-run" };
    await expect(startOrResumeRun(paths, interrupted, {
      faultInjector: async (checkpoint) => {
        if (checkpoint === "after-journal") throw new Error("leave the journal pending");
      }
    })).rejects.toThrow("leave the journal pending");

    const pending = JSON.parse(await readFile(paths.startPendingPath, "utf8")) as Record<string, unknown>;
    pending["inputHash"] = sha256("changed immutable input");
    await writeFile(paths.startPendingPath, `${JSON.stringify(pending, null, 2)}\n`, "utf8");

    await expect(startOrResumeRun(paths, interrupted)).rejects.toMatchObject({
      code: "PROJECT_START_JOURNAL_INVALID"
    });
  });

  it("rejects a request record whose key hash does not match its filename", async () => {
    const paths = projectPaths(root);
    await startOrResumeRun(paths, { ...request, requestedRunId: "record-run" });
    const recordPath = join(paths.startRequestsDirectory, `${sha256(request.requestKey)}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    record["keyHash"] = sha256("another request key");
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await expect(startOrResumeRun(paths, { ...request, requestedRunId: "record-run" }))
      .rejects.toMatchObject({ code: "PROJECT_START_REQUEST_INVALID" });
  });

  it("reclaims a stale start lock", async () => {
    const paths = projectPaths(root);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.startLockPath, "stale", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.startLockPath, old, old);

    await expect(startOrResumeRun(paths, { ...request, requestedRunId: "after-stale-lock" }, {
      staleLockMs: 10,
      lockTimeoutMs: 200,
      lockRetryMs: 5
    })).resolves.toMatchObject({ action: "started" });
  });

  it("times out without stealing a live start lock", async () => {
    const paths = projectPaths(root);
    await mkdir(paths.agentflowDirectory, { recursive: true });
    await writeFile(paths.startLockPath, "live", "utf8");

    await expect(startOrResumeRun(paths, request, {
      staleLockMs: 60_000,
      lockTimeoutMs: 30,
      lockRetryMs: 5
    })).rejects.toMatchObject({ code: "PROJECT_START_LOCK_TIMEOUT" });
  });

  it.each([
    ["config", "PROJECT_CONFIG_INVALID"],
    ["pipeline", "PROJECT_PIPELINE_INVALID"],
    ["pointer", "CURRENT_RUN_INVALID"],
    ["journal", "PROJECT_START_JOURNAL_INVALID"],
    ["request", "PROJECT_START_REQUEST_INVALID"]
  ])("fails closed for an invalid %s file", async (kind, code) => {
    const paths = projectPaths(root);
    await startOrResumeRun(paths, { ...request, requestedRunId: "valid-run" });

    if (kind === "config") await writeFile(paths.configPath, "version: nope\n", "utf8");
    if (kind === "pipeline") await writeFile(paths.pipelinePath, "stages: nope\n", "utf8");
    if (kind === "pointer") await writeFile(paths.currentRunPath, "{not-json", "utf8");
    if (kind === "journal") await writeFile(paths.startPendingPath, "{not-json", "utf8");
    if (kind === "request") {
      const recordPath = join(paths.startRequestsDirectory, `${sha256(request.requestKey)}.json`);
      await writeFile(recordPath, "{not-json", "utf8");
    }

    await expect(startOrResumeRun(paths, {
      ...request,
      requestKey: kind === "request" ? request.requestKey : `invalid-${kind}`
    })).rejects.toMatchObject({ code });
  });
});

async function tree(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else entries.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  await visit(root);
  return entries.sort();
}
