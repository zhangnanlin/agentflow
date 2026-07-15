import { z } from "zod";
import { sha256 } from "./hash.js";

const ContractIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const ArtifactReferenceSchema = z.object({
  artifactId: ContractIdSchema,
  sha256: Sha256Schema
}).strict();
const TypedArtifactReferenceSchema = ArtifactReferenceSchema.extend({
  kind: ContractIdSchema
}).strict();
const SeveritySchema = z.enum(["blocker", "critical", "high", "medium", "low"]);
const QualityCategorySchema = z.enum([
  "functional",
  "regression",
  "performance",
  "security",
  "accessibility",
  "visual",
  "reliability",
  "operability",
  "other"
]);
const RiskAcceptanceSchema = z.object({
  approvedBy: ContractIdSchema,
  reason: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }).optional()
}).strict();

export const ProductBriefContractSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  projectType: z.enum(["new", "existing"]),
  users: z.array(z.object({
    name: z.string().min(1),
    needs: z.array(z.string().min(1)).min(1),
    context: z.string().min(1)
  })).min(1),
  problem: z.object({
    statement: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
    impact: z.string().min(1)
  }),
  outcomes: z.array(z.string().min(1)).min(1),
  inScope: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  successMetrics: z.array(z.object({
    name: z.string().min(1),
    target: z.string().min(1),
    measurement: z.string().min(1)
  })).min(1),
  approaches: z.array(z.object({
    id: ContractIdSchema,
    summary: z.string().min(1),
    benefits: z.array(z.string().min(1)).min(1),
    costs: z.array(z.string().min(1)).min(1)
  })).min(2).max(3),
  recommendedApproachId: ContractIdSchema,
  dependencies: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  openQuestions: z.array(z.string().min(1)).default([]),
  approvedDecisions: z.array(z.string().min(1)).default([])
}).superRefine((value, context) => {
  if (!value.approaches.some((approach) => approach.id === value.recommendedApproachId)) {
    context.addIssue({ code: "custom", message: "recommendedApproachId must reference an approach" });
  }
});

export const PrdContractSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceProductBrief: z.object({ artifactId: ContractIdSchema, sha256: Sha256Schema }),
  goals: z.array(z.string().min(1)).min(1),
  nonGoals: z.array(z.string().min(1)).min(1),
  userStories: z.array(z.object({
    id: ContractIdSchema,
    actor: z.string().min(1),
    capability: z.string().min(1),
    benefit: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1)
  })).min(1),
  functionalRequirements: z.array(z.object({
    id: ContractIdSchema,
    description: z.string().min(1),
    priority: z.enum(["must", "should", "could"]),
    acceptanceCriteria: z.array(z.string().min(1)).min(1)
  })).min(1),
  nonFunctionalRequirements: z.array(z.object({
    id: ContractIdSchema,
    category: z.enum(["performance", "security", "accessibility", "reliability", "privacy", "operability", "other"]),
    target: z.string().min(1),
    measurement: z.string().min(1)
  })).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  dependencies: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  openQuestions: z.array(z.string().min(1)).default([])
});

export const UxArchitectureContractSchema = z.object({
  version: z.literal(1),
  sourcePrd: z.object({ artifactId: ContractIdSchema, sha256: Sha256Schema }),
  roles: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    permissions: z.array(z.string().min(1)).min(1)
  })).min(1),
  screens: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    purpose: z.string().min(1),
    route: z.string().optional(),
    supportedRoles: z.array(ContractIdSchema).min(1),
    states: z.array(z.enum(["loading", "empty", "ready", "error", "offline", "permission-denied", "partial"])).min(1)
  })).min(1),
  journeys: z.array(z.object({
    id: ContractIdSchema,
    roleId: ContractIdSchema,
    goal: z.string().min(1),
    steps: z.array(z.object({
      id: ContractIdSchema,
      screenId: ContractIdSchema,
      action: z.string().min(1),
      outcome: z.string().min(1),
      exceptions: z.array(z.string().min(1)).default([])
    })).min(1)
  })).min(1),
  navigation: z.array(z.object({
    fromScreenId: ContractIdSchema,
    toScreenId: ContractIdSchema,
    trigger: z.string().min(1)
  })).default([]),
  responsiveModes: z.array(z.object({
    id: ContractIdSchema,
    minWidth: z.number().int().nonnegative(),
    maxWidth: z.number().int().positive().optional(),
    behavior: z.string().min(1)
  })).min(1),
  contentDependencies: z.array(z.string().min(1)).default([]),
  dataDependencies: z.array(z.string().min(1)).default([]),
  accessibilityRequirements: z.array(z.string().min(1)).min(1)
}).superRefine((value, context) => {
  const roleIds = new Set(value.roles.map((role) => role.id));
  const screenIds = new Set(value.screens.map((screen) => screen.id));
  for (const screen of value.screens) {
    for (const roleId of screen.supportedRoles) {
      if (!roleIds.has(roleId)) context.addIssue({ code: "custom", message: `Unknown role ${roleId} on screen ${screen.id}` });
    }
  }
  for (const journey of value.journeys) {
    if (!roleIds.has(journey.roleId)) context.addIssue({ code: "custom", message: `Unknown journey role ${journey.roleId}` });
    for (const step of journey.steps) {
      if (!screenIds.has(step.screenId)) context.addIssue({ code: "custom", message: `Unknown journey screen ${step.screenId}` });
    }
  }
});

