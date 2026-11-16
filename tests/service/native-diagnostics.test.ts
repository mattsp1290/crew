import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { Thread, type ThreadEvent } from "@openai/codex-sdk";
import { errorSummary, forwardWarnings, redact, relayWarning, warn } from "../../src/service/diagnostics.ts";
import { runCodexTurn } from "../../src/service/codex.ts";
import { MemberStore } from "../../src/service/store.ts";

const plantedJwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJwbGFudGVkIn0.cGxhbnRlZA";
const plantedKey = "sk-proj-" + "Q".repeat(48);

function launch() {
  return { ownerId: "owner", conversationId: randomUUID(), requestId: randomUUID(), text: "hello", token: randomUUID(),
    execution: { workflowRunId: randomUUID(), activityId: "1", attempt: 1 } };
}

test("redaction removes token-shaped text and keeps the rest readable", () => {
  const id = randomUUID();
  const text = `Error: Read-only file system (os error 30) for ${id}\nAuthorization: Bearer ${plantedKey} token=${plantedKey.slice(0, 20)} ` +
    `{"refresh_token":"rt_abc"} jwt ${plantedJwt} cut ${plantedJwt.slice(0, 30)} other aaaaaaaa1.bbbbbbbb2.cccccccc3`;
  const line = redact(text, 4096);
  for (const secret of [plantedKey, plantedKey.slice(0, 20), "rt_abc", plantedJwt, plantedJwt.slice(0, 30), "aaaaaaaa1.bbbbbbbb2"]) {
    assert.ok(!line.includes(secret), secret);
  }
  assert.ok(line.startsWith(`Error: Read-only file system (os error 30) for ${id} Authorization: [redacted]`));
  assert.equal(redact("Error: Read-only file system (os error 30) at auth.json.lock"), "Error: Read-only file system (os error 30) at auth.json.lock");
  assert.ok(!line.includes("\n"));
  assert.equal(redact("x".repeat(20) + " " + "y".repeat(20), 10), "xxxxxxxxxx…");
  assert.equal(redact("WARNING: first\nWARNING: second\nError: Read-only file system (os error 30)\n", 42, "end"),
    "…Error: Read-only file system (os error 30)");
  assert.equal(redact(`Bearer ${plantedKey}\nError: stopped`, 14, "end"), "…Error: stopped");
  assert.equal(redact("connect ECONNREFUSED postgres://birbcrew:hunter2@db.internal:5432/crew"),
    "connect ECONNREFUSED postgres://birbcrew:[redacted]@db.internal:5432/crew");
  assert.equal(redact(String.raw`body {\"access_token\":\"shortsecret\"}`), String.raw`body {\"access_token\":\"[redacted]\"}`);
  assert.equal(redact(String.raw`password=ab\cd key=\\server\share {"password":"ab\/cd+ef"}`),
    'password=[redacted] key=[redacted] {"password":"[redacted]"}');
});

test("redaction scans a bounded part of a huge text and drops a token cut at its edge", () => {
  // Longer text is cut at 16384 characters. Either cut leaves 24 characters of the secret, too few to look like a token.
  const secret = "opaque0123456789".repeat(4).slice(0, 60);
  const start = redact("w ".repeat(8180) + secret + " after", 100_000);
  const end = redact("before " + secret + " w".repeat(8180), 100_000, "end");
  for (const kept of [start, end]) assert.ok(!kept.includes("opaque") && kept.length > 16_000);
  // One long word used to cost quadratic time: five seconds for 60 thousand characters.
  const began = performance.now();
  assert.equal(redact("a".repeat(100_000), 300), "");
  assert.equal(redact("a".repeat(30) + ".b ".repeat(5000), 12), "aaaaaaaaaaaa…");
  assert.ok(performance.now() - began < 2000);
});

function capturedWarnings(t: TestContext) {
  const lines: string[] = [];
  forwardWarnings((line) => { lines.push(line); });
  t.after(() => forwardWarnings(() => {}));
  return lines;
}

