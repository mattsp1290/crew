import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { MemberStore } from "../../src/service/store.ts";
import { publishObservation } from "../../src/service/observation.ts";
import { ChildStore } from "../../src/service/children.ts";
const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
before(() => store.migrate());
after(() => pool.end());
const account = "a".repeat(64);
const destination = { engine: "pi", profile: "race-target", model: "race-model", providerHost: "fixture.invalid", accountDigest: account };
const seal = { mode: "named", roles: { analyst: destination } };
const register = (db: PoolClient, name: string, legacy = false) => db.query(`INSERT INTO birbcrew_ts.profiles
 (name,engine,account_digest,delegate_task,child_target_seal,child_target_active)
 VALUES($1,'pi',decode($2,'hex'),true,$3,$4) ON CONFLICT DO NOTHING`, [name, account, legacy ? { mode: "legacy" } : seal, legacy ? [] : ["analyst"]]);
const spawn = (db: PoolClient, name: string) => db.query(`INSERT INTO birbcrew_ts.members(owner_id,spawn_request_id,engine,profile)
 VALUES('racer',$1,'pi',$2) ON CONFLICT DO NOTHING RETURNING child_target_consent`, [randomUUID(), name]);
async function blocked(pid: number) {
 for (let attempt = 0; attempt < 200; attempt++) {
  const { rows: [row] } = await pool.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [pid]);
  if (row.wait_event_type === "Lock" && row.wait_event === "advisory") return;
  await delay(10);
 }
 throw new Error("Contender did not wait on authority lock");
}
async function race(first: (db: PoolClient) => Promise<unknown>, second: (db: PoolClient) => Promise<unknown>, rejects = false) {
 const a = await pool.connect(), b = await pool.connect();
 try {
  const { rows: [{ pid }] } = await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await a.query("BEGIN"); await first(a);
  const result = second(b).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  await blocked(pid); await a.query("COMMIT");
  const outcome = await result;
  assert.equal(outcome.ok, !rejects, !outcome.ok ? String(outcome.error) : "unexpected success");
  return outcome;
 } finally { await a.query("ROLLBACK"); a.release(); b.release(); }
}
test("production triggers serialize first registration, direct spawns, old registrars and monotonic removal", async () => {
 await pool.query("INSERT INTO birbcrew_ts.profiles(name,engine,account_digest) VALUES('race-target','pi',decode($1,'hex'))", [account]);
 let name = randomUUID();
 await race(db => register(db, name), db => spawn(db, name));
 assert.deepEqual((await pool.query("SELECT child_target_consent FROM birbcrew_ts.members WHERE profile=$1", [name])).rows[0].child_target_consent, seal);
 name = randomUUID(); await race(db => spawn(db, name), db => register(db, name), true);
 assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.profiles WHERE name=$1", [name])).rowCount, 0);
 name = randomUUID(); await race(db => register(db, name), db => db.query("INSERT INTO birbcrew_ts.profiles(name,engine,account_digest) VALUES($1,'pi',decode($2,'hex')) ON CONFLICT DO NOTHING", [name, account]));
 assert.deepEqual((await pool.query("SELECT child_target_seal FROM birbcrew_ts.profiles WHERE name=$1", [name])).rows[0].child_target_seal, seal);
 name = randomUUID(); await race(db => register(db, name, true), db => spawn(db, name));
 assert.deepEqual((await pool.query("SELECT child_target_consent FROM birbcrew_ts.members WHERE profile=$1", [name])).rows[0].child_target_consent, { mode: "legacy" });
 for (const removalFirst of [true, false]) {
  name = randomUUID(); const db = await pool.connect(); try { await register(db, name); } finally { db.release(); }
  const remove = (db: PoolClient) => db.query("UPDATE birbcrew_ts.profiles SET child_target_active='{}' WHERE name=$1", [name]);
  if (removalFirst) await race(remove, db => spawn(db, name)); else await race(db => spawn(db, name), remove);
  assert.deepEqual((await pool.query("SELECT child_target_consent FROM birbcrew_ts.members WHERE profile=$1", [name])).rows[0].child_target_consent,
   removalFirst ? { mode: "named", roles: {} } : seal);
 }
 for (const removalFirst of [true, false]) {
  name = randomUUID(); const db = await pool.connect(); try { await register(db, name); } finally { db.release(); }
  const member = await store.spawn({ ownerId: "race-child", requestId: randomUUID(), engine: "pi", profile: name });
  const conversationId = randomUUID(), requestId = randomUUID();
  await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
  await store.beginTurn({ ownerId: member.ownerId, conversationId, requestId, text: "delegate" });
  await pool.query("INSERT INTO birbcrew_ts.delegations VALUES($1,$2,$3,NULL)", [conversationId, requestId, { version: 1, engine: "pi", state: {} }]);
  const insert = (db: PoolClient) => db.query(`INSERT INTO birbcrew_ts.pi_children(conversation_id,request_id,native_call_id,ordinal,task,role_profile)
   VALUES($1,$2,'race-call',0,'private',$3)`, [conversationId, requestId, { role: "analyst", version: 1, ...fixedRoles.analyst, model: destination.model, target: { version: 1, ...destination } }]);
  const remove = (db: PoolClient) => db.query("UPDATE birbcrew_ts.profiles SET child_target_active='{}' WHERE name=$1", [name]);
  if (removalFirst) await race(remove, insert, true); else await race(insert, remove);
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.pi_children WHERE request_id=$1", [requestId])).rowCount, removalFirst ? 0 : 1);
 }
});

