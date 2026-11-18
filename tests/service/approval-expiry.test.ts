import { migrateThrough, testDatabaseName } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@temporalio/client";
import { Pool } from "pg";
import { ApprovalStore, type Approval, type Decision } from "../../src/service/approvals.ts";
import { MemberClient } from "../../src/service/client.ts";
import { proposeLive } from "../../src/service/codex-calls.ts";
import { ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { readSnapshot } from "../../src/service/observation.ts";
import { RoutineApi, RoutineDispatcher, routineLimits } from "../../src/service/routines.ts";
import { MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const approvals = new ApprovalStore(pool);
before(() => store.migrate());
after(() => pool.end());
const sql = new URL("../../src/service/sql/", import.meta.url);

/** Moves a card's deadline to now, as the passage of time would. */
async function pastDeadline(db: Pool, card: Approval) {
  await db.query("UPDATE birbcrew_ts.deferred_calls SET expires_at=clock_timestamp() WHERE approval_id=$1", [card.approvalId]);
  return (await db.query<{ at: Date }>("SELECT expires_at AS at FROM birbcrew_ts.deferred_calls WHERE approval_id=$1",
    [card.approvalId])).rows[0].at.toISOString();
}

function address(card: Approval) {
  const { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId } = card;
  return { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId };
}

function answer(card: Approval, choice: Decision["choice"]): Decision {
  return { ...address(card), argumentDigest: card.argumentDigest, version: card.version, choice };
}

/** One owner and member behind a real gateway. The MemberClient is real; its Temporal client
 * runs each update as the conversation workflow's handler would, through the same store calls. */
async function owner(t: TestContext, engine: "pi" | "claude" = "pi") {
  const ownerId = "owner-" + randomUUID(), token = randomUUID(), stranger = randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine, profile: "expiry.v1" });
  const temporal = {
    connection: { withDeadline: (_deadline: number, action: () => Promise<unknown>) => action() },
    workflow: {
      start: async () => {},
      getHandle: () => ({
        describe: async () => ({ status: { name: "RUNNING" } }),
        async executeUpdate(name: string, { args: [value] }: { args: [never] }) {
          if (name === "acceptTurn") { await store.recordAcceptance(value, ownerInitiator); return (value as TurnRequest).requestId; }
          if (name === "decide") return approvals.decide(value);
          if (name === "cancelPending") return approvals.cancelTurn({ ...(value as object), memberId: member.memberId } as never);
          throw new Error("Unexpected update " + name);
        },
      }),
    },
  } as unknown as Client;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const server = createGateway(store, new MemberClient(store, temporal), { [hash(token)]: ownerId, [hash(stranger)]: "owner-" + randomUUID() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const port = bound.port;
  t.after(async () => {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections();
    await closed; await server.stopped();
  });
  async function api(path: string, body?: unknown, credential = token) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  /** A request submitted through the v1 route whose turn has started, as the worker starts it. */
  async function started(deadline?: number) {
    const conversationId = randomUUID(), requestId = randomUUID(), text = "record one item";
    assert.equal((await api("/v1/conversations", { conversationId, memberId: member.memberId })).status, 201);
    const terms = deadline === undefined ? {} : { approvalDeadlineSeconds: deadline };
    const submitted = await api(`/v1/conversations/${conversationId}/requests`, { requestId, text, ...terms });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const turn = await store.beginTurn({ ownerId, conversationId, requestId, text, ...terms },
      { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 });
    assert.equal(turn.kind, "start"); if (turn.kind !== "start") throw new Error("unreachable");
    const scope = { ownerId, memberId: member.memberId, conversationId, requestId };
    const checkpoint = { version: 1 as const, engine, state: {} };
    return {
      ...scope, token: turn.token,
      propose: (tool: "record_work_item" | "choose_next_step" = "record_work_item") => approvals.propose({ ...scope, token: turn.token,
        invocationId: requestId, nativeCallId: "call-" + requestId, toolName: tool,
        arguments: tool === "record_work_item" ? { operation_id: requestId } : {} }, checkpoint),
      decide: (card: Approval, choice: string) => api(`/v1/conversations/${conversationId}/human`, { memberId: member.memberId,
        requestId, invocationId: card.invocationId, approvalId: card.approvalId, version: card.version, choice }),
      settle: (card: Approval) => approvals.settle({ ...address(card), token: turn.token }),
      commit: () => store.commitTurn({ ownerId, conversationId, requestId, token: turn.token, reply: "done", checkpoint }),
      receipt: async () => (await api(`/v1/conversations/${conversationId}/requests/${requestId}`)).body,
      snapshot: () => readSnapshot(pool, ownerId, conversationId),
      audit: async () => (await pool.query(`SELECT event_type AS type, actor_kind AS actor, actor_id AS "actorId",
          initiator_kind AS initiator, payload FROM birbcrew_ts.audit_events
        WHERE conversation_id=$1 AND (request_id=$2 OR request_id IS NULL) ORDER BY event_id`, [conversationId, requestId])).rows,
    };
  }
  return { ownerId, member, stranger, api, started };
}

test("an approval deadline is bounded, strict, part of a request's identity and shown on its receipt", async (t) => {
  const o = await owner(t);
  const conversationId = randomUUID(), path = `/v1/conversations/${conversationId}/requests`;
  assert.equal((await o.api("/v1/conversations", { conversationId, memberId: o.member.memberId })).status, 201);
  for (const bad of [59, 604_801, 90.5, "120", null, -60, 0]) {
    assert.deepEqual(await o.api(path, { requestId: randomUUID(), text: "bad", approvalDeadlineSeconds: bad }),
      { status: 400, body: { error: "invalid_input" } }, String(bad));
  }
  const requestId = randomUUID(), body = { requestId, text: "bounded", approvalDeadlineSeconds: 60 };
  const first = await o.api(path, body);
  assert.equal(first.status, 202);
  assert.equal(first.body.approvalDeadlineSeconds, 60);
  assert.deepEqual(await o.api(path, body), first, "a retry is the same request");
  for (const changed of [{ ...body, approvalDeadlineSeconds: 61 }, { requestId, text: "bounded" }]) {
    assert.deepEqual(await o.api(path, changed), { status: 409, body: { error: "conflict" } });
  }
  const unbounded = randomUUID();
  const plain = await o.api(path, { requestId: unbounded, text: "unbounded" });
  assert.equal(plain.status, 202);
  assert.ok(!("approvalDeadlineSeconds" in plain.body), "a client that names no deadline sees the receipt it saw before");
  assert.deepEqual(await o.api(path, { requestId: unbounded, text: "unbounded", approvalDeadlineSeconds: 604_800 }),
    { status: 409, body: { error: "conflict" } });
  assert.equal((await o.api(path, { requestId: randomUUID(), text: "longest", approvalDeadlineSeconds: 604_800 })).status, 202);
  assert.deepEqual(await o.api(`${path}/${requestId}`, undefined, o.stranger), { status: 404, body: { error: "not_found" } });
  // Fixed at admission and bounded in SQL as well.
  await assert.rejects(pool.query(`UPDATE birbcrew_ts.request_admissions SET approval_deadline_seconds=120
    WHERE conversation_id=$1 AND request_id=$2`, [conversationId, requestId]), { code: "23514" });
  await assert.rejects(pool.query(`INSERT INTO birbcrew_ts.request_admissions
    (conversation_id,request_id,prompt_digest,initiator_kind,approval_deadline_seconds) VALUES ($1,$2,$3,'owner',59)`,
  [conversationId, randomUUID(), createHash("sha256").update("x").digest()]), { code: "23514" });
  const { body: capabilities } = await o.api("/v1/capabilities");
  assert.deepEqual([capabilities.approvalExpiry.minimumSeconds, capabilities.approvalExpiry.maximumSeconds], [60, 604_800]);
});

test("a card shows its deadline; a decision before it wins and the deadline then changes nothing", async (t) => {
  const o = await owner(t);
  const r = await o.started(600);
  const proposed = Date.now();
  const card = await r.propose();
  const remaining = Date.parse(card.expiresAt!) - proposed;
  assert.ok(remaining > 590_000 && remaining < 610_000, String(remaining));
  assert.deepEqual((await r.snapshot()).state.pendingApprovals.map(c => c.expiresAt), [card.expiresAt]);
  const early = await approvals.expireTurn(card);
  assert.ok(early.kind === "early" && early.remainingMs > 590_000 && early.remainingMs <= 600_000, JSON.stringify(early));
  assert.deepEqual(await r.decide(card, "deny"), { status: 200, body: { approvalId: card.approvalId, decision: "deny" } });
  assert.deepEqual(await approvals.expireTurn(card), { kind: "settled" });
  await pastDeadline(pool, card);
  assert.deepEqual(await approvals.expireTurn(card), { kind: "settled" }, "a decided card never expires");
  assert.deepEqual(await r.decide(card, "deny"), { status: 200, body: { approvalId: card.approvalId, decision: "deny" } },
    "repeating the answer given in time still returns it");
  assert.equal((await r.decide(card, "approve")).status, 409);
  assert.equal((await r.settle(card)).kind, "denied");
  assert.equal((await r.receipt()).expiredApproval, undefined);
  assert.deepEqual((await r.audit()).map(row => row.type), ["conversation.opened", "request.accepted", "approval.requested", "approval.decided"]);

  const plain = await o.started();
  const unbounded = await plain.propose();
  assert.equal(unbounded.expiresAt, undefined);
  assert.ok(!("expiresAt" in (await plain.snapshot()).state.pendingApprovals[0]));
  await assert.rejects(approvals.expireTurn(unbounded), { code: "conflict" });
});

test("a card nobody decides expires once, cancelling its request distinguishably from a deny and a cancel", async (t) => {
  const o = await owner(t);
  const r = await o.started(60);
  const card = await r.propose();
  const expiresAt = await pastDeadline(pool, card);
  // Past the deadline the card cannot be decided, even before Crew records the expiry.
  assert.deepEqual(await r.decide(card, "approve"), { status: 409, body: { error: "conflict" } });
  await assert.rejects(approvals.decide(answer(card, "approve")), { code: "conflict" });
  assert.deepEqual(await approvals.pending({ ownerId: o.ownerId, memberId: o.member.memberId, conversationId: r.conversationId }), []);
  // A retried settling activity records one expiry.
  assert.deepEqual(await Promise.all([approvals.expireTurn(card), approvals.expireTurn(card)]), [{ kind: "expired" }, { kind: "expired" }]);
  assert.deepEqual(await approvals.expireTurn(card), { kind: "expired" });
  const { rows: [row] } = await pool.query<{ expired_at: Date }>("SELECT expired_at FROM birbcrew_ts.deferred_calls WHERE approval_id=$1",
    [card.approvalId]);
  const expiredAt = row.expired_at.toISOString();
  assert.ok(expiredAt >= expiresAt);

  const { state } = await r.snapshot();
  assert.deepEqual([state.pendingApprovals, state.phase], [[], "running"]);
  assert.deepEqual(state.expiredCalls, [{ requestId: r.requestId, approvalId: card.approvalId, expiresAt, expiredAt }]);
  const running = await r.receipt();
  assert.equal(running.status, "running");
  assert.deepEqual(running.expiredApproval, { approvalId: card.approvalId, expiresAt, expiredAt });
  assert.equal(running.cancellation, undefined);
  assert.deepEqual(await r.decide(card, "approve"), { status: 409, body: { error: "conflict" } }, "refused like a settled card");
  // The native call gets the cancelled result an owner's cancel gives it, and nothing is recorded.
  assert.deepEqual(await r.settle(card), { nativeCallId: card.nativeCallId, kind: "cancelled" });
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.work_items WHERE approval_id=$1", [card.approvalId])).rowCount, 0);
  await assert.rejects(approvals.propose({ ownerId: o.ownerId, memberId: o.member.memberId, conversationId: r.conversationId,
    requestId: r.requestId, token: r.token, invocationId: r.requestId, nativeCallId: "later", toolName: "record_work_item",
    arguments: { operation_id: r.requestId } }), { code: "conflict" }, "the request is closed to later calls");
  // A cancel afterwards changes nothing.
  assert.equal((await o.api(`/conversations/${r.conversationId}/cancel`, { requestId: r.requestId })).status, 202);
  await r.commit();
  const completed = await r.receipt();
  assert.deepEqual([completed.status, completed.expiredApproval], ["completed", running.expiredApproval]);
  assert.equal((await r.snapshot()).state.phase, "cancelled");
  const audit = await r.audit();
  assert.deepEqual(audit.map(event => event.type), ["conversation.opened", "request.accepted", "approval.requested", "approval.expired",
    "request.finished"]);
  assert.deepEqual(audit[3], { type: "approval.expired", actor: "system", actorId: null, initiator: "owner",
    payload: { approvalId: card.approvalId, invocationId: r.requestId, toolName: "record_work_item", expiresAt } });

  // An owner's deny and an owner's cancel leave none of these marks.
  const denied = await o.started(60);
  await denied.decide(await denied.propose(), "deny");
  const cancelled = await o.started(60);
  await cancelled.propose();
  assert.equal((await o.api(`/conversations/${cancelled.conversationId}/cancel`, { requestId: cancelled.requestId })).status, 202);
  for (const [other, fact] of [[denied, "approval.decided"], [cancelled, "request.cancellation_requested"]] as const) {
    await other.commit();
    assert.equal((await other.receipt()).expiredApproval, undefined);
    assert.equal((await other.snapshot()).state.expiredCalls, undefined);
    const types = (await other.audit()).map(event => event.type);
    assert.ok(types.includes(fact) && !types.includes("approval.expired"), types.join());
  }
});

test("a question expires the same way", async (t) => {
  const o = await owner(t, "claude");
  const r = await o.started(120);
  const question = await r.propose("choose_next_step");
  const [shown] = (await r.snapshot()).state.pendingQuestions!;
  assert.deepEqual([shown.expiresAt, shown.choices], [question.expiresAt, ["inspect", "test"]]);
  const expiresAt = await pastDeadline(pool, question);
  assert.deepEqual(await r.decide(question, "inspect"), { status: 409, body: { error: "conflict" } });
  assert.deepEqual(await approvals.expireTurn(question), { kind: "expired" });
  const { state } = await r.snapshot();
  assert.deepEqual([state.pendingQuestions, state.expiredCalls?.map(call => call.approvalId)], [[], [question.approvalId]]);
  assert.deepEqual(await r.settle(question), { nativeCallId: question.nativeCallId, kind: "cancelled" });
  const [expiry] = (await r.audit()).filter(event => event.type === "approval.expired");
  assert.deepEqual(expiry.payload, { approvalId: question.approvalId, invocationId: r.requestId, toolName: "choose_next_step", expiresAt });
});

test("a decision racing the deadline leaves exactly one outcome, and SQL refuses a second", async (t) => {
  const o = await owner(t);
  const won = { decision: 0, expiry: 0 };
  for (let i = 0; i < 24; i++) {
    const r = await o.started(60);
    const card = await r.propose();
    await pool.query(`UPDATE birbcrew_ts.deferred_calls SET expires_at=clock_timestamp() + make_interval(secs => $2::float8 / 1000)
      WHERE approval_id=$1`, [card.approvalId, (i % 6) * 3]);
    const expire = async () => {
      for (;;) {
        const expiry = await approvals.expireTurn(card);
        if (expiry.kind !== "early") return expiry;
      }
    };
    const [decision, expiry] = await Promise.allSettled([approvals.decide(answer(card, "approve")), expire()]);
    assert.equal(expiry.status, "fulfilled");
    const { rows: [call] } = await pool.query("SELECT decision, expired_at FROM birbcrew_ts.deferred_calls WHERE approval_id=$1",
      [card.approvalId]);
    won[decision.status === "fulfilled" ? "decision" : "expiry"]++;
    if (decision.status === "fulfilled") {
      assert.deepEqual([expiry.status === "fulfilled" && expiry.value, call.decision, call.expired_at], [{ kind: "settled" }, "approve", null]);
    } else {
      assert.equal((decision.reason as { code?: string }).code, "conflict");
      assert.deepEqual(expiry.status === "fulfilled" && expiry.value, { kind: "expired" });
      assert.equal(call.decision, null);
      assert.ok(call.expired_at);
    }
    const facts = (await r.audit()).filter(event => event.type === "approval.decided" || event.type === "approval.expired");
    assert.equal(facts.length, 1);
  }
  t.diagnostic(JSON.stringify(won));
  const expired = await o.started(60);
  const lapsed = await expired.propose();
  await pastDeadline(pool, lapsed);
  await approvals.expireTurn(lapsed);
  await assert.rejects(pool.query("UPDATE birbcrew_ts.deferred_calls SET decision='approve' WHERE approval_id=$1", [lapsed.approvalId]),
    { code: "23514" });
  const decided = await o.started(60);
  const answered = await decided.propose();
  await approvals.decide(answer(answered, "approve"));
  await assert.rejects(pool.query("UPDATE birbcrew_ts.deferred_calls SET expired_at=clock_timestamp() + interval '1 hour' WHERE approval_id=$1",
    [answered.approvalId]), { code: "23514" });
});

test("on Codex the earlier of the live-call deadline and the request's deadline is the card's", async () => {
  for (const deadline of [60, 600, undefined]) {
    const ownerId = "owner-" + randomUUID(), profile = "live-" + randomUUID();
    await pool.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,volume,protected_tool)
      VALUES ($1,'codex',$2,$3,'record_work_item')`, [profile, Buffer.alloc(32), randomUUID()]);
    const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "codex", profile });
    const conversationId = randomUUID(), requestId = randomUUID();
    await store.openConversation({ ownerId, memberId: member.memberId, conversationId });
    const request = { ownerId, conversationId, requestId, text: "one live turn", ...(deadline && { approvalDeadlineSeconds: deadline }) };
    await store.recordAcceptance(request, ownerInitiator);
    const execution = { workflowRunId: randomUUID(), activityId: "sdk", attempt: 1 };
    const start = await store.beginTurn(request, execution);
    assert.equal(start.kind, "start"); if (start.kind !== "start") return;
    await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
      VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
    const live = new Date(Date.now() + 160_000).toISOString();
    const card = await proposeLive(pool, { ...request, execution, token: start.token }, { threadId: randomUUID(), nativeCallId: "call",
      toolName: "record_work_item", args: { operation_id: requestId }, expiresAt: live });
    const { rows: [row] } = await pool.query<{ live: Date; card: Date | null }>(`SELECT l.expires_at AS live, p.expires_at AS card
      FROM birbcrew_ts.codex_live_calls l JOIN birbcrew_ts.deferred_calls p USING (approval_id) WHERE approval_id=$1`, [card.approvalId]);
    assert.equal(row.card, null, "the live-call machinery, not the workflow, enforces a Codex card's deadline");
    const shown = (await readSnapshot(pool, ownerId, conversationId)).state.pendingApprovals[0].expiresAt!;
    assert.equal(shown, row.live.toISOString());
    if (deadline === 60) {
      const left = Date.parse(shown) - Date.now();
      assert.ok(left > 50_000 && left <= 61_000 && shown < live, `${shown} ${live}`);
    } else assert.equal(shown, live, String(deadline));
  }
});

// Windows of "*/15 * * * *" fall on quarter hours; nothing these tests schedule is due on the real clock.
const T0 = "2031-01-06T10:00:00.000Z";
const window = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000);

/** A database migrated up to `version` (all of them by default); dropped after the test. */
async function databaseAt(t: TestContext, version = Infinity) {
  const name = testDatabaseName("expiry_");
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
    if (applied > version) continue;
    await db.query(await readFile(new URL(file, sql), "utf8"));
    await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return db;
}

test("a routine's deadline applies to every firing, and an expired card fails the firing as a counted failure", async (t) => {
  const db = await databaseAt(t);
  const local = new MemberStore(db), ledger = new ApprovalStore(db);
  let now = new Date(T0);
  const clock = () => new Date(now);
  const ownerId = "owner-" + randomUUID();
  const member = await local.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  let beforeAdmission: ((input: TurnRequest) => Promise<void>) | undefined;
  const members = {
    async open(input: Parameters<MemberStore["openConversation"]>[0]) { return local.openConversation(input); },
    async accept(input: TurnRequest) {
      await beforeAdmission?.(input);
      await local.recordAcceptance(input, ownerInitiator);
      return { requestId: input.requestId };
    },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return local.requestStatus(input); },
    async cancelPending() {},
  } as unknown as MemberClient;
  const integration = new IntegrationApi(local, members);
  const routines = new RoutineApi(local, clock);
  const definition = { memberId: member.memberId, schedule: "*/15 * * * *", prompt: "scheduled prompt", approvalPolicy: "wait" };
  for (const bad of [59, 604_801, 1.5, "60", null]) {
    await assert.rejects(routines.create(ownerId, { ...definition, requestId: randomUUID(), approvalDeadlineSeconds: bad }),
      { name: "ZodError" }, String(bad));
  }
  const createRequest = randomUUID();
  const routine = await routines.create(ownerId, { ...definition, requestId: createRequest, approvalDeadlineSeconds: 120 });
  assert.equal(routine.approvalDeadlineSeconds, 120);
  assert.deepEqual(await routines.create(ownerId, { ...definition, requestId: createRequest, approvalDeadlineSeconds: 120 }), routine);
  for (const changed of [{ approvalDeadlineSeconds: 300 }, {}]) {
    await assert.rejects(routines.create(ownerId, { ...definition, requestId: createRequest, ...changed }), { code: "conflict" });
  }
  assert.ok(!("approvalDeadlineSeconds" in await routines.create(ownerId, { ...definition, requestId: randomUUID(), prompt: "unbounded" })));
  const { rows: [created] } = await db.query(`SELECT payload FROM birbcrew_ts.audit_events WHERE event_type='routine.created'
    AND payload->>'routineId'=$1`, [routine.routineId]);
  assert.equal(created.payload.approvalDeadlineSeconds, 120);
  await assert.rejects(db.query("UPDATE birbcrew_ts.routines SET approval_deadline_seconds=300 WHERE routine_id=$1", [routine.routineId]),
    { code: "23514" }, "the deadline is part of the immutable definition");

  const dispatcher = new RoutineDispatcher({ store: local, members, integration, owners: [ownerId], clock });
  await dispatcher.tick();
  now = window(15);
  beforeAdmission = async (input) => {
    if (input.text !== definition.prompt) return;
    beforeAdmission = undefined;
    assert.equal(input.approvalDeadlineSeconds, 120);
    // Only the routine's deadline can be admitted under a firing's identity.
    for (const other of [300, undefined]) {
      await assert.rejects(local.recordAcceptance({ ...input, approvalDeadlineSeconds: other }, ownerInitiator), { code: "conflict" });
    }
  };
  await dispatcher.tick();
  const firing = async () => (await db.query(`SELECT status, reason, conversation_id AS "conversationId", request_id AS "requestId"
    FROM birbcrew_ts.routine_firings WHERE routine_id=$1`, [routine.routineId])).rows[0];
  const { conversationId, requestId, status } = await firing();
  assert.equal(status, "admitted");
  const key = { ownerId, conversationId, requestId };
  const receipt = await integration.status(key);
  assert.deepEqual([receipt.approvalDeadlineSeconds, receipt.initiator], [120, { kind: "routine", id: routine.routineId }]);

  const request = { ...key, text: definition.prompt, approvalDeadlineSeconds: 120 };
  const turn = await local.beginTurn(request, { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const checkpoint = { version: 1 as const, engine: "pi" as const, state: {} };
  const card = await ledger.propose({ ...key, memberId: member.memberId, token: turn.token, invocationId: requestId,
    nativeCallId: "call", toolName: "record_work_item", arguments: { operation_id: requestId } }, checkpoint);
  assert.ok(card.expiresAt);
  now = new Date(now.getTime() + routineLimits.observeEveryMs);
  await dispatcher.tick();
  assert.deepEqual(await firing(), { status: "waiting", reason: null, conversationId, requestId });
  await pastDeadline(db, card);
  assert.deepEqual(await ledger.expireTurn(card), { kind: "expired" });
  await local.commitTurn({ ...key, token: turn.token, reply: "done", checkpoint });
  now = new Date(now.getTime() + routineLimits.observeEveryMs);
  await dispatcher.tick();
  assert.deepEqual(await firing(), { status: "failed", reason: "approval_expired", conversationId, requestId });
  const { rows: [counted] } = await db.query("SELECT consecutive_failures FROM birbcrew_ts.routines WHERE routine_id=$1", [routine.routineId]);
  assert.equal(counted.consecutive_failures, 1, "an expiry counts toward the ten that disable a routine");
  const { rows: facts } = await db.query(`SELECT event_type AS type, actor_kind AS actor, initiator_kind AS initiator, payload
    FROM birbcrew_ts.audit_events WHERE event_type IN ('approval.expired','routine.firing_settled') ORDER BY event_id`);
  assert.deepEqual(facts.map(fact => [fact.type, fact.actor, fact.initiator]),
    [["approval.expired", "system", "routine"], ["routine.firing_settled", "system", "owner"]]);
  assert.deepEqual([facts[1].payload.status, facts[1].payload.reason], ["failed", "approval_expired"]);
});

test("migration 028 rewrites no table, adds only NOT VALID constraints, and never queues for a lock", async (t) => {
  const upgraded = await databaseAt(t, 27);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID();
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const digest = createHash("sha256").update("x").digest();
  await upgraded.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind)
    VALUES ($1,$2,$3,'owner')`, [conversationId, requestId, digest]);
  const tables = ["deferred_calls", "request_admissions", "routines", "routine_firings", "audit_events"];
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = `SELECT ${tables.map(table => `pg_relation_filenode('birbcrew_ts.${table}') AS ${table}`).join(",")}`;
    const { rows: [before] } = await db.query(files);
    await db.query(await readFile(new URL("028-approval-expiry.sql", sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], before, "no table is rewritten");
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "audit_events", mode: "AccessExclusiveLock" }, { relation: "audit_events", mode: "ShareLock" },
      { relation: "deferred_calls", mode: "AccessExclusiveLock" },
      { relation: "request_admissions", mode: "AccessExclusiveLock" }, { relation: "request_admissions", mode: "ShareRowExclusiveLock" },
      { relation: "routine_firings", mode: "AccessExclusiveLock" }, { relation: "routines", mode: "AccessExclusiveLock" },
    ]);
    const { rows: constraints } = await db.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conname IN ('request_admissions_approval_deadline_check','deferred_calls_expiry_check','routines_approval_deadline_check',
        'routine_firings_reason_check','audit_events_type_check') ORDER BY 1`);
    assert.ok(constraints.length === 5 && constraints.every(row => row.validated === false), JSON.stringify(constraints));
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  // An admission holds request_admissions and then appends its audit row: the order in which a
  // queued exclusive lock on audit_events would deadlock it.
  const holder = await upgraded.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
    await holder.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind)
      VALUES ($1,$2,$3,'owner')`, [conversationId, randomUUID(), digest]);
    let migrated = false;
    const migrating = new MemberStore(upgraded).migrate().then(() => { migrated = true; });
    for (let i = 0; i < 10; i++) {
      await delay(30);
      const { rows: waiting } = await upgraded.query(`SELECT pid FROM pg_locks WHERE NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      assert.deepEqual(waiting, [], "the migration retries instead of queueing");
    }
    assert.equal(migrated, false);
    const appended = Date.now();
    await holder.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,conversation_id,request_id,payload)
      VALUES ($1,'owner',$1,'owner',$1,'request.accepted',$2,$3,$4,'{"promptDigest":"${"0".repeat(64)}"}')`, [ownerId, memberId, conversationId, randomUUID()]);
    assert.ok(Date.now() - appended < 1_000, "the admission's audit append is not held up");
    await holder.query("COMMIT");
    await migrating;
  } finally { holder.release(); }
  const { rows: versions } = await upgraded.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version=28");
  assert.equal(versions.length, 1);
  // A request admitted before the upgrade has no deadline: its receipt reads as it did.
  const members = { async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return new MemberStore(upgraded).requestStatus(input); } } as unknown as MemberClient;
  const receipt = await new IntegrationApi(new MemberStore(upgraded), members).status({ ownerId, conversationId, requestId });
  assert.deepEqual([receipt.status, "approvalDeadlineSeconds" in receipt, "expiredApproval" in receipt], ["accepted", false, false]);
});

test("migration 028 completes while a native turn holds its admission", async (t) => {
  const upgraded = await databaseAt(t, 27);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  await withNativeAdmission(upgraded, { ownerId, conversationId, requestId, text, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([migrateThrough(current, 28).then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 028 must not wait for a running native turn");
  });
  await current.migrate();
  await current.commitTurn({ ownerId, conversationId, requestId, token: start.token, reply: "still running", checkpoint: { version: 1, engine: "pi", state: {} } });
});
