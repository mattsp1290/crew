import { migrateThrough } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActivityFailure, ApplicationFailure, WorkflowUpdateFailedError, type Client } from "@temporalio/client";
import type { PoolClient } from "pg";
import { MemberClient } from "../../src/service/client.ts";
import { auditEvents, auditEventTypes, auditQuerySchema, readAudit } from "../../src/service/audit.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { MemberStoreError, ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { HandoffApi } from "../../src/service/handoffs.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { InstallationRecovery } from "../../src/service/recovery.ts";
import { FileRecoveryFence } from "../../src/service/recovery-fence.ts";
import { failReasons, RoutineApi, RoutineDispatcher, skipReasons, type Clock } from "../../src/service/routines.ts";
import { MemberStore, ownerAdmissionActivity } from "../../src/service/store.ts";
import type { Launch } from "../../src/service/supervisor.ts";
import { recordSegmentUsage, UsageApi } from "../../src/service/usage.ts";
import { conversation, databaseAt, gateway, launched, member, migrationNumbers, pool, reported, spend, sql, store } from "./usage-fixtures.ts";

// Estimated cost, the trusted-context lane's metering and migration 35 are in usage-cost.test.ts.
before(() => store.migrate());
after(() => pool.end());

/** The top-level OR clauses of a CHECK as pg_get_constraintdef prints it: "CHECK ((a OR b ...)) NOT VALID". */
function orClauses(definition: string) {
  const body = /^CHECK \(\((.*)\)\)( NOT VALID)?$/s.exec(definition)?.[1];
  assert.ok(body, definition);
  const clauses: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (depth === 0 && body.startsWith(" OR ", i)) { clauses.push(body.slice(start, i)); start = i + 4; }
  }
  return [...clauses, body.slice(start)];
}
/** Each WHEN status of the firing reason CHECK with the reasons it allows, and its ELSE branch. */
function reasonBranches(definition: string) {
  return Object.fromEntries(definition.split("\n").map(line => line.trim()).filter(line => /^(WHEN|ELSE)/.test(line)).map(line => {
    const status = /^WHEN '(\w+)'::text THEN/.exec(line)?.[1] ?? "ELSE";
    return [status, [...line.matchAll(/'(\w+)'::text/g)].map(match => match[1]).filter(value => value !== status)];
  }));
}
const constraintDefinitions = async (db: PoolClient) => Object.fromEntries((await db.query<{ name: string; definition: string }>(
  `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conname IN ('audit_events_type_check','routine_firings_reason_check')`)).rows.map(row => [row.name, row.definition]));

/** Runs `during` while another transaction holds the conversation FOR UPDATE, as admission, a turn
 * start, a handoff or the trusted lane does, with `writes` uncommitted; once `during` waits for the
 * conversation, commits them. Returns what `during` settles to. */
