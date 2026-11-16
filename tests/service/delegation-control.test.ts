import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { z } from "zod";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { ApprovalStore, type Approval } from "../../src/service/approvals.ts";
import { ChildStore, type ChildKey } from "../../src/service/children.ts";
import { DelegationControl, controlCommandSchema, controlReceiptSchema,
  type ChildWorkflowControl, type ControlCommand } from "../../src/service/delegation-control.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { readSnapshot } from "../../src/service/observation.ts";
import type { MemberProfile } from "../../src/service/profiles.ts";
import { MemberStore } from "../../src/service/store.ts";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a fresh disposable PostgreSQL 17 database dedicated to this suite.");
const pool = new Pool({ connectionString: url, max: 8, application_name: "delegation-control-store-tests",
  statement_timeout: 15_000, lock_timeout: 10_000 });
const members = new MemberStore(pool), children = new ChildStore(pool), approvals = new ApprovalStore(pool);
const checkpoint = { version: 1, engine: "pi", state: {} };
const directory = await mkdtemp(join(tmpdir(), "crew-control-store-"));
type ChildExecutionKey = Parameters<ChildWorkflowControl["observe"]>[0];
const fixtures: Awaited<ReturnType<typeof delegation>>[] = [];
const observations: { case: string; observedAt: string; value: unknown }[] = [];
function record(name: string, value: unknown) { observations.push({ case: name, observedAt: new Date().toISOString(), value }); }
function workflowFixture() {
  const signals: ChildExecutionKey[] = [];
  const workflows: ChildWorkflowControl = {
    async signalDecision(key) { signals.push(key); return { kind: "accepted" }; },
    async observe(key) { return key.workflowRunId === null ? { kind: "not_started" }
      : { kind: "closed", runId: key.workflowRunId, status: "COMPLETED" }; },
    async observeParentResult() { return { kind: "observed" }; },
  };
  return { workflows, signals, control: new DelegationControl({ pool, workflows }) };
}
const forbiddenWorkflowCalls: string[] = [];
function faultWorkflows(): ChildWorkflowControl {
  const fail = async (operation: string): Promise<never> => {
    forbiddenWorkflowCalls.push(operation);
    throw new Error("Workflow service must not be touched by change/status");
  };
  return { signalDecision: () => fail("signalDecision"), observe: () => fail("observe"),
    observeParentResult: () => fail("observeParentResult") };
}
const control = new DelegationControl({ pool, workflows: faultWorkflows() });
async function command(scope: ControlCommand["scope"], enabled = false): Promise<ControlCommand> {
  return { commandId: randomUUID(), expectedRevision: (await control.status()).revision, scope, enabled,
    actor: "isolated-store-test", reason: "Verify durable operator permission behavior" };
}
async function change(scope: ControlCommand["scope"], enabled = false) { return control.change(await command(scope, enabled)); }
const targetScope = (profile: string) => ({ kind: "target", engine: "pi", profile } satisfies ControlCommand["scope"]);
before(async () => {
  const version = z.object({ server_version_num: z.string() }).parse((await pool.query("SHOW server_version_num")).rows[0]);
  assert.equal(Math.floor(Number(version.server_version_num) / 10_000), 17, "This suite requires PostgreSQL 17");
  const empty = z.object({ empty: z.boolean() }).parse((await pool.query("SELECT to_regnamespace('birbcrew_ts') IS NULL AS empty")).rows[0]);
  assert.equal(empty.empty, true, "Global disable tests require their own fresh empty database");
  await members.migrate();
});
beforeEach(async () => { await change({ kind: "global" }, true); });
after(async () => {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
  const proofDirectory = process.env.BIRBCREW_CONTROL_PROOF_DIR;
  if (proofDirectory) {
    await mkdir(proofDirectory, { recursive: true });
    await writeFile(join(proofDirectory, "control-store-observations.json"), JSON.stringify({
      scope: "Real PostgreSQL 17 stores and CLI; workflow observations are explicitly scoped adapter fixtures, not Temporal/native proof",
      observations,
    }, null, 2) + "\n");
  }
});
function proposal(role: "analyst" | "recorder") {
  return { nativeCallId: "call_" + randomUUID(), task: "bounded store fixture task",
    profile: { role, version: 1, ...fixedRoles[role], tools: [...fixedRoles[role].tools], model: "fixture-model" } };
}
async function delegation(options: { profile?: string; roles?: ("analyst" | "recorder")[] } = {}) {
  const profile = options.profile ?? "control-" + randomUUID(), ownerId = randomUUID();
  const member = await members.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID();
  const conversation = await members.openConversation({ ownerId, memberId: member.memberId, conversationId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "bounded store fixture request" };
  const execution = { workflowRunId: randomUUID(), activityId: "parent-initial", attempt: 1 };
  const start = await members.beginTurn(request, execution);
  assert.equal(start.kind, "start");
  const proposals = (options.roles ?? ["analyst"]).map(proposal);
  const keys = await children.delegate(conversation, request.requestId, start.token, proposals, checkpoint);
  const fixture = { member, conversation, request, execution, keys, proposals, profile, token: start.token };
  fixtures.push(fixture);
  return fixture;
}
async function running(key: ChildKey) {
  const execution = { workflowRunId: randomUUID(), activityId: "child-initial", attempt: 1 };
  const start = await children.begin(key, execution);
  assert.equal(start.kind, "start");
  return { execution, generation: start.generation };
}
async function waiting(key: ChildKey) {
  const started = await running(key);
  const approval = await approvals.propose({ ...key, token: started.generation, invocationId: key.childId,
    nativeCallId: "record-" + randomUUID(), toolName: "record_work_item",
    arguments: { operation_id: key.requestId, note: "private store fixture note" } }, checkpoint,
  { childGeneration: started.generation });
  return { ...started, approval };
}
function address(approval: Approval) {
  const { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId } = approval;
  return { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId };
}
async function childState(key: ChildKey) {
  return z.object({ phase: z.string(), generation: z.string().nullable(), outcome: z.unknown().nullable(),
    launch_revoked: z.boolean() }).parse((await pool.query(
    "SELECT phase,generation,outcome,launch_revoked FROM birbcrew_ts.pi_children WHERE child_id=$1", [key.childId])).rows[0]);
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const key of fixture.keys) await children.closeExitedChild(key, false);
    await finishParent(fixture);
  }
});
async function finishParent(fixture: Awaited<ReturnType<typeof delegation>>) {
  const execution = { ...fixture.execution, activityId: "parent-followup" };
  const resume = await members.beginResume(fixture.request, null, execution);
  if (resume.kind === "replay") return execution;
  assert.equal(resume.kind, "start");
  await members.commitTurn({ ...fixture.request, token: resume.token, checkpoint, reply: "Fixture outcomes delivered" });
  return execution;
}

