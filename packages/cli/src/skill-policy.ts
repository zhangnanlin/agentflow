import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { AgentFlowError } from "@agentflow/core";

export type SkillPolicyHost = "codex" | "cursor" | "vscode";

export type SkillPolicyRule =
  | "bounded-parallelism"
  | "compact-results"
  | "durable-progress"
  | "event-driven-collection"
  | "focused-task-briefs"
  | "fresh-context"
  | "isolated-worktrees"
  | "persist-before-cleanup";

export type SkillPolicyRestriction =
  | "core-safety-precedence"
  | "manual-updates-only"
  | "no-agentflow-mcp-in-worker"
  | "no-custom-model-process"
  | "no-supervisor-history";

export interface NormalizedSkillPolicy {
  id: string;
  source: {
    organization: string;
    repository: string;
    revision: string;
    license: string;
    contentSha256: string;
  };
  adapterCompatibility: SkillPolicyHost[];
  restrictions: SkillPolicyRestriction[];
  policyRules: SkillPolicyRule[];
  precedence: {
    mandatoryGates: "core";
    hostBudgets: "core";
    isolation: "core";
    pathScopes: "core";
    terminalCleanup: "core";
  };
  reviewedToolScope: string[];
  reviewedScripts: string[];
}

export interface SkillPolicyCatalog {
  schemaVersion: 2;
  updatePolicy: "manual-review-only";
  policies: NormalizedSkillPolicy[];
}

export interface SkillDiscoveryCandidate {
  catalog: "skills.sh";
  slug: string;
  repository: string;
  organization?: string;
  license?: string;
  immutableRevision?: string;
  auditEvidence?: string[];
  popularity?: number;
}

export interface SkillDiscoveryComparison {
  catalog: "skills.sh";
  slug: string;
  repository: string;
  reviewability: {
    immutable: boolean;
    licensed: boolean;
    hasAuditEvidence: boolean;
  };
  activation: "review-required";
  readOnly: true;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMMUTABLE_REVISION_PATTERN = /^[a-f0-9]{40,64}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACTIVE_POLICIES = 32;
const MAX_SCOPE_ITEMS = 32;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const POLICY_RULES = new Set<SkillPolicyRule>([
  "bounded-parallelism",
  "compact-results",
  "durable-progress",
  "event-driven-collection",
  "focused-task-briefs",
  "fresh-context",
  "isolated-worktrees",
  "persist-before-cleanup"
]);
const POLICY_RESTRICTIONS = new Set<SkillPolicyRestriction>([
  "core-safety-precedence",
  "manual-updates-only",
  "no-agentflow-mcp-in-worker",
  "no-custom-model-process",
  "no-supervisor-history"
]);
const CORE_OVERRIDE_FIELDS = [
  "budget",
  "budgets",
  "cleanup",
  "gate",
  "gates",
  "hostBudget",
  "isolation",
  "mandatoryGates",
  "override",
  "overrides",
  "pathScopes",
  "precedence",
  "terminalCleanup",
  "writeScopes"
] as const;
const CORE_PRECEDENCE = Object.freeze({
  mandatoryGates: "core" as const,
  hostBudgets: "core" as const,
  isolation: "core" as const,
  pathScopes: "core" as const,
  terminalCleanup: "core" as const
});

function policyError(message: string, details: Record<string, unknown> = {}): AgentFlowError {
  return new AgentFlowError(message, "SKILL_POLICY_INVALID", details);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw policyError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw policyError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function arrayValue(value: unknown, label: string, maximum = MAX_SCOPE_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw policyError(`${label} must be a non-empty bounded array`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: string[], label: string): string[] {
  const unique = [...new Set(values)].sort(compareText);
  if (unique.length !== values.length) throw policyError(`${label} contains duplicates`);
  return unique;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = stringValue(value, label, 256);
  if (!/^[A-Za-z0-9._/-]+$/.test(path)
    || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => (
    part.length === 0 || part === "." || part === ".."
  ))) {
    throw policyError(`${label} must be a safe portable relative path`);
  }
  return path;
}

function pathWithin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...relativePath.split("/"));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw policyError("Skill path escapes its root", { relativePath });
  }
  return target;
}