const DesignConceptSchema = z.object({
  id: ContractIdSchema,
  label: z.enum(["A", "B", "C"]),
  title: z.string().min(1),
  briefArtifactId: ContractIdSchema,
  visualLanguage: z.string().min(1),
  layoutPrinciples: z.array(z.string().min(1)).min(1),
  interactionPrinciples: z.array(z.string().min(1)).min(1),
  differentiators: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)).default([]),
  figmaPageNodeId: z.string().min(1).max(512),
  representativeNodeIds: z.array(z.string().min(1).max(512)).min(1),
  screenshot: z.object({ artifactId: ContractIdSchema, sha256: Sha256Schema })
});

export const DesignConceptSetContractSchema = z.object({
  version: z.literal(1),
  sourceUxArchitecture: z.object({ artifactId: ContractIdSchema, sha256: Sha256Schema }),
  figmaFile: z.object({ fileKey: z.string().min(1), url: z.url() }),
  representativeScreenId: ContractIdSchema,
  concepts: z.array(DesignConceptSchema).length(3),
  comparisonCriteria: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    description: z.string().min(1)
  })).min(2),
  writer: z.object({
    workerId: ContractIdSchema,
    resourceId: ContractIdSchema,
    operationIds: z.array(ContractIdSchema).min(3)
  })
}).superRefine((value, context) => {
  if (new Set(value.concepts.map((concept) => concept.id)).size !== value.concepts.length) {
    context.addIssue({ code: "custom", message: "Concept IDs must be unique" });
  }
  if (new Set(value.concepts.map((concept) => concept.label)).size !== 3) {
    context.addIssue({ code: "custom", message: "Concept labels must contain A, B, and C exactly once" });
  }
});

export const ArchitectureContractSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourcePrd: ArtifactReferenceSchema,
  sourceDesignManifest: ArtifactReferenceSchema.optional(),
  principles: z.array(z.string().min(1)).min(1),
  components: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    kind: z.enum(["frontend", "backend", "service", "library", "data", "infrastructure", "integration", "other"]),
    responsibilities: z.array(z.string().min(1)).min(1),
    requirementIds: z.array(ContractIdSchema).min(1)
  }).strict()).min(1),
  interfaces: z.array(z.object({
    id: ContractIdSchema,
    fromComponentId: ContractIdSchema,
    toComponentId: ContractIdSchema,
    protocol: z.string().min(1),
    contract: z.string().min(1),
    security: z.string().min(1)
  }).strict()).default([]),
  dataStores: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    ownerComponentId: ContractIdSchema,
    classification: z.enum(["public", "internal", "confidential", "restricted"]),
    retention: z.string().min(1)
  }).strict()).default([]),
  decisions: z.array(z.object({
    id: ContractIdSchema,
    title: z.string().min(1),
    decision: z.string().min(1),
    rationale: z.string().min(1),
    consequences: z.array(z.string().min(1)).min(1),
    status: z.enum(["accepted", "superseded"]),
    supersededByDecisionId: ContractIdSchema.optional()
  }).strict()).min(1),
  requirementCoverage: z.array(z.object({
    requirementId: ContractIdSchema,
    componentIds: z.array(ContractIdSchema).min(1),
    verificationApproach: z.string().min(1)
  }).strict()).min(1),
  risks: z.array(z.object({
    id: ContractIdSchema,
    description: z.string().min(1),
    likelihood: z.enum(["low", "medium", "high"]),
    impact: z.enum(["low", "medium", "high"]),
    mitigation: z.string().min(1),
    ownerComponentId: ContractIdSchema.optional()
  }).strict()).default([])
}).strict().superRefine((value, context) => {
  const componentIds = new Set(value.components.map((component) => component.id));
  const decisionIds = new Set(value.decisions.map((decision) => decision.id));
  const coverageByRequirement = new Map(value.requirementCoverage.map((coverage) => [coverage.requirementId, coverage]));
  requireUniqueIds(value.components.map((component) => component.id), "Architecture component", context);
  requireUniqueIds(value.interfaces.map((item) => item.id), "Architecture interface", context);
  requireUniqueIds(value.dataStores.map((store) => store.id), "Architecture data store", context);
  requireUniqueIds(value.decisions.map((decision) => decision.id), "Architecture decision", context);
  requireUniqueIds(value.requirementCoverage.map((coverage) => coverage.requirementId), "Architecture requirement coverage", context);
  requireUniqueIds(value.risks.map((risk) => risk.id), "Architecture risk", context);

  for (const item of value.interfaces) {
    if (!componentIds.has(item.fromComponentId) || !componentIds.has(item.toComponentId)) {
      context.addIssue({ code: "custom", message: `Architecture interface ${item.id} references an unknown component` });
    }
    if (item.fromComponentId === item.toComponentId) {
      context.addIssue({ code: "custom", message: `Architecture interface ${item.id} must connect different components` });
    }
  }
  for (const store of value.dataStores) {
    if (!componentIds.has(store.ownerComponentId)) {
      context.addIssue({ code: "custom", message: `Architecture data store ${store.id} references an unknown owner component` });
    }
  }
  for (const decision of value.decisions) {
    if (decision.status === "superseded" && decision.supersededByDecisionId === undefined) {
      context.addIssue({ code: "custom", message: `Superseded decision ${decision.id} must name its replacement` });
    }
    if (decision.status === "accepted" && decision.supersededByDecisionId !== undefined) {
      context.addIssue({ code: "custom", message: `Accepted decision ${decision.id} cannot name a replacement` });
    }
    if (decision.supersededByDecisionId !== undefined
      && (!decisionIds.has(decision.supersededByDecisionId) || decision.supersededByDecisionId === decision.id)) {
      context.addIssue({ code: "custom", message: `Architecture decision ${decision.id} has an invalid supersededByDecisionId` });
    }
  }
  for (const coverage of value.requirementCoverage) {
    requireUniqueIds(coverage.componentIds, `Component reference in requirement ${coverage.requirementId}`, context);
    for (const componentId of coverage.componentIds) {
      const component = value.components.find((candidate) => candidate.id === componentId);
      if (!component || !component.requirementIds.includes(coverage.requirementId)) {
        context.addIssue({ code: "custom", message: `Requirement ${coverage.requirementId} is not declared by component ${componentId}` });
      }
    }
  }
  for (const component of value.components) {
    requireUniqueIds(component.requirementIds, `Requirement reference on component ${component.id}`, context);
    for (const requirementId of component.requirementIds) {
      if (!coverageByRequirement.get(requirementId)?.componentIds.includes(component.id)) {
        context.addIssue({ code: "custom", message: `Component ${component.id} is missing coverage for requirement ${requirementId}` });
      }
    }
  }
  for (const risk of value.risks) {
    if (risk.ownerComponentId !== undefined && !componentIds.has(risk.ownerComponentId)) {
      context.addIssue({ code: "custom", message: `Architecture risk ${risk.id} references an unknown owner component` });
    }
  }
});

