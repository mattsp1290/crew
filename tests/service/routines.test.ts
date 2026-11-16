import { migrateThrough, testDatabaseName } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ApprovalStore } from "../../src/service/approvals.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { MemberStoreError, ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { readSnapshot } from "../../src/service/observation.ts";
import { InstallationRecovery } from "../../src/service/recovery.ts";
import { FileRecoveryFence } from "../../src/service/recovery-fence.ts";
import { RoutineApi, RoutineDispatcher, routineLimits, type Clock } from "../../src/service/routines.ts";
import { MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
after(() => pool.end());
const sql = new URL("../../src/service/sql/", import.meta.url);

// Windows of "*/15 * * * *" fall on quarter hours. 2031-01-06 is a Monday. Every routine these
// tests create is scheduled after this, so a gateway on the real clock never finds one due.
const T0 = "2031-01-06T10:00:00.000Z";
const window = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000);

/** A database migrated only up to `version`, as that release left it; dropped after the test. */
async function databaseAt(t: TestContext, version = Infinity) {
  const name = testDatabaseName("routines_");
  await pool.query("CREATE DATABASE " + name);
  const target = new URL(url!); target.pathname = "/" + name;
  const db = new Pool({ connectionString: target.href });
  // Not FORCE: end() resolves before its connections close; a plain DROP waits for them.
  t.after(async () => { await db.end(); await pool.query("DROP DATABASE " + name); });
  if (version === Infinity) {
    await new MemberStore(db).migrate();
    return db;
  }
  await db.query("CREATE SCHEMA birbcrew_ts");
  await db.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version) continue;
    await db.query(await readFile(new URL(file, sql), "utf8"));
    await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return db;
}

type Hooks = { beforeAdmission?: (input: TurnRequest, attempt: number) => void | Promise<void>;
  afterAdmission?: (input: TurnRequest, attempt: number) => void };
/** A fresh database, one owner and member, a settable clock, and MemberClient doubles that
 * open and admit through the real store as the workflow's activities would. */
async function harness(t: TestContext, hooks: Hooks = {}) {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  let now = new Date(T0);
  const clock: Clock = () => new Date(now);
  const ownerId = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const accepts: TurnRequest[] = [];
  const members = {
    async open(input: Parameters<MemberStore["openConversation"]>[0]) { return store.openConversation(input); },
    async accept(input: TurnRequest) {
      accepts.push(input);
      const attempt = accepts.filter(({ requestId }) => requestId === input.requestId).length;
      await hooks.beforeAdmission?.(input, attempt);
      await store.recordAcceptance(input, ownerInitiator);
      hooks.afterAdmission?.(input, attempt);
      return { requestId: input.requestId };
    },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return store.requestStatus(input); },
    async cancelPending() {},
    async decide(input: Parameters<ApprovalStore["decide"]>[0]) { return new ApprovalStore(db).decide(input); },
  } as unknown as MemberClient;
  const integration = new IntegrationApi(store, members);
  const routines = new RoutineApi(store, clock);
  return {
    db, store, ownerId, member, members, accepts, routines, integration, clock,
    dispatcher: (owners = [ownerId], driveWaitMs?: number) => new RoutineDispatcher({ store, members, integration, owners, clock, driveWaitMs }),
    create: (fields: Record<string, unknown> = {}) => routines.create(ownerId, { requestId: randomUUID(), memberId: member.memberId,
      schedule: "*/15 * * * *", prompt: "scheduled prompt", approvalPolicy: "wait", ...fields }),
    firings: async (routineId: string) => (await db.query(`SELECT scheduled_for AS "scheduledFor", status, reason,
      conversation_id AS "conversationId", request_id AS "requestId" FROM birbcrew_ts.routine_firings
      WHERE routine_id=$1 ORDER BY scheduled_for`, [routineId])).rows,
    routine: async (routineId: string) => (await db.query("SELECT * FROM birbcrew_ts.routines WHERE routine_id=$1", [routineId])).rows[0],
    at(time: Date) { now = new Date(time); },
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    /** Commits the firing's turn as its worker would. */
    async finish(firing: { conversationId: string; requestId: string }, text = "scheduled prompt") {
      const request = { ownerId, conversationId: firing.conversationId, requestId: firing.requestId, text };
      const turn = await store.beginTurn(request, { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 });
      assert.equal(turn.kind, "start"); if (turn.kind !== "start") throw new Error("unreachable");
      const { text: _, ...key } = request;
      return { request, token: turn.token, commit: () => store.commitTurn({ ...key, token: turn.token, reply: "done",
        checkpoint: { version: 1, engine: "pi", state: {} } }) };
    },
  };
}

async function gateway(t: TestContext, store: MemberStore, members: MemberClient, clock: Clock, ownerId = "owner-" + randomUUID()) {
  const token = randomUUID(), stranger = randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const server = createGateway(store, members, { [hash(token)]: ownerId, [hash(stranger)]: "owner-" + randomUUID() }, { clock });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const stop = async () => {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  };
  t.after(stop);
  async function api(path: string, body?: unknown, credential: string = token, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  }
  return { ownerId, token, stranger, api, stop };
}

const sharedMembers = {
  async open() { throw new Error("not used"); },
  async accept(input: TurnRequest) { await new MemberStore(pool).recordAcceptance(input, ownerInitiator); return { requestId: input.requestId }; },
  async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return new MemberStore(pool).requestStatus(input); },
  async cancelPending() {},
} as unknown as MemberClient;

