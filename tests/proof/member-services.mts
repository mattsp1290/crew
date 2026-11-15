import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { captureDiagnostics, CommandFailure, describe, exitStatus, stopGroup, type CommandResult } from "./member-service-diagnostics.mts";

export type Engine = "pi" | "claude" | "codex";
export const run = promisify(execFile);
export async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 60_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(200);
  }
  throw new Error("Timed out waiting for " + label);
}
type Outcome = { kind: "passed" } | { kind: "failed"; error: unknown };
type OwnedProcess = { pid: number; result: Promise<CommandResult>; stop: () => Promise<void>; log: string };

export async function services(selected?: Engine, label = basename(process.argv[1] ?? "service", ".mts")) {
  assert.match(label, /^[a-zA-Z0-9-]+$/);
  const root = process.env.BIRBCREW_PROOF_ARTIFACTS ?? join(tmpdir(), "crew-service-proofs");
  assert.ok(isAbsolute(root), "BIRBCREW_PROOF_ARTIFACTS must be absolute");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const artifacts = mkdtempSync(join(root, label + "-"));
  const directory = mkdtempSync(join(tmpdir(), "birb-members-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: directory, BIRBCREW_STATE_DIR: join(directory, "native"),
    BIRBCREW_PROOF_LOG_DIR: directory,
    BIRBCREW_PROOF_STREAM_DIR: directory, BIRBCREW_PROOF_REQUESTS: join(directory, "requests.jsonl"),
    BIRBCREW_PROOF_CODEX_REQUESTS: join(directory, "codex-results.jsonl"),
    BIRBCREW_PROOF_NOTES: join(directory, "note-evidence.jsonl"),
    ...(selected && { BIRBCREW_PROOF_ENGINE: selected }),
  };
  const temporal = process.env.TEMPORAL_CLI ?? "temporal";
  const db = "birb-proof-" + randomUUID(), password = randomBytes(24).toString("hex");
  const controller = new AbortController();
  const processes: OwnedProcess[] = [];
  let state: { kind: "open" } | { kind: "closing"; done: Promise<void> } = { kind: "open" };
  let first: Outcome = { kind: "passed" };
  let gatewayNumber = 0;
  const failures: unknown[] = [];
  function ensureOpen() { assert.equal(state.kind, "open", "Fixture is closing"); }
  async function start(program: string, args: string[], options: NodeJS.ProcessEnv, log: string) {
    ensureOpen();
    const file = await open(join(directory, log), "a", 0o600);
    let owned: OwnedProcess;
    try {
      ensureOpen();
      const proc = spawn(program, args, { env: options, detached: true, stdio: ["ignore", file.fd, file.fd] });
      const result = new Promise<CommandResult>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("exit", (code, signal) => resolve(signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 }));
      });
      void result.catch(() => {});
      if (!proc.pid) { await result; throw new Error("Child has no process identity"); }
      const pid = proc.pid;
      let stopped: Promise<void> | undefined;
      function stop() {
        return stopped ??= (async () => {
          await stopGroup(pid);
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([result, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Owned process ${pid} did not exit`)), 2_000);
            })]);
          } finally { clearTimeout(timer); }
        })();
      }
      owned = { pid, result, stop, log };
      processes.push(owned);
    } finally { await file.close(); }
    return owned;
  }
  async function child(program: string, args: string[], options = env, log = "worker.log") {
    return (await start(program, args, options, log)).stop;
  }
  async function execute(program: string, args: string[]) {
    const proc = await start(program, args, env, "observation.log");
    const result = await proc.result;
    const failure = result.kind !== "exited" || result.code !== 0 ? new CommandFailure(program, result) : undefined;
    try {
      const file = await open(join(directory, proc.log), "r");
      try {
        const stat = await file.stat(), size = Math.min(stat.size, 8 * 1024 * 1024);
        const bytes = Buffer.alloc(size);
        await file.read(bytes, 0, size, Math.max(0, stat.size - size));
        process.stdout.write(bytes);
        if (size < stat.size) console.error(`Observation output truncated to last ${size} bytes; total ${stat.size}`);
      } finally { await file.close(); }
    } catch (error) {
      if (!failure) throw error;
      console.error("Observation output capture also failed", describe(error));
    }
    if (failure) throw failure;
  }
  async function gateway(configuration: string) {
    const log = `gateway-${++gatewayNumber}.log`;
    const proc = await start(process.execPath, ["src/service/gateway.ts", configuration], env, log);
    const url = await Promise.race([
      until(async () => {
        ensureOpen();
        const file = await open(join(directory, log), "r");
        try {
          const bytes = Buffer.alloc(16 * 1024);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          const line = bytes.subarray(0, bytesRead).toString().split("\n").find(value => value.startsWith('{"url":'));
          return line ? z.object({ url: z.url() }).parse(JSON.parse(line)).url : undefined;
        } finally { await file.close(); }
      }, "gateway to listen"),
      proc.result.then(result => { throw new CommandFailure("Gateway exited before listening", result); }),
    ]);
    return { url, stop: proc.stop };
  }
  function close(outcome: Outcome = { kind: "passed" }): Promise<void> {
    if (first.kind === "passed" && outcome.kind === "failed") {
      first = outcome;
      const message = describe(outcome.error);
      console.error(`${label} first failure: ${message}`);
      try { writeFileSync(join(artifacts, "first-failure.txt"), message, { mode: 0o600 }); }
      catch (error) { failures.push(error); console.error("First failure persistence also failed", describe(error)); }
    }
    if (state.kind === "closing") return state.done;
    const done = Promise.resolve().then(async () => {
      const attempt = async (operation: () => Promise<unknown>) => {
        try { await operation(); } catch (error) { failures.push(error); console.error(`${label} secondary failure: ${describe(error)}`); }
      };
      controller.abort();
      await attempt(() => writeFile(join(artifacts, "ownership.json"), JSON.stringify({ label, directory, container: db,
        processes: processes.map(({ pid, log }) => ({ pid, log })) }, null, 2)));
      await attempt(() => captureDiagnostics(directory, artifacts, db));
      await Promise.all(processes.map(proc => attempt(proc.stop)));
      await Promise.all([
        attempt(async () => {
          await run("docker", ["rm", "-f", db], { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
          const { stdout } = await run("docker", ["ps", "-aq", "--filter", "name=^/" + db + "$"], { timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 1024 });
          assert.equal(stdout.trim(), "", "Owned PostgreSQL container remained after removal");
        }),
        attempt(() => run("rm", ["-rf", "--", directory], { timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 1024 })),
      ]);
      await attempt(() => writeFile(join(artifacts, "cleanup.json"), JSON.stringify({ failures: failures.map(describe),
        outcome: first.kind === "failed" ? { kind: "failed", error: describe(first.error), status: exitStatus(first.error) } : first }, null, 2)));
      process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
      if (first.kind === "failed") throw first.error;
      if (failures.length) throw new AggregateError(failures, "Fixture capture or cleanup failed");
    });
    state = { kind: "closing", done };
    return done;
  }
  function interrupt(signal: "SIGINT" | "SIGTERM") {
    const error = new CommandFailure(label, { kind: "signalled", signal });
    void close({ kind: "failed", error }).then(() => process.exit(exitStatus(error)), failure => process.exit(exitStatus(failure)));
  }
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  async function databaseReady() {
    await until(async () => {
      ensureOpen();
      try { await run("docker", ["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { timeout: 2_000, killSignal: "SIGKILL" }); return true; }
      catch { return undefined; }
    }, "PostgreSQL");
    const { stdout } = await run("docker", ["port", db, "5432/tcp"], { timeout: 2_000, killSignal: "SIGKILL" });
    const port = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    assert.ok(port, "Expected a loopback-only PostgreSQL port");
    env.BIRBCREW_DATABASE_URL = env.BIRBCREW_TEST_DATABASE_URL = "postgres://postgres:" + password + "@127.0.0.1:" + port + "/birbcrew_ts";
  }
  async function sql(statement: string) {
    ensureOpen();
    return (await run("docker", ["exec", db, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "birbcrew_ts", "-Atc", statement],
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, signal: controller.signal, killSignal: "SIGKILL" })).stdout.trim();
  }
  async function worker(engine = selected) {
    return child(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"],
      { ...env, ...(engine && { BIRBCREW_PROOF_ENGINE: engine }) });
  }
  async function startTemporal() {
    const address = env.BIRBCREW_TEMPORAL_ADDRESS!;
    const stop = await child(temporal, ["server", "start-dev", "--headless", "--port", address.split(":")[1],
      "--db-filename", join(directory, "temporal.db")], env, "temporal.log");
    await until(async () => {
      ensureOpen();
      try { await run(temporal, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"], { env, timeout: 2_000, killSignal: "SIGKILL" }); return true; }
      catch { return undefined; }
    }, "Temporal");
    return stop;
  }
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    const cliVersion = await run(temporal, ["--version"], { timeout: 5_000, killSignal: "SIGKILL" });
    assert.match(cliVersion.stdout, /^temporal version 1\.10\.0\b/);
    ensureOpen();
    await run("docker", ["run", "--rm", "--name", db, "-d", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=birbcrew_ts",
      "-p", "127.0.0.1::5432", "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, signal: controller.signal, timeout: 30_000, killSignal: "SIGKILL" });
    await databaseReady();
    ensureOpen();
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address === "object");
    env.BIRBCREW_TEMPORAL_ADDRESS = "127.0.0.1:" + address.port;
    await new Promise<void>((done) => probe.close(() => done()));
    ensureOpen();
    return { env, signal: controller.signal, sql, worker, child, execute, gateway, directory, artifacts, startTemporal, close,
      restartDatabase: async () => { ensureOpen(); await run("docker", ["restart", db], { timeout: 30_000, killSignal: "SIGKILL", signal: controller.signal }); await databaseReady(); } };
  } catch (error) { await close({ kind: "failed", error }); throw error; }
}
export type Services = Awaited<ReturnType<typeof services>>;
export async function withServices(options: { label: string; engine?: Engine }, proof: (s: Services) => Promise<void>) {
  const s = await services(options.engine, options.label);
  try { await proof(s); }
  catch (error) { await s.close({ kind: "failed", error }); throw error; }
  await s.close();
}
