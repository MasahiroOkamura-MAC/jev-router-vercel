import http from "node:http";
import https from "node:https";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { availableTiers } from "./config.mjs";
import { openAIModelOf } from "./openai-config.mjs";
import { decide } from "./policy.mjs";
import { askJev } from "./router.mjs";
import { log } from "./log.mjs";
import { openAINewTurnPrompt } from "./openai-proxy.mjs";

const COPILOT_HOSTS = new Set([
  "api.enterprise.githubcopilot.com",
  "api.githubcopilot.com",
]);
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const debug = (line) => process.env.JEV_DEBUG && log(line);

export async function routeCopilotBody({
  body,
  current = "sonnet",
  tiers = availableTiers(),
  route = askJev,
  onDecision,
}) {
  const prompt = openAINewTurnPrompt(body);
  if (prompt) {
    const contextTokens = Math.round(JSON.stringify(body.input ?? body.messages ?? "").length / 4);
    const jev = await route({ prompt, current, contextTokens, available: tiers });
    const decision = decide({ prompt, jev, current, available: tiers, contextTokens });
    current = decision.tier;
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
  return current;
}

export function withoutCopilotNoProxy(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && !COPILOT_HOSTS.has(item.replace(/^\./, "").toLowerCase()))
    .join(",");
}

async function createCertificateBundle(existingCA) {
  const existingPEM = existingCA ? `${await readFile(existingCA, "utf8")}\n` : "";
  const notBeforeDate = new Date(Date.now() - 60_000);
  const notAfterDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const ca = await generate([{ name: "commonName", value: "Jev Router ephemeral CA" }], {
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const leaf = await generate(
    [{ name: "commonName", value: "api.enterprise.githubcopilot.com" }],
    {
      algorithm: "sha256",
      notBeforeDate,
      notAfterDate,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [...COPILOT_HOSTS].map((value) => ({ type: 2, value })),
        },
      ],
    },
  );

  const directory = await mkdtemp(join(tmpdir(), "jev-copilot-"));
  const caFile = join(directory, "ca.pem");
  await writeFile(caFile, `${existingPEM}${ca.cert}`, { mode: 0o600 });
  return {
    caFile,
    key: leaf.private,
    cert: leaf.cert,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function authorityOf(value) {
  const match = /^\[([^\]]+)\](?::(\d+))?$|^([^:]+)(?::(\d+))?$/.exec(value ?? "");
  if (!match) return null;
  return {
    hostname: (match[1] ?? match[3]).toLowerCase(),
    port: Number(match[2] ?? match[4] ?? 443),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error("Copilot request exceeded 64 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function passthroughConnect(authority, clientSocket, head) {
  const target = authorityOf(authority);
  if (!target) return clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  const upstream = net.connect(target.port, target.hostname);
  upstream.once("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.once("error", (err) => {
    debug(`copilot proxy CONNECT ${target.hostname} failed: ${err.message}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
}

export async function startCopilotProxy() {
  const certificate = await createCertificateBundle(process.env.NODE_EXTRA_CA_CERTS);
  let current = "sonnet";
  const sockets = new Set();

  const mitm = https.createServer(
    { key: certificate.key, cert: certificate.cert },
    async (req, res) => {
      try {
        const host = authorityOf(req.headers.host)?.hostname;
        if (!host || !COPILOT_HOSTS.has(host)) {
          res.writeHead(421).end("Unexpected Copilot host");
          return;
        }

        let body = await readBody(req);
        if (req.method === "POST" && body.length && /application\/json/i.test(req.headers["content-type"] ?? "")) {
          let parsed;
          try {
            parsed = JSON.parse(body.toString());
          } catch (err) {
            debug(`copilot request passthrough: ${err.message}`);
          }
          if (typeof parsed?.model === "string" && Array.isArray(parsed.tools) && parsed.tools.length) {
            current = await routeCopilotBody({ body: parsed, current });
            body = Buffer.from(JSON.stringify(parsed));
          }
        }

        const headers = { ...req.headers, host };
        delete headers["content-length"];
        delete headers["proxy-connection"];
        const upstream = https.request(
          { hostname: host, port: 443, path: req.url, method: req.method, headers },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.once("error", (err) => {
          debug(`copilot upstream error: ${err.message}`);
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
          res.end(`Copilot upstream error: ${err.message}`);
        });
        if (body.length) upstream.write(body);
        upstream.end();
      } catch (err) {
        debug(`copilot proxy error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Copilot proxy error: ${err.message}`);
      }
    },
  );
  mitm.on("tlsClientError", (err) => debug(`copilot TLS error: ${err.message}`));

  const proxy = http.createServer((_req, res) => {
    res.writeHead(400).end("HTTPS CONNECT required");
  });
  proxy.on("connect", (req, clientSocket, head) => {
    const target = authorityOf(req.url);
    if (target?.port === 443 && COPILOT_HOSTS.has(target.hostname)) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) clientSocket.unshift(head);
      mitm.emit("connection", clientSocket);
      return;
    }
    passthroughConnect(req.url, clientSocket, head);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
  } catch (err) {
    await certificate.cleanup();
    throw err;
  }

  return {
    port: proxy.address().port,
    caFile: certificate.caFile,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      await certificate.cleanup();
    },
  };
}
