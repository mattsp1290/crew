import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as portProbe } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { z } from "zod";
import { memberActivities } from "../../src/service/activities.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { type ChildKey } from "../../src/service/children.ts";
import { MemberClient } from "../../src/service/client.ts";
import { DelegationControl, type ControlCommand, type ControlReceipt } from "../../src/service/delegation-control.ts";
import { TemporalDelegationWorkflows } from "../../src/service/delegation-control-workflows.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { activityQueue, memberTaskQueue } from "../../src/service/queues.ts";
import { MemberStore } from "../../src/service/store.ts";
import { startSupervisor } from "../../src/service/supervisor.ts";
import { memberQueueActivities } from "../../src/service/worker.ts";
import { before, boundedCommand, durableLog, now, signalOwnedChild } from "../proof/member-service-diagnostics.mts";
import { workingState } from "../proof/member-services.mts";

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
type OwnedProcess = { scope: string; child: ChildProcess; stopped: boolean; logPath: string;
  capture: ReturnType<ReturnType<typeof durableLog>["close"]> | undefined };
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
    const runners = await runnerLoads();
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
  const password = new URL(database).password;
  for (const process of processes) {
    try {
      const bytes = await readFile(process.logPath);
      assert.ok(bytes.length <= 1024 * 1024, "Canonical process log retention bound");
      const start = Math.max(0, bytes.length - 64 * 1024);
      const selected = bytes.subarray(start).toString("utf8");
      let safe = selected.replaceAll(database, "[fixture-database-url]");
      if (password) safe = safe.replaceAll(password, "[fixture-database-password]");
      safe = safe.replace(/Bearer\s+[^\s"']+/g, "Bearer [fixture-credential]");
      const artifact = process.scope + "-diagnostics.log";
      const output = Buffer.from(safe);
      assert.ok(output.length <= 96 * 1024, "Sanitized process diagnostic bound");
      await writeFile(join(proof, artifact), output, { mode: 0o600 });
      observations.push({ scope: process.scope, artifact, pid: process.child.pid, observedAt: new Date().toISOString(),
        capture: process.capture ?? null, captureClosed: process.capture !== undefined, sourceFileBytes: bytes.length,
        selectedStartByte: start, selectedBytes: bytes.length - start, artifactBytes: output.length,
        artifactSha256: createHash("sha256").update(output).digest("hex"), sanitized: safe !== selected,
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

function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; }
}
const loadSchema = z.strictObject({ kind: z.literal("profile-load"), pid: z.number().int().positive(), loadedBy: z.string() });
async function runnerLoads() {
  let bytes: string;
  try { bytes = await readFile(runnerLog, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  assert.ok(Buffer.byteLength(bytes) < 512 * 1024);
  return bytes.trim().split("\n").filter(Boolean).map(line => loadSchema.parse(JSON.parse(line)));
}
async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 60_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label);
}

function owned(scope: string, program: string, args: string[], env = process.env) {
  const logPath = join(directory, scope + ".log");
  const log = durableLog(logPath);
  const child = spawn(program, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const observation: OwnedProcess = { scope, child, stopped: false, logPath, capture: undefined };
  processes.push(observation);
  child.stdout.on("data", (bytes: Buffer) => log.append(bytes));
  child.stderr.on("data", (bytes: Buffer) => log.append(bytes));
  const closed = once(child, "close");
  void closed.catch(() => {});
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (scope === "restarted-worker") child.kill("SIGTERM");
    else signalOwnedChild(child, "SIGTERM");
    try { await before(closed, now() + 20_000, scope + " owned process close"); }
    catch (error) { signalOwnedChild(child, "SIGKILL"); await before(closed, now() + 3_000, scope + " forced close"); throw error; }
    finally {
      observation.capture = log.close();
      await evidence(scope + "-process", { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, capture: observation.capture });
    }
    observation.stopped = true;
  })();
  cleanupSteps.push(stop);
  return { child, stop };
}

async function temporalServer() {
  assert.equal(process.env.BIRBCREW_TEMPORAL_ADDRESS, undefined, "This suite owns a fresh Temporal development server");
  const cli = process.env.TEMPORAL_CLI;
  assert.ok(cli, "TEMPORAL_CLI must name the official Temporal CLI 1.10.0 fixture");
  const version = await boundedCommand(cli, ["--version"], now() + 5_000);
  assert.equal(version.stdout.kind, "complete");
  if (version.stdout.kind !== "complete") throw new Error("Truncated Temporal version");
  assert.match(version.stdout.text, /^temporal version 1\.10\.0\b/);
  const probe = portProbe().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const bound = probe.address();
  assert.ok(bound && typeof bound === "object");
  const address = "127.0.0.1:" + bound.port;
  await new Promise<void>(done => probe.close(() => done()));
  const serverProcess = owned("temporal", cli, ["server", "start-dev", "--headless", "--port", String(bound.port), "--db-filename", join(directory, "temporal.db")]);
  await until(async () => {
    assert.equal(serverProcess.child.exitCode, null, "Owned Temporal server exited during startup");
    try { await boundedCommand(cli, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"], now() + 2_000); return true; }
    catch { return undefined; }
  }, "Temporal health");
  await evidence("prerequisites", { temporalVersion: version.stdout.text.trim(), node: processVersion, platform: "linux", database: "separate-fresh-pg17" });
  return address;
}
const processVersion = process.version;

const messageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))]).nullish() });
const requestSchema = z.looseObject({ model: z.enum(["control-parent", "control-analyst", "control-recorder"]),
  messages: z.array(messageSchema), tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string(), parameters: z.unknown() }) })).optional() });
