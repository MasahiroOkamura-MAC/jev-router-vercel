import { missingKeyHint, toGatewayQuestions } from "./backend.mjs";

export const CLOUDFLARE_MODEL = "typesafe/jev";

/** Workers AI takes the evaluation state/questions directly, without an AI SDK envelope. */
export function cloudflareRequest(request, env = process.env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID?.trim() || !env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error(`Cloudflare configuration missing: ${missingKeyHint({ ...env, JEV_BACKEND: "cloudflare" })}`);
  }
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID.trim())}/ai/run/${CLOUDFLARE_MODEL}`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: request.state, questions: toGatewayQuestions(request.questions) }),
    },
  };
}

const probability = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** Unwrap the Workers AI envelope, retaining typed answers and their measured uncertainty. */
export function fromCloudflareResponse(body, questions) {
  if (body?.success !== true || !body.result?.answers) {
    throw new Error("Cloudflare Workers AI returned an unsuccessful or malformed evaluation");
  }
  const answers = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = body.result.answers[name];
    const invalid = () => { throw new Error(`Cloudflare Workers AI returned an invalid ${question.type} answer for ${name}`); };
    if (!answer || answer.type !== question.type) invalid();
    if (question.type === "noul") {
      if (!probability(answer.noul)) invalid();
      answers[name] = answer;
      continue;
    }
    const probabilities = answer.probabilities;
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)
        || !Object.keys(probabilities).length || !Object.values(probabilities).every(probability)) invalid();
    let confidence = answer.confidence;
    if (question.type === "choice") {
      if (!Object.hasOwn(question.criteria, answer.choice) || !Object.hasOwn(probabilities, answer.choice)
          || Object.keys(probabilities).some((key) => !Object.hasOwn(question.criteria, key))) invalid();
      confidence ??= probabilities[answer.choice];
    } else if (question.type === "score") {
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1
          || Object.keys(probabilities).some((key) => !/^\d+$/.test(key) || Number(key) >= question.criteria.length)) invalid();
      confidence ??= Math.max(...Object.values(probabilities));
    } else invalid();
    if (!probability(confidence)) invalid();
    answers[name] = { ...answer, probabilities, confidence };
  }
  return { answers, usage: body.result.usage };
}

export async function evaluateViaCloudflare(request, signal, { env = process.env, fetch: fetcher = globalThis.fetch } = {}) {
  const { url, init } = cloudflareRequest(request, env);
  const response = await fetcher(url, { ...init, signal });
  // Never log the upstream body: it can echo prompts or credentials.
  if (!response.ok) throw new Error(`Cloudflare Workers AI HTTP ${response.status}${response.status === 402 ? " (billing/credits unavailable)" : ""}`);
  let body;
  try { body = await response.json(); }
  catch { throw new Error("Cloudflare Workers AI returned invalid JSON"); }
  return fromCloudflareResponse(body, request.questions);
}
