import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startOpenAIProxy } from "./openai-proxy.mjs";
import { AUTO_MODEL } from "./config.mjs";

export function loadEnv() {
  for (const file of [
    join(homedir(), ".jev-router.env"),
    join(homedir(), ".jev-claude.env"),
    join(process.cwd(), ".env"),
  ]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing or unreadable; values may still come from the real environment.
    }
  }
}

export function resolveCommand(name) {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `${name}${ext}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

export function openCodeConfig(baseURL, current = process.env.OPENCODE_CONFIG_CONTENT) {
  let config = {};
  if (current) config = JSON.parse(current);
  config.provider = {
    ...config.provider,
    openai: {
      ...config.provider?.openai,
      options: { ...config.provider?.openai?.options, baseURL },
      models: {
        ...config.provider?.openai?.models,
        [AUTO_MODEL]: {
          name: "Jev Auto",
          reasoning: true,
          tool_call: true,
        },
      },
    },
  };
  return JSON.stringify(config);
}

const CLIENTS = {
  opencode: ({ baseURL, env, args }) => {
    env.OPENCODE_CONFIG_CONTENT = openCodeConfig(baseURL, env.OPENCODE_CONFIG_CONTENT);
    return ["--model", `openai/${AUTO_MODEL}`, ...args];
  },
  copilot: ({ baseURL, env, args }) => {
    env.COPILOT_PROVIDER_TYPE = "openai";
    env.COPILOT_PROVIDER_BASE_URL = baseURL;
    env.COPILOT_PROVIDER_WIRE_API = "responses";
    env.COPILOT_PROVIDER_MODEL_ID = process.env.JEV_OPENAI_BALANCED_MODEL ?? "gpt-5.6-terra";
    env.COPILOT_PROVIDER_WIRE_MODEL = AUTO_MODEL;
    env.COPILOT_PROVIDER_API_KEY ??= env.OPENAI_API_KEY;
    return args;
  },
  codex: ({ baseURL, args }) => [
    "--model",
    AUTO_MODEL,
    "--config",
    `openai_base_url="${baseURL}"`,
    ...args,
  ],
};

export async function runOpenAIClient(name) {
  loadEnv();
  const command = resolveCommand(name);
  if (!command) {
    process.stderr.write(`[jev] ${name} is not installed, or it is not on your PATH.\n`);
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const env = { ...process.env };
  let close = () => {};

  if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
    const proxy = await startOpenAIProxy();
    close = proxy.close;
    const baseURL = `http://127.0.0.1:${proxy.port}/v1`;
    try {
      args.splice(0, args.length, ...CLIENTS[name]({ baseURL, env, args }));
    } catch (err) {
      close();
      process.stderr.write(`[jev] could not configure ${name}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    process.stderr.write(`[jev] no JEV_API_KEY found - starting ${name} without routing\n`);
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start ${name}: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
