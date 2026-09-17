import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  CopilotClient,
  CopilotRequestHandler,
  approveAll,
} from "@github/copilot-sdk";
import { availableTiers } from "./config.mjs";
import { loadEnv, resolveCommand } from "./openai-cli.mjs";
import { openAIModelOf } from "./openai-config.mjs";
import { decide } from "./policy.mjs";
import { askJev } from "./router.mjs";
import { log } from "./log.mjs";
import { openAINewTurnPrompt } from "./openai-proxy.mjs";

const debug = (line) => process.env.JEV_DEBUG && log(line);

const usage = `Usage: jev-copilot [options]

Runs GitHub Copilot with Jev Auto routing and your existing Copilot login.

Options:
  -p, --prompt <text>    Run one prompt non-interactively
  --resume=<id>          Resume a specific session
  --allow-all            Approve all tool and file permission requests
  -h, --help             Show this help

Use plain "copilot" when you want Copilot's native UI and manual model selection.
`;

function requestWithText(request, text) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: text,
  });
}

const requestWithBody = (request, body) =>
  requestWithText(request, JSON.stringify(body));

export async function routeCopilotBody({
  body,
  key,
  currentByAgent,
  tiers,
  route = askJev,
  onDecision,
}) {
  let current = currentByAgent.get(key) ?? "sonnet";
  const prompt = openAINewTurnPrompt(body);

  if (prompt) {
    const contextTokens = Math.round(JSON.stringify(body.input ?? body.messages ?? "").length / 4);
    const jev = await route({ prompt, current, contextTokens, available: tiers });
    const decision = decide({ prompt, jev, current, available: tiers, contextTokens });
    current = decision.tier;
    currentByAgent.set(key, current);
    onDecision?.({
      model: openAIModelOf(current),
      tier: current,
      confidence: jev?.confidence,
      reason: decision.reason,
    });
    debug(
      `copilot ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
        `${openAIModelOf(current)} (${decision.reason}) | ${prompt.slice(0, 60)}`,
    );
  }

  body.model = openAIModelOf(current);
  return body;
}

export class JevCopilotRequestHandler extends CopilotRequestHandler {
  constructor({ tiers, onDecision } = {}) {
    super();
    this.tiers = tiers ?? availableTiers();
    this.onDecision = onDecision;
    this.currentByAgent = new Map();
  }

  async sendRequest(request, context) {
    if (request.method !== "POST" || !request.body) {
      return super.sendRequest(request, context);
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return super.sendRequest(request, context);
    }

    const text = await request.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      debug(`copilot passthrough, could not parse request: ${err.message}`);
      return super.sendRequest(requestWithText(request, text), context);
    }
    if (process.env.JEV_DUMP) {
      writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
    }

    if (typeof body.model !== "string" || !Array.isArray(body.tools) || body.tools.length === 0) {
      return super.sendRequest(requestWithBody(request, body), context);
    }

    const key = `${context.sessionId ?? "session"}:${context.agentId ?? "root"}`;
    await routeCopilotBody({
      body,
      key,
      currentByAgent: this.currentByAgent,
      tiers: this.tiers,
      onDecision: this.onDecision,
    });
    return super.sendRequest(requestWithBody(request, body), context);
  }
}

export function copilotTiers(models) {
  const enabled = new Set(models.map((model) => model.id));
  return availableTiers().filter((tier) => enabled.has(openAIModelOf(tier)));
}

function parseArgs(args) {
  const options = { allowAll: false, help: false, prompt: null, resume: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--allow-all" || arg === "--allow-all-tools") options.allowAll = true;
    else if (arg === "-p" || arg === "--prompt") {
      if (!args[i + 1]) throw new Error(`${arg} requires a prompt`);
      options.prompt = args[++i];
    } else if (arg.startsWith("--prompt=")) options.prompt = arg.slice(9);
    else if (arg === "--resume") throw new Error("--resume requires a session ID");
    else if (arg.startsWith("--resume=")) {
      const id = arg.slice(9);
      if (!id) throw new Error("--resume requires a session ID");
      options.resume = id;
    }
    else throw new Error(`unsupported option: ${arg}`);
  }
  return options;
}

function spawnNativeCopilot(args) {
  const command = resolveCommand("copilot");
  if (!command) throw new Error("copilot is not installed, or it is not on your PATH");
  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env: process.env },
  );
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 0);
      resolve();
    });
  });
}

function describePermission(request) {
  return request.fullCommandText ??
    request.path ??
    request.url ??
    request.toolName ??
    request.kind ??
    "requested action";
}

async function sendPrompt(session, prompt, state) {
  state.sawDelta = false;
  const response = await session.sendAndWait({ prompt }, 180_000);
  if (!state.sawDelta && response?.data?.content) {
    process.stdout.write(`${response.data.content}\n`);
  } else if (state.sawDelta) {
    process.stdout.write("\n");
  }
}

export async function runCopilot(args = process.argv.slice(2)) {
  loadEnv();

  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
    process.stderr.write("[jev] no JEV_API_KEY found - starting Copilot without routing\n");
    await spawnNativeCopilot(args);
    return;
  }

  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    process.stderr.write(`[jev] ${err.message}\n${usage}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  const interactive = !options.prompt;
  const terminal = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const canPrompt = interactive && process.stdin.isTTY;
  const pipedPrompts = interactive && !process.stdin.isTTY
    ? await (async () => {
        const lines = [];
        for await (const line of terminal) lines.push(line);
        return lines;
      })()
    : null;
  const permissionHandler = options.allowAll
    ? approveAll
    : async (request) => {
        if (!canPrompt) return { kind: "user-not-available" };
        const answer = await terminal.question(`Allow ${describePermission(request)}? [y/N] `);
        return /^y(?:es)?$/i.test(answer.trim())
          ? { kind: "approve-once", approvedInteractively: true }
          : { kind: "reject", feedback: "Rejected by user" };
      };

  let latestDecision;
  const handler = new JevCopilotRequestHandler({
    onDecision: (decision) => {
      latestDecision = decision;
      const confidence = decision.confidence == null ? "" : ` p=${decision.confidence.toFixed(2)}`;
      process.stderr.write(`[jev] ${decision.model}${confidence} (${decision.reason})\n`);
    },
  });
  const client = new CopilotClient({
    requestHandler: handler,
    useLoggedInUser: true,
    workingDirectory: process.cwd(),
    clientInfo: {
      applicationName: "jev-router",
      integrationName: "jev-copilot",
    },
  });

  try {
    await client.start();
    const tiers = copilotTiers(await client.listModels());
    if (!tiers.length) throw new Error("none of the configured Jev models are available to this Copilot account");
    handler.tiers = tiers;
    const initialTier = tiers.includes("sonnet") ? "sonnet" : tiers[0];
    const sessionConfig = {
      model: openAIModelOf(initialTier),
      capi: { enableWebSocketResponses: false },
      onPermissionRequest: permissionHandler,
      onUserInputRequest: async (request) => {
        if (!canPrompt) return { answer: "", wasFreeform: true };
        const choices = request.choices?.length ? `\n${request.choices.join("\n")}` : "";
        const answer = await terminal.question(`${request.question}${choices}\n> `);
        return { answer, wasFreeform: !request.choices?.includes(answer) };
      },
      streaming: true,
    };

    let session;
    if (options.resume) {
      session = await client.resumeSession(options.resume, sessionConfig);
    } else {
      session = await client.createSession(sessionConfig);
    }

    const state = { sawDelta: false };
    session.on("assistant.message_delta", (event) => {
      state.sawDelta = true;
      process.stdout.write(event.data.deltaContent);
    });
    session.on("session.error", (event) => {
      process.stderr.write(`[copilot] ${event.data.message}\n`);
    });

    try {
      if (options.prompt) {
        await sendPrompt(session, options.prompt, state);
      } else {
        process.stdout.write("Jev Auto for GitHub Copilot CLI. Type /exit to quit.\n");
        const handlePrompt = async (line) => {
          const prompt = line.trim();
          if (!prompt) return true;
          if (prompt === "/exit" || prompt === "/quit") return false;
          if (prompt === "/model") {
            process.stdout.write(
              latestDecision
                ? `Jev Auto -> ${latestDecision.model} (${latestDecision.reason})\n`
                : `Jev Auto -> ${openAIModelOf(initialTier)} (initial)\n`,
            );
            return true;
          }
          await sendPrompt(session, prompt, state);
          return true;
        };
        if (process.stdin.isTTY) {
          let keepGoing = true;
          while (keepGoing) keepGoing = await handlePrompt(await terminal.question("> "));
        } else {
          for (const line of pipedPrompts) {
            if (!await handlePrompt(line)) break;
          }
        }
      }
    } finally {
      await session.disconnect();
    }
  } catch (err) {
    process.stderr.write(`[jev] Copilot failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    terminal?.close();
    await client.stop();
  }
}
