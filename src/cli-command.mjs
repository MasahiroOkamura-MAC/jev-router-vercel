import { accessSync, constants } from "node:fs";
import path from "node:path";

export function resolveCli(name, { platform = process.platform, env = process.env,
  accessible = file => { accessSync(file, constants.F_OK); return true; } } = {}) {
  const win = platform === "win32";
  const exts = win ? [".exe", ".com", ".ps1"] : [""];
  const paths = win ? path.win32 : path;
  for (const dir of (env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = paths.join(dir.replace(/^"|"$/g, ""), `${name}${ext}`);
      try {
        if (!accessible(file)) continue;
        if (win && ext === ".ps1") {
          const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
          if (!systemRoot) continue;
          return { file: paths.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: false };
      } catch { /* Continue searching PATH. */ }
    }
  }
  // Batch shims require a command shell; user prompts must never become shell code.
  return null;
}