export const ImplementationPlanContractSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceArchitecture: ArtifactReferenceSchema,
  sourcePrd: ArtifactReferenceSchema,
  repository: z.object({
    branch: z.string().min(1),
    baseRevision: GitRevisionSchema
  }).strict(),
  scope: z.object({
    requirementIds: z.array(ContractIdSchema).min(1),
    componentIds: z.array(ContractIdSchema).min(1)
  }).strict(),
  tasks: z.array(z.object({
    id: ContractIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    profile: ContractIdSchema,
    componentIds: z.array(ContractIdSchema).min(1),
    requirementIds: z.array(ContractIdSchema).min(1),
    dependsOnTaskIds: z.array(ContractIdSchema).default([]),
    inputArtifacts: z.array(TypedArtifactReferenceSchema).min(1),
    writeScopes: z.array(z.string().min(1)).min(1),
    forbiddenScopes: z.array(z.string().min(1)).default([]),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    verificationCommands: z.array(z.string().min(1)).min(1),
    expectedOutputs: z.array(z.string().min(1)).min(1),
    requiresWorktree: z.boolean(),
    risk: z.enum(["low", "medium", "high"])
  }).strict()).min(1),
  waves: z.array(z.object({
    id: ContractIdSchema,
    taskIds: z.array(ContractIdSchema).min(1),
    exitCriteria: z.array(z.string().min(1)).min(1)
  }).strict()).min(1),
  integrationStrategy: z.object({
    taskOrder: z.array(ContractIdSchema).min(1),
    conflictPolicy: z.string().min(1),
    verificationCommands: z.array(z.string().min(1)).min(1)
  }).strict()
}).strict().superRefine((value, context) => {
  const taskIds = new Set(value.tasks.map((task) => task.id));
  const requirementIds = new Set(value.scope.requirementIds);
  const componentIds = new Set(value.scope.componentIds);
  requireUniqueIds(value.scope.requirementIds, "Implementation scope requirement", context);
  requireUniqueIds(value.scope.componentIds, "Implementation scope component", context);
  requireUniqueIds(value.tasks.map((task) => task.id), "Implementation task", context);
  requireUniqueIds(value.waves.map((wave) => wave.id), "Implementation wave", context);

  for (const task of value.tasks) {
    requireUniqueIds(task.componentIds, `Component reference on task ${task.id}`, context);
    requireUniqueIds(task.requirementIds, `Requirement reference on task ${task.id}`, context);
    requireUniqueIds(task.dependsOnTaskIds, `Dependency on task ${task.id}`, context);
    requireUniqueIds(task.inputArtifacts.map((artifact) => artifact.artifactId), `Input artifact on task ${task.id}`, context);
    requireUniqueStrings(task.writeScopes, `Write scope on task ${task.id}`, context);
    requireUniqueStrings(task.forbiddenScopes, `Forbidden scope on task ${task.id}`, context);
    requireUniqueStrings(task.acceptanceCriteria, `Acceptance criterion on task ${task.id}`, context);
    requireUniqueStrings(task.verificationCommands, `Verification command on task ${task.id}`, context);
    requireUniqueStrings(task.expectedOutputs, `Expected output on task ${task.id}`, context);
    for (const componentId of task.componentIds) {
      if (!componentIds.has(componentId)) context.addIssue({ code: "custom", message: `Task ${task.id} references unknown component ${componentId}` });
    }
    for (const requirementId of task.requirementIds) {
      if (!requirementIds.has(requirementId)) context.addIssue({ code: "custom", message: `Task ${task.id} references unknown requirement ${requirementId}` });
    }
    for (const dependencyId of task.dependsOnTaskIds) {
      if (!taskIds.has(dependencyId) || dependencyId === task.id) {
        context.addIssue({ code: "custom", message: `Task ${task.id} has invalid dependency ${dependencyId}` });
      }
    }
  }
  if (hasDependencyCycle(value.tasks.map((task) => ({ id: task.id, dependencies: task.dependsOnTaskIds })))) {
    context.addIssue({ code: "custom", message: "Implementation task dependencies must be acyclic" });
  }
  for (const requirementId of requirementIds) {
    if (!value.tasks.some((task) => task.requirementIds.includes(requirementId))) {
      context.addIssue({ code: "custom", message: `Implementation scope requirement ${requirementId} is not covered by a task` });
    }
  }
  for (const componentId of componentIds) {
    if (!value.tasks.some((task) => task.componentIds.includes(componentId))) {
      context.addIssue({ code: "custom", message: `Implementation scope component ${componentId} is not covered by a task` });
    }
  }

  const waveIndexByTask = new Map<string, number>();
  value.waves.forEach((wave, waveIndex) => {
    requireUniqueIds(wave.taskIds, `Task reference in wave ${wave.id}`, context);
    const waveTasks = wave.taskIds
      .map((taskId) => value.tasks.find((task) => task.id === taskId))
      .filter((task) => task !== undefined);
    if (waveTasks.length > 1 && waveTasks.some((task) => !task.requiresWorktree)) {
      context.addIssue({ code: "custom", message: `Concurrent writable tasks in wave ${wave.id} must require worktrees` });
    }
    for (let leftIndex = 0; leftIndex < waveTasks.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < waveTasks.length; rightIndex += 1) {
        const left = waveTasks[leftIndex];
        const right = waveTasks[rightIndex];
        if (left !== undefined && right !== undefined && scopesConflict(left.writeScopes, right.writeScopes)) {
          context.addIssue({ code: "custom", message: `Concurrent tasks ${left.id} and ${right.id} have overlapping write scopes` });
        }
      }
    }
    for (const taskId of wave.taskIds) {
      if (!taskIds.has(taskId)) context.addIssue({ code: "custom", message: `Wave ${wave.id} references unknown task ${taskId}` });
      if (waveIndexByTask.has(taskId)) context.addIssue({ code: "custom", message: `Task ${taskId} appears in more than one wave` });
      waveIndexByTask.set(taskId, waveIndex);
    }
  });
  for (const task of value.tasks) {
    const waveIndex = waveIndexByTask.get(task.id);
    if (waveIndex === undefined) context.addIssue({ code: "custom", message: `Task ${task.id} is not assigned to a wave` });
    for (const dependencyId of task.dependsOnTaskIds) {
      const dependencyWaveIndex = waveIndexByTask.get(dependencyId);
      if (waveIndex !== undefined && dependencyWaveIndex !== undefined && dependencyWaveIndex >= waveIndex) {
        context.addIssue({ code: "custom", message: `Task ${task.id} must run after dependency ${dependencyId}` });
      }
    }
  }

  requireUniqueIds(value.integrationStrategy.taskOrder, "Integration task order", context);
  const integrationIndex = new Map(value.integrationStrategy.taskOrder.map((taskId, index) => [taskId, index]));
  if (integrationIndex.size !== taskIds.size || [...taskIds].some((taskId) => !integrationIndex.has(taskId))) {
    context.addIssue({ code: "custom", message: "Integration task order must contain every implementation task exactly once" });
  }
  for (const task of value.tasks) {
    for (const dependencyId of task.dependsOnTaskIds) {
      const taskIndex = integrationIndex.get(task.id);
      const dependencyIndex = integrationIndex.get(dependencyId);
      if (taskIndex !== undefined && dependencyIndex !== undefined && dependencyIndex >= taskIndex) {
        context.addIssue({ code: "custom", message: `Integration order places ${task.id} before dependency ${dependencyId}` });
      }
    }
  }
});

