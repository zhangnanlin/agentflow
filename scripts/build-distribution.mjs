import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = resolve(root, "bundle");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new TypeError("package.json must declare a non-empty version");
}
await mkdir(bundleDirectory, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  define: {
    __AGENTFLOW_VERSION__: JSON.stringify(packageJson.version)
  },
  sourcemap: true,
  legalComments: "eof",
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __agentflowCreateRequire } from \"node:module\";",
      "const require = __agentflowCreateRequire(import.meta.url);"
    ].join("\n")
  },
  logLevel: "info"
};

function stripEntryShebang(entryPoint) {
  return {
    name: "strip-entry-shebang",
    setup(context) {
      context.onLoad({ filter: /\.ts$/ }, async (args) => {
        if (resolve(args.path) !== entryPoint) return undefined;
        const source = await readFile(args.path, "utf8");
        return {
          contents: source.replace(/^#![^\r\n]*(?:\r?\n|$)/, ""),
          loader: "ts",
          resolveDir: dirname(args.path)
        };
      });
    }
  };
}

const cliEntryPoint = resolve(root, "packages/cli/src/index.ts");
await build({
  ...shared,
  entryPoints: [cliEntryPoint],
  plugins: [stripEntryShebang(cliEntryPoint)],
  outfile: resolve(bundleDirectory, "agentflow-cli.mjs")
});

const mcpEntryPoint = resolve(root, "packages/mcp-server/src/index.ts");
await build({
  ...shared,
  entryPoints: [mcpEntryPoint],
  plugins: [stripEntryShebang(mcpEntryPoint)],
  outfile: resolve(bundleDirectory, "agentflow-mcp.mjs")
});