test("the routine routes are strict, bounded, idempotent and owner-scoped", async (t) => {
  const store = new MemberStore(pool);
  await store.migrate();
  const g = await gateway(t, store, sharedMembers, () => new Date(T0));
  const member = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const foreign = await store.spawn({ ownerId: "owner-" + randomUUID(), requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const body = { requestId: randomUUID(), memberId: member.memberId, schedule: "*/15 * * * *", prompt: "check the build", approvalPolicy: "wait" };
  const created = await g.api("/v1/routines", body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual({ ...created.body, routineId: undefined }, { apiVersion: "1", routineId: undefined, memberId: member.memberId,
    schedule: body.schedule, timezone: "UTC", prompt: body.prompt, approvalPolicy: "wait", state: "enabled", disabledReason: null,
    consecutiveFailures: 0, nextWindow: window(15).toISOString(), createdAt: T0 });
  const { routineId } = created.body;
  assert.deepEqual(await g.api("/v1/routines", body), created, "an identical create is a replay");
  assert.deepEqual(await g.api("/v1/routines", { ...body, prompt: "changed" }), { status: 409, body: { error: "conflict" } });
  assert.deepEqual(await g.api("/v1/routines", { ...body, requestId: body.requestId.toUpperCase() }), created);

  const fresh = () => ({ ...body, requestId: randomUUID() });
  for (const invalid of [{ ...fresh(), initiator: { kind: "routine", id: routineId } }, { ...fresh(), ownerId: g.ownerId },
    { ...fresh(), prompt: "" }, { ...fresh(), prompt: "x".repeat(16_385) }, { ...fresh(), prompt: "a\0b" },
    { ...fresh(), schedule: "*/5 * * * *" }, { ...fresh(), schedule: "0 0 30 2 *" }, { ...fresh(), schedule: "0 9 * * MON" },
    { ...fresh(), approvalPolicy: "approve" }, { ...fresh(), memberId: "not-a-uuid" }, { requestId: randomUUID() }]) {
    assert.deepEqual(await g.api("/v1/routines", invalid), { status: 400, body: { error: "invalid_input" } }, JSON.stringify(invalid).slice(0, 80));
  }
  assert.equal((await g.api("/v1/routines", { ...fresh(), prompt: "é".repeat(8_192) })).status, 201, "16 KiB of UTF-8 is accepted");
  assert.deepEqual(await g.api("/v1/routines", { ...fresh(), memberId: foreign.memberId }), { status: 404, body: { error: "not_found" } });

  const path = `/v1/routines/${routineId}`;
  assert.deepEqual(await g.api(`/v1/routines/${routineId.toUpperCase()}`), { status: 200, body: created.body });
  for (const [route, payload, method] of [[path, undefined, "GET"], [path + "/enable", {}, "POST"], [path + "/disable", {}, "POST"],
    [path, undefined, "DELETE"], [path + "/firings", undefined, "GET"]] as const) {
    assert.deepEqual(await g.api(route, payload, g.stranger, method), { status: 404, body: { error: "not_found" } }, `${method} ${route}`);
  }
  assert.deepEqual((await g.api("/v1/routines", undefined, g.stranger)).body.routines, []);
  assert.equal((await g.api("/v1/routines", undefined, "invalid")).status, 401);
  assert.equal((await g.api("/v1/routines", {}, g.token, "PUT")).status, 405);
  assert.equal((await g.api(path + "/enable", { force: true })).status, 400);
  assert.equal((await g.api(path + "/firings", {})).status, 405);
  assert.equal((await g.api("/routines")).status, 404);
  for (const query of ["?limit=0", "?limit=1001", "?before=2031-01-06", "?before=yesterday", "?after=" + routineId, "?limit=1&limit=2", "?__proto__=1"]) {
    assert.deepEqual(await g.api(path + "/firings" + query), { status: 400, body: { error: "invalid_input" } }, query);
  }
  for (const query of ["?after=not-a-uuid", "?before=" + T0, "?limit=1&limit=1", "?limit=101"]) {
    assert.deepEqual(await g.api("/v1/routines" + query), { status: 400, body: { error: "invalid_input" } }, query);
  }

  const disabled = await g.api(path + "/disable", {});
  assert.deepEqual([disabled.status, disabled.body.state, disabled.body.disabledReason, disabled.body.nextWindow], [200, "disabled", "owner", null]);
  assert.deepEqual(await g.api(path + "/disable", {}), disabled, "disabling again changes nothing");
  const enabled = await g.api(path + "/enable", {});
  assert.deepEqual([enabled.body.state, enabled.body.disabledReason, enabled.body.nextWindow], ["enabled", null, window(15).toISOString()]);
  const deleted = await g.api(path, undefined, g.token, "DELETE");
  assert.deepEqual([deleted.status, deleted.body.state, deleted.body.nextWindow], [200, "deleted", null]);
  assert.deepEqual(await g.api(path + "/enable", {}), { status: 409, body: { error: "routine_deleted" } });
  assert.deepEqual(await g.api(path + "/disable", {}), { status: 409, body: { error: "routine_deleted" } });
  assert.deepEqual(await g.api(path, undefined, g.token, "DELETE"), deleted);
  assert.deepEqual((await g.api(path)).body, deleted.body, "the tombstone stays readable");
  assert.deepEqual((await g.api(path + "/firings")).body, { apiVersion: "1", firings: [], nextBefore: null, hasMore: false });
  assert.deepEqual(await g.api("/v1/routines", body), { status: 201, body: deleted.body }, "a replayed create never revives the id");
  const listed = (await g.api("/v1/routines?limit=1")).body;
  assert.equal(listed.routines.length, 1);
  assert.equal(listed.hasMore, true);
  const rest = (await g.api("/v1/routines?after=" + listed.nextAfter)).body;
  assert.deepEqual([...listed.routines, ...rest.routines].map(routine => routine.routineId).sort(),
    (await pool.query("SELECT routine_id FROM birbcrew_ts.routines WHERE owner_id=$1 ORDER BY 1", [g.ownerId])).rows.map(row => row.routine_id));
  // The database keeps the definition and the tombstone fixed, whoever writes.
  await assert.rejects(pool.query("UPDATE birbcrew_ts.routines SET prompt='other' WHERE routine_id=$1", [routineId]), { code: "23514", message: /immutable/ });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.routines SET state='enabled' WHERE routine_id=$1", [routineId]), { code: "23514", message: /deleted/ });
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.routines WHERE routine_id=$1", [routineId]), { code: "23514", message: /tombstones/ });

  const capabilities = (await g.api("/v1/capabilities")).body;
  assert.deepEqual(capabilities.initiatorKinds, ["owner", "routine", "handoff"]);
  assert.deepEqual([capabilities.routines.route, capabilities.routines.minimumIntervalMinutes, capabilities.routines.maximumEnabledPerOwner,
    capabilities.routines.promptBytes, capabilities.routines.approvalPolicies, capabilities.routines.timezone],
    ["/v1/routines", 15, 20, 16_384, ["wait", "fail_closed"], "UTC"]);
  const { rows: audit } = await pool.query(`SELECT event_type AS type, actor_kind AS actor, payload->>'revision' AS revision,
    payload->>'reason' AS reason FROM birbcrew_ts.audit_events WHERE owner_id=$1 AND payload->>'routineId'=$2 ORDER BY event_id`, [g.ownerId, routineId]);
  assert.deepEqual(audit, [
    { type: "routine.created", actor: "owner", revision: "1", reason: null },
    { type: "routine.disabled", actor: "owner", revision: "2", reason: "owner" },
    { type: "routine.enabled", actor: "owner", revision: "3", reason: null },
    { type: "routine.deleted", actor: "owner", revision: "4", reason: null },
  ]);
});

test("an owner never has more than 20 enabled routines, even under concurrent creates", async () => {
  const store = new MemberStore(pool);
  const ownerId = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const routines = new RoutineApi(store, () => new Date(T0));
  const body = () => ({ requestId: randomUUID(), memberId: member.memberId, schedule: "0 * * * *", prompt: "p", approvalPolicy: "wait" });
  const outcomes = await Promise.allSettled(Array.from({ length: 25 }, () => routines.create(ownerId, body())));
  const created = outcomes.filter(outcome => outcome.status === "fulfilled");
  assert.equal(created.length, 20);
  assert.ok(outcomes.every(outcome => outcome.status === "fulfilled"
    || (outcome.reason instanceof MemberStoreError && outcome.reason.code === "routine_limit")));
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::integer AS n FROM birbcrew_ts.routines WHERE owner_id=$1 AND state='enabled'", [ownerId]);
  assert.equal(n, 20);
  // A replay at the cap is still a replay; disabling frees a place, and re-enabling rechecks it.
  const replay = body();
  await assert.rejects(routines.create(ownerId, replay), { code: "routine_limit" });
  const first = (created[0] as PromiseFulfilledResult<{ routineId: string }>).value;
  await routines.change(ownerId, first.routineId, "disable");
  const last = await routines.create(ownerId, replay);
  assert.deepEqual(await routines.create(ownerId, replay), last);
  await assert.rejects(routines.change(ownerId, first.routineId, "enable"), { code: "routine_limit" });
  // Concurrent re-enables of disabled routines race for the same place.
  const disabled = (created.slice(1, 6) as PromiseFulfilledResult<{ routineId: string }>[]).map(outcome => outcome.value.routineId);
  for (const routineId of disabled) await routines.change(ownerId, routineId, "disable");
  const reenabled = await Promise.allSettled([first.routineId, ...disabled].map(routineId => routines.change(ownerId, routineId, "enable")));
  assert.equal(reenabled.filter(outcome => outcome.status === "fulfilled").length, 5);
  const { rows: [count] } = await pool.query("SELECT count(*)::integer AS n FROM birbcrew_ts.routines WHERE owner_id=$1 AND state='enabled'", [ownerId]);
  assert.equal(count.n, 20);

  // Deterministically: an uncommitted 20th routine makes a 21st create wait on the owner's lock,
  // then refuses it once the 20th commits. Without the lock both would count 19.
  const other = "owner-" + randomUUID();
  const own = await store.spawn({ ownerId: other, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const make = () => ({ ...body(), memberId: own.memberId });
  for (let i = 0; i < 19; i++) await routines.create(other, make());
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`INSERT INTO birbcrew_ts.routines (owner_id,create_request_id,member_id,schedule,prompt,approval_policy,created_at,state,next_window)
      VALUES ($1,$2,$3,'0 * * * *','p','wait',$4,'enabled',$4)`, [other, randomUUID(), own.memberId, T0]);
    let settled = false;
    const late = routines.create(other, make()).finally(() => { settled = true; });
    late.catch(() => {});
    for (let i = 0; i < 100 && !settled && !(await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rowCount; i++) {
      await delay(20);
    }
    await delay(100);
    assert.equal(settled, false, "the second enable waits for the first to commit");
    await holder.query("COMMIT");
    await assert.rejects(late, { code: "routine_limit" });
  } finally { holder.release(); }
  const { rows: [capped] } = await pool.query("SELECT count(*)::integer AS n FROM birbcrew_ts.routines WHERE owner_id=$1 AND state='enabled'", [other]);
  assert.equal(capped.n, 20);
});

test("two dispatchers at the same instant fire each window once, with one identity", async (t) => {
  const h = await harness(t);
  const routines = await Promise.all(Array.from({ length: 12 }, () => h.create()));
  const [first, second] = [h.dispatcher(), h.dispatcher()];
  await Promise.all([first.tick(), second.tick()]);
  h.at(window(15));
  await Promise.all([first.tick(), second.tick(), first.tick()]);
  for (const routine of routines) {
    const firings = await h.firings(routine.routineId);
    assert.equal(firings.length, 1);
    assert.deepEqual([firings[0].scheduledFor.toISOString(), firings[0].status], [window(15).toISOString(), "admitted"]);
  }
  assert.equal(h.accepts.length, routines.length);
  assert.equal(new Set(h.accepts.map(({ requestId }) => requestId)).size, routines.length);
  const { rows: [{ n }] } = await h.db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.request_admissions");
  assert.equal(n, routines.length);
});

test("an ambiguous admission keeps the firing claimed and retries the same identity after its lease", async (t) => {
  const h = await harness(t, {
    beforeAdmission: (input, attempt) => { if (input.text === "lost before" && attempt === 1) throw new Error("connection reset"); },
    afterAdmission: (input, attempt) => { if (input.text === "lost after" && attempt === 1) throw new Error("deadline exceeded"); },
  });
  const before = await h.create({ prompt: "lost before" });
  const afterAck = await h.create({ prompt: "lost after" });
  const dispatcher = h.dispatcher();
  await dispatcher.tick();
  h.at(window(15));
  await dispatcher.tick();
  const [claimed] = await h.firings(before.routineId);
  assert.equal(claimed.status, "claimed", "an unknown outcome is neither admitted nor failed");
  assert.equal((await h.firings(afterAck.routineId))[0].status, "admitted", "the admission row, not the error, decides");
  h.advance(routineLimits.leaseMs - 1_000);
  await dispatcher.tick();
  assert.equal(h.accepts.filter(({ text }) => text === "lost before").length, 1, "no retry while the lease holds");
  assert.equal((await h.routine(before.routineId)).consecutive_failures, 0, "an ambiguous outcome is never counted");
  h.advance(2_000);
  await dispatcher.tick();
  const retried = h.accepts.filter(({ text }) => text === "lost before");
  assert.equal(retried.length, 2);
  assert.deepEqual(retried[1], retried[0], "the retry reuses the stored conversation and request");
  assert.deepEqual(await h.firings(before.routineId), [{ ...claimed, status: "admitted" }]);
  const { rows } = await h.db.query("SELECT conversation_id, request_id FROM birbcrew_ts.request_admissions WHERE conversation_id=$1", [claimed.conversationId]);
  assert.deepEqual(rows, [{ conversation_id: claimed.conversationId, request_id: claimed.requestId }]);
});

test("a refusal that races an earlier attempt's admission settles as admitted, not failed", async (t) => {
  // The retried attempt is refused while an earlier attempt's admission is still in flight: it holds
  // the firing's share lock, as recordAcceptance does, and commits only once settlement waits for it.
  let straggle: ((input: TurnRequest) => Promise<void>) | undefined;
  const h = await harness(t, { beforeAdmission: async input => {
    if (!straggle) throw new Error("timeout");
    await straggle(input);
    throw new MemberStoreError("conflict");
  } });
  const routine = await h.create();
  const dispatcher = h.dispatcher();
  await dispatcher.tick();
  h.at(window(15));
  await dispatcher.tick();
  assert.equal((await h.firings(routine.routineId))[0].status, "claimed");
  const straggler = await h.db.connect();
  try {
    straggle = async input => {
      await straggler.query("BEGIN");
      await straggler.query("SELECT 1 FROM birbcrew_ts.routine_firings WHERE conversation_id=$1 FOR SHARE", [input.conversationId]);
      await straggler.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind,initiator_id)
        VALUES ($1,$2,$3,'routine',$4)`, [input.conversationId, input.requestId, createHash("sha256").update(input.text).digest(), routine.routineId]);
    };
    h.advance(routineLimits.leaseMs);
    const pass = dispatcher.tick();
    let waited = false;
    for (let i = 0; i < 300 && !waited; i++) {
      waited = !!(await h.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount;
      if (!waited) await delay(10);
    }
    assert.ok(waited, "settlement waits for the in-flight admission's share lock");
    await straggler.query("COMMIT");
    await pass;
  } finally { straggler.release(); }
  assert.deepEqual((await h.firings(routine.routineId)).map(f => f.status), ["admitted"]);
  assert.equal((await h.routine(routine.routineId)).consecutive_failures, 0);
});

test("a stalled drive holds up no later pass and is not driven twice by its process", { timeout: 30_000 }, async (t) => {
  let release = () => {};
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { beforeAdmission: input => input.text === "stalls" ? stalled : undefined });
  const slow = await h.create({ prompt: "stalls" });
  const quick = await h.create();
  const dispatcher = h.dispatcher([h.ownerId], 200);
  await dispatcher.tick();
  h.at(window(15));
  const started = Date.now();
  await dispatcher.tick();
  assert.ok(Date.now() - started < 5_000, "the pass ends without its stalled drive");
  assert.deepEqual([(await h.firings(slow.routineId))[0].status, (await h.firings(quick.routineId))[0].status], ["claimed", "admitted"]);
  h.advance(routineLimits.leaseMs + 1_000);
  await dispatcher.tick();
  assert.equal(h.accepts.filter(({ text }) => text === "stalls").length, 1, "its own expired lease is not re-driven while it runs");
  release();
  for (let i = 0; i < 100 && (await h.firings(slow.routineId))[0].status === "claimed"; i++) await delay(20);
  assert.equal((await h.firings(slow.routineId))[0].status, "admitted");
});

test("windows this dispatcher waits on do not crowd a due window out of its batch", async (t) => {
  const h = await harness(t);
  const other = "owner-" + randomUUID();
  const member = await h.store.spawn({ ownerId: other, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  for (let i = 0; i < 20; i++) await h.create();
  for (let i = 0; i < 13; i++) await h.routines.create(other, { requestId: randomUUID(), memberId: member.memberId,
    schedule: "*/15 * * * *", prompt: "p", approvalPolicy: "wait" });
  const later = await h.routines.create(other, { requestId: randomUUID(), memberId: member.memberId,
    schedule: "18 * * * *", prompt: "p", approvalPolicy: "wait" });
  const dispatcher = h.dispatcher([h.ownerId, other]);
  h.at(window(17));
  await dispatcher.tick(); // armed at 10:17: 33 windows of 10:15 are left to an armed replica
  h.at(window(18));
  await dispatcher.tick();
  assert.deepEqual((await h.firings(later.routineId)).map(f => [f.scheduledFor.toISOString(), f.status]), [[window(18).toISOString(), "admitted"]]);
  const { rows: [{ n }] } = await h.db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.routine_firings WHERE scheduled_for=$1", [window(15)]);
  assert.equal(n, 0);
});

test("missed, unarmed, overlapping and owner-unavailable windows are skipped; only the last counts as a failure", async (t) => {
  const h = await harness(t);
  const routine = await h.create();
  const armedLate = h.dispatcher();
  h.at(window(21));
  await armedLate.tick(); // armed at 10:21; the 10:15 window is 6 minutes late
  h.at(window(30));
  await armedLate.tick(); // fires; no turn starts, so the firing stays open
  h.at(window(45));
  await armedLate.tick(); // overlaps the open 10:30 firing
  const fresh = h.dispatcher();
  h.at(window(62));
  await fresh.tick(); // 11:00 is 2 minutes old, but this dispatcher was not armed for it: left for another replica
  assert.equal((await h.firings(routine.routineId)).length, 3);
  h.at(new Date(window(65).getTime() + 1_000));
  await fresh.tick(); // now more than 5 minutes late
  const ownerless = h.dispatcher([]);
  h.at(window(75));
  await ownerless.tick();
  h.at(window(90));
  await armedLate.tick();
  assert.deepEqual((await h.firings(routine.routineId)).map(f => [f.scheduledFor.toISOString().slice(11, 16), f.status, f.reason]), [
    ["10:15", "skipped", "missed"], ["10:30", "admitted", null], ["10:45", "skipped", "overlap"],
    ["11:00", "skipped", "missed"], ["11:15", "skipped", "owner_unavailable"], ["11:30", "skipped", "overlap"],
  ]);
  const stored = await h.routine(routine.routineId);
  assert.equal(stored.consecutive_failures, 1);
  assert.equal(stored.next_window.toISOString(), window(105).toISOString());
  const { rows } = await h.db.query(`SELECT payload->>'reason' AS reason, actor_kind AS actor FROM birbcrew_ts.audit_events
    WHERE event_type='routine.firing_settled' ORDER BY event_id`);
  assert.deepEqual(rows.map(row => row.reason), ["missed", "overlap", "missed", "owner_unavailable", "overlap"]);
  assert.ok(rows.every(row => row.actor === "system"));
});

test("refusals fail the firing; success resets the count; the tenth failure in a row disables the routine", async (t) => {
  let refuse = true;
  const h = await harness(t, { beforeAdmission: () => { if (refuse) throw new MemberStoreError("conflict"); } });
  const routine = await h.create();
  const dispatcher = h.dispatcher();
  await dispatcher.tick();
  let minutes = 0;
  const next = async () => { minutes += 15; h.at(window(minutes)); await dispatcher.tick(); };
  for (let i = 1; i <= 3; i++) {
    await next();
    assert.equal((await h.routine(routine.routineId)).consecutive_failures, i);
  }
  refuse = false;
  await next();
  const admitted = (await h.firings(routine.routineId)).at(-1);
  assert.equal(admitted.status, "admitted");
  await (await h.finish(admitted)).commit();
  h.advance(routineLimits.observeEveryMs);
  await dispatcher.tick();
  assert.equal((await h.firings(routine.routineId)).at(-1).status, "succeeded");
  assert.equal((await h.routine(routine.routineId)).consecutive_failures, 0);
  refuse = true;
  for (let i = 1; i <= 9; i++) await next();
  assert.deepEqual([(await h.routine(routine.routineId)).state, (await h.routine(routine.routineId)).consecutive_failures], ["enabled", 9]);
  await next();
  const disabled = await h.routine(routine.routineId);
  assert.deepEqual([disabled.state, disabled.disabled_reason, disabled.consecutive_failures, disabled.next_window],
    ["disabled", "consecutive_failures", 10, null]);
  const count = (await h.firings(routine.routineId)).length;
  await next();
  assert.equal((await h.firings(routine.routineId)).length, count, "a disabled routine does not fire");
  const { rows: [fact] } = await h.db.query(`SELECT actor_kind AS actor, actor_id AS "actorId", payload FROM birbcrew_ts.audit_events
    WHERE event_type='routine.disabled'`);
  assert.deepEqual(fact, { actor: "system", actorId: null, payload: { routineId: routine.routineId, revision: 2, reason: "consecutive_failures" } });
  // Re-enabling resets the count and schedules from now.
  const enabled = await h.routines.change(h.ownerId, routine.routineId, "enable");
  assert.deepEqual([enabled.consecutiveFailures, enabled.nextWindow], [0, window(minutes + 15).toISOString()]);
});

test("fail_closed records its reason and requests cancellation through the durable path; wait leaves the card", async (t) => {
  const h = await harness(t);
  const closed = await h.create({ approvalPolicy: "fail_closed", prompt: "record closed" });
  const waits = await h.create({ approvalPolicy: "wait", prompt: "record waiting" });
  const dispatcher = h.dispatcher();
  await dispatcher.tick();
  h.at(window(15));
  await dispatcher.tick();
  const approvals = new ApprovalStore(h.db);
  const cards = [];
  for (const [routine, text] of [[closed, "record closed"], [waits, "record waiting"]] as const) {
    const [firing] = await h.firings(routine.routineId);
    const turn = await h.finish(firing, text);
    const scope = { ownerId: h.ownerId, memberId: h.member.memberId, conversationId: firing.conversationId, requestId: firing.requestId };
    cards.push({ firing, turn, scope, approval: await approvals.propose({ ...scope, token: turn.token, invocationId: firing.requestId,
      nativeCallId: "call-" + text, toolName: "record_work_item", arguments: { operation_id: firing.requestId } }) });
  }
  h.advance(routineLimits.observeEveryMs);
  await dispatcher.tick();
  const [closedCard, waitingCard] = cards;
  assert.deepEqual((await h.firings(closed.routineId)).map(f => [f.status, f.reason]), [["waiting", "approval_required"]]);
  const { rows: intents } = await h.db.query("SELECT conversation_id FROM birbcrew_ts.integration_cancellations");
  assert.deepEqual(intents, [{ conversation_id: closedCard.firing.conversationId }], "only fail_closed writes an intent");
  const { rows: [cancellation] } = await h.db.query(`SELECT actor_kind AS actor, initiator_kind AS kind, initiator_id AS id, payload
    FROM birbcrew_ts.audit_events WHERE event_type='request.cancellation_requested'`);
  assert.deepEqual({ ...cancellation, payload: { ...cancellation.payload, receiptId: undefined } },
    { actor: "owner", kind: "routine", id: closed.routineId, payload: { receiptId: undefined, policy: "fail_closed" } });
  assert.equal((await h.integration.status({ ownerId: h.ownerId, conversationId: closedCard.firing.conversationId,
    requestId: closedCard.firing.requestId })).status, "cancellation_requested");
  assert.deepEqual((await h.firings(waits.routineId)).map(f => [f.status, f.reason]), [["waiting", null]]);
  const snapshot = await readSnapshot(h.db, h.ownerId, waitingCard.firing.conversationId);
  assert.deepEqual(snapshot.state.pendingApprovals.map(card => card.approvalId), [waitingCard.approval.approvalId]);

  // The closed turn ends with a reply after the cancelled card: still a failure. The owner
  // approves the waiting card; its turn completes.
  await closedCard.turn.commit();
  await approvals.decide({ ...waitingCard.scope, invocationId: waitingCard.firing.requestId, nativeCallId: waitingCard.approval.nativeCallId,
    approvalId: waitingCard.approval.approvalId, argumentDigest: waitingCard.approval.argumentDigest,
    version: waitingCard.approval.version, choice: "approve" });
  h.advance(routineLimits.observeEveryMs);
  await dispatcher.tick();
  assert.deepEqual((await h.firings(closed.routineId)).map(f => [f.status, f.reason]), [["failed", "approval_required"]]);
  assert.equal((await h.routine(closed.routineId)).consecutive_failures, 1);
  assert.deepEqual((await h.firings(waits.routineId)).map(f => [f.status, f.reason]), [["admitted", null]]);
  await waitingCard.turn.commit();
  h.advance(routineLimits.observeEveryMs);
  await dispatcher.tick();
  assert.deepEqual((await h.firings(waits.routineId)).map(f => [f.status, f.reason]), [["succeeded", null]]);
  const { rows: intentsAfter } = await h.db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.integration_cancellations");
  assert.equal(intentsAfter[0].n, 1);
});

test("nothing is written while the installation is held, and windows of the hold are skipped after resume", async (t) => {
  const h = await harness(t);
  const directory = await mkdtemp(join(tmpdir(), "birbcrew-routines-hold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recovery = new InstallationRecovery(h.db, new FileRecoveryFence(join(directory, "fence")));
  await recovery.initializeFence();
  const routine = await h.create();
  const dispatcher = h.dispatcher();
  await dispatcher.tick();
  await recovery.freeze();
  for (const minutes of [15, 31, 46]) {
    h.at(window(minutes));
    await dispatcher.tick();
  }
  assert.deepEqual(await h.firings(routine.routineId), []);
  assert.equal((await h.routine(routine.routineId)).next_window.toISOString(), window(15).toISOString());
  // The write barrier refuses a claim from a dispatcher that did not look first.
  await assert.rejects(h.db.query(`INSERT INTO birbcrew_ts.routine_firings (routine_id,scheduled_for,status,reason,recorded_at,settled_at)
    VALUES ($1,$2,'skipped','missed',$2,$2)`, [routine.routineId, window(15)]), { code: "55000" });
  await recovery.resume({ reconcile: async () => {} });
  h.at(window(47));
  await dispatcher.tick(); // re-armed at 10:47: the 10:45 window fell in the hold
  assert.deepEqual(await h.firings(routine.routineId), []);
  h.at(new Date(window(50).getTime() + 1_000));
  await dispatcher.tick();
  h.at(window(60));
  await dispatcher.tick();
  assert.deepEqual((await h.firings(routine.routineId)).map(f => [f.scheduledFor.toISOString().slice(11, 16), f.status, f.reason]),
    [["10:45", "skipped", "missed"], ["11:00", "admitted", null]]);
});

test("audit rows and receipts name the routine; no request body or caller can", async (t) => {
  const h = await harness(t, { beforeAdmission: (input, attempt) => { if (input.text === "held back" && attempt === 1) throw new Error("timeout"); } });
  // The gateway's own dispatcher keeps its clock at T0, so only the test's dispatcher fires.
  const g = await gateway(t, h.store, h.members, () => new Date(T0), h.ownerId);
  const routine = (await g.api("/v1/routines", { requestId: randomUUID(), memberId: h.member.memberId, schedule: "*/15 * * * *",
    prompt: "scheduled prompt", approvalPolicy: "wait" })).body;
  const heldBack = await h.create({ prompt: "held back" });
  const dispatcher = h.dispatcher();
  await dispatcher.tick();
  h.at(window(15));
  await dispatcher.tick();
  const history = (await g.api(`/v1/routines/${routine.routineId}/firings`)).body;
  assert.equal(history.firings.length, 1);
  const [firing] = history.firings;
  assert.deepEqual([firing.scheduledFor, firing.status, firing.reason], [window(15).toISOString(), "admitted", null]);
  const requests = `/v1/conversations/${firing.conversationId}/requests`;
  const receipt = await g.api(`${requests}/${firing.requestId}`);
  assert.deepEqual(receipt.body.initiator, { kind: "routine", id: routine.routineId });
  await (await h.finish(firing)).commit();
  const audit = (await g.api("/v1/audit?conversationId=" + firing.conversationId)).body.events;
  assert.deepEqual(audit.map((event: { type: string; actor: unknown; initiator: unknown; payload: unknown }) =>
    [event.type, event.actor, event.initiator, event.payload]), [
    ["conversation.opened", { kind: "owner", id: h.ownerId }, { kind: "owner", id: h.ownerId }, { routineId: routine.routineId }],
    ["request.accepted", { kind: "owner", id: h.ownerId }, { kind: "routine", id: routine.routineId },
      { promptDigest: createHash("sha256").update("scheduled prompt").digest("hex") }],
    ["request.finished", { kind: "system", id: null }, { kind: "routine", id: routine.routineId }, { status: "completed" }],
  ]);

  // No body can claim a routine, and no caller can name one without its firing row.
  const strict = await g.api(requests, { requestId: randomUUID(), text: "mine", initiator: { kind: "routine", id: routine.routineId } });
  assert.deepEqual(strict, { status: 400, body: { error: "invalid_input" } });
  const own = { ownerId: h.ownerId, conversationId: firing.conversationId, requestId: randomUUID(), text: "a person's follow-up" };
  await assert.rejects(h.store.recordAcceptance(own, { kind: "routine", id: routine.routineId }), { code: "conflict" });
  assert.equal((await g.api(requests, { requestId: own.requestId, text: own.text })).body.initiator.kind, "owner",
    "an owner's request in a routine's conversation is the owner's");

  // A claimed firing's identity belongs to the routine: other text is a conflict, and the identical
  // request is the routine's request, so the dispatcher's retry finds it admitted.
  const [claimed] = await h.firings(heldBack.routineId);
  assert.equal(claimed.status, "claimed");
  const reserved = `/v1/conversations/${claimed.conversationId}/requests`;
  assert.deepEqual(await g.api(reserved, { requestId: claimed.requestId, text: "something else" }), { status: 409, body: { error: "conflict" } });
  const identical = await g.api(reserved, { requestId: claimed.requestId, text: "held back" });
  assert.deepEqual([identical.status, identical.body.initiator], [202, { kind: "routine", id: heldBack.routineId }]);
  h.advance(routineLimits.leaseMs);
  await dispatcher.tick();
  assert.equal((await h.firings(heldBack.routineId))[0].status, "admitted");
  // Another member cannot open a conversation a firing reserved.
  const other = await h.store.spawn({ ownerId: h.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const next = await h.create();
  h.at(window(30));
  const opens: unknown[] = [];
  const probe = new RoutineDispatcher({ store: h.store, owners: [h.ownerId], clock: h.clock, integration: h.integration,
    members: { async open(input: unknown) { opens.push(input); throw new Error("stop before opening"); }, accept: h.members.accept } as never });
  await probe.tick();
  const [reservedFiring] = (await h.firings(next.routineId));
  await assert.rejects(h.store.openConversation({ ownerId: h.ownerId, memberId: other.memberId, conversationId: reservedFiring.conversationId }),
    { code: "conflict" });
  assert.equal(opens.length >= 1, true);
});

test("the gateway runs the dispatcher on its clock and stops it when it closes", async (t) => {
  const h = await harness(t);
  const first = await h.create();
  const g = await gateway(t, h.store, h.members, () => window(15), h.ownerId);
  for (let i = 0; i < 50 && !(await h.firings(first.routineId)).length; i++) await delay(100);
  assert.deepEqual((await h.firings(first.routineId)).map(f => f.status), ["admitted"]);
  await g.stop();
  // Due at the gateway's clock: a loop still running would fire it within a second.
  const second = await h.create();
  await delay(2_500);
  assert.deepEqual(await h.firings(second.routineId), [], "no pass runs after the gateway closes");
});

test("migration 025 never queues for a lock, so it neither waits for a native turn nor deadlocks with an admission", async (t) => {
  const upgraded = await databaseAt(t, 24);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const digest = createHash("sha256").update("x").digest();
  await upgraded.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind)
    VALUES ($1,$2,$3,'owner')`, [conversationId, randomUUID(), digest]);

  // Locks on existing tables, and no rewrite of either altered table.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = `SELECT pg_relation_filenode('birbcrew_ts.request_admissions') AS admissions, pg_relation_filenode('birbcrew_ts.audit_events') AS audit`;
    const { rows: [before] } = await db.query(files);
    await db.query(await readFile(new URL("025-routines.sql", sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname NOT IN ('routines','routine_firings') ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "audit_events", mode: "AccessExclusiveLock" }, { relation: "audit_events", mode: "ShareLock" },
      { relation: "members", mode: "AccessShareLock" }, { relation: "members", mode: "ShareRowExclusiveLock" },
      { relation: "request_admissions", mode: "AccessExclusiveLock" },
    ]);
    const { rows: constraints } = await db.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conname IN ('request_admissions_initiator_kind_check','audit_events_initiator_check','audit_events_type_check') ORDER BY 1`);
    assert.ok(constraints.length === 3 && constraints.every(row => row.validated === false), JSON.stringify(constraints));
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  // An admission transaction holds request_admissions, then appends its audit row: the order in
  // which a queued exclusive lock on audit_events would deadlock it.
  const store = new MemberStore(upgraded);
  const holder = await upgraded.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
    await holder.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind)
      VALUES ($1,$2,$3,'owner')`, [conversationId, randomUUID(), digest]);
    let migrated = false;
    const migrating = store.migrate().then(() => { migrated = true; });
    for (let i = 0; i < 10; i++) {
      await delay(30);
      const { rows: waiting } = await upgraded.query(`SELECT pid FROM pg_locks WHERE NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      assert.deepEqual(waiting, [], "the migration retries instead of queueing");
    }
    assert.equal(migrated, false);
    const appended = Date.now();
    await holder.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,conversation_id,request_id,payload)
      VALUES ($1,'owner',$1,'owner',$1,'request.accepted',$2,$3,$4,'{"promptDigest":"${"0".repeat(64)}"}')`, [ownerId, memberId, conversationId, randomUUID()]);
    assert.ok(Date.now() - appended < 1_000, "the admission's audit append is not held up");
    await holder.query("COMMIT");
    await migrating;
  } finally { holder.release(); }
  const { rows: [version] } = await upgraded.query("SELECT count(*)::integer AS n FROM birbcrew_ts.schema_versions WHERE version=25");
  assert.equal(version.n, 1);
});

test("migration 025 completes while a native turn holds its admission", async (t) => {
  const upgraded = await databaseAt(t, 24);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID(), requestId = randomUUID(), text = "running at upgrade";
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  const current = new MemberStore(upgraded);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn({ ownerId, conversationId, requestId, text }, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, requestId, start.token, execution.workflowRunId, execution.activityId]);
  await withNativeAdmission(upgraded, { ownerId, conversationId, requestId, text, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([migrateThrough(current, 25).then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 025 must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId, token: start.token }, requestId + "/assistant", 0, "still running");
  });
  await current.migrate();
  await current.commitTurn({ ownerId, conversationId, requestId, token: start.token, reply: "still running", checkpoint: { version: 1, engine: "pi", state: {} } });
});
