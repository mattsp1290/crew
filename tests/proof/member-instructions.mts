import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withServices, until } from "./member-services.mts";

// Owner-written member instructions and instruction packs through the real gateway, Temporal worker and
// fixture providers. No live inference. Instruction and pack texts carry BIRBNOTE_ markers, which the fixture hook in
// fixture-profiles.mts records from every provider request's system context and, separately, from
// its other messages.
assert.equal(process.version, "v24.22.3");
await withServices({ label: "member-instructions" }, async s => {
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
  type Evidence = { engine: string; system: string[]; messages: string[]; continuation: boolean };
  let seen = 0;
  async function requests(): Promise<Evidence[]> {
    const rows = (await readFile(s.env.BIRBCREW_PROOF_NOTES!, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const fresh = rows.slice(seen);
    seen = rows.length;
    return fresh.map(({ engine, system, messages, continuation }) => ({ engine, system, messages, continuation }));
  }
  const member = (engine: string, profile: string, instructions?: string, token = owner.token) =>
    api("/v1/members", { body: { requestId: randomUUID(), engine, profile, ...(instructions && { instructions }) }, token });
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

  await s.startTemporal();
  let stopWorker = await s.worker();
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "3" || undefined; }
    catch { return undefined; }
  }, "fixture worker registration");
  await gateway();
  assert.equal((await api("/v1/capabilities")).memberInstructions.change, "fixed-at-spawn");
  const role = marker(), fact = marker();
  const pi = await member("pi", "fixture.approval.v1", "You review database migrations. " + role);
  const plain = await member("pi", "fixture.approval.v1");
  await api("/v1/memories", { body: { requestId: randomUUID(), memberId: pi.memberId, text: "Deploys need " + fact } });
  await requests();

  const a = await open(pi.memberId);
  assert.equal((await turn(a, "remember cedar")).result.text, "stored cedar");
  assert.deepEqual(await requests(), [{ engine: "pi", system: [role, fact].sort(), messages: [], continuation: false }]);
  assert.equal((await turn(a, "recall")).result.text, "recalled cedar");
  assert.deepEqual(await requests(), [{ engine: "pi", system: [role, fact].sort(), messages: [], continuation: false }]);
  console.log("pi: every turn of a conversation gave the model the member's instructions, in its system prompt only");

  await turn(await open(plain.memberId), "remember oak");
  await turn(await open((await member("pi", "fixture.approval.v1", undefined, other.token)).memberId, other.token), "remember elm", { token: other.token });
  assert.deepEqual(await requests(), [{ engine: "pi", system: [], messages: [], continuation: false },
    { engine: "pi", system: [], messages: [], continuation: false }]);
  await api(`/v1/members/${pi.memberId}/instructions`, { token: other.token, expected: 404 });
  console.log("pi: a member without instructions, and another owner's member, saw none");

  await turn(a, "record assigned", { status: "waiting" });
  assert.deepEqual(await requests(), [{ engine: "pi", system: [role, fact].sort(), messages: [], continuation: false }]);
  await stopWorker();
  stopWorker = await s.worker();
  const [card] = (await api(`/v1/conversations/${a}`)).state.pendingApprovals;
  await api(`/v1/conversations/${a}/human`, { body: { memberId: card.memberId, requestId: card.requestId, invocationId: card.invocationId,
    approvalId: card.approvalId, version: card.version, choice: "approve" }, expected: 200 });
  await until(async () => {
    const receipt = await api(`/v1/conversations/${a}/requests/${card.requestId}`);
    return receipt.status === "completed" ? receipt : undefined;
  }, "approved turn completed", 120_000);
  assert.deepEqual(await requests(), [{ engine: "pi", system: [role, fact].sort(), messages: [], continuation: true }]);
  console.log("pi: after the worker was killed mid-turn, the resumed segment saw the same instructions");

  const routine = await api("/v1/routines", { body: { requestId: randomUUID(), memberId: pi.memberId, schedule: "0 0 1 1 *",
    prompt: "remember pine", approvalPolicy: "wait" } });
  await s.sql(`UPDATE birbcrew_ts.routines SET next_window=now() WHERE routine_id='${routine.routineId}'`);
  await until(async () => (await api(`/v1/routines/${routine.routineId}/firings`)).firings[0]?.status === "succeeded" || undefined,
    "routine firing succeeded", 120_000);
  assert.deepEqual(await requests(), [{ engine: "pi", system: [role, fact].sort(), messages: [], continuation: false }]);
  console.log("pi: a routine firing's conversation gave the model the instructions");

  const source = await open(pi.memberId);
  await turn(source, "remember birch");
  await requests();
  const takeover = marker();
  const target = await member("claude", "fixture.v1", "Take over handed-off work. " + takeover);
  const handoff = await api(`/v1/conversations/${source}/handoffs`, { body: { requestId: randomUUID(), memberId: target.memberId } });
  const received = await until(async () => {
    const receipt = await api(`/v1/conversations/${handoff.target.conversationId}/requests/${handoff.firstRequestId}`);
    return receipt.status === "completed" ? receipt : undefined;
  }, "handoff turn completed", 120_000);
  assert.equal(received.result.text, "acknowledged 1 turns from pi");
  assert.deepEqual(await requests(), [{ engine: "claude", system: [takeover], messages: [], continuation: false }]);
  console.log("claude: a handoff target's first turn had its own member's instructions as system context and none of the source's");

  const native: string[] = [];
  for (const engine of ["claude", "codex"] as const) {
    const text = marker();
    native.push(text);
    const spawned = await member(engine, "fixture.v1", "Answer tersely. " + text);
    const conversation = await open(spawned.memberId);
    await requests();
    await turn(conversation, "remember cedar");
    assert.deepEqual(await requests(), [{ engine, system: [text], messages: [], continuation: false }]);
    assert.equal((await turn(conversation, "recall")).result.text, "recalled cedar");
    assert.deepEqual(await requests(), [{ engine, system: [text], messages: [], continuation: false }]);
    console.log(`${engine}: both turns of a conversation gave the model the member's instructions`);
  }

  const [styleMark, safetyMark, reviewMark] = [marker(), marker(), marker()];
  const style = await api("/v1/instruction-packs", { body: { requestId: randomUUID(), name: "house style", text: "Answer tersely. " + styleMark } });
  const safety = await api("/v1/instruction-packs", { body: { requestId: randomUUID(), name: "safety", description: "Shared by every member",
    text: "Never print secrets. " + safetyMark } });
  await api("/v1/members", { body: { requestId: randomUUID(), engine: "pi", profile: "fixture.approval.v1", instructionPacks: [style.packId] },
    token: other.token, expected: 404 });
  for (const engine of ["pi", "claude", "codex"] as const) {
    const spawned = await api("/v1/members", { body: { requestId: randomUUID(), engine, profile: engine === "pi" ? "fixture.approval.v1" : "fixture.v1",
      instructionPacks: [style.packId, safety.packId], ...(engine === "pi" && { instructions: "You review migrations. " + reviewMark }) } });
    assert.deepEqual(spawned.instructionPacks, [style.packId, safety.packId]);
    const conversation = await open(spawned.memberId);
    await requests();
    const system = [styleMark, safetyMark, ...(engine === "pi" ? [reviewMark] : [])].sort();
    await turn(conversation, "remember cedar");
    assert.deepEqual(await requests(), [{ engine, system, messages: [], continuation: false }]);
    assert.equal((await turn(conversation, "recall")).result.text, "recalled cedar");
    assert.deepEqual(await requests(), [{ engine, system, messages: [], continuation: false }]);
    console.log(`${engine}: both turns of a conversation gave the model the member's two instruction packs`
      + (engine === "pi" ? " and its own instructions" : ""));
  }
  await api(`/v1/instruction-packs/${style.packId}`, { method: "DELETE", expected: 409 });
  assert.equal((await api(`/v1/instruction-packs/${style.packId}`)).memberCount, 3);
  console.log("packs: another owner could not attach them, and a pack in use could not be deleted");

  const all = [role, takeover, ...native, styleMark, safetyMark, reviewMark];
  const leaked = async (statement: string) => [...(await s.sql(statement)).matchAll(/BIRBNOTE_[A-Z0-9]+/g)].map(match => match[0]);
  for (const table of ["public_events", "public_snapshots", "request_admissions", "audit_events", "conversation_handoffs"]) {
    assert.deepEqual(await leaked(`SELECT to_jsonb(t) FROM birbcrew_ts.${table} t`), [], table);
  }
  assert.deepEqual(await leaked("SELECT reply FROM birbcrew_ts.turns"), []);
  const published = JSON.stringify([await api(`/v1/conversations/${a}`), await api("/v1/members"), await api("/v1/conversations"),
    await api(`/v1/conversations/${source}/handoff`), await api("/v1/audit?limit=1000"), await api("/v1/instruction-packs")])
    + await api("/v1/audit?format=csv&limit=10000");
  assert.deepEqual(all.filter(value => published.includes(value)), []);
  assert.equal((await api(`/v1/members/${pi.memberId}/instructions`)).instructions.text, "You review database migrations. " + role);
  assert.equal((await api(`/v1/instruction-packs/${safety.packId}`)).text, "Never print secrets. " + safetyMark);
  console.log("no instruction or pack text reached public events, snapshots, receipts, listings or the audit trail; the owner routes return it");
});
console.log("Member instructions and instruction packs proof passed with actual service fixtures; no live inference.");