export const IntegrationReportContractSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  sourceImplementationPlan: ArtifactReferenceSchema,
  repository: z.object({
    branch: z.string().min(1),
    baseRevision: GitRevisionSchema,
    integratedRevision: GitRevisionSchema
  }).strict(),
  planTaskIds: z.array(ContractIdSchema).min(1),
  taskResults: z.array(z.object({
    taskId: ContractIdSchema,
    status: z.enum(["integrated", "excluded"]),
    revisions: z.array(GitRevisionSchema).default([]),
    outputArtifacts: z.array(TypedArtifactReferenceSchema).default([]),
    verificationCheckIds: z.array(ContractIdSchema).min(1),
    exclusionReason: z.string().min(1).optional()
  }).strict()).min(1),
  checks: z.array(z.object({
    id: ContractIdSchema,
    category: z.enum(["build", "lint", "typecheck", "unit", "integration", "e2e", "security", "other"]),
    command: z.string().min(1),
    required: z.boolean(),
    status: z.enum(["passed", "failed", "skipped"]),
    summary: z.string().min(1),
    recordedAt: z.iso.datetime({ offset: true }),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).default([])
  }).strict()).min(1),
  conflicts: z.array(z.object({
    id: ContractIdSchema,
    taskIds: z.array(ContractIdSchema).min(2),
    status: z.enum(["resolved", "unresolved"]),
    resolution: z.string().min(1).optional()
  }).strict()).default([]),
  issues: z.array(z.object({
    id: ContractIdSchema,
    severity: SeveritySchema,
    status: z.enum(["open", "resolved", "accepted"]),
    description: z.string().min(1),
    disposition: z.string().min(1).optional()
  }).strict()).default([]),
  verdict: z.enum(["passed", "failed"])
}).strict().superRefine((value, context) => {
  const taskIds = new Set(value.planTaskIds);
  const checkIds = new Set(value.checks.map((check) => check.id));
  requireUniqueIds(value.planTaskIds, "Integration plan task", context);
  requireUniqueIds(value.taskResults.map((result) => result.taskId), "Integration task result", context);
  requireUniqueIds(value.checks.map((check) => check.id), "Integration check", context);
  requireUniqueIds(value.conflicts.map((conflict) => conflict.id), "Integration conflict", context);
  requireUniqueIds(value.issues.map((issue) => issue.id), "Integration issue", context);
  if (value.taskResults.length !== taskIds.size || value.taskResults.some((result) => !taskIds.has(result.taskId))) {
    context.addIssue({ code: "custom", message: "Integration task results must cover every plan task exactly once" });
  }
  for (const result of value.taskResults) {
    requireUniqueIds(result.verificationCheckIds, `Verification check on task ${result.taskId}`, context);
    if (result.status === "integrated" && result.revisions.length === 0) {
      context.addIssue({ code: "custom", message: `Integrated task ${result.taskId} must record at least one revision` });
    }
    if (result.status === "excluded" && result.exclusionReason === undefined) {
      context.addIssue({ code: "custom", message: `Excluded task ${result.taskId} must record a reason` });
    }
    for (const checkId of result.verificationCheckIds) {
      if (!checkIds.has(checkId)) context.addIssue({ code: "custom", message: `Task ${result.taskId} references unknown check ${checkId}` });
    }
  }
  for (const conflict of value.conflicts) {
    requireUniqueIds(conflict.taskIds, `Task reference in conflict ${conflict.id}`, context);
    if (conflict.taskIds.some((taskId) => !taskIds.has(taskId))) {
      context.addIssue({ code: "custom", message: `Conflict ${conflict.id} references an unknown task` });
    }
    if (conflict.status === "resolved" && conflict.resolution === undefined) {
      context.addIssue({ code: "custom", message: `Resolved conflict ${conflict.id} must include its resolution` });
    }
  }
  if (!value.checks.some((check) => check.required)) {
    context.addIssue({ code: "custom", message: "Integration report must include at least one required check" });
  }
  if (value.verdict === "passed") {
    if (value.taskResults.some((result) => result.status !== "integrated")) {
      context.addIssue({ code: "custom", message: "A passed integration report cannot exclude plan tasks" });
    }
    if (value.checks.some((check) => check.required && check.status !== "passed")) {
      context.addIssue({ code: "custom", message: "A passed integration report requires every required check to pass" });
    }
    if (value.conflicts.some((conflict) => conflict.status !== "resolved")) {
      context.addIssue({ code: "custom", message: "A passed integration report cannot contain unresolved conflicts" });
    }
    if (value.issues.some((issue) => ["blocker", "critical"].includes(issue.severity) && issue.status !== "resolved")) {
      context.addIssue({ code: "custom", message: "A passed integration report cannot contain unresolved blocker or critical issues" });
    }
  }
});

