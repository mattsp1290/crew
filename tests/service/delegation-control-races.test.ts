import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { after, before, test, type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { MemberStore } from "../../src/service/store.ts";
import { lockChildAdmission } from "../../src/service/supervisor-child.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL 17 database.");
const pool = new Pool({ connectionString: url, max: 8, application_name: "delegation-control-sql-first",
  statement_timeout: 15_000, lock_timeout: 10_000 });
const checkpoint = { version: 1, engine: "pi", state: {} };
const digest = "a".repeat(64);
const historical = { memberId: randomUUID(), conversationId: randomUUID(), requestId: randomUUID(), childId: randomUUID() };
const scopeSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("global") }), z.object({ kind: z.literal("target"),
  engine: z.enum(["pi", "claude", "codex"]), profile: z.string() })]);
const receiptSchema = z.object({ commandId: z.uuid(), installationId: z.uuid(), instanceId: z.uuid(),
  revision: z.string(), scope: scopeSchema, enabled: z.boolean() });
type Db = Pool | PoolClient;
type Scope = z.infer<typeof scopeSchema>;
type ProofObservation =
  | { kind: "lock_wait"; case: string; waiter: number; holder: number; wait_event_type: string | null; wait_event: string | null; blockers: number[] }
  | { kind: "admission"; case: string; oldAdmissionRows: number | null; freshAdmissionRows: number | null; reservations: number | null }
  | { kind: "command_return"; receipt: z.infer<typeof receiptSchema> }
  | { kind: "write_refused"; boundary: string; code: string }
  | { kind: "effect_order"; disableFirst: boolean; committedEffects: number | null }
  | { kind: "cohort"; expectedSelected: string[]; actualSelected: string[]; excludedChild: string };
