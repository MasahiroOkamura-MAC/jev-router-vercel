import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("detectOverride recognises Japanese Astra instructions", () => {
  for (const prompt of [
    "Astraを使って",
    "Astraで実装して",
    "Astraにして",
    "Astraを選んで",
    "今回はアストラを使ってください",
    "このタスクはAstraで進めてください",
    "今回はAstraを使ってください。",
  ]) {
    assert.equal(detectOverride(prompt), "fable", prompt);
  }
});

test("Japanese override detection does not match incidental Astra text", () => {
  assert.equal(detectOverride("Astraについて説明して"), null);
  assert.equal(detectOverride("nonastraを使って"), null);
});

test("detectOverride recognises explicit Japanese instructions for every tier", () => {
  const cases = [
    ["Lunaを使って", "haiku"],
    ["ルナで実装して", "haiku"],
    ["Terraにして", "sonnet"],
    ["テラで作業して", "sonnet"],
    ["Solを選んで", "opus"],
    ["ソルで進めて", "opus"],
    ["Astraで作業して", "fable"],
    ["Astraで進めて", "fable"],
    ["Astraで対応して", "fable"],
    ["Astraでやって", "fable"],
    ["Astraでお願い", "fable"],
  ];
  for (const [prompt, tier] of cases) assert.equal(detectOverride(prompt), tier, prompt);
});

test("Japanese override detection rejects questions, comparison, quotation, and explanation", () => {
  for (const prompt of [
    "Astraを使ってはいけない",
    "Astraで実装してほしくない",
    "Astraで実装している場合を説明して",
    "`Astraで実装して`という文字列",
    "「Astraで実装して」という指定例",
    "Astraで実装してもらえますか？",
    "Astraでは何ができますか",
    "Astraでも対応可能？",
    "Astraで利用できる機能を説明して",
    "AstraとSolを比較して",
    "『Astraで実装して』という文を引用して",
    "Lunaでは何ができますか",
    "Terraでも対応可能？",
    "Solで利用できる機能を説明して",
  ]) {
    assert.equal(detectOverride(prompt), null, prompt);
  }
});

test("quoted and code examples never become overrides", () => {
  for (const prompt of [
    "```text\nAstraで実装して\n```",
    "```text\nuse astra\n```",
    "`use astra`",
    "「use astra」という指定例",
    "“Astraで実装して”",
    '"Astraで実装して"',
    "'Astraで実装して'",
    "`switch to opus`",
  ]) assert.equal(detectOverride(prompt), null, prompt);
  assert.equal(detectOverride("`use luna` は例です。このタスクはAstraで進めてください"), "fable");
});

test("guard preserves English aliases and rejects Japanese negation across tiers", () => {
  for (const [tier, aliases] of [
    ["haiku", ["haiku", "fast", "luna"]],
    ["sonnet", ["sonnet", "balanced", "terra"]],
    ["opus", ["opus", "strong", "sol"]],
    ["fable", ["fable", "long", "astra"]],
  ]) {
    for (const alias of aliases) {
      assert.equal(detectOverride(`use ${alias} to implement this`), tier);
      assert.equal(detectOverride(`${alias}で実装して`), tier);
      assert.equal(detectOverride(`${alias}で実装してほしくない`), null);
    }
  }
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});