export const QaReportContractSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  sourceIntegrationReport: ArtifactReferenceSchema,
  environment: z.object({
    name: z.string().min(1),
    revision: GitRevisionSchema,
    baseUrl: z.url().optional()
  }).strict(),
  requirementIds: z.array(ContractIdSchema).min(1),
  testCases: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    category: QualityCategorySchema,
    requirementIds: z.array(ContractIdSchema).min(1),
    required: z.boolean(),
    status: z.enum(["passed", "failed", "blocked", "skipped"]),
    observedResult: z.string().min(1),
    recordedAt: z.iso.datetime({ offset: true }),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).min(1)
  }).strict()).min(1),
  qualityGates: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    category: QualityCategorySchema,
    required: z.boolean(),
    status: z.enum(["passed", "failed", "blocked", "skipped"]),
    summary: z.string().min(1),
    recordedAt: z.iso.datetime({ offset: true }),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).min(1)
  }).strict()).min(1),
  findings: z.array(z.object({
    id: ContractIdSchema,
    testCaseId: ContractIdSchema.optional(),
    severity: SeveritySchema,
    status: z.enum(["open", "resolved", "accepted"]),
    description: z.string().min(1),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).default([]),
    riskAcceptance: RiskAcceptanceSchema.optional()
  }).strict()).default([]),
  verdict: z.enum(["passed", "failed", "blocked"])
}).strict().superRefine((value, context) => {
  const requirementIds = new Set(value.requirementIds);
  const testCaseIds = new Set(value.testCases.map((testCase) => testCase.id));
  requireUniqueIds(value.requirementIds, "QA requirement", context);
  requireUniqueIds(value.testCases.map((testCase) => testCase.id), "QA test case", context);
  requireUniqueIds(value.qualityGates.map((gate) => gate.id), "QA quality gate", context);
  requireUniqueIds(value.findings.map((finding) => finding.id), "QA finding", context);
  for (const testCase of value.testCases) {
    requireUniqueIds(testCase.requirementIds, `Requirement reference on QA case ${testCase.id}`, context);
    for (const requirementId of testCase.requirementIds) {
      if (!requirementIds.has(requirementId)) context.addIssue({ code: "custom", message: `QA case ${testCase.id} references unknown requirement ${requirementId}` });
    }
  }
  for (const requirementId of requirementIds) {
    if (!value.testCases.some((testCase) => testCase.required && testCase.requirementIds.includes(requirementId))) {
      context.addIssue({ code: "custom", message: `QA requirement ${requirementId} is not covered by a required test case` });
    }
  }
  for (const finding of value.findings) {
    if (finding.testCaseId !== undefined && !testCaseIds.has(finding.testCaseId)) {
      context.addIssue({ code: "custom", message: `QA finding ${finding.id} references unknown test case ${finding.testCaseId}` });
    }
    if (finding.status === "accepted" && finding.riskAcceptance === undefined) {
      context.addIssue({ code: "custom", message: `Accepted QA finding ${finding.id} must include risk acceptance` });
    }
  }
  if (!value.testCases.some((testCase) => testCase.required) || !value.qualityGates.some((gate) => gate.required)) {
    context.addIssue({ code: "custom", message: "QA report must include required test cases and quality gates" });
  }
  if (value.verdict === "passed") {
    if (value.testCases.some((testCase) => testCase.required && testCase.status !== "passed")) {
      context.addIssue({ code: "custom", message: "A passed QA report requires every required test case to pass" });
    }
    if (value.qualityGates.some((gate) => gate.required && gate.status !== "passed")) {
      context.addIssue({ code: "custom", message: "A passed QA report requires every required quality gate to pass" });
    }
    if (value.findings.some((finding) => ["blocker", "critical"].includes(finding.severity) && finding.status !== "resolved")) {
      context.addIssue({ code: "custom", message: "A passed QA report cannot contain unresolved blocker or critical findings" });
    }
    if (value.findings.some((finding) => finding.severity === "high" && finding.status === "open")) {
      context.addIssue({ code: "custom", message: "A passed QA report cannot contain open high-severity findings" });
    }
  }
});

