import test from "node:test";
import assert from "node:assert/strict";
import { openAINewTurnPrompt, applyOpenAITier } from "../src/openai-proxy.mjs";

test("reads new turns from Responses API input", () => {
  const body = {
    tools: [{ type: "function", name: "shell" }],
    input: [{ role: "user", content: [{ type: "input_text", text: "fix the bug" }] }],
  };
  assert.equal(openAINewTurnPrompt(body), "fix the bug");
});

test("ignores Responses API tool continuations", () => {
  const body = {
    tools: [{ type: "function", name: "shell" }],
    input: [{ type: "function_call_output", call_id: "1", output: "done" }],
  };
  assert.equal(openAINewTurnPrompt(body), null);
});

test("reads new turns from Chat Completions input", () => {
  const body = {
    tools: [{ type: "function", function: { name: "shell" } }],
    messages: [{ role: "user", content: "fix the bug" }],
  };
  assert.equal(openAINewTurnPrompt(body), "fix the bug");
});

test("ignores Chat Completions tool continuations and utility calls", () => {
  assert.equal(
    openAINewTurnPrompt({
      tools: [{ type: "function" }],
      messages: [{ role: "tool", content: "done" }],
    }),
    null,
  );
  assert.equal(openAINewTurnPrompt({ input: "name this session" }), null);
});

test("maps abstract routing tiers to OpenAI wire models", () => {
  const body = { model: "jev-auto" };
  applyOpenAITier(body, "haiku");
  assert.equal(body.model, process.env.JEV_OPENAI_FAST_MODEL ?? "gpt-5.6-luna");
});

test("reads model overrides after env files are loaded", () => {
  const previous = process.env.JEV_OPENAI_FAST_MODEL;
  process.env.JEV_OPENAI_FAST_MODEL = "custom-fast";
  const body = { model: "jev-auto" };
  applyOpenAITier(body, "haiku");
  assert.equal(body.model, "custom-fast");
  if (previous === undefined) delete process.env.JEV_OPENAI_FAST_MODEL;
  else process.env.JEV_OPENAI_FAST_MODEL = previous;
});
