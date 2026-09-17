/**
 * Jev decision pass over a RouterBench sample.
 *
 * Calls the real shipped router (src/router.mjs) so the benchmark measures the code we
 * ship, not a reimplementation. Stores Jev's raw answer — choice, confidence and the full
 * probability vector — so every downstream threshold sweep is pure offline computation and
 * the expensive pass only ever runs once.
 *
 * Resumable: existing ids in the output file are skipped.
 */
import { createReadStream, existsSync, readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { askJev } from "../src/router.mjs";
import { availableTiers } from "../src/config.mjs";

for (const file of [join(homedir(), ".jev-claude.env"), join(process.cwd(), ".env"), join(process.cwd(), "..", ".env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);
const inFile = args.in ?? "data/sample.jsonl";
const outFile = args.out ?? "data/decisions.jsonl";
const concurrency = Number(args.concurrency ?? 8);

if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
  console.error("no JEV_API_KEY found");
  process.exit(1);
}

const done = new Set();
if (existsSync(outFile)) {
  for (const line of readFileSync(outFile, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); } catch {}
  }
}

const tasks = [];
const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (!done.has(row.id)) tasks.push(row);
}

console.log(`${tasks.length} to do (${done.size} cached), concurrency ${concurrency}`);

const available = availableTiers();
let completed = 0;
let failed = 0;
const started = Date.now();

async function worker() {
  while (tasks.length) {
    const row = tasks.pop();
    if (!row) return;
    const answer = await askJev({
      prompt: row.prompt,
      current: "sonnet",
      contextTokens: 0,
      available,
    });
    if (!answer) failed++;
    appendFileSync(outFile, JSON.stringify({
      id: row.id,
      choice: answer?.choice ?? null,
      confidence: answer?.confidence ?? null,
      probabilities: answer?.probabilities ?? null,
      ms: answer?.ms ?? null,
    }) + "\n");
    if (++completed % 25 === 0) {
      const rate = completed / ((Date.now() - started) / 1000);
      console.log(`  ${completed} done, ${failed} failed, ${rate.toFixed(1)}/s`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`finished: ${completed} decided, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