export const ReleasePlanContractSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  sourceQaReport: ArtifactReferenceSchema,
  qaVerdict: z.enum(["passed", "failed", "blocked"]),
  release: z.object({
    id: ContractIdSchema,
    version: z.string().min(1),
    targetEnvironment: z.string().min(1),
    revision: GitRevisionSchema
  }).strict(),
  releaseArtifacts: z.array(TypedArtifactReferenceSchema).min(1),
  preflightChecks: z.array(z.object({
    id: ContractIdSchema,
    description: z.string().min(1),
    required: z.boolean(),
    status: z.enum(["passed", "failed", "pending"]),
    checkedAt: z.iso.datetime({ offset: true }).optional(),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).default([])
  }).strict()).min(1),
  rolloutSteps: z.array(z.object({
    id: ContractIdSchema,
    description: z.string().min(1),
    dependsOnStepIds: z.array(ContractIdSchema).default([]),
    verificationCommands: z.array(z.string().min(1)).min(1)
  }).strict()).min(1),
  rollback: z.object({
    owner: ContractIdSchema,
    targetRevision: GitRevisionSchema,
    triggers: z.array(z.string().min(1)).min(1),
    steps: z.array(z.string().min(1)).min(1),
    verificationCommands: z.array(z.string().min(1)).min(1)
  }).strict(),
  monitoring: z.object({
    owner: ContractIdSchema,
    observationWindowMinutes: z.number().int().positive(),
    signals: z.array(z.object({
      id: ContractIdSchema,
      name: z.string().min(1),
      threshold: z.string().min(1),
      response: z.string().min(1)
    }).strict()).min(1)
  }).strict(),
  knownRisks: z.array(z.object({
    id: ContractIdSchema,
    severity: SeveritySchema,
    status: z.enum(["open", "mitigated", "accepted"]),
    description: z.string().min(1),
    mitigation: z.string().min(1),
    riskAcceptance: RiskAcceptanceSchema.optional()
  }).strict()).default([]),
  readiness: z.enum(["ready", "blocked"])
}).strict().superRefine((value, context) => {
  const stepIds = new Set(value.rolloutSteps.map((step) => step.id));
  requireUniqueIds(value.releaseArtifacts.map((artifact) => artifact.artifactId), "Release artifact", context);
  requireUniqueIds(value.preflightChecks.map((check) => check.id), "Release preflight check", context);
  requireUniqueIds(value.rolloutSteps.map((step) => step.id), "Release rollout step", context);
  requireUniqueIds(value.monitoring.signals.map((signal) => signal.id), "Release monitoring signal", context);
  requireUniqueIds(value.knownRisks.map((risk) => risk.id), "Release risk", context);
  for (const step of value.rolloutSteps) {
    requireUniqueIds(step.dependsOnStepIds, `Dependency on rollout step ${step.id}`, context);
    for (const dependencyId of step.dependsOnStepIds) {
      if (!stepIds.has(dependencyId) || dependencyId === step.id) {
        context.addIssue({ code: "custom", message: `Rollout step ${step.id} has invalid dependency ${dependencyId}` });
      }
    }
  }
  if (hasDependencyCycle(value.rolloutSteps.map((step) => ({ id: step.id, dependencies: step.dependsOnStepIds })))) {
    context.addIssue({ code: "custom", message: "Release rollout dependencies must be acyclic" });
  }
  for (const risk of value.knownRisks) {
    if (risk.status === "accepted" && risk.riskAcceptance === undefined) {
      context.addIssue({ code: "custom", message: `Accepted release risk ${risk.id} must include risk acceptance` });
    }
  }
  if (!value.preflightChecks.some((check) => check.required)) {
    context.addIssue({ code: "custom", message: "Release plan must include at least one required preflight check" });
  }
  for (const check of value.preflightChecks) {
    if (check.status === "pending" && check.checkedAt !== undefined) {
      context.addIssue({ code: "custom", message: `Pending preflight check ${check.id} cannot have checkedAt` });
    }
    if (check.status !== "pending" && check.checkedAt === undefined) {
      context.addIssue({ code: "custom", message: `Completed preflight check ${check.id} must have checkedAt` });
    }
  }
  if (value.rollback.targetRevision === value.release.revision) {
    context.addIssue({ code: "custom", message: "Rollback target revision must differ from the release revision" });
  }
  if (value.readiness === "ready") {
    if (value.qaVerdict !== "passed") {
      context.addIssue({ code: "custom", message: "A ready release plan requires a passed QA verdict" });
    }
    if (value.preflightChecks.some((check) => check.required && check.status !== "passed")) {
      context.addIssue({ code: "custom", message: "A ready release plan requires every required preflight check to pass" });
    }
    if (value.knownRisks.some((risk) => ["blocker", "critical"].includes(risk.severity) && risk.status !== "mitigated")) {
      context.addIssue({ code: "custom", message: "A ready release plan cannot contain unmitigated blocker or critical risks" });
    }
    if (value.knownRisks.some((risk) => risk.severity === "high" && risk.status === "open")) {
      context.addIssue({ code: "custom", message: "A ready release plan cannot contain open high-severity risks" });
    }
  }
});

