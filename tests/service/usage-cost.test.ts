import { migrateThrough } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { MemberClient } from "../../src/service/client.ts";
import { MemberStore } from "../../src/service/store.ts";
import { TrustedContextStore } from "../../src/service/trusted-context.ts";
import type { TrustedNativeProfile } from "../../src/service/trusted-native.ts";
import { runTrustedRequest } from "../../src/service/trusted-runner.ts";
import { recordSegmentUsage, recordTrustedUsage, UsageApi } from "../../src/service/usage.ts";
import type { PriceTable } from "../../src/service/usage-prices.ts";
import { conversation, databaseAt, gateway, launched, member, memberBeforeTargets, migrationNumbers, pool, reported, spend, sql, store } from "./usage-fixtures.ts";

// Estimated cost, the trusted-context lane's metering and migration 35 (docs/usage-metering.md).
before(() => store.migrate());
after(() => pool.end());

/** A table pricing `model` as the operator's file would, after readPrices made each rate canonical. */
const priced = (input: string, output: string, cachedInput = input, model = "fixture-model"): PriceTable =>
  new Map([[model, { input, cachedInput, cacheWrite: input, output }]]);

test("an estimated cost is written once with the rates it used, kept apart from billed cost, and never rewritten by a later price", async (t) => {
  const owner = await member(store, undefined, "claude");
  const g = await gateway(t, {} as MemberClient, owner.ownerId);
  const first = priced("2", "8", "0.5"), raised = priced("4", "16", "0.5");
  const segment = reported(1000, 100, { cachedInputTokens: 400 });
  // (600 fresh × $2 + 400 cached × $0.50 + 100 out × $8) per million tokens.
  const before = await spend(store, owner, segment, first);
  // The operator raises the price: only rows written from now on use it.
  const after = await spend(store, owner, segment, raised);
  const billed = await spend(store, owner, reported(1000, 100, { cachedInputTokens: 400, costUsd: 0.25 }), raised);
  const unpriced = await spend(store, owner, { ...segment, model: "unpriced-model" }, raised);
  const anonymous = await spend(store, owner, { ...segment, model: null }, raised);
  const silent = await spend(store, owner, undefined, raised);
  // A retried write for a launch already recorded adds nothing, whatever the table says by then.
  const retried = await launched(store, owner.ownerId, await conversation(store, owner));
  await recordSegmentUsage(pool, retried.launch, segment, first);
  await recordSegmentUsage(pool, retried.launch, segment, raised);
  await retried.commit();

  const records = new Map<string, { estimatedCostUsd: string | null; estimatePrice: unknown; costUsd: string | null }>(
    (await g.api("/v1/usage/records")).body.records.map((r: { requestId: string }) => [r.requestId, r]));
  const firstRates = { input: "2", cachedInput: "0.5", cacheWrite: "2", output: "8" };
  const view = (requestId: string) => { const r = records.get(requestId)!; return [r.costUsd, r.estimatedCostUsd, r.estimatePrice]; };
  assert.deepEqual(view(before.requestId), [null, "0.0022", firstRates]);
  assert.deepEqual(view(after.requestId), [null, "0.0042", { input: "4", cachedInput: "0.5", cacheWrite: "4", output: "16" }]);
  assert.deepEqual(view(retried.request.requestId), [null, "0.0022", firstRates]);
  assert.deepEqual(view(billed.requestId), ["0.25", null, null], "a billed segment is never estimated");
  for (const unestimated of [unpriced, anonymous, silent]) assert.deepEqual(view(unestimated.requestId), [null, null, null]);
  // A table that skipped checkedPrices, with a negative or unparsable rate, costs a segment its
  // estimate, never its counts or its result.
  const negative = await spend(store, owner, segment, priced("-1.5", "0"));
  const unparsable = await spend(store, owner, segment, priced("1e-6", "8"));
  const kept = (await pool.query(`SELECT request_id, state, input_tokens, estimated_cost_usd FROM birbcrew_ts.usage_ledger
    WHERE request_id = ANY($1::uuid[]) ORDER BY usage_id`, [[negative.requestId, unparsable.requestId]])).rows;
  assert.deepEqual(kept, [negative.requestId, unparsable.requestId].map(request_id => ({ request_id, state: "reported",
    input_tokens: 1000, estimated_cost_usd: null })));
  // An append-only ledger: no later price, and no one, rewrites an estimate.
  await assert.rejects(pool.query("UPDATE birbcrew_ts.usage_ledger SET estimated_cost_usd=0 WHERE owner_id=$1", [owner.ownerId]), { code: "23514" });

  // Billed and estimated cost are totalled apart, each with the number of segments it covers.
  const total = (await g.api("/v1/usage")).body.total;
  assert.deepEqual([total.segments, total.costUsd, total.costReportedSegments, total.estimatedCostUsd, total.costEstimatedSegments],
    [9, "0.25", 1, "0.0086", 3]);
  assert.deepEqual((await g.api("/v1/usage/members")).body.members[0].total, total);
  assert.deepEqual((await g.api("/v1/usage/conversations?memberId=" + owner.memberId)).body.conversations
    .map((c: { total: { estimatedCostUsd: string | null } }) => c.total.estimatedCostUsd).sort(),
  ["0.0022", "0.0022", "0.0042", null, null, null, null, null, null]);

  // Another owner's estimate is its own: neither owner's totals or records include the other's.
  const other = await member(store, undefined, "claude");
  const theirs = await spend(store, other, segment, raised);
  assert.deepEqual((await g.api("/v1/usage")).body.total, total);
  assert.equal(records.has(theirs.requestId), false);
  assert.ok(!(await g.api("/v1/usage/records")).body.records.some((r: { requestId: string }) => r.requestId === theirs.requestId));
  const api = new UsageApi(store);
  assert.deepEqual([(await api.summary(other.ownerId, {})).total.estimatedCostUsd, (await api.records(other.ownerId, {})).records
    .map(r => r.requestId)], ["0.0042", [theirs.requestId]]);

  // The ledger's CHECKs hold whatever writes a row.
  const target = await launched(store, owner.ownerId, await conversation(store, owner));
  const direct = (columns: Record<string, unknown>) => {
    const names = Object.keys(columns), values = Object.values(columns);
    return pool.query(`INSERT INTO birbcrew_ts.usage_ledger (owner_id,member_id,conversation_id,request_id,token,engine,${names})
      VALUES ($1,$2,$3,$4,$5,'claude',${names.map((_, i) => "$" + (i + 6))})`,
    [owner.ownerId, owner.memberId, target.request.conversationId, target.request.requestId, target.launch.token, ...values]);
  };
  const counts = { state: "reported", model: "fixture-model", input_tokens: 10, output_tokens: 1 };
  const rates = JSON.stringify(firstRates);
  for (const [why, columns] of [
    ["billed and estimated", { ...counts, cost_usd: 0.1, estimated_cost_usd: 0.1, estimate_price: rates }],
    ["an estimate without its rates", { ...counts, estimated_cost_usd: 0.1 }],
    ["rates without an estimate", { ...counts, estimate_price: rates }],
    ["rates that are not an object", { ...counts, estimated_cost_usd: 0.1, estimate_price: '"2"' }],
    ["a negative estimate", { ...counts, estimated_cost_usd: -0.1, estimate_price: rates }],
    ["an estimate with no model", { ...counts, model: null, estimated_cost_usd: 0.1, estimate_price: rates }],
    ["an estimate of nothing reported", { state: "unknown", estimated_cost_usd: 0.1, estimate_price: rates }],
  ] as const) await assert.rejects(direct(columns), { code: "23514" }, why);
  await direct({ ...counts, estimated_cost_usd: "0.000000000001", estimate_price: rates });
  await target.commit();
});

