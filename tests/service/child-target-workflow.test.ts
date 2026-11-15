import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { memberActivities } from "../../src/service/activities.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { ChildStore, type ChildKey } from "../../src/service/children.ts";
import type { ChildTarget } from "../../src/service/child-target.ts";
import { MemberClient } from "../../src/service/client.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { activityQueue, memberTaskQueue } from "../../src/service/queues.ts";
import { MemberStore } from "../../src/service/store.ts";
import { recordSegmentUsage, UsageApi } from "../../src/service/usage.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";
import { memberQueueActivities } from "../../src/service/worker.ts";

// Child targets against a real Temporal server, Crew's worker activities, its supervisor and the Pi
// fixture provider (no inference): where a targeted child runs, what a workflow worker from before
// targets does with one, and whether histories that source recorded replay under this one. Needs
// a disposable PostgreSQL database, and either BIRBCREW_TEMPORAL_ADDRESS or TEMPORAL_CLI (Temporal
// CLI 1.10.0) to start a development server.
const database = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!database) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database");
const directory = await mkdtemp(join(tmpdir(), "birb-child-target-"));
const server = await temporalServer();
process.env.BIRBCREW_TEMPORAL_ADDRESS = server.address;
process.env.BIRBCREW_DATABASE_URL = database;
process.env.BIRBCREW_PROOF_ENGINE = "pi";
const logs = { parent: join(directory, "parent.jsonl"), target: join(directory, "target.jsonl") };
process.env.BIRBCREW_PROOF_REQUESTS = logs.parent;
process.env.BIRBCREW_PROOF_TARGET_REQUESTS = logs.target;
const parentProfile = "fixture.crew.v1", targetProfile = "fixture.crew-target.v1";
const target: ChildTarget = { engine: "pi", profile: targetProfile };
const workflowsPath = fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url));
// The supervisor loads the profiles from this module; the environment above must be set first.
const config = fileURLToPath(new URL("../proof/child-target-profiles.mts", import.meta.url));

// Inside the checkout, so the workflow bundle resolves this repository's packages.
const local = resolve(".proof", "child-target-" + randomUUID());
await mkdir(local, { recursive: true });
const legacyPath = join(local, "workflow.ts");
const legacySource = await readFile(new URL("../proof/fixtures/pre-child-target-workflow.ts.txt", import.meta.url), "utf8");
assert.ok(!legacySource.includes("target"), "the fixture is the workflow source from before child targets");
await writeFile(legacyPath, legacySource.replaceAll('from "./', 'from "../../src/service/'));

const pool = new Pool({ connectionString: database });
const store = new MemberStore(pool);
await store.migrate();
const children = new ChildStore(pool);
const { profiles } = await import("../proof/child-target-profiles.mts");
const stateDir = join(directory, "native");
await registerProfiles(pool, profiles, stateDir);
const model = profiles.get(parentProfile)!.pi!.model.id;
const connection = await Connection.connect({ address: server.address });
const temporal = new Client({ connection });
const native = await NativeConnection.connect({ address: server.address });
const supervisor = await startSupervisor(config, stateDir);
// The Claude queue only shows that a non-Pi target is refused before anything launches.
const engines = await Promise.all(([["pi", parentProfile], ["pi", targetProfile], ["claude", targetProfile]] as const).map(async ([engine, profile]) => {
  const worker = await Worker.create({ connection: native, taskQueue: activityQueue(engine, profile),
    activities: memberActivities(store, supervisor, profiles, stateDir, engine) });
  return { worker, done: worker.run() };
}));
const ledger = new ApprovalStore(pool);