async function filePaths(root: string, current = ""): Promise<string[]> {
  const directory = current.length === 0 ? root : pathWithin(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const path = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw policyError("Skill content must not contain symbolic links", { path });
    }
    if (entry.isDirectory()) {
      paths.push(...await filePaths(root, path));
    } else if (entry.isFile()) {
      paths.push(path);
    } else {
      throw policyError("Skill content contains an unsupported file type", { path });
    }
  }
  return paths;
}

export async function hashSkillFile(path: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw policyError("Reviewed Skill script must be a real file", { path });
  }
  if (stats.size > MAX_SKILL_FILE_BYTES) {
    throw policyError("Skill file exceeds the review size budget", { path, bytes: stats.size });
  }
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function hashSkillDirectory(
  skillRoot: string,
  selectedPaths?: string[]
): Promise<string> {
  const stats = await lstat(skillRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw policyError("Skill root must be a real directory", { skillRoot });
  }
  const paths = selectedPaths === undefined
    ? await filePaths(skillRoot)
    : uniqueSorted(selectedPaths.map((path) => safeRelativePath(path, "Skill file path")), "Skill files");
  if (paths.length === 0) throw policyError("Skill content must contain at least one file");
  if (paths.length > MAX_SKILL_FILES) throw policyError("Skill content contains too many files");
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const path of paths) {
    manifest.push({ path, sha256: await hashSkillFile(pathWithin(skillRoot, path)) });
  }
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function validateRepository(value: unknown): string {
  const repository = stringValue(value, "Skill source repository", 1024);
  let parsed: URL;
  try {
    parsed = new URL(repository);
  } catch {
    throw policyError("Skill source repository must be an absolute URL");
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    throw policyError("Skill source repository must use credential-free HTTPS");
  }
  return repository;
}

function validateLicense(value: unknown): string {
  const license = stringValue(value, "Skill license", 256);
  if (/^(unknown|none|unlicensed)$/i.test(license)) {
    throw policyError("An enabled orchestration Skill must record an approved license");
  }
  return license;
}

function validateAudits(value: unknown): void {
  const audits = record(value, "Skill audit evidence");
  const entries = Object.entries(audits);
  if (entries.length === 0 || entries.length > 16) {
    throw policyError("Skill audit evidence must be non-empty and bounded");
  }
  for (const [provider, status] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(provider) || status !== "pass") {
      throw policyError("Every enabled Skill audit must pass", { provider });
    }
  }
}

function validateApproval(value: unknown): void {
  const approval = record(value, "Skill approval");
  if (approval.status !== "approved"
    || typeof approval.reviewedBy !== "string" || approval.reviewedBy.length === 0
    || typeof approval.reviewedAt !== "string" || !DATE_PATTERN.test(approval.reviewedAt)) {
    throw policyError("An enabled orchestration Skill requires explicit manual approval");
  }
}

function validateToolScope(value: unknown): string[] {
  const tools = arrayValue(value, "Reviewed tool scope").map((tool) => (
    stringValue(tool, "Reviewed tool", 128)
  ));
  for (const tool of tools) {
    if (!TOOL_ID_PATTERN.test(tool) || tool.includes("*") || tool.startsWith("mcp.agentflow")) {
      throw policyError("Reviewed tool scope must contain explicit bounded tool IDs", { tool });
    }
  }
  return uniqueSorted(tools, "Reviewed tool scope");
}

function validateCompatibility(value: unknown, host?: SkillPolicyHost): SkillPolicyHost[] {
  const adapters = uniqueSorted(arrayValue(value, "Adapter compatibility", 3).map((adapter) => {
    if (adapter !== "codex" && adapter !== "cursor" && adapter !== "vscode") {
      throw policyError("Adapter compatibility contains an unsupported host");
    }
    return adapter;
  }), "Adapter compatibility") as SkillPolicyHost[];
  if (host !== undefined && !adapters.includes(host)) {
    throw policyError(`Enabled Skill is not compatible with the ${host} adapter`);
  }
  return adapters;
}

function validateRules(value: unknown): SkillPolicyRule[] {
  const rules = arrayValue(value, "Skill policy rules").map((rule) => (
    stringValue(rule, "Skill policy rule", 64) as SkillPolicyRule
  ));
  for (const rule of rules) {
    if (!POLICY_RULES.has(rule)) throw policyError("Skill policy contains an unknown rule", { rule });
  }
  return uniqueSorted(rules, "Skill policy rules") as SkillPolicyRule[];
}

