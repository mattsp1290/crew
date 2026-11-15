import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

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
  if (error instanceof CommandDeadline) return 124;
  if (error instanceof CommandFailure) return error.result.kind === "exited" ? Math.max(1, error.result.code) : 128 + osConstants.signals[error.result.signal];
  return 1;
}
export function describe(error: unknown): string {
  return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 32_768);
}
export const now = () => performance.now();
export async function before<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded; completion unknown`)), Math.max(0, deadline - now()));
    })]);
  } finally { clearTimeout(timer); }
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
export async function stopGroup(pid: number, deadline = now() + 3_000) {
  signalGroup(pid, "SIGKILL");
  while (await before(liveGroup(pid), deadline, `Inspect process group ${pid}`)) {
    if (now() >= deadline) throw new Error(`Owned process group ${pid} remained alive after SIGKILL`);
    await delay(Math.min(40, Math.max(0, deadline - now())));
  }
}

class CaptureFailure extends AggregateError {
  readonly pid: number | undefined;
  readonly received: number;
  constructor(errors: unknown[], pid: number | undefined, received: number) {
    super(errors, errors.map(describe).join("\n"));
    this.pid = pid; this.received = received;
  }
}
type CapturedStdout =
  | { kind: "complete"; text: string; received: number; retained: number }
  | { kind: "truncated"; received: number; retained: number };
export async function boundedCommand(program: string, args: string[], deadline: number,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  assert.ok(now() < deadline, `${program}: no operation budget remains`);
  const child = spawn(program, args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const diagnosticBytes = Buffer.alloc(128 * 1024), stdoutBytes = Buffer.alloc(128 * 1024);
  let retained = 0, received = 0, stdoutRetained = 0, stdoutReceived = 0, timedOut = false;
  let commandFailure: CommandResult | undefined;
  let end = deadline;
  const failures: unknown[] = [];
  function drain(chunk: Buffer) {
    received += chunk.length;
    const keep = Math.min(chunk.length, diagnosticBytes.length - retained);
    chunk.copy(diagnosticBytes, retained, 0, keep);
    retained += keep;
  }
  child.stdout.on("data", (chunk: Buffer) => {
    drain(chunk);
    stdoutReceived += chunk.length;
    const keep = Math.min(chunk.length, stdoutBytes.length - stdoutRetained);
    chunk.copy(stdoutBytes, stdoutRetained, 0, keep);
    stdoutRetained += keep;
  });
  child.stderr.on("data", drain);
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const result = new Promise<CommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 }));
  });
  function kill() {
    try { if (child.pid) signalGroup(child.pid, "SIGKILL"); } catch (error) { failures.push(error); }
  }
  const { promise: cancellation, reject: rejectCancellation } = Promise.withResolvers<never>();
  const aborted = () => { end = Math.min(end, now() + 500); kill(); rejectCancellation(new Error(`${program}: aborted`)); };
  const killReserve = Math.min(150, Math.max(10, (deadline - now()) / 4));
  const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(0, deadline - now() - killReserve));
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  try {
    const outcome = await before(Promise.race([result, cancellation]), deadline - killReserve / 2, program);
    if (timedOut || options.signal?.aborted) throw new Error(`${program}: ${timedOut ? "deadline exceeded" : "aborted"}`);
    if (outcome.kind !== "exited" || outcome.code !== 0) commandFailure = outcome;
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", aborted);
    kill();
    if (child.pid) { try { await stopGroup(child.pid, end); } catch (error) { failures.push(error); } }
    try { await before(closed, end, `${program} client close`); } catch (error) { failures.push(error); }
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  const diagnostics = diagnosticBytes.toString("utf8", 0, retained);
  if (commandFailure) failures.unshift(new CommandFailure(program + " " + diagnostics, commandFailure));
  if (failures.length) throw new CaptureFailure(failures, child.pid, received);
  const stdout: CapturedStdout = stdoutReceived === stdoutRetained
    ? { kind: "complete", text: stdoutBytes.toString("utf8", 0, stdoutRetained), received: stdoutReceived, retained: stdoutRetained }
    : { kind: "truncated", received: stdoutReceived, retained: stdoutRetained };
  return { pid: child.pid, diagnostics, stdout, received, retained };
}
export async function receipt(path: string, value: unknown, deadline: number) {
  await boundedCommand(process.execPath, ["--input-type=module", "-e",
    "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],process.argv[2],{mode:0o600})",
    path, typeof value === "string" ? value : JSON.stringify(value, null, 2)], deadline, { env: { ...process.env, NODE_OPTIONS: undefined } });
}
export async function captureDiagnostics(directory: string, destination: string, container: string, deadline = now() + 3_000) {
  const failures: unknown[] = [];
  let pid: number | undefined, received = 0;
  try {
    const result = await boundedCommand(process.execPath, [fileURLToPath(import.meta.url), "--collect", directory, destination, container], deadline - 300);
    pid = result.pid; received = result.received;
  } catch (error) {
    failures.push(error);
    if (error instanceof CaptureFailure) { pid = error.pid; received = error.received; }
  }
  try { await receipt(join(destination, "collector.json"), { pid, received,
    truncated: received > 128 * 1024, failures: failures.map(describe) }, deadline); }
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

class CommandDeadline extends Error {
  constructor() { super("Proof command exceeded its 20-minute deadline"); }
}

export async function captureCommand(log: string, program: string, args: string[]) {
  let fd: number | undefined, retained = 0, received = 0, pid: number | undefined;
  const failures: string[] = [];
  const limit = 8 * 1024 * 1024;
  type Termination = { kind: "signal"; signal: "SIGINT" | "SIGTERM"; deadline: number } | { kind: "deadline"; deadline: number };
  const control: { termination: Termination | undefined; primary: unknown } = { termination: undefined, primary: undefined };
  let force: NodeJS.Timeout | undefined, releaseTimer: NodeJS.Timeout | undefined;
  let release: (result: { kind: "unknown" }) => void = () => {};
  const abandoned = new Promise<{ kind: "unknown" }>(resolve => { release = resolve; });
  function send(signal: NodeJS.Signals) {
    try { if (pid) signalGroup(pid, signal); } catch (error) { failures.push(describe(error)); }
  }
  function terminate(reason: Termination) {
    if (control.termination) return;
    control.termination = reason;
    control.primary ??= reason.kind === "deadline" ? new CommandDeadline() : new CommandFailure(program, { kind: "signalled", signal: reason.signal });
    send(reason.kind === "signal" ? reason.signal : "SIGTERM");
    force = setTimeout(() => send("SIGKILL"), Math.max(0, reason.deadline - now() - 700));
    releaseTimer = setTimeout(() => release({ kind: "unknown" }), Math.max(0, reason.deadline - now() - 600));
  }
  const int = () => terminate({ kind: "signal", signal: "SIGINT", deadline: now() + 6_900 });
  const term = () => terminate({ kind: "signal", signal: "SIGTERM", deadline: now() + 6_900 });
  process.on("SIGINT", int); process.on("SIGTERM", term);
  const commandTimer = setTimeout(() => terminate({ kind: "deadline", deadline: now() + 6_900 }), 20 * 60_000);
  try {
    fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    assert.ok(fstatSync(fd).isFile(), "Command log must be a regular file");
  } catch (error) { failures.push(describe(error)); }
  const child = spawn(program, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  pid = child.pid;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const result = new Promise<CommandResult>(resolve => {
    child.once("error", error => { failures.push(describe(error)); resolve({ kind: "exited", code: 1 }); });
    child.once("exit", (code, signal) => {
      const outcome: CommandResult = signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 };
      if (outcome.kind !== "exited" || outcome.code !== 0) control.primary ??= new CommandFailure(program, outcome);
      resolve(outcome);
    });
  });
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
  const outcome = await Promise.race([result, abandoned]);
  const deadline = control.termination?.deadline ?? now() + 3_000;
  try {
    if (pid) {
      try {
        while (control.termination && now() < deadline - 700 && await before(liveGroup(pid), deadline - 500, "Command group inspection")) {
          await delay(Math.min(40, Math.max(0, deadline - 700 - now())));
        }
        await stopGroup(pid, deadline - 400);
      } catch (error) { failures.push(describe(error)); }
    }
    try { await before(closed, deadline - 350, "Command streams"); }
    catch (error) { failures.push(describe(error)); }
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    if (fd !== undefined) { try { closeSync(fd); } catch (error) { failures.push(describe(error)); } fd = undefined; }
    const report = { pid, outcome, interrupted: control.termination?.kind === "signal" ? control.termination.signal : undefined,
      deadlineExceeded: control.termination?.kind === "deadline", received, retained, truncated: received > retained, failures };
    try { await receipt(log + ".result.json", report, deadline); }
    catch (error) { failures.push(describe(error)); }
    if (control.primary || failures.length) console.error(JSON.stringify(report));
  } finally {
    clearTimeout(commandTimer); clearTimeout(force); clearTimeout(releaseTimer);
    process.off("SIGINT", int); process.off("SIGTERM", term);
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  if (control.primary) throw control.primary;
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
