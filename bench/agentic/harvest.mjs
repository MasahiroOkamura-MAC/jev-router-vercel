/**
 * Builds an evaluation corpus of real tasks out of local Claude Code transcripts.
 *
 *   node bench/agentic/harvest.mjs [--out tasks.jsonl] [--min-chars 40]
 *
 * Only the user's own typed prompts are taken, and only those whose working directory still
 * exists, because a replay has to run against the same repository to mean anything.
 *
 * Transcripts do not record the system prompt or tool schemas, so replaying the raw request
 * is not possible. The replay instead re-runs the prompt through the real `claude` binary in
 * the original directory, which reconstructs both. The cost is that a prompt is replayed as a
 * *first* turn; prompts that only make sense after prior conversation are removed by the
 * screening pass in screen.mjs, not here.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const OUT = arg("--out", join(import.meta.dirname, "data", "tasks.jsonl"));
const MIN = Number(arg("--min-chars", 40));

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : [],
  );

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // A user record whose content contains tool_result blocks is the harness replying to the
  // model, not a person typing, so it is not a task.
  if (content.some((c) => c?.type === "tool_result")) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
};

const root = join(homedir(), ".claude", "projects");
const isTemp = (p) => /[\\/](?:temp|tmp)[\\/]/i.test(p);
const tasks = new Map();
let scanned = 0;
const rejected = { short: 0, command: 0, noCwd: 0, notUser: 0, duplicate: 0 };

for (const file of walk(root)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== "user" || r.isSidechain) continue;
    scanned++;
    const prompt = textOf(r.message?.content).trim();
    if (!prompt) {
      rejected.notUser++;
      continue;
    }
    // Slash commands, pasted images, and local-command envelopes are not model tasks.
    if (/^[/<]/.test(prompt) || prompt.startsWith("[Image")) {
      rejected.command++;
      continue;
    }
    if (prompt.length < MIN) {
      rejected.short++;
      continue;
    }
    const cwd = r.cwd;
    // os.tmpdir() returns an 8.3 short path on Windows (GARGPR~1), which never prefix-matches
    // the long path a transcript records, so the segment is matched instead.
    if (!cwd || isTemp(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      rejected.noCwd++;
      continue;
    }
    const id = createHash("sha256").update(cwd + "\u0000" + prompt).digest("hex").slice(0, 12);
    if (tasks.has(id)) {
      rejected.duplicate++;
      continue;
    }
    tasks.set(id, { id, cwd, prompt, session: r.sessionId ?? null, at: r.timestamp ?? null });
  }
}

// Screening is expensive, so an existing verdict is carried forward rather than re-run.
const prior = new Map(
  (existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean) : [])
    .map((l) => JSON.parse(l))
    .filter((t) => typeof t.keep === "boolean")
    .map((t) => [t.id, t]),
);
for (const t of tasks.values()) {
  const p = prior.get(t.id);
  if (p) Object.assign(t, { keep: p.keep, why: p.why });
}

writeFileSync(OUT, [...tasks.values()].map((t) => JSON.stringify(t)).join("\n") + "\n");
console.log(`scanned ${scanned} user records`);
console.log(`rejected ${JSON.stringify(rejected)}`);
console.log(`kept ${tasks.size} (${prior.size} screening verdicts carried over) -> ${OUT}`);
const byCwd = {};
for (const t of tasks.values()) byCwd[t.cwd] = (byCwd[t.cwd] ?? 0) + 1;
for (const [c, n] of Object.entries(byCwd).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(4)}  ${c}`);
}
