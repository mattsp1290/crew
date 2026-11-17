import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { CrewClient } from "@birbcrew/client";
import { decisionReceiptsCapabilityV1Schema } from "@birbcrew/client/contract";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { ownerInitiator } from "../../src/service/domain.ts";
import { MemberStore } from "../../src/service/store.ts";
import { gatewayFixture, validateResponse } from "./gateway-fixtures.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const approvals = new ApprovalStore(pool);
before(() => store.migrate());
after(() => pool.end());

/** An owner-admitted turn on the fixture's member, with its record_work_item card. */
async function admittedCard(f: Awaited<ReturnType<typeof gatewayFixture>>, conversationId = f.conversationId) {
  const { memberId } = await store.getConversation({ ownerId: f.ownerId, conversationId: f.conversationId });
  if (conversationId !== f.conversationId) await store.openConversation({ ownerId: f.ownerId, memberId, conversationId });
  const request = { ownerId: f.ownerId, conversationId, requestId: randomUUID(), text: "Record one receipt fixture" };
  await store.recordAcceptance(request, ownerInitiator);
  const turn = await store.beginTurn(request);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") throw new Error("unreachable");
  const card = await approvals.propose({ ownerId: f.ownerId, conversationId, memberId, requestId: request.requestId, token: turn.token, invocationId: request.requestId,
    nativeCallId: "receipt-" + request.requestId, toolName: "record_work_item", arguments: { operation_id: request.requestId } });
  const identity = { conversationId, memberId, requestId: request.requestId, invocationId: card.invocationId,
    approvalId: card.approvalId, version: 1 };
  const decide = (choice: string, decisionId?: string) => f.api(`/v1/conversations/${conversationId}/human`, {
    requestId: request.requestId, memberId, invocationId: card.invocationId, approvalId: card.approvalId, version: 1, choice,
    ...(decisionId && { decisionId }) });
  return { card, identity, decide };
}

test("decision receipts name a decision, replay it exactly and read it back with the approval detail identity", async t => {
  const f = await gatewayFixture(store); t.after(f.stop);
  const { memberId } = await store.getConversation({ ownerId: f.ownerId, conversationId: f.conversationId });
  const requestId = randomUUID();
  const turn = await store.beginTurn({ ownerId: f.ownerId, conversationId: f.conversationId, requestId, text: "receipts" });
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const proposal = { ownerId: f.ownerId, conversationId: f.conversationId, memberId, requestId, token: turn.token,
    nativeCallId: "receipt-call", toolName: "record_work_item" as const, arguments: { operation_id: requestId } };
  const card = await approvals.propose({ ...proposal, invocationId: requestId });
  const question = await approvals.propose({ ...proposal, invocationId: randomUUID(), nativeCallId: "receipt-question",
    toolName: "choose_next_step", arguments: {} });
  const identity = (approval = card) => ({ conversationId: f.conversationId, memberId, requestId,
    invocationId: approval.invocationId, approvalId: approval.approvalId, version: 1 });
  const path = (key = identity()) => `/v1/conversations/${key.conversationId}/requests/${key.requestId}/approvals/${key.approvalId}/decision`
    + `?memberId=${key.memberId}&invocationId=${key.invocationId}&version=${key.version}`;
  const human = (approval: typeof card, choice: string, decisionId?: string, credential = f.token) =>
    f.api(`/v1/conversations/${f.conversationId}/human`, { requestId, memberId, invocationId: approval.invocationId,
      approvalId: approval.approvalId, version: 1, choice, ...(decisionId && { decisionId }) }, credential);
  const client = new CrewClient({ baseUrl: f.endpoint, token: f.token });

  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.decisionReceipts, { version: 1, field: "decisionId",
    route: "/v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}/decision",
    tools: ["record_work_item", "choose_next_step"], replay: "same-decision-id-and-choice", conflictCode: "decision_conflict",
    unverifiableCode: "decision_unverifiable" });
  assert.ok(decisionReceiptsCapabilityV1Schema.safeParse(capabilities.decisionReceipts).success);

  const open = await f.api(path());
  assert.equal(open.status, 200);
  assert.equal(open.headers.get("cache-control"), "no-store");
  assert.deepEqual(await validateResponse("decisionRecord", open),
    { apiVersion: "1", ...identity(), toolName: "record_work_item", state: "undecided" });

  const mine = randomUUID();
  assert.equal((await human(card, "approve", "not-a-uuid")).status, 400);
  const first = await human(card, "approve", mine);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { approvalId: card.approvalId, decision: "approve", decisionId: mine });
  assert.deepEqual(await client.decide({ conversationId: f.conversationId, requestId, memberId, invocationId: requestId,
    approvalId: card.approvalId, version: 1, choice: "approve", decisionId: mine.toUpperCase() }),
  { approvalId: card.approvalId, decision: "approve", decisionId: mine });
  assert.deepEqual(await (await human(card, "approve")).json(), { approvalId: card.approvalId, decision: "approve" });
  for (const [choice, decisionId] of [["deny", mine], ["approve", randomUUID()]] as const) {
    const refused = await human(card, choice, decisionId);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "decision_conflict" });
  }
  await assert.rejects(client.decide({ conversationId: f.conversationId, requestId, memberId, invocationId: requestId,
    approvalId: card.approvalId, version: 1, choice: "approve", decisionId: randomUUID() }), { status: 409, code: "decision_conflict" });
  assert.deepEqual(await (await human(card, "deny")).json(), { error: "conflict" });
  assert.equal((await human(card, "approve", mine, f.stranger)).status, 404);

  const decidedAt = (await pool.query<{ at: Date }>(`SELECT occurred_at AS at FROM birbcrew_ts.audit_events
    WHERE event_type='approval.decided' AND payload->>'approvalId'=$1`, [card.approvalId])).rows[0].at.toISOString();
  const decided = { apiVersion: "1", ...identity(), toolName: "record_work_item", state: "decided", decisionId: mine,
    choice: "approve", recordedAt: decidedAt, effect: { kind: "none" } };
  assert.deepEqual(await client.decisionRecord(identity()), decided);
  const { version: _, ...settleKey } = identity();
  const outcome = await approvals.settle({ ...settleKey, ownerId: f.ownerId, nativeCallId: proposal.nativeCallId, token: turn.token });
  assert.equal(outcome.kind, "recorded");
  assert.deepEqual(await client.decisionRecord(identity()),
    { ...decided, effect: { kind: "work_item", receiptId: outcome.kind === "recorded" && outcome.receipt.receiptId } });

  assert.equal((await f.api(path(identity(question)).replace("/decision", ""))).status, 404, "approval detail stays record_work_item only");
  assert.equal((await client.decisionRecord(identity(question))).state, "undecided");
  const answer = randomUUID();
  assert.deepEqual(await (await human(question, "test", answer)).json(), { approvalId: question.approvalId, decision: "test", decisionId: answer });
  const read = await client.decisionRecord(identity(question));
  assert.ok(read.state === "decided");
  assert.deepEqual([read.toolName, read.decisionId, read.choice], ["choose_next_step", answer, "test"]);

  const legacy = await approvals.propose({ ...proposal, invocationId: randomUUID(), nativeCallId: "receipt-legacy",
    toolName: "choose_next_step", arguments: {} });
  assert.deepEqual(await (await human(legacy, "inspect")).json(), { approvalId: legacy.approvalId, decision: "inspect" });
  for (const [choice, error] of [["inspect", "decision_unverifiable"], ["test", "decision_conflict"]] as const) {
    const refused = await human(legacy, choice, randomUUID());
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error }, choice);
  }
  const unnamed = await client.decisionRecord(identity(legacy));
  assert.ok(unnamed.state === "decided");
  assert.deepEqual([unnamed.decisionId, unnamed.choice], [null, "inspect"]);

  for (const field of ["conversationId", "memberId", "requestId", "invocationId", "approvalId"] as const) {
    const denied = await f.api(path({ ...identity(), [field]: randomUUID() }));
    assert.equal(denied.status, 404, field);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.deepEqual(await denied.json(), { error: "not_found" });
  }
  for (const version of [0, 2]) assert.equal((await f.api(path({ ...identity(), version }))).status, 404);
  const foreign = await f.api(path(), undefined, f.stranger);
  assert.equal(foreign.status, 404); assert.deepEqual(await foreign.json(), { error: "not_found" });
  assert.equal((await f.api(path(), {})).status, 405);
  for (const suffix of ["&extra=x", "&version=1", "&decisionId=" + mine]) assert.equal((await f.api(path() + suffix)).status, 400, suffix);
  assert.equal((await f.api(path().split("?")[0])).status, 400);
  assert.equal((await f.api(path().replace("/decision", "/decisions"))).status, 404);
  assert.equal(f.counts().effects, 0);
});

