/**
 * Marks which harvested prompts can stand alone as a task.
 *
 *   node bench/agentic/screen.mjs [--tasks tasks.jsonl] [--model sonnet]
 *
 * Harvested prompts come from the middle of real conversations, so many of them ("alright, do
 * the rewrite", "try it out") are meaningless without the preceding turns. Left in, they
 * poison the labels in one direction: both tiers fail equally, the judge scores a tie, and the
 * corpus quietly gains evidence that escalation is never worth it.
 *
 * Rewrites tasks.jsonl in place, adding `keep` and `why`. A task that could not be screened is
 * left unmarked rather than guessed at, so re-running picks it up; and a usage limit stops the
 * run outright instead of filling the corpus with defaults.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude, extractJson, NO_TOOLS } from "./claude.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const here = import.meta.dirname;
const TASKS = arg("--tasks", join(here, "data", "tasks.jsonl"));
const MODEL = arg("--model", "sonnet");
const CONC = Number(arg("--concurrency", 4));
const SCRATCH = mkdtempSync(join(tmpdir(), "jev-screen-"));

const PROMPT = `You are filtering prompts for a benchmark. Each was typed by a developer into an AI coding assistant, mid-conversation.

Keep a prompt only if BOTH hold:
  1. An assistant opening a fresh session in that repository, with no memory of any earlier conversation, could attempt it sensibly. It may require reading the codebase; that is expected.
  2. It is a real piece of work, not a test probe. Reject canned echo tests ("reply with exactly X"), counting exercises, filler text, and connectivity checks.

Reject anything that refers to something not present in the prompt itself: "do it", "try that", "fix the error above", "continue", approvals, or replies to a question you cannot see.

Reply with ONLY a JSON object on one line:
{"keep":true|false,"why":"<a few words>"}`;

const tasks = readFileSync(TASKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const queue = tasks.filter((t) => t.keep === undefined);
console.log(`${tasks.length} tasks, ${queue.length} unscreened`);

let n = 0;
let stopped = false;

await Promise.all(
  Array.from({ length: Math.min(CONC, queue.length) }, async () => {
    for (;;) {
      if (stopped) return;
      const t = queue.shift();
      if (!t) return;
      const r = await runClaude({
        prompt: `${PROMPT}\n\n=== REPOSITORY ===\n${t.cwd}\n\n=== PROMPT ===\n${t.prompt}`,
        tier: MODEL,
        cwd: SCRATCH,
        deny: NO_TOOLS,
      });
      if (r.limited) {
        stopped = true;
        console.error(`\nstopped: usage limit reached -- ${r.text}`);
        return;
      }
      const v = r.ok ? extractJson(r.text) : null;
      if (!v || typeof v.keep !== "boolean") {
        // Leaving it unmarked keeps it in the queue for the next run. Defaulting it either way
        // would silently fabricate a screening decision.
        console.log(`[${++n}] unscreened  ${(r.stderr || r.text || "no reply").slice(0, 60)}`);
        continue;
      }
      t.keep = v.keep;
      t.why = String(v.why ?? "").slice(0, 80);
      console.log(`[${++n}] ${t.keep ? "keep  " : "reject"} ${t.why.padEnd(38)} ${t.prompt.replace(/\s+/g, " ").slice(0, 58)}`);
    }
  }),
);

writeFileSync(TASKS, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
const kept = tasks.filter((t) => t.keep === true).length;
const unscreened = tasks.filter((t) => t.keep === undefined).length;
console.log(`\nkept ${kept}/${tasks.length}, ${unscreened} still unscreened -> ${TASKS}`);
if (stopped) process.exitCode = 1;
