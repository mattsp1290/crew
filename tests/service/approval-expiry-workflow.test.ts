import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { expiryActivity, memberActivities } from "../../src/service/activities.ts";
import { ChildStore } from "../../src/service/children.ts";
import { MemberClient } from "../../src/service/client.ts";
import { cancelLive, decideLiveActivity } from "../../src/service/codex-calls.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { progressActivity } from "../../src/service/progress-activity.ts";
import { activityQueue, memberTaskQueue } from "../../src/service/queues.ts";
import { MemberStore, ownerAdmissionActivity } from "../../src/service/store.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";

// The conversation workflow's deadline timer against a real Temporal server, Crew's worker
// activities and the Pi fixture provider (no inference). Needs a disposable PostgreSQL database
// and a Temporal CLI 1.10.0 development server; the Pi engine needs no native launcher.
const database = process.env.BIRBCREW_TEST_DATABASE_URL, address = process.env.BIRBCREW_TEMPORAL_ADDRESS;
if (!database || !address) throw new Error("Set BIRBCREW_TEST_DATABASE_URL and BIRBCREW_TEMPORAL_ADDRESS");
process.env.BIRBCREW_DATABASE_URL = database;
process.env.BIRBCREW_PROOF_ENGINE = "pi";
const fixture = fileURLToPath(new URL("../proof/fixture-profiles.mts", import.meta.url));
const workflowsPath = fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url));
const profile = "fixture.approval.v1";

const pool = new Pool({ connectionString: database });
const store = new MemberStore(pool);
await store.migrate();
const { profiles } = await import(new URL("../proof/fixture-profiles.mts", import.meta.url).href);
const stateDir = await mkdtemp(join(tmpdir(), "birb-expiry-"));
await registerProfiles(pool, profiles, stateDir);
const connection = await Connection.connect({ address });
const temporal = new Client({ connection });
const native = await NativeConnection.connect({ address });
const supervisor = await startSupervisor(fixture, stateDir);
const engine = await Worker.create({ connection: native, taskQueue: activityQueue("pi", profile),
  activities: memberActivities(store, supervisor, profiles, stateDir, "pi") });
const engineRun = engine.run();

const ownerId = "owner-" + randomUUID(), token = randomUUID();
const server = createGateway(store, new MemberClient(store, temporal), { [createHash("sha256").update(token).digest("hex")]: ownerId });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const bound = server.address();
assert.ok(bound && typeof bound !== "string");
const port = bound.port;
const workflows: string[] = [];
after(async () => {
  const closed = once(server, "close");
  server.close(); server.closeAllConnections();
  await closed; await server.stopped();
  for (const id of workflows) await temporal.workflow.getHandle(id).terminate("fixture cleanup").catch(() => {});
  engine.shutdown(); await engineRun;
  await supervisor.close();
  await native.close(); await connection.close(); await pool.end();
  await rm(stateDir, { recursive: true, force: true });
});

/** The conversation workflow's worker, as worker.ts registers it, running the given source. */
async function workflowWorker(path = workflowsPath) {
  const children = new ChildStore(pool);
  const worker = await Worker.create({ connection: native, taskQueue: memberTaskQueue, workflowsPath: path, activities: {
    rejectUnstartedAdmission: store.rejectUnstartedAdmission.bind(store), recordAcceptance: ownerAdmissionActivity(store),
    rejectAccepted: store.rejectAccepted.bind(store), conversationProgress: progressActivity(store),
    cancelGenerating: store.cancelGenerating.bind(store), decideLive: decideLiveActivity.bind(null, pool), cancelLive: cancelLive.bind(null, pool),
    reconcileTurn: store.reconcileTurn.bind(store), reconcileChild: children.reconcile.bind(children),
    closeExitedChild: children.closeExitedChild.bind(children), quarantineDelegation: children.quarantineDelegation.bind(children),
    expireApproval: expiryActivity(store),
  } });
  const done = worker.run();
  return { async stop() { worker.shutdown(); await done; } };
}