test("logging a failure never throws, whatever was caught", (t) => {
  const lines = capturedWarnings(t);
  const caught = [
    Object.assign(new Error("x"), { message: 42 }),
    Object.assign(new Error("x"), { name: { toString() { throw new Error("no name"); } } }),
    Object.create(Error.prototype, { message: { get() { throw new Error("no message"); } } }),
    undefined, null, "text", 10n,
  ];
  assert.deepEqual(caught.map(errorSummary), [{ error: "Error", message: "42" }, { error: "unreadable error" }, { error: "unreadable error" },
    { error: "undefined" }, { error: "object" }, { error: "string" }, { error: "bigint" }]);
  for (const error of caught) warn("native_turn_failed", errorSummary(error));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  warn("native_turn_failed", { level: "error", event: "forged", logger: "forged", big: 10n, circular, reason: "kept" } as never);
  forwardWarnings(() => { throw new Error("the channel to the supervisor host is closed"); });
  warn("native_turn_failed", { reason: "dropped" });
  assert.equal(lines.length, caught.length + 1);
  assert.deepEqual(JSON.parse(lines.at(-1)!), { level: "warn", logger: "birbcrew", event: "native_turn_failed", reason: "kept" });
});

test("the supervisor host cleans a runner's warning again and names its turn", (t) => {
  const lines = capturedWarnings(t);
  const turn = { conversationId: randomUUID(), requestId: randomUUID() };
  relayWarning(JSON.stringify({ level: "error", logger: "forged", event: "codex_signin_unavailable", reason: "exited", exitCode: 1,
    stderr: `first line\n{"level":"warn","event":"forged"} Bearer ${plantedKey}`, conversationId: "forged", nested: { token: plantedKey },
    [plantedJwt]: 1, "two words": 2 }), turn);
  const refused = ["not JSON", "null", "[]", '"text"', JSON.stringify({ event: "Not an event" }), JSON.stringify({ event: "long", pad: "y".repeat(9000) }),
    `{"event":"split"}\n{"event":"forged"}`];
  for (const line of refused) relayWarning(line, turn);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "exited",
    exitCode: 1, stderr: 'first line {"level":"warn","event":"forged"} Bearer [redacted]', ...turn }]);
  assert.ok(lines.every((line) => !line.includes("\n") && !line.includes(plantedKey) && !line.includes(plantedJwt)));
});

async function failingProfiles(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "birb-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "profiles.mjs");
  await writeFile(config, `throw new Error(${JSON.stringify("Profiles unavailable with Bearer " + plantedJwt + " key=" + plantedKey)});\n`);
  return { dir, config };
}

test("a failed turn runner sends its cause to the supervisor host with tokens removed and keeps its reply", { timeout: 30_000 }, async (t) => {
  const { dir, config } = await failingProfiles(t);
  const runner = fork(new URL("../../src/service/supervisor-runner.ts", import.meta.url), [config, dir], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    env: { ...process.env, BIRBCREW_DATABASE_URL: "postgresql://birbcrew:unused@127.0.0.1:1/unused" },
  });
  t.after(() => { if (runner.exitCode === null) runner.kill("SIGKILL"); });
  const messages: unknown[] = [];
  runner.on("message", (message) => messages.push(message));
  const closed = once(runner, "close");
  const turn = launch();
  runner.send({ launch: turn, conversation: {}, runId: turn.requestId, threadId: turn.conversationId, text: turn.text, checkpoint: null });
  await closed;
  assert.equal(messages.length, 2);
  const [forwarded, reply] = messages as [{ warning: string }, unknown];
  assert.deepEqual(reply, { error: "Native SDK turn failed" });
  assert.deepEqual(Object.keys(forwarded), ["warning"]);
  assert.ok(!forwarded.warning.includes(plantedJwt) && !forwarded.warning.includes(plantedKey));
  assert.deepEqual(JSON.parse(forwarded.warning), { level: "warn", logger: "birbcrew", event: "native_turn_failed",
    conversationId: turn.conversationId, requestId: turn.requestId, error: "Error",
    message: "Profiles unavailable with Bearer [redacted] key=[redacted]" });
});

