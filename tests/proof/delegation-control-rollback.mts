import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as portProbe } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { z } from "zod";
import { approvalSchema } from "../../src/service/approvals.ts";
import { controlReceiptSchema, drainObservationSchema } from "../../src/service/delegation-control.ts";
import { activityQueue, memberTaskQueue } from "../../src/service/queues.ts";
import { before, boundedCommand, completedCommandFailure, describe, durableLog, now, signalOwnedChild } from "./member-service-diagnostics.mts";
import { workingState } from "./member-services.mts";

assert.equal(process.version, "v24.22.3");
assert.equal(process.platform, "linux");
assert.equal(workingState(process.env), "hosted-vm", "Retained state proof runs only in a fresh hosted VM");
const required = (name: string) => z.string().min(1).parse(process.env[name]);
const oldRoot = required("BIRBCREW_ROLLBACK_OLD_ROOT");
const artifacts = required("BIRBCREW_CONTROL_PROOF_DIR");
const temporalCli = required("TEMPORAL_CLI");
const database = required("BIRBCREW_TEST_DATABASE_URL");
for (const path of [oldRoot, artifacts, temporalCli]) assert.ok(isAbsolute(path));
assert.equal(process.env.BIRBCREW_TEMPORAL_ADDRESS, undefined, "The proof owns its Temporal server");
const newRoot = fileURLToPath(new URL("../../", import.meta.url));
assert.notEqual(resolve(oldRoot), resolve(newRoot));
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(tmpdir(), "crew-retained-rollback-"));
const stateDir = join(directory, "native");
await mkdir(stateDir, { mode: 0o700 });
const runnerLog = join(directory, "runners.jsonl");
const ownerId = "rollback-" + randomUUID();
const profiles = ["control.parent.v1", "control.legacy.v1", "control.analyst.v1", "control.recorder.v1"];
const pool = new Pool({ connectionString: database, application_name: "retained-rollback-proof", connectionTimeoutMillis: 5000,
  statement_timeout: 10000, query_timeout: 12000 });
const cleanup: (() => Promise<unknown>)[] = [];
const steps: unknown[] = [];
let phaseWorker: ChildProcess | undefined;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function evidence(name: string, value: unknown) {
  assert.match(name, /^[a-z0-9-]+$/);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024, "Bounded rollback evidence");
  await writeFile(join(artifacts, name + ".json"), bytes, { mode: 0o600 });
}
async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 120_000): Promise<T> {
  const deadline = now() + timeout;
  while (now() < deadline) {
    if (providerFailures.length) throw new AggregateError(providerFailures, "Rollback fixture provider failed");
    if (phaseWorker) {
      assert.equal(phaseWorker.exitCode, null, "Current phase worker exited");
      assert.equal(phaseWorker.signalCode, null, "Current phase worker was signalled");
    }
    const result = await before(check(), deadline, label);
    if (result !== undefined) return result;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label);
}
function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; }
}
const runnerSchema = z.strictObject({ kind: z.literal("profile-load"), pid: z.number().int().positive(), loadedBy: z.string() });
async function runners() {
  let text: string;
  try { text = await readFile(runnerLog, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  assert.ok(Buffer.byteLength(text) < 128 * 1024);
  return text.trim().split("\n").filter(Boolean).map(line => runnerSchema.parse(JSON.parse(line)))
    .filter(row => row.loadedBy === "supervisor-runner.ts");
}
async function noRunners() {
  const observed = (await runners()).map(row => ({ ...row, absent: absent(row.pid) }));
  assert.ok(observed.every(row => row.absent), "All observed native runner PIDs must be gone");
  return observed;
}
const processReports: unknown[] = [];
function owned(label: string, program: string, args: string[], env: NodeJS.ProcessEnv) {
  const logPath = join(directory, label + ".log");
  const log = durableLog(logPath);
  const child = spawn(program, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const errors: unknown[] = [];
  child.on("error", error => errors.push(error));
  child.stdout.on("error", error => errors.push(error));
  child.stderr.on("error", error => errors.push(error));
  child.stdout.on("data", (bytes: Buffer) => log.append(bytes));
  child.stderr.on("data", (bytes: Buffer) => log.append(bytes));
  const closed = new Promise<void>(done => child.once("close", () => done()));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (phaseWorker === child) phaseWorker = undefined;
    if (label === "temporal") signalOwnedChild(child, "SIGTERM");
    else child.kill("SIGTERM");
    try { await before(closed, now() + 20_000, label + " close"); }
    catch (error) {
      signalOwnedChild(child, "SIGKILL");
      await before(closed, now() + 3000, label + " forced close");
      errors.push(error);
    }
    const capture = log.close();
    assert.ok(child.pid && absent(child.pid), label + " owned PID must be absent");
    assert.ok(absent(-child.pid), label + " owned process group must be absent");
    const bytes = await readFile(logPath);
    assert.ok(bytes.length <= 1024 * 1024);
    const password = new URL(database).password;
    let safe = bytes.toString("utf8").replaceAll(database, "[owned-database]");
    if (password) safe = safe.replaceAll(password, "[database-password]");
    safe = safe.replace(/Bearer\s+[^\s"']+/g, "Bearer [synthetic-credential]");
    await writeFile(join(artifacts, label + ".log"), safe, { mode: 0o600 });
    processReports.push({ label, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, capture, stoppedAt: new Date().toISOString() });
    if (errors.length) throw new AggregateError(errors, label + " process ownership failed");
  })();
  cleanup.push(stop);
  return { child, stop, logPath };
}

const messageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))]).nullish() });
const bodySchema = z.looseObject({ model: z.enum(["control-parent", "control-analyst", "control-recorder"]), messages: z.array(messageSchema),
  tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string(), parameters: z.unknown() }) })).optional() });
