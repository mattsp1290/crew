import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { Pool } from "pg";
import { ChildStore, type ChildKey } from "../../src/service/children.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { auditEvents } from "../../src/service/audit.ts";
import { MemberStore } from "../../src/service/store.ts";
import { recordSegmentUsage, UsageApi } from "../../src/service/usage.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool), children = new ChildStore(pool), ledger = new ApprovalStore(pool), usage = new UsageApi(store);
const namedProfile = "budget-named-" + randomUUID();
const profile = "budget-parent-" + randomUUID(), targetProfile = "budget-target-" + randomUUID();
const checkpoint = { version: 1, engine: "pi", state: {} };
const execution = () => ({ workflowRunId: randomUUID(), activityId: "child", attempt: 1 });
before(async () => {
  await store.migrate();
  await pool.query(`INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,delegate_task,protected_tool)
    SELECT unnest($1::text[]),'pi',decode($2,'hex'),true,'record_work_item'`, [[profile, targetProfile], "00".repeat(32)]);
  const destination = { engine: "pi", profile: targetProfile, model: "fixture", providerHost: "fixture.local", accountDigest: "00".repeat(32) };
  await pool.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,delegate_task,protected_tool,child_target_seal,child_target_active)
    VALUES($1,'pi',decode($2,'hex'),true,'record_work_item',$3,ARRAY['analyst','recorder'])`,
    [namedProfile, "00".repeat(32), { mode: "named", roles: { analyst: destination, recorder: destination } }]);
});
after(() => pool.end());

async function parent(initiator?: { kind: "routine" | "handoff"; id: string }) {
  const ownerId = "owner-" + randomUUID();
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: initiator ? namedProfile : profile });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId, memberId, conversationId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "private parent task" };
  if (initiator) await pool.query(`INSERT INTO birbcrew_ts.request_admissions
    (conversation_id,request_id,prompt_digest,initiator_kind,initiator_id) VALUES ($1,$2,$3,$4,$5)`,
    [conversationId, request.requestId, createHash("sha256").update(request.text).digest(), initiator.kind, initiator.id]);
  const exec = execution();
  const turn = await store.beginTurn(request, exec);
  assert.equal(turn.kind, "start");
  if (turn.kind !== "start") throw new Error("Expected a parent start");
  const delegate = (roles: ("analyst" | "recorder")[] = ["analyst"]) => children.delegate(turn.conversation,
    request.requestId, turn.token, roles.map(role => ({ nativeCallId: "call_" + randomUUID(), task: "private child task",
      profile: { role, version: 1, instructions: fixedRoles[role].instructions, model: "fixture", tools: role === "recorder" ? ["record_work_item"] : [] } })), checkpoint);
  await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, request.requestId, turn.token, exec.workflowRunId, exec.activityId]);
  const spend = () => recordSegmentUsage(pool, { ...request, token: turn.token, execution: exec }, {
    state: "reported", model: "fixture", inputTokens: 9, outputTokens: 1, cachedInputTokens: null, cacheWriteTokens: null,
    reasoningTokens: null, costUsd: null });
  return { ...turn.conversation, request, token: turn.token, exec, delegate, spend };
}
const row = async (key: ChildKey) => (await pool.query(`SELECT phase,generation,native_checkpoint,outcome,workflow_run_id
  FROM birbcrew_ts.pi_children WHERE child_id=$1`, [key.childId])).rows[0];
const facts = async (key: ChildKey) => (await pool.query(`SELECT event_type AS type,payload,actor_kind AS actor,
  initiator_kind AS initiator,initiator_id AS "initiatorId" FROM birbcrew_ts.audit_events
  WHERE payload->>'childId'=$1 ORDER BY event_id`, [key.childId])).rows;
const events = async (key: ChildKey) => (await pool.query(`SELECT event FROM birbcrew_ts.public_events
  WHERE conversation_id=$1 AND event->>'messageId'=$2 ORDER BY cursor`, [key.conversationId, key.childId + "/result"])).rows.map(row => row.event);
async function publicState(key: ChildKey) {
  const events = await pool.query("SELECT cursor,event FROM birbcrew_ts.public_events WHERE conversation_id=$1 ORDER BY cursor", [key.conversationId]);
  const snapshot = await pool.query("SELECT * FROM birbcrew_ts.public_snapshots WHERE conversation_id=$1", [key.conversationId]);
  return { events: events.rows, snapshot: snapshot.rows };
}
async function start(key: ChildKey, exec = execution()) {
  const result = await children.begin(key, exec);
  assert.equal(result.kind, "start");
  if (result.kind !== "start") throw new Error("Expected a child start");
  return { ...result, exec };
}

for (const kind of ["routine", "handoff"] as const) test(`child audit uses stored targets and the parent's ${kind} initiator`, async () => {
  const initiator = { kind, id: randomUUID() };
  const p = await parent(initiator);
  const keys = await p.delegate(["analyst", "recorder"]);
  for (const key of keys) {
    const admitted = await start({ ...key, target: { engine: "codex", profile: "forged" } });
    const result = { text: "private child reply", checkpoint };
    const outcome = await children.finish(key, admitted.generation, result);
    assert.deepEqual(await children.finish(key, admitted.generation, result), outcome);
    assert.deepEqual((await facts(key)).map(fact => [fact.type, fact.payload, fact.actor, fact.initiator, fact.initiatorId]), [
      ["delegation.started", { childId: key.childId, role: key === keys[0] ? "analyst" : "recorder", engine: "pi", profile: targetProfile },
        "system", kind, initiator.id],
      ["delegation.finished", { childId: key.childId, outcome: "completed" }, "system", kind, initiator.id],
    ]);
    assert.ok(!JSON.stringify(await facts(key)).includes("private"));
  }
});

