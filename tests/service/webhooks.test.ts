import { migrateThrough, testDatabaseName } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { appendAudit, auditEventTypes } from "../../src/service/audit.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { HandoffApi } from "../../src/service/handoffs.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { MemoryApi } from "../../src/service/memories.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { InstallationRecovery, readRecoveryManifest, type RecoveryHooks, type RecoveryPins } from "../../src/service/recovery.ts";
import { FileRecoveryFence } from "../../src/service/recovery-fence.ts";
import { failReasons, RoutineApi, RoutineDispatcher, skipReasons } from "../../src/service/routines.ts";
import { MemberStore } from "../../src/service/store.ts";
import { recordSegmentUsage, UsageApi } from "../../src/service/usage.ts";
import type { ResolvedAddress, TargetPolicy } from "../../src/service/webhook-target.ts";
import { retryDelayMs, WebhookApi, WebhookDispatcher, webhookFormatNames, webhookKindNames, webhookKinds, webhookLimits, webhookMessage,
  type Clock, type WebhookFormat } from "../../src/service/webhooks.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
after(() => pool.end());
const sql = new URL("../../src/service/sql/", import.meta.url);
// This feature's migration, and the newest one in the directory, by file name: renumbering either moves the tests with it.
const migrations = (await readdir(sql)).sort();
const webhookMigration = migrations.find(file => file.endsWith("-webhooks.sql"))!;
const webhookVersion = Number(webhookMigration.split("-")[0]);

/** A fresh database, migrated up to `version`, dropped after the test. Every test that enables an
 * endpoint uses its own, so no other suite's gateway finds one to deliver to. */
async function databaseAt(t: TestContext, version = Infinity) {
  const name = testDatabaseName("webhooks_");
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

type Received = { path: string; headers: IncomingHttpHeaders; body: string; at: number };
type Reply = number | "hang" | { status: number; text: string };
/** A local receiver. `reply` decides each answer by path, or by the whole request; a status alone
 * answers "ok", and "hang" never answers. */
async function receiver(t: TestContext) {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const state = { reply: (_path: string, _request: { method: string; headers: IncomingHttpHeaders; body: string }): Reply => 200 };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    received.push({ path: request.url!, headers: request.headers, body, at: Date.now() });
    const answer = state.reply(request.url!, { method: request.method!, headers: request.headers, body });
    if (typeof answer === "number") response.writeHead(answer).end("ok");
    else if (answer !== "hang") response.writeHead(answer.status, { "Content-Type": "text/plain" }).end(answer.text);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); });
  const { port } = server.address() as { port: number };
  return { received, state, url: (name: string) => `http://127.0.0.1:${port}/${name}`, port };
}

const insecure: TargetPolicy = { allowInsecure: true };
const signature = (secret: string, timestamp: string, body: string) =>
  "v1=" + createHmac("sha256", Buffer.from(secret, "utf8")).update(timestamp + "." + body).digest("hex");

/** A fresh database, an owner with a member, a settable clock and a dispatcher factory. */
async function harness(t: TestContext, options: { policy?: TargetPolicy } = {}) {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  let now = new Date();
  const clock: Clock = () => new Date(now);
  const ownerId = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const policy = options.policy ?? insecure;
  const api = new WebhookApi(store, clock, policy);
  const conversation = async (owner = ownerId, memberId = member.memberId) => {
    const conversationId = randomUUID();
    await store.openConversation({ ownerId: owner, memberId, conversationId });
    return conversationId;
  };
  return {
    db, store, ownerId, member, api, clock, conversation,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    dispatcher: (extra: Partial<ConstructorParameters<typeof WebhookDispatcher>[0]> = {}) =>
      new WebhookDispatcher({ store, owners: [ownerId], clock, policy, ...extra }),
    create: async (url: string, kinds: readonly string[] = webhookKindNames, owner = ownerId, format: WebhookFormat = "crew") =>
      (await api.create(owner, { requestId: randomUUID(), url, kinds, format })) as Awaited<ReturnType<WebhookApi["create"]>> & { secret: string },
    /** A request.finished row, as commitTurn or a rejection appends it. */
    async finished(conversationId: string, status = "completed", owner = ownerId, memberId = member.memberId) {
      const requestId = randomUUID();
      await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: owner, memberId, conversationId, requestId,
        payload: { status: status as "completed" } }));
      return requestId;
    },
    deliveries: async (webhookId: string) => (await db.query(`SELECT event_id::text AS "eventId", kind, state, reason, attempts,
      last_outcome AS outcome, last_status_code AS status, next_attempt_at AS "nextAttemptAt" FROM birbcrew_ts.webhook_deliveries
      WHERE webhook_id=$1 ORDER BY event_id`, [webhookId])).rows,
    endpoint: async (webhookId: string) => (await db.query("SELECT * FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1", [webhookId])).rows[0],
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function pass(...dispatchers: WebhookDispatcher[]) {
  await Promise.all(dispatchers.map(d => d.tick()));
  await Promise.all(dispatchers.map(d => d.idle()));
}

/** Each kind once, through its real path where one exists: a card through the proposal path, a
 * finished request through the commit path, and the routine dispatcher's two rows as it appends
 * them. The prompt, note and reply carry marker text that no delivery may hold. */
async function everyKind(h: Harness, memberId = h.member.memberId) {
  const carded = await h.conversation(h.ownerId, memberId);
  const request: TurnRequest = { ownerId: h.ownerId, conversationId: carded, requestId: randomUUID(), text: "private PROMPT-MARKER" };
  await h.store.recordAcceptance(request, ownerInitiator);
  const turn = await h.store.beginTurn(request);
  if (turn.kind !== "start") throw new Error("the card's turn did not start");
  const approval = await new ApprovalStore(h.db).propose({ ownerId: h.ownerId, memberId, conversationId: carded,
    requestId: request.requestId, token: turn.token, invocationId: request.requestId, nativeCallId: "card",
    toolName: "record_work_item", arguments: { operation_id: request.requestId, note: "private NOTE-MARKER" } });
  const committed = await h.conversation(h.ownerId, memberId);
  const done = { ownerId: h.ownerId, conversationId: committed, requestId: randomUUID(), text: "another PROMPT-MARKER" };
  await h.store.recordAcceptance(done, ownerInitiator);
  const started = await h.store.beginTurn(done);
  if (started.kind !== "start") throw new Error("the finished request's turn did not start");
  await h.store.commitTurn({ ownerId: h.ownerId, conversationId: committed, requestId: done.requestId, token: started.token,
    reply: "private REPLY-MARKER", checkpoint: { version: 1, engine: "pi", state: {} } });
  const routineId = randomUUID();
  await h.store.transaction(async db => {
    await appendAudit(db, { type: "routine.firing_settled", ownerId: h.ownerId, memberId,
      payload: { routineId, scheduledFor: "2031-01-06T10:15:00.000Z", status: "failed", reason: "turn_failed" } });
    await appendAudit(db, { type: "routine.disabled", ownerId: h.ownerId, memberId, payload: { routineId, revision: 2, reason: "consecutive_failures" } });
  });
  return { carded, request, approval, committed, done, routineId };
}

/** The audit rows of every delivered kind, oldest first (or only `requestId`'s), with the eventId and
 * occurredAt a body states. */
async function deliveredEvents(db: Pool, requestId?: string) {
  return (await db.query<{ eventId: string; occurredAt: string }>(`SELECT event_id::text AS "eventId",
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt" FROM birbcrew_ts.audit_events
    WHERE event_type IN ('approval.requested','request.finished','routine.firing_settled','routine.disabled')
      AND ($1::uuid IS NULL OR request_id=$1::uuid) ORDER BY event_id`, [requestId ?? null])).rows;
}

async function gateway(t: TestContext, store: MemberStore, clock: Clock, webhookTargets: TargetPolicy) {
  const token = randomUUID(), stranger = randomUUID();
  const ownerId = "owner-" + randomUUID(), strangerId = "owner-" + randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const members = {} as MemberClient;
  const server = createGateway(store, members, { [hash(token)]: ownerId, [hash(stranger)]: strangerId }, { clock, webhookTargets });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const stop = async () => {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
    await server.stopped();
  };
  t.after(stop);
  async function api(path: string, body?: unknown, credential: string = token, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : undefined, text };
  }
  return { ownerId, strangerId, token, stranger, api, stop };
}