test("strict operator input rejects malformed commands without changing durable permission", async () => {
  const good = await command(targetScope("strict-" + randomUUID()));
  const original = await control.status();
  for (const invalid of [
    { ...good, extra: true }, { ...good, commandId: "not-a-uuid" }, { ...good, expectedRevision: 1 },
    { ...good, expectedRevision: "-1" }, { ...good, expectedRevision: "01" }, { ...good, expectedRevision: "1.0" },
    { ...good, expectedRevision: "9223372036854775808" }, { ...good, enabled: "false" },
    { ...good, scope: { kind: "global", profile: "hidden" } },
    { ...good, scope: { kind: "target", engine: "unknown", profile: "target" } },
    { ...good, scope: { kind: "target", engine: "pi", profile: "" } },
    { ...good, actor: "" }, { ...good, actor: "a".repeat(257) }, { ...good, actor: "é".repeat(129) },
    { ...good, reason: "\ud800" }, { ...good, reason: "" },
    { ...good, reason: "r".repeat(1025) }, { ...good, reason: "bad\0reason" },
  ]) {
    assert.equal(controlCommandSchema.safeParse(invalid).success, false);
    await assert.rejects(control.change(invalid));
    assert.deepEqual(await control.status(), original);
  }
});

test("change and status persist refusal with a workflow adapter that throws on every operation", async () => {
  const input = await command(targetScope("offline-" + randomUUID()));
  const receipt = controlReceiptSchema.parse(await control.change(input));
  assert.deepEqual(receipt.scope, input.scope);
  assert.equal(receipt.enabled, false);
  assert.equal(receipt.revision, (BigInt(input.expectedRevision) + 1n).toString());
  assert.equal((await control.status()).revision, receipt.revision);
  assert.deepEqual(forbiddenWorkflowCalls, [], "Unit boundary adapter receives no workflow calls");
  record("workflow-independent durable refusal", receipt);
});

