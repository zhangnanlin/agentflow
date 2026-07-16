import { posix, win32, type PlatformPath } from "node:path";
import { AgentFlowError } from "@agentflow/core";

export interface GlobalPathEnvironment {
  platform: NodeJS.Platform;
  home?: string;
  appData?: string;
  xdgConfigHome?: string;
  agentflowHome?: string;
  codexHome?: string;
}

export interface GlobalPathOverrides {
  vscodeConfig?: string;
}

export interface GlobalInstallationPaths {
  home: string;
  runtimeRoot: string;
  runtimeCli: string;
  runtimeMcp: string;
  installManifest: string;
  skillsLock: string;
  skillsRoot: string;
  codexConfig: string;
  cursorConfig: string;
  vscodeConfig: string;
}

export function globalInstallationPaths(
  environment: GlobalPathEnvironment,
  overrides: GlobalPathOverrides = {}
): GlobalInstallationPaths {
  const path = pathApi(environment.platform);
  const home = absolutePath(path, environment.home, "home");
  const runtimeRoot = environment.agentflowHome === undefined
    ? path.join(home, ".agentflow")
    : absolutePath(path, environment.agentflowHome, "AGENTFLOW_HOME");
  const codexHome = environment.codexHome === undefined
    ? path.join(home, ".codex")
    : absolutePath(path, environment.codexHome, "CODEX_HOME");
  const vscodeConfig = overrides.vscodeConfig === undefined
    ? defaultVsCodeConfig(path, environment, home)
    : absolutePath(path, overrides.vscodeConfig, "VS Code configuration override");

  return {
    home,
    runtimeRoot,
    runtimeCli: path.join(runtimeRoot, "bin", "agentflow-cli.mjs"),
    runtimeMcp: path.join(runtimeRoot, "bin", "agentflow-mcp.mjs"),
    installManifest: path.join(runtimeRoot, "install.json"),
    skillsLock: path.join(runtimeRoot, "skills-lock.json"),
    skillsRoot: path.join(home, ".agents", "skills"),
    codexConfig: path.join(codexHome, "config.toml"),
    cursorConfig: path.join(home, ".cursor", "mcp.json"),
    vscodeConfig
  };
}

function defaultVsCodeConfig(
  path: PlatformPath,
  environment: GlobalPathEnvironment,
  home: string
): string {
  if (environment.platform === "win32") {
    const appData = absolutePath(path, environment.appData, "APPDATA");
    return path.join(appData, "Code", "User", "mcp.json");
  }
  if (environment.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  const configRoot = environment.xdgConfigHome === undefined
    ? path.join(home, ".config")
    : absolutePath(path, environment.xdgConfigHome, "XDG_CONFIG_HOME");
  return path.join(configRoot, "Code", "User", "mcp.json");
}

function pathApi(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

function absolutePath(path: PlatformPath, value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0 || !path.isAbsolute(value)) {
    throw new AgentFlowError(`${label} must be a non-empty absolute path`, "GLOBAL_PATH_INVALID", {
      label,
      value
    });
  }
  return path.resolve(value);
}