test("the webhook routes are strict, idempotent, owner-scoped and bounded, and return the secret once", async (t) => {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  // hooks.example.com resolves only here. No test event is deliverable, so nothing is ever sent to it.
  const answers: Record<string, ResolvedAddress[]> = { "hooks.example.com": [{ address: "93.184.215.14", family: 4 }],
    "internal.example.com": [{ address: "10.0.0.7", family: 4 }], "metadata.example.com": [{ address: "169.254.169.254", family: 4 }] };
  const g = await gateway(t, store, () => new Date(), { allowInsecure: false, lookup: async host => answers[host] ?? [] });
  const body = { requestId: randomUUID(), url: "https://hooks.example.com/crew/in?team=7", kinds: ["request.finished", "approval.pending"] };
  const created = await g.api("/v1/webhooks", body);
  assert.equal(created.status, 201, created.text);
  const { webhookId, secret, createdAt } = created.body;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.text.includes(secret), true);
  const view = { apiVersion: "1", webhookId, url: body.url, host: "hooks.example.com", kinds: ["approval.pending", "request.finished"],
    format: "crew", state: "enabled", disabledReason: null, consecutiveFailures: 0, createdAt };
  assert.deepEqual({ ...created.body, secret: undefined }, { ...view, secret: undefined });
  // A replay is the same endpoint without its secret, which no route returns again.
  assert.deepEqual(await g.api("/v1/webhooks", { ...body, kinds: [...body.kinds].reverse() }), { status: 201, body: view, text: JSON.stringify(view) });
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, url: "https://hooks.example.com/other" })).body, { error: "conflict" });
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, kinds: ["request.finished"] })).body, { error: "conflict" });
  // The format is part of the definition: an endpoint created without one is `crew`, and another format is another endpoint.
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, format: "crew" })).body, view);
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, format: "slack" })).body, { error: "conflict" });
  const path = `/v1/webhooks/${webhookId}`;
  assert.deepEqual((await g.api(path)).body, view);
  assert.deepEqual((await g.api(`/v1/webhooks/${webhookId.toUpperCase()}`)).body, view);
  assert.deepEqual((await g.api("/v1/webhooks")).body, { apiVersion: "1", webhooks: [view], nextAfter: webhookId, hasMore: false });
  for (const response of [await g.api(path), await g.api("/v1/webhooks")]) assert.equal(response.text.includes(secret), false);

  const fresh = (fields: Record<string, unknown>) => ({ requestId: randomUUID(), url: "https://hooks.example.com/x", kinds: ["request.finished"], ...fields });
  for (const invalid of [fresh({ ownerId: g.ownerId }), fresh({ secret: "chosen" }), fresh({ kinds: [] }), fresh({ kinds: ["request.finished", "request.finished"] }),
    fresh({ kinds: ["member.spawned"] }), fresh({ kinds: "request.finished" }), fresh({ url: 7 }), fresh({ url: "" }), fresh({ requestId: "nope" }),
    fresh({ format: "email" }), fresh({ format: "Slack" }), fresh({ format: null }), fresh({ format: ["slack"] }),
    { url: "https://hooks.example.com/x", kinds: ["request.finished"] }]) {
    assert.deepEqual(await g.api("/v1/webhooks", invalid), { status: 400, body: { error: "invalid_input" }, text: '{"error":"invalid_input"}' },
      JSON.stringify(invalid));
  }
  // The target is checked before anything is written, and the reason is not reported.
  for (const target of ["http://hooks.example.com/x", "https://user:pw@hooks.example.com/x", "https://hooks.example.com/x#f", "https://127.0.0.1/x",
    "https://169.254.169.254/latest", "https://internal.example.com/x", "https://metadata.example.com/x", "https://unknown.example.com/x"]) {
    assert.deepEqual((await g.api("/v1/webhooks", fresh({ url: target }))).body, { error: "target_refused" }, target);
  }
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.webhook_endpoints")).rows[0].n, 1);

  // Another owner's endpoint is 404 on every route, and their list is empty.
  for (const [route, payload, method] of [[path, undefined, "GET"], [path + "/enable", {}, "POST"], [path + "/disable", {}, "POST"],
    [path, undefined, "DELETE"], [path + "/deliveries", undefined, "GET"]] as const) {
    assert.deepEqual((await g.api(route, payload, g.stranger, method)).body, { error: "not_found" }, `${method} ${route}`);
  }
  assert.deepEqual((await g.api("/v1/webhooks", undefined, g.stranger)).body.webhooks, []);
  assert.deepEqual((await g.api("/v1/webhooks", body, g.stranger)).status, 201, "a requestId is scoped to its owner");
  assert.equal((await g.api("/v1/webhooks", undefined, "invalid")).status, 401);
  assert.equal((await g.api("/v1/webhooks", {}, g.token, "PUT")).status, 405);
  assert.equal((await g.api(path + "/enable", { force: true })).status, 400);
  assert.equal((await g.api(path + "/deliveries", {})).status, 405);
  assert.equal((await g.api("/webhooks")).status, 404);
  for (const query of ["?limit=0", "?limit=101", "?before=0", "?before=-1", "?before=9223372036854775808", "?after=1", "?limit=1&limit=2", "?__proto__=1"]) {
    assert.deepEqual((await g.api(path + "/deliveries" + query)).body, { error: "invalid_input" }, query);
  }
  for (const query of ["?after=not-a-uuid", "?limit=1&limit=1", "?limit=101", "?before=1"]) {
    assert.deepEqual((await g.api("/v1/webhooks" + query)).body, { error: "invalid_input" }, query);
  }
  assert.deepEqual((await g.api(path + "?x=1")).body, { error: "invalid_input" });
  assert.deepEqual((await g.api(path + "/deliveries")).body, { apiVersion: "1", deliveries: [], nextBefore: null, hasMore: false });

  // Lifecycle: repeating a state changes nothing; a tombstone erases the URL and the secret.
  const disabled = await g.api(path + "/disable", {});
  assert.deepEqual([disabled.status, disabled.body.state, disabled.body.disabledReason], [200, "disabled", "owner"]);
  assert.deepEqual(await g.api(path + "/disable", {}), disabled);
  assert.deepEqual((await g.api(path + "/enable", {})).body, view);
  const deleted = await g.api(path, undefined, g.token, "DELETE");
  assert.deepEqual(deleted.body, { ...view, url: null, state: "deleted" });
  assert.deepEqual((await db.query("SELECT url, secret, host FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1", [webhookId])).rows,
    [{ url: null, secret: null, host: "hooks.example.com" }]);
  assert.deepEqual(await g.api(path, undefined, g.token, "DELETE"), deleted);
  for (const action of ["/enable", "/disable"]) assert.deepEqual((await g.api(path + action, {})).body, { error: "webhook_deleted" });
  assert.deepEqual((await g.api("/v1/webhooks", body)).body, { error: "webhook_deleted" }, "a replay never revives a deleted endpoint");

  // At most ten enabled endpoints: an eleventh create or a re-enable past the limit is refused.
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push((await g.api("/v1/webhooks", fresh({}))).body.webhookId);
  assert.deepEqual((await g.api("/v1/webhooks", fresh({}))).body, { error: "webhook_limit" });
  await g.api(`/v1/webhooks/${ten[0]}/disable`, {});
  const eleventh = await g.api("/v1/webhooks", fresh({}));
  assert.equal(eleventh.status, 201);
  assert.deepEqual((await g.api(`/v1/webhooks/${ten[0]}/enable`, {})).body, { error: "webhook_limit" });
  const page = (await g.api("/v1/webhooks?limit=5")).body;
  assert.deepEqual([page.webhooks.length, page.hasMore], [5, true]);
  const rest = (await g.api("/v1/webhooks?after=" + page.nextAfter)).body;
  assert.equal(page.webhooks.length + rest.webhooks.length, 12);

  // The trail names the owner and the host, never the URL path or the secret.
  const audit = await g.api("/v1/audit?limit=1000");
  const rows = audit.body.events.filter((event: { payload: { webhookId?: string } }) => event.payload.webhookId === webhookId);
  assert.deepEqual(rows.map((event: Record<string, unknown>) => [event.type, event.actor, event.memberId, event.conversationId, event.payload]), [
    ["webhook.created", { kind: "owner", id: g.ownerId }, null, null,
      { webhookId, revision: 1, host: "hooks.example.com", kinds: ["approval.pending", "request.finished"], format: "crew" }],
    ["webhook.disabled", { kind: "owner", id: g.ownerId }, null, null, { webhookId, revision: 2, host: "hooks.example.com", reason: "owner" }],
    ["webhook.enabled", { kind: "owner", id: g.ownerId }, null, null, { webhookId, revision: 3, host: "hooks.example.com" }],
    ["webhook.deleted", { kind: "owner", id: g.ownerId }, null, null, { webhookId, revision: 4, host: "hooks.example.com" }],
  ]);
  const csv = (await g.api("/v1/audit?format=csv&limit=10000")).text;
  for (const exported of [audit.text, csv]) {
    assert.ok(!exported.includes(secret) && !exported.includes("/crew/in") && !exported.includes("team=7"));
  }
  assert.match(csv, new RegExp(`,webhook\\.created,owner,${g.ownerId},owner,${g.ownerId},,,,`));
  const capabilities = (await g.api("/v1/capabilities")).body;
  assert.deepEqual([capabilities.webhooks.route, capabilities.webhooks.kinds, capabilities.webhooks.maximumEnabledPerOwner, capabilities.webhooks.schemes],
    ["/v1/webhooks", ["approval.pending", "request.finished", "routine.firing_settled", "routine.disabled"], 10, ["https"]]);
  assert.deepEqual([capabilities.webhooks.formats, capabilities.webhooks.defaultFormat, capabilities.webhooks.signature.formats],
    [["crew", "slack", "ntfy"], "crew", ["crew"]]);
  for (const type of ["approval.requested", "webhook.created", "webhook.enabled", "webhook.disabled", "webhook.deleted"]) {
    assert.ok(capabilities.audit.eventTypes.includes(type), type);
  }
});

test("the gateway runs the webhook dispatcher for the owners it serves and stops it when it closes", async (t) => {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  const r = await receiver(t);
  const g = await gateway(t, store, () => new Date(), insecure);
  const created = await g.api("/v1/webhooks", { requestId: randomUUID(), url: r.url("gateway"), kinds: ["request.finished"] });
  assert.equal(created.status, 201, created.text);
  const { memberId } = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const conversationId = randomUUID(), requestId = randomUUID();
  await store.openConversation({ ownerId: g.ownerId, memberId, conversationId });
  await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: g.ownerId, memberId, conversationId, requestId,
    payload: { status: "cancelled", reason: "predecessor_cancelled" } }));
  for (let i = 0; i < 200 && !r.received.length; i++) await delay(25);
  assert.equal(r.received.length, 1, "the gateway's own loop delivered it");
  const [item] = r.received;
  assert.equal(item.headers["crew-webhook-signature"], signature(created.body.secret, item.headers["crew-webhook-timestamp"] as string, item.body));
  assert.deepEqual(JSON.parse(item.body).status, "cancelled");
  for (let i = 0; i < 40; i++) {
    if ((await g.api(`/v1/webhooks/${created.body.webhookId}/deliveries`)).body.deliveries[0]?.state === "delivered") break;
    await delay(25);
  }
  assert.deepEqual((await g.api(`/v1/webhooks/${created.body.webhookId}/deliveries`)).body.deliveries.map((d: { state: string }) => d.state), ["delivered"]);
  // Closed, the gateway sends nothing more.
  await g.stop();
  await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: g.ownerId, memberId, conversationId, requestId: randomUUID(),
    payload: { status: "completed" } }));
  await delay(2_500);
  assert.equal(r.received.length, 1);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.webhook_deliveries")).rows[0].n, 1, "nor fans anything out");
});

test("concurrent creates never pass ten enabled endpoints, and a concurrent duplicate is one endpoint with one secret", async (t) => {
  const h = await harness(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => h.create(`http://127.0.0.1:9/${i}`)));
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 10);
  assert.ok(outcomes.every(o => o.status === "fulfilled" || (o.reason as { code?: string }).code === "webhook_limit"));
  const other = "owner-" + randomUUID();
  const body = { requestId: randomUUID(), url: "http://127.0.0.1:9/same", kinds: ["request.finished"] };
  const both = await Promise.all([h.api.create(other, body), h.api.create(other, body)]);
  assert.equal(new Set(both.map(view => view.webhookId)).size, 1);
  assert.equal(both.filter(view => "secret" in view).length, 1, "only the create that inserted it returns the secret");
  assert.equal((await h.db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type='webhook.created' AND owner_id=$1",
    [other])).rows[0].n, 1);
});

