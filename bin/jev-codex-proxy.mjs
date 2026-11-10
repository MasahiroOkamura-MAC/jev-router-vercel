#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { jevBackend, MISSING_KEY_HINT } from "../src/backend.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";

for (const file of [
  join(homedir(), ".jev-router.env"),
  join(homedir(), ".jev-claude.env"),
]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // A missing optional environment file must not stop the local proxy.
  }
}

const host = process.env.JEV_CODEX_PROXY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.JEV_CODEX_PROXY_PORT ?? "17421", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("JEV_CODEX_PROXY_PORT must be an integer from 1 to 65535");
}

const proxy = await startCodexProxy({ host, port, statusId: "codex-global" });
process.stdout.write(`[jev] Codex proxy listening on http://${host}:${proxy.port}\n`);
if (!jevBackend()) {
  process.stderr.write(
    `[jev] routing key not configured; add ${MISSING_KEY_HINT} to ~/.jev-router.env\n`,
  );
}

const shutdown = () => {
  proxy.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
