import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { availableTiers, AUTO_MODEL } from "./config.mjs";
import { openAIModelOf, openAITierOf } from "./openai-config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";

const debug = (line) => process.env.JEV_DEBUG && log(line);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

/** User text that starts a new agent turn, or null for tool continuations and utility calls. */
export function openAINewTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null;

  if (Array.isArray(body.messages)) {
    const last = body.messages.at(-1);
    if (!last || last.role === "tool" || last.role !== "user") return null;
    return textOf(last.content).trim() || null;
  }

  if (typeof body.input === "string") return body.input.trim() || null;
  if (!Array.isArray(body.input)) return null;
  if (body.input.some((item) => item?.type === "function_call_output")) return null;
  const last = [...body.input].reverse().find((item) => item?.role === "user");
  return textOf(last?.content).trim() || null;
}

export function applyOpenAITier(body, tier) {
  const model = openAIModelOf(tier);
  if (model) body.model = model;
  return body;
}

export async function startOpenAIProxy() {
  const upstreamURL = new URL(process.env.JEV_OPENAI_BASE_URL ?? "https://api.openai.com");
  const transport = upstreamURL.protocol === "http:" ? http : https;
  const upstreamPath = (path) =>
    `${upstreamURL.pathname.replace(/\/$/, "")}${path}` || "/";

  // ponytail: one wrapper process tracks one active tier; key by conversation if a stable
  // cross-request id becomes available on every supported CLI wire format.
  let current = "sonnet";

  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      if (/^\/v1\/(responses|chat\/completions)/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          if (body.model === AUTO_MODEL) {
            const prompt = openAINewTurnPrompt(body);
            if (prompt) {
              const available = availableTiers();
              const contextTokens = Math.round(JSON.stringify(body.input ?? body.messages ?? "").length / 4);
              const jev = await askJev({ prompt, current, contextTokens, available });
              const decision = decide({ prompt, jev, current, available, contextTokens });
              current = decision.tier;
              debug(
                `openai ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `${openAIModelOf(current)} (${decision.reason}) | ${prompt.slice(0, 60)}`,
              );
            }
            applyOpenAITier(body, current);
          } else {
            current = openAITierOf(body.model) ?? current;
            debug(`openai passthrough, user selected ${body.model}`);
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`openai passthrough, could not process body: ${err.message}`);
        }
      }

      const headers = { ...req.headers, host: upstreamURL.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: upstreamURL.hostname,
          port: upstreamURL.port || undefined,
          path: upstreamPath(req.url ?? "/"),
          method: req.method,
          headers,
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        debug(`openai upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
