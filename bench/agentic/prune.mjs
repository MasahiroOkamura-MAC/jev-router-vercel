/**
 * Removes rows that record a refusal rather than a result.
 *
 *   node bench/agentic/prune.mjs [--file replays.jsonl] [--dry]
 *
 * A usage-limit refusal arrives as a well-formed success envelope with prose in `result`, so a
 * harness can append hundreds of them without noticing. Because every stage skips work already
 * present in its output file, those rows are worse than useless: they permanently mark the
 * task as done and it is never retried. This deletes them so the next run picks the work back
 * up.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const DRY = process.argv.includes("--dry");
const FILE = arg("--file", join(import.meta.dirname, "data", "replays.jsonl"));

if (!existsSync(FILE)) {
  console.log(`${FILE} does not exist`);
  process.exit(0);
}

const LIMIT = /hit your limit|usage limit|rate limit|resets? \d|overloaded|quota/i;
const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const poisoned = (r) => {
  if (r.ok) return false;
  const text = `${r.error ?? ""} ${r.result ?? ""}`;
  return LIMIT.test(text) || r.error === "success";
};

const keep = rows.filter((r) => !poisoned(r));
const dropped = rows.length - keep.length;
console.log(`${rows.length} rows, ${dropped} recorded a refusal`);
if (dropped && !DRY) {
  writeFileSync(FILE, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
  console.log(`rewrote ${FILE} with ${keep.length} rows`);
} else if (DRY) {
  console.log("(dry run, nothing written)");
}
