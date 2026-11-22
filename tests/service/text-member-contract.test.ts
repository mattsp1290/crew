import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { forwardWarnings } from "../../src/service/diagnostics.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { childTargetSchema } from "../../src/service/child-target.ts";
import { controlScopeSchema } from "../../src/service/delegation-control.ts";
import { ownerInitiator, type Engine } from "../../src/service/domain.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { HandoffApi } from "../../src/service/handoffs.ts";
import { MemoryApi } from "../../src/service/memories.ts";
import type { MemberProfile } from "../../src/service/profiles.ts";
import { MemberStore } from "../../src/service/store.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { migrateThrough, testDatabaseName } from "./database-fixtures.ts";
import { TrustedContextStore } from "../../src/service/trusted-context.ts";

const run = promisify(execFile);
const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
before(() => store.migrate());
after(() => pool.end());

async function spawned(engine: Engine, extra: { instructions?: string; instructionPacks?: string[] } = {}) {
  return store.spawn({ ownerId: randomUUID(), requestId: randomUUID(), engine, profile: `${engine}.v1`, ...extra });
}

test("migration 042 applies once", async () => {
  await store.migrate();
  const { rows } = await pool.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version = 42");
  assert.deepEqual(rows, [{ version: 42 }]);
});

test("text-engine profiles store no volume and claude still requires one", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "text-profile-")));
  const cwd = directory;
  const accountId = "text fixture";
  const cursor: MemberProfile = { accountId, cursor: { model: "composer-2", apiKey: "cursor-secret", cwd } };
  const opencode: MemberProfile = {
    accountId, opencode: { model: "provider/model", executable: join(cwd, "opencode"), cwd, account: "ACCOUNT LABEL", env: {} },
  };
  const claude: MemberProfile = {
    accountId, claude: { model: "claude-sonnet-4-6", apiKey: "synthetic", baseUrl: "https://api.anthropic.com" } as MemberProfile["claude"],
  };
  const badEnv: MemberProfile = {
    accountId, opencode: { model: "provider/model", executable: join(cwd, "opencode"), cwd, account: "ACCOUNT LABEL", env: { "NOT VALID": "x" } },
  };
  await assert.rejects(registerProfiles(pool, new Map([["text-bad-env.v1", badEnv]]), directory), /opencode\.env/);
  await registerProfiles(pool, new Map([["text-cursor.v1", cursor], ["text-opencode.v1", opencode], ["text-claude.v1", claude]]), directory);
  const { rows } = await pool.query<{ name: string; volume: string | null }>(
    "SELECT name, volume FROM birbcrew_ts.profiles WHERE name LIKE 'text-%' ORDER BY name");
  assert.deepEqual(rows.map((row) => [row.name, row.volume === null]), [
    ["text-claude.v1", false], ["text-cursor.v1", true], ["text-opencode.v1", true],
  ]);
  await assert.rejects(registerProfiles(pool, new Map([["text-cursor.v1", { ...cursor, delegateTask: true }]]), directory),
    /Profile "text-cursor.v1" refuses delegateTask/);
  await assert.rejects(registerProfiles(pool, new Map([["text-cursor.v1", { ...cursor, capabilities: { version: 1, webSearch: {} } }]]), directory),
    (error: Error) => error.message === 'Profile "text-cursor.v1" refuses capabilities' && !error.message.includes("cursor-secret"));
  await rm(directory, { recursive: true, force: true });
});

test("text engines refuse instructions and packs and open with one turn", async () => {
  for (const engine of ["cursor", "opencode"] as const) {
    const member = await spawned(engine);
    assert.equal(member.engine, engine);
    const ownerId = randomUUID();
    await assert.rejects(store.spawn({ ownerId, requestId: randomUUID(), engine, profile: `${engine}.v1`, instructions: "do this" }),
      { code: "instructions_limit" });
    await assert.rejects(store.spawn({
      ownerId, requestId: randomUUID(), engine, profile: `${engine}.v1`, instructionPacks: [randomUUID()],
    }), { code: "instructions_limit" });
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id = $1", [ownerId])).rowCount, 0);
    const conversationId = randomUUID();
    await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
    const { rows: [row] } = await pool.query<{ turn_limit: number }>("SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id = $1", [conversationId]);
    assert.equal(row.turn_limit, 1);
  }
  const pi = await spawned("pi");
  const conversationId = randomUUID();
  await store.openConversation({ ownerId: pi.ownerId, memberId: pi.memberId, conversationId });
  const { rows: [row] } = await pool.query<{ turn_limit: number }>("SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id = $1", [conversationId]);
  assert.equal(row.turn_limit, 128);
});