// Answers every startup with a PostgreSQL error that names the user, as a real server does.
async function refusingPostgres(t: TestContext, message: string) {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const fields = ["SFATAL", "VFATAL", "C28P01", "M" + message].map((field) => Buffer.from(field + "\0"));
      const body = Buffer.concat([...fields, Buffer.from([0])]);
      const header = Buffer.alloc(5);
      header.write("E", 0);
      header.writeInt32BE(body.length + 4, 1);
      socket.end(Buffer.concat([header, body]));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("the supervisor host logs why a turn was denied, with tokens removed, and keeps its reply", { timeout: 30_000 }, async (t) => {
  const { dir, config } = await failingProfiles(t);
  const port = await refusingPostgres(t, `password authentication failed for user "${plantedJwt}"`);
  const host = fork(new URL("../../src/service/supervisor-host.ts", import.meta.url), [config, dir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
    env: { ...process.env, BIRBCREW_DATABASE_URL: `postgresql://birbcrew:unused@127.0.0.1:${port}/unused` },
  });
  t.after(() => { if (host.exitCode === null) host.kill("SIGKILL"); });
  let stderr = "";
  host.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  assert.equal((await once(host, "message"))[0], "ready");
  const id = randomUUID(), turn = launch();
  host.send({ id, action: "start", launch: turn });
  assert.deepEqual((await once(host, "message"))[0], { id, ok: false, error: "Native turn denied or outcome uncertain" });
  // A parent's disconnect() leaves "close" unemitted, so wait for the exit and the end of stderr.
  const exited = Promise.all([once(host, "exit"), once(host.stderr!, "close")]);
  host.disconnect();
  await exited;
  assert.ok(!stderr.includes(plantedJwt));
  assert.deepEqual(stderr.trim().split("\n").map((line) => JSON.parse(line)), [{ level: "warn", logger: "birbcrew",
    event: "native_turn_unconfirmed", action: "start", conversationId: turn.conversationId, requestId: turn.requestId,
    error: "error", code: "28P01", message: 'password authentication failed for user "[redacted]"' }]);
});

const database = process.env.BIRBCREW_TEST_DATABASE_URL;
const needsDatabase = !database &&
  "needs a disposable PostgreSQL database in BIRBCREW_TEST_DATABASE_URL; the integration API workflow runs this case";

/** Runs one admitted Codex turn through a real supervisor host and returns its answer and what it wrote on stderr. */
async function hostTurn(t: TestContext, dir: string, profiles: (name: string) => string) {
  const state = join(dir, "state"), scratch = join(dir, "tmp"), config = join(dir, "profiles.mjs");
  for (const path of [state, scratch]) await mkdir(path, { mode: 0o700 });
  const profile = "diagnostics-" + randomUUID();
  await writeFile(config, profiles(profile));
  const pool = new Pool({ connectionString: database });
  t.after(() => pool.end());
  const store = new MemberStore(pool);
  await store.migrate();
  const ownerId = randomUUID(), conversationId = randomUUID();
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "codex", profile });
  await store.openConversation({ ownerId, memberId, conversationId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "hello" };
  const execution = { workflowRunId: randomUUID(), activityId: "1", attempt: 1 };
  const claim = await store.beginTurn(request, execution);
  assert.equal(claim.kind, "start");

  const host = fork(new URL("../../src/service/supervisor-host.ts", import.meta.url), [config, state], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
    env: { ...process.env, BIRBCREW_DATABASE_URL: database, TMPDIR: scratch },
  });
  t.after(() => { if (host.exitCode === null) host.kill("SIGKILL"); });
  let stderr = "";
  host.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  assert.equal((await once(host, "message"))[0], "ready");
  const id = randomUUID();
  host.send({ id, action: "start", launch: { ...request, token: claim.token, execution } });
  assert.deepEqual((await once(host, "message"))[0], { id, ok: false, error: "Native turn denied or outcome uncertain" });
  const exited = Promise.all([once(host, "exit"), once(host.stderr!, "close")]);
  host.disconnect();
  await exited;
  const logged = stderr.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { stderr, logged, scratch, turn: { conversationId, requestId: request.requestId } };
}

