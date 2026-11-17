import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { z } from "zod";
import { memberActivities, type MemberActivities } from "../../src/service/activities.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { type ChildKey } from "../../src/service/children.ts";
import { MemberClient } from "../../src/service/client.ts";
import { DelegationReconciler, changeControl, controlState, drainDelegation, parentResultKeySchema, reconciliationPage,
  settledParentResultSchema, type ChildWorkflowControl, type ControlCommand, type ControlReceipt,
  type SettledParentResult } from "../../src/service/delegation-control.ts";
import { TemporalDelegationWorkflows } from "../../src/service/delegation-control-workflows.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { activityQueue, memberTaskQueue } from "../../src/service/queues.ts";
import { MemberStore } from "../../src/service/store.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";
import { memberQueueActivities } from "../../src/service/worker.ts";
import { absent, controlProvider, digest, ownedProcess, redact, runnerLoads, temporalDevServer, until, type LogCapture,
  type Task } from "../proof/delegation-control-fixture.mts";
import { before, boundedCommand, now } from "../proof/member-service-diagnostics.mts";
import { workingState } from "../proof/member-services.mts";
import { spawnHistoricalMember, testDatabaseName } from "./database-fixtures.ts";
import { adapterHistoryCases } from "./delegation-control-history-cases.ts";

const configuredDatabase = process.env.BIRBCREW_TEST_DATABASE_URL;
assert.ok(configuredDatabase, "Use this suite's own fresh disposable PostgreSQL 17 database");
const database = configuredDatabase;
assert.equal(process.platform, "linux", "The actual Pi proof requires the production Linux confinement launcher");
const directory = await mkdtemp(join(tmpdir(), "crew-control-workflow-"));
const proof = process.env.BIRBCREW_CONTROL_PROOF_DIR;
if (proof) { assert.ok(isAbsolute(proof)); await mkdir(proof, { recursive: true, mode: 0o700 }); }
const policy = workingState(process.env);
const cleanupSteps: (() => Promise<unknown>)[] = [];
const cleanupResults: { scope: string; state: string }[] = [];
type OwnedProcess = { scope: string; child: ChildProcess; stopped: boolean; logPath: string; capture: LogCapture | undefined };
const processes: OwnedProcess[] = [];
const workflowIds = new Set<string>();
const runnerLog = join(directory, "profile-loads.jsonl");
const config = fileURLToPath(new URL("../proof/delegation-control-profiles.mts", import.meta.url));
const currentWorkflow = fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url));
const local = resolve(".proof", "delegation-control-" + randomUUID());
const oldWorkflow = join(local, "workflow.ts");
const parentProfile = "control.parent.v1", legacyProfile = "control.legacy.v1";
const analystProfile = "control.analyst.v1", recorderProfile = "control.recorder.v1";
const stateDir = join(directory, "native");
const ownerId = "control-owner-" + randomUUID();

async function evidence(name: string, value: unknown) {
  if (!proof) return;
  assert.match(name, /^[a-z0-9-]+$/);
  const bytes = JSON.stringify({ scope: "actual-pi-temporal-control-fixture", observedAt: new Date().toISOString(), value });
  assert.ok(Buffer.byteLength(bytes) <= 512 * 1024, "Bounded control evidence");
  await writeFile(join(proof, name + ".json"), bytes + "\n", { mode: 0o600 });
}

after(async () => {
  const failures: unknown[] = [];
  for (const step of cleanupSteps.reverse()) {
    try { await before(step(), now() + 25_000, "Control fixture cleanup"); }
    catch (error) { failures.push(error); }
  }
  let retained = false;
  try { await retainProcessDiagnostics(); retained = true; } catch (error) { failures.push(error); }
  let runnerObservations: { pid: number; absent: boolean }[] = [];
  try {
    const runners = await runnerLoads(runnerLog);
    runnerObservations = runners.filter(row => row.loadedBy === "supervisor-runner.ts")
      .map(row => ({ pid: row.pid, absent: absent(row.pid) }));
  } catch (error) { failures.push(error); }
  if (runnerObservations.some(row => !row.absent)) failures.push(new Error("A known fixture runner PID remains live"));
  await evidence("cleanup", { workingState: policy, knownProcesses: processes.map(({ scope, child, stopped }) => ({
    scope, pid: child.pid, stopped, exitCode: child.exitCode, signalCode: child.signalCode,
  })), runnerObservations, cleanupResults, diagnosticRetention: retained ? "completed" : "failed-temp-directory-retained",
    ancestry: "unproven", failures: failures.map(error => error instanceof Error ? error.message : "cleanup failure") });
  await evidence("captured-provider-requests", wire);
  await rm(local, { recursive: true, force: true });
  if (retained) await rm(directory, { recursive: true, force: true });
  if (failures.length) throw new AggregateError(failures, "Control workflow fixture cleanup failed");
});

async function retainProcessDiagnostics() {
  if (!proof) return;
  const observations: unknown[] = [], failures: unknown[] = [];
  for (const process of processes) {
    try {
      const bytes = await readFile(process.logPath);
      assert.ok(bytes.length <= 1024 * 1024, "Canonical process log retention bound");
      const start = Math.max(0, bytes.length - 64 * 1024);
      const selected = bytes.subarray(start).toString("utf8");
      const safe = redact(selected, database);
      const artifact = process.scope + "-diagnostics.log";
      const output = Buffer.from(safe);
      assert.ok(output.length <= 96 * 1024, "Sanitized process diagnostic bound");
      await writeFile(join(proof, artifact), output, { mode: 0o600 });
      observations.push({ scope: process.scope, artifact, pid: process.child.pid, observedAt: new Date().toISOString(),
        capture: process.capture ?? null, captureClosed: process.capture !== undefined, sourceFileBytes: bytes.length,
        selectedStartByte: start, selectedBytes: bytes.length - start, artifactBytes: output.length,
        artifactSha256: digest(output), sanitized: safe !== selected,
        selection: "last-64KiB-of-canonical-retained-prefix", selectedTailTruncated: start > 0 });
    } catch (error) {
      failures.push(error);
      observations.push({ scope: process.scope, artifact: null, state: "retention-failed" });
    }
  }
  await evidence("diagnostic-retention", { observations, complete: failures.length === 0,
    scope: "owned-fixture-Temporal-and-worker-stdout-stderr", ancestry: "unproven" });
  if (failures.length) throw new AggregateError(failures, "Owned process diagnostic retention failed");
}

function owned(scope: string, program: string, args: string[], env = process.env, shutdown: "group" | "process" = "group") {
  const logPath = join(directory, scope + ".log");
  const owner = ownedProcess({ scope, program, args, env, logPath, shutdown, async afterStop(child, capture) {
    observation.capture = capture;
    await evidence(scope + "-process", { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, capture });
  } });
  const observation: OwnedProcess = { scope, child: owner.child, stopped: false, logPath, capture: undefined };
  processes.push(observation);
  const stop = async () => { await owner.stop(); observation.stopped = true; };
  cleanupSteps.push(stop);
  return { child: owner.child, stop, logPath };
}

const childOutcomeSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("failed"), nativeCallId: z.string(), code: z.string() }),
  z.looseObject({ kind: z.literal("completed"), nativeCallId: z.string(), text: z.string() }),
  z.looseObject({ kind: z.literal("cancelled"), nativeCallId: z.string() }),
]);
const held = new Map<string, { release: () => void; closed: Promise<void> }>();
/** Follow-up replies to hold, by provider hold key. Every `hold` prompt is held. */
const holds = new Set<string>();
const provider = controlProvider({ note: "synthetic control fixture note", limit: 200, outcome: value => childOutcomeSchema.parse(value),
  hold(key, release, closed) {
    if (!key.startsWith("child/") && !holds.has(key)) return false;
    assert.ok(!held.has(key), "A provider barrier can have only one live response");
    held.set(key, { release, closed });
    void closed.finally(() => held.delete(key));
    return true;
  } });
const { wire } = provider;
const providerEndpoint = await provider.listen();
cleanupSteps.push(async () => { await provider.close(); cleanupResults.push({ scope: "provider", state: "closed" }); });
assert.equal(process.env.BIRBCREW_TEMPORAL_ADDRESS, undefined, "This suite owns a fresh Temporal development server");
const temporalCli = process.env.TEMPORAL_CLI;
assert.ok(temporalCli, "TEMPORAL_CLI must name the official Temporal CLI 1.10.0 fixture");
const { address, version: temporalVersion } = await temporalDevServer(temporalCli, directory, args => owned("temporal", temporalCli, args));
await evidence("prerequisites", { temporalVersion, node: process.version, platform: "linux", database: "separate-fresh-pg17" });
process.env.BIRBCREW_TEMPORAL_ADDRESS = address;
process.env.BIRBCREW_TEMPORAL_NAMESPACE = "default";
process.env.BIRBCREW_DATABASE_URL = database;
process.env.BIRBCREW_CONTROL_FIXTURE_ENDPOINT = providerEndpoint;
process.env.BIRBCREW_CONTROL_RUNNER_LOG = runnerLog;
const pool = new Pool({ connectionString: database, application_name: "control-workflow-fixture" });
cleanupSteps.push(async () => { await pool.end(); cleanupResults.push({ scope: "main-pool", state: "ended" }); });
const version = (await pool.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version;
assert.equal(Math.floor(Number(version) / 10000), 17);
assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='birbcrew_ts'")).rowCount, 0,
  "This suite must not share the SQL migration or other service test database");
const store = new MemberStore(pool); await store.migrate();
const ledger = new ApprovalStore(pool);
const { profiles, close: closeProfiles } = await import("../proof/delegation-control-profiles.mts");
cleanupSteps.push(closeProfiles);
await registerProfiles(pool, profiles, stateDir);
const connection = await Connection.connect({ address });
cleanupSteps.push(async () => { await connection.close(); cleanupResults.push({ scope: "temporal-client", state: "closed" }); });
const temporal = new Client({ connection });
const native = await NativeConnection.connect({ address });
cleanupSteps.push(async () => { await native.close(); cleanupResults.push({ scope: "temporal-native", state: "closed" }); });
const members = new MemberClient(store, temporal);
const temporalControl = { pool, workflows: new TemporalDelegationWorkflows(temporal) };
const control = new DelegationReconciler(temporalControl);
await mkdir(local, { recursive: true });
await writeFile(oldWorkflow, (await readFile(new URL("../proof/fixtures/pre-child-target-workflow.ts.txt", import.meta.url), "utf8"))
  .replaceAll('from "./', 'from "../../src/service/'));