test("a text engine refuses an active memory and captured project notes", async () => {
  const member = await spawned("cursor");
  await new MemoryApi(store).create(member.ownerId, { requestId: randomUUID(), memberId: member.memberId, text: "remember this" });
  const conversationId = randomUUID();
  await assert.rejects(store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId }), { code: "instructions_limit" });
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id = $1", [conversationId])).rowCount, 0);

  const noted = await spawned("opencode");
  const root = await realpath(await mkdtemp(join(tmpdir(), "text-notes-")));
  const hub = join(root, "hub");
  await mkdir(hub);
  const git = (...args: string[]) => run("git", ["-C", hub, "-c", "user.email=text@example.com", "-c", "user.name=text", ...args]);
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "init");
  const bn = ["--hub", hub, "--branch", "main", "--actor", "coworker", "--no-sync", "--no-fetch"];
  await run("bn", [...bn, "project", "create", "release"]);
  await run("bn", [...bn, "--project", "release", "remember", "--key", "cedar", "remember cedar"]);
  const installations = join(root, "installations.json");
  await writeFile(installations, JSON.stringify({ [noted.ownerId]: { root, project: "release", actor: "coworker" } }));
  const previous = process.env.BIRBCREW_NOTE_INSTALLATIONS;
  process.env.BIRBCREW_NOTE_INSTALLATIONS = installations;
  const notedConversation = randomUUID();
  try {
    await assert.rejects(store.openConversation({ ownerId: noted.ownerId, memberId: noted.memberId, conversationId: notedConversation }),
      { code: "instructions_limit" });
  } finally {
    if (previous === undefined) delete process.env.BIRBCREW_NOTE_INSTALLATIONS;
    else process.env.BIRBCREW_NOTE_INSTALLATIONS = previous;
    await rm(root, { recursive: true, force: true });
  }
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id = $1", [notedConversation])).rowCount, 0);
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.member_memories WHERE member_id = $1", [noted.memberId])).rows[0].count, "0");
});

test("a text engine admits one request and a pi conversation without a usage budget still admits", async () => {
  const member = await spawned("cursor");
  const conversationId = randomUUID();
  await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
  const first = { ownerId: member.ownerId, conversationId, requestId: randomUUID(), text: "one" };
  const second = { ...first, requestId: randomUUID(), text: "two" };
  const settled = await Promise.allSettled([store.recordAcceptance(first, ownerInitiator), store.recordAcceptance(second, ownerInitiator)]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = settled.find((entry) => entry.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.equal(rejected.reason.code, "input_limit");
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.request_admissions WHERE conversation_id = $1", [conversationId])).rows[0].count, "1");
  await assert.rejects(store.checkAdmission({ ...first, requestId: randomUUID(), text: "three" }), { code: "input_limit" });

  const pi = await spawned("pi");
  const piConversation = randomUUID();
  await store.openConversation({ ownerId: pi.ownerId, memberId: pi.memberId, conversationId: piConversation });
  await store.checkAdmission({ ownerId: pi.ownerId, conversationId: piConversation, requestId: randomUUID(), text: "pi" });
  await store.recordAcceptance({ ownerId: pi.ownerId, conversationId: piConversation, requestId: randomUUID(), text: "pi" }, ownerInitiator);
  await store.checkAdmission({ ownerId: pi.ownerId, conversationId: piConversation, requestId: randomUUID(), text: "again" });
});

test("an opencode slash prompt is refused before it takes the only turn", async () => {
  const member = await spawned("opencode");
  const conversationId = randomUUID();
  await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
  const rejected = { ownerId: member.ownerId, conversationId, requestId: randomUUID(), text: "/remember cedar" };
  await assert.rejects(store.checkAdmission(rejected), { code: "conflict" });
  await assert.rejects(store.recordAcceptance(rejected, ownerInitiator), { code: "conflict" });
  const hidden = { ...rejected, requestId: randomUUID(), text: "remember\n/cedar" };
  await assert.rejects(store.recordAcceptance(hidden, ownerInitiator), { code: "conflict" });
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.request_admissions WHERE conversation_id = $1", [conversationId])).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id = $1", [conversationId])).rows[0].count, "0");
  await store.recordAcceptance({ ...rejected, requestId: randomUUID(), text: "remember cedar" }, ownerInitiator);
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.request_admissions WHERE conversation_id = $1", [conversationId])).rows[0].count, "1");
});