test("each kind is delivered once to each endpoint that selected it, signed, with identifiers and a status only", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const before = await h.conversation();
  await h.finished(before);
  const all = await h.create(r.url("all"));
  const finishedOnly = await h.create(r.url("finished"), ["request.finished"]);

  const { carded, request, approval, committed, done, routineId } = await everyKind(h);
  // An owner's own disable is not delivered.
  await h.store.transaction(db => appendAudit(db, { type: "routine.disabled", ownerId: h.ownerId, memberId: h.member.memberId,
    payload: { routineId: randomUUID(), revision: 2, reason: "owner" } }));

  const dispatcher = h.dispatcher();
  // One pass sends every due delivery: an endpoint's deliveries go one after another.
  await pass(dispatcher);
  const [, card, finished, settled, exhausted] = await deliveredEvents(h.db);
  const envelope = (event: { eventId: string; occurredAt: string }, kind: string, webhookId: string) =>
    ({ webhookId, eventId: event.eventId, kind, occurredAt: event.occurredAt, memberId: h.member.memberId });
  const expected = (webhookId: string) => [
    { ...envelope(card, "approval.pending", webhookId), conversationId: carded, requestId: request.requestId, approvalId: approval.approvalId,
      toolName: "record_work_item" },
    { ...envelope(finished, "request.finished", webhookId), conversationId: committed, requestId: done.requestId, status: "completed" },
    { ...envelope(settled, "routine.firing_settled", webhookId), routineId, scheduledFor: "2031-01-06T10:15:00.000Z", status: "failed" },
    { ...envelope(exhausted, "routine.disabled", webhookId), routineId, status: "consecutive_failures" },
  ];
  const at = (name: string) => r.received.filter(item => item.path === "/" + name);
  // The event before the endpoint existed is not sent; the others are, once each.
  assert.deepEqual(at("all").map(item => JSON.parse(item.body)), expected(all.webhookId));
  assert.deepEqual(at("finished").map(item => JSON.parse(item.body)), expected(finishedOnly.webhookId).slice(1, 2));
  const timestamp = String(Math.floor(h.clock().getTime() / 1000));
  for (const [item, secret, webhookId] of [...at("all").map(item => [item, all.secret, all.webhookId] as const),
    ...at("finished").map(item => [item, finishedOnly.secret, finishedOnly.webhookId] as const)]) {
    assert.equal(item.headers["crew-webhook-timestamp"], timestamp);
    assert.equal(item.headers["crew-webhook-signature"], signature(secret, timestamp, item.body));
    assert.equal(item.headers["crew-webhook-id"], webhookId);
    assert.equal(item.headers["crew-webhook-event"], JSON.parse(item.body).eventId);
    assert.equal(item.headers["content-type"], "application/json");
    assert.equal(item.headers.authorization ?? item.headers.cookie, undefined);
    assert.ok(Buffer.byteLength(item.body) <= 1024);
    for (const marker of ["PROMPT-MARKER", "NOTE-MARKER", "REPLY-MARKER", secret]) assert.ok(!item.body.includes(marker), marker);
  }
  // A signature made with the other endpoint's secret does not verify.
  assert.notEqual(at("finished")[0].headers["crew-webhook-signature"], signature(all.secret, timestamp, at("finished")[0].body));

  const listed = await h.api.deliveries(h.ownerId, all.webhookId, {});
  assert.deepEqual(listed.deliveries.map(d => [d.eventId, d.kind, d.state, d.attempts, d.lastOutcome, d.lastStatusCode, d.reason]),
    ([[exhausted, "routine.disabled"], [settled, "routine.firing_settled"], [finished, "request.finished"], [card, "approval.pending"]] as const)
      .map(([event, kind]) => [event.eventId, kind, "delivered", 1, "delivered", 200, null]));
  const older = await h.api.deliveries(h.ownerId, all.webhookId, { limit: "2", before: exhausted.eventId });
  assert.deepEqual([older.deliveries.map(d => d.eventId), older.nextBefore, older.hasMore], [[settled.eventId, finished.eventId], finished.eventId, true]);
  // Nothing more is sent on later passes.
  await pass(dispatcher);
  assert.equal(r.received.length, 5);
});

/** Runs `change` while another session holds every webhook table ACCESS EXCLUSIVE, as a stalled
 * dispatcher could. No audited transaction touches those tables, so the change commits at once. */
async function whileWebhookTablesLocked<T>(h: Harness, change: () => Promise<T>): Promise<T> {
  const blocker = await h.db.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE birbcrew_ts.webhook_deliveries, birbcrew_ts.webhook_endpoints, birbcrew_ts.webhook_cursor IN ACCESS EXCLUSIVE MODE");
    return await Promise.race([change(),
      delay(5_000, undefined, { ref: false }).then((): never => { throw new Error("the change waited on a webhook table"); })]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
}
/** Text a member's owner or model wrote, which no body or header may carry. */
const privateText = ["PROMPT-MARKER", "NOTE-MARKER", "REPLY-MARKER", "INSTRUCTIONS-MARKER", "MEMORY-MARKER"];
function assertCarriesNoText(received: Received[], ...more: string[]) {
  assert.ok(received.length > 0);
  for (const item of received) {
    for (const text of [...privateText, ...more]) assert.ok(!item.body.includes(text) && !JSON.stringify(item.headers).includes(text), text);
  }
}
const bodyKeys = {
  "approval.pending": ["approvalId", "conversationId", "eventId", "kind", "memberId", "occurredAt", "requestId", "toolName", "webhookId"],
  "request.finished": ["conversationId", "eventId", "kind", "memberId", "occurredAt", "requestId", "status", "webhookId"],
};

test("an expired card is delivered as pending and then as its request's finish, which carries no expiry mark and no text", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("all"));
  const instructed = await h.store.spawn({ ownerId: h.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture",
    instructions: "INSTRUCTIONS-MARKER" });
  await new MemoryApi(h.store).create(h.ownerId, { requestId: randomUUID(), memberId: instructed.memberId, text: "MEMORY-MARKER" });
  const conversationId = await h.conversation(h.ownerId, instructed.memberId);
  const request: TurnRequest = { ownerId: h.ownerId, conversationId, requestId: randomUUID(), text: "PROMPT-MARKER", approvalDeadlineSeconds: 60 };
  await h.store.recordAcceptance(request, ownerInitiator);
  const turn = await h.store.beginTurn(request);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  const approvals = new ApprovalStore(h.db);
  const card = await approvals.propose({ ownerId: h.ownerId, memberId: instructed.memberId, conversationId, requestId: request.requestId,
    token: turn.token, invocationId: request.requestId, nativeCallId: "expiring", toolName: "record_work_item",
    arguments: { operation_id: request.requestId, note: "NOTE-MARKER" } });
  assert.ok(card.expiresAt, "the card has its request's deadline");
  await h.db.query("UPDATE birbcrew_ts.deferred_calls SET expires_at=clock_timestamp() WHERE approval_id=$1", [card.approvalId]);
  // The workflow's timer settles the expiry; it commits while every webhook table is locked.
  assert.deepEqual(await whileWebhookTablesLocked(h, () => approvals.expireTurn(card)), { kind: "expired" });
  // The turn goes on to its reply with the cancelled result, as after an owner's cancel.
  await h.store.commitTurn({ ownerId: h.ownerId, conversationId, requestId: request.requestId, token: turn.token, reply: "REPLY-MARKER",
    checkpoint: { version: 1, engine: "pi", state: {} } });
  await pass(h.dispatcher());

  const { rows: trail } = await h.db.query(`SELECT event_id::text AS "eventId", event_type AS type FROM birbcrew_ts.audit_events
    WHERE conversation_id=$1 AND request_id IS NOT NULL ORDER BY event_id`, [conversationId]);
  assert.deepEqual(trail.map(row => row.type), ["request.accepted", "approval.requested", "approval.expired", "request.finished"]);
  const bodies = r.received.map(item => JSON.parse(item.body));
  // approval.expired is no kind: the request's finish is the delivery that follows the pending one.
  assert.deepEqual(bodies.map(body => [body.kind, body.eventId, body.memberId, body.conversationId, body.requestId]), [
    ["approval.pending", trail[1].eventId, instructed.memberId, conversationId, request.requestId],
    ["request.finished", trail[3].eventId, instructed.memberId, conversationId, request.requestId],
  ]);
  assert.equal(bodies[0].approvalId, card.approvalId);
  // A finish after an expiry looks like any other: the receipt's expiredApproval tells them apart.
  assert.deepEqual([Object.keys(bodies[0]).sort(), Object.keys(bodies[1]).sort(), bodies[1].status],
    [bodyKeys["approval.pending"], bodyKeys["request.finished"], "completed"]);
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.kind, d.state]), [["approval.pending", "delivered"], ["request.finished", "delivered"]]);
  assertCarriesNoText(r.received, endpoint.secret);
});

test("a handoff's reserved request is delivered as the target's finish without its transcript, and the handoff itself is not", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("all"));
  const target = await h.store.spawn({ ownerId: h.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture",
    instructions: "INSTRUCTIONS-MARKER" });
  await new MemoryApi(h.store).create(h.ownerId, { requestId: randomUUID(), memberId: target.memberId, text: "MEMORY-MARKER" });
  const checkpoint = { version: 1 as const, engine: "pi" as const, state: {} };
  // The source's one committed turn is what the transcript carries.
  const source = await h.conversation();
  const first: TurnRequest = { ownerId: h.ownerId, conversationId: source, requestId: randomUUID(), text: "PROMPT-MARKER" };
  await h.store.recordAcceptance(first, ownerInitiator);
  const turn = await h.store.beginTurn(first);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  await h.store.commitTurn({ ownerId: h.ownerId, conversationId: source, requestId: first.requestId, token: turn.token, reply: "REPLY-MARKER",
    checkpoint });
  const members = {
    open: (input: Parameters<MemberStore["openConversation"]>[0]) => h.store.openConversation(input),
    async accept(input: TurnRequest) { await h.store.recordAcceptance(input, ownerInitiator); return { requestId: input.requestId }; },
  } as unknown as MemberClient;
  // The handoff transaction and the reserved request's admission commit while every webhook table is locked.
  const handoff = await whileWebhookTablesLocked(h, () => new HandoffApi(h.store, members).create(h.ownerId, source,
    { requestId: randomUUID(), memberId: target.memberId }));
  assert.equal(handoff.firstRequestAdmitted, true);
  const { rows: [{ transcript }] } = await h.db.query<{ transcript: string }>(
    "SELECT transcript FROM birbcrew_ts.conversation_handoffs WHERE handoff_id=$1", [handoff.handoffId]);
  assert.ok(transcript.includes("PROMPT-MARKER") && transcript.includes("REPLY-MARKER"), "the transcript quotes the source");
  const reserved = { ownerId: h.ownerId, conversationId: handoff.target.conversationId, requestId: handoff.firstRequestId };
  const delivered = await h.store.beginTurn({ ...reserved, text: transcript });
  assert.equal(delivered.kind, "start"); if (delivered.kind !== "start") return;
  await h.store.commitTurn({ ...reserved, token: delivered.token, reply: "TARGET-MARKER", checkpoint });
  await pass(h.dispatcher());

  const bodies = r.received.map(item => JSON.parse(item.body));
  assert.deepEqual(bodies.map(body => [body.kind, body.memberId, body.conversationId, body.requestId, body.status]), [
    ["request.finished", h.member.memberId, source, first.requestId, "completed"],
    ["request.finished", target.memberId, reserved.conversationId, reserved.requestId, "completed"],
  ]);
  // The body names no initiator; the trail and the receipt say the handoff started the request.
  assert.deepEqual(Object.keys(bodies[1]).sort(), bodyKeys["request.finished"]);
  const { rows } = await h.db.query(`SELECT event_type AS type, initiator_kind AS kind, initiator_id AS id FROM birbcrew_ts.audit_events
    WHERE request_id=$1 OR event_type='conversation.handed_off' ORDER BY event_id`, [reserved.requestId]);
  assert.deepEqual(rows, [{ type: "conversation.handed_off", kind: "owner", id: h.ownerId },
    { type: "request.accepted", kind: "handoff", id: handoff.handoffId }, { type: "request.finished", kind: "handoff", id: handoff.handoffId }]);
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => d.kind), ["request.finished", "request.finished"]);
  assertCarriesNoText(r.received, transcript, "TARGET-MARKER", endpoint.secret);
});

