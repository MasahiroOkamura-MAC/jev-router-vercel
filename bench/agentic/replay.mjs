/**
 * Runs every task at every tier, through the shipped proxy, and records what came back.
 *
 *   node bench/agentic/replay.mjs [--tasks tasks.jsonl] [--tiers haiku,opus] [--limit 20]
 *                                 [--concurrency 3] [--timeout 420]
 *
 * The tier is pinned with JEV_FORCE_TIER rather than `claude --model`, because Claude Code
 * silently falls back to Sonnet when asked for a model the account cannot select -- verified:
 * `--model haiku` reports claude-sonnet-4-6 in its own modelUsage. Forcing it in the proxy
 * also means the replay exercises the real rewrite path, including the thinking and effort
 * stripping a Haiku downgrade requires.
 *
 * Replays run in plan mode with the mutating tools denied, so an agent let loose on a real
 * repository can read and reason but cannot change anything.
 *
 * Output is appended and keyed by (task, tier), so the run is resumable. A usage limit stops
 * the run rather than being recorded, because a limit refusal arrives as a well-formed
 * success envelope: recorded, it would permanently mark the task as replayed and the pair
 * would never be retried.
 */
import { readFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { idOf } from "../../src/config.mjs";
import { runClaude, READ_ONLY } from "./claude.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const here = import.meta.dirname;
const TASKS = arg("--tasks", join(here, "data", "tasks.jsonl"));
const OUT = arg("--out", join(here, "data", "replays.jsonl"));
const TIERS = arg("--tiers", "haiku,opus").split(",");
const LIMIT = Number(arg("--limit", Infinity));
const CONC = Number(arg("--concurrency", 3));
const TIMEOUT = Number(arg("--timeout", 420)) * 1000;

const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// Only screened-and-kept tasks are replayed. An unscreened task is not known to be a task.
const tasks = readJsonl(TASKS).filter((t) => t.keep === true).slice(0, LIMIT);
const done = new Set(readJsonl(OUT).map((r) => `${r.task}:${r.tier}`));

let limitHit = false;

async function runOne(task, tier) {
  const started = Date.now();
  // Claude Code attributes usage to the model name it *asked* for ("jev-auto"), so its own
  // output cannot confirm which model ran. The proxy ledger records the name the API echoed
  // back, which can.
  const ledger = join(tmpdir(), `jev-replay-${task.id}-${tier}-${process.pid}.jsonl`);
  const r = await runClaude({
    prompt: task.prompt,
    tier,
    cwd: task.cwd,
    deny: READ_ONLY,
    timeoutMs: TIMEOUT,
    env: { JEV_USAGE: "1", JEV_USAGE_FILE: ledger },
  });
  const rows = readJsonl(ledger);
  try {
    if (existsSync(ledger)) unlinkSync(ledger);
  } catch {
    /* temp file */
  }
  if (r.limited) {
    limitHit = true;
    return null;
  }
  const served = [...new Set(rows.filter((x) => x.routed).map((x) => x.served).filter(Boolean))];
  // The context the router actually saw: the first routed request, before any tool results
  // grew it. Claude Code's own `usage` is a session-wide aggregate and is several times
  // larger, which would make the downgrade guard look like it never lets a downgrade through.
  const first = rows.find((x) => x.routed);
  const contextTokens = first ? (first.input ?? 0) + (first.cacheRead ?? 0) + (first.cacheCreate ?? 0) : null;
  const raw = r.raw;
  return {
    task: task.id,
    tier,
    cwd: task.cwd,
    ok: r.ok,
    error: r.ok ? null : (r.text ?? r.stderr ?? "no json output").slice(0, 300),
    result: raw?.result ?? null,
    turns: raw?.num_turns ?? null,
    cost: raw?.total_cost_usd ?? null,
    models: Object.keys(raw?.modelUsage ?? {}),
    served,
    // A replay whose tokens were served by something other than the pinned tier is not
    // evidence about that tier, so it is flagged rather than silently averaged in.
    tierVerified: served.length === 1 && served[0] === idOf(tier),
    contextTokens,
    usage: raw?.usage
      ? {
          input: raw.usage.input_tokens ?? 0,
          cacheRead: raw.usage.cache_read_input_tokens ?? 0,
          cacheCreate: raw.usage.cache_creation_input_tokens ?? 0,
          output: raw.usage.output_tokens ?? 0,
        }
      : null,
    wallMs: Date.now() - started,
    at: new Date().toISOString(),
  };
}

const queue = [];
for (const t of tasks) for (const tier of TIERS) if (!done.has(`${t.id}:${tier}`)) queue.push([t, tier]);
// A run will usually be cut short by a usage limit, so the order must not correlate with
// repository or corpus source; otherwise a partial run silently becomes a study of whichever
// repository happened to be listed first. Task ids are content hashes, so sorting by id is a
// stable shuffle.
queue.sort((a, b) => (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : a[1] < b[1] ? -1 : 1));

console.log(`${tasks.length} tasks x ${TIERS.length} tiers = ${tasks.length * TIERS.length}; ${queue.length} to run`);
let n = 0;
let fails = 0;
await Promise.all(
  Array.from({ length: Math.min(CONC, queue.length) }, async () => {
    for (;;) {
      if (limitHit) return;
      const item = queue.shift();
      if (!item) return;
      const rec = await runOne(item[0], item[1]);
      if (rec == null) return;
      appendFileSync(OUT, JSON.stringify(rec) + "\n");
      if (!rec.ok) fails++;
      n++;
      console.log(
        `[${n}/${queue.length + n}] ${rec.task} ${rec.tier.padEnd(6)} ${rec.ok ? "ok " : "FAIL"} ` +
          `${String(Math.round(rec.wallMs / 1000)).padStart(3)}s turns=${rec.turns ?? "-"} ` +
          `served=${rec.served.join("|") || "-"}${rec.tierVerified ? "" : " !TIER"}${rec.ok ? "" : ` :: ${rec.error}`}`,
      );
    }
  }),
);
if (limitHit) console.error(`\nstopped: usage limit reached; re-run to continue (${queue.length} left)`);
console.log(`done: ${n} replays this run, ${fails} failed -> ${OUT}`);
if (limitHit) process.exitCode = 1;