test("same command retries preserve the original receipt while changed payloads and stale CAS refuse", async () => {
  const input = await command(targetScope("idempotency-" + randomUUID()));
  const receipt = await control.change(input);
  await change(targetScope("newer-" + randomUUID()));
  const current = await control.status();
  assert.deepEqual(await control.change(input), receipt);
  for (const changed of [{ ...input, reason: "changed" }, { ...input, enabled: true },
    { ...input, commandId: randomUUID() }]) await assert.rejects(control.change(changed));
  assert.deepEqual(await control.status(), current);
  const [left, right] = await Promise.allSettled([
    control.change({ ...await command(targetScope("cas-left-" + randomUUID())), expectedRevision: current.revision }),
    control.change({ ...await command(targetScope("cas-right-" + randomUUID())), expectedRevision: current.revision }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), ["fulfilled", "rejected"]);
  assert.equal((await control.status()).revision, (BigInt(current.revision) + 1n).toString());
});

async function flushChild(fixture: ReturnType<typeof workflowFixture>, childId: string) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const pass = await fixture.control.flush();
    const child = pass.children.find(child => child.childId === childId);
    if (child) return child;
  }
  assert.fail("Bounded reconciliation did not revisit the retired child");
}

test("ready retirement settles through ChildStore without creating a native launch and never resurrects", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  const receipt = await change(targetScope(f.profile));
  assert.equal((await childState(key)).phase, "ready", "A refusal receipt does not claim completed retirement");
  const pass = await flushChild(worker, key.childId);
  assert.equal(pass.settlement, "settled");
  assert.equal(pass.wake.kind, "accepted");
  const settled = await childState(key);
  assert.equal(settled.phase, "failed");
  assert.deepEqual(settled.outcome, { kind: "failed", code: "child_failed", nativeCallId: f.proposals[0].nativeCallId });
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rowCount, 0);
  await change(targetScope(f.profile), true);
  const restarted = workflowFixture();
  await flushChild(restarted, key.childId);
  const replay = await children.begin(key, { workflowRunId: randomUUID(), activityId: "after-enable", attempt: 1 });
  assert.equal(replay.kind, "settled");
  assert.deepEqual(await childState(key), settled);
  const fresh = await delegation({ profile: f.profile });
  assert.equal((await running(fresh.keys[0])).generation.length > 0, true, "Enable admits new work on the same target");
  record("ready retirement and restart", { commandId: receipt.commandId, childId: key.childId,
    phase: settled.phase, oldChildRestart: replay.kind, newChildAdmitted: true });
});

test("unanswered recorder retirement atomically closes its visible card without inventing an owner choice", async () => {
  const f = await delegation({ roles: ["recorder"] }), [key] = f.keys;
  const { approval } = await waiting(key), worker = workflowFixture();
  assert.deepEqual((await approvals.pending(f.conversation)).map(card => card.approvalId), [approval.approvalId]);
  await change(targetScope(f.profile));
  await flushChild(worker, key.childId);
  const snapshot = await readSnapshot(pool, key.ownerId, key.conversationId);
  assert.equal((await childState(key)).phase, "failed");
  assert.deepEqual(await approvals.pending(f.conversation), []);
  assert.equal(snapshot.state.pendingApprovals.some(card => card.approvalId === approval.approvalId), false);
  const closed = z.object({ phase: z.literal("failed"), decision: z.null(), card_visible: z.boolean(), result_visible: z.boolean() })
    .parse((await pool.query(`SELECT j.phase,p.decision,
      EXISTS(SELECT 1 FROM jsonb_array_elements(s.state->'pendingApprovals') card WHERE card->>'approvalId'=p.approval_id::text) AS card_visible,
      EXISTS(SELECT 1 FROM birbcrew_ts.public_publications o WHERE o.conversation_id=j.conversation_id
        AND o.logical_key='result/'||p.approval_id::text) AS result_visible
      FROM birbcrew_ts.pi_children j JOIN birbcrew_ts.deferred_calls p ON p.approval_id=j.approval_id
      JOIN birbcrew_ts.public_snapshots s ON s.conversation_id=j.conversation_id WHERE j.child_id=$1`, [key.childId])).rows[0]);
  assert.equal(closed.card_visible, false);
  assert.equal(closed.result_visible, true);
  await assert.rejects(approvals.decide({ ...address(approval), argumentDigest: approval.argumentDigest,
    version: approval.version, choice: "approve" }));
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.work_items WHERE conversation_id=$1", [key.conversationId])).rowCount, 0);
  record("unanswered card closure", { childId: key.childId, approvalId: approval.approvalId, ...closed });
});

