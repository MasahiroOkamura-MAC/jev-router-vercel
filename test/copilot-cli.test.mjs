import test from "node:test";
import assert from "node:assert/strict";
import { routeCopilotBody, withoutCopilotNoProxy } from "../src/copilot-cli.mjs";

const request = (prompt) => ({
  model: "gpt-5.6-terra",
  tools: [{ type: "function", name: "shell" }],
  input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
});

test("Copilot hosts are removed from NO_PROXY", () => {
  assert.equal(
    withoutCopilotNoProxy("localhost,.api.enterprise.githubcopilot.com,example.com"),
    "localhost,example.com",
  );
});

test("Copilot request routing rewrites the hosted model and pins continuations", async () => {
  const decisions = [];
  const body = request("fix the typo");
  const current = await routeCopilotBody({
    body,
    tiers: ["haiku", "sonnet", "opus"],
    route: async () => ({ choice: "haiku", confidence: 0.99, ms: 1 }),
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(current, "haiku");
  assert.equal(decisions[0].reason, "jev");

  const continuation = {
    model: "gpt-5.6-terra",
    tools: [{ type: "function", name: "shell" }],
    input: [{ type: "function_call_output", call_id: "1", output: "done" }],
  };
  await routeCopilotBody({
    body: continuation,
    current,
    tiers: ["haiku", "sonnet", "opus"],
    route: async () => assert.fail("continuations must not call Jev"),
  });
  assert.equal(continuation.model, "gpt-5.6-luna");
});

test("Copilot routing failures are surfaced", async () => {
  await assert.rejects(
    routeCopilotBody({
      body: request("fix the typo"),
      route: async () => {
        throw new Error("routing unavailable");
      },
    }),
    /routing unavailable/,
  );
});
