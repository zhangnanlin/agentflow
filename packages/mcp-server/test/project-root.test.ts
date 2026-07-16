import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRootResolver } from "../src/project-root.js";

describe("ProjectRootResolver", () => {
  let directory: string;
  let fixedRoot: string;
  let explicitRoot: string;
  let clientRoot: string;
  let gitRoot: string;
  let cwd: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentflow-project-root-"));
    fixedRoot = await createDirectory("fixed");
    explicitRoot = await createDirectory("workspace/explicit");
    clientRoot = await createDirectory("workspace");
    gitRoot = await createDirectory("git");
    cwd = await createDirectory("cwd");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("uses fixed, explicit, one client root, Git, then cwd priority", async () => {
    const listRoots = vi.fn(async () => [{ uri: pathToFileURL(clientRoot).href }]);
    const gitTopLevel = vi.fn(async () => gitRoot);
    const fixed = new ProjectRootResolver({ fixedRoot, cwd, listRoots, gitTopLevel });

    await expect(fixed.resolve(explicitRoot)).resolves.toEqual({
      projectRoot: fixedRoot,
      source: "fixed"
    });
    expect(listRoots).not.toHaveBeenCalled();
    expect(gitTopLevel).not.toHaveBeenCalled();

    const explicit = new ProjectRootResolver({ cwd, listRoots, gitTopLevel });
    await expect(explicit.resolve(explicitRoot)).resolves.toEqual({
      projectRoot: explicitRoot,
      source: "explicit"
    });
    expect(gitTopLevel).not.toHaveBeenCalled();

    const client = new ProjectRootResolver({
      cwd,
      listRoots,
      gitTopLevel: vi.fn(async () => gitRoot)
    });
    await expect(client.resolve()).resolves.toEqual({
      projectRoot: clientRoot,
      source: "client-root"
    });

    const git = new ProjectRootResolver({ cwd, listRoots: async () => [], gitTopLevel });
    await expect(git.resolve()).resolves.toEqual({ projectRoot: gitRoot, source: "git" });

    const fallback = new ProjectRootResolver({
      cwd,
      listRoots: async () => [],
      gitTopLevel: async () => undefined
    });
    await expect(fallback.resolve()).resolves.toEqual({ projectRoot: cwd, source: "cwd" });
  });

  it("rejects multiple canonical client roots before writes", async () => {
    const rootA = await createDirectory("a");
    const rootB = await createDirectory("b");
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => [
        { uri: pathToFileURL(rootB).href },
        { uri: pathToFileURL(rootA).href },
        { uri: pathToFileURL(rootA).href }
      ]
    });

    await expect(resolver.resolve()).rejects.toMatchObject({
      code: "PROJECT_ROOT_AMBIGUOUS",
      details: { candidates: [rootA, rootB] }
    });
  });

  it("accepts an explicit root inside one of multiple advertised roots", async () => {
    const otherRoot = await createDirectory("other");
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => [
        { uri: pathToFileURL(otherRoot).href },
        { uri: pathToFileURL(clientRoot).href }
      ]
    });

    await expect(resolver.resolve(explicitRoot)).resolves.toEqual({
      projectRoot: explicitRoot,
      source: "explicit"
    });
  });

  it("rejects an explicit root outside all advertised roots", async () => {
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => [{ uri: pathToFileURL(clientRoot).href }]
    });

    await expect(resolver.resolve(gitRoot)).rejects.toMatchObject({
      code: "PROJECT_ROOT_OUTSIDE_CLIENT_ROOTS",
      details: { projectRoot: gitRoot, clientRoots: [clientRoot] }
    });
  });

  it("decodes percent-encoded file roots and ignores non-file roots", async () => {
    const encodedRoot = await createDirectory("folder with space");
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => [
        { uri: "https://example.test/not-a-workspace" },
        { uri: pathToFileURL(encodedRoot).href }
      ]
    });

    await expect(resolver.resolve()).resolves.toEqual({
      projectRoot: encodedRoot,
      source: "client-root"
    });
  });

  it("rejects malformed encoded file roots with a structured error", async () => {
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => [{ uri: "file:///invalid%2Fworkspace" }]
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "PROJECT_ROOT_INVALID" });
  });

  it.each([
    ["relative paths", "relative/project"],
    ["missing paths", resolve("missing-agentflow-project-root")]
  ])("rejects %s", async (_label, candidate) => {
    const resolver = new ProjectRootResolver({ fixedRoot: candidate, cwd });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "PROJECT_ROOT_INVALID" });
  });

  it("rejects file paths", async () => {
    const file = join(directory, "not-a-directory.txt");
    await writeFile(file, "not a project", "utf8");
    const resolver = new ProjectRootResolver({ fixedRoot: file, cwd });

    await expect(resolver.resolve()).rejects.toMatchObject({
      code: "PROJECT_ROOT_INVALID",
      details: { candidate: file }
    });
  });

  it("falls back when roots/list is unsupported", async () => {
    const unsupported = Object.assign(new Error("Method not found"), { code: -32601 });
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => Promise.reject(unsupported),
      gitTopLevel: async () => gitRoot
    });

    await expect(resolver.resolve()).resolves.toEqual({ projectRoot: gitRoot, source: "git" });
  });

  it("falls back to cwd when the real Git lookup reports a non-repository", async () => {
    const resolver = new ProjectRootResolver({ cwd, listRoots: async () => [] });

    await expect(resolver.resolve()).resolves.toEqual({ projectRoot: cwd, source: "cwd" });
  });

  it("fails closed when roots/list fails unexpectedly", async () => {
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => Promise.reject(new Error("transport closed"))
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "PROJECT_ROOTS_UNAVAILABLE" });
  });

  it("requires dependency roots and results to be absolute directories", async () => {
    expect(isAbsolute(cwd)).toBe(true);
    const resolver = new ProjectRootResolver({
      cwd,
      listRoots: async () => [],
      gitTopLevel: async () => "relative-git-root"
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "PROJECT_ROOT_INVALID" });
  });

  async function createDirectory(relativePath: string): Promise<string> {
    const target = join(directory, relativePath);
    await mkdir(target, { recursive: true });
    return target;
  }
});