test("a first launch over budget settles once without a generation and cannot restart after a reset", async () => {
  const p = await parent(), [key] = await p.delegate();
  await usage.setBudget(p.ownerId, p.memberId, { tokenLimit: 10 });
  await p.spend();
  const result = await children.begin(key, execution());
  assert.equal(result.kind, "settled");
  assert.equal(result.kind === "settled" && result.outcome.kind === "failed" && result.outcome.code, "budget_exhausted");
  const persisted = await row(key);
  assert.deepEqual([persisted.phase, persisted.generation, persisted.workflow_run_id], ["failed", null, null]);
  assert.deepEqual((await facts(key)).map(f => [f.type, f.payload]), [
    ["delegation.finished", { childId: key.childId, outcome: "failed", code: "budget_exhausted" }],
  ]);
  assert.equal((await events(key)).length, 1);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rowCount, 0);
  await usage.clearBudget(p.ownerId, p.memberId);
  assert.deepEqual(await children.begin(key, execution()), result);
  assert.deepEqual(await children.finish(key, null, null, true), persisted.outcome);
  assert.deepEqual(await children.reconcile(key, randomUUID(), false), { kind: "complete" });
  assert.equal((await facts(key)).length, 1);
  assert.equal((await events(key)).length, 1);
});

test("committed parent cancellation wins an exhausted first launch", async () => {
  const p = await parent(), [key] = await p.delegate();
  await usage.setBudget(p.ownerId, p.memberId, { tokenLimit: 1 });
  await p.spend();
  await ledger.cancelTurn({ ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId, requestId: key.requestId });
  const result = await children.begin(key, execution());
  assert.equal(result.kind === "settled" && result.outcome.kind, "cancelled");
  assert.deepEqual((await facts(key)).map(f => f.payload), [{ childId: key.childId, outcome: "cancelled" }]);
});

