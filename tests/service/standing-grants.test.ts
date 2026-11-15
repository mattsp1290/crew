import { testDatabaseName } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HttpAgent } from "@ag-ui/client";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { Pool, type PoolClient } from "pg";
import { ApprovalStore, type Approval } from "../../src/service/approvals.ts";
import { ChildStore } from "../../src/service/children.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { grantListLimit } from "../../src/service/grants.ts";
import { readSnapshot } from "../../src/service/observation.ts";
import { MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const approvals = new ApprovalStore(pool);
const profile = "grants-fixture";
before(async () => {
  await store.migrate();
  await pool.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,protected_tool) VALUES ($1,'pi',$2,'record_work_item') ON CONFLICT DO NOTHING",
    [profile, Buffer.alloc(32)]);
});
after(() => pool.end());

type Event = { type: string; [key: string]: unknown };
type Card = { approvalId: string; requestId: string; invocationId: string; memberId: string; version: number;
  choices: string[]; standingChoices?: string[] };
type Grant = { grantId: string; memberId: string; conversationId: string | null; scope: string; choice: string; toolName: string;
  policyVersion: number; approvalId: string; createdAt: string; status: string; revokedAt?: string; revocationReason?: string };

/** An in-process gateway whose member client goes straight to the stores, as Temporal activities do. */
async function fixture(t: TestContext) {
  const token = randomUUID(), stranger = randomUUID();
  const owners = { [token]: "owner-" + randomUUID(), [stranger]: "owner-" + randomUUID() };
  const members = {
    async open(input: Parameters<MemberStore["openConversation"]>[0]) { return store.openConversation(input); },
    async accept(input: TurnRequest) { await store.recordAcceptance(input, ownerInitiator); return { requestId: input.requestId }; },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return store.requestStatus(input); },
    // MemberClient.decide: a recorded answer first, then the workflow's decideApproval activity.
    async decide(input: Parameters<ApprovalStore["decide"]>[0]) { return await approvals.previousDecision(input) ?? approvals.decide(input); },
    async cancelPending() {},
  } as unknown as MemberClient;
  const server = createGateway(store, members, Object.fromEntries(Object.entries(owners)
    .map(([secret, owner]) => [createHash("sha256").update(secret).digest("hex"), owner])));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  function api(path: string, body?: unknown, credential = token, method = body === undefined ? "GET" : "POST") {
    return fetch(endpoint + path, { method, headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function ok(path: string, body?: unknown, credential = token) {
    const response = await api(path, body, credential);
    assert.ok(response.ok, `${path} returned ${response.status}: ${await response.clone().text()}`);
    return response.json();
  }
  async function spawn(credential = token): Promise<string> {
    return (await ok("/v1/members", { requestId: randomUUID(), engine: "pi", profile }, credential)).memberId;
  }
  async function open(memberId: string, credential = token) {
    const conversationId = randomUUID();
    await ok("/v1/conversations", { conversationId, memberId }, credential);
    const ownerId = owners[credential];
    let turn: { requestId: string; token: string } | undefined;
    let calls = 0;
    return {
      conversationId, memberId, ownerId, credential,
      /** Starts the next request as the workflow would, admitted through the v1 route unless told otherwise. */
      async request(admit = true) {
        const requestId = randomUUID(), text = "record " + requestId;
        if (admit) assert.equal((await api(`/v1/conversations/${conversationId}/requests`, { requestId, text }, credential)).status, 202);
        const start = await store.beginTurn({ ownerId, conversationId, requestId, text });
        assert.equal(start.kind, "start"); if (start.kind !== "start") throw new Error("unreachable");
        turn = { requestId, token: start.token };
        return turn;
      },
      propose(toolName: "record_work_item" | "choose_next_step" = "record_work_item") {
        assert.ok(turn);
        return approvals.propose({ ownerId, memberId, conversationId, requestId: turn.requestId, token: turn.token,
          invocationId: turn.requestId, nativeCallId: "call-" + calls++, toolName,
          arguments: toolName === "record_work_item" ? { operation_id: turn.requestId, note: "private grant note" } : {} } as never);
      },
      settle(approval: Approval) {
        assert.ok(turn);
        const { approvalId, invocationId, nativeCallId, requestId } = approval;
        return approvals.settle({ ownerId, memberId, conversationId, requestId, approvalId, invocationId, nativeCallId, token: turn.token });
      },
      async commit() {
        assert.ok(turn);
        await store.commitTurn({ ownerId, conversationId, requestId: turn.requestId, token: turn.token, reply: "done",
          checkpoint: { version: 1, engine: "pi", state: {} } });
      },
      async state() { return (await ok(`/v1/conversations/${conversationId}`, undefined, credential)).state; },
      decide(card: Pick<Card, "approvalId" | "requestId" | "invocationId" | "version">, choice: string, as = credential) {
        const { approvalId, requestId, invocationId, version } = card;
        return api(`/v1/conversations/${conversationId}/human`, { memberId, requestId, invocationId, approvalId, version, choice }, as);
      },
      async status(requestId: string) { return (await ok(`/v1/conversations/${conversationId}/requests/${requestId}`, undefined, credential)).status; },
    };
  }
  async function grants(memberId: string, credential = token): Promise<{ active: Grant[]; inactive: Grant[] }> {
    return ok(`/v1/members/${memberId}/grants`, undefined, credential);
  }
  function revoke(memberId: string, grantId: string, credential = token) {
    return api(`/v1/members/${memberId}/grants/${grantId}/revoke`, {}, credential);
  }
  async function audit(query: string, credential = token) {
    return (await ok("/v1/audit" + query, undefined, credential)).events as { type: string; actor: { kind: string; id: string | null };
      conversationId: string | null; requestId: string | null; payload: Record<string, string> }[];
  }
  /** An official AG-UI client observing the conversation through the gateway. */
  function observe(conversationId: string) {
    const agent = new HttpAgent({ url: `${endpoint}/v1/conversations/${conversationId}/events`, threadId: conversationId,
      headers: { Authorization: "Bearer " + token } });
    const events: Event[] = [];
    void agent.runAgent({}, { onEvent({ event }) { events.push({ ...event }); } }).catch(() => {});
    t.after(() => agent.abortRun());
    return events;
  }
  return { api, ok, spawn, open, grants, revoke, audit, observe, token, stranger, owners };
}

async function until<T>(check: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await delay(25)) {
    const value = await check();
    if (value !== undefined) return value;
  }
  throw new Error("Timed out: " + what);
}

const standingChoices = ["allow_conversation", "allow_always"];
function answer(approval: Approval, choice: string) {
  const { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId, argumentDigest, version } = approval;
  return { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId, argumentDigest, version, choice } as never;
}

test("a standing answer creates a grant, reports its choice and approves the next call without a card", async (t) => {
  const f = await fixture(t);
  const memberId = await f.spawn();
  const chat = await f.open(memberId);
  const observer = f.observe(chat.conversationId);
  const first = await chat.request();
  const a1 = await chat.propose();
  const [card] = (await chat.state()).pendingApprovals as Card[];
  // An old client renders choices and never offers a standing grant.
  assert.deepEqual(card.choices, ["approve", "deny"]);
  assert.deepEqual(card.standingChoices, standingChoices);
  assert.equal(card.approvalId, a1.approvalId);
  assert.equal(await chat.status(first.requestId), "waiting");

  const answered = await chat.decide(card, "allow_conversation");
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { approvalId: a1.approvalId, decision: "allow_conversation" });
  assert.deepEqual(await (await chat.decide(card, "allow_conversation")).json(), { approvalId: a1.approvalId, decision: "allow_conversation" });
  for (const other of ["approve", "allow_always", "deny"]) assert.equal((await chat.decide(card, other)).status, 409, other);
  // A retried decision activity reaches the store again and reads the same choice back.
  assert.equal(await approvals.decide(answer(a1, "allow_conversation")), "allow_conversation");
  const { active: [grant], inactive } = await f.grants(memberId);
  assert.deepEqual(inactive, []);
  assert.match(grant.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.deepEqual({ ...grant, grantId: undefined, createdAt: undefined }, { grantId: undefined, createdAt: undefined, memberId,
    conversationId: chat.conversationId, scope: "conversation", choice: "allow_conversation", toolName: "record_work_item",
    policyVersion: 1, approvalId: a1.approvalId, status: "active" });
  assert.equal((await chat.settle(a1)).kind, "recorded");
  await chat.commit();

  const second = await chat.request();
  const a2 = await chat.propose();
  assert.equal(a2.grantId, grant.grantId);
  // A retried proposal reads the decision back instead of matching again.
  assert.deepEqual(await approvals.propose({ ownerId: chat.ownerId, memberId, conversationId: chat.conversationId,
    requestId: second.requestId, token: second.token, invocationId: second.requestId, nativeCallId: a2.nativeCallId,
    toolName: "record_work_item", arguments: { operation_id: second.requestId, note: "private grant note" } }), a2);
  const state = await chat.state();
  assert.deepEqual(state.pendingApprovals, []);
  assert.equal(state.phase, "running");
  assert.deepEqual(state.grantedCalls, [{ requestId: second.requestId, approvalId: a2.approvalId, grantId: grant.grantId, scope: "conversation" }]);
  assert.deepEqual(await approvals.pending({ ownerId: chat.ownerId, memberId, conversationId: chat.conversationId }), []);
  assert.equal(await chat.status(second.requestId), "running");
  // The grant's approval is fixed: approve repeats it, any other answer conflicts, and nothing is recorded.
  const auditedBefore = (await f.audit("?conversationId=" + chat.conversationId)).length;
  assert.deepEqual(await (await chat.decide({ ...a2, version: 1 }, "approve")).json(), { approvalId: a2.approvalId, decision: "approve" });
  for (const other of ["deny", "allow_always", "allow_conversation"]) assert.equal((await chat.decide({ ...a2, version: 1 }, other)).status, 409, other);
  assert.equal((await f.audit("?conversationId=" + chat.conversationId)).length, auditedBefore);
  assert.equal((await chat.settle(a2)).kind, "recorded");

  // The observer saw the same tool-call frames, a state with no card naming the grant, then the result.
  const frames = await until(() => {
    const start = observer.findIndex(e => e.type === "TOOL_CALL_START" && e.toolCallId === a2.approvalId);
    const result = observer.findIndex(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === a2.approvalId);
    return start >= 0 && result > start ? observer.slice(start, result + 1) : undefined;
  }, "observer frames for the granted call");
  assert.deepEqual(frames.filter(e => e.type.startsWith("TOOL_CALL")).map(e => e.type),
    ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
  const snapshots = frames.filter(e => e.type === "STATE_SNAPSHOT").map(e => e.snapshot as typeof state);
  assert.ok(snapshots.length > 0 && snapshots.every(s => s.pendingApprovals.length === 0 && s.phase === "running"));
  assert.deepEqual(snapshots[0].grantedCalls, state.grantedCalls);
  assert.ok(!observer.some(e => e.type === "STATE_SNAPSHOT" &&
    (e.snapshot as typeof state).pendingApprovals.some((p: Card) => p.approvalId === a2.approvalId)));
  assert.ok(!JSON.stringify(observer).includes("private grant note"));

  // The work-item budget and the call cap still apply to granted calls.
  const again = await chat.propose();
  assert.equal(again.grantId, grant.grantId);
  assert.equal((await chat.settle(again)).kind, "budget_exhausted");
  for (let call = 2; call < 16; call++) assert.equal((await chat.propose()).grantId, grant.grantId);
  await assert.rejects(chat.propose(), { code: "input_limit" });
  await chat.commit();
  // The snapshot lists the most recent 16 granted calls; the audit trail keeps them all.
  const third = await chat.request();
  const a3 = await chat.propose();
  const recent = (await chat.state()).grantedCalls;
  assert.equal(recent.length, 16);
  assert.deepEqual(recent.at(-1), { requestId: third.requestId, approvalId: a3.approvalId, grantId: grant.grantId, scope: "conversation" });
  assert.ok(!recent.some((entry: { approvalId: string }) => entry.approvalId === a2.approvalId));

  // Another conversation of the same member still asks.
  const elsewhere = await f.open(memberId);
  await elsewhere.request();
  assert.equal((await elsewhere.propose()).grantId, undefined);
  assert.deepEqual(((await elsewhere.state()).pendingApprovals as Card[])[0].standingChoices, standingChoices);

  const events = await f.audit("?conversationId=" + chat.conversationId);
  const decided = events.find(e => e.type === "approval.decided")!;
  assert.deepEqual({ actor: decided.actor, choice: decided.payload.choice }, { actor: { kind: "owner", id: chat.ownerId }, choice: "allow_conversation" });
  const created = events.filter(e => e.type === "grant.created");
  assert.deepEqual(created.map(e => ({ actor: e.actor, requestId: e.requestId, payload: e.payload })), [{ actor: { kind: "owner", id: chat.ownerId },
    requestId: first.requestId, payload: { grantId: grant.grantId, approvalId: a1.approvalId, scope: "conversation" } }]);
  const granted = events.filter(e => e.type === "approval.auto_approved");
  assert.equal(granted.length, 17);
  assert.deepEqual({ actor: granted[0].actor, requestId: granted[0].requestId, payload: granted[0].payload }, { actor: { kind: "system", id: null },
    requestId: second.requestId, payload: { approvalId: a2.approvalId, invocationId: second.requestId, toolName: "record_work_item",
      argumentDigest: a2.argumentDigest, grantId: grant.grantId } });
  assert.equal(events.filter(e => e.type === "work_item.committed").length, 2);
  assert.ok(!JSON.stringify(events).includes("private grant note"));
});

test("allow_always covers the member's other conversations and no other member or owner", async (t) => {
  const f = await fixture(t);
  const [memberId, sibling] = [await f.spawn(), await f.spawn()];
  const chat = await f.open(memberId);
  await chat.request();
  const card = await chat.propose();
  assert.deepEqual(await (await chat.decide(card, "allow_always")).json(), { approvalId: card.approvalId, decision: "allow_always" });
  const { active: [grant] } = await f.grants(memberId);
  assert.deepEqual([grant.scope, grant.choice, grant.conversationId], ["member", "allow_always", null]);

  const other = await f.open(memberId);
  const { requestId } = await other.request();
  const granted = await other.propose();
  assert.equal(granted.grantId, grant.grantId);
  assert.deepEqual((await other.state()).grantedCalls, [{ requestId, approvalId: granted.approvalId, grantId: grant.grantId, scope: "member" }]);

  const unrelated = await f.open(sibling);
  await unrelated.request();
  assert.equal((await unrelated.propose()).grantId, undefined);
  assert.deepEqual(await f.grants(sibling), { apiVersion: "1", memberId: sibling, active: [], inactive: [] });

  // Another owner can neither see nor revoke the grant, and their own member is unaffected.
  assert.equal((await f.api(`/v1/members/${memberId}/grants`, undefined, f.stranger)).status, 404);
  assert.equal((await f.revoke(memberId, grant.grantId, f.stranger)).status, 404);
  const theirs = await f.spawn(f.stranger);
  const foreign = await f.open(theirs, f.stranger);
  await foreign.request();
  assert.equal((await foreign.propose()).grantId, undefined);
  assert.equal((await chat.decide(card, "allow_always", f.stranger)).status, 404);
  assert.deepEqual((await f.grants(memberId)).active.map(g => g.grantId), [grant.grantId]);
  assert.deepEqual(await f.audit("", f.stranger).then(events => events.filter(e => e.type.startsWith("grant."))), []);

  // Two concurrent allow_always answers leave one active grant and one creation event.
  const [left, right] = [await f.open(sibling), await f.open(sibling)];
  const cards = [];
  for (const side of [left, right]) { await side.request(); cards.push(await side.propose()); }
  const answers = await Promise.all([left.decide(cards[0], "allow_always"), right.decide(cards[1], "allow_always")]);
  assert.deepEqual(answers.map(r => r.status), [200, 200]);
  const { active } = await f.grants(sibling);
  assert.equal(active.length, 1);
  assert.ok(cards.some(c => c.approvalId === active[0].approvalId));
  const { rows: [{ n }] } = await pool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events
    WHERE member_id=$1 AND event_type='grant.created'`, [sibling]);
  assert.equal(n, 1);
});

test("a request without an owner admission, a child call or a question never uses or offers a grant", async (t) => {
  const f = await fixture(t);
  const memberId = await f.spawn();
  const chat = await f.open(memberId);
  await chat.request();
  await chat.decide(await chat.propose(), "allow_always");

  // Admitted by a workflow history older than durable admission: no admission row is not the owner.
  const legacy = await f.open(memberId);
  await legacy.request(false);
  const unadmitted = await legacy.propose();
  assert.equal(unadmitted.grantId, undefined);
  const [plain] = (await legacy.state()).pendingApprovals as Card[];
  assert.equal(plain.standingChoices, undefined);
  assert.deepEqual(plain.choices, ["approve", "deny"]);
  assert.equal((await legacy.decide(plain, "allow_always")).status, 409);
  assert.equal((await legacy.decide(plain, "approve")).status, 200);

  const asking = await f.open(memberId);
  await asking.request();
  const question = await asking.propose("choose_next_step");
  assert.equal(question.grantId, undefined);
  const [prompt] = (await asking.state()).pendingQuestions as Card[];
  assert.deepEqual([prompt.choices, prompt.standingChoices], [["inspect", "test"], undefined]);
  for (const choice of standingChoices) assert.equal((await asking.decide(prompt, choice)).status, 409);

  // A Pi child's protected call.
  const parent = await f.open(memberId);
  const { requestId, token } = await parent.request();
  const conversation = await store.getConversation({ ownerId: parent.ownerId, conversationId: parent.conversationId });
  const children = new ChildStore(pool);
  const [child] = await children.delegate(conversation, requestId, token, [{ nativeCallId: "delegate-1", task: "record it",
    profile: { role: "recorder", version: 1, ...fixedRoles.recorder, model: "fixture" } }],
  { version: 1, engine: "pi", state: {} });
  const started = await children.begin(child, { workflowRunId: randomUUID(), activityId: "child", attempt: 1 });
  assert.equal(started.kind, "start"); if (started.kind !== "start") return;
  const childCall = await approvals.propose({ ownerId: parent.ownerId, memberId, conversationId: parent.conversationId, requestId,
    token: started.generation, invocationId: child.childId, nativeCallId: "child-call", toolName: "record_work_item",
    arguments: { operation_id: requestId } }, { version: 1, engine: "pi", state: {} }, { childGeneration: started.generation });
  assert.equal(childCall.grantId, undefined);
  const childCard = ((await parent.state()).pendingApprovals as Card[]).find(c => c.approvalId === childCall.approvalId)!;
  assert.equal(childCard.standingChoices, undefined);
  assert.equal((await parent.decide(childCard, "allow_conversation")).status, 409);
  // The database refuses a grant reference on any call but a top-level work item.
  await assert.rejects(pool.query("UPDATE birbcrew_ts.deferred_calls SET grant_scope='member' WHERE approval_id=$1", [childCall.approvalId]),
    { code: "23514" });
});

const sql = new URL("../../src/service/sql/", import.meta.url);
/** A separate database migrated through `version`, so its DDL stays away from other suites. */
async function databaseAt(t: TestContext, version: number) {
  const source = new URL(url!);
  const admin = new Pool({ connectionString: source.href });
  const database = testDatabaseName("grants_");
  await admin.query("CREATE DATABASE " + database);
  source.pathname = "/" + database;
  const separate = new Pool({ connectionString: source.href });
  t.after(async () => {
    try { await separate.end(); await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  });
  await separate.query("CREATE SCHEMA birbcrew_ts");
  await separate.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version) continue;
    await separate.query(await readFile(new URL(file, sql), "utf8"));
    await separate.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return separate;
}

test("a request admitted by any initiator but the owner is never granted", async (t) => {
  // A routine's request gets a card even under the owner's allow_always grant. An admission
  // recording a kind this release cannot read (as after a rollback) fails the proposal closed,
  // before any call is inserted, instead of matching the grant.
  const separate = await databaseAt(t, Infinity);
  await separate.query("ALTER TABLE birbcrew_ts.request_admissions DROP CONSTRAINT request_admissions_initiator_kind_check");
  const local = new MemberStore(separate), ledger = new ApprovalStore(separate);
  const ownerId = "owner-" + randomUUID();
  const { memberId } = await local.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  async function call(initiator: "owner" | "routine" | "fixture_kind") {
    const conversationId = randomUUID(), requestId = randomUUID(), text = "record " + requestId;
    await local.openConversation({ ownerId, memberId, conversationId });
    if (initiator === "owner") await local.recordAcceptance({ ownerId, conversationId, requestId, text }, ownerInitiator);
    else await separate.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind,initiator_id)
      VALUES ($1,$2,$3,$4,$5)`, [conversationId, requestId, createHash("sha256").update(text).digest(), initiator, randomUUID()]);
    const start = await local.beginTurn({ ownerId, conversationId, requestId, text });
    assert.equal(start.kind, "start"); if (start.kind !== "start") throw new Error("unreachable");
    const proposal = ledger.propose({ ownerId, memberId, conversationId, requestId, token: start.token, invocationId: requestId,
      nativeCallId: "call", toolName: "record_work_item", arguments: { operation_id: requestId } });
    return { proposal, conversationId };
  }
  const card = await (await call("owner")).proposal;
  await ledger.decide(answer(card, "allow_always"));
  assert.ok((await (await call("owner")).proposal).grantId);
  const scheduled = await (await call("routine")).proposal;
  assert.equal(scheduled.grantId, undefined);
  const other = await call("fixture_kind");
  await assert.rejects(other.proposal, /Unknown request initiator/);
  const { rows } = await separate.query("SELECT 1 FROM birbcrew_ts.deferred_calls WHERE conversation_id=$1", [other.conversationId]);
  assert.equal(rows.length, 0);
});

