/**
 * Blinded pairwise LLM-as-a-judge over replay pairs.
 *
 *   node bench/agentic/judge.mjs [--replays replays.jsonl] [--cheap haiku] [--strong opus]
 *                                [--judge opus] [--concurrency 3]
 *
 * Every pair is judged twice with the two responses swapped. A verdict counts only when both
 * orderings name the same response; otherwise the pair is recorded as unstable and treated as
 * a tie. This is the whole bias control: position bias, and to a large extent verbosity bias,
 * show up as disagreement between the two orderings rather than as a silent thumb on the
 * scale, and the disagreement rate is reported so the judge can be audited rather than
 * trusted.
 *
 * The judge is asked whether one response is *materially* better -- would a competent engineer
 * do something different -- rather than which is nicer, because a judge asked to pick a winner
 * will always find one.
 */
import { readFileSync, appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude, extractJson, NO_TOOLS } from "./claude.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const here = import.meta.dirname;
const REPLAYS = arg("--replays", join(here, "data", "replays.jsonl"));
const TASKS = arg("--tasks", join(here, "data", "tasks.jsonl"));
const OUT = arg("--out", join(here, "data", "verdicts.jsonl"));
const CHEAP = arg("--cheap", "haiku");
const STRONG = arg("--strong", "opus");
const JUDGE = arg("--judge", "opus");
const CONC = Number(arg("--concurrency", 3));
const MAX_CHARS = Number(arg("--max-chars", 12000));

const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// A neutral directory, so the judge does not pick up a CLAUDE.md belonging to whichever
// repository happens to be under evaluation.
const SCRATCH = mkdtempSync(join(tmpdir(), "jev-judge-"));

const clip = (s) =>
  s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS / 2)}\n\n[...truncated...]\n\n${s.slice(-MAX_CHARS / 2)}`;

const RUBRIC = `You are grading two answers produced by different AI coding assistants for the same task in the same repository.

Decide whether one answer is MATERIALLY better. Materially better means exactly one of:
  - it is correct where the other is factually wrong, or
  - it contains a specific, relevant fact, file, step or caveat the other omits, and missing it would lead a competent engineer to do the wrong thing next.

It is NOT materially better merely because it is longer, shorter, better formatted, more confident, more thorough, better organised, or more pleasant to read. Ignore style completely.

Most pairs are ties. Answer "tie" unless you can name the specific material difference.

Reply with ONLY a JSON object on a single line, no prose, no code fence:
{"verdict":"A"|"B"|"tie","reason":"<one sentence naming the specific difference, or why they are equivalent>"}`;

const buildPrompt = (task, first, second) =>
  `${RUBRIC}

=== TASK (asked in repository ${task.cwd}) ===
${clip(task.prompt)}

=== ANSWER A ===
${clip(first)}

=== ANSWER B ===
${clip(second)}

JSON verdict:`;

let limitHit = false;

async function askJudge(prompt) {
  // Pinned through the launcher for the same reason the replays are: it is the only way to be
  // certain which model produced the verdict.
  const r = await runClaude({ prompt, tier: JUDGE, cwd: SCRATCH, deny: NO_TOOLS });
  if (r.limited) {
    limitHit = true;
    return null;
  }
  if (!r.ok) return null;
  const v = extractJson(r.text);
  return v && ["A", "B", "tie"].includes(v.verdict) ? v : null;
}

const tasks = new Map(readJsonl(TASKS).map((t) => [t.id, t]));
const replays = readJsonl(REPLAYS);
const byTask = new Map();
for (const r of replays) {
  if (!r.ok || !r.result || !r.tierVerified) continue;
  const e = byTask.get(r.task) ?? {};
  e[r.tier] = r;
  byTask.set(r.task, e);
}

const done = new Set(readJsonl(OUT).map((v) => v.task));
const pairs = [...byTask.entries()].filter(
  ([id, e]) => e[CHEAP] && e[STRONG] && tasks.has(id) && !done.has(id),
);

console.log(`${byTask.size} tasks replayed; ${pairs.length} complete pairs to judge (${CHEAP} vs ${STRONG})`);

let n = 0;
const tally = { cheap: 0, strong: 0, tie: 0, unstable: 0, failed: 0 };

await Promise.all(
  Array.from({ length: Math.min(CONC, pairs.length) }, async () => {
    for (;;) {
      if (limitHit) return;
      const item = pairs.shift();
      if (!item) return;
      const [id, e] = item;
      const task = tasks.get(id);
      // Ordering 1 puts the cheap answer first; ordering 2 swaps them. Agreement is measured
      // on the *answer*, not the letter.
      const [v1, v2] = await Promise.all([
        askJudge(buildPrompt(task, e[CHEAP].result, e[STRONG].result)),
        askJudge(buildPrompt(task, e[STRONG].result, e[CHEAP].result)),
      ]);
      // A verdict lost to a usage limit is not a verdict; recording it would permanently
      // mark the pair as judged.
      if (limitHit && (v1 == null || v2 == null)) return;
      const pick = (v, cheapIsA) =>
        v == null ? null : v.verdict === "tie" ? "tie" : (v.verdict === "A") === cheapIsA ? "cheap" : "strong";
      const p1 = pick(v1, true);
      const p2 = pick(v2, false);
      let winner;
      if (p1 == null || p2 == null) winner = "failed";
      else if (p1 === p2) winner = p1;
      else winner = "unstable";
      tally[winner]++;
      appendFileSync(
        OUT,
        JSON.stringify({
          task: id,
          cheap: CHEAP,
          strong: STRONG,
          judge: JUDGE,
          winner,
          ordering1: p1,
          ordering2: p2,
          reason1: v1?.reason ?? null,
          reason2: v2?.reason ?? null,
          at: new Date().toISOString(),
        }) + "\n",
      );
      n++;
      console.log(`[${n}] ${id} ${String(winner).padEnd(8)} (${p1}/${p2})  ${v1?.reason?.slice(0, 90) ?? ""}`);
    }
  }),
);

const decisive = tally.cheap + tally.strong + tally.tie;
console.log(`\n${JSON.stringify(tally)}`);
if (limitHit) console.error(`stopped early: usage limit reached; re-run to continue`);
if (n > 0) {
  console.log(`position-stable: ${decisive}/${n} (${((decisive / n) * 100).toFixed(0)}%)`);
  console.log(`-> ${OUT}`);
}
if (limitHit) process.exitCode = 1;
