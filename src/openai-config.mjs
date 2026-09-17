const DEFAULTS = {
  haiku: "gpt-5.6-luna",
  sonnet: "gpt-5.6-terra",
  opus: "gpt-5.6-sol",
  fable: "gpt-6-astra",
};

const ENV = {
  haiku: "JEV_OPENAI_FAST_MODEL",
  sonnet: "JEV_OPENAI_BALANCED_MODEL",
  opus: "JEV_OPENAI_STRONG_MODEL",
  fable: "JEV_OPENAI_LONG_MODEL",
};

export const openAIModelOf = (tier) =>
  process.env[ENV[tier]] ?? DEFAULTS[tier];

export const openAITierOf = (model) =>
  Object.keys(DEFAULTS).find((tier) => openAIModelOf(tier) === model) ?? null;
