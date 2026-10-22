import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const KEYS = new Set(["JEV_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "JEV_BACKEND"]);

// Repository files cannot silently configure a native CLI or enable project-env loading.
// Existing process variables win. Only routing keys are read, never NODE_OPTIONS,
// provider URL overrides, PATH or child-process configuration.
export function loadRoutingEnv({ cwd = process.cwd(), home = homedir(), env = process.env } = {}) {
  const files = [
    ...(env.JEV_ALLOW_PROJECT_ENV === "1" ? [join(cwd, ".env")] : []),
    join(home, ".jev-router.env"),
    join(home, ".jev-claude.env"),
  ];
  for (const file of files) {
    try {
      for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
        if (KEYS.has(key) && env[key] === undefined) env[key] = value;
      }
    } catch {
      // Missing configuration does not prevent the underlying CLI from starting.
    }
  }
}