for (const variant of ["completed", "failed", "cancelled"] as const) test(`${variant} settlement preserves checkpoint and replay semantics`, async () => {
  const p = await parent(), [key] = await p.delegate();
  const admitted = await start(key), old = { ...checkpoint, state: { old: true } }, next = { ...checkpoint, state: { next: true } };
  await pool.query("UPDATE birbcrew_ts.pi_children SET native_checkpoint=$2 WHERE child_id=$1", [key.childId, JSON.stringify(old)]);
  if (variant === "cancelled") await ledger.cancelTurn({ ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId, requestId: key.requestId });
  const result = { text: variant === "failed" ? " " : "private reply", checkpoint: next };
  const outcome = await children.finish(key, admitted.generation, result);
  assert.equal(outcome.kind, variant);
  const expected = variant === "completed" ? next : variant === "cancelled" ? old : null;
  assert.deepEqual((await row(key)).native_checkpoint, expected);
  assert.deepEqual(await children.finish(key, admitted.generation, result), outcome);
  await assert.rejects(children.finish(key, randomUUID(), result), { code: "stale" });
  assert.equal((await facts(key)).length, 2);
  assert.deepEqual((await facts(key))[0].payload, { childId: key.childId, role: "analyst", engine: "pi", profile });
});

test("bad checkpoints roll back completion and a later activity attempt settles without another start", async () => {
  const p = await parent(), [key] = await p.delegate();
  const admitted = await start(key);
  await assert.rejects(children.finish(key, admitted.generation, { text: "reply", checkpoint: { ...checkpoint, engine: "codex" } }), { code: "conflict" });
  assert.equal((await row(key)).phase, "running");
  assert.equal((await facts(key)).length, 1);
  assert.deepEqual(await children.begin(key, { ...admitted.exec, attempt: 2 }), { kind: "revoked", generation: admitted.generation });
  await children.finish(key, admitted.generation, null, true);
  assert.deepEqual((await facts(key)).map(f => f.type), ["delegation.started", "delegation.finished"]);
});