test("037 refuses busy native tables within its actual acquisition bound, then upgrades historical targets without inventing consent", { timeout: 90_000 }, async () => {
 const name = "crew_targets_upgrade_" + randomUUID().replaceAll("-", "");
 await pool.query(`CREATE DATABASE ${name}`);
 const upgradeUrl = new URL(url!); upgradeUrl.pathname = "/" + name;
 const upgrade = new Pool({ connectionString: upgradeUrl.toString() });
 try {
  await upgrade.query("CREATE SCHEMA birbcrew_ts; CREATE TABLE birbcrew_ts.schema_versions(version integer PRIMARY KEY)");
  const directory = new URL("../../src/service/sql/", import.meta.url);
  for (const filename of (await readdir(directory)).filter(file => /^\d+.*\.sql$/.test(file) && Number(file.slice(0, 3)) < 37).sort()) {
   await upgrade.query(await readFile(new URL(filename, directory), "utf8"));
   await upgrade.query("INSERT INTO birbcrew_ts.schema_versions VALUES($1)", [Number(filename.slice(0, 3))]);
  }
  const ownerId = "historical-owner", memberId = randomUUID(), conversationId = randomUUID(), requestId = randomUUID();
  await upgrade.query("INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,delegate_task) VALUES('historical','pi',decode($1,'hex'),true)", [account]);
  await upgrade.query("INSERT INTO birbcrew_ts.members(member_id,owner_id,spawn_request_id,engine,profile) VALUES($1,$2,$3,'pi','historical')", [memberId, ownerId, randomUUID()]);
  await upgrade.query("INSERT INTO birbcrew_ts.conversations(conversation_id,owner_id,member_id) VALUES($1,$2,$3)", [conversationId, ownerId, memberId]);
  await upgrade.query("INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,attempt,phase) VALUES($1,$2,1,decode($3,'hex'),1,'started')", [conversationId, requestId, account]);
  await upgrade.query("INSERT INTO birbcrew_ts.delegations(conversation_id,request_id,parent_checkpoint) VALUES($1,$2,$3)", [conversationId, requestId, { version: 1, engine: "pi", state: {} }]);
  const profile = { role: "analyst", version: 1, ...fixedRoles.analyst, model: "old-model", target: { engine: "pi", profile: "historical" } };
  const { rows: [{ child_id: childId }] } = await upgrade.query("INSERT INTO birbcrew_ts.pi_children(conversation_id,request_id,native_call_id,ordinal,task,role_profile) VALUES($1,$2,'old-call',0,'old-task',$3) RETURNING child_id", [conversationId, requestId, profile]);
  await new MemberStore(upgrade).transaction(db => publishObservation(db, conversationId, { kind: "delegation", requestId, children: [{ childId, role: "analyst" }] }));
  const held = await upgrade.connect();
  try {
   await held.query("BEGIN"); await held.query("SELECT 1 FROM birbcrew_ts.pi_children j FOR SHARE OF j");
   const start = performance.now();
   await assert.rejects(new MemberStore(upgrade).migrate(), { code: "55P03" });
   assert.ok(performance.now() - start >= 59_000 && performance.now() - start < 75_000);
   assert.equal((await held.query("SELECT 1 FROM information_schema.columns WHERE table_schema='birbcrew_ts' AND column_name='child_target_seal'")).rowCount, 0);
  } finally { await held.query("ROLLBACK"); held.release(); }
  await new MemberStore(upgrade).migrate();
  assert.deepEqual((await upgrade.query("SELECT child_target_consent FROM birbcrew_ts.members WHERE member_id=$1", [memberId])).rows[0].child_target_consent, { mode: "legacy" });
  assert.deepEqual((await upgrade.query("SELECT role_profile FROM birbcrew_ts.pi_children WHERE child_id=$1", [childId])).rows[0].role_profile, profile);
  const childStore = new ChildStore(upgrade), key = { ownerId, memberId, conversationId, requestId, childId };
  await assert.rejects(childStore.target(key), /invalid_target/);
  await assert.rejects(upgrade.query("UPDATE birbcrew_ts.pi_children SET role_profile=role_profile-'target' WHERE child_id=$1", [childId]), { code: "23514" });
  assert.equal((await childStore.finish(key, null, null, true)).kind, "failed");
 } finally { await upgrade.end(); await pool.query(`DROP DATABASE ${name}`); }
});
