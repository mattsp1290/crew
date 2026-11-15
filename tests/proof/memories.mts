import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { withServices, until, type Engine } from "./member-services.mts";

// Owner-written member memory through the real gateway, Temporal worker and fixture providers. No
// live inference. Entry texts carry BIRBNOTE_ markers, which the fixture hook in fixture-profiles.mts
// records from every provider request's system context and, separately, from its other messages.
assert.equal(process.version, "v24.22.3");
await withServices({ label: "memories" }, async s => {
  const owner = { id: randomUUID(), token: randomUUID() }, other = { id: randomUUID(), token: randomUUID() };
  const config = join(s.directory, "gateway.json");
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  await writeFile(config, JSON.stringify({ port: 0, tokenHashes: { [digest(owner.token)]: owner.id, [digest(other.token)]: other.id } }), { mode: 0o600 });
  let endpoint = "";
  async function gateway() {
    const gateway = await s.gateway(config);
    endpoint = gateway.url;
  }
  async function api(path: string, { body, method = body === undefined ? "GET" : "POST", expected = method === "POST" ? 201 : 200,
    token = owner.token }: { body?: unknown; method?: string; expected?: number; token?: string } = {}) {
    const response = await fetch(endpoint + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${text}`);
    return path.includes("format=csv") ? text : JSON.parse(text);
  }
  const marker = () => "BIRBNOTE_" + randomUUID().replaceAll("-", "").toUpperCase();
  type Evidence = { engine: Engine; system: string[]; messages: string[]; continuation: boolean };
  const evidence = async (): Promise<Evidence[]> => (await readFile(s.env.BIRBCREW_PROOF_NOTES!, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  let seen = 0;
  async function requests() {
    const rows = await evidence();
    const fresh = rows.slice(seen);
    seen = rows.length;
    return fresh.map(({ engine, system, messages, continuation }) => ({ engine, system, messages, continuation }));
  }
  async function open(memberId: string, token = owner.token) {
    const conversationId = randomUUID();
    await api("/v1/conversations", { body: { conversationId, memberId }, token });
    return conversationId;
  }
  async function turn(conversationId: string, text: string, { token = owner.token, status = "completed" } = {}) {
    const receipt = await api(`/v1/conversations/${conversationId}/requests`, { body: { requestId: randomUUID(), text }, expected: 202, token });
    const path = `/v1/conversations/${conversationId}/requests/${receipt.requestId}`;
    return until(async () => {
      const current = await api(path, { token });
      return current.status === status ? current : undefined;
    }, `${text} ${status}`, 120_000);
  }
  const remember = (memberId: string, text: string) => api("/v1/memories", { body: { requestId: randomUUID(), memberId, text } });
  async function filesHolding(value: string) {
    const root = s.env.BIRBCREW_STATE_DIR!, found: string[] = [];
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      if ((await readFile(path)).includes(value)) found.push(relative(root, path));
    }
    return found;
  }

  await s.startTemporal();
  let stopWorker = await s.worker();
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "3" || undefined; }
    catch { return undefined; }
  }, "fixture worker registration");
  await gateway();
  assert.equal((await api("/v1/capabilities")).memories.injection, "open-snapshot-minus-deletions");
  const member = await api("/v1/members", { body: { requestId: randomUUID(), engine: "pi", profile: "fixture.approval.v1" } });
  const stranger = await api("/v1/members", { body: { requestId: randomUUID(), engine: "pi", profile: "fixture.approval.v1" }, token: other.token });
  const [first, second, third] = [marker(), marker(), marker()];
  const one = await remember(member.memberId, "The release branch is " + first);
  await remember(member.memberId, "Deploys need " + second);
  await requests();

  const a = await open(member.memberId);
  assert.equal((await turn(a, "remember cedar")).result.text, "stored cedar");
  assert.deepEqual(await requests(), [{ engine: "pi", system: [first, second].sort(), messages: [], continuation: false }]);
  console.log("pi: a conversation opened with two entries gave the model both, in its system prompt only");

  await api(`/v1/memories/${one.memoryId}`, { method: "DELETE" });
  await turn(a, "remember birch");
  assert.deepEqual(await requests(), [{ engine: "pi", system: [second], messages: [], continuation: false }]);
  console.log("pi: after one entry was deleted, the conversation's next turn saw only the other");

  await remember(member.memberId, "Reviews go to " + third);
  assert.equal((await turn(a, "recall")).result.text, "recalled birch");
  assert.deepEqual(await requests(), [{ engine: "pi", system: [second], messages: [], continuation: false }]);
  const b = await open(member.memberId);
  await turn(b, "remember oak");
  assert.deepEqual(await requests(), [{ engine: "pi", system: [second, third].sort(), messages: [], continuation: false }]);
  console.log("pi: an entry added later stayed out of the open conversation and reached a new one");

  await turn(await open(stranger.memberId, other.token), "remember elm", { token: other.token });
  assert.deepEqual(await requests(), [{ engine: "pi", system: [], messages: [], continuation: false }]);
  await api(`/v1/memories/${one.memoryId}`, { token: other.token, expected: 404 });
  console.log("pi: another owner's member saw none of these entries");

  await turn(a, "record assigned", { status: "waiting" });
  assert.deepEqual(await requests(), [{ engine: "pi", system: [second], messages: [], continuation: false }]);
  await stopWorker();
  stopWorker = await s.worker();
  const [card] = (await api(`/v1/conversations/${a}`)).state.pendingApprovals;
  await api(`/v1/conversations/${a}/human`, { body: { memberId: card.memberId, requestId: card.requestId, invocationId: card.invocationId,
    approvalId: card.approvalId, version: card.version, choice: "approve" }, expected: 200 });
  const settled = await until(async () => {
    const receipt = await api(`/v1/conversations/${a}/requests/${card.requestId}`);
    return receipt.status === "completed" ? receipt : undefined;
  }, "approved turn completed", 120_000);
  assert.match(settled.result.text, /^settled /);
  assert.deepEqual(await requests(), [{ engine: "pi", system: [second], messages: [], continuation: true }]);
  console.log("pi: after the worker was killed mid-turn, the resumed segment saw the same entries");

  for (const engine of ["claude", "codex"] as const) {
    const native = await api("/v1/members", { body: { requestId: randomUUID(), engine, profile: "fixture.v1" } });
    const [gone, kept] = [marker(), marker()];
    const deleted = await remember(native.memberId, "Deleted fact " + gone);
    await remember(native.memberId, "Kept fact " + kept);
    const started = await open(native.memberId), fresh = await open(native.memberId);
    await requests();
    await turn(started, "remember cedar");
    assert.deepEqual(await requests(), [{ engine, system: [gone, kept].sort(), messages: [], continuation: false }]);
    await api(`/v1/memories/${deleted.memoryId}`, { method: "DELETE" });
    assert.equal((await turn(started, "recall")).result.text, "recalled cedar");
    assert.deepEqual(await requests(), [{ engine, system: [gone, kept].sort(), messages: [], continuation: false }],
      `${engine} sends its recorded system context again`);
    await turn(fresh, "remember pine");
    assert.deepEqual(await requests(), [{ engine, system: [kept], messages: [], continuation: false }],
      `${engine}: a conversation whose first turn came after the deletion never sees it`);
    const files = await filesHolding(gone);
    assert.equal(files.length, 1, JSON.stringify(files));
    assert.match(files[0], engine === "claude" ? /^claude\/.*\/config\/projects\/.*\.jsonl$/ : /^codex\/.*\/home\/sessions\/.*\/rollout-.*\.jsonl$/);
    console.log(`${engine}: a deletion did not reach a conversation that had already run a turn; its session file keeps the text`);
  }

  const all = [first, second, third];
  const leaked = async (statement: string) => {
    const rows = await s.sql(statement);
    return [...rows.matchAll(/BIRBNOTE_[A-Z0-9]+/g)].map(match => match[0]);
  };
  for (const table of ["public_events", "public_snapshots", "request_admissions", "audit_events"]) {
    assert.deepEqual(await leaked(`SELECT to_jsonb(t) FROM birbcrew_ts.${table} t`), [], table);
  }
  assert.deepEqual(await leaked("SELECT reply FROM birbcrew_ts.turns"), []);
  for (const conversation of [a, b]) {
    const snapshot = JSON.stringify(await api(`/v1/conversations/${conversation}`));
    assert.deepEqual(all.filter(value => snapshot.includes(value)), [], "snapshot " + conversation);
  }
  const trail = JSON.stringify(await api("/v1/audit?limit=1000")) + await api("/v1/audit?format=csv&limit=10000");
  assert.deepEqual(all.filter(value => trail.includes(value)), []);
  assert.deepEqual(JSON.parse(await s.sql(`SELECT json_agg(event_type ORDER BY event_id) FROM birbcrew_ts.audit_events
    WHERE owner_id='${owner.id}' AND member_id='${member.memberId}' AND event_type LIKE 'memory.%'`)),
  ["memory.created", "memory.created", "memory.deleted", "memory.created"]);
  assert.equal(await s.sql(`SELECT state || ':' || coalesce(body, 'null') FROM birbcrew_ts.member_memories WHERE memory_id='${one.memoryId}'`), "deleted:null");
  const checkpoint = async (table: string, conversation: string) =>
    [...new Set(await leaked(`SELECT checkpoint FROM birbcrew_ts.${table} WHERE conversation_id='${conversation}'`))].sort();
  assert.deepEqual([await checkpoint("turns", a), await checkpoint("turns", b)], [[first, second].sort(), [second, third].sort()]);
  assert.deepEqual(await checkpoint("paused_segments", a), [first, second].sort());
  console.log("pi: no entry text reached public events, snapshots, receipts or the audit trail; Pi's checkpoint keeps what each turn saw");
});
console.log("Member memory proof passed with actual service fixtures; no live inference.");