const ownerId = "owner-" + randomUUID(), token = randomUUID();
const gateway = createGateway(store, new MemberClient(store, temporal), { [createHash("sha256").update(token).digest("hex")]: ownerId });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const port = (gateway.address() as AddressInfo).port;
const workflows: string[] = [];
after(async () => {
  // Every step runs even if an earlier one fails, so a failure cannot leave the server or workers running.
  const steps = [
    async () => { const closed = once(gateway, "close"); gateway.close(); gateway.closeAllConnections(); await closed; await gateway.stopped(); },
    async () => { for (const id of workflows) await temporal.workflow.getHandle(id).terminate("fixture cleanup").catch(() => {}); },
    async () => {
      for (const { worker } of engines) if (worker.getState() === "RUNNING") worker.shutdown();
      await Promise.all(engines.map(({ done }) => done));
    },
    () => supervisor.close(), () => native.close(), () => connection.close(), () => pool.end(), () => server.stop(),
    () => rm(local, { recursive: true, force: true }), () => rm(directory, { recursive: true, force: true }),
  ];
  const failures = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
});

/** The Temporal server BIRBCREW_TEMPORAL_ADDRESS names, else a development server from TEMPORAL_CLI. */
async function temporalServer() {
  const existing = process.env.BIRBCREW_TEMPORAL_ADDRESS;
  if (existing) return { address: existing, stop: async () => {} };
  const cli = process.env.TEMPORAL_CLI;
  if (!cli) throw new Error("Set BIRBCREW_TEMPORAL_ADDRESS, or TEMPORAL_CLI to start a Temporal development server");
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = "127.0.0.1:" + (probe.address() as AddressInfo).port;
  await new Promise(done => probe.close(done));
  const child = spawn(cli, ["server", "start-dev", "--headless", "--port", address.split(":")[1], "--db-filename", join(directory, "temporal.db")],
    { stdio: "ignore" });
  const exited = once(child, "exit");
  void exited.catch(() => {});
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited.catch(() => {}); } };
  for (let attempt = 0; ; attempt++) {
    try { await promisify(execFile)(cli, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"]); break; }
    catch (error) {
      if (attempt >= 120) { await stop(); throw error; }
      await delay(500);
    }
  }
  return { address, stop };
}

/** The conversation workflow's worker, with the activities worker.ts registers beside it, running the given source. */
async function workflowWorker(path = workflowsPath) {
  const worker = await Worker.create({ connection: native, taskQueue: memberTaskQueue, workflowsPath: path,
    activities: memberQueueActivities(store) });
  const done = worker.run();
  return { async stop() { worker.shutdown(); await done; } };
}

async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 60_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(200);
  }
  throw new Error("Timed out waiting for " + label);
}

async function api(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

const prompts = async (log: string) => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
  .map(line => (JSON.parse(line) as { prompt: string }).prompt);
const childRow = async (key: ChildKey) => (await pool.query<{ phase: string; native_call_id: string; outcome: unknown }>(
  "SELECT phase,native_call_id,outcome FROM birbcrew_ts.pi_children WHERE child_id=$1", [key.childId])).rows[0];

/** A Pi parent turn admitted and started, with one analyst child delegated as given. No parent
 * workflow runs: nothing a parent can produce yet carries a target. */
async function delegated(task: string, childTarget?: ChildTarget, role: "analyst" | "recorder" = "analyst") {
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: parentProfile });
  const conversationId = randomUUID();
  await store.openConversation({ ownerId, conversationId, memberId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "delegate" };
  const turn = await store.beginTurn(request, { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 });
  if (turn.kind !== "start") throw new Error("Expected a started turn");
  const [key] = await children.delegate(turn.conversation, request.requestId, turn.token, [{ nativeCallId: "call_" + randomUUID(), task,
    profile: { role, version: 1, instructions: role === "analyst" ? "Answer the assigned question using only the supplied task context."
      : "Complete the assigned task. Request owner approval to record a work item when asked.", model,
      tools: role === "recorder" ? ["record_work_item"] : [], ...(childTarget && { target: childTarget }) } }], { version: 1, engine: "pi", state: {} });
  return { key, memberId, conversationId, requestId: request.requestId };
}