export const FinalManifestContractSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  lineage: z.object({
    architecture: ArtifactReferenceSchema,
    implementationPlan: ArtifactReferenceSchema,
    integrationReport: ArtifactReferenceSchema,
    qaReport: ArtifactReferenceSchema,
    releasePlan: ArtifactReferenceSchema
  }).strict(),
  release: z.object({
    id: ContractIdSchema,
    version: z.string().min(1),
    targetEnvironment: z.string().min(1),
    revision: GitRevisionSchema,
    releasedAt: z.iso.datetime({ offset: true }),
    outcome: z.enum(["succeeded", "rolled-back", "failed"])
  }).strict(),
  deployedArtifacts: z.array(TypedArtifactReferenceSchema).min(1),
  releaseEvidence: z.array(TypedArtifactReferenceSchema).min(1),
  healthChecks: z.array(z.object({
    id: ContractIdSchema,
    name: z.string().min(1),
    status: z.enum(["passed", "failed"]),
    checkedAt: z.iso.datetime({ offset: true }),
    summary: z.string().min(1),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).min(1)
  }).strict()).min(1),
  incidents: z.array(z.object({
    id: ContractIdSchema,
    severity: SeveritySchema,
    status: z.enum(["open", "resolved"]),
    description: z.string().min(1),
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).default([])
  }).strict()).default([]),
  rollback: z.object({
    rolledBackAt: z.iso.datetime({ offset: true }),
    reason: z.string().min(1),
    targetRevision: GitRevisionSchema,
    evidenceArtifacts: z.array(TypedArtifactReferenceSchema).min(1)
  }).strict().optional()
}).strict().superRefine((value, context) => {
  requireUniqueIds(Object.values(value.lineage).map((reference) => reference.artifactId), "Final manifest lineage artifact", context);
  requireUniqueIds(value.deployedArtifacts.map((artifact) => artifact.artifactId), "Deployed artifact", context);
  requireUniqueIds(value.releaseEvidence.map((artifact) => artifact.artifactId), "Release evidence artifact", context);
  requireUniqueIds(value.healthChecks.map((check) => check.id), "Final health check", context);
  requireUniqueIds(value.incidents.map((incident) => incident.id), "Release incident", context);
  if (value.release.outcome === "succeeded") {
    if (value.healthChecks.some((check) => check.status !== "passed")) {
      context.addIssue({ code: "custom", message: "A successful release requires every health check to pass" });
    }
    if (value.incidents.some((incident) => ["blocker", "critical"].includes(incident.severity) && incident.status !== "resolved")) {
      context.addIssue({ code: "custom", message: "A successful release cannot contain unresolved blocker or critical incidents" });
    }
    if (value.rollback !== undefined) {
      context.addIssue({ code: "custom", message: "A successful release cannot include a rollback record" });
    }
  }
  if (value.release.outcome === "rolled-back" && value.rollback === undefined) {
    context.addIssue({ code: "custom", message: "A rolled-back release must include a rollback record" });
  }
  if (value.rollback?.targetRevision === value.release.revision) {
    context.addIssue({ code: "custom", message: "Rollback target revision must differ from the released revision" });
  }
  if (value.release.outcome === "failed"
    && value.healthChecks.every((check) => check.status === "passed")
    && value.incidents.every((incident) => incident.status === "resolved")) {
    context.addIssue({ code: "custom", message: "A failed release must include failed health evidence or an open incident" });
  }
});