const taskSchema = z.strictObject({ role: z.enum(["analyst", "recorder"]), task: z.string() });
const textOf = (message: z.infer<typeof messageSchema>) => typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("") ?? "";
type RequestObservation = { model: string; promptDigest: string; continuation: boolean; closed: boolean; finished: boolean; recalled: boolean };
const wire: RequestObservation[] = [];
const providerFailures: unknown[] = [];
const provider = createServer((request, response) => {
  void respond(request, response).catch(error => { providerFailures.push(error); response.destroy(); });
});
async function respond(request: IncomingMessage, response: ServerResponse) {
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/chat/completions");
  assert.equal(request.headers.authorization, "Bearer synthetic-control-fixture");
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; assert.ok(length <= 1024 * 1024); chunks.push(chunk); }
  const body = bodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const prompt = textOf(body.messages.findLast(row => row.role === "user") ?? { role: "user", content: "" });
  const continuation = body.messages.at(-1)?.role === "tool";
  assert.ok(wire.length < 100);
  const observed = { model: body.model, promptDigest: digest(prompt), continuation, closed: false, finished: false, recalled: false };
  wire.push(observed);
  response.once("close", () => { observed.closed = true; });
  const id = "chatcmpl_" + randomUUID();
  const frame = (delta: object, finish_reason: string | null = null) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
    model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(frame({ role: "assistant" }));
  function finish(content: string) { response.write(frame({ content })); response.write(frame({}, "stop")); observed.finished = true; response.end("data: [DONE]\n\n"); }
  function call(name: string, args: unknown) {
    response.write(frame({ tool_calls: [{ index: 0, id: "call_" + randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
    response.write(frame({}, "tool_calls")); observed.finished = true; response.end("data: [DONE]\n\n");
  }
  if (prompt.startsWith("delegate ")) {
    if (continuation) finish("delegated " + JSON.stringify(body.messages.filter(row => row.role === "tool").map(row => JSON.parse(textOf(row)))));
    else call("delegate_task", taskSchema.parse(JSON.parse(prompt.slice(9))));
  } else if (prompt.startsWith("record ")) {
    if (continuation) finish("settled " + textOf(body.messages.at(-1) ?? { role: "tool" }));
    else {
      const tool = body.tools?.find(row => row.function.name === "record_work_item");
      const schema = z.looseObject({ properties: z.looseObject({ operation_id: z.looseObject({ const: z.uuid() }) }) }).parse(tool?.function.parameters);
      call("record_work_item", { operation_id: schema.properties.operation_id.const, note: "retained ordinary parent approval" });
    }
  } else if (prompt.startsWith("hold ")) return;
  else if (prompt.startsWith("remember ")) finish("stored " + prompt.slice(9));
  else if (prompt.startsWith("recall ")) {
    assert.ok(body.messages.some(row => row.role === "assistant" && textOf(row) === "stored " + prompt.slice(7)), "Real native checkpoint retains earlier assistant content");
    observed.recalled = true; finish("recalled " + prompt.slice(7));
  } else throw new Error("Unsupported rollback provider request");
}

let connection: Connection | undefined;
let result: { kind: "passed" } | { kind: "failed"; error: string } = { kind: "failed", error: "Proof did not complete" };
try {
  await evidence("working-state", { directory, stateDir, workingState: "hosted-vm", oldRelease: "f3327346d979270a18c9f46b9cfe6a075b1cb157" });
  assert.equal(Math.floor(Number((await pool.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 17);
  assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='birbcrew_ts'")).rowCount, 0);
  assert.deepEqual(await readFile(join(oldRoot, "package-lock.json")), await readFile(join(newRoot, "package-lock.json")), "Dependency reuse requires identical lockfiles");
  assert.deepEqual(await readFile(join(oldRoot, "src/service/workflow.ts")), await readFile(join(newRoot, "src/service/workflow.ts")), "This proof's accepted floor has identical workflow source");
  const version = await boundedCommand(temporalCli, ["--version"], now() + 5000);
  assert.equal(version.stdout.kind, "complete");
  if (version.stdout.kind !== "complete") throw new Error("Temporal version truncated");
  assert.match(version.stdout.text, /^temporal version 1\.10\.0\b/);
  const probe = portProbe().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const bound = probe.address(); assert.ok(bound && typeof bound === "object");
  await new Promise<void>(done => probe.close(() => done()));
  const address = "127.0.0.1:" + bound.port;
  owned("temporal", temporalCli, ["server", "start-dev", "--headless", "--port", String(bound.port), "--db-filename", join(directory, "temporal.db")], { PATH: process.env.PATH, HOME: directory });
  await until(async () => {
    try { await boundedCommand(temporalCli, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"], now() + 2000); return true; }
    catch { return undefined; }
  }, "owned Temporal health");
  connection = await Connection.connect({ address });
  const temporal = new Client({ connection });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const listening = provider.address(); assert.ok(listening && typeof listening === "object");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory,
    BIRBCREW_DATABASE_URL: database, BIRBCREW_STATE_DIR: stateDir,
    BIRBCREW_TEMPORAL_ADDRESS: address, BIRBCREW_TEMPORAL_NAMESPACE: "default",
    BIRBCREW_CONTROL_FIXTURE_ENDPOINT: `http://127.0.0.1:${listening.port}/chat/completions`, BIRBCREW_CONTROL_RUNNER_LOG: runnerLog };
  const profileText = await readFile(new URL("./delegation-control-profiles.mts", import.meta.url), "utf8");
  async function config(root: string, label: string) {
    const target = join(directory, label + "-profiles.mts");
    await writeFile(target, profileText.replaceAll('from "../../src/', 'from "' + join(root, "src") + "/")
      .replace('from "zod"', 'from "' + join(root, "node_modules/zod/index.js") + '"'), { mode: 0o600 });
    return target;
  }
  const oldConfig = await config(oldRoot, "old"), newConfig = await config(newRoot, "new");
  const queues = [{ name: memberTaskQueue, type: 1 }, { name: memberTaskQueue, type: 2 }, ...profiles.map(profile => ({ name: activityQueue("pi", profile), type: 2 }))];
  async function pollers(label: string) {
    const snapshots = await Promise.all(queues.map(async queue => ({ ...queue, observation: await temporal.connection.workflowService.describeTaskQueue({
      namespace: "default", taskQueue: { name: queue.name }, taskQueueType: queue.type,
    }) })));
    await evidence(label + "-pollers", { observedAt: new Date().toISOString(), routing: "unversioned-exclusive-process-cutover", snapshots });
    return snapshots;
  }
  async function startWorker(root: string, configuration: string, label: string) {
    const worker = owned(label, process.execPath, [join(root, "src/service/cli.ts"), "worker", configuration], env);
    phaseWorker = worker.child;
    const identity = await until(async () => {
      assert.equal(worker.child.exitCode, null, label + " exited during startup");
      assert.equal(worker.child.signalCode, null, label + " was signalled during startup");
      const descriptions = await Promise.all(queues.map(queue => temporal.connection.workflowService.describeTaskQueue({
        namespace: "default", taskQueue: { name: queue.name }, taskQueueType: queue.type,
      })));
      const identities = descriptions.map(description => description.pollers?.find(poller => poller.identity?.startsWith(worker.child.pid + "@"))?.identity);
      return identities.every(value => value !== undefined) ? z.string().parse(identities[0]) : undefined;
    }, label + " actual queue pollers");
    await pollers(label);
    steps.push({ label, pid: worker.child.pid, identity, root, startedAt: new Date().toISOString() });
    return { ...worker, identity };
  }
  let inputNumber = 0;
  async function cli(root: string, operation: string, input: unknown): Promise<unknown> {
    const inputPath = join(directory, "input-" + ++inputNumber + ".json");
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    const output = await boundedCommand("/bin/sh", ["-c", 'exec "$1" "$2" "$3" < "$4"', "rollback-cli", process.execPath,
      join(root, "src/service/cli.ts"), operation, inputPath], now() + 120_000, { env });
    assert.equal(output.stdout.kind, "complete");
    if (output.stdout.kind !== "complete") throw new Error("Truncated application CLI reply");
    return JSON.parse(output.stdout.text);
  }
  const { MemberStore }: typeof import("../../src/service/store.ts") = await import(pathToFileURL(join(oldRoot, "src/service/store.ts")).href);
  const { MemberClient }: typeof import("../../src/service/client.ts") = await import(pathToFileURL(join(oldRoot, "src/service/client.ts")).href);
  const members = new MemberClient(new MemberStore(pool), temporal);
  const workflowIds: string[] = [];
  const childSchema = z.looseObject({ child_id: z.uuid(), workflow_run_id: z.string().nullable(), outcome: z.unknown().nullable(), phase: z.string() });
  async function children(requestId: string) {
    return z.array(childSchema).parse((await pool.query("SELECT * FROM birbcrew_ts.pi_children WHERE request_id=$1 ORDER BY ordinal", [requestId])).rows);
  }
  async function conversation(root: string, profile = profiles[0]) {
    const member = z.looseObject({ memberId: z.uuid() }).parse(await cli(root, "spawn", { ownerId, requestId: randomUUID(), engine: "pi", profile }));
    const key = { ownerId, memberId: member.memberId, conversationId: randomUUID() };
    await cli(root, "open", key);
    workflowIds.push(`birbcrew-ts/member/${key.memberId}/conversation/${key.conversationId}`);
    return key;
  }
  const turn = (key: { conversationId: string }, text: string) => ({ ownerId, conversationId: key.conversationId, requestId: randomUUID(), text });
  async function reply(requestId: string) {
    return until(async () => {
      const row = (await pool.query("SELECT phase,reply FROM birbcrew_ts.turns WHERE request_id=$1", [requestId])).rows[0];
      return row?.phase === "committed" ? z.string().parse(row.reply) : undefined;
    }, "committed application reply");
  }
  const seed = await startWorker(oldRoot, oldConfig, "old-seed");
  assert.equal((await pool.query("SELECT max(version) AS version FROM birbcrew_ts.schema_versions")).rows[0].version, 37);
  const oldDelegation = turn(await conversation(oldRoot), "delegate " + JSON.stringify({ role: "analyst", task: "remember old-child-" + randomUUID() }));
  await cli(oldRoot, "turn", oldDelegation);
  const historical = await children(oldDelegation.requestId);
  assert.equal(historical.length, 1); assert.equal(historical[0].phase, "complete");
  workflowIds.push("birbcrew-ts/child/" + historical[0].child_id);
  const remembered = await conversation(oldRoot), marker = randomUUID();
  const rememberedRequest = turn(remembered, "remember " + marker);
  assert.equal(z.looseObject({ text: z.string() }).parse(await cli(oldRoot, "turn", rememberedRequest)).text, "stored " + marker);
  const approvalConversation = await conversation(oldRoot, "control.recorder.v1");
  const approvalRequest = turn(approvalConversation, "record " + randomUUID());
  await members.accept(approvalRequest);
  const card = await until(async () => {
    const pending = z.array(approvalSchema).parse(await cli(oldRoot, "pending", { ownerId, conversationId: approvalConversation.conversationId }));
    return pending.length === 1 ? pending[0] : undefined;
  }, "old application ordinary parent approval");
  await until(async () => (await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE NOT stopped")).rowCount === 0 ? true : undefined, "old native runners stopped");
  await seed.stop(); await noRunners(); await pollers("old-seed-stopped");
  const current = await startWorker(newRoot, newConfig, "current");
  assert.equal((await pool.query("SELECT max(version) AS version FROM birbcrew_ts.schema_versions")).rows[0].version, 38);
  const heldTask = "hold " + randomUUID();
  const retiredRequest = turn(await conversation(newRoot), "delegate " + JSON.stringify({ role: "analyst", task: heldTask }));
  await members.accept(retiredRequest);
  const held = await until(async () => wire.find(row => row.promptDigest === digest(heldTask)), "actual child provider invocation");
  const activeChildren = await children(retiredRequest.requestId);
  assert.equal(activeChildren.length, 1); assert.ok(activeChildren[0].workflow_run_id);
  workflowIds.push("birbcrew-ts/child/" + activeChildren[0].child_id);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1 AND NOT stopped", [activeChildren[0].child_id])).rowCount, 1);
  const { DelegationControl } = await import("../../src/service/delegation-control.ts");
  const { TemporalDelegationWorkflows } = await import("../../src/service/delegation-control-workflows.ts");
  const control = new DelegationControl({ pool, workflows: new TemporalDelegationWorkflows(temporal) });
  const command = controlReceiptSchema.parse(await control.change({ commandId: randomUUID(), expectedRevision: (await control.status()).revision,
    scope: { kind: "global" }, enabled: false, actor: "retained-rollback-proof", reason: "stop named child before exact old application rollback" }));
  const drain = await until(async () => {
    const output = await boundedCommand(process.execPath, [join(newRoot, "src/service/delegation-control-cli.ts"), "drain", command.commandId], now() + 20_000, { env });
    if (output.stdout.kind !== "complete") throw new Error("Truncated real drain command");
    const report = drainObservationSchema.parse(JSON.parse(output.stdout.text));
    return report.complete ? report : undefined;
  }, "current worker reconciliation and real drain");
  assert.equal(drain.valid, true); assert.equal(drain.admissionClosed, true); assert.deepEqual(drain.blockers, []);
  assert.equal(drain.children.length, 1); assert.equal(drain.children[0].retire, true);
  assert.equal(drain.children[0].workflow.kind, "closed"); assert.equal(drain.parents[0].workflow.kind, "observed");
  assert.equal(held.closed, true); assert.equal(held.finished, false);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE NOT stopped")).rowCount, 0);
  const retiredReply = await reply(retiredRequest.requestId);
  await evidence("drain-before-rollback", drain);
  await current.stop(); await noRunners(); await pollers("current-stopped");
  async function retainedRows() {
    return {
      children: (await pool.query("SELECT to_jsonb(j) AS row FROM birbcrew_ts.pi_children j ORDER BY child_id")).rows,
      changes: (await pool.query("SELECT to_jsonb(c) AS row FROM birbcrew_ts.delegation_control_changes c ORDER BY command_id")).rows,
      membership: (await pool.query("SELECT to_jsonb(c) AS row FROM birbcrew_ts.delegation_control_children c ORDER BY command_id,child_id")).rows,
      migrations: (await pool.query("SELECT version FROM birbcrew_ts.schema_versions ORDER BY version")).rows,
      nativeCheckpoints: (await pool.query(`SELECT 'turn' AS source,request_id,checkpoint FROM birbcrew_ts.turns
        WHERE request_id=ANY($1::uuid[]) UNION ALL
        SELECT 'paused' AS source,request_id,checkpoint FROM birbcrew_ts.paused_segments WHERE request_id=$2
        ORDER BY source,request_id`, [[oldDelegation.requestId, rememberedRequest.requestId, retiredRequest.requestId], approvalRequest.requestId])).rows,
      state: await control.status(),
    };
  }
  async function nativeManifest(path = stateDir): Promise<{ path: string; dev: number; ino: number; bytes: number; sha256: string }[]> {
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Native fixture manifest forbids symlinks");
      if (entry.isDirectory()) files.push(...await nativeManifest(name));
      else {
        const metadata = await stat(name); assert.ok(metadata.isFile() && metadata.size <= 8 * 1024 * 1024);
        files.push({ path: name.slice(stateDir.length + 1), dev: metadata.dev, ino: metadata.ino, bytes: metadata.size, sha256: digest(await readFile(name)) });
      }
      assert.ok(files.length <= 128);
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
  const retained = await retainedRows();
  assert.equal(retained.nativeCheckpoints.length, 4);
  for (const checkpoint of retained.nativeCheckpoints) {
    assert.equal(z.looseObject({ engine: z.literal("pi"), state: z.unknown() }).parse(checkpoint.checkpoint).engine, "pi");
  }
  const nativeBefore = await nativeManifest();
  const stateIdentity = await stat(stateDir);
  const historyBefore = await Promise.all(workflowIds.map(async workflowId => {
    const handle = temporal.workflow.getHandle(workflowId), description = await handle.describe(), history = await handle.fetchHistory();
    assert.ok(history.events?.length);
    return { workflowId, runId: description.runId, events: history.events.map(event => JSON.stringify(event)) };
  }));
  await evidence("retained-before", { sql: retained, native: nativeBefore, stateDirectory: { dev: stateIdentity.dev, ino: stateIdentity.ino },
    histories: historyBefore.map(history => ({ workflowId: history.workflowId, runId: history.runId, eventCount: history.events.length, sha256: digest(JSON.stringify(history.events)) })) });
  assert.deepEqual(await nativeManifest(), nativeBefore);
  const rollback = await startWorker(oldRoot, oldConfig, "old-rollback");
  assert.equal((await stat(stateDir)).ino, stateIdentity.ino);
  assert.deepEqual(await retainedRows(), retained, "Old worker startup retains schema, control history and native SQL checkpoints");
  const requestCount = wire.length;
  assert.equal(z.looseObject({ text: z.string() }).parse(await cli(oldRoot, "turn", retiredRequest)).text, retiredReply);
  assert.equal(wire.length, requestCount, "Committed reply retry through old CLI invokes no provider");
  const recalled = turn(remembered, "recall " + marker);
  assert.equal(z.looseObject({ text: z.string() }).parse(await cli(oldRoot, "turn", recalled)).text, "recalled " + marker);
  assert.ok(wire.some(row => row.promptDigest === digest(recalled.text) && row.recalled));
  await cli(oldRoot, "decide", { ownerId, memberId: card.memberId, conversationId: card.conversationId, requestId: card.requestId,
    approvalId: card.approvalId, invocationId: card.invocationId, nativeCallId: card.nativeCallId, argumentDigest: card.argumentDigest,
    version: card.version, choice: "approve" });
  assert.match(await reply(approvalRequest.requestId), /^settled /);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.work_items WHERE request_id=$1 AND approval_id=$2", [approvalRequest.requestId, card.approvalId])).rowCount, 1);
  const deniedTask = "remember forbidden-child-" + randomUUID();
  const deniedRequest = turn(await conversation(oldRoot), "delegate " + JSON.stringify({ role: "analyst", task: deniedTask }));
  let refused = false;
  try { await cli(oldRoot, "turn", deniedRequest); }
  catch (error) { assert.ok(completedCommandFailure(error), "Old delegation must settle as a failed command, not a timeout"); refused = true; }
  assert.equal(refused, true);
  const refusal = (await readFile(rollback.logPath, "utf8")).split("\n").filter(line => line.startsWith("{")).map(line => {
    try { return z.looseObject({ event: z.string(), requestId: z.string().optional(), code: z.string().optional(), message: z.string().optional() }).parse(JSON.parse(line)); }
    catch { return undefined; }
  }).find(row => row?.event === "native_turn_unconfirmed" && row.requestId === deniedRequest.requestId && row.code === "55000"
    && row.message === "Delegation admission is disabled or retired");
  assert.ok(refusal, "Actual old application delegation reaches the retained SQL guard");
  assert.ok(wire.some(row => row.promptDigest === digest(deniedRequest.text)));
  assert.equal(wire.filter(row => row.promptDigest === digest(deniedTask)).length, 0);
  for (const table of ["pi_children", "delegations"]) assert.equal((await pool.query(`SELECT 1 FROM birbcrew_ts.${table} WHERE request_id=$1`, [deniedRequest.requestId])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE request_id=$1 AND child_id IS NOT NULL", [deniedRequest.requestId])).rowCount, 0);
  assert.deepEqual(await retainedRows(), retained, "Old application preserves all child outcomes, retirements and disabled control state");
  const histories = [];
  for (const previous of historyBefore) {
    const handle = temporal.workflow.getHandle(previous.workflowId, previous.runId);
    const history = await handle.fetchHistory();
    assert.deepEqual(history.events?.slice(0, previous.events.length).map(event => JSON.stringify(event)), previous.events, "Retained Temporal history prefix must remain exact");
    await before(Worker.runReplayHistory({ workflowsPath: join(oldRoot, "src/service/workflow.ts") }, history, previous.workflowId), now() + 45_000, "Old workflow replay");
    histories.push({ workflowId: previous.workflowId, runId: previous.runId, events: history.events?.length, replayedWith: "f3327346d979270a18c9f46b9cfe6a075b1cb157" });
  }
  const followupHistory = await temporal.workflow.getHandle(`birbcrew-ts/member/${remembered.memberId}/conversation/${remembered.conversationId}`).fetchHistory();
  assert.ok(followupHistory.events?.some(event => event.workflowTaskCompletedEventAttributes?.identity === rollback.identity), "Actual old rollback worker completes retained workflow tasks");
  const finalDrain = await control.drain(command.commandId);
  assert.equal(finalDrain.complete, true); assert.equal(finalDrain.valid, true); assert.equal(finalDrain.admissionClosed, true);
  await evidence("rollback-assertions", { histories, refusal, retained: await retainedRows(), finalDrain, ordinaryApprovalId: card.approvalId,
    oldWorkerIdentity: rollback.identity, workflowCode: "byte-identical-at-accepted-floor", dependencyLock: "byte-identical", scope: "live-database-global-disable-application-only" });
  await pollers("rollback-completed");
  assert.deepEqual(providerFailures, []);
  await rollback.stop(); await noRunners();
  result = { kind: "passed" };
} catch (error) {
  result = { kind: "failed", error: describe(error) };
  throw error;
} finally {
  const failures: string[] = [];
  for (const close of cleanup.reverse()) {
    try { await before(close(), now() + 25_000, "Rollback owned process cleanup"); }
    catch (error) { failures.push(describe(error)); }
  }
  try { await connection?.close(); } catch (error) { failures.push(describe(error)); }
  try { await pool.end(); } catch (error) { failures.push(describe(error)); }
  try {
    if (provider.listening) {
      const closed = new Promise<void>(done => provider.close(() => done()));
      provider.closeAllConnections(); await before(closed, now() + 3000, "Loopback provider close");
    }
  } catch (error) { failures.push(describe(error)); }
  let runnerObservations: Awaited<ReturnType<typeof noRunners>> = [];
  try { runnerObservations = await noRunners(); } catch (error) { failures.push(describe(error)); }
  await evidence("provider", { wire, failures: providerFailures.map(describe) });
  await evidence("cleanup", { result, steps, processReports, runnerObservations, failures, workingState: "retained-in-disposable-hosted-vm", ancestry: "unproven" });
  if (failures.length && result.kind === "passed") throw new AggregateError(failures, "Retained rollback proof cleanup failed");
}
