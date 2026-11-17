import { spawnHistoricalMember, testDatabaseName } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { MemberClient } from "../../src/service/client.ts";
import { ownerInitiator, type Engine } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import type { Clock } from "../../src/service/routines.ts";
import { MemberStore } from "../../src/service/store.ts";
import type { Launch } from "../../src/service/supervisor.ts";
import { recordSegmentUsage } from "../../src/service/usage.ts";
import type { SegmentUsage } from "../../src/service/usage-capture.ts";
import type { PriceTable } from "../../src/service/usage-prices.ts";

// Fixtures shared by usage.test.ts and usage-cost.test.ts. Each file runs in its own process with
// its own pool, and calls store.migrate() before its tests and pool.end() after them.
const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
export const pool = new Pool({ connectionString: url });
export const store = new MemberStore(pool);
export const sql = new URL("../../src/service/sql/", import.meta.url);

/** A database migrated only up to `version`, as that release left it; dropped after the test. */
export async function databaseAt(t: TestContext, version = Infinity, skip: readonly number[] = []) {
  const name = testDatabaseName("usage_");
  await pool.query("CREATE DATABASE " + name);
  const target = new URL(url!); target.pathname = "/" + name;
  const db = new Pool({ connectionString: target.href });
  t.after(async () => { await db.end(); await pool.query("DROP DATABASE " + name); });
  if (version === Infinity) {
    await new MemberStore(db).migrate();
    return db;
  }
  await db.query("CREATE SCHEMA birbcrew_ts");
  await db.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version || skip.includes(applied)) continue;
    await db.query(await readFile(new URL(file, sql), "utf8"));
    await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return db;
}

/** Every migration number in the sql directory, in order. */
export const migrationNumbers = async () => (await readdir(sql)).map(file => Number(file.split("-")[0])).sort((a, b) => a - b);

export const reported = (input: number, output = 0, more: Partial<Extract<SegmentUsage, { state: "reported" }>> = {}): SegmentUsage => ({
  state: "reported", model: "fixture-model", inputTokens: input, outputTokens: output, cachedInputTokens: null,
  cacheWriteTokens: null, reasoningTokens: null, costUsd: null, ...more });

export async function member(db: MemberStore, ownerId = "owner-" + randomUUID(), engine: Engine = "pi") {
  const spawned = await db.spawn({ ownerId, requestId: randomUUID(), engine, profile: "fixture" });
  return { ownerId, memberId: spawned.memberId };
}
export function memberBeforeTargets(db: MemberStore, engine: Engine) {
  return spawnHistoricalMember(db, { ownerId: "owner-" + randomUUID(), requestId: randomUUID(), engine, profile: "fixture" });
}
export async function conversation(db: MemberStore, owner: { ownerId: string; memberId: string }) {
  const conversationId = randomUUID();
  await db.openConversation({ ...owner, conversationId });
  return conversationId;
}

/** Admits a request, starts its turn and reserves its native launch as the supervisor does. */
export async function launched(db: MemberStore, ownerId: string, conversationId: string, text = "hello", requestId = randomUUID()) {
  const request = { ownerId, conversationId, requestId, text };
  await db.recordAcceptance(request, ownerInitiator);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const turn = await db.beginTurn(request, execution);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") throw new Error("unreachable");
  await db.pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, turn.token, execution.workflowRunId, execution.activityId]);
  const launch: Launch = { ...request, token: turn.token, execution };
  return { request, launch, commit: () => db.commitTurn({ ownerId, conversationId, requestId, token: turn.token, reply: "done",
    checkpoint: { version: 1, engine: turn.conversation.engine, state: {} } }) };
}
/** One finished segment that reported `usage`, in a conversation of its own. */
export async function spend(db: MemberStore, owner: { ownerId: string; memberId: string }, usage?: SegmentUsage, prices: PriceTable | null = null) {
  const conversationId = await conversation(db, owner);
  const segment = await launched(db, owner.ownerId, conversationId);
  await recordSegmentUsage(db.pool, segment.launch, usage, prices);
  await segment.commit();
  return { conversationId, requestId: segment.request.requestId };
}

export async function gateway(t: TestContext, members: MemberClient, ownerId: string, clock: Clock = () => new Date()) {
  const token = randomUUID(), stranger = randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const server = createGateway(store, members, { [hash(token)]: ownerId, [hash(stranger)]: "owner-" + randomUUID() }, { clock });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  t.after(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  async function api(path: string, body?: unknown, credential: string = token, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  }
  return { api, stranger };
}
