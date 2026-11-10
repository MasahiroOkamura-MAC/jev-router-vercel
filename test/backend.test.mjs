import { test } from "node:test";
import assert from "node:assert/strict";
import { fromGatewayAnswers, jevBackend, toGatewayQuestions } from "../src/backend.mjs";
import { QUESTIONS, questionForModels } from "../src/config.mjs";

test("a TypeSafe key keeps the upstream backend, even next to a gateway key", () => {
  assert.equal(jevBackend({ JEV_API_KEY: "k" }), "typesafe");
  assert.equal(jevBackend({ TYPESAFE_API_KEY: "k" }), "typesafe");
  assert.equal(jevBackend({ JEV_API_KEY: "k", AI_GATEWAY_API_KEY: "g" }), "typesafe");
});

test("a gateway key alone enables routing through Vercel AI Gateway", () => {
  assert.equal(jevBackend({ AI_GATEWAY_API_KEY: "g" }), "gateway");
  assert.equal(jevBackend({}), null);
});

test("JEV_BACKEND forces a backend, and never one whose key is missing", () => {
  assert.equal(jevBackend({ JEV_BACKEND: "gateway", JEV_API_KEY: "k", AI_GATEWAY_API_KEY: "g" }), "gateway");
  assert.equal(jevBackend({ JEV_BACKEND: "Gateway", JEV_API_KEY: "k" }), null);
  assert.equal(jevBackend({ JEV_BACKEND: "nonsense", AI_GATEWAY_API_KEY: "g" }), "gateway");
});

test("questions are flattened to the plain strings the AI SDK evaluation spec takes", () => {
  const models = [
    { id: "claude-haiku-4-5-20251001", tier: "haiku" },
    { id: "claude-opus-5", tier: "opus", description: "Opus 5" },
  ];
  const out = toGatewayQuestions({ ...QUESTIONS, model: questionForModels(models) });

  assert.equal(out.task_complexity.type, "score");
  assert.deepEqual(out.task_complexity.criteria, QUESTIONS.task_complexity.criteria);

  assert.equal(out.model.type, "choice");
  assert.equal(typeof out.model.instructions, "string");
  assert.match(out.model.instructions, /cheapest exact model[\s\S]*separate choices/);
  assert.deepEqual(Object.keys(out.model.criteria), models.map((m) => m.id));
  for (const text of Object.values(out.model.criteria)) assert.equal(typeof text, "string");
  assert.match(
    out.model.criteria["claude-opus-5"],
    /model: Opus 5\. what: Ordinary and substantial engineering.*not_for: The most demanding/,
  );
});

test("model guidance reserves Astra for demanding work and keeps cheaper tiers bounded", () => {
  const models = [
    { id: "gpt-6-luna", tier: "haiku" },
    { id: "gpt-6-sol", tier: "opus" },
    { id: "gpt-6-astra", tier: "fable" },
  ];
  const question = toGatewayQuestions({ model: questionForModels(models) }).model;
  assert.match(question.instructions, /fable-tier model.*advanced or novel reasoning/);
  assert.match(question.instructions, /multiple domains/);
  assert.match(question.instructions, /high-risk or high-blast-radius/);
  assert.match(question.instructions, /whole-repository migrations/);
  assert.match(question.instructions, /multi-hour autonomous work/);
  assert.match(question.instructions, /Keep simple, ordinary, and bounded substantial work.*cheaper/);
  assert.match(question.criteria["gpt-6-astra"], /advanced reasoning, multi-domain ambiguity, or high blast radius/);
  assert.match(question.criteria["gpt-6-astra"], /Several interacting architecture, security, data, product, or operations decisions/);
  assert.match(question.criteria["gpt-6-sol"], /within one primary domain/);
  assert.doesNotMatch(question.criteria["gpt-6-sol"], /Whole-repo migration/);
});

test("gateway choice answers gain the confidence the policy layer reads", () => {
  const out = fromGatewayAnswers({
    model: { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 } },
    bare: { type: "choice", choice: "a" },
    task_complexity: { type: "score", score: 4.2, probabilities: { 4: 0.8, 5: 0.2 } },
  });
  assert.equal(out.model.confidence, 0.8);
  assert.equal(out.bare.confidence, 1);
  assert.deepEqual(out.bare.probabilities, { a: 1 });
  assert.deepEqual(out.task_complexity, { type: "score", score: 4.2, probabilities: { 4: 0.8, 5: 0.2 } });
});
