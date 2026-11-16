import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withServices, until } from "./member-services.mts";

// Scheduled routines through the real gateway, Temporal worker and Pi fixture provider. No live
// inference. A routine's window is made due by setting its next_window to the database clock;
// the dispatcher then decides, claims and drives it exactly as it would at a cron window.
assert.equal(process.version, "v24.22.3");
await withServices({ label: "routines", engine: "pi" }, async s => {
  const ownerId = randomUUID(), token = randomUUID();
  const config = join(s.directory, "gateway.json");
  await writeFile(config, JSON.stringify({ port: 0, tokenHashes: { [createHash("sha256").update(token).digest("hex")]: ownerId } }), { mode: 0o600 });
  let endpoint = "";
  let stopGateway: (() => Promise<void>) | undefined;
  async function gateway() {
    const gateway = await s.gateway(config);
    endpoint = gateway.url;
    stopGateway = gateway.stop;
  }
  async function api(path: string, body?: unknown, expected = body === undefined ? 200 : 201) {
    const response = await fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, expected, `${path}: ${response.status}`);
    return response.json();
  }
  type Firing = { status: string; reason: string | null; conversationId: string | null; requestId: string | null };
  async function routine(memberId: string, prompt: string, approvalPolicy: "wait" | "fail_closed") {
    const created = await api("/v1/routines", { requestId: randomUUID(), memberId, schedule: "0 0 1 1 *", prompt, approvalPolicy });
    const due = () => s.sql(`UPDATE birbcrew_ts.routines SET next_window=now() WHERE routine_id='${created.routineId}'`);
    const firings = async (): Promise<Firing[]> => (await api(`/v1/routines/${created.routineId}/firings`)).firings;
    let seen: Firing[] = [];
    const settled = (status: string, timeout?: number) => until(async () => {
      seen = await firings();
      assert.equal(seen.length <= 1, true, JSON.stringify(seen));
      return seen[0]?.status === status ? seen[0] : undefined;
    }, `routine firing ${status}`, timeout).catch(async error => {
      const [firing] = seen;
      const receipt = firing?.requestId ? await api(`/v1/conversations/${firing.conversationId}/requests/${firing.requestId}`) : undefined;
      throw new Error(`${error.message}; last seen ${JSON.stringify({ firing, receipt })}`);
    });
    return { ...created, due, firings, settled };
  }
  const count = async (table: string, conversationId: string) =>
    Number(await s.sql(`SELECT count(*) FROM birbcrew_ts.${table} WHERE conversation_id='${conversationId}'`));

  await s.startTemporal();
  let stopWorker = await s.worker();
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "1" || undefined; }
    catch { return undefined; }
  }, "fixture worker registration");
  await gateway();
  const chat = await api("/v1/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.v1" });
  const guarded = await api("/v1/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.approval.v1" });
  const capabilities = await api("/v1/capabilities");
  assert.deepEqual(capabilities.initiatorKinds, ["owner", "routine", "handoff"]);

  const marker = randomUUID();
  const complete = await routine(chat.memberId, "remember " + marker, "wait");
  await complete.due();
  const done = await complete.settled("succeeded");
  const path = `/v1/conversations/${done.conversationId}/requests/${done.requestId}`;
  const receipt = await api(path);
  assert.deepEqual([receipt.status, receipt.result.text, receipt.initiator], ["completed", "stored " + marker, { kind: "routine", id: complete.routineId }]);
  const audit = (await api("/v1/audit?conversationId=" + done.conversationId)).events;
  assert.deepEqual(audit.map((event: { type: string; initiator: { kind: string } }) => [event.type, event.initiator.kind]),
      [["conversation.opened", "owner"], ["request.accepted", "routine"], ["request.finished", "routine"]]);
  assert.equal(audit[0].payload.routineId, complete.routineId);
  console.log("pi: a routine firing ran to completion in its own conversation, attributed to the routine");

  const waiting = await routine(guarded.memberId, "record assigned", "wait");
  await waiting.due();
  const pending = await waiting.settled("waiting");
  const snapshot = await api(`/v1/conversations/${pending.conversationId}`);
  assert.equal(snapshot.state.pendingApprovals.length, 1);
  const [card] = snapshot.state.pendingApprovals;
  assert.equal((await api(`/v1/conversations/${pending.conversationId}/requests/${pending.requestId}`)).status, "waiting");
  await api(`/v1/conversations/${pending.conversationId}/human`, { memberId: card.memberId, requestId: card.requestId,
    invocationId: card.invocationId, approvalId: card.approvalId, version: card.version, choice: "approve" }, 200);
  const approved = await waiting.settled("succeeded");
  assert.equal(await count("work_items", approved.conversationId!), 1);
  console.log("pi: a wait routine's approval card appeared in pendingApprovals and its approved turn completed");

  const closed = await routine(guarded.memberId, "record assigned", "fail_closed");
  await closed.due();
  const refused = await closed.settled("failed");
  assert.equal(refused.reason, "approval_required");
  const cancelled = await api(`/v1/conversations/${refused.conversationId}/requests/${refused.requestId}`);
  assert.ok(cancelled.cancellation?.receiptId, JSON.stringify(cancelled));
  assert.equal(await count("work_items", refused.conversationId!), 0);
  assert.equal((await api(`/v1/routines/${closed.routineId}`)).consecutiveFailures, 1);
  console.log(`pi: a fail_closed routine requested cancellation at its card and failed with approval_required (request ${cancelled.status})`);

  await stopWorker();
  const crash = await routine(chat.memberId, "remember " + randomUUID(), "wait");
  await crash.due();
  const claimed = await crash.settled("claimed");
  await until(async () => await count("conversations", claimed.conversationId!) === 1 || undefined, "firing conversation opened");
  await new Promise(resolve => setTimeout(resolve, 2_000));
  await stopGateway!();
  assert.equal(await count("request_admissions", claimed.conversationId!), 0, "killed before admission");
  stopWorker = await s.worker();
  await gateway();
  const recovered = await crash.settled("succeeded", 240_000);
  assert.deepEqual([recovered.conversationId, recovered.requestId], [claimed.conversationId, claimed.requestId]);
  assert.equal(await count("request_admissions", claimed.conversationId!), 1);
  assert.equal(await count("turns", claimed.conversationId!), 1);
  assert.equal(Number(await s.sql(`SELECT count(*) FROM birbcrew_ts.conversations c JOIN birbcrew_ts.routine_firings f
      USING (conversation_id) WHERE f.routine_id='${crash.routineId}'`)), 1);
  console.log("pi: a gateway killed between claim and admission left one claimed firing; the next gateway ran it once with the same identity");
});
console.log("Scheduled routines proof passed with actual service fixtures; no live inference.");