const observations: Array<ProofObservation & { observedAt: string }> = [];
function record(observation: ProofObservation) { observations.push({ observedAt: new Date().toISOString(), ...observation }); }
before(async () => {
  const version = z.object({ server_version_num: z.string() }).parse((await pool.query("SHOW server_version_num")).rows[0]);
  assert.equal(Math.floor(Number(version.server_version_num) / 10000), 17, "This proof requires PostgreSQL 17");
  assert.equal((await pool.query("SELECT to_regnamespace('birbcrew_ts') IS NULL AS empty")).rows[0].empty, true,
    "The migration-history proof requires a fresh disposable database");
  await pool.query("CREATE SCHEMA birbcrew_ts; CREATE TABLE birbcrew_ts.schema_versions(version integer PRIMARY KEY)");
  const directory = new URL("../../src/service/sql/", import.meta.url);
  for (const filename of (await readdir(directory)).filter(file => /^\d+.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 36).sort()) {
    await pool.query(await readFile(new URL(filename, directory), "utf8"));
    await pool.query("INSERT INTO birbcrew_ts.schema_versions VALUES($1)", [Number(filename.slice(0, 3))]);
  }
  await pool.query("INSERT INTO birbcrew_ts.members(member_id,owner_id,spawn_request_id,engine,profile) VALUES($1,'historical-proof',$2,'pi','legacy-proof')",
    [historical.memberId, randomUUID()]);
  await pool.query("INSERT INTO birbcrew_ts.conversations(conversation_id,owner_id,member_id) VALUES($1,'historical-proof',$2)", [historical.conversationId, historical.memberId]);
  await pool.query(`INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,attempt,phase)
    VALUES($1,$2,1,decode($3,'hex'),1,'started')`, [historical.conversationId, historical.requestId, digest]);
  await pool.query("INSERT INTO birbcrew_ts.delegations(conversation_id,request_id,parent_checkpoint) VALUES($1,$2,$3)", [historical.conversationId, historical.requestId, checkpoint]);
  await pool.query(`INSERT INTO birbcrew_ts.pi_children(child_id,conversation_id,request_id,native_call_id,ordinal,task,role_profile)
    VALUES($1,$2,$3,'historical',0,'historical task',$4)`, [historical.childId, historical.conversationId, historical.requestId,
    { role: "analyst", version: 1, ...fixedRoles.analyst, model: "old-model", target: { engine: "pi", profile: "unsealed-history" } }]);
  await new MemberStore(pool).migrate();
});
after(async () => {
  await pool.end();
  const directory = process.env.BIRBCREW_CONTROL_PROOF_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "sql-first-observations.json"), JSON.stringify({ scope: "SQL-only; no runner or provider invoked by harness", observations }, null, 2) + "\n");
  }
});
async function revision(db: Db = pool) {
  return z.object({ revision: z.string() }).parse((await db.query("SELECT revision::text FROM birbcrew_ts.delegation_control WHERE singleton")).rows[0]).revision;
}
async function change(scope: Scope, enabled = false, db: Db = pool, command = randomUUID(), expected?: string) {
  const result = await db.query("SELECT birbcrew_ts.change_delegation_control($1,$2,$3,$4,$5,$6) AS receipt",
    [command, expected ?? await revision(db), scope, enabled, "sql-first-proof", "isolated PostgreSQL race"]);
  const receipt = receiptSchema.parse(result.rows[0].receipt);
  record({ kind: "command_return", receipt });
  return receipt;
}
async function sessions(body: (a: PoolClient, b: PoolClient) => Promise<void>) {
  const a = await pool.connect(), b = await pool.connect();
  try { await body(a, b); }
  finally {
    await Promise.all([a.query("ROLLBACK"), b.query("ROLLBACK")]);
    a.release(); b.release();
  }
}
async function pid(db: PoolClient) {
  return z.object({ pid: z.number() }).parse((await db.query("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
}
async function blocked(db: PoolClient, blocker: PoolClient, t: TestContext) {
  const waiter = await pidFromCache(db), holder = await pidFromCache(blocker);
  const until = performance.now() + 5_000;
  while (performance.now() < until) {
    const state = z.object({ wait_event_type: z.string().nullable(), wait_event: z.string().nullable(), blockers: z.array(z.number()) })
      .parse((await pool.query("SELECT wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [waiter])).rows[0]);
    if (state.wait_event_type === "Lock" && state.blockers.includes(holder)) {
      record({ kind: "lock_wait", case: t.name, waiter, holder, ...state });
      t.diagnostic(JSON.stringify({ waiter, holder, ...state }));
      return;
    }
    await setImmediate();
  }
  assert.fail(`Backend ${waiter} did not wait for backend ${holder}`);
}
const pids = new WeakMap<PoolClient, number>();
async function pidFromCache(db: PoolClient) {
  const value = pids.get(db);
  if (value === undefined) throw new Error("Register connection before starting its blocked statement");
  return value;
}
async function begin(db: PoolClient) { pids.set(db, await pid(db)); await db.query("BEGIN"); }
function observed<T>(promise: Promise<T>) {
  return promise.then(value => ({ kind: "value", value } satisfies { kind: "value"; value: T }),
    (error: unknown) => ({ kind: "error", error } satisfies { kind: "error"; error: unknown }));
}
async function accepted<T>(result: ReturnType<typeof observed<T>>) {
  const outcome = await result;
  if (outcome.kind === "error") throw outcome.error;
  return outcome.value;
}
async function refused(result: ReturnType<typeof observed>) {
  const outcome = await result;
  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") assert.equal(z.object({ code: z.string() }).parse(outcome.error).code, "55000");
}

async function fixture(options: { sibling?: boolean; profile?: string; primaryRole?: "analyst" | "recorder" } = {}) {
  const primaryRole = options.primaryRole ?? "recorder";
  const ownerId = "control-" + randomUUID(), memberId = randomUUID(), conversationId = randomUUID(), requestId = randomUUID();
  const profile = options.profile ?? "control-" + randomUUID();
  const siblingProfile = "sibling-" + randomUUID();
  const parentProfile = "parent-" + randomUUID();
  const destination = (name: string) => ({ engine: "pi", profile: name, model: "proof-model", providerHost: "fixture.invalid", accountDigest: digest });
  for (const name of [profile, siblingProfile]) await pool.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,protected_tool)
    VALUES($1,'pi',decode($2,'hex'),'record_work_item') ON CONFLICT DO NOTHING`, [name, digest]);
  await pool.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,delegate_task,protected_tool,child_target_seal,child_target_active)
    VALUES($1,'pi',decode($2,'hex'),true,'record_work_item',$3,ARRAY['analyst','recorder'])`, [parentProfile, digest,
    { mode: "named", roles: { recorder: destination(options.sibling && primaryRole !== "recorder" ? siblingProfile : profile),
      analyst: destination(options.sibling && primaryRole !== "analyst" ? siblingProfile : profile) } }]);
  await pool.query("INSERT INTO birbcrew_ts.members(member_id,owner_id,spawn_request_id,engine,profile) VALUES($1,$2,$3,'pi',$4)",
    [memberId, ownerId, randomUUID(), parentProfile]);
  await pool.query("INSERT INTO birbcrew_ts.conversations(conversation_id,owner_id,member_id) VALUES($1,$2,$3)", [conversationId, ownerId, memberId]);
  await pool.query(`INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,attempt,phase)
    VALUES($1,$2,1,decode($3,'hex'),1,'started')`, [conversationId, requestId, digest]);
  await pool.query("INSERT INTO birbcrew_ts.delegations(conversation_id,request_id,parent_checkpoint) VALUES($1,$2,$3)", [conversationId, requestId, checkpoint]);
  const targetScope: Scope = { kind: "target", engine: "pi", profile };
  const roleProfile = (role: "analyst" | "recorder") => ({ role, version: 1, ...fixedRoles[role], model: "proof-model",
    target: { version: 1, ...destination(role !== primaryRole && options.sibling ? siblingProfile : profile) } });
  const insertChild = async (db: Db = pool, role: "analyst" | "recorder" = primaryRole) => {
    const childId = randomUUID();
    await db.query(`INSERT INTO birbcrew_ts.pi_children(child_id,conversation_id,request_id,native_call_id,ordinal,task,role_profile)
      VALUES($1,$2,$3,$4,$5,'proof task',$6)`, [childId, conversationId, requestId, "call-" + childId, role === primaryRole ? 0 : 1, roleProfile(role)]);
    return childId;
  };
  const childId = await insertChild();
  const key = { ownerId, memberId, conversationId, requestId, childId };
  const execution = { workflowRunId: randomUUID(), activityId: "child", attempt: 1 };
  const token = randomUUID();
  const launch = { ...key, token, execution, text: "proof task" };
  const start = (db: Db = pool) => db.query(`UPDATE birbcrew_ts.pi_children SET generation=$2,workflow_run_id=$3,activity_id=$4,attempt=1,phase='running'
    WHERE child_id=$1`, [childId, token, execution.workflowRunId, execution.activityId]);
  const reserve = (db: Db = pool, reservationToken = token, reservedChild: string | null = childId) => db.query(`INSERT INTO birbcrew_ts.native_launches
    (conversation_id,request_id,token,approval_id,receipt_digest,workflow_run_id,activity_id,attempt,child_id)
    VALUES($1,$2,$3,NULL,NULL,$4,$5,1,$6) ON CONFLICT(conversation_id,request_id,token) DO NOTHING`,
    [conversationId, requestId, reservationToken, execution.workflowRunId, execution.activityId, reservedChild]);
  const approvalId = randomUUID();
  const propose = (db: Db = pool, invocationId = childId, id = approvalId) => db.query(`INSERT INTO birbcrew_ts.deferred_calls
    (conversation_id,request_id,invocation_id,native_call_id,tool_name,arguments,argument_digest,policy_version,decision_version,approval_id)
    SELECT $1,$2,$3,'record','record_work_item',$4,$5,1,1,$6
    WHERE (SELECT count(*) FROM birbcrew_ts.deferred_calls WHERE conversation_id=$1 AND request_id=$2)<16
    RETURNING approval_id`, [conversationId, requestId, invocationId, { operation_id: requestId, note: "proof" }, digest, id]);
  const waiting = (db: Db = pool) => db.query(`UPDATE birbcrew_ts.pi_children SET phase='waiting',native_checkpoint=$2,approval_id=$3
    WHERE child_id=$1 AND phase='running' AND generation=$4`, [childId, checkpoint, approvalId, token]);
  const decide = (db: Db = pool) => db.query(`UPDATE birbcrew_ts.deferred_calls SET decision='approve',grant_scope=NULL WHERE approval_id=$1
    AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND expired_at IS NULL`, [approvalId]);
  const effect = (db: Db = pool, id = approvalId) => db.query(`INSERT INTO birbcrew_ts.work_items(conversation_id,request_id,approval_id,note)
    SELECT conversation_id,request_id,approval_id,arguments->>'note' FROM birbcrew_ts.deferred_calls
    WHERE approval_id=$1 AND decision='approve'
    AND (NOT $2::boolean OR EXISTS(SELECT 1 FROM birbcrew_ts.codex_live_calls l WHERE l.approval_id=$1 AND l.phase='dispatching'
      AND l.expires_at>clock_timestamp())) RETURNING receipt_id`, [id, false]);
  const finish = (db: Db = pool, success = true) => db.query("UPDATE birbcrew_ts.pi_children SET phase=$2,outcome=$3 WHERE child_id=$1",
    [childId, success ? "complete" : "failed", success ? { kind: "completed", nativeCallId: "call-" + childId, text: "done" }
      : { kind: "failed", nativeCallId: "call-" + childId, code: "child_failed" }]);
  return { ...key, profile, targetScope, launch, token, approvalId, start, reserve, propose, waiting, decide, effect, finish, insertChild };
}
async function lockConversation(db: PoolClient, conversationId: string) {
  await db.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
}
async function stopped(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3",
    [f.conversationId, f.requestId, f.token])).rowCount, 1);
}

async function freshAdmission(db: PoolClient, childId: string) {
  return db.query(`SELECT 1 FROM birbcrew_ts.pi_children j CROSS JOIN birbcrew_ts.delegation_control c
    WHERE j.child_id=$1 AND c.singleton AND c.global_enabled
      AND birbcrew_ts.delegation_child_scope(j.conversation_id,j.role_profile) IS NOT NULL
      AND NOT c.disabled_targets @> jsonb_build_array(birbcrew_ts.delegation_child_scope(j.conversation_id,j.role_profile))
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.delegation_control_children m WHERE m.child_id=j.child_id AND m.retire)
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.native_stop_requests s
        WHERE (s.conversation_id,s.request_id,s.token)=(j.conversation_id,j.request_id,j.generation))`, [childId]);
}

test("historical unreadable target joins a conservative disable cohort without inventing authority", async () => {
  const scope: Scope = { kind: "target", engine: "pi", profile: "unrelated-proof-target" };
  const receipt = await change(scope);
  assert.deepEqual((await pool.query(`SELECT m.retire,birbcrew_ts.delegation_child_scope(j.conversation_id,j.role_profile) AS target
    FROM birbcrew_ts.delegation_control_children m JOIN birbcrew_ts.pi_children j USING(child_id)
    WHERE m.command_id=$1 AND m.child_id=$2`, [receipt.commandId, historical.childId])).rows[0], { retire: true, target: null });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.pi_children SET generation=gen_random_uuid(),phase='running' WHERE child_id=$1", [historical.childId]), { code: "55000" });
  await pool.query("UPDATE birbcrew_ts.pi_children SET phase='failed',outcome=$2 WHERE child_id=$1", [historical.childId,
    { kind: "failed", nativeCallId: "historical", code: "child_failed" }]);
  await pool.query("UPDATE birbcrew_ts.delegations SET resume_activity_id='historical-followup' WHERE conversation_id=$1", [historical.conversationId]);
  await pool.query("UPDATE birbcrew_ts.turns SET phase='committed',reply='historical failure delivered',checkpoint=$2 WHERE conversation_id=$1", [historical.conversationId, checkpoint]);
});

test("native SHARE lease plus pinned waiting UPDATE permits disable stop publication, then refuses the stale writer", { timeout: 30_000 }, async t => {
  const f = await fixture(); await f.start(); await f.propose(); await f.reserve();
  await sessions(async (native, writer) => {
    await begin(native); assert.equal((await lockChildAdmission(native, f.launch)).rowCount, 1);
    await begin(writer); await lockConversation(writer, f.conversationId);
    const pending = observed(f.waiting(writer));
    await blocked(writer, native, t);
    const receipt = await change(f.targetScope);
    await stopped(f);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.delegation_control_children WHERE command_id=$1 AND child_id=$2 AND retire",
      [receipt.commandId, f.childId])).rowCount, 1);
    await native.query("COMMIT"); await refused(pending);
    t.diagnostic("The SQL harness invokes no runner or provider. Native execution remains a separate proof gate.");
  });
});