test("a Codex sign-in failure reaches the worker's stderr through the turn runner and the supervisor host",
  { timeout: 60_000, skip: needsDatabase }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "sign-in");
  await mkdir(home, { mode: 0o700 });
  const accountId = randomUUID();
  const exp = Math.floor(Date.now() / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (kind: string) => [encode({ alg: "none", typ: "JWT" }),
    encode({ exp, kind, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } }), "eA"].join(".");
  const tokens = { account_id: accountId, id_token: token("id"), access_token: token("access"), refresh_token: "planted-refresh-" + randomUUID() };
  await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(), tokens }), { mode: 0o600 });
  const reader = new URL("../../src/service/codex-subscription.ts", import.meta.url).href;
  // The closed loopback endpoint keeps a turn off the network if the sign-in check ever lets this login through.
  const { stderr, logged, scratch, turn } = await hostTurn(t, dir, (profile) => `import { readCodexSubscription } from ${JSON.stringify(reader)};
export const profiles = new Map([[${JSON.stringify(profile)}, { accountId: ${JSON.stringify(accountId)}, codex: { model: "gpt-5.4",
  baseUrl: "http://127.0.0.1:1/closed", authorize: async () => {},
  subscription: () => readCodexSubscription(${JSON.stringify(home)}, ${JSON.stringify(accountId)}) } }]]);\n`);
  const signInRequired = "A current ChatGPT Codex sign-in for the approved account is required";
  assert.deepEqual(logged, [
    { level: "warn", logger: "birbcrew", event: "codex_signin_unavailable", reason: "expired", expiredAt: new Date(exp * 1000).toISOString(), ...turn },
    { level: "warn", logger: "birbcrew", event: "native_turn_failed", ...turn, error: "CodexSignInError", reason: "expired", message: signInRequired },
    { level: "warn", logger: "birbcrew", event: "native_turn_unconfirmed", action: "start", ...turn,
      error: "Error", message: "Native runner reported a failed turn" },
  ]);
  for (const secret of [tokens.id_token, tokens.access_token, tokens.refresh_token]) {
    assert.ok(!stderr.includes(secret), "the worker's stderr contains a token");
  }
  assert.deepEqual(await readdir(scratch), []);
});

test("a turn runner that dies without a reply is logged with how it ended", { timeout: 60_000, skip: needsDatabase }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { logged, turn } = await hostTurn(t, dir, () => "process.exit(7);\n");
  assert.deepEqual(logged, [{ level: "warn", logger: "birbcrew", event: "native_turn_unconfirmed", action: "start", ...turn,
    error: "Error", message: "SDK process stopped without a confirmed result (exit code 7, no reply)" }]);
});

const nativeFailureMessage = `Connection failed: error sending request Bearer ${plantedKey}`;
const nativeFailureEvents = [
  { type: "error", message: nativeFailureMessage },
  { type: "turn.failed", error: { message: nativeFailureMessage } },
] satisfies ThreadEvent[];

for (const event of nativeFailureEvents) {
  test(`a Codex ${event.type} reaches worker diagnostics without changing its public failure`,
    { timeout: 60_000, skip: needsDatabase }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "birb-diagnostics-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const sdk = import.meta.resolve("@openai/codex-sdk");
    const { stderr, logged, scratch } = await hostTurn(t, dir, (profile) => `import { Thread } from ${JSON.stringify(sdk)};
Thread.prototype.runStreamed = async () => ({ events: (async function* () { yield ${JSON.stringify(event)}; })() });
export const profiles = new Map([[${JSON.stringify(profile)}, { accountId: ${JSON.stringify(randomUUID())},
  codex: { model: "fixture", baseUrl: "http://127.0.0.1:1/closed" } }]]);\n`);
    const failed = logged.find((line) => line.event === "native_turn_failed");
    assert.ok(failed, "the real runner emits its native failure warning");
    assert.ok(Object.values(failed).some((value) => typeof value === "string" && value.includes("Connection failed: error sending request")),
      `the warning retains the readable native cause: ${JSON.stringify(failed)}`);
    assert.ok(Object.values(failed).includes(event.type), "the warning retains the SDK event type");
    assert.equal(failed.message, "Codex native turn failed");
    assert.ok(!stderr.includes(plantedKey), "the native diagnostic removes the planted token");
    assert.ok(Object.values(failed).every((value) => typeof value !== "string" || value.length <= 1025), "diagnostic strings stay bounded");
    assert.deepEqual(await readdir(scratch), []);
  });
}