export const ArtifactContractKindSchema = z.enum([
  "product-brief",
  "prd",
  "ux-architecture",
  "design-concepts",
  "architecture",
  "implementation-plan",
  "integration-report",
  "qa-report",
  "release-plan",
  "final-manifest"
]);

export type ArtifactContractKind = z.infer<typeof ArtifactContractKindSchema>;
export type ProductBriefContract = z.infer<typeof ProductBriefContractSchema>;
export type PrdContract = z.infer<typeof PrdContractSchema>;
export type UxArchitectureContract = z.infer<typeof UxArchitectureContractSchema>;
export type DesignConceptSetContract = z.infer<typeof DesignConceptSetContractSchema>;
export type ArchitectureContract = z.infer<typeof ArchitectureContractSchema>;
export type ImplementationPlanContract = z.infer<typeof ImplementationPlanContractSchema>;
export type IntegrationReportContract = z.infer<typeof IntegrationReportContractSchema>;
export type QaReportContract = z.infer<typeof QaReportContractSchema>;
export type ReleasePlanContract = z.infer<typeof ReleasePlanContractSchema>;
export type FinalManifestContract = z.infer<typeof FinalManifestContractSchema>;

const contractSchemas = {
  "product-brief": ProductBriefContractSchema,
  prd: PrdContractSchema,
  "ux-architecture": UxArchitectureContractSchema,
  "design-concepts": DesignConceptSetContractSchema,
  architecture: ArchitectureContractSchema,
  "implementation-plan": ImplementationPlanContractSchema,
  "integration-report": IntegrationReportContractSchema,
  "qa-report": QaReportContractSchema,
  "release-plan": ReleasePlanContractSchema,
  "final-manifest": FinalManifestContractSchema
} as const;

function requireUniqueIds(
  values: readonly string[],
  label: string,
  context: { addIssue(issue: { code: "custom"; message: string }): void }
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${label} IDs must be unique` });
  }
}

function requireUniqueStrings(
  values: readonly string[],
  label: string,
  context: { addIssue(issue: { code: "custom"; message: string }): void }
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${label} values must be unique` });
  }
}

function scopesConflict(leftScopes: readonly string[], rightScopes: readonly string[]): boolean {
  return leftScopes.some((left) => rightScopes.some((right) => {
    const leftRoot = scopeRoot(left);
    const rightRoot = scopeRoot(right);
    return leftRoot === rightRoot
      || leftRoot.startsWith(`${rightRoot}/`)
      || rightRoot.startsWith(`${leftRoot}/`);
  }));
}

function scopeRoot(scope: string): string {
  const normalized = scope.replaceAll("\\", "/");
  const wildcardIndex = normalized.search(/[*?\[]/);
  return (wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)).replace(/\/$/, "");
}

function hasDependencyCycle(nodes: readonly { id: string; dependencies: readonly string[] }[]): boolean {
  const dependenciesById = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of dependenciesById.get(id) ?? []) {
      if (dependenciesById.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

export function isArtifactContractKind(kind: string): kind is ArtifactContractKind {
  return ArtifactContractKindSchema.safeParse(kind).success;
}

export function validateArtifactPayload(kind: ArtifactContractKind, payload: unknown): unknown {
  return contractSchemas[kind].parse(payload);
}

export function artifactPayloadHash(kind: ArtifactContractKind, payload: unknown): string {
  return sha256(canonicalJson(validateArtifactPayload(kind, payload)));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}
