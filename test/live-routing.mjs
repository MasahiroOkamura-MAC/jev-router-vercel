try {
  process.loadEnvFile();
} catch {
  // No .env; the key may still come from the real environment.
}
const { askJev } = await import("../src/router.mjs");
const { TIERS } = await import("../src/config.mjs");
const { jevBackend } = await import("../src/backend.mjs");
const models = TIERS.map((t) => ({ id: t.id, tier: t.name }));
console.log(`backend: ${jevBackend() ?? "none (set JEV_API_KEY or AI_GATEWAY_API_KEY)"}`);
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
];
for (const prompt of prompts) {
  const a = await askJev({ prompt, current: "claude-sonnet-5", contextTokens: 0, models });
  if (!a) { console.log(`FAIL  ${prompt}`); continue; }
  const p = Object.entries(a.probabilities).map(([k,v]) => `${k}=${v.toFixed(2)}`).join(" ");
  console.log(`${a.choice.padEnd(26)} conf=${a.confidence.toFixed(2)} ${String(a.ms).padStart(5)}ms | ${p} | ${prompt}`);
}