type RunningWorker = { stop: () => Promise<void> };
const manualWorkers = new Set<RunningWorker>();
cleanupSteps.push(async () => {
  const results = await Promise.allSettled([...manualWorkers].map(worker => before(worker.stop(), now() + 20_000, "Manual worker cleanup")));
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Manual worker cleanup failed");
});
cleanupSteps.push(async () => {
  const results = await Promise.allSettled([...workflowIds].map(async id => {
    const handle = temporal.workflow.getHandle(id);
    const description = await handle.describe();
    if (description.status.name === "RUNNING") await handle.terminate("owned control fixture cleanup");
  }));
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Owned workflow cleanup failed");
});
async function workflowWorker(path = currentWorkflow) {
  const worker = await Worker.create({ connection: native, taskQueue: memberTaskQueue, workflowsPath: path, activities: memberQueueActivities(store) });
  return runWorker(worker);
}
function runWorker(worker: Worker) {
  const done = worker.run(); void done.catch(() => {});
  let stopping: Promise<void> | undefined;
  const running = { stop: () => stopping ??= (async () => {
    if (worker.getState() === "RUNNING") worker.shutdown();
    await done; manualWorkers.delete(running);
  })() };
  manualWorkers.add(running); return running;
}
async function activityWorkers(names = [parentProfile, legacyProfile, analystProfile, recorderProfile],
  wrapExecuteTurn?: (executeTurn: MemberActivities["executeTurn"]) => MemberActivities["executeTurn"]) {
  const supervisor = await startSupervisor(config, stateDir);
  const running: RunningWorker[] = [];
  try {
    for (const name of names) {
      const activities = memberActivities(store, supervisor, profiles, stateDir, "pi");
      if (wrapExecuteTurn) activities.executeTurn = wrapExecuteTurn(activities.executeTurn);
      running.push(runWorker(await Worker.create({ connection: native, taskQueue: activityQueue("pi", name), activities })));
    }
  } catch (error) { await Promise.allSettled(running.map(worker => worker.stop())); await supervisor.close(); throw error; }
  let stopping: Promise<void> | undefined;
  const group = { stop: () => stopping ??= (async () => {
    const failures: unknown[] = [];
    try {
      const results = await Promise.allSettled(running.map(worker => before(worker.stop(), now() + 10_000, "Activity worker stop")));
      failures.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    } finally {
      try {
        await before(supervisor.close(), now() + 10_000, "Owned supervisor close");
        await before(supervisor.exited, now() + 1000, "Owned supervisor exit");
        cleanupResults.push({ scope: "manual-supervisor", state: "exited" });
      } catch (error) {
        failures.push(error); cleanupResults.push({ scope: "manual-supervisor", state: "exit-unconfirmed" });
      }
      manualWorkers.delete(group);
    }
    if (failures.length) throw new AggregateError(failures, "Activity workers or supervisor cleanup failed");
  })() };
  manualWorkers.add(group); return group;
}
const childRowSchema = z.strictObject({ childId: z.uuid(), nativeCallId: z.string(), ordinal: z.number().int(), phase: z.string(),
  workflowRunId: z.string().nullable(), generation: z.uuid().nullable(), approvalId: z.uuid().nullable(), outcome: childOutcomeSchema.nullable() });
async function childRows(requestId: string) {
  return z.array(childRowSchema).parse((await pool.query(`SELECT child_id AS "childId",native_call_id AS "nativeCallId",ordinal,phase,
    workflow_run_id AS "workflowRunId",generation,approval_id AS "approvalId",outcome FROM birbcrew_ts.pi_children WHERE request_id=$1 ORDER BY ordinal`, [requestId])).rows);
}
type ParentRequest = Pick<SettledParentResult, "conversationId" | "requestId">;
const cohortSchema = z.array(z.strictObject({ commandId: z.uuid(), childId: z.uuid(), retire: z.boolean() }));
async function cohortRows(commandId: string) {
  return cohortSchema.parse((await pool.query(`SELECT command_id AS "commandId",child_id AS "childId",retire
    FROM birbcrew_ts.delegation_control_children WHERE command_id=$1 ORDER BY child_id`, [commandId])).rows);
}
const parentRowSchema = settledParentResultSchema.extend({ phase: z.string() });
async function parentRow(requestId: string) {
  return parentRowSchema.parse((await pool.query(`SELECT c.member_id AS "memberId",
    t.conversation_id AS "conversationId",t.request_id AS "requestId",t.workflow_run_id AS "workflowRunId",
    d.resume_activity_id AS "resumeActivityId",t.reply,t.phase FROM birbcrew_ts.turns t
    JOIN birbcrew_ts.conversations c USING(conversation_id) JOIN birbcrew_ts.delegations d USING(conversation_id,request_id)
    WHERE t.request_id=$1`, [requestId])).rows[0]);
}
async function parentObserved(key: ParentRequest) {
  return z.strictObject({ observed: z.boolean() }).parse((await pool.query(
    "SELECT birbcrew_ts.delegation_parent_result_observed($1,$2) AS observed", [key.conversationId, key.requestId])).rows[0]);
}
const positiveSchema = parentResultKeySchema.omit({ memberId: true }).extend({
  workflowRunId: parentResultKeySchema.shape.workflowRunId.unwrap(),
  resumeActivityId: parentResultKeySchema.shape.resumeActivityId.unwrap(),
  reply: parentResultKeySchema.shape.reply.unwrap(),
  installationId: z.uuid(), instanceId: z.uuid(), observedAt: z.iso.datetime(),
});
/** Positive parent-result observations recorded under the current recovery instance. */
async function positiveRows(key: ParentRequest) {
  return z.array(positiveSchema).parse((await pool.query(`SELECT o.installation_id AS "installationId",
    o.instance_id AS "instanceId",o.conversation_id AS "conversationId",o.request_id AS "requestId",
    o.workflow_run_id AS "workflowRunId",o.resume_activity_id AS "resumeActivityId",o.reply,
    to_char(o.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt"
    FROM birbcrew_ts.delegation_parent_observations o JOIN birbcrew_ts.recovery_control r
      ON r.singleton AND (r.installation_id,r.instance_id)=(o.installation_id,o.instance_id)
    WHERE o.conversation_id=$1 AND o.request_id=$2`, [key.conversationId, key.requestId])).rows);
}
async function stoppedLaunches(requestId: string, label: string) {
  return until(async () => {
    const rows = z.array(z.looseObject({ token: z.uuid(), stopped: z.boolean() })).parse((await pool.query(
      "SELECT * FROM birbcrew_ts.native_launches WHERE request_id=$1 ORDER BY child_id NULLS FIRST,token", [requestId])).rows);
    return rows.length > 0 && rows.every(row => row.stopped) ? rows : undefined;
  }, label);
}
async function untilAbsent(pids: number[], label: string, timeout?: number) {
  return until(async () => {
    const rows = pids.map(pid => ({ pid, absent: absent(pid) }));
    return rows.every(row => row.absent) ? rows : undefined;
  }, label, timeout);
}
async function heartbeatStamp(path: string) {
  try { return (await stat(path)).mtimeMs; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
async function childPids(pid: number) {
  return z.array(z.coerce.number().int().positive()).parse((await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
    .trim().split(/\s+/).filter(Boolean));
}
async function delegation(tasks: Task[], profile = parentProfile) {
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID(), requestId = randomUUID();
  const conversation = { ownerId, memberId, conversationId };
  await members.open(conversation);
  const request = { ownerId, conversationId, requestId, text: "delegate " + JSON.stringify(tasks) };
  const workflowId = `birbcrew-ts/member/${memberId}/conversation/${conversationId}`;
  workflowIds.add(workflowId);
  await members.accept(request);
  const rows = await until(async () => { const rows = await childRows(requestId); return rows.length === tasks.length ? rows : undefined; }, "durable delegation");
  for (const row of rows) workflowIds.add(`birbcrew-ts/child/${row.childId}`);
  return { conversation, request, workflowId, tasks, rows,
    key: (row: z.infer<typeof childRowSchema>): ChildKey => ({ ownerId, memberId, conversationId, requestId, childId: row.childId }),
  };
}
type Delegation = Awaited<ReturnType<typeof delegation>>;
async function change(enabled: boolean, scope: ControlCommand["scope"] = { kind: "global" }) {
  return changeControl(pool, { commandId: randomUUID(), expectedRevision: (await controlState(pool)).revision, scope, enabled,
    actor: "actual-pi-temporal-fixture", reason: "synthetic delegation control proof" });
}
async function enable() {
  await change(true);
  for (const target of (await controlState(pool)).disabledTargets) await change(true, target);
}
async function committed(value: Delegation) {
  return until(async () => {
    const { rows: [turn] } = await pool.query<{ reply: string | null; phase: string }>("SELECT reply,phase FROM birbcrew_ts.turns WHERE request_id=$1", [value.request.requestId]);
    return turn?.phase === "committed" && turn.reply !== null ? turn.reply : undefined;
  }, "committed parent follow-up");
}
async function flushUntilComplete(command: ControlReceipt) {
  return until(async () => { await control.flush(); const report = await drainDelegation(temporalControl, command.commandId); return report.complete ? report : undefined; }, "combined exact child and parent drain", 120_000);
}
async function countSnapshot() {
  const loads = await runnerLoads(runnerLog);
  return { providerRequests: wire.length, runnerProfileLoads: loads.filter(row => row.loadedBy === "supervisor-runner.ts").length };
}
async function recordCase(label: string, value: Delegation, command: ControlReceipt) {
  const launches = (await pool.query(`SELECT child_id,token,workflow_run_id,activity_id,attempt,stopped
    FROM birbcrew_ts.native_launches WHERE request_id=$1 ORDER BY child_id NULLS FIRST,token`, [value.request.requestId])).rows;
  const prompts = new Set([value.request.text, ...value.tasks.map(task => task.task)].map(digest));
  const requests = wire.filter(row => prompts.has(row.promptDigest));
  const loads = (await runnerLoads(runnerLog)).filter(row => row.loadedBy === "supervisor-runner.ts");
  await evidence(label, { requestId: value.request.requestId, childRows: await childRows(value.request.requestId),
    nativeLaunchReservations: launches, providerRequests: requests, suiteCumulativeRunnerProfileLoads: loads,
    admissionEvidenceScope: "provider request proves final admission; reservation alone does not",
    report: await drainDelegation(temporalControl, command.commandId) });
}
async function replay(value: Delegation) {
  const before = await countSnapshot();
  const reply = await committed(value);
  assert.equal(await members.submit(value.request), reply, "Retry reads the committed reply after the caller discarded its first acknowledgement");
  for (const id of [value.workflowId, ...value.rows.map(row => `birbcrew-ts/child/${row.childId}`)]) {
    await Worker.runReplayHistory({ workflowsPath: currentWorkflow }, await temporal.workflow.getHandle(id).fetchHistory(), id);
  }
  assert.deepEqual(await countSnapshot(), before, "Committed reply retry and offline history replay launch no runner and make no provider request");
}

test("ready retirement reaches actual child closure without a target runner or provider invocation", { timeout: 240_000 }, async () => {
  await enable();
  const workflow = await workflowWorker(), parents = await activityWorkers([parentProfile]);
  let targets: RunningWorker | undefined;
  try {
    const task = "remember " + randomUUID();
    const value = await delegation([{ role: "analyst", task }]);
    assert.equal(value.rows[0].phase, "ready");
    const baseline = await countSnapshot();
    const command = await change(false);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [value.rows[0].childId])).rowCount, 0);
    targets = await activityWorkers([analystProfile]);
    const report = await flushUntilComplete(command);
    assert.equal(report.children[0].workflow.kind, "closed");
    assert.equal(wire.filter(row => row.promptDigest === digest(task)).length, 0);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [value.rows[0].childId])).rowCount, 0);
    assert.equal((await countSnapshot()).runnerProfileLoads - baseline.runnerProfileLoads, 1, "Only the parent's admitted follow-up launches after the baseline");
    assert.equal(z.array(childOutcomeSchema).parse(JSON.parse((await committed(value)).slice(10)))[0].kind, "failed");
    await recordCase("ready-no-child-launch", value, command); await replay(value);
  } finally { await targets?.stop(); await parents.stop(); await workflow.stop(); }
});

