import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { Pool } from "pg";
import { recordSegmentUsage } from "../../src/service/usage.ts";
import type { PriceTable } from "../../src/service/usage-prices.ts";
import { ChildStore, type ChildKey } from "../../src/service/children.ts";
import { childTargetSchema, storedTarget, type ChildProfile } from "../../src/service/child-target.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { configuredDestination, providerHost } from "../../src/service/provider-identity.ts";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";
import { memberProfiles, type MemberProfile } from "../../src/service/profiles.ts";
import { MemberStore } from "../../src/service/store.ts";
import { runnerResultSchema } from "../../src/service/supervisor.ts";
import { verifyChildConfiguration } from "../../src/service/supervisor-child.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool), children = new ChildStore(pool);
const directory = await mkdtemp(join(tmpdir(), "crew-targets-"));
const pi = await createPiFixtureOptions(undefined, { id: "parent-model", baseUrl: "https://parent.fixture" });
const targetPi = await createPiFixtureOptions(undefined, { id: "child-model", baseUrl: "https://CHILD.fixture.:8443/v1" });
const checkpoint = { version: 1, engine: "pi", state: {} };
before(() => store.migrate());
after(async () => { await pool.end(); await rm(directory, { recursive: true, force: true }); });
function configuration() {
  const parent = "parent-" + randomUUID(), target = "target-" + randomUUID();
  const route = { engine: "pi", profile: target } as const;
  const config = new Map<string, MemberProfile>([
    [parent, { accountId: "parent-account", pi, delegateTask: true, protectedTool: "record_work_item", childTargets: { pi: { analyst: route, recorder: route } } }],
    [target, { accountId: "child-account", pi: targetPi, protectedTool: "record_work_item" }],
  ]);
  return { parent, target, route, config, register: () => registerProfiles(pool, config, directory) };
}
const proposal = (role: "analyst" | "recorder" = "analyst") => ({ nativeCallId: "call_" + randomUUID(), task: "remember private task",
  profile: { role, version: 1, ...fixedRoles[role], tools: [...fixedRoles[role].tools], model: pi.model.id } });
async function parentTurn(profile: string, ownerId = "owner-" + randomUUID()) {
  const request = { ownerId, requestId: randomUUID(), engine: "pi" as const, profile };
  const member = await store.spawn(request);
  const conversationId = randomUUID();
  await store.openConversation({ ownerId: member.ownerId, memberId: member.memberId, conversationId });
  const turnRequest = { ownerId: member.ownerId, conversationId, requestId: randomUUID(), text: "delegate" };
  const execution = { workflowRunId: randomUUID(), activityId: "parent", attempt: 1 };
  const turn = await store.beginTurn(turnRequest, execution);
  if (turn.kind !== "start") throw new Error("Expected parent start");
  return { member, request, turn, turnRequest, execution, delegate: (proposals: unknown[] = [proposal()]) => children.delegate(turn.conversation, turnRequest.requestId, turn.token, proposals, checkpoint) };
}
const row = async (childId: string) => (await pool.query("SELECT * FROM birbcrew_ts.pi_children WHERE child_id=$1", [childId])).rows[0];

test("named registration captures full consent and resolves fixed roles to the target model", async () => {
  const c = configuration(); await c.register();
  const p = await parentTurn(c.parent);
  const identity = configuredDestination(c.config, c.route);
  assert.deepEqual(p.member.subagents, { mode: "named", targets: ["analyst", "recorder"].map(role => ({ ...identity, role, availability: "executable" })) });
  const [key] = await p.delegate();
  assert.deepEqual(key.target, c.route);
  assert.deepEqual((await row(key.childId)).role_profile, { ...proposal().profile, model: "child-model", target: { version: 1, ...identity } });
  assert.deepEqual(await children.target({ ...key, target: { engine: "codex", profile: "forged" } }), c.route);
  assert.equal(childTargetSchema.safeParse((await row(key.childId)).role_profile.target).success, false, "old strict reader refuses full identity even on the correct queue");
  const api = new IntegrationApi(store, { accept: async () => { throw Error("unused"); }, cancelPending: async () => { throw Error("unused"); }, requestStatus: async () => { throw Error("unused"); } });
  const page = await api.listMembers(p.member.ownerId, {});
  assert.deepEqual(page.members[0].subagents, p.member.subagents);
  assert.equal((await api.listMembers("other-owner", {})).members.length, 0);
  await assert.rejects(children.delegate({ ...p.turn.conversation, ownerId: "other-owner" }, p.turnRequest.requestId, p.turn.token, [proposal()], checkpoint));
});