async function whileHeld<T>(conversationId: string, writes: (db: PoolClient) => Promise<unknown>, during: () => Promise<T>) {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
    await writes(holder);
    const { rows: [{ pid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const result = during();
    void result.catch(() => {});
    let waiting = false;
    for (let i = 0; i < 1000 && !waiting; i++) {
      waiting = Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount);
      if (!waiting) await delay(10);
    }
    assert.ok(waiting, "the pre-check waits for the conversation");
    await holder.query("COMMIT");
    holder.release();
    return result;
  } catch (error) {
    // Never hand the pool a connection with this transaction still open.
    holder.release(true);
    throw error;
  }
}

/** Temporal must not be reached: the budget refuses before any workflow update. */
const unreachable = new Proxy({}, { get() { throw new Error("Temporal was used"); } }) as Client;
const audit = async (ownerId: string, type: string) => (await pool.query(`SELECT actor_kind AS actor, initiator_kind AS initiator,
  conversation_id AS "conversationId", request_id AS "requestId", payload FROM birbcrew_ts.audit_events
  WHERE owner_id=$1 AND event_type=$2 ORDER BY event_id`, [ownerId, type])).rows;

test("each launch records its segment's usage once, bound to the launch's execution, in an append-only ledger", async () => {
  const owner = await member(store);
  const conversationId = await conversation(store, owner);
  const segment = await launched(store, owner.ownerId, conversationId);
  const usage = reported(1200, 80, { cachedInputTokens: 900, cacheWriteTokens: 100, reasoningTokens: 20, costUsd: 0.0123 });
  await recordSegmentUsage(pool, segment.launch, usage);
  // A retried write for the same launch, and one whose execution is not the launch's, add nothing.
  await recordSegmentUsage(pool, segment.launch, reported(5, 5));
  await recordSegmentUsage(pool, { ...segment.launch, execution: { ...segment.launch.execution, attempt: 2 } }, reported(7, 7));
  const rows = async () => (await pool.query(`SELECT token, engine, state, model, input_tokens, output_tokens, cached_input_tokens,
    cache_write_tokens, reasoning_tokens, cost_usd::text AS cost FROM birbcrew_ts.usage_ledger WHERE owner_id=$1 ORDER BY usage_id`,
  [owner.ownerId])).rows;
  assert.deepEqual(await rows(), [{ token: segment.launch.token, engine: "pi", state: "reported", model: "fixture-model",
    input_tokens: 1200, output_tokens: 80, cached_input_tokens: 900, cache_write_tokens: 100, reasoning_tokens: 20, cost: "0.0123000000" }]);
  await segment.commit();

  // An activity retry of the turn replays its reply and launches nothing, so it has no new row.
  const retried = await store.beginTurn(segment.request, { ...segment.launch.execution, attempt: 2 });
  assert.equal(retried.kind, "replay");
  // A driver that reported nothing is recorded as unknown, never as zero.
  const other = await launched(store, owner.ownerId, conversationId, "second");
  await recordSegmentUsage(pool, other.launch);
  assert.equal((await rows()).length, 2);
  assert.deepEqual((await rows())[1], { token: other.launch.token, engine: "pi", state: "unknown", model: null, input_tokens: null,
    output_tokens: null, cached_input_tokens: null, cache_write_tokens: null, reasoning_tokens: null, cost: null });
  for (const change of ["UPDATE birbcrew_ts.usage_ledger SET input_tokens=0 WHERE owner_id=$1", "DELETE FROM birbcrew_ts.usage_ledger WHERE owner_id=$1"]) {
    await assert.rejects(pool.query(change, [owner.ownerId]), { code: "23514" });
  }
  const direct = (state: string, input: number | null) => pool.query(`INSERT INTO birbcrew_ts.usage_ledger
    (owner_id,member_id,conversation_id,request_id,token,engine,state,input_tokens) VALUES ($1,$2,$3,$4,$5,'pi',$6,$7)`,
  [owner.ownerId, owner.memberId, conversationId, other.request.requestId, other.launch.token, state, input]);
  await assert.rejects(direct("unknown", null), { code: "23505" });
  await assert.rejects(direct("unknown", 3), { code: "23514" }, "an unknown row carries no count");
  await assert.rejects(direct("reported", 3), { code: "23514" }, "a reported row has both counts");
  await other.commit();

  // A row the ledger's CHECKs would refuse is kept as unknown rather than failing the segment.
  const odd = await launched(store, owner.ownerId, conversationId, "third");
  await recordSegmentUsage(pool, odd.launch, { ...reported(5, 5), model: "é".repeat(200) });
  assert.deepEqual((await rows()).at(-1), { token: odd.launch.token, engine: "pi", state: "unknown", model: null, input_tokens: null,
    output_tokens: null, cached_input_tokens: null, cache_write_tokens: null, reasoning_tokens: null, cost: null });
});

test("the usage routes total an owner's usage by member and conversation, mark routine requests, and show no other owner's rows", async (t) => {
  const pi = await member(store);
  const codex = await member(store, pi.ownerId, "codex");
  const g = await gateway(t, {} as MemberClient, pi.ownerId);
  const first = await spend(store, pi, reported(1000, 100, { cachedInputTokens: 400, costUsd: 0.25 }));
  await spend(store, pi);
  const third = await spend(store, codex, reported(300, 30, { reasoningTokens: 10 }));
  // A routine's request: its firing row makes the admission record the routine as initiator. The
  // routine's windows start in 2031 and the lease lasts a day, so no real-clock dispatcher drives it.
  const routines = new RoutineApi(store, () => new Date("2031-01-06T10:00:00.000Z"));
  const routine = await routines.create(pi.ownerId, { requestId: randomUUID(), memberId: pi.memberId, schedule: "*/15 * * * *",
    prompt: "scheduled prompt", approvalPolicy: "wait" });
  const firing = { conversationId: randomUUID(), requestId: randomUUID() };
  await pool.query(`INSERT INTO birbcrew_ts.routine_firings (routine_id,scheduled_for,status,conversation_id,request_id,recorded_at,lease_until)
    VALUES ($1,clock_timestamp(),'claimed',$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`,
  [routine.routineId, firing.conversationId, firing.requestId]);
  await store.openConversation({ ...pi, conversationId: firing.conversationId });
  const scheduled = await launched(store, pi.ownerId, firing.conversationId, "scheduled prompt", firing.requestId);
  await recordSegmentUsage(pool, scheduled.launch, reported(50, 5));
  await scheduled.commit();
  const stranger = await member(store);
  await spend(store, stranger, reported(7777, 7));

  const zero = { segments: 0, unknownSegments: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, costUsd: null, costReportedSegments: 0, estimatedCostUsd: null, costEstimatedSegments: 0 };
  const routineTotals = { ...zero, segments: 1, inputTokens: 50, outputTokens: 5, totalTokens: 55 };
  const summary = await g.api("/v1/usage");
  assert.deepEqual(summary, { status: 200, body: { apiVersion: "1", from: null, to: null,
    total: { segments: 4, unknownSegments: 1, inputTokens: 1350, outputTokens: 135, totalTokens: 1485, cachedInputTokens: 400,
      cacheWriteTokens: 0, reasoningTokens: 10, costUsd: "0.25", costReportedSegments: 1, estimatedCostUsd: null, costEstimatedSegments: 0 },
    routine: routineTotals, trusted: zero } });

  const members = (await g.api("/v1/usage/members")).body;
  const piTotals = { segments: 3, unknownSegments: 1, inputTokens: 1050, outputTokens: 105, totalTokens: 1155, cachedInputTokens: 400,
    cacheWriteTokens: 0, reasoningTokens: 0, costUsd: "0.25", costReportedSegments: 1, estimatedCostUsd: null, costEstimatedSegments: 0 };
  const codexTotals = { ...zero, segments: 1, inputTokens: 300, outputTokens: 30, totalTokens: 330, reasoningTokens: 10 };
  assert.deepEqual(members.members, [
    { memberId: pi.memberId, engine: "pi", total: piTotals, routine: routineTotals, trusted: zero, budget: null },
    { memberId: codex.memberId, engine: "codex", total: codexTotals, routine: zero, trusted: zero, budget: null },
  ].sort((a, b) => a.memberId.localeCompare(b.memberId)));
  const page = (await g.api("/v1/usage/members?limit=1")).body;
  assert.equal(page.hasMore, true);
  assert.deepEqual((await g.api("/v1/usage/members?after=" + page.nextAfter)).body.members.map((m: { memberId: string }) => m.memberId),
    [members.members[1].memberId]);

  const conversations = (await g.api("/v1/usage/conversations?memberId=" + codex.memberId)).body;
  assert.deepEqual(conversations, { apiVersion: "1", conversations: [{ conversationId: third.conversationId, memberId: codex.memberId,
    total: codexTotals, routine: zero, trusted: zero }], nextAfter: third.conversationId, hasMore: false });
  assert.equal((await g.api("/v1/usage/conversations")).body.conversations.length, 4);

  const records = (await g.api("/v1/usage/records?limit=3")).body;
  assert.deepEqual(records.records.map((r: { requestId: string; initiator: unknown }) => [r.requestId, r.initiator]), [
    [firing.requestId, { kind: "routine", id: routine.routineId }], [third.requestId, { kind: "owner" }], [records.records[2].requestId, { kind: "owner" }],
  ]);
  assert.equal(records.hasMore, true);
  const rest = (await g.api("/v1/usage/records?before=" + records.nextBefore)).body;
  assert.deepEqual(rest.records.map((r: { requestId: string }) => r.requestId), [first.requestId]);
  assert.deepEqual({ ...rest.records[0], usageId: undefined, recordedAt: undefined }, { usageId: undefined, recordedAt: undefined,
    memberId: pi.memberId, conversationId: first.conversationId, requestId: first.requestId, childId: null, lane: "member", engine: "pi",
    state: "reported", model: "fixture-model", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, cacheWriteTokens: null,
    reasoningTokens: null, costUsd: "0.25", estimatedCostUsd: null, estimatePrice: null, initiator: { kind: "owner" } });
  assert.equal((await g.api("/v1/usage/records?conversationId=" + third.conversationId)).body.records.length, 1);

  // Time range: [from, to) on the database's record time.
  const later = new Date(Date.now() + 3_600_000).toISOString(), earlier = new Date(Date.now() - 3_600_000).toISOString();
  assert.deepEqual((await g.api("/v1/usage?from=" + later)).body.total, zero);
  assert.deepEqual((await g.api("/v1/usage?to=" + earlier)).body.total, zero);
  assert.equal((await g.api(`/v1/usage?from=${earlier}&to=${later}`)).body.total.segments, 4);
  assert.deepEqual((await g.api("/v1/usage/members?from=" + later)).body.members.map((m: { total: unknown }) => m.total), [zero, zero]);

  // Another owner sees none of these rows and cannot name this owner's member or conversation.
  assert.deepEqual((await g.api("/v1/usage", undefined, g.stranger)).body.total, zero);
  assert.deepEqual((await g.api("/v1/usage/records", undefined, g.stranger)).body.records, []);
  assert.deepEqual((await g.api("/v1/usage/members", undefined, g.stranger)).body.members, []);
  for (const path of ["/v1/usage/records?memberId=" + pi.memberId, "/v1/usage/records?conversationId=" + first.conversationId,
    "/v1/usage/conversations?memberId=" + pi.memberId, "/v1/usage/budgets/" + pi.memberId]) {
    assert.deepEqual(await g.api(path, undefined, g.stranger), { status: 404, body: { error: "not_found" } }, path);
  }
  assert.deepEqual((await g.api("/v1/usage/records?memberId=" + stranger.memberId)).status, 404);
  for (const query of ["/v1/usage?limit=1", "/v1/usage?from=2031-01-06", `/v1/usage?from=${later}&to=${earlier}`, `/v1/usage?from=${later}&to=${later}`,
    "/v1/usage?from=" + later + "&from=" + later, "/v1/usage?__proto__=1", "/v1/usage/members?limit=0", "/v1/usage/members?limit=101",
    "/v1/usage/members?after=x", "/v1/usage/records?limit=1001", "/v1/usage/records?before=abc", "/v1/usage/records?before=0",
    "/v1/usage/conversations?memberId=x", "/v1/usage/budgets/" + pi.memberId + "?x=1"]) {
    assert.deepEqual(await g.api(query), { status: 400, body: { error: "invalid_input" } }, query);
  }
  assert.equal((await g.api("/v1/usage", {})).status, 405);
  assert.equal((await g.api("/v1/usage/records", {}, undefined, "DELETE")).status, 405);
  assert.equal((await g.api("/v1/usage/budgets/" + pi.memberId, {})).status, 405);
  assert.equal((await g.api("/v1/usage", undefined, "invalid")).status, 401);
  assert.equal((await g.api("/usage")).status, 404);
  const capabilities = (await g.api("/v1/capabilities")).body;
  assert.deepEqual([capabilities.usage.route, capabilities.usage.budget.period, capabilities.usage.budget.refusal,
    capabilities.usage.budget.refusalClosingConversation], ["/v1/usage", "utc_day", "usage_limit", "usage_limit_closed"]);
  // Pinned, so rewording a value consumers may match is a deliberate change. Values that were true
  // before estimates still are, since costUsd is still billed only. Codex's model is the profile model.
  assert.deepEqual([capabilities.usage.cost, capabilities.usage.engines, capabilities.usage.lanes, capabilities.usage.estimate,
    capabilities.usage.budget.lanesCounted, capabilities.usage.budget.lanesRefused], ["provider-billed-only; never-estimated", {
    pi: { usage: "per-model-call", model: "reported", modelSource: "answering-model", cost: "when-provider-billed",
      estimate: "when-priced-and-not-billed" },
    claude: { usage: "per-query", model: "reported", cost: "never", estimate: "when-priced" },
    codex: { usage: "per-turn-from-thread-total", model: "profile-model", cost: "never", estimate: "when-priced" },
  }, ["member", "trusted"], { field: "estimatedCostUsd", source: "operator-price-table", setting: "BIRBCREW_USAGE_PRICES_PATH",
    unit: "usd-per-million-tokens", keyedBy: "recorded-model", computed: "at-write; never-recomputed", builtInPrices: false,
    withBilledCost: "never-on-one-segment; totals-never-added" }, ["member", "trusted"], ["member"]]);
  assert.ok(capabilities.audit.eventTypes.includes("usage.request_refused"));
});

test("an owner sets, changes and clears a member's budget; each change is audited once", async (t) => {
  const owner = await member(store);
  const g = await gateway(t, {} as MemberClient, owner.ownerId);
  const path = "/v1/usage/budgets/" + owner.memberId;
  await spend(store, owner, reported(40, 2));
  const window = (await g.api(path)).body.window;
  assert.equal(window.start, new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());
  assert.equal(Date.parse(window.end) - Date.parse(window.start), 86_400_000);
  assert.deepEqual(await g.api(path), { status: 200, body: { apiVersion: "1", memberId: owner.memberId, budget: null, window,
    usedTokens: 42, remainingTokens: null, admitting: true } });
  for (const invalid of [{}, { tokenLimit: 0 }, { tokenLimit: 1.5 }, { tokenLimit: "100" }, { tokenLimit: 1_000_000_000_001 },
    { tokenLimit: 100, ownerId: owner.ownerId }, { tokenLimit: 100, period: "utc_day" }]) {
    assert.deepEqual(await g.api(path, invalid, undefined, "PUT"), { status: 400, body: { error: "invalid_input" } }, JSON.stringify(invalid));
  }
  assert.deepEqual(await g.api(path, { tokenLimit: 100 }, g.stranger, "PUT"), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await g.api(path, undefined, g.stranger, "DELETE"), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await g.api("/v1/usage/budgets/" + randomUUID(), { tokenLimit: 100 }, undefined, "PUT"), { status: 404, body: { error: "not_found" } });

  const set = await g.api(path, { tokenLimit: 100 }, undefined, "PUT");
  assert.equal(set.status, 200);
  assert.deepEqual({ ...set.body, budget: { ...set.body.budget, changedAt: undefined } }, { apiVersion: "1", memberId: owner.memberId,
    budget: { tokenLimit: 100, period: "utc_day", revision: 1, changedAt: undefined }, window, usedTokens: 42, remainingTokens: 58, admitting: true });
  assert.deepEqual(await g.api(path, { tokenLimit: 100 }, undefined, "PUT"), set, "the same limit again changes nothing");
  assert.equal((await g.api(path, { tokenLimit: 40 }, undefined, "PUT")).body.admitting, false);
  const cleared = await g.api(path, undefined, undefined, "DELETE");
  assert.deepEqual([cleared.status, cleared.body.budget, cleared.body.admitting], [200, null, true]);
  assert.deepEqual(await g.api(path, undefined, undefined, "DELETE"), cleared, "clearing again changes nothing");
  assert.equal((await g.api(path, { tokenLimit: 5000 }, undefined, "PUT")).body.budget.revision, 4);
  assert.deepEqual((await g.api("/v1/usage/members")).body.members[0].budget, { tokenLimit: 5000, period: "utc_day", revision: 4,
    changedAt: (await g.api(path)).body.budget.changedAt, windowStart: window.start, usedTokens: 42 });

  const rows = await audit(owner.ownerId, "usage.budget_set");
  assert.deepEqual(rows.map(row => [row.actor, row.payload]), [["owner", { revision: 1, tokenLimit: 100, period: "utc_day" }],
    ["owner", { revision: 2, tokenLimit: 40, period: "utc_day" }], ["owner", { revision: 4, tokenLimit: 5000, period: "utc_day" }]]);
  assert.deepEqual((await audit(owner.ownerId, "usage.budget_cleared")).map(row => row.payload), [{ revision: 3 }]);
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.usage_budgets WHERE member_id=$1", [owner.memberId]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.usage_budgets SET token_limit=1, revision=revision+2 WHERE member_id=$1",
    [owner.memberId]), { code: "23514" });
});