test("revoking ends a grant for later calls only, repeats harmlessly and belongs to its owner", async (t) => {
  const f = await fixture(t);
  const [memberId, sibling] = [await f.spawn(), await f.spawn()];
  const chat = await f.open(memberId);
  await chat.request();
  const card = await chat.propose();
  await chat.decide(card, "allow_conversation");
  await chat.settle(card);
  await chat.commit();
  const { active: [grant] } = await f.grants(memberId);
  await chat.request();
  const approved = await chat.propose();
  assert.equal(approved.grantId, grant.grantId);

  for (const [member, id, credential] of [[memberId, grant.grantId, f.stranger], [memberId, randomUUID(), f.token],
    [sibling, grant.grantId, f.token]] as const) assert.equal((await f.revoke(member, id, credential)).status, 404);
  const revoked = await f.revoke(memberId, grant.grantId);
  assert.equal(revoked.status, 200);
  const body = await revoked.json();
  assert.deepEqual({ ...body.grant, revokedAt: undefined }, { ...grant, status: "revoked", revokedAt: undefined, revocationReason: "owner" });
  assert.deepEqual(await (await f.revoke(memberId, grant.grantId)).json(), body, "a repeated revoke changes nothing");
  // A call the grant already approved stays approved.
  assert.equal((await chat.settle(approved)).kind, "recorded");
  await chat.commit();
  await chat.request();
  const asked = await chat.propose();
  assert.equal(asked.grantId, undefined);
  assert.deepEqual(((await chat.state()).pendingApprovals as Card[])[0].standingChoices, standingChoices);
  assert.deepEqual(await f.grants(memberId), { apiVersion: "1", memberId, active: [], inactive: [body.grant] });

  const revocations = (await f.audit("?conversationId=" + chat.conversationId)).filter(e => e.type === "grant.revoked");
  assert.deepEqual(revocations.map(e => ({ actor: e.actor, requestId: e.requestId, payload: e.payload })),
    [{ actor: { kind: "owner", id: chat.ownerId }, requestId: null, payload: { grantId: grant.grantId, reason: "owner" } }]);

  // A member-wide grant, revoked, leaves the next conversation asking again.
  await chat.decide(asked, "allow_always");
  const { active: [always] } = await f.grants(memberId);
  assert.equal((await f.revoke(memberId, always.grantId)).status, 200);
  const later = await f.open(memberId);
  await later.request();
  assert.equal((await later.propose()).grantId, undefined);

  // A conversation grant ends with its conversation: here a cancelled request closes it.
  const closing = await f.open(sibling);
  await closing.request();
  const closingCard = await closing.propose();
  await closing.decide(closingCard, "allow_conversation");
  await closing.settle(closingCard);
  await closing.commit();
  const { requestId } = await closing.request();
  await approvals.cancelTurn({ ownerId: closing.ownerId, memberId: sibling, conversationId: closing.conversationId, requestId });
  const [closed] = (await f.grants(sibling)).inactive;
  assert.deepEqual([closed.status, closed.revokedAt], ["conversation_closed", undefined]);

  // At most grantListLimit ended grants are listed, most recent first.
  for (let i = 0; i <= grantListLimit; i++) {
    const side = await f.open(sibling);
    await side.request();
    await side.decide(await side.propose(), "allow_conversation");
    const { active } = await f.grants(sibling);
    assert.equal((await f.revoke(sibling, active[0].grantId)).status, 200);
  }
  const { inactive } = await f.grants(sibling);
  assert.equal(inactive.length, grantListLimit);
  assert.ok(inactive.every((g, i) => i === 0 || g.revokedAt! <= inactive[i - 1].revokedAt!));

  for (const [path, body, method, status] of [[`/v1/members/${memberId}/grants?limit=1`, undefined, "GET", 400],
    [`/v1/members/${memberId}/grants`, {}, "POST", 405], [`/v1/members/${memberId}/grants/${grant.grantId}/revoke`, undefined, "GET", 405],
    [`/v1/members/${memberId}/grants/${grant.grantId}/revoke`, { reason: "x" }, "POST", 400], [`/members/${memberId}/grants`, undefined, "GET", 404],
    [`/v1/members/not-a-uuid/grants`, undefined, "GET", 400]] as const) {
    assert.equal((await f.api(path, body, f.token, method)).status, status, `${method} ${path}`);
  }
  // Grants are revoked, never deleted or changed otherwise.
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.tool_grants WHERE grant_id=$1", [grant.grantId]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.tool_grants SET revoked_at=NULL, revocation_reason=NULL WHERE grant_id=$1", [grant.grantId]),
    { code: "23514" });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.tool_grants SET conversation_id=NULL WHERE grant_id=$1", [closed.grantId]), { code: "23514" });
});

