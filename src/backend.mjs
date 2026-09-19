// Jev is reachable two ways: TypeSafe's own API (JEV_API_KEY / TYPESAFE_API_KEY) or Vercel AI
// Gateway (AI_GATEWAY_API_KEY), which serves the same model as `typesafe-ai/jev`. Everything
// that depends on which one is in use lives here, so the router and launchers stay agnostic.

export const GATEWAY_MODEL = "typesafe-ai/jev";

const BACKENDS = ["typesafe", "gateway"];

/**
 * Which Jev backend to call, or null when no usable key is present. A TypeSafe key wins when
 * both are set so upstream setups behave exactly as before; `JEV_BACKEND` overrides that.
 *
 * @returns {?("typesafe"|"gateway")}
 */
export function jevBackend(env = process.env) {
  const has = {
    typesafe: Boolean(env.JEV_API_KEY || env.TYPESAFE_API_KEY),
    gateway: Boolean(env.AI_GATEWAY_API_KEY),
  };
  const forced = env.JEV_BACKEND?.toLowerCase();
  if (BACKENDS.includes(forced)) return has[forced] ? forced : null;
  return BACKENDS.find((name) => has[name]) ?? null;
}

/** Shown when routing is off because no key was found. */
export const MISSING_KEY_HINT = "JEV_API_KEY=... (TypeSafe) or AI_GATEWAY_API_KEY=... (Vercel AI Gateway)";

const asText = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).join(" ");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, inner]) => `${key}: ${asText(inner)}`)
      .join(". ");
  }
  return String(value);
};

/**
 * The TypeSafe SDK accepts multi-line instructions and structured criteria; the AI SDK's
 * evaluation spec wants plain strings. Flattens one into the other without losing content.
 */
export function toGatewayQuestions(questions) {
  return Object.fromEntries(
    Object.entries(questions).map(([name, q]) => {
      const instructions = Array.isArray(q.instructions) ? q.instructions.join("\n") : q.instructions;
      if (q.type === "choice") {
        const criteria = Object.fromEntries(
          Object.entries(q.criteria).map(([option, detail]) => [option, asText(detail)]),
        );
        return [name, { type: "choice", instructions, criteria }];
      }
      if (q.type === "score") return [name, { type: "score", instructions, criteria: q.criteria.map(asText) }];
      return [name, { ...q, instructions }];
    }),
  );
}

/**
 * Gateway answers carry per-option probabilities but no `confidence`, which the policy layer
 * reads. The probability of the selected option is the same quantity.
 */
export function fromGatewayAnswers(answers) {
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => {
      if (answer?.type !== "choice" || answer.confidence != null) return [name, answer];
      const probabilities = answer.probabilities ?? { [answer.choice]: 1 };
      return [name, { ...answer, probabilities, confidence: probabilities[answer.choice] ?? 1 }];
    }),
  );
}