const taskSchema = z.strictObject({ role: z.enum(["analyst", "recorder"]), task: z.string() });
const childOutcomeSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("failed"), nativeCallId: z.string(), code: z.string() }),
  z.looseObject({ kind: z.literal("completed"), nativeCallId: z.string(), text: z.string() }),
  z.looseObject({ kind: z.literal("cancelled"), nativeCallId: z.string() }),
]);
type WireObservation = { sequence: number; model: z.infer<typeof requestSchema>["model"]; promptDigest: string; continuation: boolean; responseClosed: boolean; responseFinished: boolean };
const wire: WireObservation[] = [];
const held = new Map<string, { release: () => void; closed: Promise<void> }>();
const parentHolds = new Set<string>(), resumeHolds = new Set<string>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (message: z.infer<typeof messageSchema>) => typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("") ?? "";
const provider = createServer((request, response) => {
  void respond(request, response).catch(() => {
    if (!response.headersSent) { response.writeHead(502); response.end('{"error":{"message":"Control fixture request refused"}}'); }
    else response.destroy();
  });
});
async function respond(request: IncomingMessage, response: ServerResponse) {
  assert.equal(request.method, "POST"); assert.equal(request.url, "/chat/completions");
  assert.equal(request.headers.authorization, "Bearer synthetic-control-fixture");
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of request) { bytes += part.length; assert.ok(bytes <= 1024 * 1024); parts.push(part); }
  const body = requestSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
  const prompt = text(body.messages.findLast(message => message.role === "user") ?? { role: "user", content: "" });
  const continuation = body.messages.at(-1)?.role === "tool";
  assert.ok(wire.length < 200, "Control fixture request bound");
  const observation: WireObservation = { sequence: wire.length + 1, model: body.model, promptDigest: digest(prompt), continuation, responseClosed: false, responseFinished: false };
  wire.push(observation);
  const closed = new Promise<void>(done => response.once("close", () => { observation.responseClosed = true; done(); }));
  const id = "chatcmpl_" + randomUUID();
  const frame = (delta: object, finish_reason: string | null = null) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
    model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
  response.writeHead(200, { "content-type": "text/event-stream" }); response.write(frame({ role: "assistant" }));
  function finish(content: string) {
    if (response.destroyed) return;
    response.write(frame({ content })); response.write(frame({}, "stop"));
    observation.responseFinished = true; response.end("data: [DONE]\n\n");
  }
  function call(name: string, args: unknown, index = 0) {
    response.write(frame({ tool_calls: [{ index, id: "call_" + randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
  }
  function hold(content: string, key: string) {
    assert.ok(!held.has(key), "A provider barrier can have only one live response");
    held.set(key, { release: () => finish(content), closed });
    void closed.finally(() => held.delete(key));
  }
  if (prompt.startsWith("delegate ")) {
    if (!continuation) {
      const tasks = z.array(taskSchema).min(1).max(2).parse(JSON.parse(prompt.slice(9)));
      tasks.forEach((task, index) => call("delegate_task", task, index));
      response.write(frame({}, "tool_calls")); response.end("data: [DONE]\n\n"); observation.responseFinished = true;
    } else {
      const results = body.messages.filter(message => message.role === "tool").map(message => childOutcomeSchema.parse(JSON.parse(text(message))));
      const reply = "delegated " + JSON.stringify(results);
      if (parentHolds.has(digest(prompt))) hold(reply, "parent/" + digest(prompt)); else finish(reply);
    }
  } else if (prompt.startsWith("record ")) {
    if (continuation) {
      const reply = "settled " + text(body.messages.at(-1) ?? { role: "tool", content: "" });
      if (resumeHolds.has(digest(prompt))) hold(reply, "resume/" + digest(prompt)); else finish(reply);
    } else {
      const tool = body.tools?.find(tool => tool.function.name === "record_work_item");
      const schema = z.looseObject({ properties: z.looseObject({ operation_id: z.looseObject({ const: z.uuid() }) }) }).parse(tool?.function.parameters);
      call("record_work_item", { operation_id: schema.properties.operation_id.const, note: "synthetic control fixture note" });
      response.write(frame({}, "tool_calls")); response.end("data: [DONE]\n\n"); observation.responseFinished = true;
    }
  } else if (prompt.startsWith("hold ")) hold("held complete", "child/" + digest(prompt));
  else if (prompt.startsWith("remember ")) finish("stored " + prompt.slice(9));
  else throw new Error("Unsupported control fixture prompt");
}
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
cleanupSteps.push(async () => { const closed = new Promise<void>(done => provider.close(() => done())); provider.closeAllConnections(); await closed; cleanupResults.push({ scope: "provider", state: "closed" }); });
const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress === "object");
const address = await temporalServer();
process.env.BIRBCREW_TEMPORAL_ADDRESS = address;
process.env.BIRBCREW_TEMPORAL_NAMESPACE = "default";
process.env.BIRBCREW_DATABASE_URL = database;
process.env.BIRBCREW_CONTROL_FIXTURE_ENDPOINT = `http://127.0.0.1:${providerAddress.port}/chat/completions`;
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
const control = new DelegationControl({ pool, workflows: new TemporalDelegationWorkflows(temporal) });
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
async function activityWorkers(names = [parentProfile, legacyProfile, analystProfile, recorderProfile]) {
  const supervisor = await startSupervisor(config, stateDir);
  const running: RunningWorker[] = [];
  try {
    for (const name of names) running.push(runWorker(await Worker.create({ connection: native, taskQueue: activityQueue("pi", name),
      activities: memberActivities(store, supervisor, profiles, stateDir, "pi") })));
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
async function delegation(tasks: z.infer<typeof taskSchema>[], profile = parentProfile) {
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const conversationId = randomUUID(), requestId = randomUUID();
  const conversation = await members.open({ ownerId, memberId, conversationId });
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
  return control.change({ commandId: randomUUID(), expectedRevision: (await control.status()).revision, scope, enabled,
    actor: "actual-pi-temporal-fixture", reason: "synthetic delegation control proof" });
}
async function enable() {
  await change(true);
  for (const target of (await control.status()).disabledTargets) await change(true, target);
}
async function committed(value: Delegation) {
  return until(async () => {
    const { rows: [turn] } = await pool.query<{ reply: string | null; phase: string }>("SELECT reply,phase FROM birbcrew_ts.turns WHERE request_id=$1", [value.request.requestId]);
    return turn?.phase === "committed" && turn.reply !== null ? turn.reply : undefined;
  }, "committed parent follow-up");
}
async function flushUntilComplete(command: ControlReceipt) {
  return until(async () => { await control.flush(); const report = await control.drain(command.commandId); return report.complete ? report : undefined; }, "combined exact child and parent drain", 120_000);
}
async function countSnapshot() {
  const loads = await runnerLoads();
  return { providerRequests: wire.length, runnerProfileLoads: loads.filter(row => row.loadedBy === "supervisor-runner.ts").length };
}
async function recordCase(label: string, value: Delegation, command: ControlReceipt) {
  const launches = (await pool.query(`SELECT child_id,token,workflow_run_id,activity_id,attempt,stopped
    FROM birbcrew_ts.native_launches WHERE request_id=$1 ORDER BY child_id NULLS FIRST,token`, [value.request.requestId])).rows;
  const prompts = new Set([value.request.text, ...value.tasks.map(task => task.task)].map(digest));
  const requests = wire.filter(row => prompts.has(row.promptDigest));
  const loads = (await runnerLoads()).filter(row => row.loadedBy === "supervisor-runner.ts");
  await evidence(label, { requestId: value.request.requestId, childRows: await childRows(value.request.requestId),
    nativeLaunchReservations: launches, providerRequests: requests, suiteCumulativeRunnerProfileLoads: loads,
    admissionEvidenceScope: "provider request proves final admission; reservation alone does not",
    report: await control.drain(command.commandId) });
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
    const baselineLoads = new Set((await runnerLoads()).map(row => row.pid));
    const value = await delegation([{ role: "analyst", task }]);
    const request = await until(async () => wire.find(row => row.promptDigest === digest(task)), "actual running child provider request");
    const running = (await runnerLoads()).filter(row => row.loadedBy === "supervisor-runner.ts" && !baselineLoads.has(row.pid) && !absent(row.pid));
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
  try {
    const tasks = [0, 1].map(() => ({ role: "recorder" as const, task: "record " + randomUUID() }));
    const parentPrompt = "delegate " + JSON.stringify(tasks); parentHolds.add(digest(parentPrompt));
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
    const parentPending = await control.drain(command.commandId);
    assert.equal(parentPending.complete, false); assert.ok(parentPending.blockers.some(blocker => blocker.kind === "parent_pending"));
    await evidence("parent-follow-up-pending", parentPending);
    await blocker.query("BEGIN");
    const locked = await blocker.query<{ token: string }>(`SELECT token FROM birbcrew_ts.native_launches WHERE request_id=$1
      AND child_id IS NULL AND NOT stopped FOR UPDATE`, [value.request.requestId]);
    assert.equal(locked.rowCount, 1, "The held provider request owns the parent follow-up launch");
    const lockedToken = locked.rows[0].token;
    const beforeRelease = await runnerLoads();
    const parentBarrier = held.get("parent/" + digest(parentPrompt)); assert.ok(parentBarrier);
    parentBarrier.release(); parentHolds.delete(digest(parentPrompt));
    const reply = await committed(value);
    const outcomes = z.array(childOutcomeSchema).parse(JSON.parse(reply.slice(10)));
    assert.deepEqual(outcomes.map(outcome => [outcome.nativeCallId, outcome.kind]), rows.map(row => [row.nativeCallId, "failed"]));
    const wait = await until(async () => {
      const { rows: [row] } = await pool.query(`SELECT pid,wait_event_type,wait_event,state,query FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE birbcrew_ts.native_launches SET stopped=true%'`);
      return row;
    }, "real native stop UPDATE withheld by the owned row lock");
    const remaining = await until(async () => {
      const rows = beforeRelease.filter(row => row.loadedBy === "supervisor-runner.ts").map(row => ({ pid: row.pid, absent: absent(row.pid) }));
      return rows.every(row => row.absent) ? rows : undefined;
    }, "known runner PIDs absent before withheld stopped update");
    const nativePending = await control.drain(command.commandId);
    assert.equal(nativePending.complete, false);
    assert.ok(nativePending.blockers.some(blocker => blocker.kind === "native_unconfirmed" && blocker.tokens.includes(lockedToken)));
    assert.ok(!nativePending.blockers.some(blocker => blocker.kind === "parent_pending"));
    await evidence("native-stopped-row-withheld", { sql: wait, knownRunnerPids: remaining, token: lockedToken, report: nativePending });
    await blocker.query("ROLLBACK");
    await flushUntilComplete(command); await recordCase("unanswered-recorders", value, command); await replay(value);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await activities.stop(); await workflow.stop(); }
});

test("an approved resumed recorder keeps its committed receipt while control retires its native continuation", { timeout: 240_000 }, async () => {
  await enable(); const workflow = await workflowWorker(), activities = await activityWorkers();
  try {
    const task = "record " + randomUUID(); resumeHolds.add(digest(task));
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
    resumeHolds.delete(digest(task)); await recordCase("resumed-receipt-preserved", value, command); await replay(value);
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
      await control.flush(); const report = await control.drain(command.commandId);
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
    });
    await until(async () => { try { await readFile(heartbeat); return true; } catch { return undefined; } }, "actual restarted worker heartbeat");
    await committed(value);
    const report = await until(async () => {
      const report = await control.drain(command.commandId);
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