test("pinned proposal INSERT waits for child before control, so native lease cannot prevent disable", { timeout: 30_000 }, async t => {
  const f = await fixture(); await f.start(); await f.reserve();
  await sessions(async (native, writer) => {
    await begin(native); await lockChildAdmission(native, f.launch);
    await begin(writer); await lockConversation(writer, f.conversationId);
    const pending = observed(f.propose(writer));
    await blocked(writer, native, t);
    await change(f.targetScope); await stopped(f);
    await native.query("COMMIT"); await refused(pending);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.deferred_calls WHERE approval_id=$1", [f.approvalId])).rowCount, 0);
  });
});

test("old admission SELECT begun behind a rolling-back writer keeps stale stop visibility; separate post-lease read refuses", { timeout: 30_000 }, async t => {
  const f = await fixture(); await f.start(); await f.reserve();
  await sessions(async (writer, native) => {
    await begin(writer);
    await writer.query("UPDATE birbcrew_ts.pi_children SET task=task WHERE child_id=$1", [f.childId]);
    await begin(native);
    const pending = observed(lockChildAdmission(native, f.launch));
    await blocked(native, writer, t);
    await change(f.targetScope); await stopped(f);
    await writer.query("ROLLBACK");
    const old = await accepted(pending), fresh = await freshAdmission(native, f.childId);
    const reservations = (await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [f.childId])).rowCount;
    record({ kind: "admission", case: t.name, oldAdmissionRows: old.rowCount, freshAdmissionRows: fresh.rowCount, reservations });
    t.diagnostic(JSON.stringify({ oldAdmissionRows: old.rowCount, freshAdmissionRows: fresh.rowCount, reservations }));
    assert.equal(old.rowCount, 1, "Pinned old SELECT is not the new final-admission guarantee");
    assert.equal(fresh.rowCount, 0);
  });
});