test("resuming recorder retirement preserves the committed effect and replays the same receipt", async () => {
  const f = await delegation({ roles: ["recorder"] }), [key] = f.keys;
  const pending = await waiting(key);
  await approvals.decide({ ...address(pending.approval), argumentDigest: pending.approval.argumentDigest,
    version: pending.approval.version, choice: "approve" });
  const committed = await approvals.settleConfirmed(pending.approval);
  assert.equal(committed.kind, "recorded");
  const resumed = await children.begin(key, { ...pending.execution, activityId: "child-resume" }, true);
  assert.equal(resumed.kind, "start");
  assert.equal((await childState(key)).phase, "resuming");
  await change(targetScope(f.profile));
  await flushChild(workflowFixture(), key.childId);
  assert.equal((await childState(key)).phase, "failed");
  assert.deepEqual(await approvals.settleConfirmed(pending.approval), committed);
  const writes = await pool.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1 AND request_id=$2",
    [key.conversationId, key.requestId]);
  assert.equal(writes.rowCount, 1);
  assert.equal(writes.rows[0].receipt_id, committed.receipt.receiptId);
  await flushChild(workflowFixture(), key.childId);
  assert.deepEqual(await approvals.settleConfirmed(pending.approval), committed);
  record("committed effect survives retirement", { childId: key.childId, committedEffects: writes.rowCount,
    receiptId: committed.receipt.receiptId });
});

test("failed wakes remain retryable across enable and a new manager instance", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  await running(key);
  await change(targetScope(f.profile));
  worker.workflows.signalDecision = async () => ({ kind: "unavailable" });
  const first = await flushChild(worker, key.childId);
  assert.equal(first.settlement, "settled");
  assert.equal(first.wake.kind, "unavailable");
  const settled = await childState(key);
  worker.workflows.signalDecision = async () => ({ kind: "missing" });
  assert.equal((await flushChild(worker, key.childId)).wake.kind, "missing");
  await change(targetScope(f.profile), true);
  const restarted = workflowFixture();
  const retried = await flushChild(restarted, key.childId);
  assert.equal(retried.settlement, "settled");
  assert.equal(retried.wake.kind, "accepted");
  assert.ok(restarted.signals.some(signal => signal.childId === key.childId));
  assert.deepEqual(await childState(key), settled);
  assert.equal((await children.begin(key, { workflowRunId: randomUUID(), activityId: "retry", attempt: 1 })).kind, "settled");
});

test("global and target permission compose without enabling one overriding the other", async () => {
  const profile = "composition-" + randomUUID();
  await change(targetScope(profile));
  await change({ kind: "global" }, false);
  await change({ kind: "global" }, true);
  await assert.rejects(delegation({ profile }));
  await change({ kind: "global" }, false);
  await change(targetScope(profile), true);
  const state = await control.status();
  assert.equal(state.globalEnabled, false);
  assert.equal(state.disabledTargets.some(target => target.profile === profile), false);
  await assert.rejects(delegation({ profile }));
  await change({ kind: "global" }, true);
  const fresh = await delegation({ profile });
  assert.equal((await running(fresh.keys[0])).generation.length > 0, true);
});

test("drain reports ready SQL work, not-started execution and undelivered parent independently", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  const receipt = await change(targetScope(f.profile));
  const report = await worker.control.drain(receipt.commandId);
  assert.equal(report.valid, true);
  assert.equal(report.admissionClosed, true);
  assert.equal(report.complete, false);
  assert.deepEqual(report.blockers, [
    { kind: "child_pending", childId: key.childId, phase: "ready" },
    { kind: "child_workflow", childId: key.childId, observation: { kind: "not_started" } },
    { kind: "parent_pending", requestId: key.requestId, phase: "started" },
  ]);
  assert.deepEqual(report.children.map(child => ({ childId: child.childId, retire: child.retire })),
    [{ childId: key.childId, retire: true }]);
  record("incomplete SQL and not-started execution", report);
});

