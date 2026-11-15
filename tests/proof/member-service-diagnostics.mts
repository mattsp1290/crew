import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type CommandResult = { kind: "exited"; code: number } | { kind: "signalled"; signal: NodeJS.Signals };
export class CommandFailure extends Error {
  readonly result: CommandResult;
  constructor(command: string, result: CommandResult) {
    super(`${command}: ${JSON.stringify(result)}`);
    this.result = result;
  }
}
export function exitStatus(error: unknown): number {
  if (error instanceof CommandFailure) return error.result.kind === "exited" ? Math.max(1, error.result.code) : 128 + osConstants.signals[error.result.signal];
  return 1;
}
export function describe(error: unknown): string {
  return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 32_768);
}
function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch (error) { if (!missing(error)) throw error; }
}
export async function liveGroup(pid: number): Promise<boolean> {
  try { process.kill(-pid, 0); } catch (error) { if (missing(error)) return false; throw error; }
  const entries = await opendir("/proc");
  for await (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    let stat: string;
    try { stat = await readFile(`/proc/${entry.name}/stat`, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) continue;
      throw error;
    }
    const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(group) === pid && state !== "Z" && state !== "X") return true;
  }
  return false;
}
export async function stopGroup(pid: number) {
  signalGroup(pid, "SIGKILL");
  const deadline = Date.now() + 3_000;
  while (await liveGroup(pid)) {
    if (Date.now() >= deadline) throw new Error(`Owned process group ${pid} remained alive after SIGKILL`);
    await delay(40);
  }
}

export async function captureDiagnostics(directory: string, destination: string, container: string) {
  const collector = spawn(process.execPath, [fileURLToPath(import.meta.url), "--collect", directory, destination, container],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = collector.pid;
  let output = "", received = 0;
  function drain(chunk: Buffer) {
    received += chunk.length;
    if (output.length < 128 * 1024) output += chunk.subarray(0, 128 * 1024 - output.length).toString();
  }
  collector.stdout.on("data", drain); collector.stderr.on("data", drain);
  const result = new Promise<CommandResult>((resolve, reject) => {
    collector.once("error", reject);
    collector.once("exit", (code, signal) => resolve(signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 }));
  });
  const timer = setTimeout(() => { if (pid) signalGroup(pid, "SIGKILL"); }, 8_000);
  const failures: unknown[] = [];
  try {
    const outcome = await result;
    if (outcome.kind !== "exited" || outcome.code !== 0) throw new CommandFailure("Diagnostic collector " + output, outcome);
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(timer);
    if (pid) { try { await stopGroup(pid); } catch (error) { failures.push(error); } }
    collector.stdout.destroy(); collector.stderr.destroy();
  }
  try { await writeFile(join(destination, "collector.json"), JSON.stringify({ pid, received,
    truncated: received > 128 * 1024, failures: failures.map(describe) }, null, 2)); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, failures.map(describe).join("\n"));
}