test("removal is permanent, omission is a no-op, and stale configs preserve recorded child launches", async () => {
  const c = configuration(); await c.register(); const p = await parentTurn(c.parent); const [key] = await p.delegate();
  const original = c.config.get(c.parent)!;
  c.config.set(c.parent, { ...original, childTargets: { pi: {} } }); await c.register();
  c.config.set(c.parent, original); await c.register();
  const replay = await store.spawn(p.request);
  assert.deepEqual(replay.subagents.targets.map(t => t.availability), ["removed", "removed"]);
  assert.deepEqual(replay.subagents.targets.map(({ availability, ...t }) => t), p.member.subagents.targets.map(({ availability, ...t }) => t));
  const removed = await parentTurn(c.parent);
  assert.deepEqual(removed.member.subagents, { mode: "named", targets: [] });
  await assert.rejects(removed.delegate(), /ineligible_target/);
  const execution = { workflowRunId: randomUUID(), activityId: "child", attempt: 1 };
  const started = await children.begin(key, execution);
  if (started.kind !== "start") throw new Error("Expected recorded child start after removal");
  const launch = { ...key, token: started.generation, execution, text: started.task };
  await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,child_id,token,workflow_run_id,activity_id,attempt)
    VALUES($1,$2,$3,$4,$5,$6,1)`, [key.conversationId, key.requestId, key.childId, launch.token, execution.workflowRunId, execution.activityId]);
  const { target: _target, ...childProfile } = (await row(key.childId)).role_profile;
  const conversation = { ...p.turn.conversation, profile: c.target };
  let calls = 0;
  const invoke = (config: ReadonlyMap<string, MemberProfile>) => withNativeAdmission(pool, launch, AbortSignal.timeout(10_000), async (_signal, db) => {
    await verifyChildConfiguration(db, launch, config, conversation, childProfile); calls++;
  });
  await invoke(c.config); assert.equal(calls, 1);
  for (const drift of [
    { ...c.config.get(c.target)!, accountId: "other-account" },
    { ...c.config.get(c.target)!, pi: { ...targetPi, model: { ...targetPi.model, id: "other-model" } } },
    { ...c.config.get(c.target)!, pi: { ...targetPi, model: { ...targetPi.model, baseUrl: "https://other.fixture" } } },
    { accountId: "child-account", claude: { model: "child-model", apiKey: "synthetic" } },
  ] satisfies MemberProfile[]) {
    await assert.rejects(invoke(new Map(c.config).set(c.target, drift))); assert.equal(calls, 1, "drift refused before provider callback");
  }
  const { childTargets: _removed, ...omitted } = original;
  c.config.set(c.parent, omitted); await c.register();
  assert.deepEqual((await store.spawn(p.request)).subagents, replay.subagents);
});

test("first registration seals legacy and explicitly empty named profiles without later widening", async () => {
  const c = configuration();
  const p = await parentTurn(c.parent);
  assert.deepEqual(p.member.subagents, { mode: "legacy", targets: [] });
  await assert.rejects(c.register(), /Existing members reserve legacy/);
  const entry = c.config.get(c.parent)!;
  const { childTargets: _targets, ...legacy } = entry;
  c.config.set(c.parent, legacy); await c.register();
  c.config.set(c.parent, entry); await assert.rejects(c.register(), /Legacy profile cannot gain/);
  const [untargeted] = await p.delegate(); assert.equal(untargeted.target, undefined);
  const empty = configuration(); const original = empty.config.get(empty.parent)!;
  empty.config.set(empty.parent, { ...original, childTargets: { pi: {} } }); await empty.register();
  assert.deepEqual((await parentTurn(empty.parent)).member.subagents, { mode: "named", targets: [] });
  empty.config.set(empty.parent, original); await assert.rejects(empty.register(), /cannot change/);
});

test("new role keys, target replacement, malformed declarations and engine/tool violations fail closed", async () => {
  const c = configuration(); await c.register();
  c.config.set(c.target, { ...c.config.get(c.target)!, pi: { ...targetPi, model: { ...targetPi.model, id: "new-model" } } });
  await assert.rejects(c.register(), /cannot change/);
  for (const engine of ["claude", "codex"] as const) {
    const x = configuration(); const base = x.config.get(x.parent)!;
    x.config.set(x.parent, { ...base, [engine]: { model: "future", apiKey: "synthetic" }, childTargets: { [engine]: { recorder: x.route } } });
    await assert.rejects(x.register(), /exceeds parent or target/);
    x.config.set(x.parent, { ...base, [engine]: { model: "future", apiKey: "synthetic" }, childTargets: { [engine]: { analyst: x.route } } });
    await x.register();
    const member = await store.spawn({ ownerId: randomUUID(), requestId: randomUUID(), engine, profile: x.parent });
    assert.equal(member.subagents.targets[0].availability, "unsupported_engine");
  }
  for (const engine of ["claude", "codex"] as const) {
    const future = configuration();
    future.config.set(future.target, { accountId: "future-target", [engine]: { model: "future-model", apiKey: "synthetic" } });
    future.config.set(future.parent, { ...future.config.get(future.parent)!, childTargets: { pi: { analyst: { engine, profile: future.target } } } });
    await future.register();
    const parent = await parentTurn(future.parent);
    assert.equal(parent.member.subagents.targets[0].availability, "unsupported_engine");
    await assert.rejects(parent.delegate(), /unsupported_engine/);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.pi_children WHERE request_id=$1", [parent.turnRequest.requestId])).rowCount, 0);
  }
  const codexTools = configuration();
  codexTools.config.set(codexTools.target, { accountId: "codex", codex: { model: "future", apiKey: "synthetic" }, protectedTool: "record_work_item" });
  codexTools.config.set(codexTools.parent, { ...codexTools.config.get(codexTools.parent)!, childTargets: { pi: { recorder: { engine: "codex", profile: codexTools.target } } } });
  await assert.rejects(codexTools.register(), /exceeds parent or target/);
  const malformed = configuration();
  Object.assign(malformed.config.get(malformed.parent)!, { childTargets: { pi: { custom: malformed.route } } });
  await assert.rejects(malformed.register());
  const noTools = configuration(); noTools.config.set(noTools.target, { accountId: "child-account", pi: targetPi });
  await assert.rejects(noTools.register(), /exceeds parent or target/);
  const noParentTools = configuration();
  noParentTools.config.set(noParentTools.parent, { ...noParentTools.config.get(noParentTools.parent)!, protectedTool: undefined });
  await assert.rejects(noParentTools.register(), /exceeds parent or target/);
});

test("SQL rejects forged and malformed child roles, targets, consent and immutable identity edits", async () => {
  const c = configuration(); await c.register(); const p = await parentTurn(c.parent); const [key] = await p.delegate();
  const good = (await row(key.childId)).role_profile;
  const other = await parentTurn(c.parent);
  await pool.query("INSERT INTO birbcrew_ts.delegations(conversation_id,request_id,parent_checkpoint) VALUES($1,$2,$3)", [other.turnRequest.conversationId, other.turnRequest.requestId, checkpoint]);
  for (const malformed of [
    { ...good, target: c.route }, { ...good, target: null }, { ...good, target: { ...good.target, providerHost: "other.fixture" } },
    { ...good, role: "custom" }, { ...good, instructions: "custom" }, { ...good, tools: ["record_work_item"] },
    { ...good, model: "parent-model" }, { ...good, model: null }, { ...good, target: { version: 1 } },
    { ...good, target: { ...good.target, accountDigest: null } }, {},
  ]) {
    await assert.rejects(pool.query(`INSERT INTO birbcrew_ts.pi_children(conversation_id,request_id,native_call_id,ordinal,task,role_profile)
      VALUES($1,$2,$3,0,'private',$4)`, [other.turnRequest.conversationId, other.turnRequest.requestId, randomUUID(), malformed]));
    await assert.rejects(pool.query("UPDATE birbcrew_ts.pi_children SET role_profile=$2 WHERE child_id=$1", [key.childId, malformed]));
  }
  await pool.query("UPDATE birbcrew_ts.pi_children SET role_profile=role_profile WHERE child_id=$1", [key.childId]);
  await assert.rejects(pool.query("UPDATE birbcrew_ts.members SET child_target_consent='{}' WHERE member_id=$1", [p.member.memberId]));
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.profiles WHERE name=$1", [c.parent]));
  await assert.rejects(pool.query("UPDATE birbcrew_ts.profiles SET child_target_seal='{}' WHERE name=$1", [c.parent]));
  const inserted = await pool.query("INSERT INTO birbcrew_ts.members(owner_id,spawn_request_id,engine,profile,child_target_consent) VALUES($1,$2,'pi',$3,'{}') RETURNING child_target_consent", [randomUUID(), randomUUID(), c.parent]);
  assert.equal(inserted.rows[0].child_target_consent.mode, "named", "SQL stamps consent from joined authority");
  await assert.rejects(other.delegate([{ ...proposal(), profile: { ...proposal().profile, target: c.route } }]));
  await assert.rejects(other.delegate([{ ...proposal(), profile: { ...proposal().profile, instructions: "forged" } }]));
});

test("SQL preserves the child's original identity and authority binding through lifecycle updates", async () => {
  const c = configuration(); await c.register();
  const p = await parentTurn(c.parent), [key] = await p.delegate();
  const original = await row(key.childId);
  const empty = configuration();
  empty.config.set(empty.parent, { ...empty.config.get(empty.parent)!, childTargets: { pi: {} } });
  await empty.register();
  for (const ownerId of [p.member.ownerId, "owner-" + randomUUID()]) {
    const other = await parentTurn(empty.parent, ownerId);
    assert.deepEqual(other.member.subagents, { mode: "named", targets: [] });
    await pool.query("INSERT INTO birbcrew_ts.delegations(conversation_id,request_id,parent_checkpoint) VALUES($1,$2,$3)",
      [other.turnRequest.conversationId, other.turnRequest.requestId, checkpoint]);
    for (const assignment of ["conversation_id=$2,request_id=$3", "conversation_id=$2,request_id=$3,role_profile=role_profile"]) {
      await assert.rejects(pool.query(`UPDATE birbcrew_ts.pi_children SET ${assignment} WHERE child_id=$1`,
        [key.childId, other.turnRequest.conversationId, other.turnRequest.requestId]), { code: "23514" });
      assert.deepEqual(await row(key.childId), original);
    }
    const mismatched = { ...key, ownerId, memberId: other.member.memberId,
      conversationId: other.turnRequest.conversationId, requestId: other.turnRequest.requestId };
    await assert.rejects(children.begin(mismatched, { workflowRunId: randomUUID(), activityId: "child", attempt: 1 }), { code: "not_found" });
    assert.deepEqual(await row(key.childId), original);
  }
  for (const [column, value] of [
    ["child_id", randomUUID()], ["conversation_id", randomUUID()], ["request_id", randomUUID()],
    ["role_profile", { ...original.role_profile, model: "different-model" }],
  ]) {
    await assert.rejects(pool.query(`UPDATE birbcrew_ts.pi_children SET ${column}=$2 WHERE child_id=$1`, [key.childId, value]), { code: "23514" });
    assert.deepEqual(await row(key.childId), original);
  }
  assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1", [key.childId])).rowCount, 0);
  await pool.query(`UPDATE birbcrew_ts.pi_children SET child_id=child_id,conversation_id=conversation_id,
    request_id=request_id,role_profile=role_profile WHERE child_id=$1`, [key.childId]);
  assert.deepEqual(await row(key.childId), original);
  const started = await children.begin(key, { workflowRunId: randomUUID(), activityId: "child", attempt: 1 });
  if (started.kind !== "start") throw Error("Expected original child to start");
  await pool.query("UPDATE birbcrew_ts.pi_children SET native_checkpoint=$2 WHERE child_id=$1", [key.childId, checkpoint]);
  const running = await row(key.childId);
  assert.equal(running.phase, "running");
  assert.equal(running.generation, started.generation);
  assert.deepEqual(running.native_checkpoint, checkpoint);
  for (const column of ["child_id", "conversation_id", "request_id", "role_profile"]) assert.deepEqual(running[column], original[column]);
});

test("fixed SQL role definitions match the exported package and the runner has no target authority", async () => {
  const migration = await readFile(new URL("../../src/service/sql/037-named-child-targets.sql", import.meta.url), "utf8");
  for (const definition of Object.values(fixedRoles)) assert.ok(migration.includes(definition.instructions));
  const reply = { kind: "delegated", checkpoint, proposals: [proposal()] };
  assert.equal(runnerResultSchema.safeParse(reply).success, true);
  assert.equal(runnerResultSchema.safeParse({ ...reply, proposals: [{ ...proposal(), profile: { ...proposal().profile, target: { engine: "pi", profile: "target" } } }] }).success, false);
  assert.throws(() => storedTarget({ engine: "pi", profile: "historical" }), /invalid_target/);
});

test("provider identity canonicalizes hosts and ports and never invokes opaque routing callbacks", async () => {
  assert.equal(providerHost("https://EXAMPLE.com.:8443/v1"), "example.com:8443");
  assert.equal(providerHost("http://[2001:db8::1]:8080/v1"), "[2001:db8::1]:8080");
  for (const endpoint of ["https://user:secret@example.com", "https://example.com?secret=1", "https://example.com#secret", "file:///tmp/provider"]) assert.throws(() => providerHost(endpoint));
  let callbacks = 0;
  const opaque: MemberProfile = { accountId: "fixture", codex: { model: "future", proxyTransport: async () => { callbacks++; throw Error("must not run"); } } };
  assert.throws(() => configuredDestination(new Map([["opaque", opaque]]), { engine: "codex", profile: "opaque" }), /unavailable/);
  assert.equal(callbacks, 0);
  const direct: MemberProfile = { accountId: "direct", pi: targetPi,
    upstreamIdentity: { pi: { model: targetPi.model.id, providerHost: "other.fixture", relayHost: "child.fixture:8443" } } };
  assert.throws(() => configuredDestination(new Map([["direct", direct]]), { engine: "pi", profile: "direct" }), /differs from proxy routing/);
});


test("a named Pi child sends its sealed model to the captured proxy upstream", { timeout: 60_000 }, async t => {
  const requests: unknown[] = [];
  const upstream = createServer(async (request, response) => {
    requests.push(await json(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "fixture accepted" }, null], [{}, "stop"]]) {
      response.write("data: " + JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1,
        model: "network-child", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    }
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  let credentials = 0;
  const proxy = await createProxyProfile({ engine: "pi", protocol: "openai-chat-completions", accountId: "network-account",
    model: "network-child", endpoint: `http://127.0.0.1:${address.port}/chat/completions`, allowHttpLoopback: true,
    resolveCredential: async () => { credentials++; return { headers: { authorization: "Bearer synthetic" }, expiresAt: Date.now() + 60_000 }; } });
  t.after(proxy.close);
  const c = configuration();
  c.config.set(c.parent, { ...c.config.get(c.parent)!, childTargets: { pi: { analyst: c.route } } });
  c.config.set(c.target, proxy.profile); await c.register(); assert.equal(credentials, 0);
  const p = await parentTurn(c.parent), [key] = await p.delegate();
  const execution = { workflowRunId: randomUUID(), activityId: "network-child", attempt: 1 };
  const started = await children.begin(key, execution); if (started.kind !== "start") throw Error("Expected child start");
  const launch = { ...key, token: started.generation, execution, text: started.task };
  await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,child_id,token,workflow_run_id,activity_id,attempt)
    VALUES($1,$2,$3,$4,$5,$6,1)`, [key.conversationId, key.requestId, key.childId, launch.token, execution.workflowRunId, execution.activityId]);
  const { target: sealed, ...childProfile } = (await row(key.childId)).role_profile;
  assert.equal(sealed.providerHost, `127.0.0.1:${address.port}`);
  const conversation = { ...p.turn.conversation, profile: c.target };
  const driver = memberProfiles(c.config, directory).get(c.target)!.pi!;
  const result = await withNativeAdmission(pool, launch, t.signal, async (signal, db) => {
    await verifyChildConfiguration(db, launch, c.config, conversation, childProfile);
    return driver({ threadId: key.childId, runId: key.requestId, text: started.task, checkpoint: null, childProfile, signal }, conversation);
  });
  assert.equal(result.kind, "complete");
  assert.equal(result.kind === "complete" && result.text, "fixture accepted");
  assert.equal(requests.length, 1); assert.equal(credentials, 1);
  assert.match(JSON.stringify(requests[0]), /"model":"network-child"/);
  assert.match(JSON.stringify(requests[0]), /remember private task/);
  const changed = { ...proxy.profile, pi: { ...proxy.profile.pi!, model: { ...proxy.profile.pi!.model, baseUrl: "http://127.0.0.1:9" } } };
  await assert.rejects(withNativeAdmission(pool, launch, t.signal, (_signal, db) =>
    verifyChildConfiguration(db, launch, new Map(c.config).set(c.target, changed), conversation, childProfile)), /differs from proxy routing/);
  assert.equal(requests.length, 1, "stale upstream metadata cannot mask changed relay routing");
});


test("named children cannot delegate and receive only their fixed tools on a nondelegating target", async t => {
  const c = configuration();
  const tools: string[][] = [];
  const observed = await createPiFixtureOptions(context => { tools.push(getCurrentTools(context.messages).map(tool => tool.name).sort()); },
    { id: "child-model", baseUrl: "https://child.fixture:8443" });
  c.config.set(c.target, { ...c.config.get(c.target)!, pi: observed,
    claude: { model: "fixture", apiKey: "synthetic", baseUrl: "http://127.0.0.1:9" }, codex: { model: "fixture", baseUrl: "http://127.0.0.1:9" } });
  await c.register(); const p = await parentTurn(c.parent), [key] = await p.delegate();
  const start = await children.begin(key, { workflowRunId: randomUUID(), activityId: "child", attempt: 1 });
  if (start.kind !== "start") throw Error("Expected child start");
  await assert.rejects(children.delegate(p.turn.conversation, p.turnRequest.requestId, start.generation, [proposal()], checkpoint),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stale");
  const drivers = memberProfiles(c.config, directory).get(c.target)!;
  const member = { ...p.turn.conversation, profile: c.target };
  const input = (childProfile: ChildProfile, text: string) => ({ threadId: randomUUID(), runId: randomUUID(), text,
    checkpoint: null, childProfile, signal: t.signal });
  for (const role of ["analyst", "recorder"] as const) {
    const childProfile = { ...proposal(role).profile, version: 1 as const, model: observed.model.id };
    const result = await drivers.pi!(input(childProfile, "remember " + role), member);
    assert.deepEqual([result.kind, "text" in result && result.text], ["complete", "stored " + role]);
  }
  assert.deepEqual(tools, [[], ["record_work_item"]]);
  const childProfile = { ...proposal().profile, version: 1 as const, model: "other-model" };
  await assert.rejects(drivers.pi!(input(childProfile, "remember"), member), /Child profile differs/);
  for (const engine of ["claude", "codex"] as const) {
    await assert.rejects(drivers[engine]!(input(childProfile, "remember"), { ...member, engine }), /unsupported_engine/);
  }
  assert.equal(tools.length, 2, "refused model and engine make no provider call");
});

test("named child spend stays with its parent member and uses the reported model price", async () => {
  const c = configuration(); await c.register(); const p = await parentTurn(c.parent), [key] = await p.delegate();
  const legacy = await parentTurn("legacy-usage-" + randomUUID()), [untargeted] = await legacy.delegate();
  const prices: PriceTable = new Map([["parent-model", { input: "1", cachedInput: "1", cacheWrite: "1", output: "2" }],
    ["provider-actual", { input: "10", cachedInput: "10", cacheWrite: "10", output: "20" }]]);
  async function spend(owner: typeof p, child: ChildKey | undefined, model: string) {
    let token = owner.turn.token, execution = owner.execution;
    if (child) {
      execution = { workflowRunId: randomUUID(), activityId: "child", attempt: 1 };
      const start = await children.begin(child, execution); if (start.kind !== "start") throw Error("Expected child start");
      token = start.generation;
    }
    await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,token,workflow_run_id,activity_id,attempt,child_id)
      VALUES($1,$2,$3,$4,$5,1,$6)`, [owner.turnRequest.conversationId, owner.turnRequest.requestId, token, execution.workflowRunId, execution.activityId, child?.childId ?? null]);
    await recordSegmentUsage(pool, { ...owner.turnRequest, token, execution, ...(child && { childId: child.childId }) }, {
      state: "reported", model, inputTokens: 3, outputTokens: 2, cachedInputTokens: null, cacheWriteTokens: null,
      reasoningTokens: null, costUsd: null }, prices);
  }
  await spend(p, undefined, "parent-model"); await spend(p, key, "provider-actual"); await spend(legacy, untargeted, "parent-model");
  const { rows } = await pool.query(`SELECT child_id,member_id,engine,model,estimated_cost_usd::text AS estimated
    FROM birbcrew_ts.usage_ledger WHERE request_id=ANY($1::uuid[]) ORDER BY usage_id`, [[p.turnRequest.requestId, legacy.turnRequest.requestId]]);
  assert.deepEqual(rows, [
    { child_id: null, member_id: p.member.memberId, engine: "pi", model: "parent-model", estimated: "0.000007000000" },
    { child_id: key.childId, member_id: p.member.memberId, engine: "pi", model: "provider-actual", estimated: "0.000070000000" },
    { child_id: untargeted.childId, member_id: legacy.member.memberId, engine: "pi", model: "parent-model", estimated: "0.000007000000" },
  ]);
});