test("a request refused for its budget sends nothing; a routine's refused firings and its switch-off are delivered", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("all"));
  // Spend the member's day: one finished request that reported 10 tokens.
  const spent = await h.conversation();
  const request: TurnRequest = { ownerId: h.ownerId, conversationId: spent, requestId: randomUUID(), text: "metered" };
  await h.store.recordAcceptance(request, ownerInitiator);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const turn = await h.store.beginTurn(request, execution);
  assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
  await h.db.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [spent, request.requestId, turn.token, execution.workflowRunId, execution.activityId]);
  await recordSegmentUsage(h.db, { ...request, token: turn.token, execution }, { state: "reported", model: "m", inputTokens: 10,
    outputTokens: 0, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null });
  await h.store.commitTurn({ ownerId: h.ownerId, conversationId: spent, requestId: request.requestId, token: turn.token, reply: "done",
    checkpoint: { version: 1, engine: "pi", state: {} } });
  await new UsageApi(h.store).setBudget(h.ownerId, h.member.memberId, { tokenLimit: 10 });
  // A refusal at admission is audited in its own transaction, which never waits on a webhook table.
  const refused = await h.conversation();
  await whileWebhookTablesLocked(h, () => assert.rejects(h.store.recordAcceptance({ ownerId: h.ownerId, conversationId: refused,
    requestId: randomUUID(), text: "over budget" }, ownerInitiator), { code: "usage_limit" }));
  // A routine on the member, one failure from its switch-off: two firings are refused for the budget.
  let now = new Date("2031-01-06T10:00:00.000Z");
  const clock = () => new Date(now);
  const members = {
    open: (input: Parameters<MemberStore["openConversation"]>[0]) => h.store.openConversation(input),
    async accept(input: TurnRequest) {
      await h.store.checkAdmission(input);
      await h.store.recordAcceptance(input, ownerInitiator);
      return { requestId: input.requestId };
    },
    requestStatus: (input: Parameters<MemberStore["requestStatus"]>[0]) => h.store.requestStatus(input),
    async cancelPending() {},
  } as unknown as MemberClient;
  const { routineId } = await new RoutineApi(h.store, clock).create(h.ownerId, { requestId: randomUUID(), memberId: h.member.memberId,
    schedule: "*/15 * * * *", prompt: "scheduled PROMPT-MARKER", approvalPolicy: "wait" });
  await h.db.query("UPDATE birbcrew_ts.routines SET consecutive_failures=8 WHERE routine_id=$1", [routineId]);
  const routines = new RoutineDispatcher({ store: h.store, members, integration: new IntegrationApi(h.store, members), owners: [h.ownerId], clock });
  t.after(() => routines.stop());
  // The budget pre-check, each firing's settlement and the switch-off commit while every webhook table is locked.
  await whileWebhookTablesLocked(h, async () => {
    for (const minutes of [15, 30]) {
      now = new Date(Date.parse("2031-01-06T10:00:00.000Z") + minutes * 60_000);
      await routines.tick();
    }
  });
  await pass(h.dispatcher());

  const { rows: refusals } = await h.db.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type='usage.request_refused'");
  assert.equal(refusals[0].n, 3, "the direct request and both firings were refused and audited");
  const bodies = r.received.map(item => JSON.parse(item.body));
  assert.deepEqual(bodies.map(body => [body.kind, body.status, body.routineId ?? body.requestId]), [
    ["request.finished", "completed", request.requestId],
    ["routine.firing_settled", "failed", routineId],
    ["routine.firing_settled", "failed", routineId],
    ["routine.disabled", "consecutive_failures", routineId],
  ]);
  const { rows: settled } = await h.db.query(`SELECT payload->>'reason' AS reason FROM birbcrew_ts.audit_events
    WHERE event_type='routine.firing_settled' ORDER BY event_id`);
  assert.deepEqual(settled.map(row => row.reason), ["usage_limit", "usage_limit"]);
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => d.state), ["delivered", "delivered", "delivered", "delivered"]);
  assertCarriesNoText(r.received, endpoint.secret);
});

test("every routine firing outcome the trail records is delivered with its status", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  await h.create(r.url("in"), ["routine.firing_settled"]);
  // From the dispatcher's own lists, so a reason it gains is covered here too.
  const outcomes = [["succeeded", undefined] as const, ...skipReasons.map(reason => ["skipped", reason] as const),
    ...failReasons.map(reason => ["failed", reason] as const)];
  assert.ok(failReasons.includes("usage_limit") && failReasons.includes("approval_expired"));
  const routineId = randomUUID();
  await h.store.transaction(async db => {
    for (const [i, [status, reason]] of outcomes.entries()) {
      await appendAudit(db, { type: "routine.firing_settled", ownerId: h.ownerId, memberId: h.member.memberId, payload: { routineId,
        scheduledFor: new Date(Date.UTC(2031, 0, 6, 10, 15 * i)).toISOString(), status, ...(reason && { reason }) } });
    }
  });
  await pass(h.dispatcher());
  assert.deepEqual(r.received.map(item => JSON.parse(item.body).status), outcomes.map(([status]) => status));
  // The statuses come from the audit registry; a value it gains changes what receivers get, so it must change this list
  // and docs/webhooks.md with it.
  assert.deepEqual([webhookKinds["request.finished"].body.shape.status.options, webhookKinds["routine.firing_settled"].body.shape.status.options],
    [["completed", "failed", "cancelled", "uncertain"], ["succeeded", "failed", "skipped"]]);
});

for (const format of webhookFormatNames) test(`a failed attempt is retried with exponential backoff; the tenth gives up; a success resets the count (${format})`, async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"], h.ownerId, format);
  const conversationId = await h.conversation();
  r.state.reply = () => 503;
  await h.finished(conversationId);
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  let [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome, delivery.status], ["pending", 1, "http_status", 503]);
  assert.equal(delivery.nextAttemptAt.getTime() - h.clock().getTime(), 30_000);
  // Not due yet: nothing is sent.
  await pass(dispatcher);
  assert.equal(r.received.length, 1);
  const waits: number[] = [];
  for (let attempt = 2; attempt <= webhookLimits.maximumAttempts; attempt++) {
    h.advance(delivery.nextAttemptAt.getTime() - h.clock().getTime());
    await pass(dispatcher);
    [delivery] = await h.deliveries(endpoint.webhookId);
    if (delivery.nextAttemptAt) waits.push(delivery.nextAttemptAt.getTime() - h.clock().getTime());
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
  assert.deepEqual(waits, [2, 3, 4, 5, 6, 7, 8, 9].map(retryDelayMs));
  assert.deepEqual([delivery.state, delivery.reason, delivery.attempts, delivery.outcome], ["failed", "attempts_exhausted", 10, "http_status"]);
  assert.equal(r.received.length, 10);
  assert.equal(new Set(r.received.map(item => item.body)).size, 1, "every attempt sends the same bytes");
  assert.equal((await h.endpoint(endpoint.webhookId)).consecutive_failures, 1);
  h.advance(24 * 3_600_000);
  await pass(dispatcher);
  assert.equal(r.received.length, 10, "a failed delivery is never sent again");

  // The next one succeeds on its second attempt, which resets the count.
  await h.finished(conversationId);
  await pass(dispatcher);
  r.state.reply = () => 204;
  h.advance(30_000);
  await pass(dispatcher);
  const [, second] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([second.state, second.attempts, second.outcome, second.status], ["delivered", 2, "delivered", 204]);
  assert.equal((await h.endpoint(endpoint.webhookId)).consecutive_failures, 0);
});

test("ten deliveries given up in a row disable the endpoint and cancel what it has not delivered", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = () => 500;
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  for (let i = 0; i < 11; i++) await h.finished(conversationId);
  const dispatcher = h.dispatcher();
  for (let i = 0; i < 120 && (await h.endpoint(endpoint.webhookId)).state === "enabled"; i++) {
    await pass(dispatcher);
    h.advance(webhookLimits.retryCapMs);
  }
  const row = await h.endpoint(endpoint.webhookId);
  assert.deepEqual([row.state, row.disabled_reason, row.consecutive_failures, row.enabled_at], ["disabled", "consecutive_failures", 10, null]);
  // Each pass gave every due delivery one attempt; the eleventh still had its last to go.
  const deliveries = await h.deliveries(endpoint.webhookId);
  assert.deepEqual(deliveries.map(d => [d.state, d.reason, d.attempts]),
    [...Array(10).fill(["failed", "attempts_exhausted", 10]), ["cancelled", "endpoint_disabled", 9]]);
  assert.equal(r.received.length, 109);
  const { rows: audit } = await h.db.query(`SELECT actor_kind AS actor, actor_id AS "actorId", member_id AS "memberId", payload
    FROM birbcrew_ts.audit_events WHERE event_type='webhook.disabled'`);
  assert.deepEqual(audit, [{ actor: "system", actorId: null, memberId: null,
    payload: { webhookId: endpoint.webhookId, revision: 2, host: `127.0.0.1:${r.port}`, reason: "consecutive_failures" } }]);
  // A disabled endpoint receives nothing, including events that occur while it is disabled.
  await h.finished(conversationId);
  h.advance(webhookLimits.retryCapMs);
  await pass(dispatcher);
  assert.equal(r.received.length, 109);
  // Enabling resets the count; only events from then on are delivered.
  r.state.reply = () => 200;
  const enabled = await h.api.change(h.ownerId, endpoint.webhookId, "enable");
  assert.deepEqual([enabled.state, enabled.consecutiveFailures, enabled.disabledReason], ["enabled", 0, null]);
  const later = await h.finished(conversationId);
  await pass(dispatcher);
  assert.deepEqual(r.received.slice(109).map(item => JSON.parse(item.body).requestId), [later]);
});

test("a slow or dead endpoint holds up only its own deliveries, and a timeout is retried", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = path => path === "/slow" ? "hang" : 200;
  const slow = await h.create(r.url("slow"), ["request.finished"]);
  const fast = await h.create(r.url("fast"), ["request.finished"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  const dispatcher = h.dispatcher({ timeouts: { connectMs: 1_000, totalMs: 3_000 } });
  const started = Date.now();
  await dispatcher.tick();
  // The pass does not wait for the hanging endpoint, and the other endpoint already has its delivery.
  assert.ok(Date.now() - started < 1_000, "the pass returns before the slow attempt settles");
  for (let i = 0; i < 50 && !r.received.some(item => item.path === "/fast"); i++) await delay(20);
  const fastAt = r.received.find(item => item.path === "/fast")!.at;
  assert.ok(fastAt - started < 1_000);
  // While its attempt is in flight, this process does not start another for the slow endpoint.
  await h.finished(conversationId);
  await dispatcher.tick();
  await delay(300);
  assert.equal(r.received.filter(item => item.path === "/slow").length, 1);
  assert.deepEqual((await h.deliveries(slow.webhookId)).map(d => [d.state, d.attempts]), [["delivering", 1], ["pending", 0]]);
  assert.equal(r.received.filter(item => item.path === "/fast").length, 2, "the other endpoint's second delivery went at once");
  await dispatcher.idle();
  const [first] = await h.deliveries(slow.webhookId);
  assert.deepEqual([first.state, first.outcome, first.status, first.attempts], ["pending", "timeout", null, 1]);
  assert.deepEqual((await h.deliveries(fast.webhookId)).map(d => d.state).slice(0, 1), ["delivered"]);
  // A change committed while the receiver hangs commits at once: the change never waits on delivery.
  const blocker = await h.db.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE birbcrew_ts.webhook_deliveries, birbcrew_ts.webhook_endpoints, birbcrew_ts.webhook_cursor IN ACCESS EXCLUSIVE MODE");
    const committing = Date.now();
    await h.finished(conversationId);
    const request: TurnRequest = { ownerId: h.ownerId, conversationId: await h.conversation(), requestId: randomUUID(), text: "p" };
    await h.store.recordAcceptance(request, ownerInitiator);
    const turn = await h.store.beginTurn(request);
    assert.equal(turn.kind, "start"); if (turn.kind !== "start") return;
    await new ApprovalStore(h.db).propose({ ownerId: h.ownerId, memberId: h.member.memberId, conversationId: request.conversationId,
      requestId: request.requestId, token: turn.token, invocationId: request.requestId, nativeCallId: "card",
      toolName: "choose_next_step", arguments: {} });
    await h.store.commitTurn({ ownerId: h.ownerId, conversationId: request.conversationId, requestId: request.requestId, token: turn.token,
      reply: "r", checkpoint: { version: 1, engine: "pi", state: {} } });
    assert.ok(Date.now() - committing < 2_000, "audited changes never touch the webhook tables");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  await dispatcher.stop();
});

test("two dispatchers fan out and deliver each event once", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoints = [];
  for (let i = 0; i < 4; i++) endpoints.push(await h.create(r.url("e" + i), ["request.finished"]));
  const conversationId = await h.conversation();
  const one = h.dispatcher(), two = h.dispatcher();
  for (let round = 0; round < 6; round++) {
    await Promise.all([h.finished(conversationId), h.finished(conversationId), h.finished(conversationId)]);
    await pass(one, two);
  }
  for (let i = 0; i < 20; i++) await pass(one, two);
  const keys = r.received.map(item => `${item.headers["crew-webhook-id"]}/${item.headers["crew-webhook-event"]}`);
  assert.equal(keys.length, 4 * 18);
  assert.equal(new Set(keys).size, keys.length, "no endpoint received one event twice");
  for (const endpoint of endpoints) {
    const deliveries = await h.deliveries(endpoint.webhookId);
    assert.equal(deliveries.length, 18);
    assert.ok(deliveries.every(d => d.state === "delivered" && d.attempts === 1));
  }
});