test("disabling a running Pi child closes its actual provider socket and known runner before drain completes", { timeout: 240_000 }, async () => {
  await enable(); const workflow = await workflowWorker(), activities = await activityWorkers();
  try {
    const task = "hold " + randomUUID();
    const baselineLoads = new Set((await runnerLoads(runnerLog)).map(row => row.pid));
    const value = await delegation([{ role: "analyst", task }]);
    const request = await until(async () => wire.find(row => row.promptDigest === digest(task)), "actual running child provider request");
    const running = (await runnerLoads(runnerLog)).filter(row => row.loadedBy === "supervisor-runner.ts" && !baselineLoads.has(row.pid) && !absent(row.pid));
    assert.ok(running.length > 0, "At least the admitted child runner is live while its response is held");
    const command = await change(false);
    await flushUntilComplete(command); await committed(value);
    assert.equal(request.responseClosed, true); assert.equal(request.responseFinished, false, "Provider did not finish the held response");
    for (const row of running) assert.equal(absent(row.pid), true, "The observed fixture runner PID exited");
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE request_id=$1 AND NOT stopped", [value.request.requestId])).rowCount, 0);
    assert.equal(wire.filter(row => row.promptDigest === digest(task)).length, 1);
    await recordCase("running-real-stop", value, command);
  } finally { await activities.stop(); await workflow.stop(); }
});