test("drain requires independently closed child execution and observed parent result after SQL settles", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  const childExecution = await running(key);
  const receipt = await change(targetScope(f.profile));
  await flushChild(worker, key.childId);
  await finishParent(f);
  const complete = await worker.control.drain(receipt.commandId);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.blockers, []);
  assert.deepEqual(complete.children[0].workflow, { kind: "closed", runId: childExecution.execution.workflowRunId, status: "COMPLETED" });
  assert.equal(complete.parents[0].workflow.kind, "observed");
  assert.ok(Date.parse(complete.completedAt) >= Date.parse(complete.startedAt));
  assert.equal(JSON.stringify(complete).includes("Fixture outcomes delivered"), false, "Reports exclude private parent reply text");
  for (const observation of [
    { kind: "missing" }, { kind: "unknown" }, { kind: "unavailable" },
    { kind: "open", runId: childExecution.execution.workflowRunId, status: "RUNNING" },
  ] satisfies Awaited<ReturnType<ChildWorkflowControl["observe"]>>[]) {
    worker.workflows.observe = async () => observation;
    const report = await worker.control.drain(receipt.commandId);
    assert.equal(report.complete, false);
    assert.deepEqual(report.blockers, [{ kind: "child_workflow", childId: key.childId, observation }]);
    record("adapter fixture child execution " + observation.kind, report);
  }
  worker.workflows.observe = async () => { throw new Error("controlled unreachable workflow service"); };
  assert.deepEqual((await worker.control.drain(receipt.commandId)).blockers,
    [{ kind: "child_workflow", childId: key.childId, observation: { kind: "unavailable" } }]);
  worker.workflows.observe = async () => ({ kind: "closed", runId: childExecution.execution.workflowRunId, status: "COMPLETED" });
  for (const kind of ["pending", "missing", "unknown", "unavailable"] as const) {
    worker.workflows.observeParentResult = async () => ({ kind });
    const report = await worker.control.drain(receipt.commandId);
    assert.equal(report.complete, false);
    assert.deepEqual(report.blockers, [{ kind: "parent_workflow", requestId: key.requestId, observation: { kind } }]);
    record("adapter fixture parent result " + kind, report);
  }
  worker.workflows.observeParentResult = async () => { throw new Error("controlled result observation failure"); };
  assert.deepEqual((await worker.control.drain(receipt.commandId)).blockers,
    [{ kind: "parent_workflow", requestId: key.requestId, observation: { kind: "unavailable" } }]);
});