async function exhaustParentBudget(key: ChildKey) {
  const { rows: [turn] } = await pool.query<{ token: string; workflow_run_id: string; activity_id: string; attempt: number }>(
    "SELECT token,workflow_run_id,activity_id,attempt FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",
    [key.conversationId, key.requestId]);
  const execution = { workflowRunId: turn.workflow_run_id, activityId: turn.activity_id, attempt: turn.attempt };
  await pool.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,$6)`, [key.conversationId, key.requestId, turn.token, execution.workflowRunId, execution.activityId, execution.attempt]);
  await recordSegmentUsage(pool, { ownerId: key.ownerId, conversationId: key.conversationId, requestId: key.requestId,
    token: turn.token, execution, text: "delegate" }, { state: "reported", model, inputTokens: 9, outputTokens: 1,
    cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null });
  const budget = await new UsageApi(store).setBudget(key.ownerId, key.memberId, { tokenLimit: 10 });
  assert.equal(budget.admitting, false);
}
const childAudit = async (key: ChildKey) => (await pool.query("SELECT event_type,payload FROM birbcrew_ts.audit_events WHERE payload->>'childId'=$1 ORDER BY event_id",
  [key.childId])).rows;

/** Starts the child's workflow, as its parent's executeChild would. */
async function startChild(key: ChildKey) {
  const workflowId = `birbcrew-ts/child/${key.childId}`;
  workflows.push(workflowId);
  return { workflowId, handle: await temporal.workflow.start("piChildWorkflow", { workflowId, taskQueue: memberTaskQueue, args: [key, parentProfile] }) };
}
async function runChild(key: ChildKey) {
  const { workflowId, handle } = await startChild(key);
  await handle.result();
  return workflowId;
}

/** Replays the history with the given source and reports the queue of each child segment and the patches. */
async function replay(workflowId: string, path = workflowsPath) {
  const recorded = await temporal.workflow.getHandle(workflowId).fetchHistory();
  await Worker.runReplayHistory({ workflowsPath: path }, recorded, workflowId);
  const events = recorded.events ?? [];
  const scheduled = (name: string) => events.flatMap(event => event.activityTaskScheduledEventAttributes?.activityType?.name === name
    ? [event.activityTaskScheduledEventAttributes.taskQueue?.name] : []);
  return {
    queues: scheduled("executeChildSegment"), settled: scheduled("settleApproval"),
    failures: events.flatMap(event => event.activityTaskFailedEventAttributes?.failure?.applicationFailureInfo?.type ?? []),
    patches: events.flatMap(event => event.markerRecordedEventAttributes?.markerName === "core_patch"
      ? (event.markerRecordedEventAttributes.details?.["patch-data"]?.payloads ?? []).map(payload => Buffer.from(payload.data ?? []).toString())
      : []),
  };
}

test("a child whose row names a Pi target runs on that profile's queue and driver, as its parent member's spend", { timeout: 180_000 }, async () => {
  const worker = await workflowWorker();
  try {
    const nonce = randomUUID();
    const { key, memberId } = await delegated("remember " + nonce, target);
    assert.deepEqual(key.target, target);
    const workflowId = await runChild(key);
    const row = await childRow(key);
    assert.deepEqual([row.phase, row.outcome], ["complete", { kind: "completed", nativeCallId: row.native_call_id, text: "stored " + nonce }]);
    assert.ok((await prompts(logs.target)).includes("remember " + nonce), "the target profile's driver ran the child");
    assert.ok(!(await prompts(logs.parent)).includes("remember " + nonce), "the parent profile's driver did not");
    const usage = await pool.query("SELECT member_id,engine FROM birbcrew_ts.usage_ledger WHERE child_id=$1", [key.childId]);
    assert.deepEqual(usage.rows, [{ member_id: memberId, engine: "pi" }]);
    const replayed = await replay(workflowId);
    assert.deepEqual(replayed.queues, [activityQueue("pi", targetProfile)]);
    assert.deepEqual(replayed.patches, []);
    // The pre-target source replays this history too: replay never compares an activity's task
    // queue, so only the activity's own check stops such a worker from misrouting a child.
    await replay(workflowId, legacyPath);
  } finally { await worker.stop(); }
});

test("a workflow worker from before targets schedules a targeted child on its parent's queue, and the activity refuses it", { timeout: 180_000 }, async () => {
  const worker = await workflowWorker(legacyPath);
  try {
    const nonce = randomUUID();
    const { key } = await delegated("remember " + nonce, target);
    const workflowId = await runChild(key);
    const row = await childRow(key);
    assert.deepEqual([row.phase, row.outcome], ["failed", { kind: "failed", nativeCallId: row.native_call_id, code: "child_failed" }]);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rowCount, 0);
    for (const log of Object.values(logs)) assert.ok(!(await prompts(log)).includes("remember " + nonce));
    const replayed = await replay(workflowId, legacyPath);
    assert.deepEqual(replayed.queues, [activityQueue("pi", parentProfile)]);
    assert.deepEqual(replayed.failures, ["ChildTargetMismatch"]);
    await replay(workflowId);
  } finally { await worker.stop(); }
});

test("an exhausted child finishes its actual workflow without a native launch or provider request", { timeout: 180_000 }, async () => {
  const worker = await workflowWorker();
  try {
    const task = "remember " + randomUUID();
    const { key } = await delegated(task, target);
    await exhaustParentBudget(key);
    const workflowId = await runChild(key);
    const row = await childRow(key);
    assert.deepEqual(row.outcome, { kind: "failed", nativeCallId: row.native_call_id, code: "budget_exhausted" });
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rowCount, 0);
    for (const log of Object.values(logs)) assert.ok(!(await prompts(log)).includes(task));
    assert.deepEqual(await childAudit(key), [{ event_type: "delegation.finished",
      payload: { childId: key.childId, outcome: "failed", code: "budget_exhausted" } }]);
    await replay(workflowId);
  } finally { await worker.stop(); }
});

test("a targeted recorder resumes over budget on its target queue with one start and finish audit", { timeout: 180_000 }, async () => {
  const worker = await workflowWorker();
  try {
    const task = "record assigned " + randomUUID();
    const { key, memberId, conversationId, requestId } = await delegated(task, target, "recorder");
    const { workflowId, handle } = await startChild(key);
    const card = await until(async () => (await ledger.pending({ ownerId, memberId, conversationId }))
      .find(approval => approval.invocationId === key.childId), "the child's card");
    await exhaustParentBudget(key);
    const { approvalId, invocationId, nativeCallId, argumentDigest, version } = card;
    assert.equal(await ledger.decide({ ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId,
      argumentDigest, version, choice: "approve" }), "approve");
    await handle.signal("childDecision");
    await handle.result();
    const row = await childRow(key);
    assert.equal(row.phase, "complete");
    const outcome = row.outcome as { kind: string; text: string };
    assert.equal(outcome.kind, "completed");
    assert.equal(JSON.parse(outcome.text.slice("settled ".length)).kind, "recorded");
    assert.deepEqual((await childAudit(key)).map(fact => fact.event_type), ["delegation.started", "delegation.finished"]);
    // Both segments, the proposal and the resume after the card, ran on the target's driver.
    assert.equal((await prompts(logs.target)).filter(prompt => prompt === task).length, 2);
    assert.equal((await prompts(logs.parent)).filter(prompt => prompt === task).length, 0);
    const replayed = await replay(workflowId);
    assert.deepEqual(replayed.queues, [activityQueue("pi", targetProfile), activityQueue("pi", targetProfile)]);
    assert.deepEqual(replayed.settled, [activityQueue("pi", targetProfile)]);
  } finally { await worker.stop(); }
});

test("a child whose row names a Claude target is refused on that queue before anything launches", { timeout: 180_000 }, async () => {
  const worker = await workflowWorker();
  try {
    const nonce = randomUUID();
    const { key } = await delegated("remember " + nonce, target);
    // The store refuses a Claude target, so write one directly, as a later release or an operator might.
    await pool.query(`UPDATE birbcrew_ts.pi_children SET role_profile=jsonb_set(role_profile,'{target,engine}','"claude"')
      WHERE child_id=$1`, [key.childId]);
    const workflowId = await runChild({ ...key, target: { engine: "claude", profile: targetProfile } });
    const row = await childRow(key);
    assert.deepEqual([row.phase, row.outcome], ["failed", { kind: "failed", nativeCallId: row.native_call_id, code: "child_failed" }]);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rowCount, 0);
    for (const log of Object.values(logs)) assert.ok(!(await prompts(log)).includes("remember " + nonce));
    const replayed = await replay(workflowId);
    assert.deepEqual(replayed.queues, [activityQueue("claude", targetProfile)]);
    assert.deepEqual(replayed.failures, ["ChildTargetError"]);
  } finally { await worker.stop(); }
});

test("histories recorded with the workflow source before targets replay, and a child card it left waiting is answered under this one",
  { timeout: 240_000 }, async () => {
    async function delegation(tasks: { role: "analyst" | "recorder"; task: string }[]) {
      const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: parentProfile });
      const conversationId = randomUUID(), requestId = randomUUID(), base = `/v1/conversations/${conversationId}`;
      assert.equal((await api("/v1/conversations", { conversationId, memberId })).status, 201);
      const workflowId = `birbcrew-ts/member/${memberId}/conversation/${conversationId}`;
      workflows.push(workflowId);
      const submitted = await api(`${base}/requests`, { requestId, text: "delegate " + JSON.stringify(tasks) });
      assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
      return {
        memberId, requestId, workflowId, base,
        settled: (phase: string) => until(async () => (await api(base)).body.state.phase === phase || undefined, "phase " + phase),
        reply: async () => (await pool.query<{ reply: string }>("SELECT reply FROM birbcrew_ts.turns WHERE request_id=$1", [requestId])).rows[0].reply,
        children: async () => (await pool.query<{ child_id: string }>("SELECT child_id FROM birbcrew_ts.pi_children WHERE request_id=$1 ORDER BY ordinal",
          [requestId])).rows.map(row => `birbcrew-ts/child/${row.child_id}`),
      };
    }
    let worker = await workflowWorker(legacyPath);
    try {
      const finished = await delegation([{ role: "analyst", task: "remember " + randomUUID() }]);
      await finished.settled("idle");
      const waiting = await delegation([{ role: "analyst", task: "remember " + randomUUID() }, { role: "recorder", task: "record assigned cedar" }]);
      const card = await until(async () => (await api(waiting.base)).body.state.pendingApprovals[0], "the child's card");
      const [, recorder] = await waiting.children();
      assert.equal(recorder, `birbcrew-ts/child/${card.invocationId}`);
      await worker.stop();
      worker = await workflowWorker();
      assert.deepEqual(await api(`${waiting.base}/human`, { memberId: waiting.memberId, requestId: waiting.requestId,
        invocationId: card.invocationId, approvalId: card.approvalId, version: card.version, choice: "approve" }),
      { status: 200, body: { approvalId: card.approvalId, decision: "approve" } });
      await waiting.settled("idle");
      assert.match(await finished.reply(), /^delegated \[\{"kind":"completed"/);
      const outcomes = JSON.parse((await waiting.reply()).slice("delegated ".length)) as { kind: string; text: string }[];
      assert.deepEqual(outcomes.map(outcome => outcome.kind), ["completed", "completed"]);
      assert.equal(JSON.parse(outcomes[1].text.slice("settled ".length)).kind, "recorded");
      const parentQueue = activityQueue("pi", parentProfile);
      // Analysts run one segment; the recorder's second segment and its card's settlement were
      // scheduled by this release, on the same queue the previous one would have used.
      const expected = [[[parentQueue]], [[parentQueue], [parentQueue, parentQueue]]];
      for (const [index, r] of [finished, waiting].entries()) {
        await replay(r.workflowId);
        const children = await r.children();
        assert.equal(children.length, expected[index].length);
        for (const [ordinal, child] of children.entries()) {
          const replayed = await replay(child);
          assert.deepEqual(replayed.queues, expected[index][ordinal], child);
          assert.deepEqual(replayed.settled, expected[index][ordinal].slice(1), child);
          assert.deepEqual(replayed.patches, []);
        }
      }
    } finally { await worker.stop(); }
  });