test("a grant names a card answered with its scope: the database refuses any other card, owner, member or conversation", async () => {
  const ownerId = "owner-" + randomUUID();
  const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const { memberId: sibling } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile });
  const [conversationId, elsewhere] = [randomUUID(), randomUUID()];
  for (const id of [conversationId, elsewhere]) await store.openConversation({ ownerId, memberId, conversationId: id });
  async function card(conversation: string) {
    const requestId = randomUUID(), text = "record";
    await store.recordAcceptance({ ownerId, conversationId: conversation, requestId, text }, ownerInitiator);
    const start = await store.beginTurn({ ownerId, conversationId: conversation, requestId, text });
    assert.equal(start.kind, "start"); if (start.kind !== "start") throw new Error("unreachable");
    return approvals.propose({ ownerId, memberId, conversationId: conversation, requestId, token: start.token, invocationId: requestId,
      nativeCallId: "call", toolName: "record_work_item", arguments: { operation_id: requestId } });
  }
  const undecided = await card(elsewhere);
  // An undecided call can carry neither a standing scope nor a grant.
  for (const column of ["grant_scope='conversation'", "grant_id=gen_random_uuid()"]) {
    await assert.rejects(pool.query(`UPDATE birbcrew_ts.deferred_calls SET ${column} WHERE approval_id=$1`, [undecided.approvalId]),
      { code: "23514" }, column);
  }
  // A card stored as answered allow_conversation, before its grant is inserted, as decideLocked leaves it.
  const answered = await card(conversationId);
  const insert = `INSERT INTO birbcrew_ts.tool_grants (owner_id,member_id,conversation_id,tool_name,policy_version,initiator_kind,approval_id)
    VALUES ($1,$2,$3,'record_work_item',1,'owner',$4)`;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE birbcrew_ts.deferred_calls SET decision='approve', grant_scope='conversation' WHERE approval_id=$1", [answered.approvalId]);
    for (const [owner, member, conversation, approvalId] of [[ownerId, sibling, conversationId, answered.approvalId],
      [ownerId, memberId, elsewhere, answered.approvalId], ["owner-" + randomUUID(), memberId, conversationId, answered.approvalId],
      [ownerId, memberId, null, answered.approvalId], [ownerId, memberId, elsewhere, undecided.approvalId]]) {
      await db.query("SAVEPOINT attempt");
      await assert.rejects(db.query(insert, [owner, member, conversation, approvalId]),
        { code: "23503", message: /not answered with this scope, or belongs to another owner, member or conversation/ },
        JSON.stringify([owner === ownerId, member === memberId, conversation, approvalId === answered.approvalId]));
      await db.query("ROLLBACK TO SAVEPOINT attempt");
    }
    await db.query(insert, [ownerId, memberId, conversationId, answered.approvalId]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("a conversation grant ends when its conversation stops accepting requests", async (t) => {
  const f = await fixture(t);
  const memberId = await f.spawn();
  async function granted() {
    const chat = await f.open(memberId);
    await chat.request();
    const card = await chat.propose();
    await chat.decide(card, "allow_conversation");
    await chat.settle(card);
    await chat.commit();
    return chat;
  }
  const status = async (conversationId: string) => {
    const { active, inactive } = await f.grants(memberId);
    return [...active, ...inactive].find(g => g.conversationId === conversationId)!.status;
  };
  // An uncertain turn.
  const uncertain = await granted();
  const turn = await uncertain.request();
  assert.equal(await status(uncertain.conversationId), "active");
  await store.markUncertain({ ownerId: uncertain.ownerId, conversationId: uncertain.conversationId, requestId: turn.requestId, token: turn.token });
  assert.equal(await status(uncertain.conversationId), "conversation_closed");
  // A rejected admission.
  const rejected = await granted();
  const queued = { ownerId: rejected.ownerId, conversationId: rejected.conversationId, requestId: randomUUID(), text: "queued" };
  await store.recordAcceptance(queued, ownerInitiator);
  await store.rejectAccepted(queued, "predecessor_failed");
  assert.equal(await status(rejected.conversationId), "conversation_closed");
  // The turn limit, once its last turn commits.
  const full = await granted();
  await pool.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1", [full.conversationId]);
  for (let turn = 2; turn <= 4; turn++) {
    await full.request();
    assert.equal(await status(full.conversationId), "active");
    await full.commit();
  }
  assert.equal(await status(full.conversationId), "conversation_closed");
});

/** Waits until another session waits for a row the holder's open transaction has locked. */
async function waitsFor(holder: PoolClient, what: string) {
  const { rows: [{ pid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await until(async () => (await pool.query(`SELECT 1 FROM pg_locks w JOIN pg_locks h ON h.locktype='transactionid'
    AND h.transactionid=w.transactionid AND h.granted AND h.pid=$1 WHERE w.locktype='transactionid' AND NOT w.granted`, [pid])).rowCount || undefined, what);
}

test("a revoke racing a proposal either commits first and the call gets a card, or waits and the call stays approved", async (t) => {
  const f = await fixture(t);
  for (const choice of ["allow_conversation", "allow_always"]) {
    const memberId = await f.spawn();
    const chat = await f.open(memberId);
    await chat.request();
    const card = await chat.propose();
    await chat.decide(card, choice);
    await chat.settle(card);
    await chat.commit();
    const target = choice === "allow_always" ? await f.open(memberId) : chat;
    const { active: [grant] } = await f.grants(memberId);

    // The proposal first: it holds the conversation row and reads the grant FOR SHARE, so the revoke waits.
    const { requestId, token } = await target.request();
    const proposer = await pool.connect();
    let revoke: Promise<Response> | undefined;
    try {
      await proposer.query("BEGIN");
      const approval = await approvals.proposeLocked(proposer, { ownerId: target.ownerId, memberId, conversationId: target.conversationId,
        requestId, token, invocationId: requestId, nativeCallId: "raced", toolName: "record_work_item", arguments: { operation_id: requestId } });
      assert.equal(approval.grantId, grant.grantId);
      revoke = f.revoke(memberId, grant.grantId);
      await waitsFor(proposer, "revoke waiting for the proposal");
      await proposer.query("COMMIT");
      assert.equal((await revoke).status, 200);
      assert.equal((await target.settle(approval)).kind, "recorded", "a call the grant approved stays approved");
    } finally {
      await proposer.query("ROLLBACK").catch(() => {});
      proposer.release();
    }
    await target.commit();
    assert.equal((await f.grants(memberId)).active.length, 0);
  }

  // The revoke first: a proposal waiting on the revoked grant row sees the revocation and asks.
  const memberId = await f.spawn();
  const chat = await f.open(memberId);
  await chat.request();
  await chat.decide(await chat.propose(), "allow_always");
  const { active: [grant] } = await f.grants(memberId);
  const target = await f.open(memberId);
  await target.request();
  const revoker = await pool.connect();
  try {
    await revoker.query("BEGIN");
    // The statement revokeGrant runs for a member-wide grant, held open.
    await revoker.query("UPDATE birbcrew_ts.tool_grants SET revoked_at=clock_timestamp(), revocation_reason='owner' WHERE grant_id=$1", [grant.grantId]);
    const proposal = target.propose();
    await waitsFor(revoker, "proposal waiting on the revoked grant");
    await revoker.query("COMMIT");
    assert.equal((await proposal).grantId, undefined);
  } finally {
    await revoker.query("ROLLBACK").catch(() => {});
    revoker.release();
  }
  assert.deepEqual(((await target.state()).pendingApprovals as Card[]).map(c => c.standingChoices), [standingChoices]);
});
