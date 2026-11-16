import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { ApprovalStore, type Approval } from "../../src/service/approvals.ts";
import { ChildStore } from "../../src/service/children.ts";
import { publishObservation, readSnapshot } from "../../src/service/observation.ts";
import { MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database");
const pool = new Pool({ connectionString: url });
const members = new MemberStore(pool);
const approvals = new ApprovalStore(pool);
before(async () => { await members.migrate(); await Promise.all([approvals.migrate(), approvals.migrate()]); });
after(() => pool.end());

async function input(engine: "claude" | "pi") {
  const ownerId = randomUUID();
  const { memberId } = await members.spawn({ ownerId, requestId: randomUUID(), engine, profile: "approvals.v1" });
  const conversation = { ownerId, memberId, conversationId: randomUUID() };
  await members.openConversation(conversation);
  const { conversationId } = conversation;
  const requestId = randomUUID();
  const turn = await members.beginTurn({ ownerId, conversationId, requestId, text: "Record one fixture work item" });
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