function validateRestrictions(value: unknown): SkillPolicyRestriction[] {
  const restrictions = arrayValue(value, "Skill restrictions").map((restriction) => (
    stringValue(restriction, "Skill restriction", 64) as SkillPolicyRestriction
  ));
  for (const restriction of restrictions) {
    if (!POLICY_RESTRICTIONS.has(restriction)) {
      throw policyError("Skill restrictions contain an unknown restriction", { restriction });
    }
  }
  if (!restrictions.includes("core-safety-precedence")
    || !restrictions.includes("manual-updates-only")) {
    throw policyError("Skill restrictions must preserve Core precedence and manual updates");
  }
  return uniqueSorted(restrictions, "Skill restrictions") as SkillPolicyRestriction[];
}

async function validateScripts(
  skillRoot: string,
  entrypoint: string,
  value: unknown
): Promise<string[]> {
  const scripts = Array.isArray(value) ? value : [];
  if (scripts.length > MAX_SCOPE_ITEMS) throw policyError("Reviewed script scope is too large");
  const reviewed = new Map<string, string>();
  for (const item of scripts) {
    const script = record(item, "Reviewed script");
    const path = safeRelativePath(script.path, "Reviewed script path");
    if (!path.startsWith("scripts/")) {
      throw policyError("Reviewed scripts must stay under the Skill scripts directory", { path });
    }
    const sha256 = stringValue(script.sha256, "Reviewed script SHA-256", 64);
    if (!SHA256_PATTERN.test(sha256)) throw policyError("Reviewed script SHA-256 is invalid", { path });
    if (reviewed.has(path)) throw policyError("Reviewed script scope contains duplicates", { path });
    const actual = await hashSkillFile(pathWithin(skillRoot, path));
    if (actual !== sha256) throw policyError("Reviewed script SHA-256 does not match local content", { path });
    reviewed.set(path, sha256);
  }

  const localScripts = (await filePaths(skillRoot)).filter((path) => path.startsWith("scripts/"));
  for (const path of localScripts) {
    if (!reviewed.has(path)) {
      throw policyError("Every Skill script must appear in the reviewed script scope", { path });
    }
  }

  const entrypointText = await readFile(pathWithin(skillRoot, entrypoint), "utf8");
  const referenced = new Set<string>();
  const pattern = /(?:^|[\s`"'(])(?:\.\/)?(scripts\/[A-Za-z0-9._/-]*[A-Za-z0-9_-])/gm;
  for (const match of entrypointText.matchAll(pattern)) {
    const path = safeRelativePath(match[1], "Referenced script path");
    referenced.add(path);
  }
  for (const path of referenced) {
    if (!reviewed.has(path)) {
      throw policyError("Every referenced script must appear in the reviewed script scope", { path });
    }
  }
  return [...reviewed.keys()].sort(compareText);
}

export async function validateSkillPolicyLock(
  input: unknown,
  options: { skillsRoot: string; host?: SkillPolicyHost }
): Promise<SkillPolicyCatalog> {
  const lock = record(input, "Skill policy lock");
  if (lock.schemaVersion !== 2 || lock.updatePolicy !== "manual-review-only") {
    throw policyError("Skill policy lock must use schemaVersion 2 and manual-review-only updates");
  }
  if (!Array.isArray(lock.dependencies) || lock.dependencies.length > 64) {
    throw policyError("Skill policy lock dependencies must be a bounded array");
  }

  const policies: NormalizedSkillPolicy[] = [];
  const policyIds = new Set<string>();
  for (const dependencyValue of lock.dependencies) {
    const dependency = record(dependencyValue, "Skill dependency");
    if (!Array.isArray(dependency.skills) || dependency.skills.length > 64) {
      throw policyError("Skill dependency must contain a bounded skills array");
    }
    const activeSkills = dependency.skills.map((skill) => record(skill, "Skill entry"))
      .filter((skill) => skill.activation === "orchestration");
    if (activeSkills.length === 0) continue;

    const dependencyId = stringValue(dependency.id, "Skill dependency ID", 128);
    const organization = stringValue(dependency.organization, "Skill organization", 128);
    const repository = validateRepository(dependency.repository);
    const revision = stringValue(dependency.commit, "Skill immutable revision", 64);
    if (!IMMUTABLE_REVISION_PATTERN.test(revision)) {
      throw policyError("Enabled Skill revision must be an immutable full commit SHA");
    }
    const license = validateLicense(dependency.license);
    if (dependency.sourceMode !== "external-host" && dependency.sourceMode !== "vendored") {
      throw policyError("Enabled Skill source mode is unsupported");
    }
    if (typeof dependency.reviewedAt !== "string" || !DATE_PATTERN.test(dependency.reviewedAt)) {
      throw policyError("Enabled Skill dependency must record its review date");
    }

    for (const skill of activeSkills) {
      for (const field of CORE_OVERRIDE_FIELDS) {
        if (field in skill) throw policyError(`Skill policy cannot override Core ${field}`);
      }
      const name = stringValue(skill.name, "Skill name", 128);
      if (!SKILL_NAME_PATTERN.test(name)) throw policyError("Skill name is unsafe", { name });
      const policyId = `${dependencyId}/${name}@${revision}`;
      if (policyIds.has(policyId)) throw policyError("Skill policy is duplicated", { policyId });
      policyIds.add(policyId);
      validateApproval(skill.approval);
      validateAudits(skill.audits);
      const adapterCompatibility = validateCompatibility(skill.adapterCompatibility, options.host);
      const restrictions = validateRestrictions(skill.restrictions);
      const reviewedToolScope = validateToolScope(skill.toolScope);
      const policyRules = validateRules(skill.policyRules);
      const contentSha256 = stringValue(skill.contentSha256, "Skill content SHA-256", 64);
      if (!SHA256_PATTERN.test(contentSha256)) throw policyError("Skill content SHA-256 is invalid");
      const entrypoint = safeRelativePath(skill.entrypoint, "Skill entrypoint");
      const skillRoot = pathWithin(options.skillsRoot, name);
      const reviewedScripts = await validateScripts(skillRoot, entrypoint, skill.scriptScope);
      const actualContentSha256 = await hashSkillDirectory(skillRoot);
      if (actualContentSha256 !== contentSha256) {
        throw policyError("Skill content SHA-256 does not match local content", { policyId });
      }

      policies.push({
        id: policyId,
        source: { organization, repository, revision, license, contentSha256 },
        adapterCompatibility,
        restrictions,
        policyRules,
        precedence: { ...CORE_PRECEDENCE },
        reviewedToolScope,
        reviewedScripts
      });
    }
  }
  if (policies.length > MAX_ACTIVE_POLICIES) throw policyError("Too many active Skill policies");
  policies.sort((left, right) => compareText(left.id, right.id));
  return { schemaVersion: 2, updatePolicy: "manual-review-only", policies };
}

export function compareSkillDiscoveryCandidates(
  candidates: SkillDiscoveryCandidate[]
): SkillDiscoveryComparison[] {
  if (candidates.length > 64) throw policyError("Skill discovery comparison is too large");
  return candidates.map((candidate): SkillDiscoveryComparison => {
    if (candidate.catalog !== "skills.sh") throw policyError("Unsupported Skill discovery catalog");
    const slug = stringValue(candidate.slug, "Skill discovery slug", 256);
    const repository = validateRepository(candidate.repository);
    return {
      catalog: "skills.sh",
      slug,
      repository,
      reviewability: {
        immutable: typeof candidate.immutableRevision === "string"
          && IMMUTABLE_REVISION_PATTERN.test(candidate.immutableRevision),
        licensed: typeof candidate.license === "string"
          && candidate.license.length > 0
          && !/^(unknown|none|unlicensed)$/i.test(candidate.license),
        hasAuditEvidence: Array.isArray(candidate.auditEvidence)
          && candidate.auditEvidence.length > 0
      },
      activation: "review-required",
      readOnly: true
    };
  }).sort((left, right) => {
    const leftScore = Object.values(left.reviewability).filter(Boolean).length;
    const rightScore = Object.values(right.reviewability).filter(Boolean).length;
    return rightScore - leftScore || compareText(left.slug, right.slug);
  });
}
