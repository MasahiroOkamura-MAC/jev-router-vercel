import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let request;
let requestURL;
let authorization;

const server = http.createServer((req, res) => {
  requestURL = req.url;
  authorization = req.headers.authorization;
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    request = JSON.parse(Buffer.concat(chunks).toString());
    const id = "resp_jev_e2e";
    const item = {
      id: "msg_jev_e2e",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "E2E_OK", annotations: [] }],
    };
    const response = {
      id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: request.model,
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const events = [
      ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
      ["response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "E2E_OK" }],
      ["response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "E2E_OK" }],
      ["response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response }],
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseURL = `http://127.0.0.1:${server.address().port}`;
const child = spawn(
  process.execPath,
  [
    join(ROOT, "bin", "jev-copilot.mjs"),
    "-p",
    "Reply with exactly E2E_OK and do not use tools.",
    "--silent",
    "--allow-all-tools",
    "--disable-builtin-mcps",
    "--no-custom-instructions",
    "--no-auto-update",
  ],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      JEV_OPENAI_BASE_URL: baseURL,
      COPILOT_PROVIDER_API_KEY: "e2e-placeholder",
      JEV_DEBUG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const [code] = await once(child, "exit");
server.close();

assert.equal(code, 0, stderr);
assert.match(stdout, /E2E_OK/);
assert.equal(requestURL, "/v1/responses");
assert.equal(authorization, "Bearer e2e-placeholder");
assert.equal(request.model === "jev-auto", false);
assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
assert.match(stderr, /\bp=\d\.\d{2}\b/, "Jev must answer, not fail open");
console.log(`jev-copilot E2E passed: ${request.model}`);
