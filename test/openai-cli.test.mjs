import test from "node:test";
import assert from "node:assert/strict";
import { openCodeConfig } from "../src/openai-cli.mjs";

test("OpenCode inline config preserves user settings and adds Jev Auto", () => {
  const config = JSON.parse(
    openCodeConfig(
      "http://127.0.0.1:1234/v1",
      JSON.stringify({ theme: "system", provider: { openai: { options: { timeout: 1000 } } } }),
    ),
  );
  assert.equal(config.theme, "system");
  assert.equal(config.provider.openai.options.timeout, 1000);
  assert.equal(config.provider.openai.options.baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(config.provider.openai.models["jev-auto"].name, "Jev Auto");
});
