import { describe, expect, it } from "vitest";
import {
  ArchitectureContractSchema,
  DesignConceptSetContractSchema,
  FinalManifestContractSchema,
  ImplementationPlanContractSchema,
  IntegrationReportContractSchema,
  PrdContractSchema,
  ProductBriefContractSchema,
  QaReportContractSchema,
  ReleasePlanContractSchema,
  UxArchitectureContractSchema,
  artifactPayloadHash,
  canonicalJson,
  sha256
} from "../src/index.js";

const sourceHash = sha256("source");

describe("M2 artifact contracts", () => {
  it("validates a traceable product brief and PRD", () => {
    const brief = productBrief();
    expect(ProductBriefContractSchema.parse(brief).recommendedApproachId).toBe("A");
    expect(() => ProductBriefContractSchema.parse({ ...brief, recommendedApproachId: "missing" })).toThrow();

    const prd = PrdContractSchema.parse({
      version: 1,
      title: "Team planner",
      summary: "Coordinate small project teams.",
      sourceProductBrief: { artifactId: "brief-1", sha256: sourceHash },
      goals: ["Reduce coordination time"],
      nonGoals: ["Enterprise portfolio management"],
      userStories: [{
        id: "story-1",
        actor: "team lead",
        capability: "create a project",
        benefit: "work starts with shared context",
        acceptanceCriteria: ["A named project is visible to its members"]
      }],
      functionalRequirements: [{
        id: "fr-1",
        description: "Create projects",
        priority: "must",
        acceptanceCriteria: ["Reject an empty project name"]
      }],
      nonFunctionalRequirements: [{
        id: "nfr-1",
        category: "accessibility",
        target: "WCAG 2.2 AA",
        measurement: "Automated and keyboard checks"
      }]
    });
    expect(prd.sourceProductBrief.sha256).toBe(sourceHash);
  });

  it("rejects UX journeys that reference unknown roles or screens", () => {
    const ux = uxArchitecture();
    expect(UxArchitectureContractSchema.parse(ux).screens).toHaveLength(1);
    expect(() => UxArchitectureContractSchema.parse({
      ...ux,
      journeys: [{
        id: "journey-bad",
        roleId: "missing-role",
        goal: "Fail validation",
        steps: [{ id: "step-bad", screenId: "missing-screen", action: "Open", outcome: "None" }]
      }]
    })).toThrow();
  });

  it("requires exactly one rendered A, B, and C concept from one writer ledger", () => {
    const set = designConceptSet();
    expect(DesignConceptSetContractSchema.parse(set).concepts.map((concept) => concept.label)).toEqual(["A", "B", "C"]);
    expect(() => DesignConceptSetContractSchema.parse({
      ...set,
      concepts: [set.concepts[0], set.concepts[0], set.concepts[2]]
    })).toThrow();
  });

  it("hashes validated payloads with deterministic canonical JSON", () => {
    const brief = productBrief();
    const reordered = Object.fromEntries(Object.entries(brief).reverse());
    expect(artifactPayloadHash("product-brief", brief)).toBe(artifactPayloadHash("product-brief", reordered));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});

describe("M3 delivery artifact contracts", () => {
  it("validates a traceable architecture through final-manifest chain", () => {
    expect(ArchitectureContractSchema.parse(architecture()).sourcePrd.artifactId).toBe("prd-1");
    expect(ImplementationPlanContractSchema.parse(implementationPlan()).tasks).toHaveLength(2);
    expect(IntegrationReportContractSchema.parse(integrationReport()).verdict).toBe("passed");
    expect(QaReportContractSchema.parse(qaReport()).verdict).toBe("passed");
    expect(ReleasePlanContractSchema.parse(releasePlan()).readiness).toBe("ready");
    expect(FinalManifestContractSchema.parse(finalManifest()).release.outcome).toBe("succeeded");
  });

  it("rejects unknown architecture references and unknown fields", () => {
    const value = architecture();
    expect(() => ArchitectureContractSchema.parse({
      ...value,
      interfaces: [{ ...value.interfaces[0], toComponentId: "missing-component" }]
    })).toThrow();
    expect(() => ArchitectureContractSchema.parse({ ...value, undocumented: true })).toThrow();
  });

  it("rejects cyclic or incorrectly ordered implementation tasks", () => {
    const value = implementationPlan();
    expect(() => ImplementationPlanContractSchema.parse({
      ...value,
      tasks: [
        { ...value.tasks[0], dependsOnTaskIds: ["task-api"] },
        { ...value.tasks[1], dependsOnTaskIds: ["task-ui"] }
      ]
    })).toThrow();
    expect(() => ImplementationPlanContractSchema.parse({
      ...value,
      integrationStrategy: { ...value.integrationStrategy, taskOrder: ["task-api", "task-ui"] }
    })).toThrow();
  });

  it("requires bounded worker prompts and isolated concurrent write scopes", () => {
    const value = implementationPlan();
    expect(() => ImplementationPlanContractSchema.parse({
      ...value,
      tasks: [{ ...value.tasks[0], inputArtifacts: [] }, value.tasks[1]]
    })).toThrow();
    expect(() => ImplementationPlanContractSchema.parse({
      ...value,
      tasks: [
        { ...value.tasks[0], requiresWorktree: false },
        {
          ...value.tasks[1],
          dependsOnTaskIds: [],
          requiresWorktree: true
        }
      ],
      waves: [{ id: "wave-parallel", taskIds: ["task-ui", "task-api"], exitCriteria: ["Both tasks pass"] }]
    })).toThrow();
    expect(() => ImplementationPlanContractSchema.parse({
      ...value,
      tasks: [
        { ...value.tasks[0], requiresWorktree: true },
        {
          ...value.tasks[1],
          dependsOnTaskIds: [],
          writeScopes: ["packages/web/src/projects/api/**"],
          requiresWorktree: true
        }
      ],
      waves: [{ id: "wave-parallel", taskIds: ["task-ui", "task-api"], exitCriteria: ["Both tasks pass"] }]
    })).toThrow();
  });

  it("does not permit a passed integration verdict with unsafe evidence", () => {
    const value = integrationReport();
    expect(() => IntegrationReportContractSchema.parse({
      ...value,
      checks: [{ ...value.checks[0], status: "failed" }]
    })).toThrow();
    expect(() => IntegrationReportContractSchema.parse({
      ...value,
      taskResults: [{ ...value.taskResults[0], status: "excluded", exclusionReason: "Deferred" }, value.taskResults[1]]
    })).toThrow();
  });

  it("does not permit QA to pass failed coverage or unaccepted findings", () => {
    const value = qaReport();
    expect(() => QaReportContractSchema.parse({
      ...value,
      testCases: [{ ...value.testCases[0], status: "failed" }]
    })).toThrow();
    expect(() => QaReportContractSchema.parse({
      ...value,
      findings: [{
        id: "finding-1",
        testCaseId: "qa-fr-1",
        severity: "high",
        status: "accepted",
        description: "Known edge case",
        evidenceArtifacts: []
      }]
    })).toThrow();
  });

  it("blocks release readiness when QA or preflight safety is contradictory", () => {
    const value = releasePlan();
    expect(() => ReleasePlanContractSchema.parse({ ...value, qaVerdict: "failed" })).toThrow();
    expect(() => ReleasePlanContractSchema.parse({
      ...value,
      preflightChecks: [{ ...value.preflightChecks[0], status: "pending" }]
    })).toThrow();
    expect(() => ReleasePlanContractSchema.parse({
      ...value,
      preflightChecks: [{ ...value.preflightChecks[0], checkedAt: undefined }]
    })).toThrow();
    expect(() => ReleasePlanContractSchema.parse({
      ...value,
      rollback: { ...value.rollback, targetRevision: value.release.revision }
    })).toThrow();
  });

  it("requires final release outcome to match health and rollback evidence", () => {
    const value = finalManifest();
    expect(() => FinalManifestContractSchema.parse({
      ...value,
      healthChecks: [{ ...value.healthChecks[0], status: "failed" }]
    })).toThrow();
    expect(() => FinalManifestContractSchema.parse({
      ...value,
      release: { ...value.release, outcome: "rolled-back" }
    })).toThrow();
  });

  it("hashes each new contract from its validated canonical payload", () => {
    const value = architecture();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(artifactPayloadHash("architecture", value)).toBe(artifactPayloadHash("architecture", reordered));
    expect(artifactPayloadHash("final-manifest", finalManifest())).toMatch(/^[a-f0-9]{64}$/);
  });
});

function architecture() {
  return {
    version: 1 as const,
    title: "Team planner architecture",
    summary: "A web client and API with explicit requirement ownership.",
    sourcePrd: { artifactId: "prd-1", sha256: sourceHash },
    sourceDesignManifest: { artifactId: "design-manifest-1", sha256: sha256("design-manifest") },
    principles: ["Keep domain behavior behind stable interfaces"],
    components: [
      {
        id: "web-client",
        name: "Web client",
        kind: "frontend" as const,
        responsibilities: ["Render and validate project forms"],
        requirementIds: ["fr-1"]
      },
      {
        id: "project-api",
        name: "Project API",
        kind: "backend" as const,
        responsibilities: ["Persist valid projects"],
        requirementIds: ["fr-1"]
      }
    ],
    interfaces: [{
      id: "project-http-api",
      fromComponentId: "web-client",
      toComponentId: "project-api",
      protocol: "HTTPS JSON",
      contract: "POST /projects validates and returns a project",
      security: "Authenticated requests with schema validation"
    }],
    dataStores: [{
      id: "project-store",
      name: "Project database",
      ownerComponentId: "project-api",
      classification: "internal" as const,
      retention: "Retain while the workspace is active"
    }],
    decisions: [{
      id: "adr-1",
      title: "Use an HTTP boundary",
      decision: "Expose project operations through a versioned JSON API",
      rationale: "Separates UI delivery from persistence",
      consequences: ["The request schema is a compatibility boundary"],
      status: "accepted" as const
    }],
    requirementCoverage: [{
      requirementId: "fr-1",
      componentIds: ["web-client", "project-api"],
      verificationApproach: "Component tests plus an API integration test"
    }],
    risks: [{
      id: "risk-contract-drift",
      description: "Client and API schemas can diverge",
      likelihood: "medium" as const,
      impact: "high" as const,
      mitigation: "Generate client types from the API schema",
      ownerComponentId: "project-api"
    }]
  };
}

function implementationPlan() {
  return {
    version: 1 as const,
    title: "Team planner implementation plan",
    summary: "Implement the UI before wiring it to the API.",
    sourceArchitecture: { artifactId: "architecture-1", sha256: sha256("architecture") },
    sourcePrd: { artifactId: "prd-1", sha256: sourceHash },
    repository: { branch: "main", baseRevision: sha256("base-revision") },
    scope: { requirementIds: ["fr-1"], componentIds: ["web-client", "project-api"] },
    tasks: [
      {
        id: "task-ui",
        title: "Implement project form",
        description: "Render and validate the project form.",
        profile: "frontend",
        componentIds: ["web-client"],
        requirementIds: ["fr-1"],
        dependsOnTaskIds: [],
        inputArtifacts: [{ artifactId: "architecture-1", kind: "architecture", sha256: sha256("architecture") }],
        writeScopes: ["packages/web/src/projects/**"],
        forbiddenScopes: ["packages/api/**"],
        acceptanceCriteria: ["An empty project name is rejected"],
        verificationCommands: ["npm test -- project-form"],
        expectedOutputs: ["Project form implementation and tests"],
        requiresWorktree: false,
        risk: "low" as const
      },
      {
        id: "task-api",
        title: "Implement project endpoint",
        description: "Validate and persist new projects.",
        profile: "backend",
        componentIds: ["project-api"],
        requirementIds: ["fr-1"],
        dependsOnTaskIds: ["task-ui"],
        inputArtifacts: [{ artifactId: "architecture-1", kind: "architecture", sha256: sha256("architecture") }],
        writeScopes: ["packages/api/src/projects/**"],
        forbiddenScopes: ["packages/web/**"],
        acceptanceCriteria: ["A valid project is persisted"],
        verificationCommands: ["npm test -- project-api"],
        expectedOutputs: ["Project endpoint implementation and tests"],
        requiresWorktree: false,
        risk: "medium" as const
      }
    ],
    waves: [
      { id: "wave-ui", taskIds: ["task-ui"], exitCriteria: ["UI tests pass"] },
      { id: "wave-api", taskIds: ["task-api"], exitCriteria: ["API tests pass"] }
    ],
    integrationStrategy: {
      taskOrder: ["task-ui", "task-api"],
      conflictPolicy: "The integration owner resolves shared contract changes.",
      verificationCommands: ["npm test", "npm run build"]
    }
  };
}

function integrationReport() {
  const revision = sha256("integrated-revision");
  return {
    version: 1 as const,
    summary: "All planned work was integrated and verified.",
    sourceImplementationPlan: { artifactId: "implementation-plan-1", sha256: sha256("implementation-plan") },
    repository: {
      branch: "main",
      baseRevision: sha256("base-revision"),
      integratedRevision: revision
    },
    planTaskIds: ["task-ui", "task-api"],
    taskResults: [
      {
        taskId: "task-ui",
        status: "integrated" as const,
        revisions: [sha256("ui-revision")],
        outputArtifacts: [artifactReference("web-bundle", "build-output")],
        verificationCheckIds: ["integration-check"]
      },
      {
        taskId: "task-api",
        status: "integrated" as const,
        revisions: [sha256("api-revision")],
        outputArtifacts: [artifactReference("api-bundle", "build-output")],
        verificationCheckIds: ["integration-check"]
      }
    ],
    checks: [{
      id: "integration-check",
      category: "integration" as const,
      command: "npm test",
      required: true,
      status: "passed" as const,
      summary: "All integration tests passed",
      recordedAt: "2026-07-15T09:00:00.000Z",
      evidenceArtifacts: [artifactReference("integration-log", "test-report")]
    }],
    conflicts: [],
    issues: [],
    verdict: "passed" as const
  };
}

function qaReport() {
  return {
    version: 1 as const,
    summary: "Required functional and security coverage passed.",
    sourceIntegrationReport: { artifactId: "integration-report-1", sha256: sha256("integration-report") },
    environment: {
      name: "staging",
      revision: sha256("integrated-revision"),
      baseUrl: "https://staging.example.test"
    },
    requirementIds: ["fr-1"],
    testCases: [{
      id: "qa-fr-1",
      name: "Create a project",
      category: "functional" as const,
      requirementIds: ["fr-1"],
      required: true,
      status: "passed" as const,
      observedResult: "A valid project was persisted and displayed.",
      recordedAt: "2026-07-15T09:05:00.000Z",
      evidenceArtifacts: [artifactReference("qa-functional-log", "test-report")]
    }],
    qualityGates: [{
      id: "qa-security",
      name: "Security baseline",
      category: "security" as const,
      required: true,
      status: "passed" as const,
      summary: "No release-blocking findings",
      recordedAt: "2026-07-15T09:10:00.000Z",
      evidenceArtifacts: [artifactReference("security-report", "security-report")]
    }],
    findings: [],
    verdict: "passed" as const
  };
}

function releasePlan() {
  return {
    version: 1 as const,
    summary: "Deploy one immutable build with monitored rollback.",
    sourceQaReport: { artifactId: "qa-report-1", sha256: sha256("qa-report") },
    qaVerdict: "passed" as const,
    release: {
      id: "release-1",
      version: "1.0.0",
      targetEnvironment: "production",
      revision: sha256("release-revision")
    },
    releaseArtifacts: [artifactReference("release-bundle", "release-bundle")],
    preflightChecks: [{
      id: "preflight-backup",
      description: "Verify a current database backup",
      required: true,
      status: "passed" as const,
      checkedAt: "2026-07-15T09:20:00.000Z",
      evidenceArtifacts: [artifactReference("backup-proof", "release-evidence")]
    }],
    rolloutSteps: [
      {
        id: "deploy-canary",
        description: "Deploy to the canary pool",
        dependsOnStepIds: [],
        verificationCommands: ["check canary health"]
      },
      {
        id: "deploy-production",
        description: "Promote the verified canary",
        dependsOnStepIds: ["deploy-canary"],
        verificationCommands: ["check production health"]
      }
    ],
    rollback: {
      owner: "release-owner",
      targetRevision: sha256("base-revision"),
      triggers: ["Error rate exceeds two percent for five minutes"],
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
    readiness: "ready" as const
  };
}

function finalManifest() {
  return {
    version: 1 as const,
    summary: "Release 1.0.0 is deployed and healthy.",
    lineage: {
      architecture: { artifactId: "architecture-1", sha256: sha256("architecture") },
      implementationPlan: { artifactId: "implementation-plan-1", sha256: sha256("implementation-plan") },
      integrationReport: { artifactId: "integration-report-1", sha256: sha256("integration-report") },
      qaReport: { artifactId: "qa-report-1", sha256: sha256("qa-report") },
      releasePlan: { artifactId: "release-plan-1", sha256: sha256("release-plan") }
    },
    release: {
      id: "release-1",
      version: "1.0.0",
      targetEnvironment: "production",
      revision: sha256("release-revision"),
      releasedAt: "2026-07-15T09:30:00.000Z",
      outcome: "succeeded" as const
    },
    deployedArtifacts: [artifactReference("release-bundle", "release-bundle")],
    releaseEvidence: [artifactReference("deployment-log", "release-evidence")],
    healthChecks: [{
      id: "production-health",
      name: "Production health",
      status: "passed" as const,
      checkedAt: "2026-07-15T09:35:00.000Z",
      summary: "Error rate and latency are within thresholds",
      evidenceArtifacts: [artifactReference("health-report", "release-evidence")]
    }],
    incidents: []
  };
}

function artifactReference(artifactId: string, kind: string) {
  return { artifactId, kind, sha256: sha256(artifactId) };
}

function productBrief() {
  return {
    version: 1 as const,
    title: "Team planner",
    summary: "A focused planner for small teams.",
    projectType: "new" as const,
    users: [{ name: "team lead", needs: ["shared priorities"], context: "weekly planning" }],
    problem: { statement: "Work context is scattered.", evidence: ["User interviews"], impact: "Delivery slows down." },
    outcomes: ["Teams see one current plan"],
    inScope: ["Projects and tasks"],
    outOfScope: ["Portfolio accounting"],
    constraints: ["Web first"],
    successMetrics: [{ name: "planning time", target: "under 15 minutes", measurement: "session analytics" }],
    approaches: [
      { id: "A", summary: "Board first", benefits: ["Fast scanning"], costs: ["Limited reporting"] },
      { id: "B", summary: "List first", benefits: ["Dense data"], costs: ["Less spatial context"] }
    ],
    recommendedApproachId: "A",
    dependencies: [],
    risks: [],
    openQuestions: [],
    approvedDecisions: ["Web first"]
  };
}

function uxArchitecture() {
  return {
    version: 1 as const,
    sourcePrd: { artifactId: "prd-1", sha256: sourceHash },
    roles: [{ id: "lead", name: "Team lead", permissions: ["manage projects"] }],
    screens: [{
      id: "project-board",
      name: "Project board",
      purpose: "Plan and track work",
      route: "/projects/:id",
      supportedRoles: ["lead"],
      states: ["loading", "empty", "ready", "error"] as const
    }],
    journeys: [{
      id: "plan-work",
      roleId: "lead",
      goal: "Plan a sprint",
      steps: [{ id: "open-board", screenId: "project-board", action: "Open project", outcome: "Board is visible", exceptions: [] }]
    }],
    navigation: [],
    responsiveModes: [{ id: "mobile", minWidth: 0, maxWidth: 767, behavior: "Single column" }],
    contentDependencies: [],
    dataDependencies: ["Project API"],
    accessibilityRequirements: ["Keyboard operable"]
  };
}

function designConceptSet() {
  const concept = (label: "A" | "B" | "C", index: number) => ({
    id: `concept-${label.toLowerCase()}`,
    label,
    title: `Direction ${label}`,
    briefArtifactId: `concept-${label.toLowerCase()}-brief`,
    visualLanguage: `Visual language ${label}`,
    layoutPrinciples: ["Clear hierarchy"],
    interactionPrinciples: ["Visible system status"],
    differentiators: [`Differentiator ${label}`],
    risks: [],
    figmaPageNodeId: `1:${index}`,
    representativeNodeIds: [`2:${index}`],
    screenshot: { artifactId: `concept-${label.toLowerCase()}-shot`, sha256: sha256(`shot-${label}`) }
  });
  return {
    version: 1 as const,
    sourceUxArchitecture: { artifactId: "ux-1", sha256: sourceHash },
    figmaFile: { fileKey: "file-key", url: "https://www.figma.com/design/file-key/AgentFlow" },
    representativeScreenId: "project-board",
    concepts: [concept("A", 1), concept("B", 2), concept("C", 3)],
    comparisonCriteria: [
      { id: "clarity", name: "Clarity", description: "Ease of scanning" },
      { id: "density", name: "Density", description: "Information visible at once" }
    ],
    writer: { workerId: "figma-writer", resourceId: "figma-main", operationIds: ["op-a", "op-b", "op-c"] }
  };
}