test("concurrent first decisions with different ids through the gateway commit one and refuse the other as decision_conflict", async t => {
  const f = await gatewayFixture(store); t.after(f.stop);
  const { identity, decide } = await admittedCard(f);
  const ids = [randomUUID(), randomUUID()];
  const replies = await Promise.all(ids.map(id => decide("approve", id)));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const won = replies.findIndex(reply => reply.status === 200);
  assert.deepEqual(await replies[won].json(), { approvalId: identity.approvalId, decision: "approve", decisionId: ids[won] });
  assert.deepEqual(await replies[1 - won].json(), { error: "decision_conflict" });
  const record = await new CrewClient({ baseUrl: f.endpoint, token: f.token }).decisionRecord(identity);
  assert.ok(record.state === "decided");
  assert.equal(record.decisionId, ids[won]);
  const { rows: [{ decided }] } = await pool.query<{ decided: number }>(`SELECT count(*)::integer AS decided FROM birbcrew_ts.audit_events
    WHERE event_type='approval.decided' AND payload->>'approvalId'=$1`, [identity.approvalId]);
  assert.equal(decided, 1);
});

test("an auto-approved card whose audit row is missing fails the read instead of inventing its time", async t => {
  const f = await gatewayFixture(store); t.after(f.stop);
  const granting = await admittedCard(f);
  assert.equal((await granting.decide("allow_always", randomUUID())).status, 200);
  const { card, identity } = await admittedCard(f, randomUUID());
  assert.ok(card.grantId);
  const path = `/v1/conversations/${identity.conversationId}/requests/${identity.requestId}/approvals/${identity.approvalId}/decision`
    + `?memberId=${identity.memberId}&invocationId=${identity.invocationId}&version=1`;
  const read = await f.api(path);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).state, "auto_approved");
  await store.transaction(async db => {
    await db.query("ALTER TABLE birbcrew_ts.audit_events DISABLE TRIGGER audit_events_append_only");
    const removed = await db.query(`DELETE FROM birbcrew_ts.audit_events
      WHERE event_type='approval.auto_approved' AND payload->>'approvalId'=$1`, [identity.approvalId]);
    assert.equal(removed.rowCount, 1);
    await db.query("ALTER TABLE birbcrew_ts.audit_events ENABLE TRIGGER audit_events_append_only");
  });
  const damaged = await f.api(path);
  assert.equal(damaged.status, 503);
  assert.deepEqual(await damaged.json(), { error: "retry_same_request" });
});