test("a cursor conversation cannot open a trusted session", async () => {
  const member = await spawned("cursor");
  const conversationId = randomUUID();
  await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
  const trusted = new TrustedContextStore(pool, { id: "text-member", tools: [], async authorize() { return true; } });
  await assert.rejects(trusted.open(
    { ownerId: member.ownerId, conversationId },
    { scope: "scope", version: "v1", text: "context" },
  ), { code: "denied" });
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.trusted_sessions WHERE conversation_id = $1", [conversationId])).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM birbcrew_ts.trusted_requests WHERE conversation_id = $1", [conversationId])).rows[0].count, "0");
});

test("the database rejects a turn limit of 1 on pi and 128 on cursor", async () => {
  const pi = await spawned("pi");
  const cursor = await spawned("cursor");
  const piConversation = randomUUID();
  const cursorConversation = randomUUID();
  await store.openConversation({ ownerId: pi.ownerId, memberId: pi.memberId, conversationId: piConversation });
  await store.openConversation({ ownerId: cursor.ownerId, memberId: cursor.memberId, conversationId: cursorConversation });
  await assert.rejects(pool.query(
    "INSERT INTO birbcrew_ts.conversations (owner_id, member_id, conversation_id, turn_limit) VALUES ($1, $2, $3, 1)",
    [pi.ownerId, pi.memberId, randomUUID()]), (error: { code: string }) => error.code === "23514");
  await assert.rejects(pool.query("UPDATE birbcrew_ts.conversations SET turn_limit = 128 WHERE conversation_id = $1", [cursorConversation]),
    (error: { code: string }) => error.code === "23514");
  const { rows } = await pool.query<{ turn_limit: number }>("SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id = $1", [cursorConversation]);
  assert.equal(rows[0].turn_limit, 1);
  assert.equal(piConversation.length > 0, true);
});

test("handoffs, child targets, and delegation control reject text engines", async () => {
  const cursor = await spawned("cursor");
  const opencode = await spawned("opencode");
  const pi = await spawned("pi");
  const source = randomUUID();
  await store.openConversation({ ownerId: cursor.ownerId, memberId: cursor.memberId, conversationId: source });
  const piSource = randomUUID();
  await store.openConversation({ ownerId: pi.ownerId, memberId: pi.memberId, conversationId: piSource });
  const api = new HandoffApi(store, {
    open: async () => { throw new Error("opened"); },
    accept: async () => { throw new Error("accepted"); },
  });
  await assert.rejects(api.create(cursor.ownerId, source, { requestId: randomUUID(), memberId: pi.memberId }), { code: "conflict" });
  const target = await store.spawn({ ownerId: pi.ownerId, requestId: randomUUID(), engine: "opencode", profile: "opencode.v1" });
  await assert.rejects(api.create(pi.ownerId, piSource, { requestId: randomUUID(), memberId: target.memberId }), { code: "conflict" });
  await assert.rejects(api.create(opencode.ownerId, randomUUID(), { requestId: randomUUID(), memberId: opencode.memberId }), { code: "not_found" });
  assert.equal(childTargetSchema.safeParse({ engine: "cursor", profile: "text-cursor.v1" }).success, false);
  assert.equal(controlScopeSchema.safeParse({ kind: "target", engine: "cursor", profile: "text-cursor.v1" }).success, false);
});

/** A separate database migrated through `version`, with one native turn running; dropped after the test. */
async function runningTurnAt(t: TestContext, version: number) {
  const source = new URL(url!);
  const admin = new Pool({ connectionString: source.href });
  const database = testDatabaseName("text_members_");
  await admin.query("CREATE DATABASE " + database);
  source.pathname = "/" + database;
  const upgraded = new Pool({ connectionString: source.href });
  t.after(async () => {
    try { await upgraded.end(); await admin.query("DROP DATABASE " + database); }
    finally { await admin.end(); }
  });
  await upgraded.query("CREATE SCHEMA birbcrew_ts");
  await upgraded.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  const current = new MemberStore(upgraded);
  await migrateThrough(current, version);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") throw new Error("no turn");
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  const launch = { ownerId, conversationId, requestId, text, token: start.token, execution };
  return { upgraded, current, launch };
}
const engineCheck = "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='members_engine_check'";
const applied42 = "SELECT count(*)::integer AS n FROM birbcrew_ts.schema_versions WHERE version=42";