test("a member at or over its budget is refused at admission; an admitted or running request never is", async (t) => {
  const owner = await member(store);
  const g = await gateway(t, new MemberClient(store, unreachable), owner.ownerId);
  const usage = new UsageApi(store);
  await usage.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 1000 });
  await spend(store, owner, reported(900, 99));
  await spend(store, owner); // unknown usage counts nothing
  // Yesterday's usage is outside the window.
  const old = await launched(store, owner.ownerId, await conversation(store, owner), "old");
  await pool.query(`INSERT INTO birbcrew_ts.usage_ledger (owner_id,member_id,conversation_id,request_id,token,engine,state,input_tokens,output_tokens,recorded_at)
    VALUES ($1,$2,$3,$4,$5,'pi','reported',50000,0,date_trunc('day', now(), 'UTC') - interval '1 second')`,
  [owner.ownerId, owner.memberId, old.request.conversationId, old.request.requestId, old.launch.token]);
  await old.commit();

  // 999 of 1000 used: this request is admitted, starts, and its usage takes the member past the limit.
  const conversationId = await conversation(store, owner);
  const running = await launched(store, owner.ownerId, conversationId, "running");
  await recordSegmentUsage(pool, running.launch, reported(500, 1));
  assert.deepEqual((await usage.budget(owner.ownerId, owner.memberId)).usedTokens, 1500, "a soft cap: one request can pass the limit");

  const refused = { ownerId: owner.ownerId, conversationId: await conversation(store, owner), requestId: randomUUID(), text: "refused" };
  await assert.rejects(store.checkAdmission(refused), { code: "usage_limit" });
  await assert.rejects(store.recordAcceptance(refused, ownerInitiator), { code: "usage_limit" });
  await assert.rejects(ownerAdmissionActivity(store)(refused), (error: unknown) =>
    error instanceof ApplicationFailure && error.type === "usage_limit" && error.nonRetryable);
  const submitted = await g.api(`/v1/conversations/${refused.conversationId}/requests`, { requestId: refused.requestId, text: refused.text });
  assert.deepEqual(submitted, { status: 409, body: { error: "usage_limit" } });
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.request_admissions WHERE request_id=$1", [refused.requestId])).rowCount, 0);
  const refusals = await audit(owner.ownerId, "usage.request_refused");
  assert.deepEqual(refusals, [{ actor: "system", initiator: "owner", conversationId: refused.conversationId, requestId: refused.requestId,
    payload: { tokenLimit: 1000, usedTokens: 1500, period: "utc_day", windowStart: new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString(),
      budgetRevision: 1 } }], "one row per refused request, however often it is retried");

  // The running request is not interrupted and its admission is replayed, not refused.
  await store.recordAcceptance(running.request, ownerInitiator);
  await store.checkAdmission(running.request);
  assert.equal(await running.commit(), "done");
  // The workflow's own admission refusing in a race reaches the caller as 409 usage_limit_closed.
  await usage.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 5000 });
  const raced = { workflow: { start: async () => {}, getHandle: () => ({ executeUpdate: async () => {
    throw new WorkflowUpdateFailedError("Workflow Update failed", new ActivityFailure("Activity task failed", "recordAcceptance", "1",
      undefined as never, "worker", ApplicationFailure.nonRetryable("usage_limit", "usage_limit")));
  } }) } } as unknown as Client;
  // The workflow closes a conversation whose admission it refused, so this refusal says so.
  await assert.rejects(new MemberClient(store, raced).accept({ ...refused, requestId: randomUUID() }), { code: "usage_limit_closed" });
  // A larger limit, or no limit, admits again.
  await store.recordAcceptance({ ...refused, requestId: randomUUID() }, ownerInitiator);
  await usage.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 1 });
  await assert.rejects(store.recordAcceptance({ ...refused, requestId: randomUUID() }, ownerInitiator), { code: "usage_limit" });
  await usage.clearBudget(owner.ownerId, owner.memberId);
  await store.recordAcceptance({ ...refused, requestId: randomUUID() }, ownerInitiator);
  // Another member of the owner is not limited by this one's budget.
  const sibling = await member(store, owner.ownerId);
  await usage.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 1 });
  await store.recordAcceptance({ ownerId: owner.ownerId, conversationId: await conversation(store, sibling), requestId: randomUUID(), text: "free" }, ownerInitiator);
});