async function api(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 40_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(200);
  }
  throw new Error("Timed out waiting for " + label);
}

/** A new conversation with one request through the v1 route, waiting at its card. */
async function carded(deadline?: number) {
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID(), requestId = randomUUID(), base = `/v1/conversations/${conversationId}`;
  assert.equal((await api("/v1/conversations", { conversationId, memberId })).status, 201);
  const workflowId = `birbcrew-ts/member/${memberId}/conversation/${conversationId}`;
  workflows.push(workflowId);
  const submitted = await api(`${base}/requests`, { requestId, text: "record " + requestId,
    ...(deadline === undefined ? {} : { approvalDeadlineSeconds: deadline }) });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  const card = await until(async () => (await api(base)).body.state.pendingApprovals[0], "the card");
  const snapshot = async () => (await api(base)).body;
  return {
    card, workflowId, requestId, snapshot,
    decide: (choice: string, decisionId?: string) => api(`${base}/human`, { memberId, requestId, invocationId: card.invocationId,
      approvalId: card.approvalId, version: card.version, choice, ...(decisionId && { decisionId }) }),
    receipt: async () => (await api(`${base}/requests/${requestId}`)).body,
    settled: (phase: string, timeout?: number) => until(async () => {
      const current = await snapshot();
      return current.state.phase === phase ? current : undefined;
    }, "phase " + phase, timeout),
  };
}

/** Replays the history with this release's workflow and counts what it recorded. */
async function history(workflowId: string) {
  const recorded = await temporal.workflow.getHandle(workflowId).fetchHistory();
  const events = recorded.events ?? [];
  const markers = events.flatMap(event => event.markerRecordedEventAttributes?.markerName === "core_patch"
    ? (event.markerRecordedEventAttributes.details?.["patch-data"]?.payloads ?? []).map(payload => Buffer.from(payload.data ?? []).toString())
    : []).filter(patch => patch.includes("approval-expiry-v1"));
  await Worker.runReplayHistory({ workflowsPath }, recorded, workflowId);
  return { markers: markers.length, timers: events.filter(event => event.timerStartedEventAttributes).length,
    cancelledTimers: events.filter(event => event.timerCanceledEventAttributes).length,
    expiries: events.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === "expireApproval").length };
}

test("a card nobody answers expires at its deadline in the workflow, and the history replays", { timeout: 180_000 }, async () => {
  const worker = await workflowWorker();
  try {
    const r = await carded(60);
    const left = Date.parse(r.card.expiresAt) - Date.now();
    assert.ok(left > 50_000 && left <= 61_000, String(left));
    // As if the database clock lagged the Temporal server's by 5 s: the timer fires first, the
    // database answers early, and the workflow waits out the rest before it expires the card.
    await pool.query("UPDATE birbcrew_ts.deferred_calls SET expires_at=expires_at + interval '5 seconds' WHERE approval_id=$1",
      [r.card.approvalId]);
    const end = await r.settled("cancelled", 100_000);
    assert.deepEqual(end.state.pendingApprovals, []);
    assert.deepEqual(end.state.expiredCalls.map((call: { approvalId: string }) => call.approvalId), [r.card.approvalId]);
    const receipt = await r.receipt();
    assert.deepEqual([receipt.status, receipt.expiredApproval.approvalId], ["completed", r.card.approvalId]);
    assert.ok(Date.parse(receipt.expiredApproval.expiredAt) >= Date.parse(r.card.expiresAt) + 5_000);
    assert.equal(end.messages.find((m: { role: string; toolCallId?: string }) => m.role === "tool" && m.toolCallId === r.card.approvalId)
      ?.content, JSON.stringify({ kind: "cancelled" }), "the native call got a cancelled result");
    assert.deepEqual(await r.decide("approve"), { status: 409, body: { error: "conflict" } });
    const { rows } = await pool.query(`SELECT event_type AS type, actor_kind AS actor FROM birbcrew_ts.audit_events
      WHERE request_id=$1 ORDER BY event_id`, [r.requestId]);
    assert.deepEqual(rows.map(row => row.type), ["request.accepted", "approval.requested", "approval.expired", "request.finished"]);
    assert.equal(rows[2].actor, "system");
    // An expiry cancels the request, which closes the conversation as a cancel does.
    await temporal.workflow.getHandle(r.workflowId).result();
    assert.deepEqual(await history(r.workflowId), { markers: 1, timers: 2, cancelledTimers: 0, expiries: 2 });
  } finally { await worker.stop(); }
});

