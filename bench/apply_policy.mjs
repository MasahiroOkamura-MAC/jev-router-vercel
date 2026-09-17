/**
 * Applies the shipped policy (src/policy.mjs) to a cached Jev decision pass.
 *
 * Offline and free: no network, no Jev calls. This is what makes threshold sweeps cheap —
 * the expensive decision pass runs once, and every policy variant replays it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { decide } from "../src/policy.mjs";
import { availableTiers } from "../src/config.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);
const sampleFile = args.sample ?? "data/sample_p0.jsonl";
const decisionFile = args.decisions ?? "data/decisions_p0.jsonl";
const outFile = args.out ?? "data/policy_p0.jsonl";

const readJsonl = (f) =>
  readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

if (!existsSync(sampleFile) || !existsSync(decisionFile)) {
  console.error("missing input files");
  process.exit(1);
}

const prompts = new Map(readJsonl(sampleFile).map((r) => [r.id, r.prompt]));
const available = availableTiers();

let overrides = 0;
const out = readJsonl(decisionFile).map((d) => {
  const prompt = prompts.get(d.id) ?? "";
  const result = decide({
    prompt,
    jev: d.choice ? { choice: d.choice, confidence: d.confidence } : null,
    current: "sonnet",
    available,
    contextTokens: 0,
  });
  if (result.reason.startsWith("override")) overrides++;
  return { id: d.id, tier: result.tier, reason: result.reason, raw: d.choice, confidence: d.confidence };
});

writeFileSync(outFile, out.map((o) => JSON.stringify(o)).join("\n") + "\n");

const byTier = {};
const byReason = {};
for (const o of out) {
  byTier[o.tier] = (byTier[o.tier] ?? 0) + 1;
  byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
}
console.log(`wrote ${out.length} to ${outFile}`);
console.log("final tier:", byTier);
console.log("reason:", byReason);
if (overrides) console.log(`WARNING: ${overrides} prompts tripped explicit-override detection`);