test("a handoff meets its target's budget before it commits; its reserved request is metered and never refused afterwards", async (t) => {
  const source = await member(store);
  const target = await member(store, source.ownerId);
  const usage = new UsageApi(store);
  const g = await gateway(t, new MemberClient(store, unreachable), source.ownerId);
  const sourceConversation = await conversation(store, source);
  const prior = await launched(store, source.ownerId, sourceConversation, "carried prompt");
  await prior.commit();
  await spend(store, target, reported(90, 10));
  await usage.setBudget(source.ownerId, target.memberId, { tokenLimit: 100 });
  const trail = async () => (await pool.query("SELECT event_type FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id",
    [source.ownerId])).rows.map(row => row.event_type);
  const before = await trail();

  // Over budget: refused inside the handoff's transaction, which writes nothing, and Temporal is never reached.
  const refused = await g.api(`/v1/conversations/${sourceConversation}/handoffs`, { requestId: randomUUID(), memberId: target.memberId });
  assert.deepEqual(refused, { status: 409, body: { error: "usage_limit" } });
  assert.deepEqual(await trail(), before, "no handoff, target, seal or audit row");
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.conversation_handoffs WHERE source_conversation_id=$1", [sourceConversation])).rowCount, 0);
  await store.checkAdmission({ ownerId: source.ownerId, conversationId: sourceConversation, requestId: randomUUID(), text: "still open" });

  // Under budget the handoff commits. The budget then runs out before the reserved request reaches
  // admission: it is admitted anyway, since refusing it would leave the source sealed and the target pending.
  await usage.setBudget(source.ownerId, target.memberId, { tokenLimit: 1000 });
  const members = {
    async open(input: Parameters<MemberStore["openConversation"]>[0]) { return store.openConversation(input); },
    async accept(input: TurnRequest) {
      await usage.setBudget(source.ownerId, target.memberId, { tokenLimit: 1 });
      await store.checkAdmission(input);
      await store.recordAcceptance(input, ownerInitiator);
      return { requestId: input.requestId };
    },
  } as unknown as MemberClient;
  const handoff = await new HandoffApi(store, members).create(source.ownerId, sourceConversation, { requestId: randomUUID(), memberId: target.memberId });
  assert.equal(handoff.firstRequestAdmitted, true);
  const reserved = { ownerId: source.ownerId, conversationId: handoff.target.conversationId, requestId: handoff.firstRequestId };
  assert.equal((await audit(source.ownerId, "usage.request_refused")).length, 0);
  // Every other request to the target still meets the budget.
  const next = { ...reserved, requestId: randomUUID(), text: "after the handoff" };
  await assert.rejects(store.checkAdmission(next), { code: "usage_limit" });
  await assert.rejects(store.recordAcceptance(next, ownerInitiator), { code: "usage_limit" });

  // The reserved request is a model call on the target member: metered there and named as the handoff's.
  const { rows: [{ transcript }] } = await pool.query<{ transcript: string }>(
    "SELECT transcript FROM birbcrew_ts.conversation_handoffs WHERE handoff_id=$1", [handoff.handoffId]);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const turn = await store.beginTurn({ ...reserved, text: transcript }, execution);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [reserved.conversationId, reserved.requestId, turn.token, execution.workflowRunId, execution.activityId]);
  await recordSegmentUsage(pool, { ...reserved, text: transcript, token: turn.token, execution }, reported(16_000, 20));
  const [record] = (await usage.records(source.ownerId, { conversationId: reserved.conversationId })).records;
  assert.deepEqual([record.memberId, record.inputTokens, record.initiator], [target.memberId, 16_000, { kind: "handoff", id: handoff.handoffId }]);
  assert.equal((await usage.budget(source.ownerId, target.memberId)).usedTokens, 16_120);
});

