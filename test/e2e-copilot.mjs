import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env, JEV_DEBUG: "1" };
delete env.OPENAI_API_KEY;
for (const key of Object.keys(env)) {
  if (key.startsWith("COPILOT_PROVIDER_")) delete env[key];
}

const child = spawn(
  process.execPath,
  [
    join(ROOT, "bin", "jev-copilot.mjs"),
    "-p",
    "Reply with exactly JEV_COPILOT_E2E_OK and nothing else.",
  ],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const [code] = await once(child, "exit");

assert.equal(code, 0, stderr);
assert.match(stdout, /JEV_COPILOT_E2E_OK/);
assert.match(stderr, /\[jev\] gpt-[^ ]+ p=\d\.\d{2}/, "Jev must select a hosted model");
assert.doesNotMatch(stderr, /routing failed|COPILOT_PROVIDER|OPENAI_API_KEY/);
console.log(stderr.trim().split("\n")[0]);
