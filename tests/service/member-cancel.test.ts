import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { service, until } from "./observer-host.ts";

test("three simultaneously streaming SDK members cancel independently and close both observers", {timeout:100_000}, async t => {
  const host = await service(t);
  const cases = await Promise.all(["claude","pi","codex"].map(async engine => {
    const {memberId} = await host.post("/members",{engine,profile:"fixture.v1",requestId:randomUUID()});
    const conversationId=randomUUID(), requestId=randomUUID(), path="/conversations/" + conversationId;
    await host.post("/conversations",{memberId,conversationId});
    const first=host.attach(conversationId);
    await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
    await host.post(path+"/inputs",{requestId,text:"wait"});
    await until(async () => first.events.some(e => e.type === "TEXT_MESSAGE_CONTENT") || undefined);
    const second=host.attach(conversationId);
    await until(async () => second.agent.messages.some(m => m.role === "assistant") || undefined);
    return {engine,path,conversationId,requestId,readers:[first,second]};
  }));
  for (const [index, member] of cases.entries()) {
    const {requestId,conversationId,path,readers} = member;
    await host.post(path+"/cancel",{requestId});
    await host.post(path+"/cancel",{requestId});
    await Promise.all(readers.map(r => r.done));
    const end = await (await host.api(path)).json();
    assert.equal(end.state.phase,"cancelled");
    for (const reader of readers) {
      assert.equal(reader.events.at(-1)?.type,"RUN_FINISHED");
      // AG-UI reads a RUN_FINISHED without an outcome as success, so a cancellation must say so.
      assert.deepEqual(reader.events.at(-1)?.outcome,{type:"cancelled"});
      assert.deepEqual(reader.outcomes,["cancelled"]);
      assert.deepEqual(reader.agent.messages,end.messages);
    }
    assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND NOT stopped",[conversationId])).rowCount,0);
    for (const other of cases.slice(index+1)) {
      assert.equal((await (await host.api(other.path)).json()).state.phase,"running");
      assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND NOT stopped",[other.conversationId])).rowCount,1);
    }
  }
});

test("a conversation that uses its last turn still ends both observers with a successful RUN_FINISHED", {timeout:65_000}, async t => {
  const host = await service(t);
  const {memberId} = await host.post("/members",{engine:"pi",profile:"fixture.v1",requestId:randomUUID()});
  const conversationId=randomUUID(), path="/conversations/" + conversationId;
  await host.post("/conversations",{memberId,conversationId});
  // A new conversation has 128 turns (docs/bounded-conversations.md); pin this one to the
  // four-turn budget migration 16 keeps for older conversations, so four inputs complete it.
  const pinned = await host.db.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1 AND turn_limit=128",[conversationId]);
  assert.equal(pinned.rowCount,1);
  const readers=[host.attach(conversationId),host.attach(conversationId)];
  for (let i = 0; i < 4; i++) await host.post(path+"/inputs",{requestId:randomUUID(),text:"remember " + i});
  await Promise.all(readers.map(r => r.done));
  const end = await (await host.api(path)).json();
  assert.equal(end.state.phase,"complete");
  for (const reader of readers) {
    assert.equal(reader.events[0]?.type,"RUN_STARTED");
    // The gateway sends @ag-ui/core's PROTOCOL_VERSION, so a package bump changes the wire value with no source edit.
    assert.equal(reader.events[0]?.protocolVersion,"1.0",
      "RUN_STARTED declares the pinned AG-UI protocol version. After an @ag-ui/core bump, review what the new version requires, " +
      "then update this pin and the RUN_STARTED sentence in docs/integration-api-v1.md.");
    const last = reader.events.at(-1);
    assert.equal(last?.type,"RUN_FINISHED");
    assert.ok(last && !("outcome" in last));
    assert.deepEqual(reader.outcomes,["success"]);
    assert.deepEqual(reader.agent.messages,end.messages);
  }
});

for (const engine of ["pi", "claude"] as const) {
  test(engine + " cancels resumed generation and preserves the committed receipt", {timeout:65_000}, async t => {
    const host = await service(t);
    const {memberId} = await host.post("/members", {engine, profile:"fixture.approval.v1", requestId:randomUUID()});
    const conversationId = randomUUID(), requestId = randomUUID();
    const path = "/conversations/" + conversationId;
    await host.post("/conversations", {memberId, conversationId});
    const reader = host.attach(conversationId);
    await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, requestId + ".hold-receipt"), "");
    await host.post(path + "/inputs", {requestId, text:"record " + requestId});
    const card = await until(async () => (await (await host.api(path)).json()).state.pendingApprovals[0]);
    const {invocationId, approvalId, version} = card;
    await host.post(path + "/human", {memberId, requestId, invocationId, approvalId, version, choice:"approve"});
    const receipt = await until(async () => (await host.db.query<{receipt_id:string}>(
      "SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1", [conversationId])).rows[0]?.receipt_id);
    await until(async () => reader.events.some(event => event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string" && event.delta.includes(receipt)) || undefined);
    await host.post(path + "/cancel", {requestId});
    await reader.done;
    const final = await (await host.api(path)).json();
    assert.equal(final.state.phase, "cancelled");
    assert.deepEqual(reader.agent.messages, final.messages);
    assert.equal(reader.events.at(-1)?.type, "RUN_FINISHED");
    assert.deepEqual(reader.events.at(-1)?.outcome, {type:"cancelled"});
    assert.deepEqual(reader.outcomes, ["cancelled"]);
    assert.ok(final.messages.some((message: {role:string;content:unknown}) => message.role === "tool" && String(message.content).includes(receipt)));
    assert.deepEqual((await host.db.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1", [conversationId])).rows,
      [{receipt_id:receipt}]);
    assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND NOT stopped",[conversationId])).rowCount,0);
  });
}
