import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { before, boundedCommand, collectFiles, CommandFailure, describe, durableLog, exitStatus, firstFailure, now, receipt, signalOwnedChild, type CommandResult } from "./member-service-diagnostics.mts";
import { disposeContainer, type ContainerAllocation } from "./member-service-container.mts";

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
export function workingState(env: NodeJS.ProcessEnv): "local" | "hosted-vm" {
  if (env.BIRBCREW_PROOF_WORKING_STATE === undefined) return "local";
  assert.equal(env.BIRBCREW_PROOF_WORKING_STATE, "github-hosted-vm", "Unknown proof working-state policy");
  assert.equal(env.GITHUB_ACTIONS, "true", "VM retention requires GitHub Actions");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "VM retention requires an ordinary GitHub-hosted runner");
  return "hosted-vm";
}
type Outcome = { kind: "passed" } | { kind: "failed"; error: unknown };
const active = new Map<object, (error: CommandFailure) => Promise<void>>();
let interruption: CommandFailure | undefined;
function interrupt(signal: "SIGINT" | "SIGTERM") {
  if (interruption) return;
  interruption = new CommandFailure("Fixture cancellation", { kind: "signalled", signal });
  const error = interruption;
  void Promise.allSettled([...active.values()].map(close => close(error))).then(results => {
    const failed = results.find(result => result.status === "rejected");
    process.exit(exitStatus(failed?.status === "rejected" ? failed.reason : error));
  });
}
const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
function activate(owner: object, cancel: (error: CommandFailure) => Promise<void>) {
  assert.ok(!interruption, "Fixture creation after cancellation");
  if (!active.size) { process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); }
  active.set(owner, cancel);
}
function deactivate(owner: object) {
  active.delete(owner);
  if (!active.size && !interruption) { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); }
}
function createFixture(selected?: Engine, label = basename(process.argv[1] ?? "service", ".mts")) {
  assert.ok(!interruption, "Fixture creation after cancellation");
  assert.match(label, /^[a-zA-Z0-9-]+$/);
  const policy = workingState(process.env);
  const root = process.env.BIRBCREW_PROOF_ARTIFACTS ?? join(tmpdir(), "crew-service-proofs");
  assert.ok(isAbsolute(root), "BIRBCREW_PROOF_ARTIFACTS must be absolute");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const artifacts = mkdtempSync(join(root, label + "-"));
  const directory = mkdtempSync(join(tmpdir(), "birb-members-"));
  writeFileSync(join(artifacts, "working-state.json"), JSON.stringify({ directory, workingState: policy }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: directory, BIRBCREW_STATE_DIR: join(directory, "native"),
    BIRBCREW_PROOF_LOG_DIR: artifacts,
    BIRBCREW_PROOF_STREAM_DIR: directory, BIRBCREW_PROOF_REQUESTS: join(directory, "requests.jsonl"),
    BIRBCREW_PROOF_CODEX_REQUESTS: join(directory, "codex-results.jsonl"),
    BIRBCREW_PROOF_NOTES: join(directory, "note-evidence.jsonl"),
    ...(selected && { BIRBCREW_PROOF_ENGINE: selected }),
  };
  const temporal = process.env.TEMPORAL_CLI ?? "temporal";
  const db = "birb-proof-" + randomUUID(), password = randomBytes(24).toString("hex");
  const controller = new AbortController();
  const processes: { stop: (deadline?: number) => Promise<void>; pid: number | undefined }[] = [];
  const logs = new Map<string, ReturnType<typeof durableLog>>();
  const failures: unknown[] = [];
  let state: { kind: "open" } | { kind: "closing"; done: Promise<void>; deadline: number } = { kind: "open" };
  let first: Outcome | undefined;
  let allocation: ContainerAllocation = { kind: "not-started" };
  let pendingAllocation: Promise<void> | undefined;
  let gatewayNumber = 0;
  function ensureOpen() { assert.equal(state.kind, "open", "Fixture is closing"); }
  function start(program: string, args: string[], options: NodeJS.ProcessEnv, log: string, echo = false) {
    ensureOpen();
    assert.match(log, /^(?:worker|coordinated-worker|temporal|observation|(?:observer-)?gateway(?:-\d+)?)\.log$/);
    let sink = logs.get(log);
    if (!sink) {
      sink = durableLog(join(artifacts, log), log === "observation.log" ? 8 * 1024 * 1024 : 1024 * 1024);
      logs.set(log, sink);
      symlinkSync(join(artifacts, log), join(directory, log));
    }
    const output = sink;
    const proc = spawn(program, args, { env: options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("error", error => failures.push(error));
    proc.stderr.on("error", error => failures.push(error));
    const result = new Promise<CommandResult>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => resolve(signal ? { kind: "signalled", signal } : { kind: "exited", code: code ?? 1 }));
    });
    void result.catch(() => {});
    const closed = new Promise<void>(resolve => proc.once("close", () => resolve()));
    let echoed = 0;
    const drain = (chunk: Buffer) => {
      output.append(chunk);
      if (echo && echoed < 8 * 1024 * 1024) {
        const keep = chunk.subarray(0, 8 * 1024 * 1024 - echoed);
        echoed += keep.length;
        process.stdout.write(keep);
      }
    };
    proc.stdout.on("data", drain); proc.stderr.on("data", drain);
    async function stop(deadline = state.kind === "closing" ? state.deadline - 2_800 : now() + 3_000) {
      try {
        signalOwnedChild(proc, "SIGKILL");
        await before(result, deadline, "Owned child exit");
        await before(closed, deadline, "Owned child streams");
      } finally { proc.stdout.destroy(); proc.stderr.destroy(); proc.unref(); }
    }
    processes.push({ stop, pid: proc.pid });
    return { stop, result };
  }
  async function child(program: string, args: string[], options = env, log = "worker.log") {
    return start(program, args, options, log).stop;
  }
  async function execute(program: string, args: string[]) {
    const proc = start(program, args, env, "observation.log", true);
    const result = await proc.result;
    if (result.kind !== "exited" || result.code !== 0) throw new CommandFailure(program, result);
    await proc.stop();
  }
  async function gateway(configuration: string, options = env) {
    const log = `gateway-${++gatewayNumber}.log`;
    const proc = start(process.execPath, ["src/service/gateway.ts", configuration], options, log);
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
  function finish(outcome: Outcome): Promise<void> {
    if (!first || (first.kind === "passed" && outcome.kind === "failed")) {
      first = outcome;
      if (outcome.kind === "failed") {
        try { firstFailure(join(artifacts, "first-failure.txt"), outcome.error); } catch (error) { failures.push(error); }
      }
    }
    return close();
  }
  function close(): Promise<void> {
    if (state.kind === "closing") return state.done;
    const deadline = now() + 5_900;
    const done = Promise.resolve().then(async () => {
      const stopped: number[] = [];
      let container: "disposed" | "not-started" | "unknown" = "unknown";
      let directoryState: "retained" | "removed" = "retained";
      const attempt = async (operation: () => Promise<unknown>) => {
        try { await operation(); } catch (error) { failures.push(error); }
      };
      controller.abort();
      try {
        await Promise.all([
          ...processes.map(proc => attempt(async () => {
            await proc.stop(deadline - 2_800);
            if (proc.pid) stopped.push(proc.pid);
          })),
          ...(pendingAllocation ? [attempt(() => before(pendingAllocation!, deadline - 2_800, "Docker allocation settlement"))] : []),
          attempt(() => before(collectFiles(directory, join(artifacts, "snapshot")), deadline - 2_800, "Fixture snapshot")),
        ]);
        await attempt(async () => {
          await disposeContainer({ container: db, allocation }, deadline - 400);
          container = allocation.kind === "not-started" ? "not-started" : "disposed";
        });
        const logReports: Record<string, unknown> = {};
        for (const [name, log] of logs) {
          try { logReports[name] = log.close(); } catch (error) { failures.push(error); }
        }
        if (policy === "local") await attempt(async () => {
          assert.equal(stopped.length, processes.filter(proc => proc.pid !== undefined).length, "Known child stop failed; private state retained");
          assert.notEqual(container, "unknown", "Container disposal unresolved; private state retained");
          await before(rm(directory, { recursive: true, force: true }), deadline - 300, "Local fixture directory removal");
          directoryState = "removed";
        });
        if (first?.kind !== "failed" && failures.length) first = { kind: "failed", error: new AggregateError(failures, "Fixture diagnostics or disposal failed") };
        if (first?.kind === "failed") {
          try { firstFailure(join(artifacts, "first-failure.txt"), first.error); } catch (error) { failures.push(error); }
        }
        await attempt(() => receipt(join(artifacts, "cleanup.json"), { container, directory: directoryState, workingState: policy,
          knownChildrenStopped: stopped, ancestry: "unproven", logs: logReports, failures: failures.map(describe),
          outcome: first?.kind === "failed" ? { kind: "failed", error: describe(first.error), status: exitStatus(first.error) } : { kind: "passed" } }, deadline));
      } finally { deactivate(owner); }
      if (first?.kind === "failed") throw first.error;
      if (failures.length) throw new AggregateError(failures, "Fixture diagnostics or disposal failed");
    });
    state = { kind: "closing", done, deadline };
    return done;
  }
  async function databaseReady() {
    await until(async () => {
      ensureOpen();
      try { await run("docker", ["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { timeout: 2_000, killSignal: "SIGKILL", signal: controller.signal }); return true; }
      catch { return undefined; }
    }, "PostgreSQL");
    const { stdout } = await run("docker", ["port", db, "5432/tcp"], { timeout: 2_000, killSignal: "SIGKILL", signal: controller.signal });
    const port = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1];
    assert.ok(port, "Expected a loopback-only PostgreSQL port");
    const databaseHost = process.env.BIRBCREW_PROOF_DATABASE_HOST ?? "127.0.0.1";
    assert.ok(["127.0.0.1","host.docker.internal"].includes(databaseHost),"Use the local Docker host for fixture PostgreSQL");
    env.BIRBCREW_DATABASE_URL = env.BIRBCREW_TEST_DATABASE_URL = "postgres://postgres:" + password + "@" + databaseHost + ":" + port + "/birbcrew_ts";
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
      try { await run(temporal, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"], { env, timeout: 2_000, killSignal: "SIGKILL", signal: controller.signal }); return true; }
      catch { return undefined; }
    }, "Temporal");
    return stop;
  }
  async function openFixture() {
    const cliVersion = await run(temporal, ["--version"], { timeout: 5_000, killSignal: "SIGKILL", signal: controller.signal });
    assert.match(cliVersion.stdout, /^temporal version 1\.10\.0\b/);
    ensureOpen();
    allocation = { kind: "pending" };
    pendingAllocation = (async () => {
      const result = await boundedCommand("docker", ["run", "--rm", "--name", db, "--label", "birb-proof-owner=" + db, "-d", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=birbcrew_ts",
        "-p", "127.0.0.1::5432", "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"],
        now() + 30_000, { env: { ...process.env, POSTGRES_PASSWORD: password }, signal: controller.signal });
      assert.ok(result.stdout.kind === "complete", "Docker allocation stdout was truncated");
      allocation = { kind: "settled", container: z.string().regex(/^[a-f0-9]{64}$/).parse(result.stdout.text.trim()) };
    })();
    await pendingAllocation;
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
      restartDatabase: async () => { ensureOpen(); await run("docker", ["restart", db], { timeout: 30_000, signal: controller.signal, killSignal: "SIGKILL" }); await databaseReady(); } };
  }
  const owner = { open: openFixture, close, finish };
  return owner;
}
export async function services(selected?: Engine, label?: string) {
  const owner = createFixture(selected, label);
  activate(owner, error => owner.finish({ kind: "failed", error }));
  try { return await owner.open(); }
  catch (error) { await owner.finish({ kind: "failed", error }); throw error; }
}
export type ServiceHandle = Awaited<ReturnType<typeof services>>;
export type Services = Omit<ServiceHandle, "close">;
export async function withServices(options: { label: string; engine?: Engine }, proof: (s: Services) => Promise<void>) {
  const owner = createFixture(options.engine, options.label);
  activate(owner, error => owner.finish({ kind: "failed", error }));
  let outcome: Outcome = { kind: "passed" };
  try {
    const { close: _close, ...context } = await owner.open();
    await proof(context);
  } catch (error) { outcome = { kind: "failed", error }; }
  await owner.finish(outcome);
}