/** A trusted-context request started as runTrustedRequest starts one: its claim binds the generation and token. */
async function trustedStart(db: MemberStore, owner: { ownerId: string; memberId: string }) {
  const trusted = new TrustedContextStore(db.pool, { id: "usage-test", tools: [], async authorize() { return true; } });
  const key = { ownerId: owner.ownerId, conversationId: await conversation(db, owner) };
  await trusted.open(key, { scope: "scope", version: "v1", text: "context" });
  const requestId = randomUUID();
  await trusted.submit(key, requestId, "prompt");
  const start = await trusted.begin(key);
  assert.ok(start);
  return { trusted, key, requestId, claim: start.claim };
}

test("a trusted-context request is metered once in its own lane, as the owner's, and counts toward its member's budget", async (t) => {
  const owner = await member(store, undefined, "claude");
  const g = await gateway(t, {} as MemberClient, owner.ownerId);
  const { trusted, key, requestId, claim } = await trustedStart(store, owner);
  const usage = reported(1000, 100, { model: "claude-sonnet-4-6", cachedInputTokens: 400 });
  const prices = priced("3", "15", "0.3", "claude-sonnet-4-6");
  // Neither a stale claim nor another owner's names the run, and a repeated write adds nothing.
  await recordTrustedUsage(pool, { ...claim, token: randomUUID() }, usage, prices);
  await recordTrustedUsage(pool, { ...claim, generation: claim.generation + 1 }, usage, prices);
  await recordTrustedUsage(pool, { ...claim, ownerId: "owner-" + randomUUID() }, usage, prices);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.usage_ledger WHERE conversation_id=$1", [key.conversationId])).rowCount, 0);
  await recordTrustedUsage(pool, claim, usage, prices);
  await recordTrustedUsage(pool, claim, reported(5, 5), prices);
  await trusted.commit(claim, "reply", {});
  const { rows } = await pool.query(`SELECT token, trusted_request_id, child_id, input_tokens FROM birbcrew_ts.usage_ledger
    WHERE conversation_id=$1`, [key.conversationId]);
  assert.deepEqual(rows, [{ token: null, trusted_request_id: requestId, child_id: null, input_tokens: 1000 }]);

  // Its record names its lane and the owner, as the trusted lane's effects do in the audit trail;
  // the totals carry it in total and in their trusted part.
  const [record] = (await g.api("/v1/usage/records?conversationId=" + key.conversationId)).body.records;
  assert.deepEqual([record.lane, record.engine, record.requestId, record.initiator, record.estimatedCostUsd],
    ["trusted", "claude", requestId, { kind: "owner" }, "0.00342"]);
  const memberLane = await spend(store, owner, reported(10, 1));
  const summary = (await g.api("/v1/usage")).body;
  assert.deepEqual([summary.total.segments, summary.total.totalTokens, summary.trusted.segments, summary.trusted.totalTokens,
    summary.trusted.estimatedCostUsd, summary.routine.segments], [2, 1111, 1, 1100, "0.00342", 0]);
  assert.deepEqual((await g.api("/v1/usage/members")).body.members[0].trusted, summary.trusted);
  assert.deepEqual((await g.api("/v1/usage/records?conversationId=" + memberLane.conversationId)).body.records[0].lane, "member");

  // The budget is the member's: the trusted lane's tokens count in its window, and the member lane is
  // refused once they use it up, though the trusted lane itself is never refused by it.
  const budget = await g.api("/v1/usage/budgets/" + owner.memberId, { tokenLimit: 1111 }, undefined, "PUT");
  assert.deepEqual([budget.body.usedTokens, budget.body.admitting], [1111, false]);

  // A table built in code that the operator's file would refuse stops runTrustedRequest before it
  // claims a request, never after the request's tools have run.
  const queued = { ownerId: owner.ownerId, conversationId: await conversation(store, owner) };
  await trusted.open(queued, { scope: "scope", version: "v1", text: "context" });
  const waiting = randomUUID();
  await trusted.submit(queued, waiting, "prompt");
  await assert.rejects(runTrustedRequest(trusted, queued, { engine: "claude" } as TrustedNativeProfile, t.signal,
    priced("0.0000005", "15", "0.3", "claude-sonnet-4-6")), /invalid model entry at position 1/);
  assert.deepEqual(await trusted.result(queued, waiting), { phase: "queued", reply: null });

  // Erasing the trusted conversation keeps its row: counts and a model, never content.
  await trusted.invalidate(key, 1, { scope: "scope", version: "v2", text: "context" });
  await trusted.erase(key);
  assert.equal((await g.api("/v1/usage/records?conversationId=" + key.conversationId)).body.records.length, 1);

  // The ledger's CHECKs and keys hold whatever writes a trusted row.
  const next = await trustedStart(store, owner);
  const direct = (columns: Record<string, unknown>) => {
    const names = Object.keys(columns), values = Object.values(columns);
    return pool.query(`INSERT INTO birbcrew_ts.usage_ledger (owner_id,member_id,conversation_id,engine,state,${names})
      VALUES ($1,$2,$3,'claude','unknown',${names.map((_, i) => "$" + (i + 4))})`, [owner.ownerId, owner.memberId, next.key.conversationId, ...values]);
  };
  for (const [why, columns] of [
    ["a launch token as well", { request_id: next.requestId, trusted_request_id: next.requestId, token: randomUUID() }],
    ["neither a token nor a trusted request", { request_id: next.requestId }],
    ["another request's ID", { request_id: randomUUID(), trusted_request_id: next.requestId }],
    ["a Pi child", { request_id: next.requestId, trusted_request_id: next.requestId, child_id: randomUUID() }],
  ] as const) await assert.rejects(direct(columns), { code: "23514" }, why);
  const unknown = randomUUID();
  await assert.rejects(direct({ request_id: unknown, trusted_request_id: unknown }), { code: "23503" }, "a trusted request that does not exist");
  await direct({ request_id: next.requestId, trusted_request_id: next.requestId });
  await assert.rejects(direct({ request_id: next.requestId, trusted_request_id: next.requestId }), { code: "23505" }, "one row per trusted request");
});

