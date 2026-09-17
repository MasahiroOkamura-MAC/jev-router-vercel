/**
 * Expands the corpus with tasks generated against real repositories.
 *
 *   node bench/agentic/generate.mjs --repos C:\a,C:\b [--per-repo 24] [--model opus]
 *
 * Harvested tasks are the most faithful evidence available but there are only a few dozen of
 * them, and most come from one repository, which is not enough to separate a router from a
 * coin. Generated tasks fill the difficulty range deliberately: a router is only interesting
 * if the corpus contains both tasks a cheap model handles and tasks it does not.
 *
 * Every generated task is marked `source: "generated"` and scoring reports the two sources
 * separately. A model asked to invent hard tasks invents tasks that are hard *in the way that
 * model imagines*, which is not the same as the tasks a user actually sends, and pooling the
 * two would hide that.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runClaude, extractJson, READ_ONLY } from "./claude.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const here = import.meta.dirname;
const OUT = arg("--out", join(here, "data", "tasks.jsonl"));
const PER = Number(arg("--per-repo", 24));
const MODEL = arg("--model", "opus");

const existing = existsSync(OUT)
  ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const repos = arg("--repos", "")
  ? arg("--repos", "").split(",").map((s) => s.trim()).filter(Boolean)
  : [...new Set(existing.map((t) => t.cwd))];

if (!repos.length) {
  console.error("no repositories: pass --repos, or harvest first");
  process.exit(1);
}

const PROMPT = (n) => `Explore this repository, then invent ${n} distinct tasks a developer might genuinely ask an AI coding assistant to do here.

Spread them deliberately across difficulty:
  - about a third trivially answerable by reading one file
  - about a third needing several files to be read and related to each other
  - about a third needing real reasoning: a subtle bug, a design trade-off, a cross-cutting consequence, or an invariant that is not written down anywhere

Rules for every task:
  - it must be answerable from this repository alone, with no prior conversation
  - it must be phrased the way a developer would type it, not as an exam question
  - it must not ask for changes to be written; asking for analysis, a diagnosis or a plan is fine
  - do not number them or reference each other

Reply with ONLY a JSON object on one line:
{"tasks":[{"prompt":"...","difficulty":"easy"|"medium"|"hard"},...]}`;

const byId = new Map(existing.map((t) => [t.id, t]));
let added = 0;

for (const cwd of repos) {
  if (!existsSync(cwd)) {
    console.log(`skip (gone) ${cwd}`);
    continue;
  }
  process.stdout.write(`generating ${PER} for ${cwd} ... `);
  const r = await runClaude({ prompt: PROMPT(PER), tier: MODEL, cwd, deny: READ_ONLY, timeoutMs: 900_000 });
  if (r.limited) {
    console.log("usage limit reached, stopping");
    break;
  }
  const v = r.ok ? extractJson(r.text) : null;
  if (!Array.isArray(v?.tasks)) {
    console.log(`failed (${(r.stderr || r.text || "no reply").slice(0, 60)})`);
    continue;
  }
  let n = 0;
  for (const t of v.tasks) {
    const prompt = String(t?.prompt ?? "").trim();
    if (prompt.length < 20) continue;
    const id = createHash("sha256").update(cwd + "\u0000" + prompt).digest("hex").slice(0, 12);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      cwd,
      prompt,
      source: "generated",
      // Self-contained by construction, so screening has nothing to add.
      keep: true,
      why: "generated",
      difficultyHint: ["easy", "medium", "hard"].includes(t?.difficulty) ? t.difficulty : null,
    });
    n++;
    added++;
  }
  console.log(`${n} new`);
}

writeFileSync(OUT, [...byId.values()].map((t) => JSON.stringify(t)).join("\n") + "\n");
const gen = [...byId.values()].filter((t) => t.source === "generated").length;
console.log(`\nadded ${added}; corpus is now ${byId.size} (${gen} generated, ${byId.size - gen} harvested) -> ${OUT}`);