test("an owner's events reach only that owner's endpoints, and only from owners the gateway serves", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const otherOwner = "owner-" + randomUUID();
  const otherMember = await h.store.spawn({ ownerId: otherOwner, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const mine = await h.create(r.url("mine"), ["request.finished"]);
  const theirs = await h.create(r.url("theirs"), ["request.finished"], otherOwner);
  await h.finished(await h.conversation());
  const theirConversation = await h.conversation(otherOwner, otherMember.memberId);
  await h.finished(theirConversation, "failed", otherOwner, otherMember.memberId);
  // This gateway serves only the first owner.
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  assert.deepEqual(r.received.map(item => item.path), ["/mine"]);
  assert.equal(JSON.parse(r.received[0].body).memberId, h.member.memberId);
  // The other owner's delivery waits, unattempted, for a gateway that serves them.
  assert.deepEqual((await h.deliveries(theirs.webhookId)).map(d => [d.state, d.attempts]), [["pending", 0]]);
  await pass(h.dispatcher({ owners: [otherOwner] }));
  assert.deepEqual(r.received.map(item => item.path), ["/mine", "/theirs"]);
  assert.equal(JSON.parse(r.received[1].body).status, "failed");
  assert.equal((await h.deliveries(mine.webhookId)).length, 1);
  await assert.rejects(h.api.get(otherOwner, mine.webhookId), { code: "not_found" });
  await assert.rejects(h.api.deliveries(otherOwner, mine.webhookId, {}), { code: "not_found" });
  await assert.rejects(h.api.change(otherOwner, mine.webhookId, "delete"), { code: "not_found" });
});

test("every delivery checks its target again and refuses one that now resolves to a refused address or scheme", async (t) => {
  let answer: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];
  const policy: TargetPolicy = { allowInsecure: true, lookup: async () => answer };
  const h = await harness(t, { policy });
  const r = await receiver(t);
  const named = await h.create(`http://receiver.test:${r.port}/named`, ["request.finished"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  const dispatcher = h.dispatcher();
  await pass(dispatcher);
  assert.deepEqual(r.received.map(item => [item.path, item.headers.host]), [["/named", `receiver.test:${r.port}`]]);
  // The name now answers with a metadata address, alone or beside the allowed one.
  for (const rebound of [[{ address: "169.254.169.254", family: 4 }], [{ address: "127.0.0.1", family: 4 }, { address: "169.254.169.254", family: 4 }]] as ResolvedAddress[][]) {
    answer = rebound;
    await h.finished(conversationId);
    await pass(dispatcher);
    h.advance(webhookLimits.retryCapMs);
  }
  assert.equal(r.received.length, 1);
  assert.deepEqual((await h.deliveries(named.webhookId)).slice(1).map(d => [d.state, d.outcome]), [["pending", "address_refused"], ["pending", "address_refused"]]);
  // The operator turned insecure targets off: an http endpoint is refused at delivery.
  answer = [{ address: "127.0.0.1", family: 4 }];
  const plain = await h.create(r.url("plain"), ["request.finished"]);
  await h.finished(conversationId);
  await pass(h.dispatcher({ policy: { allowInsecure: false } }));
  assert.equal(r.received.filter(item => item.path === "/plain").length, 0);
  assert.deepEqual((await h.deliveries(plain.webhookId)).map(d => d.outcome), ["url_refused"]);
});

test("a restored installation disables every endpoint and cancels undelivered rows; a source that resumes keeps them", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = () => 503;
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const idle = await h.create(r.url("idle"), ["approval.pending"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  await pass(h.dispatcher());
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => d.state), ["pending"]);
  const directory = await mkdtemp(join(tmpdir(), "birbcrew-webhooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fence = new FileRecoveryFence(join(directory, "fence"));
  const recovery = new InstallationRecovery(h.db, fence);
  await recovery.initializeFence();
  const pins: RecoveryPins = { applicationCommit: "a".repeat(40), lockfileSha256: "b".repeat(64),
    temporal: { mode: "development-fixture", serverVersion: "1.10.0", persistenceFormat: "dev-sqlite-fixture" }, logicalNativeRoot: "/var/lib/birbcrew/native" };
  const hooks: RecoveryHooks = { quiesce: async () => {}, reconcile: async () => {}, snapshot: async dir => {
    const artifacts = [];
    for (const kind of ["application-postgres", "temporal-persistence", "native-volumes", "configuration"] as const) {
      await writeFile(join(dir, kind), "fixture " + kind); artifacts.push({ kind, file: kind });
    }
    return artifacts;
  } };
  // A held installation records nothing: neither a delivery nor an endpoint change.
  const bundle = join(directory, "bundle"); await mkdir(bundle);
  await recovery.capture(bundle, pins, hooks);
  const manifest = await readRecoveryManifest(bundle);
  assert.deepEqual([manifest.inventory.webhook_endpoints, manifest.inventory.webhook_deliveries, manifest.inventory.webhook_cursor], [2, 1, 1]);
  h.advance(webhookLimits.retryCapMs);
  await pass(h.dispatcher());
  assert.equal(r.received.length, 1);
  await assert.rejects(h.api.change(h.ownerId, endpoint.webhookId, "disable"), { code: "55000" });
  await assert.rejects(h.create(r.url("held")), { code: "55000" });
  // A source that resumes without a restore keeps its endpoints and their pending rows.
  await recovery.resume(hooks);
  assert.deepEqual([(await h.endpoint(endpoint.webhookId)).state, (await h.deliveries(endpoint.webhookId))[0].state], ["enabled", "pending"]);

  // The same database accepted as a restore: resuming it disables and cancels.
  const restoreBundle = join(directory, "restore"); await mkdir(restoreBundle);
  await recovery.capture(restoreBundle, pins, hooks);
  await recovery.acceptRestore(restoreBundle, pins, randomUUID());
  await recovery.resume(hooks, await readRecoveryManifest(restoreBundle));
  for (const id of [endpoint.webhookId, idle.webhookId]) {
    const row = await h.endpoint(id);
    assert.deepEqual([row.state, row.disabled_reason], ["disabled", "recovery_restore"]);
  }
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.state, d.reason]), [["cancelled", "recovery_restore"]]);
  const { rows: audit } = await h.db.query(`SELECT actor_kind AS actor, payload->>'webhookId' AS id, payload->>'reason' AS reason
    FROM birbcrew_ts.audit_events WHERE event_type='webhook.disabled' ORDER BY event_id`);
  assert.deepEqual(audit, [endpoint, idle].map(e => ({ actor: "system", id: e.webhookId, reason: "recovery_restore" })));
  const { rows: [cursor] } = await h.db.query(`SELECT c.last_event_id::text AS cursor, (SELECT max(event_id) FROM birbcrew_ts.audit_events)::text AS max
    FROM birbcrew_ts.webhook_cursor c`);
  assert.equal(cursor.cursor, cursor.max);
  // Nothing from before the restore is sent, even once the owner enables the endpoint again.
  r.state.reply = () => 200;
  await h.api.change(h.ownerId, endpoint.webhookId, "enable");
  const after = await h.finished(conversationId);
  h.advance(webhookLimits.retryCapMs);
  await pass(h.dispatcher());
  assert.deepEqual(r.received.slice(1).map(item => JSON.parse(item.body).requestId), [after]);
});

test("a fan-out never passes an audit row that commits after a higher one", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  const writer = await h.db.connect();
  try {
    await writer.query("BEGIN");
    const early = randomUUID();
    await appendAudit(writer, { type: "request.finished", ownerId: h.ownerId, memberId: h.member.memberId, conversationId, requestId: early,
      payload: { status: "failed" } });
    const late = await h.finished(conversationId); // a higher ID, committed first
    const dispatcher = h.dispatcher();
    const passing = pass(dispatcher);
    await delay(300);
    assert.equal(r.received.length, 0, "the pass waits for the open writer instead of moving the cursor past its ID");
    await writer.query("COMMIT");
    await passing;
    assert.deepEqual(r.received.map(item => JSON.parse(item.body).requestId).sort(), [early, late].sort());
  } finally { writer.release(); }
});

test("an abandoned attempt is retried after its lease, a stale holder records nothing, and a lost last attempt fails", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  r.state.reply = () => "hang";
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  await h.finished(conversationId);
  // The holder stops mid-request: the row stays leased, its attempt counted.
  const first = h.dispatcher();
  await first.tick();
  for (let i = 0; i < 50 && !r.received.length; i++) await delay(20);
  await first.stop();
  let [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome], ["delivering", 1, null]);
  const { rows: [{ lease }] } = await h.db.query("SELECT lease_until AS lease FROM birbcrew_ts.webhook_deliveries");
  // Before the lease ends nobody takes it; after it, another dispatcher sends the same event again.
  const second = h.dispatcher();
  await pass(second);
  assert.equal(r.received.length, 1);
  h.advance(webhookLimits.leaseMs);
  await second.tick();
  for (let i = 0; i < 50 && r.received.length < 2; i++) await delay(20);
  [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts], ["delivering", 2]);
  // The first holder, settling late through the real settle, matches nothing: the row's attempt count
  // and lease are no longer its own, so it neither reschedules the row nor counts a failure.
  const stale = { webhook_id: endpoint.webhookId, event_id: delivery.eventId, attempts: 1, prior_attempts: 0, lease_until: lease,
    body: "{}", url: r.url("in"), secret: endpoint.secret };
  await (first as unknown as { settle(claim: unknown, result: unknown): Promise<void> }).settle(stale, { outcome: "timeout" });
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.state, d.attempts, d.outcome]), [["delivering", 2, null]]);
  assert.equal((await h.endpoint(endpoint.webhookId)).consecutive_failures, 0);
  await second.stop();
  r.state.reply = () => 200;
  h.advance(webhookLimits.leaseMs);
  const third = h.dispatcher();
  await pass(third);
  [delivery] = await h.deliveries(endpoint.webhookId);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome], ["delivered", 3, "delivered"]);
  assert.equal(r.received.length, 3);
  assert.equal(new Set(r.received.map(item => JSON.parse(item.body).eventId)).size, 1, "one event, sent again by each holder");
  // A last attempt whose holder vanished is never sent again: it fails as interrupted.
  await h.finished(conversationId);
  await h.db.query(`INSERT INTO birbcrew_ts.webhook_deliveries (webhook_id,event_id,kind,body,state,attempts,lease_until,last_attempt_at,created_at)
    SELECT $1, max(event_id), 'request.finished', '{}', 'delivering', 10, now() - interval '1 hour', now(), now()
      FROM birbcrew_ts.audit_events`, [endpoint.webhookId]);
  await pass(third);
  const last = (await h.deliveries(endpoint.webhookId)).at(-1)!;
  assert.deepEqual([last.state, last.reason, last.attempts, last.outcome], ["failed", "attempts_exhausted", 10, "interrupted"]);
  assert.equal(r.received.length, 3);
});

