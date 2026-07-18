import { describe, expect, it } from "vitest";
import {
  AgentFlowEngine,
  JsonRunStore,
  canonicalJson,
  defaultPipeline,
  migrateRunState
} from "../src/index.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Run state migration", () => {
  it("migrates a completed 0.4.0 snapshot without changing durable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentflow-migration-"));
    try {
      const engine = new AgentFlowEngine(new JsonRunStore(directory), defaultPipeline);
      const created = await engine.createRun({ id: "run-legacy-migration", requirement: "Migrate legacy state" });
      const path = join(directory, created.id, "state.json");
      const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & {
        stages: Record<string, Record<string, unknown>>;
        workers: Record<string, unknown>;
      };
      legacy.status = "completed";
      delete legacy.schemaVersion;
      delete legacy.executionStatus;
      delete legacy.businessOutcome;
      delete legacy.activeStageId;
      legacy.stages.S00 = {
        ...legacy.stages.S00,
        status: "completed",
        completedAt: created.updatedAt
      };
      legacy.workers["worker-terminal"] = {
        id: "worker-terminal",
        taskId: "task-terminal",
        adapter: "codex",
        hostTaskName: "legacy_task",
        promptHash: "a".repeat(64),
        externalThreadId: "thread-terminal",
        status: "completed",
        capabilities: {
          spawn: true,
          send: true,
          status: true,
          collect: true,
          interrupt: true,
          close: true
        },
        result: {
          workerId: "worker-terminal",
          taskId: "task-terminal",
          status: "completed",
          summary: "Legacy result",
          artifacts: [],
          changeSet: null,
          verification: [],
          risks: [],
          followUps: [],
          completedAt: created.updatedAt
        },
        createdAt: created.createdAt,
        updatedAt: created.updatedAt
      };

      const migrated = migrateRunState(legacy);

      expect(migrated.schemaVersion).toBe(2);
      expect(migrated.executionStatus).toBe("terminal");
      expect(migrated.businessOutcome).toBe("succeeded");
      expect(migrated.workers["worker-terminal"]).toMatchObject({
        adapterVersion: "1",
        contextPolicy: { mode: "unknown" },
        cleanup: {
          resultCollectedAt: created.updatedAt,
          close: { status: "pending" },
          archive: { status: "pending" },
          permitRelease: { status: "pending" }
        }
      });
      expect(migrated.events).toEqual(legacy.events);
      expect(migrated.gates).toEqual(legacy.gates);
      expect(migrated.artifacts).toEqual(legacy.artifacts);
      expect(canonicalJson(migrateRunState(migrated))).toBe(canonicalJson(migrated));

      await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
      await expect(new JsonRunStore(directory).load(created.id)).resolves.toEqual(migrated);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates cancelled Runs to a truthful terminal outcome", () => {
    const now = new Date().toISOString();
    const migrated = migrateRunState({
      id: "run-cancelled",
      pipelineId: "agentflow-default",
      pipelineVersion: "0.4.0",
      requirement: "Cancel safely",
      projectType: "existing",
      hasUi: false,
      status: "cancelled",
      revision: 3,
      stages: { S00: { id: "S00", status: "completed", startedAt: now, completedAt: now } },
      tasks: {},
      workers: {},
      resources: {},
      artifacts: {},
      gates: {},
      events: [],
      idempotency: {},
      createdAt: now,
      updatedAt: now
    });

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      executionStatus: "terminal",
      businessOutcome: "cancelled"
    });
  });
});