test("completed selected child remains in the cohort until parent and all retained native attempts are accounted for", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  const started = await running(key);
  const parentTokens = [f.token, randomUUID()];
  await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES($1,$2,$3,$4,'parent-first',1),($1,$2,$5,$4,'parent-retry',2)`,
  [key.conversationId, key.requestId, parentTokens[0], f.execution.workflowRunId, parentTokens[1]]);
  try {
    await children.finish(key, started.generation, { text: "Completed fixture child", checkpoint });
    const receipt = await change(targetScope(f.profile));
    const beforeParent = await worker.control.drain(receipt.commandId);
    assert.deepEqual(beforeParent.children.map(child => ({ childId: child.childId, retire: child.retire })),
      [{ childId: key.childId, retire: false }]);
    assert.ok(beforeParent.blockers.some(blocker => blocker.kind === "parent_pending"));
    await finishParent(f);
    const lateNativeReceipt = await change(targetScope(f.profile));
    const nativePending = await worker.control.drain(lateNativeReceipt.commandId);
    assert.deepEqual(nativePending.children.map(child => ({ childId: child.childId, retire: child.retire })),
      [{ childId: key.childId, retire: false }]);
    assert.deepEqual(nativePending.blockers, [{ kind: "native_unconfirmed", requestId: key.requestId, tokens: parentTokens.toSorted() }]);
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND token=$2", [key.conversationId, parentTokens[0]]);
    const onePending = await worker.control.drain(lateNativeReceipt.commandId);
    assert.deepEqual(onePending.blockers, [{ kind: "native_unconfirmed", requestId: key.requestId, tokens: [parentTokens[1]] }]);
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND token=$2", [key.conversationId, parentTokens[1]]);
    assert.equal((await worker.control.drain(lateNativeReceipt.commandId)).complete, true);
    const quiescentReceipt = await change(targetScope(f.profile));
    assert.deepEqual((await worker.control.drain(quiescentReceipt.commandId)).children, []);
    record("database-only retained launch accounting", { childId: key.childId, tokens: parentTokens,
      beforeParentBlockers: beforeParent.blockers, afterParentBlockers: nativePending.blockers });
  } finally {
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1", [key.conversationId]);
  }
});

test("revision change during workflow observation invalidates the snapshot while retaining cohort diagnostics", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  await running(key);
  const receipt = await change(targetScope(f.profile));
  let changed = false;
  worker.workflows.observe = async execution => {
    if (!changed) { changed = true; await change(targetScope("concurrent-" + randomUUID()), true); }
    assert.ok(execution.workflowRunId);
    return { kind: "closed", runId: execution.workflowRunId, status: "COMPLETED" };
  };
  const report = await worker.control.drain(receipt.commandId);
  assert.equal(report.valid, false);
  assert.equal(report.admissionClosed, false);
  assert.equal(report.complete, false);
  assert.notEqual(report.initial.revision, report.current.revision);
  assert.equal(report.children[0].childId, key.childId);
  assert.ok(report.blockers.some(blocker => blocker.kind === "child_pending"));
  assert.ok(report.blockers.some(blocker => blocker.kind === "control_changed"));
  assert.ok(report.blockers.some(blocker => blocker.kind === "admission_open"));
  record("revision invalidation retains diagnostics", report);
});

test("previous-instance commands refuse and cross-observation instance changes invalidate rather than erase the cohort", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  await running(key);
  const input = await command(targetScope(f.profile)), receipt = await control.change(input);
  const original = await control.status();
  const replacementInstance = randomUUID();
  try {
    worker.workflows.observe = async execution => {
      await pool.query("UPDATE birbcrew_ts.recovery_control SET instance_id=$1 WHERE singleton", [replacementInstance]);
      assert.ok(execution.workflowRunId);
      return { kind: "closed", runId: execution.workflowRunId, status: "COMPLETED" };
    };
    const report = await worker.control.drain(receipt.commandId);
    assert.equal(report.valid, false);
    assert.equal(report.complete, false);
    assert.equal(report.initial.instanceId, original.instanceId);
    assert.equal(report.current.instanceId, replacementInstance);
    assert.equal(report.children[0].childId, key.childId);
    assert.ok(report.blockers.some(blocker => blocker.kind === "control_changed"));
    await assert.rejects(control.change(input), { code: "55000" });
    record("database fixture instance invalidation", report);
  } finally {
    await pool.query("UPDATE birbcrew_ts.recovery_control SET instance_id=$1 WHERE singleton", [original.instanceId]);
  }
});

test("target drain names an unaffected waiting sibling and global retirement closes it without a human answer", async () => {
  const parent = "mixed-parent-" + randomUUID(), analyst = "mixed-analyst-" + randomUUID(), recorder = "mixed-recorder-" + randomUUID();
  const pi = await createPiFixtureOptions(undefined, { id: "fixture-model", baseUrl: "https://control-store.fixture" });
  const config = new Map<string, MemberProfile>([
    [parent, { accountId: "fixture-parent", pi, protectedTool: "record_work_item", delegateTask: true,
      childTargets: { pi: { analyst: { engine: "pi", profile: analyst }, recorder: { engine: "pi", profile: recorder } } } }],
    [analyst, { accountId: "fixture-analyst", pi, protectedTool: "record_work_item" }],
    [recorder, { accountId: "fixture-recorder", pi, protectedTool: "record_work_item" }],
  ]);
  await registerProfiles(pool, config, directory);
  const f = await delegation({ profile: parent, roles: ["analyst", "recorder"] }), [selected, sibling] = f.keys;
  await running(selected);
  const pending = await waiting(sibling), worker = workflowFixture();
  const targeted = await change(targetScope(analyst));
  await flushChild(worker, selected.childId);
  const report = await worker.control.drain(targeted.commandId);
  const expectedSibling = { ownerId: sibling.ownerId, memberId: sibling.memberId, conversationId: sibling.conversationId,
    requestId: sibling.requestId, childId: sibling.childId, phase: "waiting", target: targetScope(recorder),
    approvalId: pending.approval.approvalId };
  assert.deepEqual(report.children.map(child => child.childId), [selected.childId]);
  assert.deepEqual(report.siblings, [expectedSibling]);
  assert.ok(report.blockers.some(blocker => blocker.kind === "sibling_pending"));
  assert.equal(report.complete, false);
  assert.equal((await childState(sibling)).phase, "waiting");
  assert.deepEqual((await approvals.pending(f.conversation)).map(card => card.approvalId), [pending.approval.approvalId]);
  const global = await change({ kind: "global" });
  await flushChild(worker, sibling.childId);
  assert.equal((await childState(sibling)).phase, "failed");
  assert.deepEqual(await approvals.pending(f.conversation), []);
  await finishParent(f);
  const complete = await worker.control.drain(global.commandId);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.siblings, []);
  assert.ok(complete.children.some(child => child.childId === sibling.childId && child.retire));
  record("unselected sibling dependency", { targetReport: report, globalReport: complete });
});

test("enable receipts and superseded disabled receipts never report admission closed", async () => {
  const target = targetScope("report-enable-" + randomUUID()), worker = workflowFixture();
  const disabled = await change(target);
  const enabled = await change(target, true);
  const enabledReport = await worker.control.drain(enabled.commandId);
  assert.equal(enabledReport.valid, true);
  assert.equal(enabledReport.admissionClosed, false);
  assert.equal(enabledReport.complete, false);
  assert.deepEqual(enabledReport.blockers, [{ kind: "admission_open" }]);
  const oldReport = await worker.control.drain(disabled.commandId);
  assert.equal(oldReport.valid, false);
  assert.equal(oldReport.admissionClosed, false);
  assert.deepEqual(oldReport.blockers, [{ kind: "control_changed" }, { kind: "admission_open" }]);
  await assert.rejects(worker.control.drain("invalid-command-id"));
  await assert.rejects(worker.control.drain(randomUUID()));
});

async function cli(args: string[], input = "") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../src/service/delegation-control-cli.ts", import.meta.url)), ...args], {
    env: { ...process.env, BIRBCREW_DATABASE_URL: url, BIRBCREW_TEMPORAL_ADDRESS: "127.0.0.1:1",
      BIRBCREW_TEMPORAL_TLS_CA_PATH: "/nonexistent-control-store-fixture-ca",
      BIRBCREW_TEMPORAL_TLS_CERTIFICATE_PATH: "/nonexistent-control-store-fixture-certificate",
      BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH: "/nonexistent-control-store-fixture-key",
      BIRBCREW_TEMPORAL_TLS_SERVER_NAME: "unreachable-control-store-fixture" },
    stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(15_000),
  });
  let stdout = "", stderr = "";
  const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
    if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > 65_536) child.kill("SIGKILL");
  };
  child.stdout.on("data", chunk => collect("stdout", chunk));
  child.stderr.on("data", chunk => collect("stderr", chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(input);
  const exitCode = await exited;
  assert.ok(stdout.length + stderr.length <= 65_536, "CLI output remains bounded");
  return { exitCode, stdout, stderr };
}

test("actual CLI change and status work with unreachable Temporal and unreadable TLS files", { timeout: 40_000 }, async () => {
  const input = await command(targetScope("cli-offline-" + randomUUID()));
  const changed = await cli(["change"], JSON.stringify(input));
  assert.equal(changed.exitCode, 0, changed.stderr);
  const receipt = controlReceiptSchema.parse(JSON.parse(changed.stdout));
  assert.equal(receipt.commandId, input.commandId);
  assert.equal(receipt.enabled, false);
  assert.deepEqual(await control.change(input), receipt);
  const status = await cli(["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), await control.status());
  record("actual CLI Temporal-independent change and status", { receipt, changeExit: changed.exitCode, statusExit: status.exitCode });
});

test("actual CLI rejects extra fields, malformed JSON and unknown operations without disclosing private input", { timeout: 60_000 }, async () => {
  const input = await command(targetScope("cli-strict-" + randomUUID()));
  const original = await control.status(), secret = "private-control-input-" + randomUUID();
  for (const [args, text] of [
    [["change"], JSON.stringify({ ...input, extra: secret })],
    [["change"], "{\"reason\":\"" + secret],
    [["unknown", secret], ""],
    [["status", secret], ""],
  ] satisfies [string[], string][]) {
    const result = await cli(args, text);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(z.object({ status: z.literal("failed"), message: z.string() }).parse(JSON.parse(result.stderr)).status, "failed");
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stderr.includes(url), false);
    assert.deepEqual(await control.status(), original);
  }
});

test("unconfirmed native stop stays pending until an authoritative stopped fact permits retry", { timeout: 25_000 }, async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  const started = await running(key);
  await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,child_id,token,workflow_run_id,activity_id,attempt)
    VALUES($1,$2,$3,$4,$5,$6,1)`, [key.conversationId, key.requestId, key.childId, started.generation,
    started.execution.workflowRunId, started.execution.activityId]);
  try {
    const receipt = await change(targetScope(f.profile));
    const pending = await flushChild(worker, key.childId);
    assert.equal(pending.settlement, "pending");
    assert.deepEqual(pending.wake, { kind: "deferred" });
    assert.deepEqual(worker.signals, [], "An unconfirmed native stop must not wake the workflow adapter");
    assert.equal((await childState(key)).phase, "running");
    assert.equal(z.object({ stopped: z.boolean() }).parse((await pool.query(
      "SELECT stopped FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rows[0]).stopped, false);
    const report = await worker.control.drain(receipt.commandId);
    assert.equal(report.complete, false);
    assert.ok(report.blockers.some(blocker => blocker.kind === "native_unconfirmed"
      && blocker.tokens.includes(started.generation)));
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE child_id=$1", [key.childId]);
    const restarted = workflowFixture();
    const retried = await flushChild(restarted, key.childId);
    assert.equal(retried.settlement, "settled");
    assert.equal(retried.wake.kind, "accepted");
    assert.deepEqual(restarted.signals.map(signal => signal.childId), [key.childId]);
    assert.equal((await childState(key)).phase, "failed");
    record("database-only native stop uncertainty", { childId: key.childId, firstSettlement: pending.settlement,
      firstWake: pending.wake.kind, workflowAdapterWakesBeforeConfirmation: worker.signals,
      afterAuthoritativeStoppedFact: retried.settlement, blockersBeforeStop: report.blockers });
  } finally {
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE child_id=$1", [key.childId]);
  }
});

test("reconciliation retries incomplete parent and native facts after enable but excludes fully settled history", async () => {
  const f = await delegation(), [key] = f.keys, worker = workflowFixture();
  await running(key);
  await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES($1,$2,$3,$4,'database-only-parent-launch',1)`,
  [key.conversationId, key.requestId, f.token, f.execution.workflowRunId]);
  try {
    const receipt = await change(targetScope(f.profile));
    assert.equal((await flushChild(worker, key.childId)).settlement, "settled");
    const terminal = await childState(key);
    assert.equal(terminal.phase, "failed");
    await change(targetScope(f.profile), true);
    const pendingParent = workflowFixture();
    assert.equal((await flushChild(pendingParent, key.childId)).wake.kind, "accepted");
    assert.deepEqual(pendingParent.signals.map(signal => signal.childId), [key.childId]);
    await finishParent(f);
    const pendingNative = workflowFixture();
    assert.equal((await flushChild(pendingNative, key.childId)).wake.kind, "accepted");
    assert.deepEqual(pendingNative.signals.map(signal => signal.childId), [key.childId]);
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND token=$2", [key.conversationId, f.token]);
    const restarted = workflowFixture();
    const quiescent = await restarted.control.flush();
    assert.deepEqual(quiescent, { examined: 0, children: [] });
    assert.deepEqual(restarted.signals, [], "A fully settled historical child must not receive another workflow wake");
    assert.deepEqual(await childState(key), terminal);
    assert.equal((await pool.query(`SELECT 1 FROM birbcrew_ts.delegation_control_children
      WHERE command_id=$1 AND child_id=$2 AND retire`, [receipt.commandId, key.childId])).rowCount, 1,
    "Excluding settled work must preserve permanent retirement membership");
    record("database-only historical reconciliation eligibility", { childId: key.childId,
      pendingParentWake: "accepted", pendingNativeWake: "accepted", quiescent, permanentRetirementPreserved: true });
  } finally {
    await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND token=$2", [key.conversationId, f.token]);
  }
});