test("a request refused as handed off, pending its handoff or over the prompt bound records no budget refusal", async () => {
  const source = await member(store);
  const target = await member(store, source.ownerId);
  const sourceConversation = await conversation(store, source);
  const prior = await launched(store, source.ownerId, sourceConversation, "carried prompt");
  await prior.commit();
  // A handoff whose reserved request has not reached admission yet.
  const pending = { async open(input: Parameters<MemberStore["openConversation"]>[0]) { return store.openConversation(input); },
    async accept() { throw new MemberStoreError("busy"); } } as unknown as MemberClient;
  const handoff = await new HandoffApi(store, pending).create(source.ownerId, sourceConversation, { requestId: randomUUID(), memberId: target.memberId });
  assert.equal(handoff.firstRequestAdmitted, false);
  // Both members then use up their budgets.
  const usage = new UsageApi(store);
  for (const owner of [source, target]) {
    await spend(store, owner, reported(10));
    await usage.setBudget(source.ownerId, owner.memberId, { tokenLimit: 10 });
  }
  const cases: [{ ownerId: string; conversationId: string; requestId: string; text: string }, (error: unknown) => boolean][] = [
    [{ ownerId: source.ownerId, conversationId: sourceConversation, requestId: randomUUID(), text: "to the sealed source" },
      error => error instanceof MemberStoreError && error.code === "handed_off"],
    [{ ownerId: source.ownerId, conversationId: handoff.target.conversationId, requestId: randomUUID(), text: "before the reserved request" },
      error => error instanceof MemberStoreError && error.code === "handoff_pending"],
    [{ ownerId: source.ownerId, conversationId: await conversation(store, source), requestId: randomUUID(), text: "x".repeat(16_385) },
      error => error instanceof Error && error.name === "ZodError"],
  ];
  for (const [request, refusal] of cases) {
    await assert.rejects(store.checkAdmission(request), refusal, request.text.slice(0, 30));
    await assert.rejects(store.recordAcceptance(request, ownerInitiator), refusal, request.text.slice(0, 30));
  }
  assert.equal((await audit(source.ownerId, "usage.request_refused")).length, 0);
  // The budget itself still refuses an ordinary request of either member.
  for (const owner of [source, target]) {
    await assert.rejects(store.checkAdmission({ ownerId: source.ownerId, conversationId: await conversation(store, owner), requestId: randomUUID(),
      text: "ordinary" }), { code: "usage_limit" });
  }
});

