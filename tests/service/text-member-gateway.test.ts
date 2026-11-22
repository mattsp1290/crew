import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { MemberClient } from "../../src/service/client.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { MemberStore } from "../../src/service/store.ts";
import { temporalSettings } from "../../src/service/temporal-config.ts";

const database = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!database) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");

const reply = "cedar remembered";

function profileModule(log: string, cwd: string) {
  return `import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(log)};
const cwd = ${JSON.stringify(cwd)};
const executable = ${JSON.stringify(join(cwd, "opencode"))};
function send(sink, value) { sink(Buffer.from(JSON.stringify(value) + "\\n")); }
function acp() {
  let sink;
  let resolveExit = () => {};
  const processExit = new Promise((resolve) => { resolveExit = resolve; });
  function respond(message) {
    if (message.method === "initialize") send(sink, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    else if (message.method === "session/new") send(sink, { jsonrpc: "2.0", id: message.id, result: {
      sessionId: "session-1", configOptions: [{ id: "model", type: "select", currentValue: "default", options: [] }] } });
    else if (message.method === "session/set_config_option") send(sink, { jsonrpc: "2.0", id: message.id, result: {
      configOptions: [{ id: "model", currentValue: message.params.value }] } });
    else if (message.method === "session/prompt") {
      send(sink, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
        sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "cedar remembered" } } } });
      send(sink, { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: {} } });
    } else if (message.method === "session/close") send(sink, { jsonrpc: "2.0", id: message.id, result: {} });
  }
  return { processExit, channel: {
    listen(next) { sink = next; return () => {}; },
    write(frame) {
      for (const line of Buffer.from(frame).toString("utf8").split("\\n")) if (line) respond(JSON.parse(line));
      return Promise.resolve();
    },
    endInput() { sink.ended(); resolveExit(); },
  } };
}
export const profiles = new Map([
  [${JSON.stringify("text-cursor.v1")}, {
    accountId: "text fixture",
    cursor: { model: "composer-2", apiKey: "cursor-secret", cwd, runtime() {
      appendFileSync(log, "start\\n");
      return { async start({ onEvent }) {
        onEvent({ kind: "text", text: "cedar " });
        onEvent({ kind: "text", text: ${JSON.stringify(reply)} });
        onEvent({ kind: "ended", outcome: "completed" });
        return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
      }, async close() {} };
    } },
  }],
  [${JSON.stringify("text-opencode.v1")}, {
    accountId: "text fixture",
    opencode: { model: "provider/model", executable, cwd, account: "ACCOUNT LABEL", env: { OPENCODE_TOKEN: "kept" },
      spawn(request) {
        appendFileSync(log, "spawn\\n");
        if (JSON.stringify(request.env) !== JSON.stringify({ OPENCODE_TOKEN: "kept" })) throw new Error("environment");
        if (JSON.stringify(request.args) !== JSON.stringify([executable, "acp"])) throw new Error("argv");
        return acp();
      } },
  }],
]);
export function close() {}
`;
}

async function until(label: string, check: () => Promise<boolean>) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > 30_000) throw new Error(label);
    await delay(100);
  }
}

