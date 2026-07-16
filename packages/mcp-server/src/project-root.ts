import { execFile } from "node:child_process";
import { lstat as nodeLstat, realpath as nodeRealpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentFlowError } from "@agentflow/core";

const execFileAsync = promisify(execFile);

export interface ProjectRootResolution {
  projectRoot: string;
  source: "fixed" | "explicit" | "client-root" | "git" | "cwd";
}

export interface ProjectRootClientRoot {
  uri: string;
}

export interface ProjectRootResolverDependencies {
  fixedRoot?: string;
  cwd?: string;
  listRoots?: () => Promise<readonly ProjectRootClientRoot[]>;
  gitTopLevel?: (cwd: string) => Promise<string | undefined>;
  realpath?: (path: string) => Promise<string>;
  lstat?: (path: string) => Promise<{ isDirectory(): boolean }>;
}

export class ProjectRootResolver {
  private readonly cwd: string;
  private readonly resolveRealpath: (path: string) => Promise<string>;
  private readonly resolveLstat: (path: string) => Promise<{ isDirectory(): boolean }>;

  constructor(private readonly dependencies: ProjectRootResolverDependencies = {}) {
    this.cwd = dependencies.cwd ?? process.cwd();
    this.resolveRealpath = dependencies.realpath ?? nodeRealpath;
    this.resolveLstat = dependencies.lstat ?? nodeLstat;
  }

  async resolve(explicitProjectRoot?: string): Promise<ProjectRootResolution> {
    if (this.dependencies.fixedRoot !== undefined) {
      return this.resolveCandidate(this.dependencies.fixedRoot, "fixed");
    }

    const clientRoots = await this.clientFileRoots();
    if (explicitProjectRoot !== undefined) {
      const explicit = await this.resolveCandidate(explicitProjectRoot, "explicit");
      this.assertAllowedByClientRoots(explicit.projectRoot, clientRoots);
      return explicit;
    }

    if (clientRoots.length > 1) {
      throw new AgentFlowError(
        "Multiple project roots are available; provide an explicit absolute projectRoot",
        "PROJECT_ROOT_AMBIGUOUS",
        { candidates: clientRoots }
      );
    }
    if (clientRoots.length === 1) {
      return { projectRoot: clientRoots[0]!, source: "client-root" };
    }

    const gitRoot = await this.gitTopLevel();
    return gitRoot === undefined
      ? this.resolveCandidate(this.cwd, "cwd")
      : this.resolveCandidate(gitRoot, "git");
  }

  private async clientFileRoots(): Promise<string[]> {
    if (this.dependencies.listRoots === undefined) return [];

    let roots: readonly ProjectRootClientRoot[];
    try {
      roots = await this.dependencies.listRoots();
    } catch (error) {
      if (isUnsupportedRootsError(error)) return [];
      throw new AgentFlowError(
        "Unable to inspect the MCP client workspace roots",
        "PROJECT_ROOTS_UNAVAILABLE",
        { message: error instanceof Error ? error.message : "roots/list failed" }
      );
    }

    const canonical = new Set<string>();
    for (const root of roots) {
      let url: URL;
      let filePath: string | undefined;
      try {
        url = new URL(root.uri);
        if (url.protocol === "file:") filePath = fileURLToPath(url);
      } catch {
        throw new AgentFlowError("The MCP client supplied an invalid workspace URI", "PROJECT_ROOT_INVALID", {
          uri: root.uri
        });
      }
      if (url.protocol !== "file:") continue;
      canonical.add((await this.resolveCandidate(filePath!, "client-root")).projectRoot);
    }
    return [...canonical].sort((left, right) => left.localeCompare(right));
  }

  private async gitTopLevel(): Promise<string | undefined> {
    if (this.dependencies.gitTopLevel !== undefined) {
      try {
        return await this.dependencies.gitTopLevel(this.cwd);
      } catch (error) {
        throw new AgentFlowError("Unable to resolve the Git project root", "PROJECT_ROOT_GIT_UNAVAILABLE", {
          message: error instanceof Error ? error.message : "Git root lookup failed"
        });
      }
    }

    try {
      const result = await execFileAsync(
        "git",
        ["-C", this.cwd, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", windowsHide: true }
      );
      return String(result.stdout).trim();
    } catch (error) {
      if (isNotGitRepositoryError(error)) return undefined;
      throw new AgentFlowError("Unable to resolve the Git project root", "PROJECT_ROOT_GIT_UNAVAILABLE", {
        message: error instanceof Error ? error.message : "Git root lookup failed"
      });
    }
  }

  private async resolveCandidate(
    candidate: string,
    source: ProjectRootResolution["source"]
  ): Promise<ProjectRootResolution> {
    if (!isAbsolute(candidate)) {
      throw new AgentFlowError("Project roots must be absolute paths", "PROJECT_ROOT_INVALID", { candidate });
    }

    try {
      const canonical = await this.resolveRealpath(candidate);
      const stats = await this.resolveLstat(canonical);
      if (!stats.isDirectory()) {
        throw new AgentFlowError("Project root is not a directory", "PROJECT_ROOT_INVALID", { candidate });
      }
      return { projectRoot: canonical, source };
    } catch (error) {
      if (error instanceof AgentFlowError) throw error;
      throw new AgentFlowError("Project root is unavailable", "PROJECT_ROOT_INVALID", {
        candidate,
        message: error instanceof Error ? error.message : "path validation failed"
      });
    }
  }

  private assertAllowedByClientRoots(projectRoot: string, clientRoots: readonly string[]): void {
    if (clientRoots.length === 0) return;
    if (clientRoots.some((clientRoot) => containsPath(clientRoot, projectRoot))) return;
    throw new AgentFlowError(
      "Explicit projectRoot is outside the MCP client's advertised workspace roots",
      "PROJECT_ROOT_OUTSIDE_CLIENT_ROOTS",
      { projectRoot, clientRoots }
    );
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function isUnsupportedRootsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === -32601 || code === "METHOD_NOT_FOUND";
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return candidate.code === 128
    && typeof candidate.stderr === "string"
    && candidate.stderr.toLowerCase().includes("not a git repository");
}
