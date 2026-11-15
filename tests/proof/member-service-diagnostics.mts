import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, writeFileSync, writeSync } from "node:fs";
import { lstat, mkdir, open, opendir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { z } from "zod";

export type CommandResult = { kind: "exited"; code: number } | { kind: "signalled"; signal: NodeJS.Signals };
export class CommandFailure extends Error {
  readonly result: CommandResult;
  constructor(command: string, result: CommandResult) {
    super(`${command}: ${JSON.stringify(result)}`);
    this.result = result;
  }
}
export function exitStatus(error: unknown): number {
  if (error instanceof CaptureFailure) {
    const command = error.errors.find((failure: unknown) => failure instanceof CommandFailure);
    if (command) return exitStatus(command);
  }
  if (error instanceof CommandDeadline) return 124;
  if (error instanceof CommandFailure) return error.result.kind === "exited" ? Math.max(1, error.result.code) : 128 + osConstants.signals[error.result.signal];
  return 1;
}
export function describe(error: unknown): string {
  return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 32_768);
}
export function firstFailure(path: string, error: unknown) {
  try { writeFileSync(path, describe(error), { mode: 0o600, flag: "wx" }); }
  catch (failure) {
    if (!(failure instanceof Error && "code" in failure && failure.code === "EEXIST")) throw failure;
    assert.ok(lstatSync(path).isFile(), "First failure evidence must be a regular file");
  }
}
export function durableLog(path: string, limit = 1024 * 1024) {
  let fd: number | undefined = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  assert.ok(fstatSync(fd).isFile(), "Diagnostic log must be a regular file");
  let received = 0, retained = 0;
  const failures: unknown[] = [];
  return {
    append(chunk: Buffer) {
      received += chunk.length;
      const keep = chunk.subarray(0, Math.max(0, limit - retained));
      if (fd === undefined || !keep.length) return;
      try {
        let offset = 0;
        while (offset < keep.length) offset += writeSync(fd, keep, offset);
        retained += keep.length;
      } catch (error) {
        failures.push(error);
        try { closeSync(fd); } catch (error) { failures.push(error); }
        fd = undefined;
      }
    },
    close() {
      if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { failures.push(error); }
        fd = undefined;
      }
      if (failures.length) throw new AggregateError(failures, "Durable log capture failed");
      return { received, retained, truncated: received > retained };
    },
  };
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
export function signalOwnedChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, "Invalid owned child PID");
  try { process.kill(-child.pid, signal); } catch (error) { if (!missing(error)) throw error; }
}

class CaptureFailure extends AggregateError {
  readonly pid: number | undefined;
  readonly received: number;
  readonly diagnostics: CapturedOutput;
  constructor(errors: unknown[], pid: number | undefined, received: number, diagnostics: CapturedOutput) {
    super(errors, errors.map(describe).join("\n"));
    this.pid = pid; this.received = received; this.diagnostics = diagnostics;
  }
}
type CapturedOutput =
  | { kind: "complete"; text: string; received: number; retained: number }
  | { kind: "truncated"; received: number; retained: number };
