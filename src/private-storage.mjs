import {
  mkdirSync, lstatSync, chmodSync, openSync, closeSync, writeFileSync,
  renameSync, unlinkSync, constants, fstatSync, readFileSync, fchmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const owned = info => !process.getuid || info.uid === process.getuid();

export function privateDirectory() {
  const root = join(homedir(), ".jev-router");
  const dir = join(root, ".secret");
  for (const path of [root, dir]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) {
      throw new Error("Unsafe diagnostic directory");
    }
    chmodSync(path, 0o700);
  }
  return dir;
}

const validName = name => /^[\w.-]+$/.test(name) && name !== "." && name !== "..";

export function writePrivateJson(name, value) {
  if (!validName(name)) throw new Error("Invalid diagnostic filename");
  const dir = privateDirectory();
  const temp = join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, join(dir, name));
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

export function readPrivateJson(name) {
  if (!validName(name)) return null;
  const path = join(privateDirectory(), name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || info.nlink !== 1 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) return null;
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function appendPrivateLog(text) {
  const path = join(privateDirectory(), "diagnostic.log");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK |
    (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || info.nlink !== 1) return;
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text);
  } finally { closeSync(fd); }
}

export function writeDiagnosticDump(body) {
  if (process.env.JEV_DUMP) writePrivateJson(`dump-${Date.now()}-${randomUUID()}.json`, body);
}
