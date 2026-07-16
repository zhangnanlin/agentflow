#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentFlowMcpServer } from "./server.js";

function fixedProjectRootFrom(argv: string[]): string | undefined {
  const optionIndex = argv.indexOf("--project-root");
  if (optionIndex >= 0) {
    const value = argv[optionIndex + 1];
    if (!value) throw new Error("--project-root requires a path");
    return resolve(value);
  }
  const environmentRoot = process.env.AGENTFLOW_PROJECT_ROOT;
  return environmentRoot === undefined || environmentRoot.length === 0
    ? undefined
    : resolve(environmentRoot);
}

try {
  const fixedProjectRoot = fixedProjectRootFrom(process.argv.slice(2));
  const server = createAgentFlowMcpServer(
    fixedProjectRoot === undefined ? {} : { projectRoot: fixedProjectRoot }
  );
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: "MCP_START_FAILED",
    message: error instanceof Error ? error.message : "Unable to start AgentFlow MCP server"
  })}\n`);
  process.exitCode = 1;
}