// 042 widens CHECKs on members and conversations, which needs ACCESS EXCLUSIVE, and a running native
// turn's admission holds ACCESS SHARE on members. Unlike 025-041, it therefore waits for running native
// turns: it retries without queueing, applies once they end, and fails closed at its deadline.
test("migration 042 waits for a running native turn without queueing and applies once the turn ends", async (t) => {
  const { upgraded, current, launch } = await runningTurnAt(t, 41);
  const before = (await upgraded.query(engineCheck)).rows[0].def;
  let migrating: Promise<void> | undefined;
  let migrated = false;
  await withNativeAdmission(upgraded, launch, AbortSignal.timeout(30_000), async () => {
    migrating = current.migrate().then(() => { migrated = true; });
    await delay(1_500);
    assert.equal(migrated, false, "042 waits while a native turn holds its admission");
    assert.equal((await upgraded.query(applied42)).rows[0].n, 0);
    assert.equal((await upgraded.query(engineCheck)).rows[0].def, before, "nothing is visible while it waits");
    // It retries with NOWAIT, so the running turn and other sessions are never queued behind it.
    await current.appendText({ ownerId: launch.ownerId, conversationId: launch.conversationId, requestId: launch.requestId, token: launch.token },
      launch.requestId + "/assistant", 0, "still running");
  });
  assert.equal(await Promise.race([migrating!.then(() => true), delay(10_000, false)]), true, "042 applies once the turn ends");
  assert.equal((await upgraded.query(applied42)).rows[0].n, 1);
  assert.match((await upgraded.query(engineCheck)).rows[0].def, /cursor.*opencode/);
});

