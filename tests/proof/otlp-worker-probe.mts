import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { services, until, type ServiceHandle } from "./member-services.mts";
import { commands, decision, pendingSchema } from "./member-commands.mts";
import { before, durableLog, firstFailure, describe } from "./member-service-diagnostics.mts";

assert.equal(process.platform, "linux");
assert.equal(process.version, "v24.22.3");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.OTLP_PROBE_ONLY, "NEVER_MERGE");
assert.equal(process.env.BIRBCREW_PROOF_WORKING_STATE, "github-hosted-vm");
assert.equal(resolve(process.cwd()), process.env.GITHUB_WORKSPACE);
assert.equal(process.env.NODE_OPTIONS, undefined);
const artifactRoot = join(process.cwd(), ".proof/artifacts/otlp-worker");
assert.equal(process.env.BIRBCREW_PROOF_ARTIFACTS, artifactRoot);
mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
const now = () => performance.now();
const origin = now();
const events: object[] = [];
let eventBytes = 0;
function event(kind: string, value: object = {}) {
  try {
    assert.ok(events.length < 2048, "Event evidence bound exceeded");
    const row = { atMs: now() - origin, kind, ...value };
    const serialized = JSON.stringify(row) + "\n";
    eventBytes += Buffer.byteLength(serialized);
    assert.ok(eventBytes <= 4 * 1024 * 1024, "Event byte bound exceeded");
    events.push(row);
    appendFileSync(join(artifactRoot, "events.jsonl"), serialized, { mode: 0o600 });
  } catch (error) { fail(error); }
}
function save(name: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 2 * 1024 * 1024, "Artifact size bound");
  writeFileSync(join(artifactRoot, name), bytes, { mode: 0o600, flag: "wx" });
}
const spanSchema = z.object({ name: z.string(), traceId: z.string(), spanId: z.string(),
  status: z.object({ code: z.number().optional() }).optional(),
  attributes: z.array(z.object({ key: z.string(), value: z.object({ stringValue: z.string().optional() }) })).optional() });
const requestSchema = z.object({ resourceSpans: z.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) })) });
type WireSpan = z.infer<typeof spanSchema>;
function identity(span: WireSpan) {
  const attributes = new Map(span.attributes?.map(attribute => [attribute.key, attribute.value.stringValue]));
  return { name: span.name, traceId: span.traceId, spanId: span.spanId, status: span.status?.code,
    requestId: attributes.get("requestId"), conversationId: attributes.get("conversationId"), engine: attributes.get("engine") };
}
const traceSchema = z.array(z.object({ name: z.string(), traceId: z.string(), spanId: z.string(), status: z.number(),
  attributes: z.object({ requestId: z.uuid(), conversationId: z.uuid(), engine: z.string() }) }));
