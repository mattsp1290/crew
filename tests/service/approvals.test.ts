import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { ApprovalStore, readDecisionRecord, type Approval } from "../../src/service/approvals.ts";
import { ChildStore } from "../../src/service/children.ts";
import { ownerInitiator } from "../../src/service/domain.ts";
import { publishObservation, readSnapshot } from "../../src/service/observation.ts";
import { MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database");
const pool = new Pool({ connectionString: url });
const members = new MemberStore(pool);
const approvals = new ApprovalStore(pool);
before(async () => { await members.migrate(); await Promise.all([approvals.migrate(), approvals.migrate()]); });
after(() => pool.end());

async function input(engine: "claude" | "pi", admission?: { approvalDeadlineSeconds?: number }) {
  const ownerId = randomUUID();
  const { memberId } = await members.spawn({ ownerId, requestId: randomUUID(), engine, profile: "approvals.v1" });
  const conversation = { ownerId, memberId, conversationId: randomUUID() };
  await members.openConversation(conversation);
  const { conversationId } = conversation;
  const requestId = randomUUID();
  const request = { ownerId, conversationId, requestId, text: "Record one fixture work item", ...admission };
  if (admission) await members.recordAcceptance(request, ownerInitiator);
  const turn = await members.beginTurn(request);
  assert.equal(turn.kind, "start");
  const scope = { ...conversation, requestId };
  const proposal = {
    ...scope, token: turn.token, invocationId: requestId, nativeCallId: "tool-id", toolName: "record_work_item" as const,
    arguments: { operation_id: requestId, note: "private-fixture-note" },
  };
  return { scope, conversation, proposal, token: turn.token };
}

function address(approval: Approval) {
  const { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId } = approval;
  return { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId };
}

function decision(approval: Approval, choice: "approve" | "deny") {
  return { ...address(approval), argumentDigest: approval.argumentDigest, version: approval.version, choice };
}

async function writes(conversationId: string) {
  const { rows } = await pool.query<{ approval_id: string; receipt_id: string; note: string }>(
    "SELECT approval_id, receipt_id, note FROM birbcrew_ts.work_items WHERE conversation_id = $1", [conversationId],
  );
  return rows;
}

for (const engine of ["pi", "claude"] as const) {
  test(`${engine} approval gates the actual write and replays its receipt after a lost acknowledgement`, async () => {
    const { conversation, scope, proposal, token } = await input(engine);
    await assert.rejects(approvals.propose({ ...proposal, arguments: { operation_id: randomUUID() } }), { code: "conflict" });
    assert.deepEqual(await approvals.pending(conversation), []);
    await assert.rejects(approvals.pending({ ...conversation, ownerId: "other" }), { code: "not_found" });
    const [a, b] = await Promise.all([approvals.propose(proposal), approvals.propose(proposal)]);
    assert.deepEqual(a, b);
    const [card] = await approvals.pending(conversation);
    assert.deepEqual(card, a);
    assert.ok(!JSON.stringify(card).includes("private-fixture-note"));
    await assert.rejects(approvals.propose({ ...proposal, arguments: { operation_id: scope.requestId } }), { code: "conflict" });
    const answer = decision(a, "approve");
    const settle = { ...address(a), token };
    for (const bad of [
      { ...answer, argumentDigest: "0".repeat(64) }, { ...answer, version: 0 },
      { ...answer, ownerId: "other" }, { ...answer, invocationId: randomUUID() }, { ...answer, memberId: randomUUID() },
      { ...answer, approvalId: randomUUID() }, { ...answer, nativeCallId: "other-call" },
    ]) await assert.rejects(approvals.decide(bad));
    await assert.rejects(approvals.settle(settle), { code: "conflict" });
    assert.deepEqual(await writes(scope.conversationId), []);
    assert.equal(await approvals.decide(answer), "approve");
    await assert.rejects(approvals.decide(decision(a, "deny")), { code: "conflict" });
    await assert.rejects(approvals.settle({ ...settle, token: randomUUID() }), { code: "stale" });
    assert.deepEqual(await writes(scope.conversationId), []);
    const [result, replay] = await Promise.all([approvals.settle(settle), approvals.settle(settle)]);
    assert.deepEqual(replay, result);
    assert.equal(result.kind, "recorded");
    assert.equal(result.nativeCallId, a.nativeCallId);
    assert.deepEqual(await writes(scope.conversationId), [
      { approval_id: a.approvalId, receipt_id: result.receipt.receiptId, note: "private-fixture-note" },
    ]);
    await approvals.cancelTurn(scope);
    const restartedPool = new Pool({ connectionString: url });
    try {
      const restored = new ApprovalStore(restartedPool);
      assert.equal(await restored.decide(answer), "approve");
      assert.deepEqual(await restored.settle(settle), result);
    } finally { await restartedPool.end(); }
  });
}

test("siblings with the same native call ID have distinct approvals and complete only their own operation", async () => {
  const { conversation, scope, proposal, token } = await input("pi");
  const calls = await Promise.all([0, 1, 2].map(() =>
    approvals.propose({ ...proposal, invocationId: randomUUID() })));
  const [a, b, denied] = calls;
  assert.equal(new Set(calls.map((call) => call.approvalId)).size, 3);
  assert.equal((await approvals.pending(conversation)).length, 3);
  await approvals.decide(decision(denied, "deny"));
  assert.equal((await approvals.pending(conversation)).length, 2);
  assert.deepEqual(await approvals.settle({ ...address(denied), token }), { nativeCallId: denied.nativeCallId, kind: "denied" });
  assert.deepEqual(await writes(scope.conversationId), []);
  for (const call of [a, b]) await approvals.decide(decision(call, "approve"));
  const settle = [a, b].map((call) => ({ ...address(call), token }));
  const outcomes = await Promise.all(settle.map((cmd) => approvals.settle(cmd)));
  assert.deepEqual(outcomes.map((result) => result.kind).sort(), ["budget_exhausted", "recorded"]);
  assert.equal((await writes(scope.conversationId)).length, 1);
  await approvals.cancelTurn(scope);
  assert.deepEqual(await Promise.all(settle.map((cmd) => approvals.settle(cmd))), outcomes);
});

test("cancellation closes admissions and races atomically with the approved effect", async () => {
  for (const order of ["cancel-first", "effect-first", "race"]) {
    const { scope, proposal, conversation, token } = await input("claude");
    const call = await approvals.propose(proposal);
    await approvals.decide(decision(call, "approve"));
    const settle = () => approvals.settle({ ...address(call), token });
    if (order === "cancel-first") await approvals.cancelTurn(scope);
    if (order === "effect-first") await settle();
    const [, outcome] = await Promise.all([approvals.cancelTurn(scope), settle()]);
    assert.deepEqual(await settle(), outcome);
    if (order === "cancel-first") assert.equal(outcome.kind, "cancelled");
    if (order === "effect-first") assert.equal(outcome.kind, "recorded");
    assert.equal((await writes(scope.conversationId)).length, outcome.kind === "recorded" ? 1 : 0);
    await assert.rejects(approvals.propose({ ...proposal, nativeCallId: "late" }), { code: "conflict" });
    assert.deepEqual(await approvals.pending(conversation), []);
  }
});

test("opposite decisions race to one canonical answer, stale workers cannot propose or execute", async () => {
  const { scope, proposal, token } = await input("pi");
  const approval = await approvals.propose(proposal);
  const choices = await Promise.allSettled([approvals.decide(decision(approval, "approve")), approvals.decide(decision(approval, "deny"))]);
  assert.equal(choices.filter((entry) => entry.status === "fulfilled").length, 1);
  const { memberId: _, ...turn } = scope;
  await members.markUncertain({ ...turn, token });
  await assert.rejects(approvals.propose(proposal), { code: "stale" });
  if (choices[0].status === "fulfilled") await assert.rejects(approvals.settle({ ...address(approval), token }), { code: "stale" });
  assert.deepEqual(await writes(scope.conversationId), []);
});

test("ordinary answers race cancellation under the conversation lock and cannot authorize receipts", async () => {
  const { scope, proposal, token } = await input("pi");
  const question = await approvals.propose({ ...proposal, toolName: "choose_next_step", arguments: {} });
  const key = address(question);
  await assert.rejects(approvals.decide(decision(question, "approve")), { code: "conflict" });
  const answer = { ...key, version: question.version, argumentDigest: question.argumentDigest, choice: "inspect" as const };
  const [resolution, cancellation] = await Promise.allSettled([approvals.decide(answer), approvals.cancelTurn(scope)]);
  assert.equal([resolution, cancellation].filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(await approvals.settle({ ...key, token }), resolution.status === "fulfilled" ?
    { nativeCallId: key.nativeCallId, kind: "answered", choice: "inspect" } : { nativeCallId: key.nativeCallId, kind: "cancelled" });
  await assert.rejects(pool.query(`INSERT INTO birbcrew_ts.work_items (conversation_id,request_id,approval_id)
    VALUES ($1,$2,$3)`, [key.conversationId, key.requestId, key.approvalId]), { code: "23503" });
  assert.equal((await writes(scope.conversationId)).length, 0);
});

for (const child of [false, true]) {
  for (const variant of ["no-note", "empty-note", "private-note", "question"] as const) {
    if (child && variant === "question") continue;
    test(`${child ? "child" : "parent"} ${variant} publishes only proven public arguments across reopen`, async () => {
      const { scope, proposal } = await input("pi");
      let invocationId: string = scope.requestId, token = proposal.token;
      const checkpoint = { version: 1, engine: "pi", state: {} } as const;
      if (child) {
        const children = new ChildStore(pool);
        const conversation = await members.getConversation({ ownerId: scope.ownerId, conversationId: scope.conversationId });
        const [key] = await children.delegate(conversation, scope.requestId, token, [{ nativeCallId: "delegate", task: "record",
          profile: { role: "recorder", version: 1, instructions: fixedRoles.recorder.instructions, model: "fixture",
            tools: [...fixedRoles.recorder.tools] } }], checkpoint);
        const started = await children.begin(key, { workflowRunId: randomUUID(), activityId: "child", attempt: 1 });
        assert.equal(started.kind, "start");
        invocationId = key.childId;
        token = started.generation;
      }
      const toolName = variant === "question" ? "choose_next_step" : "record_work_item";
      const args = variant === "question" ? {} : { operation_id: scope.requestId,
        ...(variant === "empty-note" ? { note: "" } : variant === "private-note" ? { note: "private-fixture-note" } : {}) };
      const proposed = { ...proposal, token, invocationId, toolName, arguments: args } satisfies Parameters<ApprovalStore["propose"]>[0];
      const mode = child ? { childGeneration: token } : undefined;
      const call = await approvals.propose(proposed, child ? checkpoint : undefined, mode);
      const complete = variant === "no-note" || variant === "question";
      const snapshot = await readSnapshot(pool, scope.ownerId, scope.conversationId);
      const card = (variant === "question" ? snapshot.state.pendingQuestions : snapshot.state.pendingApprovals)?.[0];
      assert.ok(card);
      assert.equal(card.argumentsComplete, complete ? true : undefined);
      assert.equal(Object.hasOwn(card, "argumentsComplete"), complete);
      const message = snapshot.messages.find(m => m.role === "assistant" && m.toolCalls?.some(c => c.id === call.approvalId));
      assert.ok(message?.role === "assistant");
      assert.equal(message.subagentRunId, child ? invocationId : undefined);
      assert.equal(message.toolCalls?.[0].function.arguments, JSON.stringify(variant === "question" ? {} : { operation_id: scope.requestId }));
      const events = await pool.query("SELECT event FROM birbcrew_ts.public_events WHERE conversation_id=$1 ORDER BY cursor", [scope.conversationId]);
      assert.deepEqual(events.rows.at(-1).event.snapshot, snapshot.state);
      assert.ok(!JSON.stringify([snapshot, events.rows]).includes("private-fixture-note"));
      assert.ok(!JSON.stringify([snapshot, events.rows]).includes('\"note\"'));
      const reopened = new Pool({ connectionString: url });
      try {
        assert.deepEqual(await readSnapshot(reopened, scope.ownerId, scope.conversationId), snapshot);
        assert.deepEqual(await new ApprovalStore(reopened).propose(proposed, child ? checkpoint : undefined, mode), call);
        assert.deepEqual(await readSnapshot(reopened, scope.ownerId, scope.conversationId), snapshot);
      } finally { await reopened.end(); }
    });
  }
}

test("legacy call changes and persisted cards remain unproven", async () => {
  const original = await input("pi");
  const approval = await approvals.propose(original.proposal);
  const { scope } = await input("pi");
  await approvals.transaction(db => publishObservation(db, scope.conversationId, {
    kind: "call", approval: { ...approval, ...scope, invocationId: scope.requestId },
  }));
  const snapshot = await readSnapshot(pool, scope.ownerId, scope.conversationId);
  assert.equal(Object.hasOwn(snapshot.state.pendingApprovals[0], "argumentsComplete"), false);
  const reopened = new Pool({ connectionString: url });
  try { assert.deepEqual(await readSnapshot(reopened, scope.ownerId, scope.conversationId), snapshot); }
  finally { await reopened.end(); }
});

type Choice = Parameters<ApprovalStore["decide"]>[0]["choice"];
function named(approval: Approval, choice: Choice, decisionId?: string) {
  return { ...address(approval), argumentDigest: approval.argumentDigest, version: approval.version, choice,
    ...(decisionId && { decisionId }) };
}

function identity(approval: Approval) {
  const { memberId, conversationId, requestId, invocationId, approvalId, version } = approval;
  return { memberId, conversationId, requestId, invocationId, approvalId, version };
}

async function facts(approvalId: string) {
  const { rows: [row] } = await pool.query<{ decided: string; grants: string; at: Date | null }>(
    `SELECT (SELECT count(*) FROM birbcrew_ts.audit_events WHERE event_type='approval.decided' AND payload->>'approvalId'=$1) AS decided,
       (SELECT count(*) FROM birbcrew_ts.tool_grants WHERE approval_id=$1::uuid) AS grants,
       (SELECT occurred_at FROM birbcrew_ts.audit_events WHERE event_type='approval.decided' AND payload->>'approvalId'=$1) AS at`,
    [approvalId]);
  return { decided: Number(row.decided), grants: Number(row.grants), at: row.at?.toISOString() ?? null };
}

test("a named decision replays exactly once and any other decision on its card is a decision_conflict", async () => {
  const { proposal, token } = await input("pi", {});
  const card = await approvals.propose(proposal);
  const ownerId = card.ownerId, mine = randomUUID();
  assert.deepEqual(await readDecisionRecord(pool, ownerId, identity(card)), {
    apiVersion: "1", ...identity(card), toolName: "record_work_item", state: "undecided" });
  assert.equal(await approvals.previousDecision(named(card, "allow_conversation", mine)), null);
  assert.equal(await approvals.decide(named(card, "allow_conversation", mine)), "allow_conversation");
  const once = await facts(card.approvalId);
  assert.deepEqual([once.decided, once.grants], [1, 1]);
  const replays = await Promise.all([approvals.decide(named(card, "allow_conversation", mine)),
    approvals.previousDecision(named(card, "allow_conversation", mine.toUpperCase()))]);
  assert.deepEqual(replays, ["allow_conversation", "allow_conversation"]);
  assert.deepEqual(await facts(card.approvalId), once, "a replay appends no audit row and creates no grant");
  for (const other of [named(card, "approve", mine), named(card, "deny", mine), named(card, "allow_conversation", randomUUID())]) {
    await assert.rejects(approvals.decide(other), { code: "decision_conflict" });
    await assert.rejects(approvals.previousDecision(other), { code: "decision_conflict" });
  }
  assert.equal(await approvals.decide(named(card, "allow_conversation")), "allow_conversation", "without an id the choice alone replays");
  await assert.rejects(approvals.decide(named(card, "deny")), { code: "conflict" });
  const decided = { apiVersion: "1", ...identity(card), toolName: "record_work_item", state: "decided", decisionId: mine,
    choice: "allow_conversation", recordedAt: once.at };
  assert.deepEqual(await readDecisionRecord(pool, ownerId, identity(card)), { ...decided, effect: { kind: "none" } });
  const outcome = await approvals.settle({ ...address(card), token });
  assert.equal(outcome.kind, "recorded");
  assert.deepEqual(await readDecisionRecord(pool, ownerId, identity(card)),
    { ...decided, effect: { kind: "work_item", receiptId: outcome.kind === "recorded" && outcome.receipt.receiptId } });
});

test("a decision recorded without an id is never claimed by a named one, and unnamed decisions behave as before", async () => {
  const { proposal } = await input("claude");
  const question = await approvals.propose({ ...proposal, toolName: "choose_next_step", arguments: {} });
  assert.equal(await approvals.decide(named(question, "inspect")), "inspect");
  await assert.rejects(approvals.decide(named(question, "inspect", randomUUID())), { code: "decision_conflict" });
  await assert.rejects(approvals.previousDecision(named(question, "inspect", randomUUID())), { code: "decision_conflict" });
  assert.equal(await approvals.previousDecision(named(question, "inspect")), "inspect");
  await assert.rejects(approvals.decide(named(question, "test")), { code: "conflict" });
  await assert.rejects(approvals.decide(named(question, "approve", randomUUID())), { code: "conflict" },
    "a choice the tool never accepts stays an ordinary conflict");
  const record = await readDecisionRecord(pool, question.ownerId, identity(question));
  assert.ok(record.state === "decided");
  assert.deepEqual([record.toolName, record.decisionId, record.choice, record.effect], ["choose_next_step", null, "inspect", { kind: "none" }]);
  assert.equal(record.recordedAt, (await facts(question.approvalId)).at);
});

test("the decision record reports closed and auto-approved cards and hides every other owner's card", async () => {
  const expiring = await input("pi", { approvalDeadlineSeconds: 60 });
  const lapsed = await approvals.propose(expiring.proposal);
  await pool.query("UPDATE birbcrew_ts.deferred_calls SET expires_at=clock_timestamp() WHERE approval_id=$1", [lapsed.approvalId]);
  await assert.rejects(approvals.decide(named(lapsed, "approve", randomUUID())), { code: "conflict" });
  assert.deepEqual(await approvals.expireTurn(lapsed), { kind: "expired" });
  const { rows: [{ expired_at }] } = await pool.query("SELECT expired_at FROM birbcrew_ts.deferred_calls WHERE approval_id=$1", [lapsed.approvalId]);
  assert.deepEqual(await readDecisionRecord(pool, lapsed.ownerId, identity(lapsed)), { apiVersion: "1", ...identity(lapsed),
    toolName: "record_work_item", state: "closed", reason: "expired", closedAt: expired_at.toISOString() });

  const cancelling = await input("pi");
  const withdrawn = await approvals.propose(cancelling.proposal);
  await approvals.cancelTurn(cancelling.scope);
  await assert.rejects(approvals.decide(named(withdrawn, "deny", randomUUID())), { code: "conflict" });
  assert.deepEqual(await readDecisionRecord(pool, withdrawn.ownerId, identity(withdrawn)), { apiVersion: "1", ...identity(withdrawn),
    toolName: "record_work_item", state: "closed", reason: "cancelled", closedAt: null });

  const granted = await input("pi", {});
  const first = await approvals.propose(granted.proposal);
  await approvals.decide(named(first, "allow_always", randomUUID()));
  const sameMember = { ...granted.scope, conversationId: randomUUID(), requestId: randomUUID() };
  await members.openConversation({ ownerId: sameMember.ownerId, memberId: sameMember.memberId, conversationId: sameMember.conversationId });
  const request = { ownerId: sameMember.ownerId, conversationId: sameMember.conversationId, requestId: sameMember.requestId,
    text: "Record one more fixture work item" };
  await members.recordAcceptance(request, ownerInitiator);
  const turn = await members.beginTurn(request);
  assert.equal(turn.kind, "start");
  if (turn.kind !== "start") throw new Error("unreachable");
  const auto = await approvals.propose({ ...granted.proposal, ...sameMember, token: turn.token, invocationId: sameMember.requestId,
    arguments: { operation_id: sameMember.requestId } });
  assert.ok(auto.grantId);
  await assert.rejects(approvals.decide(named(auto, "approve", randomUUID())), { code: "decision_conflict" });
  const { rows: [audit] } = await pool.query<{ at: Date }>(`SELECT occurred_at AS at FROM birbcrew_ts.audit_events
    WHERE event_type='approval.auto_approved' AND payload->>'approvalId'=$1`, [auto.approvalId]);
  assert.deepEqual(await readDecisionRecord(pool, auto.ownerId, identity(auto)), { apiVersion: "1", ...identity(auto),
    toolName: "record_work_item", state: "auto_approved", grantId: auto.grantId, recordedAt: audit.at.toISOString() });

  for (const [owner, key] of [[randomUUID(), identity(first)], [first.ownerId, { ...identity(first), version: 2 }],
    [first.ownerId, { ...identity(first), memberId: randomUUID() }], [first.ownerId, { ...identity(first), invocationId: randomUUID() }],
    [first.ownerId, { ...identity(first), requestId: sameMember.requestId }], [first.ownerId, { ...identity(first), approvalId: randomUUID() }]] as const) {
    await assert.rejects(readDecisionRecord(pool, owner, key), { code: "not_found" });
  }
});

test("only a decided card that no grant approved can carry a decision id", async () => {
  const { proposal } = await input("pi");
  const card = await approvals.propose(proposal);
  await assert.rejects(pool.query("UPDATE birbcrew_ts.deferred_calls SET decision_id=$2 WHERE approval_id=$1",
    [card.approvalId, randomUUID()]), { code: "23514" });
});

test("concurrent first decisions with different ids commit one and refuse the other as a decision_conflict", async () => {
  const { proposal } = await input("pi", {});
  const card = await approvals.propose(proposal);
  const ids = [randomUUID(), randomUUID()];
  const results = await Promise.allSettled(ids.map(id => approvals.decide(named(card, "allow_conversation", id))));
  assert.deepEqual(results.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  const lost = results.find(r => r.status === "rejected");
  assert.equal(lost?.status === "rejected" && lost.reason.code, "decision_conflict");
  const winner = ids[results.findIndex(r => r.status === "fulfilled")];
  const record = await readDecisionRecord(pool, card.ownerId, identity(card));
  assert.ok(record.state === "decided");
  assert.equal(record.decisionId, winner);
  const once = await facts(card.approvalId);
  assert.deepEqual([once.decided, once.grants], [1, 1]);
});
