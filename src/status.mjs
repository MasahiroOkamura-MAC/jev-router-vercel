import { chmodSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One file per session rather than a shared map, so concurrent jev-claude sessions can never
// clobber each other's status. Kept in the temp dir so the OS eventually cleans up.
export const STATUS_DIR = join(tmpdir(), "jev-claude");

export const statusFileFor = (sessionId) =>
  join(STATUS_DIR, `${sessionId.replace(/[^\w-]/g, "")}.json`);

/** Publish the latest routing decision so the status line can display it. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
    // The files contain exact prompts and routing responses. Correct permissions even when
    // an older router version created this directory or status file with the process umask.
    chmodSync(STATUS_DIR, 0o700);
    const file = statusFileFor(sessionId);
    writeFileSync(file, JSON.stringify(status), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Status display is cosmetic and must never interfere with a request.
  }
}

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
}

/** Latest routing decision for a session, or null if none has been made yet. */
export function readStatus(sessionId) {
  try {
    return JSON.parse(readFileSync(statusFileFor(sessionId), "utf8"));
  } catch {
    return null;
  }
}
