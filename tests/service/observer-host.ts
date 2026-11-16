import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HttpAgent } from "@ag-ui/client";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { createGateway } from "../../src/service/gateway.ts";
import { MemberClient } from "../../src/service/client.ts";
import { MemberStore } from "../../src/service/store.ts";
import { before, durableLog, now } from "../proof/member-service-diagnostics.mts";

export async function until<T>(tryValue: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 35_000;
  while (Date.now() < end) {
    const value = await tryValue();
    if (value !== undefined) return value;
    await delay(80);
  }
  throw new Error("Timed out awaiting observer state");
}

export function startWorker(t: TestContext, profile: string, engine: string, protectedTool: boolean | "ordinary" = false) {
  const logs = process.env.BIRBCREW_PROOF_LOG_DIR;
  const log = logs ? durableLog(join(logs, `recovery-${createHash("sha256").update(t.name).digest("hex").slice(0, 12)}-${randomUUID()}.log`)) : undefined;
  log?.append(Buffer.from(JSON.stringify({ test: t.name, profile, engine }) + "\n"));
  const child = spawn(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"], {
    env: {
      ...process.env, BIRBCREW_PROOF_RECOVERY_PROFILE: profile, BIRBCREW_PROOF_ENGINE: engine,
      ...(protectedTool === true && { BIRBCREW_PROOF_PROTECTED: "1" }),
      ...(protectedTool === "ordinary" && { BIRBCREW_PROOF_NEXT_STEP: "1" })
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => log?.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => log?.append(chunk));
  const exited = once(child, "exit");
  void exited.catch(() => {});
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const stop = async () => {
    const deadline = now() + 3_000;
    const failures: unknown[] = [];
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await before(exited, deadline, "Observer worker exit");
      await before(closed, deadline, "Observer worker streams");
    } catch (error) { failures.push(error); }
    finally {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      try { log?.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Observer worker stop failed");
  };
  t.after(stop);
  return stop;
}

export async function service(t: TestContext, external = false) {
  const db = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL, max: 1 });
  const connection = await Connection.connect({ address: process.env.BIRBCREW_TEMPORAL_ADDRESS });
  t.after(async () => { await connection.close(); await db.end(); });
  const temporal = new Client({ connection });
  const store = new MemberStore(db), members = new MemberClient(store, temporal);
  await store.migrate();
  const owner = randomUUID(), stranger = randomUUID();
  const tokens = { [createHash("sha256").update(owner).digest("hex")]: randomUUID(),
    [createHash("sha256").update(stranger).digest("hex")]: randomUUID() };
  const directory = await mkdtemp(join(tmpdir(), "birb-gateway-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "gateway.json");
  await writeFile(config, JSON.stringify({ tokenHashes: tokens, port: 0 }), { mode: 0o600 });
  async function start() {
    if (external) {
      const child = spawn(process.execPath, ["src/service/gateway.ts", config], {
        env: { ...process.env, BIRBCREW_DATABASE_URL: process.env.BIRBCREW_TEST_DATABASE_URL },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = once(child, "exit");
      const stop = async () => { child.kill("SIGKILL"); await exited; };
      t.after(stop);
      const lines = createInterface({ input: child.stdout });
      const startup = Promise.race([
        once(lines, "line").then(([line]) => JSON.parse(line).url as string),
        exited.then(() => { throw new Error("Gateway exited before listening"); }),
      ]);
      try { return { url: await startup, stop }; }
      finally { lines.close(); }
    }
    const server = createGateway(store, members, tokens);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const url = "http://127.0.0.1:" + addr.port;
    const stop = async () => {
      if (!server.listening) return;
      const finished = once(server, "close");
      server.close(); server.closeAllConnections();
      await finished;
    };
    t.after(stop);
    return { url, stop };
  }
  let server = await start();
  const api = (path: string, body?: unknown, bearer: string = owner) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function post(path: string, body: unknown) {
    const response = await api(path, body);
    assert.ok(response.ok, path + " returned " + response.status);
    return response.json();
  }
  function attach(cid: string) {
    const agent = new HttpAgent({ url: server.url + "/conversations/" + cid + "/events", threadId: cid,
      headers: { Authorization: "Bearer " + owner } });
    const events: { type: string; [key: string]: unknown }[] = [];
    // How the official client read each RUN_FINISHED: "success", "interrupt" or "cancelled".
    const outcomes: string[] = [];
    const run = agent.runAgent({}, {
      onEvent({ event }) { events.push({ ...event }); },
      onRunFinishedEvent({ outcome }) { outcomes.push(outcome); },
    });
    const done = run.then(() => undefined, (error: unknown) => error);
    t.after(() => agent.abortRun());
    return { agent, done, events, outcomes };
  }
  return { api, post, attach, temporal, stranger, ownerId: Object.values(tokens)[0], db, async restart() { await server.stop(); server = await start(); } };
}