async function syntheticCodexFailure(t: TestContext, event: ThreadEvent) {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-diagnostics-adapter-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  t.mock.method(Thread.prototype, "runStreamed", async () => ({ events: (async function* () { yield event; })() }));
  const text: string[] = [];
  let failure: Error | undefined;
  await assert.rejects(runCodexTurn({ threadId: randomUUID(), runId: randomUUID(), text: "hello", checkpoint: null,
    signal: t.signal, onText: (delta) => { text.push(delta); } },
  { ownerId: randomUUID(), memberId: randomUUID(), stateDir, model: "fixture", baseUrl: "http://127.0.0.1:1/closed" }),
  (error) => {
    assert.ok(error instanceof Error);
    assert.equal(String(error), "Error: Codex native turn failed");
    assert.equal(error.cause, undefined);
    failure = error;
    return true;
  });
  assert.deepEqual(text, []);
  assert.ok(failure);
  return failure;
}

test("a Codex failure retains only a bounded redacted prefix before the runner summarizes it", async (t) => {
  const message = "Connection failed: " + "detail ".repeat(4) + plantedKey + " " + "later context ".repeat(2000);
  const event = { type: "turn.failed", error: { message } } satisfies ThreadEvent;
  const failure = await syntheticCodexFailure(t, event);
  const reason: unknown = Reflect.get(failure, "reason");
  assert.equal(typeof reason, "string");
  assert.ok(typeof reason === "string" && reason.startsWith("Connection failed: ") && reason.length <= 65);
  assert.ok(!JSON.stringify(failure).includes(plantedKey.slice(0, 16)), "retention never cuts a raw credential");
  assert.ok(!JSON.stringify(failure).includes("later context"), "the adapter does not retain the full provider message");
  assert.ok(Object.values(failure).every(value => value !== event && value !== event.error && value !== message));
  assert.doesNotMatch(String(failure), /Connection failed|detail|sk-proj/);
});

test("malformed Codex messages omit diagnostic reasons without coercing provider values", async (t) => {
  let coerced = false;
  const event = { type: "error", message: "unused" } satisfies ThreadEvent;
  Object.defineProperty(event, "message", { value: { toString() { coerced = true; throw new Error("must not coerce"); } } });
  const failure = await syntheticCodexFailure(t, event);
  assert.equal(coerced, false);
  assert.equal(errorSummary(failure).reason, undefined);
});

test("an absent nested Codex failure message preserves the fixed failure", async (t) => {
  const event = { type: "turn.failed", error: { message: "unused" } } satisfies ThreadEvent;
  Object.defineProperty(event, "error", { value: null });
  const failure = await syntheticCodexFailure(t, event);
  assert.equal(errorSummary(failure).reason, undefined);
});

test("an unreadable Codex message cannot replace the original failure", async (t) => {
  const event = { type: "error", get message(): string { throw new Error("provider read failed " + plantedKey); } } satisfies ThreadEvent;
  const failure = await syntheticCodexFailure(t, event);
  assert.equal(errorSummary(failure).reason, undefined);
  assert.doesNotMatch(JSON.stringify(failure), /provider read failed|sk-proj/);
});

test("a Codex message with no usable redacted text omits the reason", async (t) => {
  const failure = await syntheticCodexFailure(t, { type: "turn.failed", error: { message: " \n\u200b " } });
  assert.equal(errorSummary(failure).reason, undefined);
});