test("migration 042 fails closed with 55P03 and applies nothing when a native turn outlasts its deadline", async (t) => {
  const { upgraded, launch } = await runningTurnAt(t, 41);
  const before = (await upgraded.query(engineCheck)).rows[0].def;
  const source = await readFile(new URL("../../src/service/sql/042-text-members.sql", import.meta.url), "utf8");
  assert.equal(source.split("interval '200 seconds'").length, 2, "042 has one deadline");
  // The same SQL with a one-second deadline, so the test need not wait 200 seconds.
  const shortened = source.replace("interval '200 seconds'", "interval '1 second'");
  await withNativeAdmission(upgraded, launch, AbortSignal.timeout(30_000), async () => {
    const db = await upgraded.connect();
    try {
      await db.query("BEGIN");
      await assert.rejects(db.query(shortened), { code: "55P03" });
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  });
  assert.equal((await upgraded.query(applied42)).rows[0].n, 0);
  assert.equal((await upgraded.query(engineCheck)).rows[0].def, before);
});

test("migration 043 preserves registrations and fails atomically on a held profile lock", async t => {
  const { upgraded, current } = await runningTurnAt(t, 42);
  await upgraded.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest)
    VALUES ('historical','cursor',decode(repeat('ab',32),'hex'))`);
  const before = (await upgraded.query("SELECT to_jsonb(p) AS profile FROM birbcrew_ts.profiles p WHERE name='historical'")).rows[0].profile;
  const lock = await upgraded.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE birbcrew_ts.profiles IN ACCESS SHARE MODE");
    await assert.rejects(current.migrate(), { code: "55P03" });
    assert.equal((await upgraded.query("SELECT 1 FROM birbcrew_ts.schema_versions WHERE version=43")).rowCount, 0);
    assert.deepEqual((await upgraded.query("SELECT to_jsonb(p) AS profile FROM birbcrew_ts.profiles p WHERE name='historical'")).rows[0].profile, before);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  await current.migrate();
  await current.migrate();
  const after = (await upgraded.query("SELECT to_jsonb(p) AS profile FROM birbcrew_ts.profiles p WHERE name='historical'")).rows[0].profile;
  assert.deepEqual(after, { ...before, request_text_bytes: 16_384 });
  await assert.rejects(upgraded.query("UPDATE birbcrew_ts.profiles SET request_text_bytes=32768 WHERE name='historical'"));
});

test("immutable text policy is shared by preflight, locked admission, restart and discovery", async t => {
  const diagnosticLines: string[] = [];
  forwardWarnings(line => diagnosticLines.push(line));
  t.after(() => forwardWarnings(line => { writeSync(2, line + "\n"); }));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "text-policy-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { IntegrationApi } = await import("../../src/service/integration-api.ts");
  const { MemberClient } = await import("../../src/service/client.ts");
  const { Client } = await import("@temporalio/client");
  const api = new IntegrationApi(store, new MemberClient(store, new Client()));
  for (const engine of ["cursor", "opencode"] as const) {
    const profile: MemberProfile = { accountId: "policy-fixture", ...(engine === "cursor"
      ? { cursor: { model: "composer-2", apiKey: "marker-secret", cwd: directory } }
      : { opencode: { model: "provider/model", executable: join(directory, "opencode"), cwd: directory, account: "account", env: {} } }) };
    const name = `policy-${engine}-${randomUUID()}`;
    for (const requestTextBytes of [0, 16_383, 65_537, 1.5]) {
      await assert.rejects(registerProfiles(pool, new Map([[name, { ...profile, requestTextBytes }]]), directory),
        (error: Error) => error.message.includes("requestTextBytes") && !error.message.includes("marker-secret"));
    }
    await registerProfiles(pool, new Map([[name, profile]]), directory);
    await registerProfiles(pool, new Map([[name, { ...profile, requestTextBytes: 16_384 }]]), directory);
    await assert.rejects(registerProfiles(pool, new Map([[name, { ...profile, requestTextBytes: 65_536 }]]), directory),
      (error: Error) => error.message.includes(name) && error.message.includes("requestTextBytes") && error.message.includes("new profile name") && !error.message.includes("marker-secret"));
    for (const n of [16_384, 32_768, 65_536]) {
      const wideName = `${name}-${n}`;
      await registerProfiles(pool, new Map([[wideName, { ...profile, requestTextBytes: n }]]), directory);
      const member = await store.spawn({ ownerId: randomUUID(), requestId: randomUUID(), engine, profile: wideName });
      const listing = await api.listMembers(member.ownerId, {});
      assert.equal(listing.members.find(m => m.memberId === member.memberId)?.requestTextBytes, n);
      assert.equal((await api.listMembers(randomUUID(), {})).members.some(m => m.memberId === member.memberId), false);
      const conversationId = randomUUID();
      await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
      const request = { ownerId: member.ownerId, conversationId, requestId: randomUUID(), text: "é".repeat(n / 2) };
      const restarted = new MemberStore(pool);
      await assert.rejects(restarted.checkAdmission({ ...request, text: "private-input-marker" + "x".repeat(n) }), { name: "ZodError" });
      const diagnosticCount = diagnosticLines.length;
      await assert.rejects(restarted.checkAdmission({ ...request, text: "\0" }), { name: "ZodError" });
      assert.equal(diagnosticLines.length, diagnosticCount, "malformed text has no size-refusal diagnostic");
      await assert.rejects(restarted.recordAcceptance({ ...request, text: request.text + "x" }, ownerInitiator), { name: "ZodError" });
      assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.request_admissions WHERE conversation_id=$1", [conversationId])).rowCount, 0);
      assert.deepEqual(await restarted.checkAdmission(request), request);
      await restarted.recordAcceptance(request, ownerInitiator);
      assert.deepEqual(await restarted.checkAdmission(request), request);
      for (const text of ["different", "x".repeat(n + 1), "x".repeat(65_537)]) {
        await assert.rejects(restarted.checkAdmission({ ...request, text }), { code: "conflict" });
      }
      await assert.rejects(restarted.checkAdmission({ ...request, text: "\0" }), { name: "ZodError" });
      await assert.rejects(restarted.checkAdmission({ ...request, ownerId: randomUUID() }), { code: "not_found" });
    }
  }
  assert.ok(diagnosticLines.some(line => line.includes('"event":"request_text_refused"') && line.includes('"limit":65536')));
  assert.equal(diagnosticLines.join("\n").includes("private-input-marker"), false);
  await assert.rejects(registerProfiles(pool, new Map([["native-policy", { accountId: "native", requestTextBytes: 16_384 }]]), directory), /requestTextBytes/);
});
