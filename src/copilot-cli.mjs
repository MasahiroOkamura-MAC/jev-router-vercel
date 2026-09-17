import { spawn } from "node:child_process";
import { loadEnv, resolveCommand } from "./openai-cli.mjs";
import { startCopilotProxy, withoutCopilotNoProxy } from "./copilot-proxy.mjs";

export { routeCopilotBody, withoutCopilotNoProxy } from "./copilot-proxy.mjs";

function spawnCopilot(command, args, env) {
  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

export async function runCopilot(args = process.argv.slice(2)) {
  loadEnv();
  const command = resolveCommand("copilot");
  if (!command) {
    process.stderr.write("[jev] copilot is not installed, or it is not on your PATH\n");
    process.exitCode = 1;
    return;
  }

  if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
    process.stderr.write("[jev] no JEV_API_KEY found - starting Copilot without routing\n");
    process.exitCode = await spawnCopilot(command, args, process.env);
    return;
  }

  let proxy;
  try {
    proxy = await startCopilotProxy();
    const proxyURL = `http://127.0.0.1:${proxy.port}`;
    const noProxy = withoutCopilotNoProxy(process.env.NO_PROXY ?? process.env.no_proxy);
    const env = {
      ...process.env,
      HTTPS_PROXY: proxyURL,
      https_proxy: proxyURL,
      NODE_EXTRA_CA_CERTS: proxy.caFile,
      COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: "1",
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
    process.exitCode = await spawnCopilot(command, args, env);
  } catch (err) {
    process.stderr.write(`[jev] Copilot failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await proxy?.close();
  }
}