test("migration 035 adds the estimate and the trusted lane without a rewrite or a scan, never queues, and leaves earlier rows unestimated", async (t) => {
  const upgraded = await databaseAt(t, 34);
  const current = new MemberStore(upgraded);
  const owner = await memberBeforeTargets(current, "claude");
  const conversationId = await conversation(current, owner);
  // A row recorded before the upgrade, as release 34 wrote it.
  const earlier = await launched(current, owner.ownerId, conversationId, "before the upgrade");
  await upgraded.query(`INSERT INTO birbcrew_ts.usage_ledger (owner_id,member_id,conversation_id,request_id,token,engine,state,model,input_tokens,output_tokens)
    VALUES ($1,$2,$3,$4,$5,'claude','reported','fixture-model',1000,100)`,
  [owner.ownerId, owner.memberId, conversationId, earlier.request.requestId, earlier.launch.token]);
  await earlier.commit();
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const file = "SELECT pg_relation_filenode('birbcrew_ts.usage_ledger') AS ledger";
    const { rows: [before] } = await db.query(file);
    await db.query(await readFile(new URL("035-usage-cost.sql", sql), "utf8"));
    assert.deepEqual((await db.query(file)).rows[0], before, "no rewrite");
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace ORDER BY 1,2`);
    // No other table, and nothing on trusted_requests stronger than the foreign key needs: SHARE ROW
    // EXCLUSIVE allows a running trusted turn's reads. The ledger's weaker entries sit under its ACCESS EXCLUSIVE.
    const modes = (relation: string) => rows.filter(row => row.relation === relation).map(row => row.mode);
    assert.deepEqual([...new Set(rows.map(row => row.relation))], ["trusted_requests", "usage_ledger"]);
    assert.deepEqual(modes("trusted_requests"), ["AccessShareLock", "ShareRowExclusiveLock"]);
    assert.ok(modes("usage_ledger").includes("AccessExclusiveLock"));
    const { rows: checks } = await db.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conrelid='birbcrew_ts.usage_ledger'::regclass AND conname ~ '^usage_ledger_(estimate|lane|trusted)' ORDER BY 1`);
    assert.deepEqual(checks, ["usage_ledger_estimate_check", "usage_ledger_estimate_price_check", "usage_ledger_lane_check",
      "usage_ledger_trusted_request_fkey"].map(name => ({ name, validated: false })), "NOT VALID: no row is scanned");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  // A ledger write in flight holds the table; the migration retries instead of queueing behind it,
  // where every later ledger write and usage read would queue behind the migration.
  const holder = await upgraded.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE birbcrew_ts.usage_ledger IN ROW EXCLUSIVE MODE");
    let migrated = false;
    const migrating = current.migrate().then(() => { migrated = true; });
    for (let i = 0; i < 10; i++) {
      await delay(30);
      const { rows: waiting } = await upgraded.query(`SELECT pid FROM pg_locks WHERE NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      assert.deepEqual(waiting, [], "the migration retries instead of queueing");
    }
    assert.equal(migrated, false);
    await holder.query("COMMIT");
    await migrating;
  } finally { holder.release(); }
  assert.deepEqual((await upgraded.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version>=34 ORDER BY 1")).rows
    .map(row => row.version), (await migrationNumbers()).filter(version => version >= 34));

  // The earlier row keeps no estimate: the price table never reaches back. A new segment is priced.
  const later = await launched(current, owner.ownerId, conversationId, "after the upgrade");
  await recordSegmentUsage(upgraded, later.launch, reported(1000, 100), priced("2", "8"));
  await later.commit();
  const records = (await new UsageApi(current).records(owner.ownerId, {})).records;
  assert.deepEqual(records.map(r => [r.requestId, r.estimatedCostUsd]),
    [[later.request.requestId, "0.0028"], [earlier.request.requestId, null]]);
});

test("migration 035 completes while a trusted-context turn holds its lease", async (t) => {
  const upgraded = await databaseAt(t, 34);
  const current = new MemberStore(upgraded);
  const owner = await memberBeforeTargets(current, "claude");
  const { trusted, claim } = await trustedStart(current, owner);
  // A trusted native turn reads its request under its lease's transaction for the whole turn.
  await trusted.admitted(claim, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([migrateThrough(current, 35).then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 035 must not wait for a running trusted turn");
  });
  await current.migrate();
  await recordTrustedUsage(upgraded, claim, reported(3, 4));
  assert.equal((await upgraded.query("SELECT count(*)::integer AS n FROM birbcrew_ts.usage_ledger WHERE trusted_request_id IS NOT NULL")).rows[0].n, 1);
});
