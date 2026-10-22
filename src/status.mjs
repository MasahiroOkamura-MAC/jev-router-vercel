import { writePrivateJson, readPrivateJson } from "./private-storage.mjs";

const validSession = id => typeof id === "string" && /^[\w-]{1,128}$/.test(id);
const fileFor = id => `session-${id}.json`;

export function writeStatus(sessionId, status) {
  if (!validSession(sessionId)) return;
  try { writePrivateJson(fileFor(sessionId), status); } catch {
    // Status display must not interfere with a request; fail closed on unsafe storage.
  }
}

export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
}

export function readStatus(sessionId) {
  if (!validSession(sessionId)) return null;
  try { return readPrivateJson(fileFor(sessionId)); } catch { return null; }
}