type ProcessIdentity = { pid: number; ppid: number; pgid: number; startTicks: string; role: "worker" | "supervisor" | "runner" };
function processFields(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), startTicks: fields[19], argv };
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return undefined;
    throw error;
  }
}
function groupAbsent(pgid: number) {
  try { process.kill(-pgid, 0); return false; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}
const known = new Map<number, ProcessIdentity>();
let worker: ChildProcess | undefined;
let fixture: ServiceHandle | undefined;
let censusTimer: NodeJS.Timeout | undefined;
let responseTimer: NodeJS.Timeout | undefined;
let shutdownTimer: NodeJS.Timeout | undefined;
let first: unknown;
let cleanupStarted = false;
type Shutdown = { sentAt: number; count: number; responseStartedAt: number };
let shutdown: Shutdown | undefined;
let responseClosedAt: number | undefined;
let socketClosedAt: number | undefined;
let targetResponseBytes = 0;
const trickleTimes: number[] = [];
let healthyRequestId = "", hostileRequestId = "", conversationId = "";
let healthySeen = 0, hostileSeen = 0, requestCount = 0, totalRequestBytes = 0;
let warningText = "", warningBytes = 0;
let warningObservedAt: number | undefined;
const fault = Promise.withResolvers<never>();
void fault.promise.catch(() => {});
function fail(error: unknown) {
  first ??= error;
  try { firstFailure(join(artifactRoot, "first-failure.txt"), first); } catch {}
  fault.reject(first);
}
function census() {
  if (!worker?.pid || !fixture) return;
  const workerRecord = processFields(worker.pid);
  if (workerRecord && !known.has(worker.pid)) known.set(worker.pid, { pid: workerRecord.pid, ppid: workerRecord.ppid,
    pgid: workerRecord.pgid, startTicks: workerRecord.startTicks, role: "worker" });
  const pids = readdirSync("/proc").filter(name => /^\d+$/.test(name));
  assert.ok(pids.length <= 8192, "Process census bound exceeded");
  const supervisorPath = join(process.cwd(), "src/service/supervisor-host.ts");
  const runnerPath = join(process.cwd(), "src/service/supervisor-runner.ts");
  const config = resolve("tests/proof/fixture-profiles.mts");
  for (const name of pids) {
    const item = processFields(Number(name));
    if (!item || known.has(item.pid)) continue;
    const supervisor = item.ppid === worker.pid && item.argv[1] === supervisorPath;
    const runner = known.get(item.ppid)?.role === "supervisor" && item.argv[1] === runnerPath;
    if (!supervisor && !runner) continue;
    assert.deepEqual(item.argv.slice(2), [config, fixture.env.BIRBCREW_STATE_DIR]);
    assert.ok(known.size < 64, "Known process bound exceeded");
    const record: ProcessIdentity = { pid: item.pid, ppid: item.ppid, pgid: item.pgid, startTicks: item.startTicks,
      role: supervisor ? "supervisor" : "runner" };
    known.set(item.pid, record);
    event("owned-process-observed", record);
  }
}
const server = createServer((request, response) => {
  const id = ++requestCount;
  if (requestCount > 64) { fail(new Error("Collector request count bound")); response.destroy(); return; }
  let received = 0;
  const chunks: Buffer[] = [];
  request.on("error", fail);
  response.on("error", fail);
  request.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > 1024 * 1024) { fail(new Error("Collector request byte bound")); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/traces");
      assert.equal(request.headers["content-encoding"], undefined);
      assert.match(String(request.headers["content-type"]), /^application\/json/);
      const bytes = Buffer.concat(chunks);
      totalRequestBytes += bytes.length;
      assert.ok(totalRequestBytes <= 4 * 1024 * 1024, "Total raw collector evidence bound");
      writeFileSync(join(artifactRoot, `collector-request-${id}.json`), bytes, { mode: 0o600, flag: "wx" });
      const spans = requestSchema.parse(JSON.parse(bytes.toString("utf8"))).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)).map(identity);
      event("collector-request-complete", { id, bytes: received, sha256: createHash("sha256").update(bytes).digest("hex"), spans });
      const target = spans.filter(span => span.name === "tool.settle" && span.requestId === hostileRequestId);
      const control = spans.filter(span => span.name === "tool.settle" && span.requestId === healthyRequestId);
      for (const span of [...control, ...target]) {
        assert.equal(span.conversationId, conversationId);
        assert.equal(span.engine, "pi");
        assert.equal(span.status, 1);
        assert.equal(span.traceId, createHash("sha256").update(conversationId + "/" + span.requestId).digest("hex").slice(0, 32));
      }
      healthySeen += control.length;
      assert.ok(healthySeen <= 1, "One healthy worker settlement span");
      if (!target.length) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
        event("collector-healthy-response", { id });
        return;
      }
      assert.equal(target.length, 1);
      assert.equal(++hostileSeen, 1, "One hostile worker settlement span");
      assert.equal(healthySeen, 1, "Healthy control precedes shutdown case");
      assert.equal(shutdown, undefined);
      assert.ok(worker?.pid && worker.exitCode === null && worker.signalCode === null);
      response.on("close", () => {
        clearInterval(responseTimer);
        responseClosedAt = now();
        event("target-response-close", { id, writableEnded: response.writableEnded, bytesSent: targetResponseBytes });
      });
      request.socket.once("close", hadError => {
        socketClosedAt = now();
        event("target-socket-close", { id, hadError });
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
      response.write(" ");
      targetResponseBytes++;
      const responseStartedAt = now();
      trickleTimes.push(responseStartedAt);
      responseTimer = setInterval(() => {
        if (!response.destroyed) {
          response.write(" "); targetResponseBytes++;
          trickleTimes.push(now());
          if (trickleTimes.length > 64) fail(new Error("Trickle lifetime exceeded the probe bound"));
        }
      }, 250);
      shutdown = { responseStartedAt, sentAt: now(), count: 1 };
      assert.equal(worker.kill("SIGTERM"), true, "Exactly one SIGTERM to the live worker PID");
      shutdownTimer = setTimeout(() => fail(new Error("Actual worker did not close within 15 seconds of SIGTERM")), 15_000);
      event("worker-sigterm", { pid: worker.pid, responseId: id, responseStartToSignalMs: shutdown.sentAt - responseStartedAt });
    } catch (error) { fail(error); response.destroy(); }
  });
});
server.on("error", fail);
let workerClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }> | undefined;
let log: ReturnType<typeof durableLog> | undefined;
const turnClients: { child: ChildProcess; result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> }[] = [];
function startTurn(env: NodeJS.ProcessEnv, input: object) {
  const child = spawn(process.execPath, ["src/service/cli.ts", "turn"], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", total = 0;
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > 128 * 1024) fail(new Error("Turn CLI output bound exceeded"));
    else if (stream === child.stdout) stdout += chunk.toString("utf8");
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout }));
  });
  child.stdin.end(JSON.stringify(input));
  const client = { child, result };
  turnClients.push(client);
  return client;
}
try {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); done(); }); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  fixture = await services("pi", "otlp-worker");
  const s = fixture;
  await s.startTemporal();
  const traceFile = join(s.directory, "worker-traces.jsonl");
  log = durableLog(join(artifactRoot, "actual-worker.log"), 1024 * 1024);
  worker = spawn(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"], {
    env: { ...s.env, BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`, BIRBCREW_TRACE_FILE: traceFile },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const targetWorker = worker;
  assert.ok(targetWorker.stdout && targetWorker.stderr);
  targetWorker.once("error", fail);
  targetWorker.stdout.on("error", fail);
  targetWorker.stderr.on("error", fail);
  targetWorker.stdout.on("data", (chunk: Buffer) => log!.append(chunk));
  targetWorker.stderr.on("data", (chunk: Buffer) => {
    log!.append(chunk);
    warningBytes += chunk.length;
    if (warningBytes > 1024 * 1024) fail(new Error("Worker stderr bound exceeded"));
    else warningText += chunk.toString("utf8");
    if (warningObservedAt === undefined && warningText.includes("birbcrew: OTLP trace export failed")) {
      warningObservedAt = now();
      event("worker-export-warning-observed");
    }
  });
  workerClosed = new Promise(resolve => targetWorker.once("close", (code, signal) => {
    clearTimeout(shutdownTimer);
    const outcome = { code, signal, at: now() };
    event("worker-close", { ...outcome, beforeEmergencyCleanup: !cleanupStarted });
    if (!shutdown || code !== 0 || signal !== null) fail(new Error("Unexpected actual worker exit " + JSON.stringify(outcome)));
    resolve(outcome);
  }));
  targetWorker.once("exit", (code, signal) => event("worker-exit", { code, signal, beforeEmergencyCleanup: !cleanupStarted }));
  censusTimer = setInterval(() => { try { census(); } catch (error) { fail(error); } }, 50);
  const body = async () => {
    await until(async () => {
      try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE engine='pi' AND name='fixture.approval.v1'") === "1" || undefined; }
      catch { return undefined; }
    }, "real worker profile registration");
    await until(async () => { census(); return [...known.values()].filter(item => item.role === "supervisor").length === 1 || undefined; }, "owned supervisor identity", 10_000);
    const { create, command } = commands(s);
    const member = await create("pi", "fixture.approval.v1");
    const key = await member.open();
    conversationId = key.conversationId;
    healthyRequestId = randomUUID();
    hostileRequestId = randomUUID();
    async function approval(requestId: string) {
      const turn = startTurn(s.env, { ...key, requestId, text: "record " + requestId });
      const card = await until(async () => pendingSchema.parse(await command("pending", key)).find(item => item.requestId === requestId), "real Pi protected approval");
      assert.equal(card.toolName, "record_work_item");
      assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${conversationId}' AND request_id='${requestId}'`), "0");
      await command("decide", decision(card, "approve"));
      await until(async () => await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${conversationId}' AND request_id='${requestId}'`) === "1" || undefined, "one protected effect");
      if (requestId === healthyRequestId) {
        const result = await before(turn.result, now() + 60_000, "Healthy CLI turn completion");
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.match(z.object({ text: z.string() }).parse(JSON.parse(result.stdout)).text, /^settled /);
      }
      event("approved-effect", { requestId, effects: 1, completionRequired: requestId === healthyRequestId });
    }
    await approval(healthyRequestId);
    await until(async () => healthySeen === 1 || undefined, "healthy actual-worker OTLP settlement", 10_000);
    assert.equal(shutdown, undefined);
    assert.ok(!warningText.includes("birbcrew: OTLP trace export failed"), "Healthy control has no export warning");
    await approval(hostileRequestId);
    const exitControl = await until<Shutdown>(async () => shutdown, "hostile actual-worker OTLP response", 10_000);
    const exited = await before(workerClosed!, exitControl.sentAt + 15_000, "Unforced actual CLI worker lifetime");
    assert.equal(exited.code, 0);
    assert.equal(exited.signal, null);
    assert.equal(exitControl.count, 1);
    assert.ok(exited.at - exitControl.sentAt <= 15_000);
    await until(async () => responseClosedAt !== undefined && socketClosedAt !== undefined || undefined, "peer closes target response and socket", 1000);
    assert.ok(responseClosedAt !== undefined && socketClosedAt !== undefined);
    assert.ok(responseClosedAt - exitControl.responseStartedAt < 15_000);
    assert.ok(targetResponseBytes > 1 && targetResponseBytes <= 64, "Tiny trickle exercises deadline, never response cap");
    const tickBoundaries = [...trickleTimes, responseClosedAt];
    const maximumTrickleGapMs = Math.max(...tickBoundaries.slice(1).map((time, index) => time - tickBoundaries[index]));
    assert.ok(maximumTrickleGapMs < 1500, "Continuous trickle stays below the exporter 2000ms inactivity timeout");
    event("target-trickle-timing", { offsetsMs: trickleTimes.map(time => time - exitControl.responseStartedAt), maximumTrickleGapMs });
    const warnings = warningText.match(/^birbcrew: OTLP trace export failed .*$/gm) ?? [];
    assert.equal(warnings.length, 1);
    assert.ok(warningObservedAt !== undefined && warningObservedAt >= exitControl.responseStartedAt && warningObservedAt <= exited.at);
    assert.match(warnings[0], /\(timeout\)/);
    assert.ok(!/uncaught|unhandled|SDK supervisor stopped/i.test(warningText));
    clearInterval(censusTimer);
    const identities = [...known.values()];
    assert.equal(identities.filter(item => item.role === "worker").length, 1);
    assert.equal(identities.filter(item => item.role === "supervisor").length, 1);
    for (const item of identities) {
      const current = processFields(item.pid);
      assert.ok(!current || current.startTicks !== item.startTicks, `Observed ${item.role} remains alive`);
    }
    for (const pgid of new Set(identities.map(item => item.pgid))) assert.ok(groupAbsent(pgid), `Observed owned process group ${pgid} remains`);
    event("observed-owned-processes-absent", { identities, beforeEmergencyCleanup: !cleanupStarted });
    assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${conversationId}'`), "2");
    assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.native_launches WHERE conversation_id='${conversationId}' AND NOT stopped`), "0");
    assert.ok(statSync(traceFile).size <= 1024 * 1024);
    const traces = traceSchema.parse(readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    for (const requestId of [healthyRequestId, hostileRequestId]) {
      const settle = traces.filter(span => span.name === "tool.settle" && span.attributes.requestId === requestId);
      assert.equal(settle.length, 1);
      assert.equal(settle[0].status, 1);
    }
    save("sanitized-traces.json", traces.map(span => ({ name: span.name, traceId: span.traceId, spanId: span.spanId, status: span.status, attributes: span.attributes })));
    save("qualification.json", { status: "passed", actualWorker: { code: exited.code, signal: exited.signal, signalCount: exitControl.count,
      signalToCloseMs: exited.at - exitControl.sentAt, unforced: true }, response: { bytesSent: targetResponseBytes,
      startToCloseMs: responseClosedAt - exitControl.responseStartedAt, maximumTrickleGapMs, socketClosed: true }, healthySeen, hostileSeen,
      effectsPerRequest: [1, 1], warnings, observedProcesses: identities, observedGroupsAbsentBeforeCleanup: true,
      supervisorDisconnect: "source-supported inference from real worker return, not an independently observed IPC event or supervisor exit code",
      flushReturnTimestamp: "not observed; process exit does not establish a separate flush-return timestamp",
      ancestry: "only observed owned PID identities and groups checked; unobserved descendants remain hosted VM responsibility" });
  };
  await before(Promise.race([body(), fault.promise]), origin + 240_000, "Whole worker qualification");
} catch (error) { fail(error); }
finally {
  cleanupStarted = true;
  clearInterval(censusTimer);
  clearInterval(responseTimer);
  clearTimeout(shutdownTimer);
  event("emergency-cleanup-start", { qualificationFailed: first !== undefined });
  if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
    event("emergency-worker-sigkill", { pid: worker.pid });
    first ??= new Error("Worker required emergency SIGKILL");
    try { process.kill(-worker.pid, "SIGKILL"); } catch (error) { first ??= error; }
    if (workerClosed) try { await before(workerClosed, now() + 2_000, "Emergency worker close"); } catch (error) { first ??= error; }
  }
  for (const { child, result } of turnClients) {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        event("controller-turn-client-cleanup", { pid: child.pid });
        process.kill(-child.pid, "SIGKILL");
      }
      await before(result, now() + 2_000, "Turn client cleanup");
    } catch (error) { first ??= error; }
  }
  server.closeAllConnections();
  try { await before(new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())), now() + 2_000, "Collector close"); }
  catch (error) { first ??= error; }
  try { await fixture?.close(); } catch (error) { first ??= error; }
  try { if (log) save("worker-log-metadata.json", log.close()); } catch (error) { first ??= error; }
  save("probe-outcome.json", { status: first === undefined ? "passed" : "failed", error: first === undefined ? undefined : describe(first),
    qualificationArtifactIsProvisionalUntilThisOutcomeAndPostVerificationPass: true });
  if (first !== undefined) { firstFailure(join(artifactRoot, "first-failure.txt"), first); process.exitCode = 1; }
}
