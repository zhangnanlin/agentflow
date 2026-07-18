import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareSkillDiscoveryCandidates,
  hashSkillDirectory,
  hashSkillFile,
  validateSkillPolicyLock
} from "../src/skill-policy.js";

const temporaryDirectories: string[] = [];

async function temporarySkillsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentflow-skill-policy-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeSkill(
  skillsRoot: string,
  name: string,
  files: Record<string, string>
): Promise<string> {
  const skillRoot = join(skillsRoot, name);
  for (const [path, content] of Object.entries(files)) {
    const target = join(skillRoot, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return skillRoot;
}

function reviewedLock(
  contentSha256: string,
  scriptSha256: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    updatePolicy: "manual-review-only",
    dependencies: [{
      id: "obra-superpowers",
      organization: "obra",
      repository: "https://github.com/obra/superpowers.git",
      commit: "d884ae04edebef577e82ff7c4e143debd0bbec99",
      license: "MIT",
      sourceMode: "external-host",
      reviewedAt: "2026-07-15",
      skills: [{
        name: "subagent-driven-development",
        activation: "orchestration",
        contentSha256,
        entrypoint: "SKILL.md",
        scriptScope: [{ path: "scripts/task-brief", sha256: scriptSha256 }],
        toolScope: [
          "filesystem.read",
          "filesystem.write",
          "git.read",
          "git.write",
          "host.worker.collect",
          "host.worker.spawn",
          "test.run"
        ],
        audits: { agentTrustHub: "pass", socket: "pass", snyk: "pass" },
        approval: {
          status: "approved",
          reviewedBy: "agentflow-maintainers",
          reviewedAt: "2026-07-15"
        },
        adapterCompatibility: ["codex", "cursor", "vscode"],
        restrictions: [
          "core-safety-precedence",
          "manual-updates-only",
          "no-supervisor-history"
        ],
        policyRules: [
          "compact-results",
          "durable-progress",
          "focused-task-briefs",
          "fresh-context",
          "isolated-worktrees"
        ],
        ...overrides
      }]
    }]
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("content-addressed Skill policy", () => {
  it("accepts reviewed local bytes and emits bounded Core-subordinate policy", async () => {
    const skillsRoot = await temporarySkillsRoot();
    const script = "#!/usr/bin/env bash\nprintf 'brief\\n'\n";
    const skillRoot = await writeSkill(skillsRoot, "subagent-driven-development", {
      "SKILL.md": "---\nname: subagent-driven-development\n---\nUse scripts/task-brief for bounded handoff.\n",
      "scripts/task-brief": script
    });
    const contentSha256 = await hashSkillDirectory(skillRoot);
    const scriptSha256 = await hashSkillFile(join(skillRoot, "scripts", "task-brief"));

    const result = await validateSkillPolicyLock(
      reviewedLock(contentSha256, scriptSha256),
      { skillsRoot, host: "codex" }
    );

    expect(result).toEqual({
      schemaVersion: 2,
      updatePolicy: "manual-review-only",
      policies: [{
        id: "obra-superpowers/subagent-driven-development@d884ae04edebef577e82ff7c4e143debd0bbec99",
        source: {
          organization: "obra",
          repository: "https://github.com/obra/superpowers.git",
          revision: "d884ae04edebef577e82ff7c4e143debd0bbec99",
          license: "MIT",
          contentSha256
        },
        adapterCompatibility: ["codex", "cursor", "vscode"],
        restrictions: [
          "core-safety-precedence",
          "manual-updates-only",
          "no-supervisor-history"
        ],
        policyRules: [
          "compact-results",
          "durable-progress",
          "focused-task-briefs",
          "fresh-context",
          "isolated-worktrees"
        ],
        precedence: {
          mandatoryGates: "core",
          hostBudgets: "core",
          isolation: "core",
          pathScopes: "core",
          terminalCleanup: "core"
        },
        reviewedToolScope: [
          "filesystem.read",
          "filesystem.write",
          "git.read",
          "git.write",
          "host.worker.collect",
          "host.worker.spawn",
          "test.run"
        ],
        reviewedScripts: ["scripts/task-brief"]
      }]
    });
  });

  it.each([
    ["mutable revision", { commit: "main" }, "immutable"],
    ["missing license", { license: "unknown" }, "license"],
    ["hash mismatch", { contentSha256: "0".repeat(64) }, "content SHA-256"],
    ["wildcard tool", { toolScope: ["*"] }, "tool scope"],
    ["unsafe entrypoint", { entrypoint: "C:SKILL.md" }, "safe portable"],
    ["unreviewed script", { scriptScope: [] }, "Skill script"],
    ["failed audit", { audits: { socket: "warn" } }, "audit"],
    ["missing approval", { approval: { status: "pending" } }, "approval"],
    ["missing restrictions", { restrictions: [] }, "restrictions"],
    ["Core override", { precedence: { mandatoryGates: "skill" } }, "override Core"],
    ["unsupported host", { adapterCompatibility: ["cursor"] }, "compatible"]
  ])("rejects %s", async (_label, override, message) => {
    const skillsRoot = await temporarySkillsRoot();
    const script = "brief\n";
    const skillRoot = await writeSkill(skillsRoot, "subagent-driven-development", {
      "SKILL.md": "Use scripts/task-brief.\n",
      "scripts/task-brief": script
    });
    const contentSha256 = await hashSkillDirectory(skillRoot);
    const scriptSha256 = await hashSkillFile(join(skillRoot, "scripts", "task-brief"));
    const lock = reviewedLock(contentSha256, scriptSha256);
    Object.assign((lock.dependencies as Array<Record<string, unknown>>)[0], override);
    if (!("commit" in override) && !("license" in override)) {
      Object.assign(
        ((lock.dependencies as Array<Record<string, unknown>>)[0].skills as Array<Record<string, unknown>>)[0],
        override
      );
    }

    await expect(validateSkillPolicyLock(lock, { skillsRoot, host: "codex" }))
      .rejects.toThrow(message);
  });

  it("compares skills.sh metadata without exposing install or execution actions", () => {
    expect(compareSkillDiscoveryCandidates([{
      catalog: "skills.sh",
      slug: "team/parallel-rules",
      repository: "https://github.com/team/rules",
      organization: "team",
      license: "MIT",
      immutableRevision: "a".repeat(40),
      auditEvidence: ["socket:pass"]
    }, {
      catalog: "skills.sh",
      slug: "mutable/popular",
      repository: "https://github.com/mutable/popular",
      organization: "mutable",
      popularity: 100000
    }])).toEqual([{
      catalog: "skills.sh",
      slug: "team/parallel-rules",
      repository: "https://github.com/team/rules",
      reviewability: {
        immutable: true,
        licensed: true,
        hasAuditEvidence: true
      },
      activation: "review-required",
      readOnly: true
    }, {
      catalog: "skills.sh",
      slug: "mutable/popular",
      repository: "https://github.com/mutable/popular",
      reviewability: {
        immutable: false,
        licensed: false,
        hasAuditEvidence: false
      },
      activation: "review-required",
      readOnly: true
    }]);
  });

  it("rejects an undeclared file in the activated Skill scripts directory", async () => {
    const skillsRoot = await temporarySkillsRoot();
    const skillRoot = await writeSkill(skillsRoot, "subagent-driven-development", {
      "SKILL.md": "Use scripts/task-brief.\n",
      "scripts/task-brief": "brief\n",
      "scripts/undeclared": "hidden behavior\n"
    });
    const contentSha256 = await hashSkillDirectory(skillRoot);
    const scriptSha256 = await hashSkillFile(join(skillRoot, "scripts", "task-brief"));

    await expect(validateSkillPolicyLock(
      reviewedLock(contentSha256, scriptSha256),
      { skillsRoot, host: "codex" }
    )).rejects.toThrow("Every Skill script");
  });

  it("bounds the number of files included in a Skill content hash", async () => {
    const skillsRoot = await temporarySkillsRoot();
    const files = Object.fromEntries(Array.from({ length: 257 }, (_value, index) => (
      [`references/${index}.md`, `${index}\n`]
    )));
    const skillRoot = await writeSkill(skillsRoot, "large-skill", files);

    await expect(hashSkillDirectory(skillRoot)).rejects.toThrow("too many files");
  });
});