export function completedCommandFailure(error: unknown) {
  if (!(error instanceof CaptureFailure) || error.errors.length !== 1 || error.diagnostics.kind !== "complete") return undefined;
  const failure: unknown = error.errors[0];
  if (!(failure instanceof CommandFailure) || failure.result.kind !== "exited") return undefined;
  return { code: failure.result.code, diagnostics: error.diagnostics.text };
}
export async function boundedCommand(program: string, args: string[], deadline: number,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  assert.ok(now() < deadline, `${program}: no operation budget remains`);
  const child = spawn(program, args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const diagnosticBytes = Buffer.alloc(128 * 1024), stdoutBytes = Buffer.alloc(128 * 1024);
  let retained = 0, received = 0, stdoutRetained = 0, stdoutReceived = 0, timedOut = false;
  let commandFailure: CommandResult | undefined;
  let end = deadline;
  const failures: unknown[] = [];
  child.stdout.on("error", error => failures.push(error));
  child.stderr.on("error", error => failures.push(error));
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
    child.once("exit", (code, signal) => {
      const outcome: CommandResult = signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 };
      if (!timedOut && !options.signal?.aborted && (outcome.kind !== "exited" || outcome.code !== 0)) commandFailure = outcome;
      resolve(outcome);
    });
  });
  function kill() {
    try { signalOwnedChild(child, "SIGKILL"); } catch (error) { failures.push(error); }
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
    if (outcome.kind !== "exited" || outcome.code !== 0) commandFailure ??= outcome;
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", aborted);
    kill();
    try { await before(closed, end, `${program} client close`); } catch (error) { failures.push(error); }
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  const diagnostics = diagnosticBytes.toString("utf8", 0, retained);
  if (commandFailure) failures.unshift(new CommandFailure(program + " " + diagnostics, commandFailure));
  if (failures.length) throw new CaptureFailure(failures, child.pid, received, received === retained
    ? { kind: "complete", text: diagnostics, received, retained } : { kind: "truncated", received, retained });
  const stdout: CapturedOutput = stdoutReceived === stdoutRetained
    ? { kind: "complete", text: stdoutBytes.toString("utf8", 0, stdoutRetained), received: stdoutReceived, retained: stdoutRetained }
    : { kind: "truncated", received: stdoutReceived, retained: stdoutRetained };
  return { pid: child.pid, diagnostics, stdout, received, retained };
}
export async function receipt(path: string, value: unknown, deadline: number) {
  await boundedCommand(process.execPath, ["--input-type=module", "-e",
    "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],process.argv[2],{mode:0o600})",
    path, typeof value === "string" ? value : JSON.stringify(value, null, 2)], deadline, { env: { ...process.env, NODE_OPTIONS: undefined } });
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
export async function collectArtifacts(root: string) {
  const failures: string[] = [];
  const entries = await opendir(root);
  let count = 0;
  for await (const entry of entries) {
    if (!entry.isDirectory()) continue;
    assert.ok(++count <= 16, "Too many fixture artifact directories");
    const destination = join(root, entry.name);
    try {
      const file = await open(join(destination, "working-state.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let content: string;
      try {
        const stat = await file.stat();
        assert.ok(stat.isFile() && stat.size <= 16 * 1024, "Working-state metadata must be a bounded regular file");
        const bytes = Buffer.alloc(16 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        assert.ok(bytesRead <= 16 * 1024, "Working-state metadata exceeded its bound");
        content = bytes.subarray(0, bytesRead).toString("utf8");
      } finally { await file.close(); }
      const metadata = z.object({ directory: z.string(), workingState: z.enum(["local", "hosted-vm"]) }).parse(JSON.parse(content));
      assert.ok(isAbsolute(metadata.directory), "Working directory must be absolute");
      await collectFiles(metadata.directory, join(destination, "snapshot"));
    } catch (error) { failures.push(describe(error)); }
  }
  await writeFile(join(root, "collector.json"), JSON.stringify({ failures }), { mode: 0o600 });
  if (failures.length) throw new AggregateError(failures, "Post-step diagnostic collection failed");
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
    try { signalOwnedChild(child, signal); } catch (error) { failures.push(describe(error)); }
  }
  function terminate(reason: Termination) {
    if (control.termination) return;
    control.termination = reason;
    control.primary ??= reason.kind === "deadline" ? new CommandDeadline() : new CommandFailure(program, { kind: "signalled", signal: reason.signal });
    try { firstFailure(log + ".first-failure.txt", control.primary); } catch (error) { failures.push(describe(error)); }
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
  child.stdout.on("error", error => failures.push(describe(error)));
  child.stderr.on("error", error => failures.push(describe(error)));
  pid = child.pid;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const result = new Promise<CommandResult>(resolve => {
    child.once("error", error => { failures.push(describe(error)); resolve({ kind: "exited", code: 1 }); });
    child.once("exit", (code, signal) => {
      const outcome: CommandResult = signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 };
      if (outcome.kind !== "exited" || outcome.code !== 0) {
        control.primary ??= new CommandFailure(program, outcome);
        try { firstFailure(log + ".first-failure.txt", control.primary); } catch (error) { failures.push(describe(error)); }
      }
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
      try {
        let offset = 0;
        while (offset < keep.length) offset += writeSync(fd, keep, offset);
      }
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
    if (outcome.kind === "unknown") send("SIGKILL");
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
    assert.ok(first);
    if (mode === "--command") { assert.ok(second); await captureCommand(first, second, rest); }
    else if (mode === "--collect") {
      assert.ok(isAbsolute(first));
      const timer = setTimeout(() => {
        const error = new Error("Post-step collection exceeded its 6.9-second deadline");
        try { firstFailure(join(first, "collector-first-failure.txt"), error); }
        finally { console.error(describe(error)); process.exit(1); }
      }, 6_900);
      try { await collectArtifacts(first); }
      catch (error) {
        try { firstFailure(join(first, "collector-first-failure.txt"), error); }
        catch (secondary) { console.error("Collector failure capture also failed", describe(secondary)); }
        throw error;
      }
      finally { clearTimeout(timer); }
    }
    else throw new Error("Expected --command or --collect");
  } catch (error) { console.error(describe(error)); process.exitCode = exitStatus(error); }
}
