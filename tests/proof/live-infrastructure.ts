import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Message } from "@ag-ui/core";
import { Pool } from "pg";
import type { openRelay } from "./live-relay.ts";
import type { LiveAccount } from "./live-account.ts";

const run = promisify(execFile);
export const root = fileURLToPath(new URL("../../", import.meta.url));
const postgres = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const nodeImage = "node@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496";
export async function until<T>(check: () => Promise<T | undefined>, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const value = await check();
    if (value !== undefined) return value;
    await delay(150, undefined, { signal });
  }
}

export async function proofInfrastructure(account: LiveAccount, relay: Awaited<ReturnType<typeof openRelay>>, signal: AbortSignal, cleanup: (() => Promise<unknown>)[]) {
  if (process.version !== "v24.22.3") throw new Error("Use pinned Node 24.22.3");
  const temp = await mkdtemp(join(tmpdir(), "birb-live-"));
  cleanup.push(() => rm(temp, { recursive: true, force: true }));
  const native = join(temp, "native");
  await mkdir(native, { mode: 0o700 });
  const base = { PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"), HOME: temp, DD_INJECTION_ENABLED: "false", DD_TRACE_ENABLED: "false", DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false" };
  const docker = async (args: string[], extra: Record<string, string> = {}) =>
    (await run("docker", args, { cwd: root, env: { ...base, ...extra }, timeout: 120_000 })).stdout.trim();
  const mount = (source: string, target: string, writable = false) =>
    ["--mount", ["type=bind", "source=" + source, "target=" + target, ...(writable ? [] : ["readonly"])]
      .map(field => '"' + field.replaceAll('"', '""') + '"').join(",")];
  const uid = process.getuid!() + ":" + process.getgid!();
  const build = join(temp, "build");
  await mkdir(build, { mode: 0o700 });
  await docker(["run", "--rm", "--network", "none", "--user", uid, "-w", "/app",
    ...mount(join(root, "scripts/build-native"), "/app/scripts/build-native"),
    ...mount(join(root, "native/member-launch.c"), "/app/native/member-launch.c"),
    ...mount(build, "/app/.proof", true), nodeImage, "scripts/build-native"]);
  const dbName = "birb-live-db-" + randomUUID();
  const password = randomBytes(32).toString("hex");
  await docker(["run", "--rm", "-d", "--name", dbName, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD", postgres], { POSTGRES_PASSWORD: password });
  cleanup.push(() => docker(["rm", "-f", dbName]));
  const binding = await docker(["port", dbName, "5432/tcp"]);
  const url = "postgres://postgres:" + password + "@" + binding + "/postgres";
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
  cleanup.push(() => pool.end());
  await until(async () => pool.query("SELECT 1").then(() => true, () => undefined), signal);
  const picker = createServer().listen(0, "127.0.0.1");
  await once(picker, "listening");
  const selected = picker.address();
  if (!selected || typeof selected === "string") throw new Error("Failed to reserve Temporal port");
  await new Promise<void>((resolve) => picker.close(() => resolve()));
  const address = "127.0.0.1:" + selected.port;
  const temporal = process.env.TEMPORAL_CLI ?? join(root, ".proof/bin/temporal");
  const service = (executable: string, args: string[], env: NodeJS.ProcessEnv, stdout: "ignore" | "pipe") => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ["ignore", stdout, "ignore"] });
    const exit = new Promise<void>((resolve) => { child.once("error", () => resolve()); child.once("exit", () => resolve()); });
    cleanup.push(async () => { child.kill("SIGKILL"); await exit; });
    return { child, exit };
  };
  const temporalProc = service(temporal, ["server", "start-dev", "--headless", "--port", String(selected.port),
    "--db-filename", join(temp, "temporal.db")], base, "ignore");
  await until(async () => {
    if (temporalProc.child.exitCode !== null) throw new Error("Temporal startup failed");
    return run(temporal, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"],
      { env: base, timeout: 2500 }).then(() => true, () => undefined);
  }, signal);
  const durable = { BIRBCREW_DATABASE_URL: url, BIRBCREW_TEMPORAL_ADDRESS: address };
  const bearer = randomBytes(32).toString("hex");
  const config = join(temp, "gateway.json");
  await writeFile(config, JSON.stringify({ port: 0, tokenHashes: { [createHash("sha256").update(bearer).digest("hex")]: randomUUID() } }), { mode: 0o600 });
  const gateway = service(process.execPath, ["src/service/gateway.ts", config], { ...base, ...durable }, "pipe");
  const lines = createInterface({ input: gateway.child.stdout! });
  let gatewayUrl: string;
  try {
    const value = await Promise.race([once(lines, "line", { signal }), gateway.exit.then(() => { throw new Error("Gateway startup failed"); })]);
    gatewayUrl = JSON.parse(value[0]).url;
  } finally { lines.close(); }

  const observerConfig = join(temp, "observer.json");
  await writeFile(observerConfig, JSON.stringify({ url: gatewayUrl, tokens: { owner: bearer } }), { mode: 0o600 });
  function observe(cid: string) {
    const log = join(temp, "observer-" + randomUUID() + ".jsonl");
    const observer = service(process.execPath, ["clients/observe.mjs", observerConfig, cid, log], base, "ignore");
    const check = () => {
      if (observer.child.exitCode !== null || observer.child.signalCode !== null) throw new Error("Observation process exited");
    };
    return {
      async messages(): Promise<Message[]> {
        check();
        try { return JSON.parse(await readFile(log + ".messages.json", "utf8")); }
        catch (error) {
          if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return [];
          throw error;
        }
      },
      async sawPending(id: string) {
        check();
        const text = await readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        return text.split("\n").slice(0, -1).some(line => {
          const frame = JSON.parse(line);
          return frame.type === "STATE_SNAPSHOT" && frame.snapshot.pendingApprovals?.some((p: { approvalId: string }) => p.approvalId === id);
        });
      },
    };
  }
  const worker = "birb-live-worker-" + randomUUID();
  let running = false;
  const stop = async () => { if (running) { await docker(["rm", "-f", worker]); running = false; } };
  cleanup.push(stop);
  const start = async () => {
    const env = { ...durable, DD_INJECTION_ENABLED: "false", DD_TRACE_ENABLED: "false", DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false", BIRBCREW_STATE_DIR: "/state", BIRBCREW_LIVE_ENGINE: account.engine, BIRBCREW_LIVE_AUTH: account.auth, BIRBCREW_LIVE_PROFILES: account.liveProfiles, BIRBCREW_LIVE_RELAY: relay.url, BIRBCREW_LIVE_TOKEN: relay.workerKey };
    const id = await docker(["run", "-d", "--name", worker, "--log-driver", "none", "--network", "host", "--read-only", "--init",
      "--user", uid, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777", "-e", "HOME=/tmp", "-w", "/app",
      ...Object.keys(env).flatMap((key) => ["-e", key]),
      ...["src/service", "node_modules", "package.json", "tests/proof/live-profiles.ts",
        "tests/proof/live-account.ts"].flatMap((path) => mount(join(root, path), "/app/" + path)),
      ...mount(join(build, "bin/member-launch"), "/app/.proof/bin/member-launch"),
      ...mount(native, "/state", true),
      nodeImage, "node", "src/service/cli.ts", "worker", "tests/proof/live-profiles.ts"], env);
    running = true;
    await until(async () => {
      if (await docker(["inspect", "-f", "{{.State.Running}}", worker]) !== "true") throw new Error("Worker startup failed");
      return (await pool.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2", [account.engine, account.profile])).rowCount ? true : undefined;
    }, signal);
    return id;
  };
  const first = await start();
  return { pool, native, bearer, gatewayUrl, observe, async replaceWorker() {
    await stop();
    if (await start() === first) throw new Error("Worker container was reused");
  } };
}
