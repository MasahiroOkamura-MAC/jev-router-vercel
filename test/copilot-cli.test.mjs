import test from "node:test";
import assert from "node:assert/strict";
import { copilotTiers, routeCopilotBody } from "../src/copilot-cli.mjs";

const request = (prompt) => ({
  model: "gpt-5.6-terra",
  tools: [{ type: "function", name: "shell" }],
  input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
});

test("Copilot account model list limits the tiers Jev may choose", () => {
  const old = process.env.JEV_ALLOW_FABLE;
  delete process.env.JEV_ALLOW_FABLE;
  try {
    assert.deepEqual(
      copilotTiers([
        { id: "gpt-5.6-luna" },
        { id: "gpt-5.6-sol" },
        { id: "some-other-model" },
      ]),
      ["haiku", "opus"],
    );
  } finally {
    if (old == null) delete process.env.JEV_ALLOW_FABLE;
    else process.env.JEV_ALLOW_FABLE = old;
  }
});

test("Copilot request routing rewrites the hosted model and pins continuations", async () => {
  const currentByAgent = new Map();
  const decisions = [];
  const body = request("fix the typo");
  await routeCopilotBody({
    body,
    key: "session:root",
    currentByAgent,
    tiers: ["haiku", "sonnet", "opus"],
    route: async () => ({ choice: "haiku", confidence: 0.99, ms: 1 }),
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(currentByAgent.get("session:root"), "haiku");
  assert.equal(decisions[0].reason, "jev");

  const continuation = {
    model: "gpt-5.6-terra",
    tools: [{ type: "function", name: "shell" }],
    input: [{ type: "function_call_output", call_id: "1", output: "done" }],
  };
  await routeCopilotBody({
    body: continuation,
    key: "session:root",
    currentByAgent,
    tiers: ["haiku", "sonnet", "opus"],
    route: async () => assert.fail("continuations must not call Jev"),
  });
  assert.equal(continuation.model, "gpt-5.6-luna");
});