test("a backlog larger than one fan-out batch is delivered in full and the cursor ends at the horizon", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  const conversationId = await h.conversation();
  await h.store.transaction(async db => {
    for (let i = 0; i < webhookLimits.fanOutBatch + 44; i++) {
      await appendAudit(db, { type: "request.finished", ownerId: h.ownerId, memberId: h.member.memberId, conversationId,
        requestId: randomUUID(), payload: { status: "completed" } });
    }
  });
  const dispatcher = h.dispatcher();
  // One pass fans out both batches; each pass then sends at most 100 to one endpoint.
  await pass(dispatcher);
  assert.equal((await h.deliveries(endpoint.webhookId)).length, 300);
  assert.equal(r.received.length, webhookLimits.chainLength);
  for (let i = 0; i < 3; i++) await pass(dispatcher);
  assert.equal((await h.deliveries(endpoint.webhookId)).filter(d => d.state === "delivered").length, 300);
  assert.equal(r.received.length, 300, "the chain cap claims nothing it does not send");
  assert.equal(new Set(r.received.map(item => JSON.parse(item.body).eventId)).size, 300);
  const { rows: [cursor] } = await h.db.query(`SELECT c.last_event_id = (SELECT max(event_id) FROM birbcrew_ts.audit_events) AS at_end
    FROM birbcrew_ts.webhook_cursor c`);
  assert.equal(cursor.at_end, true);
});

test("with no endpoint enabled the cursor moves to the end of the trail, and a later endpoint gets only later events", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const conversationId = await h.conversation();
  for (let i = 0; i < 3; i++) await h.finished(conversationId);
  const cursor = async () => (await h.db.query(`SELECT c.last_event_id::text AS cursor, (SELECT max(event_id) FROM birbcrew_ts.audit_events)::text AS max
    FROM birbcrew_ts.webhook_cursor c`)).rows[0];
  const dispatcher = h.dispatcher();
  // An enable in progress holds the cursor: the pass neither waits for it nor moves the cursor.
  const enabling = await h.db.connect();
  const before = await cursor();
  try {
    await enabling.query("BEGIN");
    await enabling.query("SELECT 1 FROM birbcrew_ts.webhook_cursor FOR SHARE");
    const started = Date.now();
    await pass(dispatcher);
    assert.ok(Date.now() - started < 2_000);
    assert.equal((await cursor()).cursor, before.cursor);
  } finally { await enabling.query("ROLLBACK"); enabling.release(); }
  h.advance(60_000);
  await pass(dispatcher);
  let position = await cursor();
  assert.equal(position.cursor, position.max);
  // At most once a minute.
  await h.finished(conversationId);
  await pass(dispatcher);
  assert.notEqual((await cursor()).cursor, (await cursor()).max);
  h.advance(60_000);
  await pass(dispatcher);
  position = await cursor();
  assert.equal(position.cursor, position.max);
  await h.create(r.url("in"), ["request.finished"]);
  const later = await h.finished(conversationId);
  // With an endpoint enabled the idle move does nothing, even if asked directly.
  const unsent = await cursor();
  h.advance(60_000);
  await (dispatcher as unknown as { advanceIdle(now: Date): Promise<void> }).advanceIdle(h.clock());
  assert.deepEqual(await cursor(), unsent);
  await pass(dispatcher);
  assert.deepEqual(r.received.map(item => JSON.parse(item.body).requestId), [later]);
});

test("an audit row that does not fit its kind is skipped, and later events still reach the endpoint", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["routine.firing_settled", "request.finished"]);
  // Written past the TypeScript schema, as only direct SQL could: a scheduledFor no body may carry.
  await h.db.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
    VALUES ($1,'system',NULL,'owner',$1,'routine.firing_settled',$2,$3)`,
    [h.ownerId, h.member.memberId, { routineId: randomUUID(), scheduledFor: "2031-01-06T10:15:00.000Z" + "x".repeat(800), status: "failed" }]);
  const later = await h.finished(await h.conversation());
  await pass(h.dispatcher());
  assert.deepEqual(r.received.map(item => JSON.parse(item.body).requestId), [later]);
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.kind, d.state]), [["request.finished", "delivered"]]);
});

test("the database keeps endpoints and deliveries as history and refuses a member on a webhook audit row", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"]);
  await h.finished(await h.conversation());
  await pass(h.dispatcher());
  const refused = async (statement: string, values: unknown[] = []) => assert.rejects(h.db.query(statement, values), { code: "23514" }, statement);
  await refused("DELETE FROM birbcrew_ts.webhook_endpoints");
  await refused("TRUNCATE birbcrew_ts.webhook_endpoints CASCADE");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET kinds='{approval.pending}'");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET format='slack'");
  await assert.rejects(h.db.query(`INSERT INTO birbcrew_ts.webhook_endpoints (owner_id,create_request_id,url,host,kinds,format,secret,state,
      disabled_reason) VALUES ($1, gen_random_uuid(), 'https://x.example.com/', 'x.example.com', '{request.finished}', 'Slack', repeat('a', 43),
      'disabled', 'owner')`, [h.ownerId]), { code: "23514", constraint: "webhook_endpoints_format_check" });
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET url='https://elsewhere.example.com/'");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET secret=repeat('a', 43)");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET url=NULL");
  await refused("DELETE FROM birbcrew_ts.webhook_deliveries");
  await refused("UPDATE birbcrew_ts.webhook_deliveries SET body='{}'");
  await refused("UPDATE birbcrew_ts.webhook_deliveries SET state='pending', next_attempt_at=now(), settled_at=NULL");
  await refused("UPDATE birbcrew_ts.webhook_cursor SET last_event_id=0");
  await refused("DELETE FROM birbcrew_ts.webhook_cursor");
  await h.api.change(h.ownerId, endpoint.webhookId, "delete");
  await refused("UPDATE birbcrew_ts.webhook_endpoints SET state='disabled', disabled_reason='owner'");
  const insert = `INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
    VALUES ($1,'owner',$1,'owner',$1,$2,$3,$4)`;
  await refused(insert, [h.ownerId, "webhook.enabled", h.member.memberId, { webhookId: endpoint.webhookId, revision: 9, host: "x" }]);
  await refused(insert, [h.ownerId, "member.spawned", null, { spawnRequestId: randomUUID(), engine: "pi", profile: "fixture" }]);
  await refused(insert, [h.ownerId, "webhook.enabled", null, { revision: 9, host: "x" }]);
});

/** The top-level OR clauses of a CHECK as pg_get_constraintdef prints it. */
function orClauses(definition: string) {
  const body = /^CHECK \(\((.*)\)\)( NOT VALID)?$/s.exec(definition)?.[1];
  assert.ok(body, definition);
  const clauses: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (depth === 0 && body.startsWith(" OR ", i)) { clauses.push(body.slice(start, i)); start = i + 4; }
  }
  return [...clauses, body.slice(start)];
}

/** Everything in the schema that a migration could replace, disable or drop, as PostgreSQL prints it, keyed
 * by the table it belongs to. NOT NULL is read from the column, not from pg_constraint, which holds it
 * only from PostgreSQL 18. */
async function schemaCatalog(db: Pool) {
  return Object.fromEntries((await db.query<{ name: string; definition: string }>(`
    SELECT conrelid::regclass::text || '/' || conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace='birbcrew_ts'::regnamespace AND contype <> 'n'
    UNION ALL SELECT tgrelid::regclass::text || '/' || tgname, pg_get_triggerdef(oid) || ' ENABLED ' || tgenabled::text FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='birbcrew_ts'::regnamespace)
    UNION ALL SELECT 'function/' || oid::regprocedure::text, pg_get_functiondef(oid) FROM pg_proc
      WHERE pronamespace='birbcrew_ts'::regnamespace AND prokind='f'
    UNION ALL SELECT 'index/' || indrelid::regclass::text || '/' || indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index
      WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace='birbcrew_ts'::regnamespace)
    UNION ALL SELECT 'column/' || a.attrelid::regclass::text || '.' || a.attname, format_type(a.atttypid, a.atttypmod)
        || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
        || CASE WHEN a.attidentity <> '' THEN ' IDENTITY ' || a.attidentity::text ELSE '' END
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON (d.adrelid, d.adnum) = (a.attrelid, a.attnum)
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND a.attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='birbcrew_ts'::regnamespace AND relkind='r')
    UNION ALL SELECT 'sequence/' || seqrelid::regclass::text, concat_ws(' ', seqtypid::regtype, seqstart, seqincrement, seqmax, seqmin,
        seqcache, seqcycle) FROM pg_sequence WHERE seqrelid IN (SELECT oid FROM pg_class WHERE relnamespace='birbcrew_ts'::regnamespace)
    UNION ALL SELECT 'view/' || oid::regclass::text, pg_get_viewdef(oid) FROM pg_class
      WHERE relnamespace='birbcrew_ts'::regnamespace AND relkind IN ('v', 'm')`)).rows
    .map(row => [row.name, row.definition]));
}

test("the webhook migration keeps every constraint, trigger, function, index and column it finds, and its type CHECK every clause of the one it replaces", async (t) => {
  const upgraded = await databaseAt(t, webhookVersion - 1);
  const catalog = () => schemaCatalog(upgraded);
  const before = await catalog();
  await upgraded.query(await readFile(new URL(webhookMigration, sql), "utf8"));
  const after = await catalog();
  const typeCheck = "birbcrew_ts.audit_events/audit_events_type_check", member = "column/birbcrew_ts.audit_events.member_id";
  assert.deepEqual([before[member], after[member]], ["uuid NOT NULL", "uuid"], "webhook rows name no member");
  for (const [name, definition] of Object.entries(before)) {
    if (name !== typeCheck && name !== member) assert.equal(after[name], definition, name);
  }
  const own = /^(?:column\/|index\/)?birbcrew_ts\.webhook_(?:endpoints|deliveries|cursor)[./]/;
  assert.deepEqual(Object.keys(after).filter(name => !(name in before) && !own.test(name)).sort(), [
    "birbcrew_ts.audit_events/audit_events_member_check", "function/birbcrew_ts.guard_webhook_cursor()",
    "function/birbcrew_ts.guard_webhook_delivery()", "function/birbcrew_ts.guard_webhook_endpoint()",
    "function/birbcrew_ts.limit_enabled_webhooks()", "function/birbcrew_ts.reject_webhook_truncate()",
    "index/birbcrew_ts.audit_events/birbcrew_ts.audit_events_approval_request_fact",
    "index/birbcrew_ts.audit_events/birbcrew_ts.audit_events_webhook_fact",
  ], "what it adds outside its own tables");
  // Clause for clause as PostgreSQL stores them: everything the replaced CHECK held, unchanged and in order, then this feature's own.
  const [kept, replaced] = [orClauses(before[typeCheck]), orClauses(after[typeCheck])];
  const types = (clauses: string[]) => clauses.flatMap(clause => [...clause.matchAll(/'([a-z_]+\.[a-z_]+)'::text/g)].map(match => match[1]));
  assert.deepEqual(replaced.slice(0, kept.length), kept, "every clause of the replaced CHECK");
  assert.deepEqual(types(replaced.slice(kept.length)), ["approval.requested", "webhook.created", "webhook.enabled", "webhook.disabled", "webhook.deleted"]);
  // The registry also holds the types later migrations add to the CHECK, read from their files.
  const later = new Set<string>();
  for (const file of migrations.filter(file => Number(file.split("-")[0]) > webhookVersion)) {
    const check = /ADD CONSTRAINT audit_events_type_check CHECK \(([\s\S]*?)\) NOT VALID;/.exec(await readFile(new URL(file, sql), "utf8"));
    for (const [, type] of check?.[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g) ?? []) later.add(type);
  }
  assert.deepEqual([...new Set([...types(replaced), ...later])].sort(), [...auditEventTypes].sort());
});

test("the webhook migration takes only audit_events, without queueing, rewrites nothing and leaves its CHECKs unvalidated", async (t) => {
  const upgraded = await databaseAt(t, webhookVersion - 1);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  const { rows: [{ member_id: memberId }] } = await upgraded.query<{ member_id: string }>(`INSERT INTO birbcrew_ts.members
    (owner_id,spawn_request_id,engine,profile) VALUES ($1,$2,'pi','fixture') RETURNING member_id`, [ownerId, randomUUID()]);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, memberId, conversationId]);
  await upgraded.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,conversation_id,payload)
    VALUES ($1,'owner',$1,'owner',$1,'conversation.opened',$2,$3,'{}')`, [ownerId, memberId, conversationId]);
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = "SELECT pg_relation_filenode('birbcrew_ts.audit_events') AS audit";
    const { rows: [before] } = await db.query(files);
    await db.query(await readFile(new URL(webhookMigration, sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname NOT LIKE 'webhook_%' ORDER BY 1,2`);
    assert.deepEqual(rows, [{ relation: "audit_events", mode: "AccessExclusiveLock" }, { relation: "audit_events", mode: "AccessShareLock" },
      { relation: "audit_events", mode: "ShareLock" }]);
    const { rows: checks } = await db.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conrelid='birbcrew_ts.audit_events'::regclass AND conname IN ('audit_events_type_check','audit_events_member_check') ORDER BY 1`);
    assert.deepEqual(checks, [{ name: "audit_events_member_check", validated: false }, { name: "audit_events_type_check", validated: false }]);
    const { rows: [cursor] } = await db.query(`SELECT last_event_id = (SELECT max(event_id) FROM birbcrew_ts.audit_events) AS at_end
      FROM birbcrew_ts.webhook_cursor`);
    assert.equal(cursor.at_end, true, "no event from before the upgrade is ever delivered");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  // An audited writer holding audit_events: the migration retries without queueing, so the
  // writer's next statements are not held up, and it completes once the writer commits.
  const store = new MemberStore(upgraded);
  const holder = await upgraded.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,event_type,member_id,payload)
      VALUES ($1,'owner',$1,'owner',$1,'member.spawned',$2,$3)`, [ownerId, memberId, { spawnRequestId: randomUUID(), engine: "pi", profile: "fixture" }]);
    let migrated = false;
    const migrating = store.migrate().then(() => { migrated = true; });
    for (let i = 0; i < 10; i++) {
      await delay(30);
      const { rows: waiting } = await upgraded.query(`SELECT pid FROM pg_locks WHERE NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      assert.deepEqual(waiting, [], "the migration retries instead of queueing");
    }
    assert.equal(migrated, false);
    await holder.query("COMMIT");
    await migrating;
  } finally { holder.release(); }
  assert.deepEqual((await upgraded.query("SELECT version FROM birbcrew_ts.schema_versions WHERE version>=$1 ORDER BY 1", [webhookVersion]))
    .rows.map(row => row.version), migrations.map(file => Number(file.split("-")[0])).filter(version => version >= webhookVersion));
  const { rows: [nullable] } = await upgraded.query(`SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='birbcrew_ts' AND table_name='audit_events' AND column_name='member_id'`);
  assert.equal(nullable.is_nullable, "YES");
});

