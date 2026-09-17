/**
 * Summarises a usage ledger written by JEV_USAGE=1.
 *
 *   node bench/usage_report.mjs [ledger.jsonl] [--baseline claude-sonnet-5]
 *
 * The counterfactual reprices the *same* token counts at the baseline model. That is an
 * approximation: a different model would have produced a different number of output tokens
 * and would not have forced the cache rebuilds a tier switch causes. It bounds the input-side
 * saving honestly and is reported as such, not as a measured total.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { costOf } from "../src/pricing.mjs";

const args = process.argv.slice(2);
const bi = args.indexOf("--baseline");
const baseline = bi === -1 ? "claude-sonnet-5" : args[bi + 1];
const file = args.find((a) => !a.startsWith("--") && a !== baseline) ?? join(homedir(), ".jev-claude-usage.jsonl");

const rows = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const usd = (n) => `$${n.toFixed(4)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

const by = new Map();
for (const r of rows) {
  const k = r.routed ? (r.tier ?? "?") : "passthrough";
  const a = by.get(k) ?? { n: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0, cost: 0 };
  a.n++;
  for (const f of ["input", "cacheRead", "cacheCreate", "output"]) a[f] += r[f] ?? 0;
  a.cost += r.cost ?? 0;
  by.set(k, a);
}

console.log(`ledger   ${file}`);
console.log(`requests ${rows.length}\n`);
console.log("tier         n   input    cache-r   cache-w   output       cost");
for (const [k, a] of [...by].sort((x, y) => y[1].cost - x[1].cost)) {
  console.log(
    `${k.padEnd(12)}${String(a.n).padStart(3)} ${String(a.input).padStart(7)} ${String(a.cacheRead).padStart(9)} ${String(a.cacheCreate).padStart(9)} ${String(a.output).padStart(8)} ${usd(a.cost).padStart(10)}`,
  );
}

const routed = rows.filter((r) => r.routed && r.cost != null);
const actual = routed.reduce((s, r) => s + r.cost, 0);
const counter = routed.reduce((s, r) => s + (costOf(baseline, r) ?? 0), 0);

console.log(`\nrouted requests      ${routed.length}`);
console.log(`actual               ${usd(actual)}`);
console.log(`same tokens at ${baseline}  ${usd(counter)}`);
if (counter > 0) console.log(`difference           ${usd(counter - actual)}  (${pct((counter - actual) / counter)})`);

// A tier switch invalidates the prompt cache, so the next request pays cache-write instead of
// cache-read. That penalty is the main thing that can make routing lose, so count it.
let switches = 0;
const last = new Map();
for (const r of routed) {
  if (last.has(r.conversation) && last.get(r.conversation) !== r.tier) switches++;
  last.set(r.conversation, r.tier);
}
console.log(`tier switches        ${switches} across ${last.size} conversations`);