const fileLimit = 256 * 1024, totalLimit = 16 * 1024 * 1024, countLimit = 64;
const allowed = /^(?:worker\.log|temporal\.log|(?:observer-)?gateway(?:-\d+)?\.log|observation\.log|recovery-[a-zA-Z0-9-]+\.log|requests\.jsonl|codex-results\.jsonl|note-evidence\.jsonl|(?:pi|claude|codex)-observer-[ab]\.jsonl(?:\.messages\.json)?)$/;
export async function collectFiles(directory: string, destination: string) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const manifest: { name: string; status: string; bytes?: number; originalBytes?: number }[] = [];
  let bytes = 0, count = 0, examined = 0;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (++examined > 1024) { manifest.push({ name: "remaining directory entries", status: "omitted: entry limit" }); break; }
    if (!allowed.test(entry.name)) continue;
    if (count >= countLimit || bytes >= totalLimit) { manifest.push({ name: entry.name, status: "omitted: budget" }); continue; }
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) { manifest.push({ name: entry.name, status: "omitted: not regular" }); continue; }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile()) { manifest.push({ name: entry.name, status: "omitted: not regular" }); continue; }
      const size = Math.min(opened.size, fileLimit, totalLimit - bytes);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, Math.max(0, opened.size - size));
      await writeFile(join(destination, entry.name), buffer.subarray(0, bytesRead), { mode: 0o600 });
      bytes += bytesRead; count++;
      manifest.push({ name: entry.name, status: opened.size > bytesRead ? "truncated" : "copied", bytes: bytesRead, originalBytes: opened.size });
    } finally { await file.close(); }
  }
  await writeFile(join(destination, "files.json"), JSON.stringify({ bytes, count, files: manifest }, null, 2));
}
async function collect(directory: string, destination: string, container: string) {
  await collectFiles(directory, destination);
  const queries = [
    ["turns", "conversation_id,request_id,phase,attempt"],
    ["native_launches", "conversation_id,request_id,child_id,activity_id,attempt,stopped,recovery_closed"],
    ["pi_children", "child_id,conversation_id,request_id,phase,generation,attempt,launch_revoked"],
  ];
  const results = await Promise.allSettled(queries.map(async ([table, fields]) => {
    const query = `SET statement_timeout='1000ms'; SELECT row_to_json(t) FROM (SELECT ${fields} FROM birbcrew_ts.${table} LIMIT 100) t`;
    const { stdout } = await exec("docker", ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "birbcrew_ts", "-Atc", query],
      { timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
    await writeFile(join(destination, table + ".jsonl"), stdout, { mode: 0o600 });
  }));
  const failures = results.filter(result => result.status === "rejected").map(result => describe(result.reason));
  await writeFile(join(destination, "sql.json"), JSON.stringify({ failures }));
  if (failures.length) throw new AggregateError(failures, "Lifecycle SQL capture failed");
}

export async function captureCommand(log: string, program: string, args: string[]) {
  let fd: number | undefined, retained = 0, received = 0;
  const failures: string[] = [];
  const limit = 8 * 1024 * 1024;
  try {
    fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    assert.ok(fstatSync(fd).isFile(), "Command log must be a regular file");
  } catch (error) { failures.push(describe(error)); }
  const child = spawn(program, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const result = new Promise<CommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 }));
  });
  let interrupted: NodeJS.Signals | undefined;
  let force: NodeJS.Timeout | undefined;
  let interruptDeadline = 0;
  function interrupt(signal: "SIGINT" | "SIGTERM") {
    interrupted ??= signal;
    interruptDeadline ||= Date.now() + 65_000;
    if (child.pid) signalGroup(child.pid, signal);
    force ??= setTimeout(() => { if (child.pid) signalGroup(child.pid, "SIGKILL"); }, 65_000);
  }
  const int = () => interrupt("SIGINT"), term = () => interrupt("SIGTERM");
  process.on("SIGINT", int); process.on("SIGTERM", term);
  function drain(chunk: Buffer) {
    received += chunk.length;
    const keep = chunk.subarray(0, Math.max(0, limit - retained));
    retained += keep.length;
    if (!keep.length) return;
    process.stdout.write(keep);
    if (fd !== undefined) {
      try { writeSync(fd, keep); }
      catch (error) {
        failures.push(describe(error));
        try { closeSync(fd); } catch (error) { failures.push(describe(error)); }
        fd = undefined;
      }
    }
  }
  child.stdout.on("data", drain); child.stderr.on("data", drain);
  let outcome: CommandResult;
  try { outcome = await result; }
  catch (error) { failures.push(describe(error)); outcome = { kind: "exited", code: 1 }; }
  try {
    if (child.pid) {
      try {
        while (interrupted && Date.now() < interruptDeadline && await liveGroup(child.pid)) await delay(100);
        await stopGroup(child.pid);
      } catch (error) { failures.push(describe(error)); }
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Command streams did not close")), 2_000);
      })]);
    } catch (error) { failures.push(describe(error)); child.stdout.destroy(); child.stderr.destroy(); }
    finally { clearTimeout(timer); }
  } finally {
    if (force) clearTimeout(force);
    process.off("SIGINT", int); process.off("SIGTERM", term);
    if (fd !== undefined) { try { closeSync(fd); } catch (error) { failures.push(describe(error)); } }
  }
  const report = { pid: child.pid, outcome, interrupted, received, retained, truncated: received > retained, failures };
  try { await writeFile(log + ".result.json", JSON.stringify(report, null, 2), { mode: 0o600 }); }
  catch (error) { failures.push(describe(error)); }
  if (outcome.kind === "signalled" || outcome.code !== 0) {
    console.error(JSON.stringify(report));
    throw new CommandFailure(program, outcome);
  }
  if (interrupted) throw new CommandFailure(program, { kind: "signalled", signal: interrupted });
  if (failures.length) throw new AggregateError(failures, "Command capture or cleanup failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, first, second, ...rest] = process.argv.slice(2);
    assert.ok(first && second);
    if (mode === "--command") await captureCommand(first, second, rest);
    else if (mode === "--collect") {
      assert.ok(isAbsolute(first) && isAbsolute(second) && /^birb-proof-[a-f0-9-]+$/.test(rest[0] ?? ""));
      await collect(first, second, rest[0]);
    } else throw new Error("Expected --command or --collect");
  } catch (error) { console.error(describe(error)); process.exitCode = exitStatus(error); }
}