test("generation guard takes a fresh policy snapshot after waiting for disable; reverse order captures the committed generation", { timeout: 45_000 }, async t => {
  for (const disableFirst of [true, false]) {
    const f = await fixture();
    await sessions(async (a, b) => {
      await begin(a); await begin(b);
      if (disableFirst) {
        await change(f.targetScope, false, a);
        const pending = observed(f.start(b)); await blocked(b, a, t);
        await a.query("COMMIT"); await refused(pending);
        assert.equal((await pool.query("SELECT generation FROM birbcrew_ts.pi_children WHERE child_id=$1", [f.childId])).rows[0].generation, null);
      } else {
        await lockConversation(a, f.conversationId); await f.start(a);
        const pending = observed(change(f.targetScope, false, b)); await blocked(b, a, t);
        await a.query("COMMIT"); await accepted(pending); await b.query("COMMIT"); await stopped(f);
      }
    });
  }
});

test("actual work-item INSERT independently fences a stale approved read in both commit orders and preserves committed receipts", { timeout: 45_000 }, async t => {
  for (const disableFirst of [true, false]) {
    const f = await fixture(); await f.start(); await f.propose(); await f.waiting(); await f.decide();
    await sessions(async (effect, setter) => {
      await begin(effect); await lockConversation(effect, f.conversationId);
      assert.equal((await effect.query("SELECT decision FROM birbcrew_ts.deferred_calls WHERE approval_id=$1", [f.approvalId])).rows[0].decision, "approve");
      if (disableFirst) {
        await change(f.targetScope);
        await assert.rejects(f.effect(effect), { code: "55000" });
      } else {
        assert.equal((await f.effect(effect)).rowCount, 1);
        await begin(setter);
        const pending = observed(change(f.targetScope, false, setter)); await blocked(setter, effect, t);
        await effect.query("COMMIT"); await accepted(pending); await setter.query("COMMIT");
      }
      const effects = (await pool.query("SELECT 1 FROM birbcrew_ts.work_items WHERE approval_id=$1", [f.approvalId])).rowCount;
      record({ kind: "effect_order", disableFirst, committedEffects: effects });
      assert.equal(effects, disableFirst ? 0 : 1);
      assert.equal((await pool.query("SELECT decision FROM birbcrew_ts.deferred_calls WHERE approval_id=$1", [f.approvalId])).rows[0].decision, "approve");
    });
  }
});

