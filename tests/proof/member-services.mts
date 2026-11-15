import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { before, boundedCommand, captureDiagnostics, CommandFailure, describe, exitStatus, now, receipt, stopGroup, type CommandResult } from "./member-service-diagnostics.mts";

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
type OwnedProcess = { pid: number; identity: { kind: "pending" } | { kind: "known"; group: number; startTime: string }; result: Promise<CommandResult>; stop: (deadline?: number) => Promise<void>; log: string };

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
  let state: { kind: "open" } | { kind: "closing"; done: Promise<void>; deadline: number } = { kind: "open" };
  let first: Outcome | undefined;
  let proof: Promise<void> | undefined;
  let allocation: ReturnType<typeof boundedCommand> | undefined;
  let allocationState: { kind: "not-started" } | { kind: "pending" } | { kind: "settled"; container: string } = { kind: "not-started" };
  let gatewayNumber = 0;
  const failures: unknown[] = [];
  function publishOwnership() {
    const path = join(artifacts, "ownership.json");
    writeFileSync(path + ".tmp", JSON.stringify({ label, directory, container: db, allocation: allocationState,
      processes: processes.map(({ pid, identity, log }) => ({ pid, identity, log })) }), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  writeFileSync(join(directory, ".fixture-owner"), db, { mode: 0o600 });
  publishOwnership();
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
      function stop(deadline = state.kind === "closing" ? state.deadline - 2_800 : now() + 3_000) {
        return stopped ??= (async () => {
          await stopGroup(pid, deadline);
          await before(result, deadline, `Owned process ${pid} exit`);
        })();
      }
      owned = { pid, identity: { kind: "pending" }, result, stop, log };
      processes.push(owned);
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parts = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      const group = Number(parts[2]), startTime = parts[19];
      assert.equal(group, pid, "Owned child must lead its detached process group");
      assert.ok(startTime && /^\d+$/.test(startTime), "Owned child has no start identity");
      owned.identity = { kind: "known", group, startTime };
      publishOwnership();
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
  async function gateway(configuration: string, options = env) {
    const log = `gateway-${++gatewayNumber}.log`;
    const proc = await start(process.execPath, ["src/service/gateway.ts", configuration], options, log);
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
      if (outcome.kind === "failed") console.error(`${label} first failure: ${describe(outcome.error)}`);
    }
    return close();
  }
  async function persistFailure(deadline: number) {
    if (first?.kind === "failed") await receipt(join(artifacts, "first-failure.txt"), describe(first.error), deadline);
  }
  function close(): Promise<void> {
    if (state.kind === "closing") return state.done;
    const deadline = now() + 5_900;
    const done = Promise.resolve().then(async () => {
      type Absence = "absent" | "unknown";
      const resources: { container: Absence; directory: Absence; processes: { pid: number; status: Absence }[] } = {
        container: "unknown", directory: "unknown", processes: processes.map(({ pid }) => ({ pid, status: "unknown" })),
      };
      const attempt = async (operation: () => Promise<unknown>) => {
        try { await operation(); } catch (error) { failures.push(error); console.error(`${label} secondary failure: ${describe(error)}`); }
      };
      const pendingProof = proof, pendingAllocation = allocation;
      controller.abort();
      try {
        await Promise.all([
          attempt(async () => publishOwnership()),
          attempt(() => persistFailure(deadline - 4_900)),
        ]);
        await Promise.all([
          ...(first ? [attempt(() => captureDiagnostics(directory, artifacts, db, deadline - 2_800))] : []),
          ...processes.map((proc, index) => attempt(async () => {
            await proc.stop(deadline - 2_800);
            resources.processes[index].status = "absent";
          })),
          ...(pendingProof ? [attempt(() => before(pendingProof.catch(() => {}), deadline - 2_800, "Proof callback disposal"))] : []),
          ...(pendingAllocation ? [attempt(() => before(pendingAllocation, deadline - 2_800, "Docker allocation settlement"))] : []),
        ]);
        await Promise.all([
          attempt(async () => {
            await boundedCommand("docker", ["rm", "-f", db], deadline - 1_200);
            const { output } = await boundedCommand("docker", ["ps", "-aq", "--filter", "name=^/" + db + "$"], deadline - 700);
            assert.equal(output.trim(), "", "Owned PostgreSQL container remained after removal");
            assert.notEqual(allocationState.kind, "pending", "Docker allocation was interrupted; daemon allocation completion unknown");
            resources.container = "absent";
          }),
          attempt(async () => {
            await boundedCommand(process.execPath, ["--input-type=module", "-e",
              "import {readdirSync,unlinkSync,rmdirSync} from 'node:fs';import {join} from 'node:path';import {execFileSync} from 'node:child_process';" +
              "const root=process.argv[1],marker=join(root,'.fixture-owner'),entries=readdirSync(root).filter(name=>name!=='.fixture-owner').map(name=>join(root,name));" +
              "if(entries.length)execFileSync('rm',['-rf','--',...entries],{stdio:'inherit'});unlinkSync(marker);rmdirSync(root)", directory], deadline - 800);
            await boundedCommand(process.execPath, ["--input-type=module", "-e",
              "import {lstatSync} from 'node:fs';try{lstatSync(process.argv[1]);process.exitCode=1}catch(e){if(e.code!=='ENOENT')throw e}", directory], deadline - 700);
            resources.directory = "absent";
          }),
        ]);
        for (let written: Outcome | undefined, again = true; again;) {
          written = first;
          await attempt(() => persistFailure(deadline - 350));
          await attempt(() => receipt(join(artifacts, "cleanup.json"), { failures: failures.map(describe), resources,
            ...(first ? { outcome: first.kind === "failed" ? { kind: "failed", error: describe(first.error), status: exitStatus(first.error) } : first } : {}) }, deadline));
          again = written !== first && now() < deadline;
        }
      } finally { deactivate(owner); }
      if (first?.kind === "failed") throw first.error;
      if (failures.length) throw new AggregateError(failures, "Fixture capture or cleanup failed");
    });
    state = { kind: "closing", done, deadline };
    return done;
  }
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
  async function openFixture() {
    const cliVersion = await run(temporal, ["--version"], { timeout: 5_000, killSignal: "SIGKILL" });
    assert.match(cliVersion.stdout, /^temporal version 1\.10\.0\b/);
    ensureOpen();
    allocationState = { kind: "pending" };
    publishOwnership();
    allocation = boundedCommand("docker", ["run", "--rm", "--name", db, "--label", "birb-proof-owner=" + db, "-d", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=birbcrew_ts",
      "-p", "127.0.0.1::5432", "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"],
      now() + 30_000, { env: { ...process.env, POSTGRES_PASSWORD: password }, signal: controller.signal });
    const allocated = await allocation;
    allocationState = { kind: "settled", container: z.string().regex(/^[a-f0-9]{64}$/).parse(allocated.output.trim()) };
    publishOwnership();
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
  }
  const owner = { open: openFixture, close, finish, observe: (pending: Promise<void>) => { proof = pending; } };
  return owner;
}
export async function services(selected?: Engine, label?: string) {
  const owner = createFixture(selected, label);
  activate(owner, async error => {
    try { await owner.close(); } finally { throw error; }
  });
  try { return await owner.open(); }
  catch (error) {
    try { await owner.close(); } catch (cleanup) { console.error("Fixture startup cleanup also failed", describe(cleanup)); }
    throw error;
  }
}
export type ServiceHandle = Awaited<ReturnType<typeof services>>;
export type Services = Omit<ServiceHandle, "close">;
export async function withServices(options: { label: string; engine?: Engine }, proof: (s: Services) => Promise<void>) {
  const owner = createFixture(options.engine, options.label);
  activate(owner, error => owner.finish({ kind: "failed", error }));
  let outcome: Outcome = { kind: "passed" };
  try {
    const { close: _close, ...context } = await owner.open();
    const pending = Promise.resolve().then(() => proof(context));
    owner.observe(pending);
    await pending;
  } catch (error) { outcome = { kind: "failed", error }; }
  await owner.finish(outcome);
}