test("begin waits for the parent lock and observes spend committed before it acquires that lock", async () => {
  const p = await parent(), [key] = await p.delegate();
  await usage.setBudget(p.ownerId, p.memberId, { tokenLimit: 10 });
  const holder = await pool.connect();
  let pending: ReturnType<ChildStore["begin"]> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR NO KEY UPDATE", [key.conversationId]);
    const { rows: [{ pid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    pending = children.begin(key, execution());
    const deadline = Date.now() + 5000;
    while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount) {
      assert.ok(Date.now() < deadline, "child begin must wait for the parent's lock");
      await delay(10);
    }
    await p.spend();
    await holder.query("COMMIT");
    const result = await pending;
    assert.equal(result.kind === "settled" && result.outcome.kind === "failed" && result.outcome.code, "budget_exhausted");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await pending;
  }
});

test("an audit insert failure rolls back the child mutation and observation", async () => {
  const p = await parent(), [key] = await p.delegate();
  const before = await publicState(key);
  await pool.query(`CREATE FUNCTION birbcrew_ts.proof_child_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.payload->>'childId'='${key.childId}' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER proof_child_audit_fail BEFORE INSERT ON birbcrew_ts.audit_events
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.proof_child_audit_fail()`);
  try {
    await assert.rejects(children.begin(key, execution()), /fixture audit failure/);
    assert.deepEqual([(await row(key)).phase, (await row(key)).generation], ["ready", null]);
    assert.deepEqual(await publicState(key), before);
    await usage.setBudget(p.ownerId, p.memberId, { tokenLimit: 1 });
    await p.spend();
    await assert.rejects(children.begin(key, execution()), /fixture audit failure/);
    assert.deepEqual([(await row(key)).phase, (await row(key)).outcome], ["ready", null]);
    assert.deepEqual(await publicState(key), before);
  } finally {
    await pool.query("DROP TRIGGER proof_child_audit_fail ON birbcrew_ts.audit_events");
    await pool.query("DROP FUNCTION birbcrew_ts.proof_child_audit_fail()");
  }
  assert.equal((await children.begin(key, execution())).kind, "settled");
});

test("a terminal audit failure preserves the waiting recorder and its pending approval", async () => {
  const p = await parent(), [key] = await p.delegate(["recorder"]);
  const admitted = await start(key), waiting = { ...checkpoint, state: { pending: true } };
  await ledger.propose({ ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId,
    requestId: key.requestId, token: admitted.generation, invocationId: key.childId, nativeCallId: "record_" + randomUUID(),
    toolName: "record_work_item", arguments: { operation_id: key.requestId } }, waiting, { childGeneration: admitted.generation });
  const scope = { ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId };
  const before = { child: await row(key), pending: await ledger.pending(scope), public: await publicState(key), facts: await facts(key) };
  assert.equal(before.pending.length, 1);
  await pool.query(`CREATE FUNCTION birbcrew_ts.proof_child_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.payload->>'childId'='${key.childId}' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER proof_child_audit_fail BEFORE INSERT ON birbcrew_ts.audit_events
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.proof_child_audit_fail()`);
  try {
    await assert.rejects(children.finish(key, admitted.generation, null, true), /fixture audit failure/);
    assert.deepEqual({ child: await row(key), pending: await ledger.pending(scope), public: await publicState(key), facts: await facts(key) }, before);
  } finally {
    await pool.query("DROP TRIGGER proof_child_audit_fail ON birbcrew_ts.audit_events");
    await pool.query("DROP FUNCTION birbcrew_ts.proof_child_audit_fail()");
  }
  assert.equal((await children.finish(key, admitted.generation, null, true)).kind, "failed");
  assert.deepEqual(await ledger.pending(scope), []);
});

test("quarantine requests a stop without claiming a terminal child outcome", async () => {
  const p = await parent(), [key] = await p.delegate();
  await start(key);
  await children.quarantineDelegation(p, p.request, p.exec.workflowRunId);
  assert.equal((await row(key)).outcome, null);
  assert.deepEqual((await facts(key)).map(f => f.type), ["delegation.started"]);
});

test("audit payloads reject task material and invalid outcome/code combinations", () => {
  const childId = randomUUID();
  const started = { childId, role: "analyst", engine: "pi", profile };
  for (const extra of ["task", "text", "instructions", "taskDigest", "nativeCallId", "token"]) {
    assert.equal(auditEvents["delegation.started"].payload.safeParse({ ...started, [extra]: "private" }).success, false);
    assert.equal(auditEvents["delegation.finished"].payload.safeParse({ childId, outcome: "completed", [extra]: "private" }).success, false);
  }
  for (const value of [{ childId, outcome: "failed" }, { childId, outcome: "completed", code: "child_failed" },
    { childId, outcome: "cancelled", code: "budget_exhausted" }]) {
    assert.equal(auditEvents["delegation.finished"].payload.safeParse(value).success, false);
  }
});

for (const cancelled of [false, true]) test(`a ${cancelled ? "cancelled" : "failed"} waiting recorder closes its card once`, async () => {
  const p = await parent(), [key] = await p.delegate(["recorder"]);
  const admitted = await start(key), waiting = { ...checkpoint, state: { pending: true } };
  const approval = await ledger.propose({ ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId,
    requestId: key.requestId, token: admitted.generation, invocationId: key.childId, nativeCallId: "record_" + randomUUID(),
    toolName: "record_work_item", arguments: { operation_id: key.requestId } }, waiting, { childGeneration: admitted.generation });
  assert.equal((await ledger.pending({ ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId })).length, 1);
  await children.closeExitedChild(key, cancelled);
  assert.deepEqual(await ledger.pending({ ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId }), []);
  assert.deepEqual((await row(key)).native_checkpoint, cancelled ? waiting : null);
  assert.equal((await facts(key)).filter(f => f.type === "delegation.finished").length, 1);
  const result = await ledger.settleConfirmed(approval);
  assert.equal(result.kind, "cancelled");
});
