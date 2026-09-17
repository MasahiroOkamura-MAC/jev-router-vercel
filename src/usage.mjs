/**
 * Token accounting for routed requests.
 *
 * Every downstream measurement -- savings, cost per turn, the cache-rebuild penalty -- needs
 * the four token classes the API reports, so they are read back off the wire rather than
 * estimated. Opt-in via JEV_USAGE=1 because it means asking upstream for an uncompressed
 * stream and holding the response in memory.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { costOf } from "./pricing.mjs";

export const usageEnabled = () => process.env.JEV_USAGE === "1";

export const usageFile = () =>
  process.env.JEV_USAGE_FILE ?? join(homedir(), ".jev-claude-usage.jsonl");

/**
 * Pulls the model and token counts out of a response body, streaming or not.
 *
 * A streaming response reports input and cache tokens once in `message_start` and the final
 * output count in `message_delta`, so the fields are accumulated by maximum across every
 * usage object seen rather than taken from any single event.
 *
 * @param {string} text raw, uncompressed response body
 * @returns {?{model: ?string, input: number, cacheRead: number, cacheCreate: number, output: number}}
 */
export function parseUsage(text) {
  if (typeof text !== "string" || !text) return null;
  const payloads = [];
  if (/^\s*(?:event|data):/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s*(.+)$/.exec(line);
      if (!m || m[1] === "[DONE]") continue;
      try {
        payloads.push(JSON.parse(m[1]));
      } catch {
        /* partial or non-JSON event */
      }
    }
  } else {
    try {
      payloads.push(JSON.parse(text));
    } catch {
      return null;
    }
  }

  const out = { model: null, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
  let found = false;
  for (const p of payloads) {
    const msg = p?.message ?? p;
    if (!out.model && typeof msg?.model === "string") out.model = msg.model;
    const u = msg?.usage ?? p?.usage;
    if (!u || typeof u !== "object") continue;
    found = true;
    out.input = Math.max(out.input, u.input_tokens ?? 0);
    out.cacheRead = Math.max(out.cacheRead, u.cache_read_input_tokens ?? 0);
    out.cacheCreate = Math.max(out.cacheCreate, u.cache_creation_input_tokens ?? 0);
    out.output = Math.max(out.output, u.output_tokens ?? 0);
  }
  return found || out.model ? out : null;
}

/** Appends one request to the ledger. Never throws: accounting must not break the proxy. */
export function recordUsage(record) {
  try {
    appendFileSync(usageFile(), JSON.stringify(record) + "\n");
  } catch {
    /* ledger is best-effort */
  }
}

/** Builds the ledger row for a completed request. */
export function usageRecord({ text, status, requested, tier, reason, routed, session, key }) {
  const u = parseUsage(text);
  return {
    at: new Date().toISOString(),
    session,
    conversation: key,
    status,
    routed,
    requested,
    tier: tier ?? null,
    reason: reason ?? null,
    served: u?.model ?? null,
    input: u?.input ?? 0,
    cacheRead: u?.cacheRead ?? 0,
    cacheCreate: u?.cacheCreate ?? 0,
    output: u?.output ?? 0,
    cost: u?.model ? costOf(u.model, u) : null,
  };
}
