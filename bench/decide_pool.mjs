/**
 * Pool-calibrated variant of the Jev decision pass.
 *
 * The shipped question asks for "the cheapest Claude model tier that can complete this
 * coding request". RouterBench's candidates are 2023-era open models that are far weaker
 * than Claude Haiku 4.5, so "trivial for Haiku" does not imply "Mixtral-8x7B can do it".
 *
 * This variant asks the same engine the question the benchmark actually poses, describing
 * the real candidates. Comparing the two isolates whether a flat result comes from Jev
 * lacking difficulty signal, or from the tier->model mapping being semantically invalid.
 *
 * Reported as a clearly-labelled secondary result; the shipped question stays primary.
 */
import { createReadStream, existsSync, readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { THRESHOLDS } from "../src/config.mjs";

for (const file of [join(homedir(), ".jev-claude.env"), join(process.cwd(), ".env"), join(process.cwd(), "..", ".env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const QUESTION = {
  model_tier: choice(
    [
      "A question from a standard evaluation benchmark (MMLU, HellaSwag, GSM8K, ARC, Winogrande, or MBPP) is shown. Decide whether a small open-weight language model from 2023 would answer it correctly, or whether it needs a frontier model.",
      "Calibrate to 2023-era open models, which are much weaker than current frontier models. Mixtral-8x7B scores about 55% on these benchmarks overall and is especially weak at commonsense sentence completion and multi-step arithmetic. Judge the failure rate of a weak model, not whether the question looks short or easy to a strong one.",
    ],
    {
      weak: {
        what: "A small 2023 open model (Mixtral-8x7B class) would very likely get this right.",
        signals: [
          "Simple factual recall with an obvious answer among the choices",
          "Single-step arithmetic or a direct lookup",
          "Distractor options that are clearly wrong",
        ],
        not_for: "Anything needing multi-step reasoning, nuanced commonsense, or code synthesis.",
      },
      strong: {
        what: "Needs a frontier model (GPT-4 class) to be answered reliably.",
        signals: [
          "Commonsense sentence completion where distractors are all plausible",
          "Multi-step arithmetic or word problems",
          "Writing a working program from a specification",
          "Specialist domain knowledge such as law, medicine, or advanced science",
        ],
        not_for: "Questions a competent small model would already get right.",
      },
    },
  ),
};

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);
const inFile = args.in ?? "data/sample_p0.jsonl";
const outFile = args.out ?? "data/decisions_pool.jsonl";
const concurrency = Number(args.concurrency ?? 8);

const client = new TypeSafeClient({
  apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
  timeout: THRESHOLDS.jevTimeoutMs,
  retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
  logLevel: "warn",
});

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
let completed = 0, failed = 0;
const started = Date.now();

async function worker() {
  while (tasks.length) {
    const row = tasks.pop();
    if (!row) return;
    let answer = null;
    try {
      const result = await client.systemOne({
        state: { request: row.prompt, environment: { available_models: ["weak", "strong"] } },
        questions: QUESTION,
      });
      answer = result.answers.model_tier;
    } catch (err) {
      failed++;
    }
    appendFileSync(outFile, JSON.stringify({
      id: row.id,
      choice: answer?.choice ?? null,
      confidence: answer?.confidence ?? null,
      probabilities: answer?.probabilities ?? null,
    }) + "\n");
    if (++completed % 50 === 0) console.log(`  ${completed} done, ${failed} failed`);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`finished: ${completed} decided, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
