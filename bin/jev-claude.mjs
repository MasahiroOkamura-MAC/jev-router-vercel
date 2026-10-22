#!/usr/bin/env node
import { loadRoutingEnv } from "../src/env.mjs";
import { privateDirectory, writePrivateJson } from "../src/private-storage.mjs";
import { statuslineCommand } from "../src/statusline-command.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveCli } from "../src/cli-command.mjs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { jevBackend, MISSING_KEY_HINT } from "../src/backend.mjs";
import { AUTO_MODEL } from "../src/config.mjs";
import { readSavedModel, restoreSavedModel } from "../src/settings.mjs";
import { LOG_FILE } from "../src/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * Registers "Jev Router" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    // Some Claude Code versions validate the model client-side before it reaches the proxy;
    // this defers to the API so "jev-router" can pass through for rewriting.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  return env;
}

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLineArgs() {
  if (process.env.JEV_NO_STATUSLINE) return [];
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return [];
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  // Passed as a file rather than inline JSON: on Windows the args go through a shell, and a
  // JSON string containing its own quotes does not survive that.
  const command = statuslineCommand(process.execPath, join(HERE, "jev-statusline.mjs"));
  if (!command) return [];
  const name = `settings-${process.pid}.json`;
  let file;
  try {
    file = join(privateDirectory(), name);
    writePrivateJson(name, { statusLine: { type: "command", command } });
  } catch {
    return [];
  }
  return ["--settings", file];
}

loadRoutingEnv();

/**
 * Finds the Claude Code executable on PATH. Resolving it here rather than leaning on the
 * shell means arguments are passed as an array (no quoting hazard, no DEP0190 warning) and
 * a missing install produces a useful message instead of a shell error. Older npm-based
 * installs need a native executable or PowerShell shim; batch-only installs fail closed.
 */
const resolveClaude = () => resolveCli("claude");

const args = process.argv.slice(2);
args.push("--add-dir", ROOT);
const env = { ...process.env };

const claude = resolveClaude();
if (!claude) {
  process.stderr.write(
    "[jev] Claude Code is not installed, or `claude` is not on your PATH.\n" +
      "[jev] jev-claude requires a native CLI or Windows PowerShell shim; batch-only shims are unsupported.\n" +
      "[jev]   https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

if (jevBackend()) {
  const { port, close } = await startProxy();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  Object.assign(env, autoModelEnv());
  process.on("exit", () => {
    close();
    restoreSavedModel(savedModelBefore);
  });
  args.push(...statusLineArgs());
  if (process.env.JEV_DEBUG && process.stdout.isTTY) {
    process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  }
} else {
  process.stderr.write(
    `[jev] no Jev key found - starting Claude Code without routing\n` +
      `[jev] add ${MISSING_KEY_HINT} to ${join(homedir(), ".jev-router.env")} to enable routing\n`,
  );
}

// Never pass prompt arguments through a command shell, including Windows batch shims.
const child = spawn(claude.file, [...claude.prefix, ...args], {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[jev] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