test("the webhook migration completes while a native turn holds its admission", async (t) => {
  const upgraded = await databaseAt(t, webhookVersion - 1);
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
    const migrated = await Promise.race([migrateThrough(current, webhookVersion).then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "the webhook migration must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId, token: start.token }, requestId + "/assistant", 0, "still running");
  });
  await current.migrate();
  await current.commitTurn({ ownerId, conversationId, requestId, token: start.token, reply: "still running", checkpoint: { version: 1, engine: "pi", state: {} } });
  const { rows } = await upgraded.query("SELECT event_type FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id", [ownerId]);
  assert.deepEqual(rows.map(row => row.event_type), ["request.finished"]);
});

test("every format writes each kind as its fixed template from the body's identifiers alone, and only crew is signed", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const endpoints = {} as Record<WebhookFormat, Awaited<ReturnType<Harness["create"]>>>;
  for (const format of webhookFormatNames) endpoints[format] = await h.create(r.url(format), webhookKindNames, h.ownerId, format);
  // Each kind through its real path, around text no message may carry: the fixture's, and this member's instructions and memory.
  const { memberId } = await h.store.spawn({ ownerId: h.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture",
    instructions: "INSTRUCTIONS-MARKER" });
  await new MemoryApi(h.store).create(h.ownerId, { requestId: randomUUID(), memberId, text: "MEMORY-MARKER" });
  const { carded, request, approval, committed, done, routineId } = await everyKind(h, memberId);
  await pass(h.dispatcher());

  const [card, finished, settled, exhausted] = await deliveredEvents(h.db);
  const at = (format: WebhookFormat) => r.received.filter(item => item.path === "/" + format);
  for (const format of webhookFormatNames) assert.equal(at(format).length, 4, format);

  // crew: the stored body, byte for byte, in PostgreSQL's jsonb key order, as before formats existed.
  const crew = endpoints.crew;
  assert.equal(at("crew")[1].body, `{"kind": "request.finished", "status": "completed", "eventId": "${finished.eventId}", "memberId": "${memberId}", `
    + `"requestId": "${done.requestId}", "webhookId": "${crew.webhookId}", "occurredAt": "${finished.occurredAt}", "conversationId": "${committed}"}`);
  const stored = async (webhookId: string) => (await h.db.query<{ body: string }>(
    "SELECT body FROM birbcrew_ts.webhook_deliveries WHERE webhook_id=$1 ORDER BY event_id", [webhookId])).rows.map(row => row.body);
  assert.deepEqual(at("crew").map(item => item.body), await stored(crew.webhookId));
  // The outbox is the same for every format: each endpoint's rows hold the crew body with its own webhookId.
  for (const format of ["slack", "ntfy"] as const) {
    assert.deepEqual((await stored(endpoints[format].webhookId)).map(body => JSON.parse(body)),
      (await stored(crew.webhookId)).map(body => ({ ...JSON.parse(body), webhookId: endpoints[format].webhookId })), format);
  }
  const timestamp = String(Math.floor(h.clock().getTime() / 1000));
  for (const item of at("crew")) {
    assert.equal(item.headers["content-type"], "application/json");
    assert.equal(item.headers["crew-webhook-id"], crew.webhookId);
    assert.equal(item.headers["crew-webhook-event"], JSON.parse(item.body).eventId);
    assert.equal(item.headers["crew-webhook-signature"], signature(crew.secret, timestamp, item.body));
  }

  // slack and ntfy: one fixed template per kind, filled with the body's identifiers, status, tool and time only.
  const tail = (event: { eventId: string; occurredAt: string }) => [["Member", memberId], ["Event", event.eventId], ["Occurred at", event.occurredAt]];
  const messages = [
    ["Crew: approval pending", [["Tool", "record_work_item"], ["Conversation", carded], ["Request", request.requestId], ["Approval", approval.approvalId],
      ...tail(card)]],
    ["Crew: request completed", [["Conversation", committed], ["Request", done.requestId], ...tail(finished)]],
    ["Crew: routine firing failed", [["Routine", routineId], ["Scheduled for", "2031-01-06T10:15:00.000Z"], ...tail(settled)]],
    ["Crew: routine disabled", [["Routine", routineId], ["Reason", "consecutive_failures"], ...tail(exhausted)]],
  ] as const;
  assert.deepEqual(at("slack").map(item => item.body), messages.map(([title, details]) =>
    JSON.stringify({ text: [title, ...details.map(([label, value]) => `${label}: \`${value}\``)].join("\n") })));
  assert.equal(at("slack")[1].body, `{"text":"Crew: request completed\\nConversation: \`${committed}\`\\nRequest: \`${done.requestId}\`\\n`
    + `Member: \`${memberId}\`\\nEvent: \`${finished.eventId}\`\\nOccurred at: \`${finished.occurredAt}\`"}`);
  assert.deepEqual(at("ntfy").map(item => [item.headers.title, item.body]), messages.map(([title, details]) =>
    [title, details.map(([label, value]) => `${label}: ${value}`).join("\n")]));
  assert.equal(at("ntfy")[1].body, `Conversation: ${committed}\nRequest: ${done.requestId}\nMember: ${memberId}\nEvent: ${finished.eventId}\n`
    + `Occurred at: ${finished.occurredAt}`);
  for (const [format, contentType] of [["slack", "application/json"], ["ntfy", "text/plain; charset=utf-8"]] as const) {
    for (const item of at(format)) {
      assert.equal(item.headers["content-type"], contentType, format);
      assert.deepEqual(Object.keys(item.headers).filter(name => name.startsWith("crew-")), [], "no signature where nobody checks one");
    }
  }
  for (const item of r.received) {
    assert.equal(item.headers["user-agent"], "Crew-Webhooks/1");
    assert.equal(item.headers.authorization ?? item.headers.cookie, undefined);
    assert.ok(Buffer.byteLength(item.body) <= 1024);
  }
  assertCarriesNoText(r.received, ...webhookFormatNames.map(format => endpoints[format].secret));
  for (const format of webhookFormatNames) {
    assert.deepEqual((await h.deliveries(endpoints[format].webhookId)).map(d => [d.state, d.attempts, d.outcome]),
      Array(4).fill(["delivered", 1, "delivered"]), format);
  }
});

test("a readable message is built only from a body its kind's strict schema accepts, and any other body is never sent", async (t) => {
  const body = { webhookId: randomUUID(), eventId: "42", kind: "request.finished", occurredAt: "2031-01-06T10:15:00.123456Z", memberId: randomUUID(),
    conversationId: randomUUID(), requestId: randomUUID(), status: "failed" };
  assert.deepEqual(webhookMessage("request.finished", JSON.stringify(body)), { title: "Crew: request failed", details: [
    ["Conversation", body.conversationId], ["Request", body.requestId], ["Member", body.memberId], ["Event", "42"], ["Occurred at", body.occurredAt]] });
  for (const stored of [{ ...body, note: "NOTE-MARKER" }, { ...body, status: "NOTE-MARKER" }, { ...body, requestId: "NOTE-MARKER" },
    { ...body, webhookId: undefined }, { ...body, kind: "approval.pending" }]) {
    assert.throws(() => webhookMessage("request.finished", JSON.stringify(stored)), JSON.stringify(stored));
  }
  assert.throws(() => webhookMessage("approval.pending", JSON.stringify(body)));
  // Only direct SQL could store such a body; a readable endpoint's attempt then fails before any connection,
  // while a well-formed delivery to the same endpoint goes out.
  const h = await harness(t);
  const r = await receiver(t);
  const endpoint = await h.create(r.url("in"), ["request.finished"], h.ownerId, "slack");
  await h.db.query(`INSERT INTO birbcrew_ts.webhook_deliveries (webhook_id,event_id,kind,body,state,next_attempt_at,created_at)
    VALUES ($1, 1, 'request.finished', $2, 'pending', $3, $3)`, [endpoint.webhookId, JSON.stringify({ ...body, webhookId: endpoint.webhookId,
    note: "NOTE-MARKER" }), h.clock()]);
  const good = await h.finished(await h.conversation());
  await pass(h.dispatcher());
  assert.deepEqual(r.received.map(item => [item.path, (JSON.parse(item.body) as { text: string }).text.includes(good)]), [["/in", true]]);
  assertCarriesNoText(r.received);
  assert.deepEqual((await h.deliveries(endpoint.webhookId)).map(d => [d.eventId === "1", d.state, d.attempts, d.outcome]),
    [[true, "pending", 1, "network"], [false, "delivered", 1, "delivered"]]);
});