test("the budget pre-check repeats admission's earlier refusals under its lock before it refuses or audits", async () => {
  const owner = await member(store);
  const usage = new UsageApi(store);
  const refusals = async () => (await audit(owner.ownerId, "usage.request_refused")).length;
  // A conversation at its request bound: admission refuses input_limit before it looks at the budget.
  const bounded = await conversation(store, owner);
  await pool.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1", [bounded]);
  for (let i = 0; i < 4; i++) await store.recordAcceptance({ ownerId: owner.ownerId, conversationId: bounded, requestId: randomUUID(), text: "fill" }, ownerInitiator);
  // A routine firing's identity sent with other text: admission refuses conflict and names no routine.
  const routine = await new RoutineApi(store, () => new Date("2031-01-06T10:00:00.000Z")).create(owner.ownerId, { requestId: randomUUID(),
    memberId: owner.memberId, schedule: "*/15 * * * *", prompt: "scheduled prompt", approvalPolicy: "wait" });
  const firing = { ownerId: owner.ownerId, conversationId: randomUUID(), requestId: randomUUID(), text: "not the routine's prompt" };
  await pool.query(`INSERT INTO birbcrew_ts.routine_firings (routine_id,scheduled_for,status,conversation_id,request_id,recorded_at,lease_until)
    VALUES ($1,clock_timestamp(),'claimed',$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`,
  [routine.routineId, firing.conversationId, firing.requestId]);
  await store.openConversation({ ...owner, conversationId: firing.conversationId });
  await spend(store, owner, reported(10));
  await usage.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 10 });
  const overBound = { ownerId: owner.ownerId, conversationId: bounded, requestId: randomUUID(), text: "fifth" };
  await assert.rejects(store.checkAdmission(overBound), { code: "input_limit" });
  await assert.rejects(store.recordAcceptance(overBound, ownerInitiator), { code: "input_limit" });
  await assert.rejects(store.checkAdmission(firing), { code: "conflict" });
  await assert.rejects(store.recordAcceptance(firing, ownerInitiator), { code: "conflict" });
  assert.equal(await refusals(), 0);

  // Each of these commits after the pre-check's first, unlocked reads, while it waits for the
  // conversation; under its lock it sees the commit. A handoff seals the source: handed_off.
  const source = await conversation(store, owner), target = await conversation(store, owner);
  await assert.rejects(whileHeld(source, db => db.query(`INSERT INTO birbcrew_ts.conversation_handoffs (owner_id,request_id,
      source_conversation_id,source_member_id,target_conversation_id,target_member_id,transcript,transcript_digest,carried_turns,
      omitted_turns,uncertain_turns) VALUES ($1,$2,$3,$4,$5,$4,'t',sha256(convert_to('t','UTF8')),1,0,0)`,
  [owner.ownerId, randomUUID(), source, owner.memberId, target]),
  () => store.checkAdmission({ ownerId: owner.ownerId, conversationId: source, requestId: randomUUID(), text: "during the handoff" })),
  { code: "handed_off" });
  // The same request admitted, or its turn started by a legacy submit: a retry is never refused.
  const digest = (text: string) => createHash("sha256").update(text).digest();
  const admitted = { ownerId: owner.ownerId, conversationId: await conversation(store, owner), requestId: randomUUID(), text: "admitted meanwhile" };
  await whileHeld(admitted.conversationId, db => db.query(`INSERT INTO birbcrew_ts.request_admissions
    (conversation_id,request_id,prompt_digest,initiator_kind) VALUES ($1,$2,$3,'owner')`,
  [admitted.conversationId, admitted.requestId, digest(admitted.text)]), () => store.checkAdmission(admitted));
  const started = { ownerId: owner.ownerId, conversationId: await conversation(store, owner), requestId: randomUUID(), text: "started meanwhile" };
  await whileHeld(started.conversationId, db => db.query(`INSERT INTO birbcrew_ts.turns
    (conversation_id,request_id,position,prompt_digest,attempt,phase) VALUES ($1,$2,1,$3,1,'started')`,
  [started.conversationId, started.requestId, digest(started.text)]), () => store.checkAdmission(started));
  // The trusted-context lane attaches: admission refuses the conversation itself, not the budget.
  const trusted = await conversation(store, owner);
  await whileHeld(trusted, db => db.query(`INSERT INTO birbcrew_ts.trusted_sessions
    (conversation_id,owner_id,scope,context_version,context_text,application_digest) VALUES ($1,$2,'fixture','1','context',$3)`,
  [trusted, owner.ownerId, "0".repeat(64)]),
  () => store.checkAdmission({ ownerId: owner.ownerId, conversationId: trusted, requestId: randomUUID(), text: "on the trusted lane" }));
  assert.equal(await refusals(), 0);
  // An ordinary request of the member is still refused under its budget, once.
  await assert.rejects(store.checkAdmission({ ownerId: owner.ownerId, conversationId: await conversation(store, owner), requestId: randomUUID(),
    text: "ordinary" }), { code: "usage_limit" });
  assert.equal(await refusals(), 1);
});