test("cursor and opencode each commit one text turn and refuse a second launch", { timeout: 120_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "text-gateway-")));
  const cwd = root;
  const log = join(root, "launches.log");
  const heartbeat = join(root, "heartbeat");
  const config = join(root, "profiles.mjs");
  await writeFile(log, "");
  await writeFile(config, profileModule(log, cwd));
  const pool = new Pool({ connectionString: database });
  const store = new MemberStore(pool);
  await store.migrate();
  const connection = await Connection.connect({ address: temporalSettings(process.env).address });
  const temporal = new Client({ connection, namespace: temporalSettings(process.env).namespace });
  const token = randomUUID();
  const ownerId = randomUUID();
  const members = new MemberClient(store, temporal);
  const server = createGateway(store, members, { [createHash("sha256").update(token).digest("hex")]: ownerId });
  const stderr: Buffer[] = [];
  const worker = spawn(process.execPath, ["src/service/cli.ts", "worker", config], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, BIRBCREW_DATABASE_URL: database, BIRBCREW_STATE_DIR: join(root, "state"), BIRBCREW_TEXT_ENGINE_LOG: log,
      BIRBCREW_WORKER_HEARTBEAT_FILE: heartbeat },
    stdio: ["ignore", "ignore", "pipe"],
  });
  worker.stderr?.on("data", (chunk) => stderr.push(chunk));
  t.after(async () => {
    if (worker.exitCode === null && !worker.signalCode) worker.kill("SIGKILL");
    server.close();
    await server.stopped();
    await connection.close();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  await until("worker heartbeat", async () => {
    try { return (await readFile(heartbeat, "utf8")) !== undefined; }
    catch { return false; }
  }).catch((error: Error) => { throw new Error(`${error.message}\n${Buffer.concat(stderr).toString("utf8")}`); });

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }
  async function count(kind: string) {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line === kind).length;
  }

  for (const engine of ["cursor", "opencode"] as const) {
    const kind = engine === "cursor" ? "start" : "spawn";
    const before = await count(kind);
    const profile = engine === "cursor" ? "text-cursor.v1" : "text-opencode.v1";
    const created = await call("POST", "/members", { requestId: randomUUID(), engine, profile });
    assert.equal(created.status, 201);
    const memberId = (created.payload as { memberId: string }).memberId;
    const conversationId = randomUUID();
    const opened = await call("POST", "/conversations", { memberId, conversationId });
    assert.equal(opened.status, 201);
    const { rows: [limit] } = await pool.query<{ turn_limit: number }>("SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id = $1", [conversationId]);
    assert.equal(limit.turn_limit, 1);
    const requestId = randomUUID();
    const submitted = await call("POST", `/conversations/${conversationId}/inputs`, { requestId, text: "remember cedar" });
    assert.equal(submitted.status, 202);
    assert.deepEqual(submitted.payload, { requestId });
    await until(`${engine} committed`, async () => {
      const status = await call("GET", `/conversations/${conversationId}/requests/${requestId}`);
      return status.status === 200 && (status.payload as { phase?: string; reply?: string }).phase === "committed"
        && (status.payload as { reply?: string }).reply === reply;
    });
    assert.equal(await count(kind), before + 1);
    const replay = await call("POST", `/conversations/${conversationId}/inputs`, { requestId, text: "remember cedar" });
    assert.equal(replay.status, 202);
    const again = await call("GET", `/conversations/${conversationId}/requests/${requestId}`);
    assert.equal((again.payload as { reply?: string }).reply, reply);
    assert.equal(await count(kind), before + 1);
    const blocked = randomUUID();
    const rejected = await call("POST", `/conversations/${conversationId}/inputs`, { requestId: blocked, text: "another" });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.payload, { error: "input_limit" });
    assert.equal(await count(kind), before + 1);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id = $1 AND request_id = $2", [conversationId, blocked])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.usage_ledger WHERE conversation_id = $1", [conversationId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.tool_previews WHERE conversation_id = $1", [conversationId])).rowCount, 0);
    const snapshot = await call("GET", `/conversations/${conversationId}`);
    assert.deepEqual((snapshot.payload as { state: { pendingApprovals: unknown[] } }).state.pendingApprovals, []);

    const other = randomUUID();
    const openedOther = await call("POST", "/conversations", { memberId, conversationId: other });
    assert.equal(openedOther.status, 201);
    const left = randomUUID();
    const right = randomUUID();
    const pair = await Promise.all([
      call("POST", `/conversations/${other}/inputs`, { requestId: left, text: "remember cedar" }),
      call("POST", `/conversations/${other}/inputs`, { requestId: right, text: "remember cedar" }),
    ]);
    const statuses = pair.map((entry) => entry.status).sort();
    assert.deepEqual(statuses, [202, 409]);
    const winner = pair.find((entry) => entry.status === 202);
    const loser = pair.find((entry) => entry.status === 409);
    assert.deepEqual(loser?.payload, { error: "input_limit" });
    const winnerId = (winner?.payload as { requestId: string }).requestId;
    await until(`${engine} concurrent committed`, async () => {
      const status = await call("GET", `/conversations/${other}/requests/${winnerId}`);
      return (status.payload as { phase?: string; reply?: string }).phase === "committed"
        && (status.payload as { reply?: string }).reply === reply;
    });
    assert.equal(await count(kind), before + 2);
    const described = await temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${other}`).describe();
    assert.notEqual(described.status.name, "FAILED");
    if (engine === "cursor") {
      const submitConversation = randomUUID();
      assert.equal((await call("POST", "/conversations", { memberId, conversationId: submitConversation })).status, 201);
      const left = randomUUID();
      const right = randomUUID();
      const submits = await Promise.allSettled([
        members.submit({ ownerId, conversationId: submitConversation, requestId: left, text: "remember cedar" }),
        members.submit({ ownerId, conversationId: submitConversation, requestId: right, text: "remember cedar" }),
      ]);
      const fulfilled = submits.filter((entry) => entry.status === "fulfilled");
      const rejectedSubmit = submits.find((entry) => entry.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(fulfilled[0].status === "fulfilled" && fulfilled[0].value, reply);
      assert.equal(rejectedSubmit?.status, "rejected");
      assert.equal(rejectedSubmit.reason.code, "input_limit");
      const submitHandle = temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${submitConversation}`);
      const submitWorkflow = await submitHandle.describe();
      assert.notEqual(submitWorkflow.status.name, "FAILED");
      await Worker.runReplayHistory(
        { workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)) },
        await submitHandle.fetchHistory(),
        submitHandle.workflowId,
      );
      assert.notEqual((await submitHandle.describe()).status.name, "FAILED");
    }
  }
});
