import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderTranscript } from "../../src/service/handoffs.ts";
import { withServices, until, type Engine } from "./member-services.mts";

// Conversation handoff through the real gateway, Temporal worker and fixture providers, once for each
// target engine. No live inference. Source prompts carry BIRBNOTE_ markers, which the fixture hook in
// fixture-profiles.mts records from every provider request's system context and, separately, from its
// other messages. The fixtures answer a handoff transcript by parsing it (tests/fixtures/engines/handoff.mts).
assert.equal(process.version, "v24.22.3");
await withServices({ label: "handoffs" }, async s => {
  const owner = { id: randomUUID(), token: randomUUID() };
  const config = join(s.directory, "gateway.json");
  await writeFile(config, JSON.stringify({ port: 0, tokenHashes: { [createHash("sha256").update(owner.token).digest("hex")]: owner.id } }), { mode: 0o600 });
  let endpoint = "";
  async function gateway() {
    const gateway = await s.gateway(config);
    endpoint = gateway.url;
  }
  async function api(path: string, { body, method = body === undefined ? "GET" : "POST", expected = method === "POST" ? 201 : 200 }:
    { body?: unknown; method?: string; expected?: number } = {}) {
    const response = await fetch(endpoint + path, { method, headers: { Authorization: "Bearer " + owner.token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  }
  const marker = () => "BIRBNOTE_" + randomUUID().replaceAll("-", "").toUpperCase();
  let seen = 0;
  /** The provider requests made since the last call: each one's system-context and message markers. */
  async function requests() {
    const rows = (await readFile(s.env.BIRBCREW_PROOF_NOTES!, "utf8").catch(() => "")).split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { engine: Engine; system: string[]; messages: string[]; continuation: boolean });
    const fresh = rows.slice(seen);
    seen = rows.length;
    return fresh;
  }
  async function open(memberId: string) {
    const conversationId = randomUUID();
    await api("/v1/conversations", { body: { conversationId, memberId } });
    return conversationId;
  }
  const completed = (conversationId: string, requestId: string, label: string) => until(async () => {
    const receipt = await api(`/v1/conversations/${conversationId}/requests/${requestId}`);
    return receipt.status === "completed" ? receipt : undefined;
  }, label, 120_000);
  async function turn(conversationId: string, text: string) {
    const receipt = await api(`/v1/conversations/${conversationId}/requests`, { body: { requestId: randomUUID(), text }, expected: 202 });
    return completed(conversationId, receipt.requestId, text.slice(0, 40));
  }

  await s.startTemporal();
  await s.worker();
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1'") === "3" || undefined; }
    catch { return undefined; }
  }, "fixture worker registration");
  await gateway();
  assert.equal((await api("/v1/capabilities")).handoffs.transcriptBytes, 65_536);
  const source = await api("/v1/members", { body: { requestId: randomUUID(), engine: "pi", profile: "fixture.v1" } });
  for (const engine of ["pi", "claude", "codex"] as const) {
    const target = await api("/v1/members", { body: { requestId: randomUUID(), engine, profile: "fixture.v1" } });
    const conversation = await open(source.memberId);
    // Two turns of about 8 KB each way, nearly all quotes and backslashes, sized so the transcript is
    // exactly its 65,536-byte budget: four times the public prompt limit, and every one of those
    // characters escaped once in the transcript and again on each engine's JSON wire.
    const [first, second] = [marker(), marker()];
    const escapes = (count: number) => "\"\\".repeat(Math.ceil(count / 2)).slice(0, count);
    const bytes = (paddings: string[]) => Buffer.byteLength(renderTranscript({ sourceEngine: "pi", omittedTurns: 0, uncertainTurns: 0,
      turns: [first, second].map((note, index) => ({ ownerPrompt: "remember " + note + paddings[index], modelReply: "stored " + note + paddings[index] })) }));
    // Each escaped character adds four bytes (twice in the prompt, twice in the reply) and a space two.
    const missing = 65_536 - bytes(["", ""]), escaped = Math.floor(missing / 4);
    const paddings = [" ".repeat((missing - 4 * escaped) / 2) + escapes(Math.ceil(escaped / 2)), escapes(Math.floor(escaped / 2))];
    assert.equal(bytes(paddings), 65_536);
    assert.equal((await turn(conversation, "remember " + first + paddings[0])).result.text, "stored " + first + paddings[0]);
    await turn(conversation, "remember " + second + paddings[1]);
    await requests();

    const handoff = await api(`/v1/conversations/${conversation}/handoffs`, { body: { requestId: randomUUID(), memberId: target.memberId } });
    assert.deepEqual([handoff.target.engine, handoff.carriedTurns, handoff.omittedTurns, handoff.firstRequestAdmitted], [engine, 2, 0, true]);
    assert.equal(handoff.transcriptBytes, 65_536);
    const targetId = handoff.target.conversationId;
    const receipt = await completed(targetId, handoff.firstRequestId, `${engine} handoff turn`);
    assert.deepEqual(receipt.initiator, { kind: "handoff", id: handoff.handoffId });
    assert.equal(receipt.result.text, "acknowledged 2 turns from pi");
    // The target model got the transcript once, as a user message: both turns' markers, none in its system context.
    assert.deepEqual(await requests(), [{ engine, system: [], messages: [first, second].sort(), continuation: false }]);
    const { messages } = await api(`/v1/conversations/${targetId}`);
    assert.deepEqual(messages.map((message: { role: string }) => message.role), ["user", "assistant"]);
    assert.equal(createHash("sha256").update(messages[0].content).digest("hex"), handoff.transcriptDigest);
    console.log(`${engine}: the target's first turn carried ${handoff.transcriptBytes} transcript bytes as a user message and the model answered`);

    // The owner continues in the target; the source is sealed and still readable.
    assert.equal((await turn(targetId, "remember cedar")).result.text, "stored cedar");
    assert.deepEqual(await api(`/v1/conversations/${conversation}/requests`, { body: { requestId: randomUUID(), text: "more" }, expected: 409 }),
      { error: "handed_off" });
    assert.equal((await api(`/v1/conversations/${conversation}`)).messages.length, 4);
    assert.equal((await api(`/v1/conversations/${targetId}/handoff`)).incoming.handoffId, handoff.handoffId);
    await requests();
    console.log(`${engine}: the owner continued in the target; the source refused new requests`);
  }
  // The audit trail names every handoff by identifiers and digest; no marker reaches it.
  const trail = JSON.stringify(await api("/v1/audit?limit=1000"));
  assert.equal([...trail.matchAll(/"conversation\.handed_off"/g)].length, 3);
  assert.deepEqual(trail.match(/BIRBNOTE_[A-Z0-9]+/g), null);
});
console.log("Conversation handoff proof passed with actual service fixtures; no live inference.");