test("independent old-write guards refuse insert, generation, waiting, proposal, decision, effect, success and reservation after disable", async () => {
  const f = await fixture(); await f.start(); await f.propose();
  await change(f.targetScope);
  const writes = [() => f.insertChild(pool, "analyst"),
    () => pool.query("UPDATE birbcrew_ts.pi_children SET generation=gen_random_uuid() WHERE child_id=$1", [f.childId]),
    () => f.waiting(), () => f.propose(pool, f.childId, randomUUID()), () => f.decide(),
    () => pool.query("INSERT INTO birbcrew_ts.work_items(conversation_id,request_id,approval_id) VALUES($1,$2,$3)", [f.conversationId, f.requestId, f.approvalId]),
    () => f.finish(), () => f.reserve()];
  const boundaries = ["child_insert", "generation", "waiting", "proposal", "decision", "effect", "success", "native_reservation"];
  for (const [index, write] of writes.entries()) {
    await assert.rejects(write(), { code: "55000" });
    record({ kind: "write_refused", boundary: boundaries[index], code: "55000" });
  }
  await f.finish(pool, false);
  assert.equal((await f.reserve(pool, randomUUID(), null)).rowCount, 1, "Parent follow-up reservation remains permitted");
  await change(f.targetScope, true);
  await assert.rejects(f.start(), { code: "23514" });
  const ready = await fixture(); await change(ready.targetScope); await change(ready.targetScope, true);
  await assert.rejects(ready.start(), { code: "55000" });
  const future = await fixture({ profile: ready.profile }); await future.start(); await future.reserve();
});

