import { loadRoutingEnv } from "./env.mjs";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolveCli } from "./cli-command.mjs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jevBackend, MISSING_KEY_HINT } from "./backend.mjs";
import { CODEX_AUTO_MODEL, startCodexProxy } from "./codex-proxy.mjs";

const PROVIDER = "jev";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPLAIN_SKILL = join(ROOT, "skills", "codex", "jev-explain", "SKILL.md");

export function installCodexSkill(home = homedir()) {
  const target = join(home, ".agents", "skills", "jev-router-explain", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(EXPLAIN_SKILL, target);
  return target;
}

export { loadRoutingEnv as loadEnv } from "./env.mjs";

export function resolveCodex() {
  return resolveCli("codex");
}

export const codexArgs = (baseURL, args) => [
  ...(args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))
    ? []
    : ["--model", CODEX_AUTO_MODEL]),
  "--config",
  `model_provider="${PROVIDER}"`,
  "--config",
  `model_providers.${PROVIDER}.name="Jev Router"`,
  "--config",
  `model_providers.${PROVIDER}.base_url="${baseURL}"`,
  "--config",
  `model_providers.${PROVIDER}.wire_api="responses"`,
  "--config",
  `model_providers.${PROVIDER}.requires_openai_auth=true`,
  "--config",
  `model_providers.${PROVIDER}.supports_websockets=false`,
  ...args,
];

// Loads configuration, starts the optional routing proxy, and launches the Codex CLI.
export async function runCodex() {
  loadRoutingEnv();
  try {
    installCodexSkill();
  } catch (err) {
    process.stderr.write(`[jev] could not install the Codex explanation skill: ${err.message}\n`);
  }
  const command = resolveCodex();
  if (!command) {
    process.stderr.write(
      "[jev] OpenAI Codex is not installed, or `codex` is not on your PATH.\n" +
        "[jev] jev-codex requires a native CLI or Windows PowerShell shim; batch-only shims are unsupported.\n" +
        "[jev]   https://developers.openai.com/codex/cli\n",
    );
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  let close = () => {};
  const statusId = `codex-${process.pid}`;
  process.env.JEV_CODEX_STATUS_ID = statusId;
  if (jevBackend()) {
    const proxy = await startCodexProxy({ statusId });
    close = proxy.close;
    args = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
  } else {
    process.stderr.write(
      "[jev] no Jev key found - starting Codex without routing\n" +
        `[jev] add ${MISSING_KEY_HINT} to ${join(homedir(), ".jev-router.env")} and restart jev-codex\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    childArgs,
    { stdio: "inherit", shell: false, env: process.env },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start Codex: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