test("an endpoint whose format this release does not know keeps its deliveries pending and unattempted", async (t) => {
  const h = await harness(t);
  const r = await receiver(t);
  const known = await h.create(r.url("known"), ["request.finished"]);
  // As a later release with another format could write it.
  const { rows: [{ webhook_id: later }] } = await h.db.query<{ webhook_id: string }>(`INSERT INTO birbcrew_ts.webhook_endpoints
      (owner_id,create_request_id,url,host,kinds,format,secret,state,enabled_at)
    VALUES ($1, gen_random_uuid(), $2, $3, '{request.finished}', 'teams', repeat('a', 43), 'enabled', clock_timestamp()) RETURNING webhook_id`,
    [h.ownerId, r.url("later"), `127.0.0.1:${r.port}`]);
  await h.finished(await h.conversation());
  await pass(h.dispatcher());
  assert.deepEqual(r.received.map(item => item.path), ["/known"]);
  assert.deepEqual((await h.deliveries(known.webhookId)).map(d => [d.state, d.attempts]), [["delivered", 1]]);
  assert.deepEqual((await h.deliveries(later)).map(d => [d.state, d.attempts, d.outcome]), [["pending", 0, null]]);
  assert.deepEqual([(await h.endpoint(later)).state, (await h.endpoint(later)).consecutive_failures], ["enabled", 0]);
});

/** A Slack-compatible incoming webhook, as Slack documents it: a JSON body whose `text` is a
 * non-empty string is answered `200 ok`; malformed JSON `400 invalid_payload`; no text `400 no_text`;
 * a path that names no hook `404 no_service`. The path is the hook's credential. */
async function slackReceiver(t: TestContext, hook: string) {
  const r = await receiver(t);
  const accepted: { text: string; raw: string; headers: IncomingHttpHeaders }[] = [];
  const answers: string[] = [];
  const answer = (status: number, text: string) => { answers.push(text); return { status, text }; };
  r.state.reply = (path, { method, headers, body }) => {
    if (method !== "POST" || path !== hook) return answer(404, "no_service");
    if (!headers["content-type"]?.startsWith("application/json")) return answer(400, "invalid_payload");
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { return answer(400, "invalid_payload"); }
    const text = (payload as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text) return answer(400, "no_text");
    accepted.push({ text, raw: body, headers });
    return answer(200, "ok");
  };
  return { accepted, answers, port: r.port, url: (path = hook) => `http://127.0.0.1:${r.port}${path}` };
}

test("a slack endpoint made through the routes posts a message a Slack-compatible receiver accepts, and its URL reaches no one but the owner", async (t) => {
  const db = await databaseAt(t);
  const store = new MemberStore(db);
  const hook = "/services/T0CREW/B0CREW/HOOK-SECRET-TOKEN";
  const slack = await slackReceiver(t, hook);
  const g = await gateway(t, store, () => new Date(), insecure);
  const body = { requestId: randomUUID(), url: slack.url(), kinds: ["request.finished"], format: "slack" };
  const created = await g.api("/v1/webhooks", body);
  assert.equal(created.status, 201, created.text);
  const { secret, ...view } = created.body;
  assert.deepEqual([view.format, view.url, typeof secret], ["slack", slack.url(), "string"]);
  assert.deepEqual((await g.api(`/v1/webhooks/${view.webhookId}`)).body, view);
  assert.deepEqual((await g.api("/v1/webhooks")).body.webhooks, [view]);
  assert.deepEqual((await g.api("/v1/webhooks", body)).body, view);
  assert.deepEqual((await g.api("/v1/webhooks", { ...body, format: "ntfy" })).body, { error: "conflict" });
  const { format: _format, ...crewReplay } = body;
  assert.deepEqual((await g.api("/v1/webhooks", crewReplay)).body, { error: "conflict" }, "a create without a format is crew");
  // A hook the service no longer knows, and bodies it cannot read: each an ordinary failed attempt.
  const revoked = (await g.api("/v1/webhooks", { requestId: randomUUID(), url: slack.url("/services/T0CREW/B0CREW/REVOKED-TOKEN"),
    kinds: ["request.finished"], format: "slack" })).body;
  const crewAtHook = (await g.api("/v1/webhooks", { requestId: randomUUID(), url: slack.url(), kinds: ["request.finished"] })).body;
  const ntfyAtHook = (await g.api("/v1/webhooks", { requestId: randomUUID(), url: slack.url(), kinds: ["request.finished"], format: "ntfy" })).body;

  const { memberId } = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture" });
  const conversationId = randomUUID(), requestId = randomUUID();
  await store.openConversation({ ownerId: g.ownerId, memberId, conversationId });
  await store.transaction(db => appendAudit(db, { type: "request.finished", ownerId: g.ownerId, memberId, conversationId, requestId,
    payload: { status: "failed" } }));
  const states = async (id: string) => (await g.api(`/v1/webhooks/${id}/deliveries`)).body.deliveries
    .map((d: { state: string; attempts: number; lastOutcome: string; lastStatusCode: number }) => [d.state, d.attempts, d.lastOutcome, d.lastStatusCode]);
  const settled = async () => JSON.stringify(await Promise.all([view, revoked, crewAtHook, ntfyAtHook].map(e => states(e.webhookId))));
  const expected = JSON.stringify([[["delivered", 1, "delivered", 200]], [["pending", 1, "http_status", 404]], [["pending", 1, "http_status", 400]],
    [["pending", 1, "http_status", 400]]]);
  for (let i = 0; i < 200 && await settled() !== expected; i++) await delay(25);
  assert.equal(await settled(), expected, "delivered to the hook; an ordinary failed attempt for the revoked hook and each unreadable body");
  assert.deepEqual(slack.answers.sort(), ["invalid_payload", "no_service", "no_text", "ok"]);
  const [event] = await deliveredEvents(db, requestId);
  assert.deepEqual(slack.accepted.map(message => message.text), [["Crew: request failed", `Conversation: \`${conversationId}\``,
    `Request: \`${requestId}\``, `Member: \`${memberId}\``, `Event: \`${event.eventId}\``, `Occurred at: \`${event.occurredAt}\``].join("\n")]);
  const [message] = slack.accepted;
  assert.equal(message.raw, JSON.stringify({ text: message.text }));
  assert.deepEqual(Object.keys(message.headers).filter(name => name.startsWith("crew-") || name === "authorization" || name === "cookie"), []);
  assert.ok(!message.raw.includes(secret));

  // The hook's path is its credential. The trail, its CSV export and the delivery rows hold the host only.
  const audit = await g.api("/v1/audit?limit=1000&eventType=webhook.created");
  assert.deepEqual(audit.body.events.map((e: { payload: Record<string, unknown> }) => [e.payload.host, e.payload.format]),
    ["slack", "slack", "crew", "ntfy"].map(format => [`127.0.0.1:${slack.port}`, format]));
  const csv = (await g.api("/v1/audit?format=csv&limit=10000")).text;
  const deliveries = (await Promise.all([view, revoked, crewAtHook, ntfyAtHook].map(async e => (await g.api(`/v1/webhooks/${e.webhookId}/deliveries`)).text)))
    .join("");
  for (const text of [audit.text, csv, deliveries]) assert.ok(!text.includes("TOKEN") && !text.includes("/services/"), text);
  // Another owner learns nothing of it.
  assert.deepEqual((await g.api(`/v1/webhooks/${view.webhookId}`, undefined, g.stranger)).body, { error: "not_found" });
  assert.deepEqual((await g.api("/v1/webhooks", undefined, g.stranger)).body.webhooks, []);
  // A delete erases the URL with the secret, whatever the format.
  assert.equal((await g.api(`/v1/webhooks/${view.webhookId}`, undefined, g.token, "DELETE")).body.url, null);
  assert.deepEqual((await db.query("SELECT url, secret, format FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1", [view.webhookId])).rows,
    [{ url: null, secret: null, format: "slack" }]);
});

test("the formats migration reads every existing endpoint as crew, keeps everything else, rewrites nothing and locks only webhook_endpoints", async (t) => {
  const formatsMigration = migrations.find(file => file.endsWith("-notification-formats.sql"))!;
  const upgraded = await databaseAt(t, Number(formatsMigration.split("-")[0]) - 1);
  const { rows: [{ webhook_id: webhookId }] } = await upgraded.query<{ webhook_id: string }>(`INSERT INTO birbcrew_ts.webhook_endpoints
      (owner_id,create_request_id,url,host,kinds,secret,state,enabled_at)
    VALUES ('owner-upgrade', gen_random_uuid(), 'https://hooks.example.com/in', 'hooks.example.com', '{request.finished}', repeat('a', 43),
      'enabled', clock_timestamp()) RETURNING webhook_id`);
  const before = await schemaCatalog(upgraded);
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = "SELECT pg_relation_filenode('birbcrew_ts.webhook_endpoints') AS endpoints";
    const { rows: [unchanged] } = await db.query(files);
    await db.query(await readFile(new URL(formatsMigration, sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], unchanged, "no row is rewritten");
    const { rows: locks } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace ORDER BY 1,2`);
    assert.deepEqual(locks, [{ relation: "webhook_endpoints", mode: "AccessExclusiveLock" }]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
  const after = await schemaCatalog(upgraded);
  const guard = "function/birbcrew_ts.guard_webhook_endpoint()";
  assert.deepEqual(Object.keys(before).filter(name => !(name in after)), []);
  assert.deepEqual(Object.keys(before).filter(name => name in after && after[name] !== before[name]), [guard]);
  assert.deepEqual(Object.entries(after).filter(([name]) => !(name in before)).sort(), [
    ["birbcrew_ts.webhook_endpoints/webhook_endpoints_format_check", "CHECK ((format ~ '^[a-z][a-z0-9_]{0,31}$'::text))"],
    ["column/birbcrew_ts.webhook_endpoints.format", "text NOT NULL DEFAULT 'crew'::text"],
  ]);
  // The guard is 032's with the format added to what never changes.
  assert.equal(after[guard], before[guard].replace("OLD.kinds, OLD.created_at", "OLD.kinds, OLD.format, OLD.created_at")
    .replace("NEW.kinds, NEW.created_at", "NEW.kinds, NEW.format, NEW.created_at"));
  assert.deepEqual((await upgraded.query("SELECT format FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1", [webhookId])).rows, [{ format: "crew" }]);
  await assert.rejects(upgraded.query("UPDATE birbcrew_ts.webhook_endpoints SET format='slack'"), { code: "23514" });
});