test("command retry is immutable, revisions compare-and-swap, global and target state compose, and recovery fences all three tables", async () => {
  const f = await fixture();
  const expected = await revision(), command = randomUUID();
  const receipt = await change(f.targetScope, false, pool, command, expected);
  assert.deepEqual(await change(f.targetScope, false, pool, command, expected), receipt);
  assert.equal(await revision(), receipt.revision);
  await assert.rejects(change(f.targetScope, true, pool, command, expected), { code: "23505" });
  await assert.rejects(change(f.targetScope, true, pool, randomUUID(), expected), { code: "40001" });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.delegation_control_children SET retire=false WHERE command_id=$1", [command]), { code: "23514" });
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.delegation_control_changes WHERE command_id=$1", [command]), { code: "23514" });
  await change({ kind: "global" });
  await change(f.targetScope, true);
  await assert.rejects(f.insertChild(pool, "analyst"), { code: "55000" });
  await change(f.targetScope);
  await change({ kind: "global" }, true);
  await assert.rejects(f.insertChild(pool, "analyst"), { code: "55000" });
  const barriers = await pool.query(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='birbcrew_ts' AND c.relname IN ('delegation_control','delegation_control_changes','delegation_control_children')
      AND t.tgname='recovery_write_barrier' ORDER BY c.relname`);
  assert.deepEqual(barriers.rows.map(row => row.relname), ["delegation_control", "delegation_control_changes", "delegation_control_children"]);
  await sessions(async (db) => {
    await begin(db);
    await db.query("UPDATE birbcrew_ts.recovery_control SET phase='frozen',generation=gen_random_uuid() WHERE singleton");
    const writes = [
      () => change({ kind: "global" }, false, db),
      () => db.query("UPDATE birbcrew_ts.delegation_control SET global_enabled=false WHERE singleton"),
      () => db.query(`INSERT INTO birbcrew_ts.delegation_control_changes(command_id,request,installation_id,instance_id,revision,receipt)
        SELECT gen_random_uuid(),request,installation_id,instance_id,revision+1000000,receipt FROM birbcrew_ts.delegation_control_changes LIMIT 1`),
      () => db.query("INSERT INTO birbcrew_ts.delegation_control_children SELECT * FROM birbcrew_ts.delegation_control_children LIMIT 1"),
    ];
    for (const write of writes) {
      await db.query("SAVEPOINT recovery_barrier");
      await assert.rejects(write(), { code: "55000" });
      await db.query("ROLLBACK TO SAVEPOINT recovery_barrier");
    }
  });
});

test("fixed cohort retains completed-child pending-parent and late-native windows but excludes fully completed history", async () => {
  const pendingParent = await fixture(), lateNative = await fixture(), lateParent = await fixture(), uncertain = await fixture(),
    missingResume = await fixture(), complete = await fixture();
  for (const f of [pendingParent, lateNative, lateParent, uncertain, missingResume, complete]) {
    await f.start(); await f.reserve();
    if (f === lateParent) await f.reserve(pool, randomUUID(), null);
    await f.finish();
    if (f !== lateNative) await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE child_id=$1", [f.childId]);
    if (f !== missingResume) await pool.query("UPDATE birbcrew_ts.delegations SET resume_activity_id='followup' WHERE conversation_id=$1", [f.conversationId]);
    if (f === uncertain) await pool.query("UPDATE birbcrew_ts.turns SET phase='uncertain' WHERE conversation_id=$1", [f.conversationId]);
    else if (f !== pendingParent) await pool.query("UPDATE birbcrew_ts.turns SET phase='committed',reply='done',checkpoint=$2 WHERE conversation_id=$1", [f.conversationId, checkpoint]);
  }
  const receipt = await change({ kind: "global" });
  const membership = await pool.query<{ child_id: string; retire: boolean }>(`SELECT child_id,retire FROM birbcrew_ts.delegation_control_children
    WHERE command_id=$1 AND child_id=ANY($2::uuid[])`, [receipt.commandId, [pendingParent, lateNative, lateParent, uncertain, missingResume, complete].map(f => f.childId)]);
  record({ kind: "cohort", expectedSelected: [pendingParent, lateNative, lateParent, uncertain, missingResume].map(f => f.childId).sort(),
    actualSelected: membership.rows.map(row => row.child_id).sort(), excludedChild: complete.childId });
  assert.deepEqual(membership.rows.map(row => row.child_id).sort(), [pendingParent, lateNative, lateParent, uncertain, missingResume].map(f => f.childId).sort());
  assert.ok(membership.rows.every(row => !row.retire));
  await change({ kind: "global" }, true);
});

test("target-only cohort leaves an unaffected sibling eligible; later global disable retires it permanently", async () => {
  const f = await fixture({ sibling: true, primaryRole: "analyst" }), sibling = await f.insertChild(pool, "recorder");
  const target = await change(f.targetScope);
  assert.deepEqual((await pool.query("SELECT child_id FROM birbcrew_ts.delegation_control_children WHERE command_id=$1", [target.commandId])).rows,
    [{ child_id: f.childId }]);
  assert.equal((await pool.query("UPDATE birbcrew_ts.pi_children SET phase='running',generation=gen_random_uuid() WHERE child_id=$1", [sibling])).rowCount, 1);
  const approval = randomUUID();
  await f.propose(pool, sibling, approval);
  await pool.query("UPDATE birbcrew_ts.pi_children SET phase='waiting',approval_id=$2,native_checkpoint=$3 WHERE child_id=$1", [sibling, approval, checkpoint]);
  assert.deepEqual((await pool.query(`SELECT j.phase,p.decision,p.expires_at FROM birbcrew_ts.pi_children j
    JOIN birbcrew_ts.deferred_calls p USING(approval_id) WHERE child_id=$1`, [sibling])).rows[0],
    { phase: "waiting", decision: null, expires_at: null });
  const global = await change({ kind: "global" });
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.delegation_control_children WHERE command_id=$1 AND child_id=$2 AND retire", [global.commandId, sibling])).rowCount, 1);
  await change({ kind: "global" }, true);
  await assert.rejects(pool.query("UPDATE birbcrew_ts.pi_children SET phase='resuming' WHERE child_id=$1", [sibling]), { code: "55000" });
});

test("native reservation and child insert gates serialize both commit orders without granting after disable", { timeout: 60_000 }, async t => {
  for (const boundary of ["reservation", "child_insert"]) for (const disableFirst of [true, false]) {
    const f = await fixture(); await f.start();
    const write = async (db: PoolClient) => boundary === "reservation" ? f.reserve(db) : f.insertChild(db, "analyst");
    await sessions(async (writer, setter) => {
      await begin(writer); await begin(setter);
      if (disableFirst) {
        await change(f.targetScope, false, setter);
        const pending = observed(write(writer)); await blocked(writer, setter, t);
        await setter.query("COMMIT"); await refused(pending);
      } else {
        await lockConversation(writer, f.conversationId); await write(writer);
        const pending = observed(change(f.targetScope, false, setter)); await blocked(setter, writer, t);
        await writer.query("COMMIT"); await accepted(pending); await setter.query("COMMIT");
      }
      const rows = await pool.query(boundary === "reservation"
        ? "SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1"
        : "SELECT 1 FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND ordinal=1", [boundary === "reservation" ? f.childId : f.conversationId]);
      assert.equal(rows.rowCount, disableFirst ? 0 : 1);
      await stopped(f);
    });
  }
});

test("restore-style activation reuses the canonical mutation atomically, and rollback leaves no control receipt or stop intent", async () => {
  for (const commit of [false, true]) {
    const f = await fixture(); await f.start();
    const prior = (await pool.query("SELECT instance_id FROM birbcrew_ts.recovery_control WHERE singleton")).rows[0].instance_id;
    const priorRevision = await revision(), command = randomUUID(), instance = randomUUID();
    await sessions(async (db) => {
      await begin(db);
      await db.query("UPDATE birbcrew_ts.recovery_control SET phase='restored',generation=gen_random_uuid() WHERE singleton");
      await db.query("UPDATE birbcrew_ts.recovery_control SET phase='active',generation=NULL,instance_id=$1 WHERE singleton", [instance]);
      const receipt = await change({ kind: "global" }, false, db, command, priorRevision);
      assert.equal(receipt.instanceId, instance);
      await db.query(commit ? "COMMIT" : "ROLLBACK");
    });
    assert.equal((await pool.query("SELECT instance_id FROM birbcrew_ts.recovery_control WHERE singleton")).rows[0].instance_id, commit ? instance : prior);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.delegation_control_changes WHERE command_id=$1", [command])).rowCount, commit ? 1 : 0);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE token=$1", [f.token])).rowCount, commit ? 1 : 0);
    assert.deepEqual((await pool.query("SELECT phase,generation,outcome FROM birbcrew_ts.pi_children WHERE child_id=$1", [f.childId])).rows[0],
      { phase: "running", generation: f.token, outcome: null });
    if (commit) await change({ kind: "global" }, true);
    else assert.equal(await revision(), priorRevision);
  }
});

test("retirement stops every reserved child generation, preserves parent reservation, and refuses non-READ-COMMITTED commands", async () => {
  const f = await fixture(); await f.start(); await f.reserve();
  const oldToken = randomUUID(), parentToken = randomUUID();
  await f.reserve(pool, oldToken); await f.reserve(pool, parentToken, null);
  await change(f.targetScope);
  const stoppedTokens = (await pool.query<{ token: string }>("SELECT token FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1", [f.conversationId])).rows.map(row => row.token).sort();
  assert.deepEqual(stoppedTokens, [oldToken, f.token].sort());
  await sessions(async (db) => {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await assert.rejects(change(f.targetScope, true, db), { code: "55000" });
  });
});

test("an enable command from an old recovery instance cannot return a current enable receipt after restored disable", async () => {
  const expected = await revision(), command = randomUUID();
  const old = await change({ kind: "global" }, true, pool, command, expected);
  await sessions(async (db) => {
    await begin(db);
    await db.query("UPDATE birbcrew_ts.recovery_control SET instance_id=gen_random_uuid() WHERE singleton");
    const disabled = await change({ kind: "global" }, false, db);
    assert.notEqual(disabled.instanceId, old.instanceId);
    await db.query("COMMIT");
  });
  await assert.rejects(change({ kind: "global" }, true, pool, command, expected), { code: "55000" });
  assert.equal((await pool.query("SELECT global_enabled FROM birbcrew_ts.delegation_control WHERE singleton")).rows[0].global_enabled, false);
  assert.deepEqual((await pool.query("SELECT receipt FROM birbcrew_ts.delegation_control_changes WHERE command_id=$1", [command])).rows[0].receipt, old);
  await change({ kind: "global" }, true);
});