test("an answer before the deadline wins and stops the timer; a card without one records no patch marker", { timeout: 120_000 }, async () => {
  const worker = await workflowWorker();
  try {
    for (const deadline of [600, undefined]) {
      const r = await carded(deadline);
      assert.equal(r.card.expiresAt === undefined, deadline === undefined);
      assert.deepEqual(await r.decide("approve"), { status: 200, body: { approvalId: r.card.approvalId, decision: "approve" } });
      const end = await r.settled("idle");
      assert.equal(end.state.expiredCalls, undefined);
      assert.equal((await r.receipt()).expiredApproval, undefined);
      const timed = deadline === undefined ? 0 : 1;
      assert.deepEqual(await history(r.workflowId), { markers: timed, timers: timed, cancelledTimers: timed, expiries: 0 }, String(deadline));
    }
  } finally { await worker.stop(); }
});

test("histories of the previous release replay, and a card it left waiting is answered under this one", { timeout: 180_000 }, async () => {
  // The workflow source of the release before approval expiry, against this release's modules.
  const directory = join(".proof", "expiry-" + randomUUID());
  await mkdir(directory, { recursive: true });
  try {
    const legacy = join(directory, "workflow.ts");
    const source = await readFile(new URL("../proof/fixtures/pre-expiry-workflow.ts.txt", import.meta.url), "utf8");
    assert.ok(!source.includes("approval-expiry-v1"));
    await writeFile(legacy, source.replaceAll('from "./', 'from "../../src/service/'));
    let worker = await workflowWorker(fileURLToPath(new URL("../../" + legacy, import.meta.url)));
    const finished = await carded();
    await finished.decide("approve");
    await finished.settled("idle");
    const inFlight = await carded();
    await worker.stop();
    worker = await workflowWorker();
    try {
      assert.deepEqual(await inFlight.decide("approve"), { status: 200, body: { approvalId: inFlight.card.approvalId, decision: "approve" } });
      await inFlight.settled("idle", 60_000);
      for (const r of [finished, inFlight]) {
        assert.deepEqual(await history(r.workflowId), { markers: 0, timers: 0, cancelledTimers: 0, expiries: 0 });
      }
    } finally { await worker.stop(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a named decision crosses the decide update unchanged, replays exactly, and its history replays", { timeout: 120_000 }, async () => {
  const worker = await workflowWorker();
  try {
    const r = await carded(600);
    const decisionId = randomUUID();
    assert.deepEqual(await r.decide("approve", decisionId),
      { status: 200, body: { approvalId: r.card.approvalId, decision: "approve", decisionId } });
    await r.settled("idle");
    assert.deepEqual(await r.decide("approve", decisionId),
      { status: 200, body: { approvalId: r.card.approvalId, decision: "approve", decisionId } });
    assert.deepEqual(await r.decide("approve", randomUUID()), { status: 409, body: { error: "decision_conflict" } });
    const { rows } = await pool.query("SELECT event_type AS type FROM birbcrew_ts.audit_events WHERE request_id=$1 ORDER BY event_id", [r.requestId]);
    assert.equal(rows.filter(row => row.type === "approval.decided").length, 1);
    const updates = (await temporal.workflow.getHandle(r.workflowId).fetchHistory()).events?.filter(event =>
      event.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.name === "decide") ?? [];
    assert.equal(updates.length, 1, "a replayed decision is answered from SQL, not by a second update");
    assert.deepEqual(await history(r.workflowId), { markers: 1, timers: 1, cancelledTimers: 1, expiries: 0 });
  } finally { await worker.stop(); }
});
