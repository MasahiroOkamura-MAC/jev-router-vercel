import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareRequest, evaluateViaCloudflare, fromCloudflareResponse } from "../src/cloudflare.mjs";
import { jevBackend, missingKeyHint } from "../src/backend.mjs";
import { QUESTIONS, questionForModels } from "../src/config.mjs";
import { askJev } from "../src/router.mjs";

const env = { JEV_BACKEND: "cloudflare", CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token" };
const models = [{ id: "small", tier: "haiku" }, { id: "large", tier: "opus" }];
const request = { state: { request: "Rename a variable" }, questions: { ...QUESTIONS, model: questionForModels(models) } };
const fixture = () => ({ success: true, result: { answers: {
  model: { type: "choice", choice: "small", probabilities: { small: 0.8, large: 0.2 } },
  ...Object.fromEntries(Object.keys(QUESTIONS).map((key) => [key, { type: "score", score: 1.2, probabilities: { 1: 0.8, 2: 0.2 }, confidence: 0.75 }])),
}, usage: { input_tokens: 20, output_tokens: 5 } } });

test("Cloudflare selection requires both credentials and preserves existing precedence", () => {
  assert.equal(jevBackend(env), "cloudflare");
  assert.equal(jevBackend({ ...env, CLOUDFLARE_API_TOKEN: "" }), null);
  assert.equal(jevBackend({ ...env, CLOUDFLARE_ACCOUNT_ID: " " }), null);
  assert.equal(jevBackend({ ...env, JEV_BACKEND: "Cloudflare", AI_GATEWAY_API_KEY: "g" }), "cloudflare");
  assert.equal(jevBackend({ ...env, JEV_BACKEND: undefined, AI_GATEWAY_API_KEY: "g" }), "gateway");
  assert.equal(jevBackend({ ...env, JEV_BACKEND: undefined, JEV_API_KEY: "t" }), "typesafe");
  assert.equal(jevBackend({ ...env, JEV_BACKEND: undefined }), "cloudflare");
});

test("configuration errors identify exactly the missing variables without leaking credentials", () => {
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    const incomplete = { ...env, [key]: "" };
    assert.match(missingKeyHint(incomplete), new RegExp(key));
    assert.throws(() => cloudflareRequest(request, incomplete), new RegExp(key));
    assert(!missingKeyHint(incomplete).includes("test-token"));
  }
  assert.throws(() => cloudflareRequest(request, {}), /CLOUDFLARE_ACCOUNT_ID.*CLOUDFLARE_API_TOKEN/);
});

test("Cloudflare requests use Bearer authentication and the direct state/questions payload", () => {
  const { url, init } = cloudflareRequest(request, env);
  assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/typesafe/jev");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { Authorization: "Bearer test-token", "Content-Type": "application/json" });
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["state", "questions"]);
  assert.deepEqual(body.state, request.state);
  assert.deepEqual(body.questions.task_complexity, QUESTIONS.task_complexity);
  assert.equal(typeof body.questions.model.instructions, "string");
  assert.equal(typeof body.questions.model.criteria.small, "string");
  assert.equal(cloudflareRequest(request, { ...env, CLOUDFLARE_ACCOUNT_ID: "a/b" }).url.includes("a%2Fb"), true);
});

test("typed answers preserve probabilities, scores, usage and explicit confidence", () => {
  const body = fixture();
  const result = fromCloudflareResponse(body, request.questions);
  assert.equal(result.answers.model.confidence, 0.8);
  assert.deepEqual(result.answers.model.probabilities, { small: 0.8, large: 0.2 });
  assert.equal(result.answers.task_complexity.score, 1.2);
  assert.equal(result.answers.task_complexity.confidence, 0.75);
  assert.deepEqual(result.usage, body.result.usage);
  assert.equal(body.result.answers.model.confidence, undefined, "does not mutate the response");
  body.result.answers.model.confidence = 0.6;
  assert.equal(fromCloudflareResponse(body, request.questions).answers.model.confidence, 0.6);
  delete body.result.answers.task_complexity.confidence;
  assert.equal(fromCloudflareResponse(body, request.questions).answers.task_complexity.confidence, 0.8);
});

test("malformed and untyped answers cannot become confident routing decisions", () => {
  for (const mutate of [
    (b) => { b.success = false; },
    (b) => { delete b.result.answers; },
    (b) => { delete b.result.answers.model.type; },
    (b) => { delete b.result.answers.model.probabilities; },
    (b) => { b.result.answers.model.choice = "unknown"; },
    (b) => { b.result.answers.model.probabilities.small = 1.5; },
    (b) => { b.result.answers.model.confidence = -1; },
    (b) => { b.result.answers.model.probabilities = {}; },
    (b) => { delete b.result.answers.task_complexity; },
    (b) => { b.result.answers.task_complexity.score = "1"; },
    (b) => { b.result.answers.task_complexity.score = 10; },
    (b) => { b.result.answers.task_complexity.probabilities = { invalid: 1 }; },
  ]) {
    const body = fixture(); mutate(body);
    assert.throws(() => fromCloudflareResponse(body, request.questions), /Cloudflare Workers AI/);
  }
});

test("HTTP failures, API errors and invalid JSON are safe errors; cancellation reaches fetch", async () => {
  const signal = new AbortController().signal;
  for (const status of [401, 402, 429, 500]) {
    await assert.rejects(evaluateViaCloudflare(request, signal, { env, fetch: async () => new Response("sensitive upstream body", { status }) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(evaluateViaCloudflare(request, signal, { env, fetch: async () => Response.json({ success: false, errors: [{ message: "sensitive" }] }) }), /unsuccessful/);
  await assert.rejects(evaluateViaCloudflare(request, signal, { env, fetch: async () => new Response("not json") }), /invalid JSON/);
  const result = await evaluateViaCloudflare(request, signal, { env, fetch: async (url, init) => {
    assert.equal(init.signal, signal);
    assert.match(url, /typesafe\/jev$/);
    return Response.json(fixture());
  } });
  assert.equal(result.answers.model.choice, "small");
});

test("the router uses Cloudflare typed answers for both model catalogs and fails open", async (t) => {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const ids = Object.keys(body.questions.model.criteria);
    const response = fixture();
    response.result.answers.model = { type: "choice", choice: ids[0], probabilities: { [ids[0]]: 0.8, [ids[1]]: 0.2 } };
    assert.equal(init.signal instanceof AbortSignal, true);
    return Response.json(response);
  };
  for (const ids of [["claude-haiku-4-5-20251001", "claude-opus-5"], ["gpt-6.1-sol", "gpt-6-astra"]]) {
    const result = await askJev({ prompt: "Rename a variable", current: ids[1], contextTokens: 100, models: ids.map((id, i) => ({ id, tier: i ? "opus" : "haiku" })) });
    assert.equal(result.backend, "cloudflare");
    assert.equal(result.choice, ids[0]);
    assert.equal(result.confidence, 0.8);
    assert.equal(result.metrics.taskComplexity, 1.2 / 9);
  }
  assert.equal(calls, 2);
  globalThis.fetch = async () => new Response(null, { status: 402 });
  assert.equal(await askJev({ prompt: "Rename a variable", current: "large", contextTokens: 100, models }), null);
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  assert.equal(await askJev({ prompt: "Rename a variable", current: "large", contextTokens: 100, models }), null);
});