test("unanswered recorder cards close without owner answers and ordered failures wait separately for parent follow-up and confirmed native stop", { timeout: 300_000 }, async () => {
  await enable(); const workflow = await workflowWorker(), activities = await activityWorkers();
  const blocker = await pool.connect();
  const barrierId = randomUUID().replaceAll("-", "");
  const barrier = { name: "control_stop_" + barrierId, key: BigInt("0x" + barrierId.slice(0, 15)).toString() };
  try {
    const tasks = [0, 1].map(() => ({ role: "recorder" as const, task: "record " + randomUUID() }));
    const parentPrompt = "delegate " + JSON.stringify(tasks); holds.add("parent/" + digest(parentPrompt));
    const value = await delegation(tasks);
    const cards = await until(async () => {
      const cards = await ledger.pending(value.conversation); return cards.length === 2 ? cards : undefined;
    }, "both unanswered child cards");
    assert.ok(cards.every(card => card.expiresAt === undefined), "The child cards have no owner deadline");
    const command = await change(false);
    await until(async () => { await control.flush(); return held.get("parent/" + digest(parentPrompt)); }, "parent follow-up provider barrier");
    const rows = await childRows(value.request.requestId);
    assert.deepEqual(rows.map(row => row.phase), ["failed", "failed"]);
    assert.equal((await ledger.pending(value.conversation)).length, 0);
    const calls = (await pool.query("SELECT approval_id,decision FROM birbcrew_ts.deferred_calls WHERE request_id=$1 ORDER BY approval_id", [value.request.requestId])).rows;
    assert.equal(calls.length, 2); assert.ok(calls.every(row => row.decision === null), "Control creates no human choice");
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.work_items WHERE request_id=$1", [value.request.requestId])).rowCount, 0);
    for (const task of tasks) assert.equal(wire.filter(row => row.promptDigest === digest(task.task)).length, 1, "No retired recorder continuation reached the provider");
    const parentPending = await drainDelegation(temporalControl, command.commandId);
    assert.equal(parentPending.complete, false); assert.ok(parentPending.blockers.some(blocker => blocker.kind === "parent_pending"));
    await evidence("parent-follow-up-pending", parentPending);
    const parentLaunch = await pool.query(`SELECT token FROM birbcrew_ts.native_launches WHERE request_id=$1
      AND child_id IS NULL AND NOT stopped`, [value.request.requestId]);
    assert.equal(parentLaunch.rowCount, 1, "The held provider request owns the parent follow-up launch");
    const parentToken = z.uuid().parse(parentLaunch.rows[0].token);
    const blockerPid = z.int().positive().parse((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await blocker.query("SELECT pg_advisory_lock($1::bigint)", [barrier.key]);
    await pool.query(`CREATE FUNCTION birbcrew_ts.${barrier.name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.token = TG_ARGV[0]::uuid THEN
          PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint);
        END IF;
        RETURN NEW;
      END;
    $$`);
    await pool.query(`CREATE TRIGGER ${barrier.name} BEFORE UPDATE OF stopped ON birbcrew_ts.native_launches
      FOR EACH ROW WHEN (NEW.stopped AND NOT OLD.stopped)
      EXECUTE FUNCTION birbcrew_ts.${barrier.name}('${parentToken}', '${barrier.key}')`);
    const beforeRelease = await runnerLoads(runnerLog);
    assert.ok(beforeRelease.some(row => row.loadedBy === "supervisor-runner.ts" && !absent(row.pid)),
      "The held parent response has a live observed runner before release");
    const parentBarrier = held.get("parent/" + digest(parentPrompt)); assert.ok(parentBarrier);
    parentBarrier.release(); holds.delete("parent/" + digest(parentPrompt));
    const wait = await until(async () => {
      const { rows: [row] } = await pool.query(`SELECT pid,wait_event_type,wait_event,state,query,pg_blocking_pids(pid) AS blocking_pids
        FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'
        AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE birbcrew_ts.native_launches SET stopped=true%'`, [blockerPid]);
      return row;
    }, "real native stop UPDATE withheld by the owned advisory lock");
    await evidence("native-stop-update-blocked", { sql: wait, blockerPid, barrier, token: parentToken });
    const reply = await committed(value);
    const outcomes = z.array(childOutcomeSchema).parse(JSON.parse(reply.slice(10)));
    assert.deepEqual(outcomes.map(outcome => [outcome.nativeCallId, outcome.kind]), rows.map(row => [row.nativeCallId, "failed"]));
    const remaining = await untilAbsent(beforeRelease.filter(row => row.loadedBy === "supervisor-runner.ts").map(row => row.pid),
      "known runner PIDs absent before withheld stopped update");
    const nativePending = await drainDelegation(temporalControl, command.commandId);
    assert.equal(nativePending.complete, false);
    assert.ok(nativePending.blockers.some(blocker => blocker.kind === "native_unconfirmed" && blocker.tokens.includes(parentToken)));
    assert.ok(!nativePending.blockers.some(blocker => blocker.kind === "parent_pending"));
    await evidence("native-stopped-row-withheld", { sql: wait, blockerPid, barrier, knownRunnerPids: remaining, token: parentToken, report: nativePending });
    assert.equal((await blocker.query("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [barrier.key])).rows[0].unlocked, true);
    await flushUntilComplete(command); await recordCase("unanswered-recorders", value, command); await replay(value);
  } catch (error) {
    try {
      const sql = (await pool.query(`SELECT pid,application_name,wait_event_type,wait_event,state,query,
        pg_blocking_pids(pid) AS blocking_pids FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid LIMIT 30`)).rows;
      await evidence("native-stop-barrier-failure", { barrier, sql, error: error instanceof Error ? error.message : String(error) });
    } catch (diagnosticError) { throw new AggregateError([error, diagnosticError], "Native stop barrier and diagnostics failed"); }
    throw error;
  } finally {
    blocker.release(true);
    try {
      try { await pool.query(`DROP TRIGGER IF EXISTS ${barrier.name} ON birbcrew_ts.native_launches`); }
      finally { await pool.query(`DROP FUNCTION IF EXISTS birbcrew_ts.${barrier.name}()`); }
    } finally {
      try { await activities.stop(); } finally { await workflow.stop(); }
    }
  }
});

test("an approved resumed recorder keeps its committed receipt while control retires its native continuation", { timeout: 240_000 }, async () => {
  await enable(); const workflow = await workflowWorker(), activities = await activityWorkers();
  try {
    const task = "record " + randomUUID(); holds.add("resume/" + digest(task));
    const value = await delegation([{ role: "recorder", task }]);
    const card = await until(async () => (await ledger.pending(value.conversation))[0], "recorder approval");
    const { approvalId, invocationId, nativeCallId, argumentDigest, version } = card;
    assert.equal(await members.decide({ ...value.conversation, requestId: value.request.requestId,
      approvalId, invocationId, nativeCallId, argumentDigest, version, choice: "approve" }), "approve");
    await until(async () => held.get("resume/" + digest(task)), "actual resumed recorder provider request");
    const receipts = (await pool.query("SELECT receipt_id,approval_id FROM birbcrew_ts.work_items WHERE request_id=$1", [value.request.requestId])).rows;
    assert.equal(receipts.length, 1); assert.equal(receipts[0].approval_id, card.approvalId);
    assert.equal((await childRows(value.request.requestId))[0].phase, "resuming");
    const command = await change(false); await flushUntilComplete(command);
    assert.deepEqual((await pool.query("SELECT receipt_id,approval_id FROM birbcrew_ts.work_items WHERE request_id=$1", [value.request.requestId])).rows, receipts);
    assert.equal((await pool.query("SELECT decision FROM birbcrew_ts.deferred_calls WHERE approval_id=$1", [card.approvalId])).rows[0].decision, "approve");
    assert.equal(wire.filter(row => row.promptDigest === digest(task)).length, 2, "The real proposal and admitted continuation were captured");
    holds.delete("resume/" + digest(task)); await recordCase("resumed-receipt-preserved", value, command); await replay(value);
  } finally { await activities.stop(); await workflow.stop(); }
});

test("target disable names the unaffected waiting recorder and global disable later retires it", { timeout: 240_000 }, async () => {
  await enable(); const workflow = await workflowWorker(), activities = await activityWorkers();
  try {
    const analystTask = "hold " + randomUUID(), recorderTask = "record " + randomUUID();
    const value = await delegation([{ role: "analyst", task: analystTask }, { role: "recorder", task: recorderTask }]);
    const card = await until(async () => (await ledger.pending(value.conversation))[0], "unselected recorder card");
    await until(async () => wire.find(row => row.promptDigest === digest(analystTask)), "selected analyst request");
    const command = await change(false, { kind: "target", engine: "pi", profile: analystProfile });
    const report = await until(async () => {
      await control.flush(); const report = await drainDelegation(temporalControl, command.commandId);
      return report.children.every(child => child.terminal && child.workflow.kind === "closed") ? report : undefined;
    }, "selected target retirement");
    assert.equal(report.complete, false);
    const sibling = report.blockers.find(blocker => blocker.kind === "sibling_pending");
    assert.ok(sibling?.kind === "sibling_pending");
    assert.deepEqual([sibling.sibling.childId, sibling.sibling.phase, sibling.sibling.approvalId, sibling.sibling.target],
      [value.rows[1].childId, "waiting", card.approvalId, { kind: "target", engine: "pi", profile: recorderProfile }]);
    assert.equal((await ledger.pending(value.conversation))[0].approvalId, card.approvalId);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.delegation_control_children WHERE command_id=$1 AND child_id=$2", [command.commandId, value.rows[1].childId])).rowCount, 0);
    await evidence("unselected-sibling-blocker", report);
    const global = await change(false); await flushUntilComplete(global);
    assert.equal((await ledger.pending(value.conversation)).length, 0);
    assert.equal(wire.filter(row => row.promptDigest === digest(recorderTask)).length, 1);
    await enable(); const baseline = await countSnapshot(); await control.flush();
    assert.deepEqual(await countSnapshot(), baseline, "Re-enable does not revive either immutable retirement");
    await recordCase("mixed-target-global-retirement", value, global); await replay(value);
  } finally { await activities.stop(); await workflow.stop(); }
});

test("a real restarted worker reconciles a pre-target waiting history after missed wake and re-enable", { timeout: 300_000 }, async () => {
  await enable(); let workflow: RunningWorker | undefined = await workflowWorker(oldWorkflow);
  let activities: RunningWorker | undefined = await activityWorkers([legacyProfile]);
  let restarted: ReturnType<typeof owned> | undefined;
  try {
    const task = "record " + randomUUID();
    const value = await delegation([{ role: "recorder", task }], legacyProfile);
    const card = await until(async () => (await ledger.pending(value.conversation))[0], "legacy waiting card");
    assert.equal(card.expiresAt, undefined);
    const childId = value.rows[0].childId;
    await until(async () => (await childRows(value.request.requestId))[0].phase === "waiting" || undefined, "legacy child waiting");
    const history = await temporal.workflow.getHandle(`birbcrew-ts/child/${childId}`).fetchHistory();
    await Worker.runReplayHistory({ workflowsPath: oldWorkflow }, history);
    await activities.stop(); activities = undefined; await workflow.stop(); workflow = undefined;
    const command = await change(false);
    await change(true);
    assert.equal((await childRows(value.request.requestId))[0].phase, "waiting", "Durable control change does not fabricate a settled result");
    const baseline = await countSnapshot();
    const heartbeat = join(directory, "restarted-worker-heartbeat");
    restarted = owned("restarted-worker", process.execPath, ["src/service/cli.ts", "worker", config], {
      ...process.env, BIRBCREW_STATE_DIR: stateDir, BIRBCREW_WORKER_HEARTBEAT_FILE: heartbeat,
    }, "process");
    await until(async () => { try { await readFile(heartbeat); return true; } catch { return undefined; } }, "actual restarted worker heartbeat");
    await committed(value);
    const report = await until(async () => {
      const report = await drainDelegation(temporalControl, command.commandId);
      return report.children[0]?.workflow.kind === "closed" && report.parents.every(parent => parent.workflow.kind === "observed" && parent.unstoppedLaunches.length === 0) ? report : undefined;
    }, "worker-owned durable retirement without fixture flush", 120_000);
    assert.equal(report.valid, false); assert.ok(report.blockers.some(blocker => blocker.kind === "control_changed"));
    assert.equal(report.children[0].terminal, true); assert.equal(report.children[0].cardClosed, true);
    assert.equal((await ledger.pending(value.conversation)).length, 0);
    assert.equal((await pool.query("SELECT decision FROM birbcrew_ts.deferred_calls WHERE approval_id=$1", [card.approvalId])).rows[0].decision, null);
    assert.equal(wire.filter(row => row.promptDigest === digest(task)).length, 1, "Restart and re-enable do not invoke the retired recorder again");
    assert.equal((await countSnapshot()).runnerProfileLoads - baseline.runnerProfileLoads, 1, "The resumed parent is the only post-restart runner");
    await recordCase("legacy-restart-missed-wake", value, command); await replay(value);
    await restarted.stop(); restarted = undefined;
  } finally { await restarted?.stop(); await activities?.stop(); await workflow?.stop(); }
});

test("disable retains a SQL-settled delegation until its actual parent workflow observes the completed follow-up", { timeout: 300_000 }, async () => {
  await enable(); let workflow: RunningWorker | undefined = await workflowWorker();
  const activities = await activityWorkers();
  const tasks = [{ role: "analyst" as const, task: "remember " + randomUUID() }];
  const parentPrompt = "delegate " + JSON.stringify(tasks), holdKey = "parent/" + digest(parentPrompt);
  const observer = new TemporalDelegationWorkflows(temporal);
  holds.add(holdKey);
  try {
    const baselinePids = new Set((await runnerLoads(runnerLog)).map(row => row.pid));
    const value = await delegation(tasks);
    const barrier = await until(async () => held.get(holdKey), "actual parent follow-up provider hold");
    const requests = wire.filter(row => [digest(parentPrompt), digest(tasks[0].task)].includes(row.promptDigest));
    assert.equal(requests.filter(row => row.model === "control-parent" && row.continuation).length, 1);
    assert.equal(requests.filter(row => row.model === "control-analyst").length, 1);
    const admission = z.strictObject({ approvalDeadlineSeconds: z.number().nullable() }).parse((await pool.query(
      'SELECT approval_deadline_seconds AS "approvalDeadlineSeconds" FROM birbcrew_ts.request_admissions WHERE request_id=$1',
      [value.request.requestId])).rows[0]);
    assert.equal(admission.approvalDeadlineSeconds, null, "The actual request admission has no owner deadline");
    assert.equal((await ledger.pending(value.conversation)).length, 0, "The analyst delegation needs no owner answer or deadline");
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.deferred_calls WHERE request_id=$1", [value.request.requestId])).rowCount, 0);
    const runners = (await runnerLoads(runnerLog)).filter(row => row.loadedBy === "supervisor-runner.ts" && !baselinePids.has(row.pid));
    assert.ok(runners.some(row => !absent(row.pid)), "The provider hold owns a live actual parent runner");
    await workflow.stop(); workflow = undefined;
    barrier.release(); holds.delete(holdKey);
    await before(barrier.closed, now() + 10_000, "released actual parent provider response closes");
    await committed(value);
    const launches = await stoppedLaunches(value.request.requestId,
      "all actual request native launches confirm stopped while the workflow worker is offline");
    const knownRunners = await untilAbsent(runners.map(row => row.pid), "all observed request runners exit while the workflow worker is offline");
    const parent = await parentRow(value.request.requestId);
    const { phase, ...key } = parent;
    assert.equal(phase, "committed"); assert.ok(key.workflowRunId); assert.ok(key.resumeActivityId); assert.ok(key.reply);
    const history = await until(async () => {
      const history = await temporal.workflow.getHandle(value.workflowId, key.workflowRunId ?? undefined).fetchHistory();
      const events = history.events ?? [];
      const scheduled = events.find(event => event.activityTaskScheduledEventAttributes?.activityId === key.resumeActivityId
        && event.activityTaskScheduledEventAttributes.activityType?.name === "executeTurn");
      if (!scheduled?.eventId) return undefined;
      const completedIndex = events.findIndex(event => event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() === scheduled.eventId?.toString());
      return completedIndex < 0 ? undefined : { raw: history, scheduledEventId: scheduled.eventId.toString(),
        completedEventId: events[completedIndex].eventId?.toString(),
        postCompletionWorkflowTasks: events.slice(completedIndex + 1).filter(event => event.workflowTaskCompletedEventAttributes) };
    }, "actual Temporal executeTurn completion without a workflow worker to process it");
    const children = await childRows(value.request.requestId);
    const observation = await observer.observeParentResult(key);
    const applicable = await parentObserved(key);
    assert.ok(requests.every(request => request.responseFinished && request.responseClosed), "Every actual provider response finished and closed");
    await evidence("sql-settled-parent-unobserved-history", history.raw);
    await evidence("sql-settled-parent-unobserved-before-disable", { parent, children, launches, knownRunners, admission,
      providerRequests: requests, scheduledEventId: history.scheduledEventId, completedEventId: history.completedEventId,
      postCompletionWorkflowTasks: history.postCompletionWorkflowTasks, observation, applicable,
      workflowWorker: "stopped", activityWorkers: "running" });
    assert.ok(children.every(child => child.phase === "complete" && child.outcome?.kind === "completed"));
    assert.equal(history.postCompletionWorkflowTasks.length, 0, "No workflow task completed after the actual follow-up activity completion");
    assert.deepEqual(observation, { kind: "pending" }, "Actual Temporal history still lacks parent workflow observation");
    assert.equal(applicable.observed, false, "The pending actual history has no applicable positive SQL evidence");
    const command = await change(false);
    const cohort = await cohortRows(command.commandId);
    const report = await drainDelegation(temporalControl, command.commandId);
    await evidence("sql-settled-parent-unobserved-disable", { requestId: value.request.requestId, childId: value.rows[0].childId,
      command, cohort, report, observation, workflowWorker: "stopped", activityWorkers: "running" });
    assert.equal(report.complete, false, "Disable must wait for the actual parent workflow to observe its already committed follow-up");
    assert.deepEqual(cohort.find(row => row.childId === value.rows[0].childId), {
      commandId: command.commandId, childId: value.rows[0].childId, retire: false,
    }, "The terminal child remains selected without retiring its completed work");
    assert.ok(report.children.some(child => child.childId === value.rows[0].childId), "The disable cohort retains this terminal child");
    assert.ok(report.parents.some(parent => parent.requestId === value.request.requestId && parent.workflow.kind === "pending"));
    assert.ok(report.blockers.some(blocker => blocker.kind === "parent_workflow" && blocker.requestId === value.request.requestId
      && blocker.observation.kind === "pending"), "The report names this unobserved parent workflow as a blocker");

    workflow = await workflowWorker();
    const recovered = await until(async () => {
      const result = await observer.observeParentResult(key); return result.kind === "observed" ? result : undefined;
    }, "restarted workflow worker observes the completed actual parent activity");
    const recoveredReport = await flushUntilComplete(command);
    await evidence("sql-settled-parent-unobserved-recovered", { parentKey: key, observation: recovered, report: recoveredReport });
    assert.equal(recovered.kind, "observed");
    assert.equal(recoveredReport.complete, true, "Drain completes after the parent workflow actually observes its result");
    const noLaunchBaseline = await countSnapshot();
    const positive = await until(async () => {
      await control.flush();
      if (!(await parentObserved(key)).observed) return undefined;
      const rows = await positiveRows(key);
      assert.equal(rows.length, 1, "The actual controller persisted one current-instance parent observation");
      return rows[0];
    }, "actual controller flush persists applicable exact parent-result evidence", 120_000);
    const fresh = { pool, workflows: new TemporalDelegationWorkflows(temporal) };
    const current = await controlState(pool);
    const { observedAt, ...identity } = positive;
    assert.deepEqual(identity, { installationId: current.installationId, instanceId: current.instanceId,
      conversationId: key.conversationId, requestId: key.requestId, workflowRunId: key.workflowRunId,
      resumeActivityId: key.resumeActivityId, reply: key.reply });
    assert.equal(current.installationId, command.installationId);
    assert.equal(current.instanceId, command.instanceId);
    const persistedReport = await drainDelegation(fresh, command.commandId);
    assert.equal(persistedReport.complete, true, "A new manager drains the original command with durable evidence");
    const cohortAfterPositive = await cohortRows(command.commandId);
    assert.deepEqual(cohortAfterPositive, cohort, "Recording the positive preserves original cohort membership and retirement");
    const { reply: observedReply, ...positiveIdentity } = positive;
    const { reply: parentReply, ...parentIdentity } = key;
    assert.equal(observedReply, parentReply);
    const positiveProof = { ...positiveIdentity, replyDigest: digest(observedReply) };
    await evidence("sql-settled-parent-observed-positive", { observation: recovered, positive: positiveProof, applicable: true,
      source: "actual-Temporal-adapter-through-controller-flush", freshManagerState: current, originalCommand: command,
      originalCohort: cohort, cohortAfterPositive, report: persistedReport });
    const enabled = await changeControl(pool, { commandId: randomUUID(), expectedRevision: current.revision,
      scope: { kind: "global" }, enabled: true, actor: "actual-pi-temporal-fixture", reason: "re-enable after actual parent observation" });
    const later = await changeControl(pool, { commandId: randomUUID(), expectedRevision: (await controlState(pool)).revision,
      scope: { kind: "global" }, enabled: false, actor: "actual-pi-temporal-fixture", reason: "exclude durably observed exact parent result" });
    const laterCohort = await cohortRows(later.commandId);
    const originalChildren = new Set(persistedReport.children.filter(child => child.requestId === key.requestId).map(child => child.childId));
    assert.equal(originalChildren.size, tasks.length, "The original cohort identifies every child from this exact request");
    assert.ok(laterCohort.every(row => !originalChildren.has(row.childId)), "The later disable excludes this durably observed request's children");
    const laterReport = await drainDelegation(fresh, later.commandId);
    assert.ok(laterReport.children.every(child => child.requestId !== key.requestId));
    assert.ok(laterReport.parents.every(parent => parent.requestId !== key.requestId));
    assert.ok(laterReport.siblings.every(sibling => sibling.requestId !== key.requestId));
    const cohortAfterLaterDisable = await cohortRows(command.commandId);
    assert.deepEqual(cohortAfterLaterDisable, cohort, "Re-enable and later disable preserve the original immutable cohort");
    const noLaunchAfter = await countSnapshot();
    assert.deepEqual(noLaunchAfter, noLaunchBaseline, "Positive persistence, manager restart and later control changes launch no additional SDK or provider work");
    await evidence("sql-settled-parent-observed-later-disable", { parentKey: parentIdentity, positive: positiveProof, observedAt, enabled, later,
      noLaunchBaseline, noLaunchAfter,
      originalCohort: cohort, cohortAfterLaterDisable, laterCohort, laterReport,
      exclusionScope: "this-exact-request-only-other-history-may-remain-selected" });
  } finally {
    held.get(holdKey)?.release(); holds.delete(holdKey);
    try { await activities.stop(); } finally { await workflow?.stop(); }
  }
});

test("an actual worker stops healthy heartbeats on blocked control discovery, recovers, and shuts down with discovery still blocked", { timeout: 240_000 }, async () => {
  assert.equal(manualWorkers.size, 0, "Earlier fixture workflow and activity workers have stopped before CLI startup");
  const scope = "worker-health-" + randomUUID();
  const heartbeat = join(directory, scope + "-heartbeat");
  const baselinePids = new Set((await runnerLoads(runnerLog)).map(row => row.pid));
  const worker = owned(scope, process.execPath, ["src/service/cli.ts", "worker", config], {
    ...process.env, PGAPPNAME: scope, BIRBCREW_STATE_DIR: stateDir, BIRBCREW_WORKER_HEARTBEAT_FILE: heartbeat,
  }, "process");
  const sessionSchema = z.looseObject({ pid: z.int().positive(), application_name: z.string(), state: z.string().nullable(),
    wait_event_type: z.string().nullable(), wait_event: z.string().nullable(), query: z.string(), blockingPids: z.array(z.int().positive()) });
  async function sessions() {
    return z.array(sessionSchema).parse((await pool.query(`SELECT pid,application_name,state,wait_event_type,wait_event,query,
      pg_blocking_pids(pid) AS "blockingPids" FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=$1 ORDER BY pid`, [scope])).rows);
  }
  const eventSchema = z.looseObject({ event: z.string() });
  async function failures() {
    const events: z.infer<typeof eventSchema>[] = [];
    for (const line of (await readFile(worker.logPath, "utf8")).split("\n")) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      const parsed = eventSchema.safeParse(value);
      if (parsed.success && parsed.data.event === "delegation_control_failed") events.push(parsed.data);
    }
    return events.length;
  }
  function alive() {
    assert.equal(worker.child.exitCode, null, "Owned health worker has not exited");
    assert.equal(worker.child.signalCode, null, "Owned health worker has not been signalled");
  }
  const blocker = await pool.connect();
  let locked = false;
  try {
    const queues = [{ name: memberTaskQueue, type: 1 }, { name: memberTaskQueue, type: 2 },
      ...[parentProfile, legacyProfile, analystProfile, recorderProfile].map(profile => ({ name: activityQueue("pi", profile), type: 2 }))];
    const pollers = await until(async () => {
      alive();
      const observations = await Promise.all(queues.map(async queue => ({ ...queue,
        observation: await connection.workflowService.describeTaskQueue({ namespace: "default", taskQueue: { name: queue.name }, taskQueueType: queue.type }),
      })));
      return observations.every(row => row.observation.pollers?.some(poller => poller.identity?.startsWith(worker.child.pid + "@")))
        ? observations : undefined;
    }, "the owned CLI worker's workflow and every configured activity queue poller");
    const initialHeartbeat = await until(async () => { alive(); return heartbeatStamp(heartbeat); }, "owned CLI healthy heartbeat after startup");
    const ownedLoads = (await runnerLoads(runnerLog)).filter(row => !baselinePids.has(row.pid));
    assert.ok(ownedLoads.some(row => row.pid === worker.child.pid && row.loadedBy === "cli.ts"));
    const workerPid = z.int().positive().parse(worker.child.pid);
    const directChildPids = await childPids(workerPid);
    const directChildren = await Promise.all(directChildPids.map(async pid => {
      const bytes = await readFile(`/proc/${pid}/cmdline`);
      assert.ok(bytes.length < 32 * 1024, "Bounded owned child command line");
      return { pid, arguments: bytes.toString("utf8").split("\0").filter(Boolean) };
    }));
    const supervisorPath = fileURLToPath(new URL("../../src/service/supervisor-host.ts", import.meta.url));
    const supervisors = directChildren.filter(child => child.arguments.includes(supervisorPath));
    assert.equal(supervisors.length, 1, "The CLI owns the observed actual native supervisor process");
    const knownPids = [...new Set([workerPid, ...supervisors.map(row => row.pid), ...ownedLoads.map(row => row.pid)])];
    const startupSessions = await sessions();
    assert.ok(startupSessions.length > 0, "The worker's unique application name identifies owned database sessions");
    await evidence("worker-health-startup", { scope, workerPid, initialHeartbeat, pollers, ownedLoads, supervisors, sessions: startupSessions });
    const blockerPid = z.int().positive().parse((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    async function blockDiscovery(label: string) {
      await blocker.query("BEGIN");
      locked = true;
      await blocker.query("SET LOCAL lock_timeout='5s'");
      await blocker.query("LOCK TABLE birbcrew_ts.pi_children IN ACCESS EXCLUSIVE MODE");
      const discovery = await until(async () => {
        alive();
        return (await sessions()).find(row => row.state === "active" && row.wait_event_type === "Lock"
          && row.blockingPids.includes(blockerPid) && /^SELECT\s+c\.owner_id/.test(row.query)
          && row.query.includes("FROM birbcrew_ts.pi_children j"));
      }, label + " actual controller discovery SELECT blocked by the owned backend", 20_000);
      await evidence("worker-health-" + label + "-blocked", { blockerPid, discovery, heartbeat: await heartbeatStamp(heartbeat), observedAt: new Date().toISOString() });
      return discovery;
    }
    const baselineFailures = await failures();
    const firstBlocked = await blockDiscovery("failure");
    const failedAt = now();
    const firstFailureCount = await until(async () => {
      alive(); const count = await failures(); return count > baselineFailures ? count : undefined;
    }, "failed-control log while discovery remains blocked", 20_000);
    const failedHeartbeat = await heartbeatStamp(heartbeat);
    assert.ok(failedHeartbeat !== undefined);
    const secondBlocked = await until(async () => {
      alive();
      assert.equal(await heartbeatStamp(heartbeat), failedHeartbeat, "A failed control pass must not publish healthy heartbeats");
      return (await sessions()).find(row => row.state === "active" && row.wait_event_type === "Lock"
        && row.blockingPids.includes(blockerPid) && /^SELECT\s+c\.owner_id/.test(row.query)
        && row.query.includes("FROM birbcrew_ts.pi_children j"));
    }, "another actual controller discovery pass blocked after failure", 20_000);
    const repeatedFailureCount = await until(async () => {
      alive();
      assert.equal(await heartbeatStamp(heartbeat), failedHeartbeat, "The healthy heartbeat remains frozen through the next failed pass");
      const count = await failures(); return count > firstFailureCount ? count : undefined;
    }, "a second failed-control log with unchanged heartbeat", 20_000);
    await evidence("worker-health-failed", { scope, blockerPid, firstBlocked, secondBlocked, baselineFailures,
      firstFailureCount, repeatedFailureCount, failedHeartbeat, observedBlockedIntervalMs: now() - failedAt,
      heartbeatAfterRepeatedFailure: await heartbeatStamp(heartbeat), sessions: await sessions() });
    await blocker.query("ROLLBACK"); locked = false;
    const recoveredHeartbeat = await until(async () => {
      alive(); const stamp = await heartbeatStamp(heartbeat); return stamp !== undefined && stamp > failedHeartbeat ? stamp : undefined;
    }, "fresh healthy heartbeat after the discovery lock is released", 20_000);
    await evidence("worker-health-recovered", { scope, failedHeartbeat, recoveredHeartbeat, failureCount: await failures(), sessions: await sessions() });
    const shutdownBlocked = await blockDiscovery("shutdown");
    const stopAt = now();
    await worker.stop();
    assert.equal(worker.child.exitCode, 0, "The real CLI worker completes graceful shutdown without a forced signal");
    assert.equal(worker.child.signalCode, null);
    const heldLock = z.looseObject({ held: z.boolean() }).parse((await blocker.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE pid=pg_backend_pid() AND relation='birbcrew_ts.pi_children'::regclass AND mode='AccessExclusiveLock' AND granted) AS held`)).rows[0]);
    assert.equal(heldLock.held, true, "The owned table lock remains held until after the worker has closed");
    const closedSessions = await until(async () => { const rows = await sessions(); return rows.length === 0 ? rows : undefined; },
      "all uniquely named worker database sessions close", 5000);
    const knownProcesses = await untilAbsent(knownPids, "the known CLI and supervisor PIDs exit", 5000);
    await evidence("worker-health-shutdown", { scope, workerPid: worker.child.pid, shutdownBlocked, blockerPid,
      blockerLockStillHeld: heldLock.held, observedShutdownMs: now() - stopAt, exitCode: worker.child.exitCode,
      signalCode: worker.child.signalCode, sessions: closedSessions, knownProcesses, ancestry: "unproven" });
  } catch (error) {
    await evidence("worker-health-failure", { scope, workerPid: worker.child.pid, heartbeat: await heartbeatStamp(heartbeat),
      failures: await failures(), sessions: await sessions(), error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    try { if (locked) await blocker.query("ROLLBACK"); }
    finally { blocker.release(); await worker.stop(); }
  }
});

test("disable drains an actual committed parent reply recovered by reconcileTurn after its executeTurn acknowledgement fails", { timeout: 240_000 }, async context => {
  await enable();
  const failureType = "ControlFixturePostCommitAcknowledgementLoss";
  const task = "hold " + randomUUID();
  const holdKey = "child/" + digest(task);
  let targetRequestId: string | undefined;
  let injected: { requestId: string; workflowRunId: string; activityId: string; reply: string } | undefined;
  const workflow = await workflowWorker();
  const activities = await activityWorkers(undefined, executeTurn => async (request, resume) => {
    const result = await executeTurn(request, resume);
    if (request.requestId === targetRequestId && resume && "children" in resume && result.kind === "complete") {
      assert.equal(injected, undefined, "Only this request's committed follow-up loses its acknowledgement once");
      const info = Context.current().info;
      assert.ok(info.workflowExecution);
      injected = { requestId: request.requestId, workflowRunId: info.workflowExecution.runId,
        activityId: info.activityId, reply: result.text };
      throw ApplicationFailure.nonRetryable("Actual Pi SQL commit completed before the fixture lost its activity acknowledgement", failureType);
    }
    return result;
  });
  try {
    const value = await delegation([{ role: "analyst", task }]);
    targetRequestId = value.request.requestId;
    const barrier = await until(async () => held.get(holdKey), "actual Pi child provider response held before parent commit");
    const submitted = members.submit(value.request);
    void submitted.catch(() => {});
    await until(async () => {
      const history = await temporal.workflow.getHandle(value.workflowId).fetchHistory();
      return history.events?.some(event => event.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.name === "submitTurn")
        ? true : undefined;
    }, "actual submitTurn update accepted before the parent commits");
    barrier.release();
    await before(barrier.closed, now() + 10_000, "actual child provider response closes");
    const delivered = await before(submitted, now() + 60_000, "actual submit resolves through production reconcileTurn");
    const reply = await committed(value);
    assert.equal(delivered, reply, "The waiting caller receives the actual committed reply after activity acknowledgement loss");
    assert.ok(injected, "The production executeTurn returned a complete actual Pi result before injection");
    const fault = injected;
    const parent = await parentRow(value.request.requestId);
    const { phase, ...key } = parent;
    assert.equal(phase, "committed");
    assert.deepEqual(fault, { requestId: key.requestId, workflowRunId: key.workflowRunId,
      activityId: key.resumeActivityId, reply: key.reply });
    assert.equal(key.reply, delivered);
    assert.ok(key.workflowRunId); assert.ok(key.resumeActivityId);
    type Payload = Parameters<typeof temporal.options.loadedDataConverter.payloadConverter.fromPayload>[0];
    async function decoded(payloads: Payload[] | null | undefined) {
      assert.ok(payloads);
      let result = payloads;
      const converter = temporal.options.loadedDataConverter;
      for (const codec of [...converter.payloadCodecs].reverse()) result = await codec.decode(result);
      return result.map(payload => converter.payloadConverter.fromPayload(payload));
    }
    const history = await until(async () => {
      const raw = await temporal.workflow.getHandle(value.workflowId, key.workflowRunId ?? undefined).fetchHistory();
      const events = raw.events ?? [];
      const execute = events.find(event => event.activityTaskScheduledEventAttributes?.activityId === key.resumeActivityId
        && event.activityTaskScheduledEventAttributes.activityType?.name === "executeTurn");
      if (!execute?.eventId) return undefined;
      const failedIndex = events.findIndex(event => event.activityTaskFailedEventAttributes?.scheduledEventId?.toString() === execute.eventId?.toString());
      if (failedIndex < 0) return undefined;
      const reconciles = events.slice(failedIndex + 1).filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === "reconcileTurn");
      for (const scheduled of reconciles) {
        const args = await decoded(scheduled.activityTaskScheduledEventAttributes?.input?.payloads);
        if (!isDeepStrictEqual(args, [value.request, key.workflowRunId, true])) continue;
        const completedIndex = events.findIndex(event => event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() === scheduled.eventId?.toString());
        if (completedIndex < 0) continue;
        const completed = events[completedIndex];
        const result = await decoded(completed.activityTaskCompletedEventAttributes?.result?.payloads);
        const postCompletionWorkflowTasks = events.slice(completedIndex + 1).filter(event => {
          const startedId = event.workflowTaskCompletedEventAttributes?.startedEventId?.toString();
          return startedId !== undefined && events.slice(completedIndex + 1).some(started =>
            started.workflowTaskStartedEventAttributes && started.eventId?.toString() === startedId);
        });
        if (!postCompletionWorkflowTasks.length) continue;
        return { raw, execute, failed: events[failedIndex], reconcile: scheduled, args, completed, result, postCompletionWorkflowTasks };
      }
      return undefined;
    }, "real failed executeTurn followed by exact production reconciliation and parent workflow processing");
    const failure = history.failed.activityTaskFailedEventAttributes?.failure;
    assert.ok(failure?.applicationFailureInfo, "Actual Temporal records the injected application failure");
    assert.equal(failure.applicationFailureInfo.type, failureType);
    assert.equal(failure.applicationFailureInfo.nonRetryable, true);
    assert.deepEqual(await decoded(history.execute.activityTaskScheduledEventAttributes?.input?.payloads), [value.request, { children: true }]);
    assert.deepEqual(history.args, [value.request, key.workflowRunId, true]);
    assert.deepEqual(history.result, [{ kind: "complete", text: delivered }]);
    assert.ok(history.postCompletionWorkflowTasks.length > 0, "The actual parent workflow processed reconciliation completion");
    assert.equal(history.raw.events?.some(event => event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()
      === history.execute.eventId?.toString()), false, "The recorded follow-up executeTurn has no successful activity completion");
    const launches = await stoppedLaunches(key.requestId, "all actual native launches stopped before recovered-parent control drain");
    const children = await childRows(key.requestId);
    assert.ok(children.every(child => child.phase === "complete" && child.outcome?.kind === "completed"));
    const observer = new TemporalDelegationWorkflows(temporal);
    const observation = await observer.observeParentResult(key);
    await evidence("reconciled-parent-raw-history", history.raw);
    await evidence("reconciled-parent-exact-recovery", { parent, fault, failureType, failure, delivered, launches, children,
      executeScheduledEventId: history.execute.eventId?.toString(), failedEventId: history.failed.eventId?.toString(),
      reconcileScheduledEventId: history.reconcile.eventId?.toString(), reconcileArgs: history.args,
      reconcileCompletedEventId: history.completed.eventId?.toString(), reconcileResult: history.result,
      postCompletionWorkflowTasks: history.postCompletionWorkflowTasks, observation, expectedObservation: { kind: "observed" } });
    const command = await change(false);
    const cohort = await cohortRows(command.commandId);
    assert.deepEqual(cohort.find(row => row.childId === value.rows[0].childId), {
      commandId: command.commandId, childId: value.rows[0].childId, retire: false,
    }, "Disable retains the already completed child without retiring it");
    const noLaunchBaseline = await countSnapshot();
    const flush = await control.flush();
    const report = await drainDelegation(temporalControl, command.commandId);
    await evidence("reconciled-parent-disable-drain", { key, command, cohort, flush, report, observation,
      expectedObservation: { kind: "observed" }, expectedDrainComplete: true });
    assert.deepEqual(observation, { kind: "observed" }, "The actual adapter must recognize the exact committed parent reply delivered through reconciliation");
    assert.equal(report.complete, true, "Disable must not strand a completed parent whose actual workflow delivered its reconciled reply");

    const liveIdentityChecks = [];
    for (const [name, wrongKey] of [
      ["wrong-request", { ...key, requestId: randomUUID() }],
      ["wrong-conversation", { ...key, conversationId: randomUUID() }],
      ["wrong-run", { ...key, workflowRunId: randomUUID() }],
      ["wrong-resume", { ...key, resumeActivityId: "unrelated-resume-" + randomUUID() }],
      ["wrong-reply", { ...key, reply: delivered + " unrelated" }],
    ] satisfies [string, typeof key][]) {
      const observation = await observer.observeParentResult(wrongKey);
      liveIdentityChecks.push({ name, observation });
      await evidence("reconciled-parent-live-identity-negatives", { source: "actual-Temporal-public-adapter-wrong-key-lookups", checks: liveIdentityChecks });
      assert.notEqual(observation.kind, "observed", name + " cannot observe the actual reply");
      if (name !== "wrong-conversation" && name !== "wrong-run") {
        assert.notEqual(observation.kind, "unavailable", name + " still has an available recorded workflow execution");
      }
    }

    await adapterHistoryCases({ context, connection, temporal, evidence, history, key, request: value.request, delivered,
      workflowId: value.workflowId });
    await until(async () => {
      await control.flush();
      return (await parentObserved(key)).observed ? true : undefined;
    }, "fair historical discovery persists this exact recovered parent observation");
    const positives = (await positiveRows(key)).map(({ observedAt, ...row }) => row);
    assert.deepEqual(positives, [{ installationId: command.installationId, instanceId: command.instanceId,
      conversationId: key.conversationId, requestId: key.requestId, workflowRunId: key.workflowRunId,
      resumeActivityId: key.resumeActivityId, reply: key.reply }], "Actual controller flush persists the exact reconciled parent result");
    const applicable = await parentObserved(key);
    assert.equal(applicable.observed, true);
    const fresh = { pool, workflows: new TemporalDelegationWorkflows(temporal) };
    const persistedReport = await drainDelegation(fresh, command.commandId);
    assert.equal(persistedReport.complete, true, "A fresh controller drains the original command using durable reconciled-result evidence");
    assert.deepEqual(await countSnapshot(), noLaunchBaseline, "Reconciled observation, flush and fresh drain launch no additional runner or provider work");
    await evidence("reconciled-parent-positive", { key, command, cohort, positives, applicable, persistedReport,
      noLaunchBaseline, noLaunchAfter: await countSnapshot(), source: "actual-Temporal-adapter-through-controller-flush" });

    const missingKey = { ...key, workflowRunId: randomUUID() };
    const missingNamespace = "control-missing-" + randomUUID();
    const namespaceClient = new Client({ connection, namespace: missingNamespace });
    const namespaceObserver = new TemporalDelegationWorkflows(namespaceClient);
    const authorityBeforeMissingRun = await controlState(pool);
    const missingParentCalls: { key: typeof key; observation: Awaited<ReturnType<typeof observer.observeParentResult>> }[] = [];
    const missingWorkflows: ChildWorkflowControl = {
      signalDecision: candidate => observer.signalDecision(candidate),
      observe: candidate => observer.observe(candidate),
      observeParentResult: async candidate => {
        const observation = await observer.observeParentResult(candidate);
        if (isDeepStrictEqual(candidate, missingKey)) missingParentCalls.push({ key: candidate, observation });
        return observation;
      },
    };
    const missingController = new DelegationReconciler({ pool, workflows: missingWorkflows });
    const replaced = await pool.query(`UPDATE birbcrew_ts.turns SET workflow_run_id=$3
      WHERE conversation_id=$1 AND request_id=$2 AND workflow_run_id=$4 RETURNING workflow_run_id`,
    [key.conversationId, key.requestId, missingKey.workflowRunId, key.workflowRunId]);
    try {
      assert.equal(replaced.rowCount, 1, "Only this test's completed parent gets a nonexistent stored run");
      const missingObservation = await observer.observeParentResult(missingKey);
      let missingHistoryRpc: { failed: boolean; code: number | null; workflowNotFound: boolean } = {
        failed: false, code: null, workflowNotFound: false,
      };
      try {
        await connection.withDeadline(Date.now() + 5000, () =>
          temporal.workflow.getHandle(value.workflowId, missingKey.workflowRunId).fetchHistory());
      }
      catch (error) {
        const status = z.object({ code: z.number().int() }).safeParse(error);
        missingHistoryRpc = { failed: true, code: status.success ? status.data.code : null,
          workflowNotFound: error instanceof WorkflowNotFoundError };
      }
      const namespaceObservation = await namespaceObserver.observeParentResult(key);
      const discovery = z.strictObject({ count: z.number().int().positive() }).parse((await pool.query(
        "SELECT count(*)::integer AS count FROM birbcrew_ts.delegations")).rows[0]);
      const passLimit = Math.ceil(discovery.count / reconciliationPage) + 1;
      const flushPasses: { failed: boolean; aggregateError: boolean; parentUnavailable: boolean;
        result: Awaited<ReturnType<typeof control.flush>> | null }[] = [];
      for (let pass = 0; pass < passLimit && missingParentCalls.length === 0; pass++) {
        try {
          const result = await before(missingController.flush(), now() + 30_000, "real missing-history controller flush");
          flushPasses.push({ failed: false, aggregateError: false, parentUnavailable: false, result });
        } catch (error) {
          flushPasses.push({ failed: true, aggregateError: error instanceof AggregateError, result: null,
            parentUnavailable: error instanceof AggregateError && error.errors.some((cause: unknown) =>
              cause instanceof AggregateError && cause.errors.some((failure: unknown) =>
                failure instanceof Error && failure.message === "Delegation parent observation unavailable")) });
        }
      }
      const flushParentCalls = [...missingParentCalls];
      const missingReport = await drainDelegation({ pool, workflows: missingWorkflows }, command.commandId);
      const missingApplicable = await parentObserved(key);
      const retainedPositives = (await positiveRows(key)).map(({ observedAt, ...row }) => row);
      const missingRunPositives = z.strictObject({ count: z.number().int().nonnegative() }).parse((await pool.query(
        `SELECT count(*)::integer AS count FROM birbcrew_ts.delegation_parent_observations
          WHERE conversation_id=$1 AND request_id=$2 AND workflow_run_id=$3`,
        [key.conversationId, key.requestId, missingKey.workflowRunId])).rows[0]);
      const authorityAfterMissingRun = await controlState(pool);
      const noLaunchAfterMissingRun = await countSnapshot();
      await evidence("missing-parent-history-background-flush", {
        source: "SQL-seeded-stored-parent-run-and-actual-Temporal-RPC", actualRetentionExpiryClaim: false,
        actualWorkerHeartbeatClaim: false, originalKey: key, missingKey, missingHistoryRpc, missingObservation,
        missingNamespace, namespaceObservation, discovery, passLimit, flushPasses, flushParentCalls, missingReport,
        missingApplicable, positives, retainedPositives, missingRunPositives, authorityBeforeMissingRun,
        authorityAfterMissingRun, noLaunchBaseline, noLaunchAfterMissingRun,
      });
      assert.ok(flushParentCalls.length > 0, "Actual background discovery calls the real adapter for the exact stored missing run");
      assert.equal(missingHistoryRpc.failed, true, "The nonexistent stored run is checked by an actual Temporal history RPC");
      assert.equal(missingHistoryRpc.code, 5, "Actual Temporal history lookup returns NOT_FOUND for the nonexistent run");
      assert.deepEqual(missingObservation, { kind: "missing" }, "A real nonexistent stored parent run is missing history, not an availability failure");
      assert.ok(flushParentCalls.every(call => call.observation.kind === "missing"));
      assert.ok(flushPasses.every(pass => !pass.failed), "Missing historical parent history must not fail background control reconciliation");
      assert.deepEqual(namespaceObservation, { kind: "unavailable" }, "A nonexistent Temporal namespace remains an availability failure");
      assert.equal(missingApplicable.observed, false, "The original positive cannot authorize a different stored run");
      assert.deepEqual(retainedPositives, positives, "Missing history preserves the original exact positive without replacing it");
      assert.equal(missingRunPositives.count, 0, "No positive observation is invented for the nonexistent stored run");
      assert.equal(missingReport.complete, false, "Missing history conservatively blocks the original command's drain");
      assert.deepEqual(missingReport.blockers.filter(blocker => blocker.kind === "parent_workflow" && blocker.requestId === key.requestId),
        [{ kind: "parent_workflow", requestId: key.requestId, observation: { kind: "missing" } }]);
      assert.deepEqual(authorityAfterMissingRun, authorityBeforeMissingRun, "Missing history preserves control authority");
      assert.deepEqual(noLaunchAfterMissingRun, noLaunchBaseline, "Missing-history observation, background flush and drain launch no runner or provider work");
    } finally {
      const restored = await pool.query(`UPDATE birbcrew_ts.turns SET workflow_run_id=$3
        WHERE conversation_id=$1 AND request_id=$2 AND workflow_run_id=$4 RETURNING workflow_run_id`,
      [key.conversationId, key.requestId, key.workflowRunId, missingKey.workflowRunId]);
      const restoredApplicable = await parentObserved(key);
      await evidence("missing-parent-history-restoration", { originalKey: key, missingKey,
        restoredRows: restored.rowCount, restoredApplicable });
      assert.equal(restored.rowCount, 1, "Restore this test's original stored parent run even when the regression fails");
      assert.equal(restoredApplicable.observed, true, "The retained original positive applies again after the original run is restored");
    }
  } finally {
    held.get(holdKey)?.release();
    try { await activities.stop(); } finally { await workflow.stop(); }
  }
});

test("an actual CLI worker keeps advancing healthy heartbeats while its sole stored parent history is missing", { timeout: 240_000 }, async () => {
  const cli = process.env.TEMPORAL_CLI;
  assert.ok(cli);
  const scope = "missing-history-worker-" + randomUUID();
  const heartbeat = join(directory, scope + "-heartbeat"), workerState = join(directory, scope + "-native");
  const namespace = "control-missing-history-" + randomUUID();
  const databaseName = testDatabaseName("ctl_missing_history_");
  const databaseUrl = new URL(database); databaseUrl.pathname = "/" + databaseName;
  await pool.query(`CREATE DATABASE "${databaseName}"`);
  const seedPool = new Pool({ connectionString: databaseUrl.toString(), application_name: scope + "-seed" });
  let dropped: Promise<void> | undefined;
  const dropDatabase = () => dropped ??= (async () => {
    await seedPool.end();
    await pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    const remaining = (await pool.query("SELECT datname FROM pg_database WHERE datname=$1", [databaseName])).rows;
    await evidence("missing-history-worker-database-cleanup", { databaseName, remaining });
    assert.deepEqual(remaining, [], "The isolated missing-history database is dropped");
  })();
  cleanupSteps.push(dropDatabase);
  let worker: ReturnType<typeof owned> | undefined;
  try {
    await boundedCommand(cli, ["operator", "namespace", "create", "--namespace", namespace, "--address", address], now() + 15_000);
    const seedStore = new MemberStore(seedPool); await seedStore.migrate();
    await registerProfiles(seedPool, profiles, workerState);
    const member = await spawnHistoricalMember(seedStore, { ownerId, requestId: randomUUID(), engine: "pi", profile: parentProfile });
    const key = { memberId: member.memberId, conversationId: randomUUID(), requestId: randomUUID(), workflowRunId: randomUUID(),
      resumeActivityId: "missing-history-resume", reply: "SQL-seeded committed parent reply" };
    await seedStore.transaction(async db => {
      await db.query("INSERT INTO birbcrew_ts.conversations(conversation_id,owner_id,member_id) VALUES($1,$2,$3)",
        [key.conversationId, ownerId, key.memberId]);
      await db.query(`INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,workflow_run_id,activity_id,attempt,phase,reply,checkpoint)
        VALUES($1,$2,1,$3,$4,'missing-history-turn',1,'committed',$5,'{}')`,
      [key.conversationId, key.requestId, createHash("sha256").update(scope).digest(), key.workflowRunId, key.reply]);
      await db.query("INSERT INTO birbcrew_ts.delegations(conversation_id,request_id,parent_checkpoint,resume_activity_id) VALUES($1,$2,'{}',$3)",
        [key.conversationId, key.requestId, key.resumeActivityId]);
    });
    const namespaceClient = new Client({ connection, namespace });
    await until(() => namespaceClient.workflow.getHandle("missing-history-namespace-probe").describe()
      .then(() => assert.fail("The fixture namespace starts empty"),
        (error: unknown) => error instanceof WorkflowNotFoundError ? true : undefined),
    "the registered fixture namespace serves workflow lookups", 30_000);
    const directObservation = await new TemporalDelegationWorkflows(namespaceClient).observeParentResult(key);
    assert.deepEqual(directObservation, { kind: "missing" }, "The real adapter classifies the seeded nonexistent run as missing history");
    worker = owned(scope, process.execPath, ["src/service/cli.ts", "worker", config], {
      ...process.env, BIRBCREW_DATABASE_URL: databaseUrl.toString(), BIRBCREW_TEMPORAL_NAMESPACE: namespace, PGAPPNAME: scope,
      BIRBCREW_STATE_DIR: workerState, BIRBCREW_WORKER_HEARTBEAT_FILE: heartbeat,
    }, "process");
    const running = worker;
    const alive = () => {
      assert.equal(running.child.exitCode, null, "Missing-history CLI worker has not exited");
      assert.equal(running.child.signalCode, null, "Missing-history CLI worker has not been signalled");
    };
    const pollers = await until(async () => {
      alive();
      const { pollers } = await connection.workflowService.describeTaskQueue({ namespace, taskQueue: { name: memberTaskQueue }, taskQueueType: 1 });
      return pollers?.some(poller => poller.identity?.startsWith(running.child.pid + "@")) ? pollers : undefined;
    }, "the missing-history CLI worker polls its fixture namespace");
    const firstHeartbeat = await until(async () => { alive(); return heartbeatStamp(heartbeat); }, "first healthy heartbeat with missing parent history");
    const workerPid = z.int().positive().parse(running.child.pid);
    const directChildren = await childPids(workerPid);
    assert.ok(directChildren.length > 0, "The CLI worker owns its native supervisor process");
    const advancedHeartbeat = await until(async () => {
      alive(); const next = await heartbeatStamp(heartbeat); return next !== undefined && next > firstHeartbeat ? next : undefined;
    }, "advancing healthy heartbeat with missing parent history", 30_000);
    const failures = (await readFile(running.logPath, "utf8")).split("\n").filter(line => line.includes('"delegation_control_failed"'));
    const sql = z.strictObject({ observed: z.boolean(), positives: z.number().int(), delegations: z.number().int() }).parse((await seedPool.query(
      `SELECT birbcrew_ts.delegation_parent_result_observed($1,$2) AS observed,
        (SELECT count(*)::integer FROM birbcrew_ts.delegation_parent_observations) AS positives,
        (SELECT count(*)::integer FROM birbcrew_ts.delegations) AS delegations`, [key.conversationId, key.requestId])).rows[0]);
    const sessions = (await pool.query("SELECT pid,datname,state FROM pg_stat_activity WHERE application_name=$1 ORDER BY pid", [scope])).rows;
    await evidence("missing-history-worker-health", { source: "SQL-seeded-committed-delegation-with-nonexistent-run-and-actual-Temporal-namespace",
      actualRetentionExpiryClaim: false, scope, namespace, databaseName, key, directObservation, workerPid: running.child.pid, pollers,
      firstHeartbeat, advancedHeartbeat, failedPassLogs: failures.length, sql, sessions, directChildren });
    assert.equal(failures.length, 0, "Missing parent history never fails the CLI worker's control pass");
    assert.deepEqual(sql, { observed: false, positives: 0, delegations: 1 }, "Missing history records no positive for the sole seeded delegation");
    assert.ok(sessions.length > 0 && sessions.every(row => row.datname === databaseName), "The CLI worker uses only its isolated database");
    await running.stop();
    assert.equal(running.child.exitCode, 0, "The missing-history CLI worker shuts down gracefully");
    const closed = await until(async () => {
      const rows = (await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1", [scope])).rows;
      return rows.length === 0 ? rows : undefined;
    }, "missing-history CLI database sessions close", 5000);
    const knownProcesses = await untilAbsent([workerPid, ...directChildren], "the missing-history CLI worker and its direct children exit", 5000);
    await evidence("missing-history-worker-shutdown", { scope, exitCode: running.child.exitCode, signalCode: running.child.signalCode,
      sessions: closed, knownProcesses, ancestry: "unproven" });
  } finally {
    try { await worker?.stop(); } finally { await dropDatabase(); }
  }
});
