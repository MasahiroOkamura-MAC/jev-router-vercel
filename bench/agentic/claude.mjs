/**
 * One way to run a Claude Code session for the harness.
 *
 * Every caller needs the same three things: pin the model so the result is attributable, get
 * structured JSON back, and be able to tell a real answer apart from a usage-limit refusal.
 * That last one matters more than it looks -- a limit refusal arrives as a perfectly
 * well-formed success envelope with `is_error: true` and prose in `result`, so a harness that
 * only checks for a parse failure will happily record "the model said nothing useful" as data.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dirname, "..", "..", "bin", "jev-claude.mjs");

export const READ_ONLY = ["Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch"];
export const NO_TOOLS = [...READ_ONLY, "Read", "Glob", "Grep", "Task"];

const LIMIT = /hit your limit|usage limit|rate limit|resets? \d|overloaded|quota/i;

/**
 * @returns {Promise<{ok: boolean, limited: boolean, text: ?string, raw: ?object, stderr: string}>}
 */
export function runClaude({ prompt, tier, cwd, deny = NO_TOOLS, timeoutMs = 240_000, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [LAUNCHER, "-p", "--permission-mode", "plan", "--disallowedTools", ...deny, "--output-format", "json"],
      {
        cwd,
        env: { ...process.env, JEV_FORCE_TIER: tier, JEV_NO_STATUSLINE: "1", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      let raw = null;
      try {
        raw = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        /* no envelope at all */
      }
      const text = raw?.result ?? null;
      const limited = Boolean(raw?.is_error && typeof text === "string" && LIMIT.test(text));
      resolve({
        ok: Boolean(raw && raw.subtype === "success" && !raw.is_error),
        limited,
        text,
        raw,
        stderr: err.trim().slice(-300),
      });
    });
    child.stdin.end(prompt);
  });
}

/** Pulls the first JSON object out of a model reply that was asked for bare JSON. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
