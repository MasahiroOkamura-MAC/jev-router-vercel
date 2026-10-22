import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalBody, MAX_BODY_BYTES } from "../src/local-http.mjs";
import { privateDirectory, writePrivateJson, readPrivateJson, writeDiagnosticDump } from "../src/private-storage.mjs";
import { loadRoutingEnv } from "../src/env.mjs";
import { formatExplanation } from "../src/explain.mjs";
import { statuslineCommand } from "../src/statusline-command.mjs";
import { resolveCli } from "../src/cli-command.mjs";

const request = (port, headers = {}, body = "{}") => new Promise((resolve, reject) => {
  const req = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/responses", headers }, res => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", reject);
  req.end(body);
});

for (const kind of ["Claude", "Codex"]) {
  test(`${kind} proxy rejects browser origins, foreign Hosts and oversized bodies before forwarding`, async t => {
    let forwarded = 0;
    const upstream = http.createServer((req, res) => {
      forwarded++;
      req.resume();
      req.on("end", () => res.end("{}"));
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => upstream.close());
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const { port, close } = kind === "Claude"
      ? await startProxy({ upstreamURL: base, route: () => { throw Error("Unexpected routing"); } })
      : await startCodexProxy({ chatgptBaseURL: base, apiBaseURL: base, route: () => { throw Error("Unexpected routing"); } });
    t.after(close);
    assert.equal(await request(port, { origin: "https://dummy.invalid" }), 403);
    assert.equal(await request(port, { origin: "null" }), 403);
    assert.equal(await request(port, { host: `dummy.invalid:${port}` }), 403);
    assert.equal(await request(port, { "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await request(port, { "content-length": String(32 * 1024 * 1024 + 1) }), 413);
    assert.equal(forwarded, 0);
    assert.equal(await request(port), 200);
    assert.equal(forwarded, 1);
  });
}

test("chunked bytes over the limit are rejected without forwarding or buffering the remainder", async () => {
  const req = new EventEmitter();
  req.headers = {};
  let status;
  const res = { writeHead: code => { status = code; }, end() {} };
  const body = readLocalBody(req, res);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i <= MAX_BODY_BYTES / chunk.length; i++) req.emit("data", chunk);
  req.emit("end");
  assert.equal(await body, null);
  assert.equal(status, 413);
});

test("aborted input is not passed upstream", async () => {
  const req = new EventEmitter();
  req.headers = {};
  const res = { destroyed: true };
  const body = readLocalBody(req, res);
  req.emit("data", Buffer.from("partial dummy"));
  req.emit("aborted");
  assert.equal(await body, null);
});

test("diagnostic files are private and a symlink cannot redirect a write or read", t => {
  const dir = privateDirectory();
  const name = `dummy-${process.pid}.json`;
  const outside = join(dir, `outside-${process.pid}.json`);
  const file = join(dir, name);
  t.after(() => { for (const path of [file, outside]) rmSync(path, { force: true }); });
  writeFileSync(outside, '{"dummy":"unchanged"}', { mode: 0o600 });
  symlinkSync(outside, file);
  assert.throws(() => readPrivateJson(name));
  writePrivateJson(name, { dummy: "private" });
  assert.equal(readFileSync(outside, "utf8"), '{"dummy":"unchanged"}');
  assert.deepEqual(readPrivateJson(name), { dummy: "private" });
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.throws(() => writePrivateJson("../escape", {}));
});

test("an untrusted project env is ignored; opt-in still cannot configure child execution or provider endpoints", t => {
  const root = mkdtempSync(join(tmpdir(), "jev-env-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home); mkdirSync(cwd);
  writeFileSync(join(cwd, ".env"), "JEV_API_KEY=dummy-project\nNODE_OPTIONS=--require=./dummy.mjs\nAI_GATEWAY_BASE_URL=https://dummy.invalid\n");
  writeFileSync(join(home, ".jev-router.env"), "JEV_API_KEY=dummy-home\nPATH=dummy-untrusted\n");
  const env = {};
  loadRoutingEnv({ home, cwd, env });
  assert.deepEqual(env, { JEV_API_KEY: "dummy-home" });
  const opted = { JEV_ALLOW_PROJECT_ENV: "1" };
  loadRoutingEnv({ home, cwd, env: opted });
  assert.deepEqual(opted, { JEV_ALLOW_PROJECT_ENV: "1", JEV_API_KEY: "dummy-project" });
  const external = { JEV_API_KEY: "dummy-process" };
  loadRoutingEnv({ home, cwd, env: external });
  assert.deepEqual(external, { JEV_API_KEY: "dummy-process" });
});

test("explicit diagnostic dumps stay in the private directory regardless of the old prefix", t => {
  const dir = privateDirectory();
  const before = new Set(readdirSync(dir));
  const old = process.env.JEV_DUMP;
  process.env.JEV_DUMP = "/untrusted/dummy-prefix";
  t.after(() => {
    if (old === undefined) delete process.env.JEV_DUMP;
    else process.env.JEV_DUMP = old;
    for (const name of readdirSync(dir)) {
      if (!before.has(name) && name.startsWith("dump-")) rmSync(join(dir, name));
    }
  });
  writeDiagnosticDump({ dummy: "private dump" });
  const created = readdirSync(dir).filter(name => !before.has(name) && name.startsWith("dump-"));
  assert.equal(created.length, 1);
  assert.deepEqual(readPrivateJson(created[0]), { dummy: "private dump" });
  if (process.platform !== "win32") assert.equal(statSync(join(dir, created[0])).mode & 0o777, 0o600);
});

test("a symlink diagnostic directory is rejected before any private write", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "jev-directory-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(home); mkdirSync(outside);
  symlinkSync(outside, join(home, ".jev-router"));
  const module = new URL("../src/private-storage.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { writePrivateJson } from ${JSON.stringify(module)}; try { writePrivateJson('dummy.json', {}); process.exitCode=1; } catch {}`],
    { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readdirSync(outside), []);
});

test("statusline installation paths are shell data, not command substitutions", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "jev-shell-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "dummy ' $(false) `false` $.mjs");
  writeFileSync(script, "process.stdout.write('dummy statusline');");
  const result = spawnSync("/bin/sh", ["-c", statuslineCommand(process.execPath, script)],
    { env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "dummy statusline");
  assert.equal(statuslineCommand("node.exe", "bad%PATH%.mjs", "win32"), null);
  assert.equal(statuslineCommand("node.exe", "bad\npath.mjs"), null);
});

test("explanation output strips terminal control characters from untrusted fields", () => {
  const output = formatExplanation({ prompt: "dummy\x1b[2J\x00", tier: "opus\x1b[31m" });
  assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
});

test("Windows CLI resolution never selects a batch shell for prompt arguments", () => {
  for (const name of ["claude", "codex"]) {
    const base = { platform: "win32", env: { PATH: "C:\\dummy", SystemRoot: "C:\\Windows" } };
    assert.equal(resolveCli(name, { ...base, accessible: file => /\.(cmd|bat)$/i.test(file) }), null);
    const native = resolveCli(name, { ...base, accessible: file => file.endsWith(".exe") });
    assert.equal(native.shell, false);
    assert.deepEqual(native.prefix, []);
    const ps = resolveCli(name, { ...base, accessible: file => file.endsWith(".ps1") });
    assert.equal(ps.shell, false);
    assert.deepEqual(ps.prefix, ["-NoProfile", "-File", `C:\\dummy\\${name}.ps1`]);
    assert.equal(ps.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  }
});

test("statusline output treats an untrusted directory name as terminal text", t => {
  const root = mkdtempSync(join(tmpdir(), "jev-statusline-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL("../bin/jev-statusline.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { env: { PATH: process.env.PATH, HOME: root },
    input: JSON.stringify({ cwd: "dummy\x1b]52;evil\x07", model: { display_name: "dummy" } }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b\]|\x07/);
  assert.match(result.stdout, /dummy/);
});
