import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentFlowError } from "@agentflow/core";

export interface DistributionAssets {
  root: string;
  cliBundle: string;
  mcpBundle: string;
  skillsDirectory: string;
  skillsLockPath: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveDistributionAssets(
  moduleUrl = import.meta.url
): Promise<DistributionAssets> {
  const directory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(directory, ".."),
    resolve(directory, "../.."),
    resolve(directory, "../../..")
  ];

  for (const root of candidates) {
    const assets: DistributionAssets = {
      root,
      cliBundle: resolve(root, "bundle/agentflow-cli.mjs"),
      mcpBundle: resolve(root, "bundle/agentflow-mcp.mjs"),
      skillsDirectory: resolve(root, ".agents/skills"),
      skillsLockPath: resolve(root, "skills-lock.json")
    };
    const required = [
      assets.cliBundle,
      assets.mcpBundle,
      assets.skillsDirectory,
      assets.skillsLockPath
    ];
    if ((await Promise.all(required.map(pathExists))).every(Boolean)) return assets;
  }

  throw new AgentFlowError(
    "AgentFlow distribution assets are missing",
    "DISTRIBUTION_ASSETS_MISSING"
  );
}
