import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
const commandArgs = process.argv.slice(3);
const validCommands = new Set(["dev", "build", "start"]);

if (!validCommands.has(command)) {
  console.error("Usage: node scripts/run-next.mjs <dev|build|start> [...args]");
  process.exit(1);
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nextBin = join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const proxyFlag = "--use-env-proxy";
const hasProxyEnv = Boolean(
  process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy
);
const canUseEnvProxy = process.allowedNodeEnvironmentFlags.has(proxyFlag);
const nodeArgs = [...(hasProxyEnv && canUseEnvProxy ? [proxyFlag] : []), nextBin, command, ...commandArgs];

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: process.env
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
