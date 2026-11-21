import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
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