test("an expired card's request is metered for the segment that proposed it and the one that resumes with the cancelled result", async () => {
  const owner = await member(store);
  const usage = new UsageApi(store), approvals = new ApprovalStore(pool);
  const conversationId = await conversation(store, owner);
  const request = { ownerId: owner.ownerId, conversationId, requestId: randomUUID(), text: "record then wait", approvalDeadlineSeconds: 60 };
  await store.recordAcceptance(request, ownerInitiator);
  const reserve = async (execution: { workflowRunId: string; activityId: string; attempt: number }, token: string) => {
    await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
      VALUES ($1,$2,$3,$4,$5,$6)`, [conversationId, request.requestId, token, execution.workflowRunId, execution.activityId, execution.attempt]);
    return { ...request, token, execution };
  };
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const turn = await store.beginTurn(request, execution);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  // The proposing segment returned: the supervisor records its usage, then commits the card and its checkpoint.
  await recordSegmentUsage(pool, await reserve(execution, turn.token), reported(400, 40));
  const card = await approvals.propose({ ownerId: owner.ownerId, memberId: owner.memberId, conversationId, requestId: request.requestId,
    invocationId: request.requestId, nativeCallId: "expiring-call", token: turn.token, toolName: "record_work_item",
    arguments: { operation_id: request.requestId } }, { version: 1, engine: "pi", state: {} });
  assert.ok(card.expiresAt);
  await pool.query("UPDATE birbcrew_ts.deferred_calls SET expires_at=clock_timestamp() WHERE approval_id=$1", [card.approvalId]);
  assert.deepEqual(await approvals.expireTurn(card), { kind: "expired" });
  // As the workflow does next: settle the card, which the expiry cancelled, and resume the native
  // session with that result under a new launch generation. That segment writes the reply and is metered too.
  assert.equal((await approvals.settleConfirmed(card)).kind, "cancelled");
  const resumeExecution = { ...execution, activityId: "resume" };
  const resumed = await store.beginResume(request, card, resumeExecution);
  assert.equal(resumed.kind, "start"); if (resumed.kind !== "start") return;
  assert.notEqual(resumed.token, turn.token);
  await recordSegmentUsage(pool, await reserve(resumeExecution, resumed.token), reported(500, 60));
  const records = (await usage.records(owner.ownerId, { conversationId })).records;
  assert.deepEqual(records.map(record => [record.requestId, record.state, record.inputTokens, record.outputTokens]),
    [[request.requestId, "reported", 500, 60], [request.requestId, "reported", 400, 40]]);
  // Both count, and the request admitted before them was never refused for them.
  await usage.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 1000 });
  assert.deepEqual([(await usage.budget(owner.ownerId, owner.memberId)).usedTokens, (await usage.summary(owner.ownerId, {})).total.totalTokens], [1000, 1000]);
  assert.equal((await audit(owner.ownerId, "usage.request_refused")).length, 0);
  await assert.rejects(store.recordAcceptance({ ...request, requestId: randomUUID(), conversationId: await conversation(store, owner) }, ownerInitiator),
    { code: "usage_limit" });
});

test("a routine firing refused by its member's budget fails with usage_limit and counts toward the switch-off", async (t) => {
  const db = await databaseAt(t);
  const isolated = new MemberStore(db);
  const owner = await member(isolated);
  let now = new Date("2031-01-06T10:00:00.000Z"), refused = 0;
  const clock: Clock = () => new Date(now);
  const members = {
    async open(input: Parameters<MemberStore["openConversation"]>[0]) { return isolated.openConversation(input); },
    // The first firing is refused by MemberClient's pre-check, which finds the routine itself. The
    // second reaches the workflow's own admission, as in a race, and MemberClient reports that refusal.
    async accept(input: TurnRequest) {
      try {
        if (refused === 0) await isolated.checkAdmission(input);
        await isolated.recordAcceptance(input, ownerInitiator);
      } catch (error) { throw ++refused === 2 ? new MemberStoreError("usage_limit_closed") : error; }
      return { requestId: input.requestId };
    },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return isolated.requestStatus(input); },
    async cancelPending() {},
  } as unknown as MemberClient;
  const integration = new IntegrationApi(isolated, members);
  const routine = await new RoutineApi(isolated, clock).create(owner.ownerId, { requestId: randomUUID(), memberId: owner.memberId,
    schedule: "*/15 * * * *", prompt: "scheduled prompt", approvalPolicy: "wait" });
  await new UsageApi(isolated).setBudget(owner.ownerId, owner.memberId, { tokenLimit: 10 });
  await spend(isolated, owner, reported(10));
  await db.query("UPDATE birbcrew_ts.routines SET consecutive_failures=8 WHERE routine_id=$1", [routine.routineId]);
  const dispatcher = new RoutineDispatcher({ store: isolated, members, integration, owners: [owner.ownerId], clock });
  t.after(() => dispatcher.stop());
  for (const minutes of [15, 30]) {
    now = new Date(Date.parse("2031-01-06T10:00:00.000Z") + minutes * 60_000);
    await dispatcher.tick();
  }
  const { rows: firings } = await db.query(`SELECT status, reason, conversation_id, request_id FROM birbcrew_ts.routine_firings
    WHERE routine_id=$1 ORDER BY scheduled_for`, [routine.routineId]);
  assert.deepEqual(firings.map(row => [row.status, row.reason]), [["failed", "usage_limit"], ["failed", "usage_limit"]]);
  const { rows: [state] } = await db.query("SELECT state, disabled_reason, consecutive_failures FROM birbcrew_ts.routines WHERE routine_id=$1",
    [routine.routineId]);
  assert.deepEqual(state, { state: "disabled", disabled_reason: "consecutive_failures", consecutive_failures: 10 });
  const { rows: refusals } = await db.query(`SELECT conversation_id, request_id, payload->>'routineId' AS routine FROM birbcrew_ts.audit_events
    WHERE event_type='usage.request_refused' ORDER BY event_id`);
  assert.deepEqual(refusals, firings.map(row => ({ conversation_id: row.conversation_id, request_id: row.request_id, routine: routine.routineId })));
  const { rows: settled } = await db.query(`SELECT payload->>'reason' AS reason FROM birbcrew_ts.audit_events
    WHERE event_type='routine.firing_settled' ORDER BY event_id`);
  assert.deepEqual(settled.map(row => row.reason), ["usage_limit", "usage_limit"]);
  // The audit filters find the refusals by type. A refused request has no admission, so its row
  // names the owner as initiator and the routine only in its payload, which no filter reads.
  const filtered = async (filters: Record<string, string>) =>
    (await readAudit(db, owner.ownerId, auditQuerySchema.parse(filters))).events.map(event => [event.type, event.initiator.kind]);
  assert.deepEqual(await filtered({ eventType: "usage.request_refused", actorKind: "system", initiatorKind: "owner" }),
    [["usage.request_refused", "owner"], ["usage.request_refused", "owner"]]);
  assert.deepEqual(await filtered({ initiatorId: routine.routineId }), []);
});

test("migration 031 takes its locks without queueing, rewrites nothing, leaves its CHECKs unvalidated and never waits for a running turn", async (t) => {
  const upgraded = await databaseAt(t, 30);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'codex','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = `SELECT pg_relation_filenode('birbcrew_ts.members') AS members, pg_relation_filenode('birbcrew_ts.native_launches') AS launches,
      pg_relation_filenode('birbcrew_ts.audit_events') AS audit, pg_relation_filenode('birbcrew_ts.routine_firings') AS firings`;
    const { rows: [before] } = await db.query(files);
    const previous = await constraintDefinitions(db);
    await db.query(await readFile(new URL("031-usage.sql", sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname NOT IN ('usage_ledger','usage_budgets') ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "audit_events", mode: "AccessExclusiveLock" }, { relation: "audit_events", mode: "ShareLock" },
      { relation: "members", mode: "AccessShareLock" }, { relation: "members", mode: "ShareRowExclusiveLock" },
      { relation: "native_launches", mode: "AccessShareLock" }, { relation: "native_launches", mode: "ShareRowExclusiveLock" },
      { relation: "routine_firings", mode: "AccessExclusiveLock" },
    ]);
    const { rows: checks } = await db.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conname IN ('audit_events_type_check','routine_firings_check4','routine_firings_reason_check') ORDER BY 1`);
    assert.deepEqual(checks, [{ name: "audit_events_type_check", validated: false }, { name: "routine_firings_reason_check", validated: false }]);

    // Each CHECK 031 replaces keeps, clause for clause as PostgreSQL stores it, everything the one it
    // replaces held (029's 22 audit types and 028's firing reasons), and adds only usage's.
    const current = await constraintDefinitions(db);
    const [kept, replaced] = [orClauses(previous.audit_events_type_check), orClauses(current.audit_events_type_check)];
    const types = (clauses: string[]) => clauses.flatMap(clause => [...clause.matchAll(/'([a-z_]+\.[a-z_]+)'::text/g)].map(match => match[1]));
    assert.equal(new Set(types(kept)).size, 22);
    assert.deepEqual(replaced.slice(0, kept.length), kept, "every clause 029 held, unchanged and in order");
    assert.deepEqual(types(replaced.slice(kept.length)), ["usage.budget_set", "usage.budget_cleared", "usage.request_refused"]);
    // The registry also holds the types later migrations add to the CHECK, read from their files.
    const later = new Set<string>();
    for (const file of (await readdir(sql)).filter(file => Number(file.split("-")[0]) > 31)) {
      const check = /ADD CONSTRAINT audit_events_type_check CHECK \(([\s\S]*?)\) NOT VALID'?;/.exec((await readFile(new URL(file, sql), "utf8")).replaceAll("''", "'"));
      for (const [, type] of check?.[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g) ?? []) later.add(type);
    }
    assert.deepEqual([...new Set([...types(replaced), ...later])].sort(), [...auditEventTypes].sort(), "the registry and the CHECKs name the same types");
    const [reasons, widened] = [reasonBranches(previous.routine_firings_reason_check), reasonBranches(current.routine_firings_reason_check)];
    assert.ok(reasons.failed.includes("approval_expired"), previous.routine_firings_reason_check);
    assert.deepEqual([...widened.skipped].sort(), [...skipReasons].sort());
    assert.deepEqual([...widened.failed].sort(), [...failReasons].sort());
    assert.deepEqual(widened, { ...reasons, failed: [...reasons.failed, "usage_limit"] });
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  // A launch being reserved holds native_launches in a mode the migration's lock excludes.
  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  const holder = await upgraded.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
      VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
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
  // migrate() brought it to the newest migration in the directory, whatever that is.
  assert.deepEqual((await upgraded.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version>=30 ORDER BY 1")).rows.map(row => row.version),
    (await migrationNumbers()).filter(version => version >= 30));
  // The turn that started before the upgrade is metered when its segment returns.
  await recordSegmentUsage(upgraded, { ownerId, conversationId, requestId, text, token: start.token, execution }, reported(3, 4));
  assert.equal((await upgraded.query("SELECT count(*)::integer AS n FROM birbcrew_ts.usage_ledger")).rows[0].n, 1);
});

test("migrate() refuses to apply a migration below one already applied", async (t) => {
  // A database that ran a later migration first would otherwise get an earlier one's narrower CHECKs.
  const ahead = await databaseAt(t, 30);
  await ahead.query("INSERT INTO birbcrew_ts.schema_versions VALUES (40)");
  await assert.rejects(new MemberStore(ahead).migrate(), /Migration 31 would apply after migration 40/);
  assert.equal((await ahead.query("SELECT to_regclass('birbcrew_ts.usage_ledger') AS ledger")).rows[0].ledger, null);
  // A development database that ran this branch before 27 to 30 were merged below it holds 31
  // without them. 027 to 029 would narrow 031's type CHECK and 028 cannot find the reason CHECK
  // it replaces, so migrate() stops before applying anything.
  const early = await databaseAt(t, 26);
  await early.query("INSERT INTO birbcrew_ts.schema_versions VALUES (31)");
  await assert.rejects(new MemberStore(early).migrate(), /Migration 27 would apply after migration 31/);
  assert.equal((await early.query("SELECT to_regclass('birbcrew_ts.conversation_handoffs') AS handoffs")).rows[0].handoffs, null);
  // Releases before 27 shipped migration 22 after 26; a database from one still upgrades.
  const shipped = await databaseAt(t, 26, [22]);
  await new MemberStore(shipped).migrate();
  assert.deepEqual((await shipped.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version=22 OR version>26 ORDER BY 1")).rows
    .map(row => row.version), [22, ...(await migrationNumbers()).filter(version => version > 26)]);
});

test("every firing reason the dispatcher names is one the routine firing CHECK allows", async () => {
  // The reason CHECK repeats the code's lists; a stacked migration that drops a reason fails here.
  const owner = await member(store);
  const routine = await new RoutineApi(store, () => new Date("2031-01-06T10:00:00.000Z")).create(owner.ownerId, {
    requestId: randomUUID(), memberId: owner.memberId, schedule: "*/15 * * * *", prompt: "reasons", approvalPolicy: "wait" });
  const reasons = [...skipReasons.map(reason => ["skipped", reason]), ...failReasons.map(reason => ["failed", reason])];
  assert.deepEqual([...auditEvents["routine.firing_settled"].payload.shape.reason.unwrap().options].sort(),
    [...skipReasons, ...failReasons].sort(), "the audit payload names the same reasons");
  for (const [index, [status, reason]] of reasons.entries()) {
    const identity = status === "skipped" ? [null, null] : [randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO birbcrew_ts.routine_firings (routine_id,scheduled_for,status,reason,conversation_id,request_id,recorded_at,settled_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp())`,
    [routine.routineId, new Date(Date.parse("2031-01-07T00:00:00.000Z") + index * 900_000), status, reason, ...identity]);
  }
  await assert.rejects(pool.query(`INSERT INTO birbcrew_ts.routine_firings (routine_id,scheduled_for,status,reason,conversation_id,request_id,recorded_at,settled_at)
    VALUES ($1,'2031-02-01T00:00:00Z','failed','usage_exceeded',$2,$3,clock_timestamp(),clock_timestamp())`,
  [routine.routineId, randomUUID(), randomUUID()]), { code: "23514" });
});

test("migration 031 completes while a native turn holds its admission", async (t) => {
  const upgraded = await databaseAt(t, 30);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  // A Codex turn's admission holds its native_launches row FOR SHARE for the whole native turn.
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'codex','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  const launch: Launch = { ownerId, conversationId, requestId, text, token: start.token, execution };
  await withNativeAdmission(upgraded, launch, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([migrateThrough(current, 31).then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 031 must not wait for a running native turn");
  });
  await current.migrate();
  await recordSegmentUsage(upgraded, launch, reported(3, 4));
  assert.equal((await upgraded.query("SELECT count(*)::integer AS n FROM birbcrew_ts.usage_ledger")).rows[0].n, 1);
});

test("a held installation refuses every usage write and still serves reads", async (t) => {
  const db = await databaseAt(t);
  const isolated = new MemberStore(db);
  const owner = await member(isolated);
  const segment = await launched(isolated, owner.ownerId, await conversation(isolated, owner));
  const api = new UsageApi(isolated);
  const directory = await mkdtemp(join(tmpdir(), "birbcrew-usage-hold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recovery = new InstallationRecovery(db, new FileRecoveryFence(join(directory, "fence")));
  await recovery.initializeFence();
  await recovery.freeze();
  await assert.rejects(recordSegmentUsage(db, segment.launch, reported(1, 1)), { code: "55000" });
  await assert.rejects(api.setBudget(owner.ownerId, owner.memberId, { tokenLimit: 5 }), { code: "55000" });
  assert.equal((await api.summary(owner.ownerId, {})).total.segments, 0);
  await recovery.resume({ reconcile: async () => {} });
  await recordSegmentUsage(db, segment.launch, reported(1, 1));
  assert.equal((await api.summary(owner.ownerId, {})).total.segments, 1);
});