test("CLI spawn returns original named identity and replay reports permanent removal", async () => {
  const c = configuration(); await c.register();
  const request = { ownerId: "cli-owner", requestId: randomUUID(), engine: "pi", profile: c.parent };
  async function cli(input: unknown) {
    const child = spawnProcess(process.execPath, ["src/service/cli.ts", "spawn"], {
      env: { ...process.env, BIRBCREW_DATABASE_URL: url }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = once(child, "close"); child.stdin.end(JSON.stringify(input));
    const [code] = await exited;
    return { code, stdout, stderr };
  }
  const first = await cli(request); assert.equal(first.code, 0, first.stderr);
  const member = JSON.parse(first.stdout);
  assert.equal(member.subagents.mode, "named");
  assert.equal(member.subagents.targets[0].providerHost, "child.fixture:8443");
  await pool.query("UPDATE birbcrew_ts.profiles SET child_target_active='{}' WHERE name=$1", [c.parent]);
  const replay = await cli(request); assert.equal(replay.code, 0, replay.stderr);
  const expected = { ...member, subagents: { ...member.subagents, targets: member.subagents.targets.map((target: object) => ({ ...target, availability: "removed" })) } };
  assert.deepEqual(JSON.parse(replay.stdout), expected);
  const forged = await cli({ ...request, target: c.route }); assert.notEqual(forged.code, 0);
});
