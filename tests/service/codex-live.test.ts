import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { service, startWorker, until } from "./observer-host.ts";

type Host = Awaited<ReturnType<typeof service>>;
async function open(host:Host,profile:string) {
  const requestId = randomUUID(), conversationId = randomUUID();
  const {memberId} = await host.post("/members",{engine:"codex",profile,requestId:randomUUID()});
  await host.post("/conversations",{conversationId,memberId});
  return {requestId,conversationId,memberId,path:"/conversations/" + conversationId};
}
async function state(host:Host,path:string) {return (await host.api(path)).json();}
async function countWrites(host:Host,id:string) {
  return (await host.db.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1",[id])).rows;
}

test("Codex completes assistant items individually for early and late observers", {timeout:65_000}, async t => {
  const host = await service(t);
  const {requestId,conversationId,path} = await open(host,"fixture.v1");
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  await host.post(path + "/inputs",{requestId,text:"stream " + requestId});
  await until(async () => first.events.some(e => e.type === "STEP_STARTED") || undefined);
  assert.ok(!first.events.some(e => e.type === "TEXT_MESSAGE_CONTENT"));
  const gate = join(process.env.BIRBCREW_PROOF_STREAM_DIR!,requestId);
  await writeFile(gate + ".first","");
  await until(async () => first.events.some(e => e.type === "TEXT_MESSAGE_END") || undefined);
  const second = host.attach(conversationId);
  await until(async () => second.agent.messages.some(m => m.content === "first") || undefined);
  await writeFile(gate + ".second","");
  await until(async () => [first,second].every(r => r.agent.messages.some(m => m.content === " second")) || undefined);
  const end = await until(async () => { const s = await state(host,path); return s.state.phase === "idle" ? s : undefined; });
  for (const reader of [first,second]) assert.deepEqual(reader.agent.messages,end.messages);
  assert.deepEqual(first.events.filter(e => e.type === "TEXT_MESSAGE_CONTENT").map(e => e.delta),["first"," second"]);
  assert.deepEqual(second.events.filter(e => e.type === "TEXT_MESSAGE_CONTENT").map(e => e.delta),[" second"]);
});

for (const choice of ["approve","deny","inspect"] as const) {
  test("Codex " + choice + " reaches the open native call after a gateway restart", {timeout:95_000}, async t => {
    const host = await service(t,true);
    const ordinary = choice === "inspect";
    const {requestId,conversationId,memberId,path} = await open(host,ordinary ? "fixture.next-step.v1" : "fixture.approval.v1");
    const observer = host.attach(conversationId);
    await until(async () => observer.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
    const text = ordinary ? "choose" : "record " + requestId;
    const submittedAt = Date.now();
    await host.post(path + "/inputs",{requestId,text});
    const card = await until(async () => {
      const {state:s} = await state(host,path);
      return (ordinary ? s.pendingQuestions : s.pendingApprovals)?.[0];
    });
    const deadline = Date.parse(card.expiresAt);
    assert.ok(deadline >= submittedAt + 120_000, "native proposals offer two minutes for review");
    assert.ok(deadline <= Date.now() + 120_000, "native proposals stay within the live approval window");
    assert.deepEqual(await countWrites(host,conversationId),[]);
    await host.restart();
    const readers = [host.attach(conversationId),host.attach(conversationId)];
    await until(async () => readers.every(r => r.events.some(e => e.type === "STATE_SNAPSHOT")) || undefined);
    const key = {memberId,requestId,invocationId:card.invocationId,approvalId:card.approvalId,version:1,choice};
    assert.equal((await host.api(path+"/human",{...key,version:2})).status,409);
    assert.equal((await host.api(path+"/human",key,host.stranger)).status,404);
    await host.post(path+"/human",key);
    await host.post(path+"/human",key);
    const end = await until(async () => {
      const s = await state(host,path);
      return s.state.phase === "idle" && readers.every(r => r.agent.messages.length === s.messages.length) ? s : undefined;
    });
    assert.equal(end.state.liveOperations[0].delivery,"confirmed");
    const writes = await countWrites(host,conversationId);
    assert.equal(writes.length,choice === "approve" ? 1 : 0);
    const reply = end.messages.at(-1).content;
    assert.ok(reply.includes(choice === "approve" ? writes[0].receipt_id : choice === "deny" ? "denied" : "inspect"));
    for (const reader of readers) {
      assert.equal(reader.events.filter(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === card.approvalId).length,1);
      assert.deepEqual(reader.agent.messages,end.messages);
      assert.ok(!JSON.stringify(reader.events).includes("private fixture note"));
    }
    assert.deepEqual(await host.post(path+"/inputs",{requestId,text}),{requestId});
    assert.equal((await host.api(path+"/inputs",{requestId,text:"changed"})).status,409);
    if (!ordinary) {
      const evidencePath = process.env.BIRBCREW_PROOF_CODEX_REQUESTS;
      if (evidencePath) assert.ok((await readFile(evidencePath,"utf8")).includes("call_" + requestId));
    }
  });
}

for (const action of ["kill","cancel","expiry"] as const) {
  test("Codex closes an unexecuted live call on " + action, {timeout:100_000}, async t => {
    const host = await service(t);
    const profile = "live." + randomUUID();
    const stop = startWorker(t,profile,"codex",true);
    await until(async () => (await host.db.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine='codex' AND name=$1",[profile])).rowCount || undefined);
    const {requestId,conversationId,memberId,path} = await open(host,profile);
    const first = host.attach(conversationId);
    await host.post(`/v1${path}/requests`,{requestId,text:"record " + requestId,
      ...(action === "expiry" && {approvalDeadlineSeconds:60})});
    const card = await until(async () => (await state(host,path)).state.pendingApprovals[0]);
    const key = {memberId,requestId,invocationId:card.invocationId,approvalId:card.approvalId,version:1,choice:"approve"};
    if (action === "kill") {await stop(); startWorker(t,profile,"codex",true);}
    if (action === "cancel") await host.post(path+"/cancel",{requestId});
    // The expiry case leaves the call untouched until its shorter request deadline.
    await first.done;
    const late = host.attach(conversationId);
    await late.done;
    const end = await state(host,path);
    assert.equal(end.state.phase,action === "cancel" ? "cancelled" : "failed");
    assert.deepEqual(end.state.pendingApprovals,[]);
    assert.deepEqual(await countWrites(host,conversationId),[]);
    assert.equal(end.state.interruptedCalls[0].effect,"none");
    if (action === "expiry") assert.ok(Date.now() >= Date.parse(card.expiresAt));
    assert.equal((await host.api(path+"/human",key)).status,409);
    for (const reader of [first,late]) {
      assert.deepEqual(reader.agent.messages,end.messages);
      assert.ok(reader.agent.messages.some(m => typeof m.content === "string" && m.content.includes("fresh approval")));
    }
    if (action === "kill") {
      const next = randomUUID(), nextRequest = randomUUID();
      await host.post("/conversations",{memberId,conversationId:next});
      const route = "/conversations/" + next;
      await host.post(route+"/inputs",{requestId:nextRequest,text:"record " + nextRequest});
      const fresh = await until(async () => (await state(host,route)).state.pendingApprovals[0]);
      assert.notEqual(fresh.approvalId,card.approvalId);
      assert.deepEqual(await countWrites(host,next),[]);
      await host.post(route+"/human",{memberId,requestId:nextRequest,approvalId:fresh.approvalId,invocationId:nextRequest,version:1,choice:"approve"});
      await until(async () => (await state(host,route)).state.phase === "idle" || undefined);
      assert.equal((await countWrites(host,next)).length,1);
    }
  });
}


test("Codex redacts a future tool ID in preamble and a known ID split across completed items", {timeout:70_000}, async t => {
  const host = await service(t);
  const {requestId,conversationId,memberId,path} = await open(host,"fixture.approval.v1");
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  await host.post(path + "/inputs",{requestId,text:"review " + requestId});
  const card = await until(async () => (await state(host,path)).state.pendingApprovals[0]);
  const second = host.attach(conversationId);
  await until(async () => second.agent.messages.some(m => m.content === "Before [tool call]") || undefined);
  await host.post(path + "/human", {memberId,requestId,invocationId:card.invocationId,approvalId:card.approvalId,version:1,choice:"deny"});
  const settled = await until(async () => {
    const snapshot = await state(host,path);
    return snapshot.state.phase === "idle" && [first,second].every(r => r.agent.messages.length === snapshot.messages.length)
      ? snapshot : undefined;
  });
  const expected = ["Before [tool call]", "After [tool call]", "[tool call] finished."];
  assert.deepEqual(settled.messages.filter((m: {id:string}) => m.id.startsWith(requestId + "/item/")).map((m: {content:string}) => m.content), expected);
  for (const reader of [first,second]) {
    assert.deepEqual(reader.agent.messages,settled.messages);
    assert.ok(!JSON.stringify(reader.events).includes("private."));
  }
  for (const type of ["TEXT_MESSAGE_START","TEXT_MESSAGE_CONTENT","TEXT_MESSAGE_END"]) {
    assert.equal(first.events.filter(e => e.type === type && String(e.messageId).startsWith(requestId + "/item/")).length,3);
  }
  const stored = await host.db.query("SELECT reply FROM birbcrew_ts.turns WHERE conversation_id=$1 AND phase='committed'", [conversationId]);
  assert.equal(stored.rows[0].reply,"Before private." + requestId + "After private." + requestId + " finished.");
});

test("Codex allow_always lets the member's next live call run without a card", {timeout:100_000}, async t => {
  const host = await service(t);
  const first = await open(host,"fixture.approval.v1");
  await host.post(`/v1${first.path}/requests`,{requestId:first.requestId,text:"record " + first.requestId});
  const card = await until(async () => (await state(host,first.path)).state.pendingApprovals?.[0]);
  assert.deepEqual(card.standingChoices,["allow_conversation","allow_always"]);
  const key = {memberId:first.memberId,requestId:first.requestId,invocationId:card.invocationId,approvalId:card.approvalId,version:1};
  assert.deepEqual(await host.post(first.path+"/human",{...key,choice:"allow_always"}),{approvalId:card.approvalId,decision:"allow_always"});
  await until(async () => (await state(host,first.path)).state.phase === "idle" || undefined);

  const conversationId = randomUUID(), requestId = randomUUID(), path = "/conversations/" + conversationId;
  await host.post("/conversations",{conversationId,memberId:first.memberId});
  const observer = host.attach(conversationId);
  await host.post(`/v1${path}/requests`,{requestId,text:"record " + requestId});
  const end = await until(async () => { const s = await state(host,path); return s.state.phase === "idle" && s.state.grantedCalls ? s : undefined; });
  const [granted] = end.state.grantedCalls;
  assert.deepEqual([granted.requestId,granted.scope],[requestId,"member"]);
  const [receipt] = await countWrites(host,conversationId);
  assert.deepEqual(end.state.liveOperations,[{requestId,approvalId:granted.approvalId,effect:"committed",delivery:"confirmed",receiptId:receipt.receipt_id}]);
  assert.ok(end.messages.at(-1).content.includes(receipt.receipt_id));
  await until(async () => observer.events.some(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === granted.approvalId) || undefined);
  assert.ok(!observer.events.some(e => e.type === "STATE_SNAPSHOT" &&
    (e.snapshot as {pendingApprovals:{requestId:string}[]}).pendingApprovals.some(p => p.requestId === requestId)), "no card for the granted call");
});
