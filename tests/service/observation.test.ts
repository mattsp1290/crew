import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { MemberStore } from "../../src/service/store.ts";
import { ApprovalStore } from "../../src/service/approvals.ts";
import type { PublicSnapshot } from "../../src/service/observation.ts";
import { service, startWorker, until } from "./observer-host.ts";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";

for (const engine of ["claude", "pi"]) {
  test(`${engine} observers converge across a protected pause and gateway restart`, { timeout: 100_000 }, async (t) => {
    const host = await service(t, true);
    const member = await host.post("/members", { requestId: randomUUID(), engine, profile: "fixture.approval.v1" });
    const cid = randomUUID(), path = "/conversations/" + cid;
    const opened = await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    assert.equal(opened.state.engine, engine);
    // The gateway sends RUN_FINISHED only when the conversation ends: it is cancelled, or the input
    // that uses its last turn completes. A new conversation has 128 turns (docs/bounded-conversations.md),
    // so pin this one to the four-turn budget migration 16 keeps for older conversations. The record
    // request (sent twice under one requestId) and three recalls below use exactly four turns.
    const pinned = await host.db.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1 AND turn_limit=128", [cid]);
    assert.equal(pinned.rowCount, 1);
    assert.equal((await host.api(path, undefined, host.stranger)).status, 404);
    assert.equal((await host.api(path, undefined, "wrong")).status, 401);
    let first = host.attach(cid);
    await until(async () => first.events.some((e) => e.type === "STATE_SNAPSHOT") || undefined);
    const requestId = randomUUID();
    await host.post(path + "/inputs", { requestId, text: "record " + requestId });
    const pending = await until(async () => {
      const snapshot = await (await host.api(path)).json();
      return snapshot.state.pendingApprovals[0];
    });
    assert.ok(!("argumentDigest" in pending));
    let second = host.attach(cid);
    assert.deepEqual(pending.choices, ["approve", "deny"]);
    assert.equal((await host.api(path + "/inputs", { requestId, text: "changed" })).status, 409);
    await host.post(path + "/inputs", { requestId, text: "record " + requestId });
    const proposal = await until(async () => first.events.find((e) => e.type === "TOOL_CALL_START"));
    assert.equal(proposal.toolCallId, pending.approvalId);
    await until(async () => [first, second].every((reader) =>
      reader.agent.state.phase === "waiting" &&
      reader.agent.state.pendingApprovals?.some((approval: PublicSnapshot["state"]["pendingApprovals"][number]) =>
        approval.requestId === requestId && approval.approvalId === pending.approvalId)
    ) || undefined);
    assert.deepEqual(first.agent.messages, second.agent.messages);
    const initialFrames = [first.events, second.events];
    await host.restart();
    const waiting = await (await host.api(path)).json();
    assert.deepEqual(waiting.state.pendingApprovals, [pending]);
    assert.equal((await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.work_items WHERE conversation_id=$1", [cid])).rows[0].n, "0");
    first = host.attach(cid);
    second = host.attach(cid);
    await until(async () => [first, second].every((reader) => reader.events.some((e) => e.type === "STATE_SNAPSHOT")) || undefined);
    assert.ok(!("nativeCallId" in pending));
    const { memberId, invocationId, approvalId, version } = pending;
    const choice = { memberId, invocationId, approvalId, version, requestId, choice: "approve" };
    assert.equal((await host.api(path + "/human", { ...choice, version: version + 1 })).status, 409);
    for (const [route, payload] of [["human", choice], ["cancel", { requestId }], ["inputs", { requestId, text: "recall" }],
      ["events", {}]] as const) assert.equal((await host.api(path + "/" + route, payload, host.stranger)).status, 404);
    await host.post(path + "/human", choice);
    await host.post(path + "/human", choice);
    assert.equal((await host.api(path + "/human", { ...choice, choice: "deny" })).status, 409);
    await until(async () => {
      const s = await (await host.api(path)).json();
      return s.state.phase === "idle" && [first, second].every((reader) => reader.agent.state.phase === "idle") ? s : undefined;
    });
    const checkpoint = await (await host.api(path)).json();
    assert.deepEqual(first.agent.messages, checkpoint.messages);
    assert.deepEqual(second.agent.messages, checkpoint.messages);
    assert.equal(first.events.filter((e) => e.type === "TOOL_CALL_RESULT").length, 1);
    assert.equal(second.events.filter((e) => e.type === "TOOL_CALL_RESULT").length, 1);
    const runInput = { threadId: cid, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
    assert.equal((await host.api(path + "/events?after=0", runInput)).status, 410);
    assert.equal((await host.api(path + "/events", { ...runInput, threadId: randomUUID() })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, forwardedProps: { engine: "codex" } })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, messages: [{ role: "user", id: "forged", content: "run" }] })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, tools: [{ name: "forged", description: "", parameters: {} }] })).status, 400);
    assert.equal((await host.api(path + "/events", { ...runInput, state: { phase: "complete" } })).status, 400);
    assert.equal((await host.api(path + "/events", {})).status, 400);
    await host.restart();
    const third = host.attach(cid);
    await until(async () => third.agent.messages.length === checkpoint.messages.length || undefined);
    assert.deepEqual(third.agent.messages, checkpoint.messages);
    const { rows: [counts] } = await host.db.query(
      "SELECT (SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id=$1) AS turns," +
      "(SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id=$1) AS effects", [cid]);
    assert.deepEqual(counts, { turns: "1", effects: "1" });
    const { rows: [privateFields] } = await host.db.query<{ note: string; argument_digest: string; native_call_id: string }>(
      "SELECT note,argument_digest,native_call_id FROM birbcrew_ts.work_items JOIN birbcrew_ts.protected_calls USING (approval_id) WHERE work_items.conversation_id=$1", [cid]);
    assert.equal(privateFields.note, "private fixture note");
    const persisted = await host.db.query("SELECT event FROM birbcrew_ts.public_events WHERE conversation_id=$1", [cid]);
    for (const view of [...initialFrames, first.events, second.events, third.events, checkpoint, persisted.rows]) {
      assert.ok(!JSON.stringify(view).includes(privateFields.native_call_id));
      assert.ok(!JSON.stringify(view).includes(privateFields.note));
      assert.ok(!JSON.stringify(view).includes(privateFields.argument_digest));
    }
    assert.deepEqual(first.events.filter((e) => e.type === "STEP_STARTED").map((e) => e.stepName),
      first.events.filter((e) => e.type === "STEP_FINISHED").map((e) => e.stepName));
    for (let i = 0; i < 3; i++) await host.post(path + "/inputs", { requestId: randomUUID(), text: "recall" });
    assert.equal(await third.done, undefined);
    assert.equal(third.events.at(-1)?.type, "RUN_FINISHED");
    assert.deepEqual(third.agent.messages, (await (await host.api(path)).json()).messages);
  });
}

for (const engine of ["claude", "pi"]) {
  test(`${engine} observers join an open native text stream, replay the prefix once and accept the next delta`, { timeout: 80_000 }, async (t) => {
    const host = await service(t, true);
    const member = await host.post("/members", { requestId: randomUUID(), engine, profile: "fixture.v1" });
    const cid = randomUUID(), path = "/conversations/" + cid;
    await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    const first = host.attach(cid);
    await until(async () => first.events.some((e) => e.type === "STATE_SNAPSHOT") || undefined);
    const requestId = randomUUID();
    await host.post(path + "/inputs", { requestId, text: "stream " + requestId });
    await until(async () => first.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "first") || undefined);
    const paused = await (await host.api(path)).json();
    assert.deepEqual(paused.messages.map((m: { role: string }) => m.role), ["user"]);
    assert.equal(paused.openText.prefix, "first");
    const second = host.attach(cid);
    await until(async () => second.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "first") || undefined);
    await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, requestId), "");
    const settled = await until(async () => {
      const state = await (await host.api(path)).json();
      return state.state.phase === "idle" && [first, second].every((r) => r.events.some((e) => e.type === "TEXT_MESSAGE_END")) ? state : undefined;
    });
    assert.equal(settled.messages.at(-1).content, "first second");
    for (const reader of [first, second]) {
      const live = reader.events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
      assert.deepEqual(live.map((e) => e.delta), ["first", " second"]);
      assert.deepEqual(live.map((e) => e.messageId), [paused.openText.id, paused.openText.id]);
      assert.deepEqual(reader.agent.messages, settled.messages);
    }
    first.agent.abortRun();
    second.agent.abortRun();
  });
}

for (const engine of ["claude", "pi"]) {
  test(`${engine} worker loss after a native text delta closes the message and restores the committed history`, { timeout: 120_000 }, async (t) => {
    const host = await service(t, true);
    const profile = "fixture.recovery." + randomUUID();
    const worker = () => startWorker(t, profile, engine);
    const stop = worker();
    await until(async () => (await host.db.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2", [engine, profile])).rowCount || undefined);
    const member = await host.post("/members", { requestId: randomUUID(), engine, profile });
    const cid = randomUUID(), path = "/conversations/" + cid;
    await host.post("/conversations", { memberId: member.memberId, conversationId: cid });
    const first = host.attach(cid);
    await until(async () => first.events.some((e) => e.type === "STATE_SNAPSHOT") || undefined);
    const requestId = randomUUID();
    await host.post(path + "/inputs", { requestId, text: "wait" });
    await until(async () => first.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "waiting") || undefined);
    const second = host.attach(cid);
    await until(async () => second.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "waiting") || undefined);
    await stop();
    worker();
    await Promise.all([first.done, second.done]);
    const terminal = await (await host.api(path)).json();
    assert.equal(terminal.state.phase, "failed");
    assert.equal(terminal.openText, null);
    assert.deepEqual(terminal.messages, [{ id: requestId, role: "user", content: "wait" }]);
    const { rows: [turn] } = await host.db.query("SELECT attempt,phase FROM birbcrew_ts.turns WHERE conversation_id=$1", [cid]);
    assert.ok(turn.attempt > 1);
    assert.equal(turn.phase, "uncertain");
    for (const reader of [first, second]) {
      assert.equal(reader.events.at(-1)?.type, "RUN_ERROR");
      assert.equal(reader.events.at(-1)?.code, "MEMBER_FAILED");
      const starts = reader.events.filter((e) => e.type === "TEXT_MESSAGE_START").map((e) => e.messageId);
      assert.deepEqual(starts, [requestId + "/assistant"]);
      assert.deepEqual(reader.events.filter((e) => e.type === "TEXT_MESSAGE_END").map((e) => e.messageId), starts);
      assert.deepEqual(reader.agent.messages, terminal.messages);
    }
    const fresh = host.attach(cid);
    await fresh.done;
    assert.equal(fresh.events.at(-1)?.code, "MEMBER_FAILED");
    assert.deepEqual(fresh.agent.messages, terminal.messages);
  });
}

test("an overtaken observer receives CURSOR_EXPIRED and can attach at the latest checkpoint", { timeout: 45_000 }, async (t) => {
  const host = await service(t);
  const member = await host.post("/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.approval.v1" });
  const conversationId = randomUUID(), path = "/conversations/" + conversationId;
  await host.post("/conversations", { memberId: member.memberId, conversationId });
  const reader = host.attach(conversationId);
  await until(async () => reader.events.some((event) => event.type === "STATE_SNAPSHOT") || undefined);
  const gatewaySlot = await host.db.connect();
  const writer = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL });
  const store = new MemberStore(writer), approvals = new ApprovalStore(writer);
  const scope = { memberId: member.memberId, conversationId, ownerId: host.ownerId };
  try {
    for (let turn = 0; turn < 2; turn++) {
      const request = { conversationId, ownerId: scope.ownerId, requestId: randomUUID(), text: "review proposals" };
      const started = await store.beginTurn(request);
      assert.equal(started.kind, "start");
      const { token } = started;
      for (let i = 0; i < 16; i++) {
        const call = { ...scope, requestId: request.requestId, invocationId: randomUUID(), nativeCallId: "call-" + i };
        const proposal = await approvals.propose({ ...call, token, toolName: "record_work_item", arguments: { operation_id: request.requestId } });
        const { approvalId, argumentDigest, version } = proposal;
        await approvals.decide({ ...call, approvalId, argumentDigest, version, choice: "deny" });
        await approvals.settle({ ...call, approvalId, token });
      }
      await store.commitTurn({ conversationId, ownerId: scope.ownerId, requestId: request.requestId, token, reply: "reviewed",
        checkpoint: { version: 1, engine: "pi", state: {} } });
    }
  } finally {
    gatewaySlot.release();
    await writer.end();
  }
  await until(async () => reader.events.find((event) => event.type === "RUN_ERROR" && event.code === "CURSOR_EXPIRED"));
  const snapshot = await (await host.api(path)).json();
  const { rows: [retained] } = await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.public_events WHERE conversation_id=$1", [conversationId]);
  assert.equal(retained.n, "256");
  assert.ok(snapshot.cursor > 256);
  const fresh = host.attach(conversationId);
  await until(async () => fresh.events.some((event) => event.type === "STATE_SNAPSHOT") || undefined);
  assert.deepEqual(fresh.agent.messages, snapshot.messages);
  fresh.agent.abortRun();
});

for (const engine of ["pi", "claude"]) {
  for (const crash of [false, true]) {
    test(`${engine} native argument stream ${crash ? "closes on takeover" : "keeps one public ID through settlement"}`, { timeout: 115_000 }, async t => {
      const host = await service(t, true);
      const profile = "fixture.arguments." + randomUUID();
      const worker = () => startWorker(t, profile, engine, true);
      const stop = worker();
      await until(async () => (await host.db.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2", [engine, profile])).rowCount || undefined);
      const { memberId } = await host.post("/members", { engine, profile, requestId: randomUUID() });
      const cid = randomUUID(), path = "/conversations/" + cid, requestId = randomUUID();
      await host.post("/conversations", { memberId, conversationId: cid });
      const first = host.attach(cid);
      await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
      await host.post(path + "/inputs", { requestId, text: "record stream " + requestId });
      await until(async () => first.events.some(e => e.type === "TOOL_CALL_ARGS") || undefined);
      const snapshot = await (await host.api(path)).json();
      const preview = snapshot.openTools[requestId];
      assert.equal(preview.prefix, '{"operation_id":');
      assert.equal(snapshot.state.pendingApprovals.length, 0);
      const earlyDecision = { memberId, invocationId: requestId, requestId, approvalId: preview.publicId, version: 1, choice: "approve" };
      assert.equal((await host.api(path + "/human", earlyDecision)).status, 409);
      await assert.rejects(new MemberStore(host.db).previewTool({
        ownerId: host.ownerId, conversationId: cid, requestId, token: randomUUID(),
      }, "stale-native-id"));
      const second = host.attach(cid);
      await until(async () => second.events.some(e => e.type === "TOOL_CALL_ARGS") || undefined);
      await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, requestId + ".value"), "");
      await until(async () => [first, second].every(reader => reader.events.some(e => e.type === "TOOL_CALL_ARGS" && e.delta === JSON.stringify(requestId))) || undefined);
      const matched = await (await host.api(path)).json();
      assert.equal(matched.openTools[requestId].prefix, '{"operation_id":' + JSON.stringify(requestId));
      assert.equal(matched.state.pendingApprovals.length, 0);
      const native = await host.db.query("SELECT native_call_id FROM birbcrew_ts.tool_previews WHERE conversation_id=$1", [cid]);
      const nativeId = native.rows[0].native_call_id;
      assert.notEqual(preview.publicId, nativeId);
      if (crash) {
        await stop();
        worker();
        await Promise.all([first.done, second.done]);
      } else {
        await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, requestId), "");
        const approval = await until(async () => (await (await host.api(path)).json()).state.pendingApprovals[0]);
        assert.equal(approval.approvalId, preview.publicId);
        await host.post(path + "/human", { memberId, invocationId: requestId, requestId, approvalId: approval.approvalId, version: approval.version, choice: "approve" });
        await until(async () => {
          const snapshot = await (await host.api(path)).json();
          return snapshot.state.phase === "idle" && [first, second].every(r => r.agent.messages.length === snapshot.messages.length) || undefined;
        });
      }
      const end = await (await host.api(path)).json();
      assert.deepEqual(end.openTools, {});
      if (crash) assert.equal(end.state.phase, "failed");
      const effects = await host.db.query("SELECT note FROM birbcrew_ts.work_items WHERE conversation_id=$1", [cid]);
      assert.deepEqual(effects.rows, crash ? [] : [{ note: "private fixture note" }]);
      const rows = await host.db.query("SELECT event FROM birbcrew_ts.public_events WHERE conversation_id=$1", [cid]);
      for (const reader of [first, second]) {
        const frames = reader.events.filter(e => e.type.startsWith("TOOL_CALL_"));
        assert.deepEqual(frames.map(e => e.type), crash ? ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_ARGS", "TOOL_CALL_END"] :
          ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_ARGS", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
        assert.ok(frames.every(e => e.toolCallId === preview.publicId));
        if (!crash) assert.deepEqual(JSON.parse(frames.filter(e => e.type === "TOOL_CALL_ARGS").map(e => e.delta).join("")), { operation_id: requestId });
        const visible = JSON.stringify([rows.rows, reader.events, end]);
        assert.ok(!visible.includes(nativeId) && !visible.includes("private fixture note"));
        assert.deepEqual(reader.agent.messages, end.messages);
        reader.agent.abortRun();
      }
    });
  }
}

test("two HttpAgents keep both Pi subagents open through separate owner decisions", { timeout: 100_000 }, async (t) => {
  const host = await service(t);
  const { memberId } = await host.post("/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.crew.v1" });
  const conversationId = randomUUID(), path = "/conversations/" + conversationId;
  await host.post("/conversations", { memberId, conversationId });
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  const requestId = randomUUID();
  const tasks = ["first", "second"].map(label => ({ role: "recorder", task: "record assigned " + label }));
  await host.post(path + "/inputs", { requestId, text: "delegate " + JSON.stringify(tasks) });
  const waiting = await until(async () => {
    const { state } = await (await host.api(path)).json();
    return state.pendingApprovals.length === 2 ? state : undefined;
  });
  const late = host.attach(conversationId);
  await until(async () => late.events.filter(e => e.type === "SUBAGENT_STARTED").length === 2 || undefined);
  for (const [i, approval] of waiting.pendingApprovals.entries()) {
    const { approvalId, invocationId, nativeCallId, version } = approval;
    const choice = { memberId, requestId, approvalId, invocationId, ...(nativeCallId && { nativeCallId }), version, choice: i ? "approve" : "deny" };
    await host.post(path + "/human", choice);
    await until(async () => late.events.some(e => e.type === "SUBAGENT_FINISHED" && e.subagentRunId === invocationId) || undefined);
  }
  const terminal = await until(async () => {
    const snapshot = await (await host.api(path)).json();
    return snapshot.state.phase === "idle" && [first, late].every(r => r.agent.messages.length === snapshot.messages.length) ?
      snapshot : undefined;
  });
  for (const observer of [first, late]) {
    assert.equal(observer.agent.messages.filter(m => m.id === requestId + "/assistant" &&
      m.role === "assistant" && m.content === "Assigning tasks.").length,1);
    assert.equal(observer.agent.messages.filter(m => m.id === requestId + "/resumed-assistant").length,1);
    const starts = observer.events.filter(e => e.type === "SUBAGENT_STARTED");
    const ends = observer.events.filter(e => e.type === "SUBAGENT_FINISHED");
    assert.equal(starts.length, 2);
    assert.deepEqual(new Set(starts.map(e => e.subagentRunId)), new Set(ends.map(e => e.subagentRunId)));
    for (const opener of starts) {
      assert.ok(terminal.messages.some((m: { id: string }) => m.id === opener.parentMessageId));
      assert.equal(observer.events.filter(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === opener.parentToolCallId).length, 1);
      assert.ok(observer.events.some(e => e.type === "TOOL_CALL_RESULT" && e.subagentRunId === opener.subagentRunId));
    }
    assert.deepEqual(observer.agent.messages, terminal.messages);
    assert.ok(!observer.events.some(e => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED"));
  }
});

test("two HttpAgents restore child text while its sibling awaits approval", { timeout: 90_000 }, async t => {
  const host = await service(t);
  const { memberId } = await host.post("/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.crew.v1" });
  const gate = randomUUID(), requestId = randomUUID(), conversationId = randomUUID();
  const path = "/conversations/" + conversationId;
  await host.post("/conversations", { memberId, conversationId });
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  await host.post(path + "/inputs", {
    requestId, text: "delegate " + JSON.stringify([
      { role: "analyst", task: "stream " + gate }, { role: "recorder", task: "record assigned checkpoint" },
    ])
  });
  const paused = await until(async () => {
    const snapshot = await (await host.api(path)).json();
    return Object.keys(snapshot.childText).length === 1 && snapshot.state.pendingApprovals.length === 1 ? snapshot : undefined;
  });
  const [childId] = Object.keys(paused.childText);
  assert.equal(paused.childText[childId].prefix, "first");
  assert.ok(!paused.messages.some((m: { id: string }) => m.id === paused.childText[childId].id));
  const second = host.attach(conversationId);
  await until(async () => second.events.some(e => e.type === "TEXT_MESSAGE_CONTENT" && e.subagentRunId === childId) || undefined);
  const { approvalId, invocationId, version } = paused.state.pendingApprovals[0];
  await host.post(path + "/human", { memberId, requestId, approvalId, invocationId, version, choice: "deny" });
  await until(async () => first.events.some(e => e.type === "SUBAGENT_FINISHED" && e.subagentRunId === invocationId) || undefined);
  for (const reader of [first, second]) {
    await until(async () => reader.events.some(e => e.type === "STATE_SNAPSHOT" &&
      (e.snapshot as {children?: {childId: string; phase: string}[]}).children?.some(c => c.childId === invocationId && c.phase === "completed")) || undefined);
    assert.ok(reader.agent.messages.some(m => m.id === paused.childText[childId].id && m.content === "first"));
  }
  await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, gate), "release");
  const terminal = await until(async () => {
    const snapshot = await (await host.api(path)).json();
    return snapshot.state.phase === "idle" && [first, second].every(r => r.events.some(e => e.type === "STATE_SNAPSHOT" &&
      (e.snapshot as { phase: string })?.phase === "idle") && r.agent.messages.length === snapshot.messages.length) ? snapshot : undefined;
  });
  for (const reader of [first, second]) {
    const events = reader.events.filter(e => e.subagentRunId === childId);
    assert.equal(events.filter(e => e.type === "SUBAGENT_STARTED").length, 1);
    assert.deepEqual(events.filter(e => e.type === "TEXT_MESSAGE_CONTENT").map(e => e.delta), ["first", " second"]);
    assert.equal(events.filter(e => e.type === "TEXT_MESSAGE_END").length, 1);
    assert.deepEqual(reader.agent.messages, terminal.messages);
  }
  assert.deepEqual(terminal.childText, {});
});

test("two HttpAgents close a streaming child and its sibling's protected call on cancel", { timeout: 90_000 }, async t => {
  const host = await service(t);
  const { memberId } = await host.post("/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.crew.v1" });
  const requestId = randomUUID(), conversationId = randomUUID(), path = "/conversations/" + conversationId;
  await host.post("/conversations", { memberId, conversationId });
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  await host.post(path + "/inputs", {
    requestId, text: "delegate " + JSON.stringify([
      { role: "analyst", task: "child wait" }, { role: "recorder", task: "record assigned cancelled" },
    ])
  });
  const waiting = await until(async () => {
    const snapshot = await (await host.api(path)).json();
    return Object.keys(snapshot.childText).length && snapshot.state.pendingApprovals.length ? snapshot : undefined;
  });
  const second = host.attach(conversationId);
  await until(async () => second.events.some(e => e.type === "TEXT_MESSAGE_CONTENT") || undefined);
  const approval = waiting.state.pendingApprovals[0];
  await host.post(path + "/cancel", { requestId });
  const snapshot = await until(async () => {
    const state = await (await host.api(path)).json();
    return state.state.phase === "cancelled" && [first, second].every(r => r.agent.messages.length === state.messages.length) ? state : undefined;
  });
  for (const reader of [first, second]) {
    assert.equal(reader.events.filter(e => e.type === "SUBAGENT_ERROR" && e.code === "cancelled").length, 2);
    const results = reader.events.filter(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === approval.approvalId);
    assert.equal(results.length, 1);
    assert.equal(results[0].subagentRunId, approval.invocationId);
    assert.deepEqual(JSON.parse(String(results[0].content)), { kind: "cancelled" });
    assert.deepEqual(reader.agent.messages, snapshot.messages);
  }
  assert.equal((await host.api(path + "/human", {
    memberId,requestId,invocationId:approval.invocationId,approvalId:approval.approvalId,version:1,choice:"approve",
  })).status,409);
  assert.deepEqual(snapshot.childText, {});
  assert.deepEqual(snapshot.state.pendingApprovals, []);
  assert.equal((await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.work_items WHERE conversation_id=$1", [conversationId])).rows[0].n, "0");
});

test("two HttpAgents restore one child's argument stream while a sibling awaits approval", {timeout:95_000}, async t => {
  const host = await service(t);
  const requestId = randomUUID(), conversationId = randomUUID(), path = "/conversations/" + conversationId;
  const {memberId} = await host.post("/members",{requestId:randomUUID(),engine:"pi",profile:"fixture.crew.v1"});
  await host.post("/conversations",{conversationId,memberId});
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  await host.post(path + "/inputs",{requestId,text:"delegate " + JSON.stringify([
    {role:"recorder",task:"record assigned immediate"}, {role:"recorder",task:"record stream " + requestId},
  ])});
  const waiting = await until(async () => {
    const s = await (await host.api(path)).json();
    return s.state.pendingApprovals.length === 1 && Object.keys(s.openTools).length === 1 ? s : undefined;
  });
  const childId = Object.keys(waiting.openTools)[0], partial = waiting.openTools[childId];
  const sibling = waiting.state.pendingApprovals[0];
  assert.notEqual(childId,sibling.invocationId);
  assert.equal(partial.prefix,'{"operation_id":');
  assert.equal((await host.api(path + "/human",{memberId,requestId,invocationId:childId,approvalId:partial.publicId,version:1,choice:"approve"})).status,409);
  const second = host.attach(conversationId);
  await until(async () => second.events.some(e => e.type === "TOOL_CALL_ARGS" && e.subagentRunId === childId) || undefined);
  await host.post(path + "/human",{memberId,requestId,invocationId:sibling.invocationId,approvalId:sibling.approvalId,version:1,choice:"deny"});
  await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!,requestId + ".value"),"");
  await until(async () => second.events.some(e => e.toolCallId === partial.publicId && e.delta === JSON.stringify(requestId)) || undefined);
  await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!,requestId),"");
  await until(async () => (await (await host.api(path)).json()).state.pendingApprovals.find((a:{approvalId:string}) => a.approvalId === partial.publicId));
  await host.post(path + "/human",{memberId,requestId,invocationId:childId,approvalId:partial.publicId,version:1,choice:"approve"});
  const end = await until(async () => {
    const s = await (await host.api(path)).json();
    return s.state.phase === "idle" && [first,second].every(r => r.agent.messages.length === s.messages.length) ? s : undefined;
  });
  for (const reader of [first,second]) {
    const tools = reader.events.filter(e => e.toolCallId === partial.publicId);
    assert.ok(tools.every(e => e.subagentRunId === childId));
    assert.equal(tools.filter(e => e.type === "TOOL_CALL_START").length,1);
    assert.equal(tools.filter(e => e.type === "TOOL_CALL_END").length,1);
    assert.equal(tools.filter(e => e.type === "TOOL_CALL_RESULT").length,1);
    assert.deepEqual(JSON.parse(tools.filter(e => e.type === "TOOL_CALL_ARGS").map(e => e.delta).join("")),{operation_id:requestId});
    assert.ok(!JSON.stringify(reader.events).includes("private fixture note"));
    assert.deepEqual(reader.agent.messages,end.messages);
  }
});

for (const interruption of ["streaming", "pending", "unconfirmed"] as const) {
  test(`terminated Pi child workflow with ${interruption} native work`, { timeout: 100_000 }, async t => {
    const host = await service(t);
    const { memberId } = await host.post("/members", { requestId: randomUUID(), engine: "pi", profile: "fixture.crew.v1" });
    const requestId = randomUUID(), conversationId = randomUUID(), path = "/conversations/" + conversationId;
    await host.post("/conversations", { memberId, conversationId });
    const reader = host.attach(conversationId);
    await until(async () => reader.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
    const tasks = [interruption === "streaming" ? { role: "analyst", task: "child wait" } :
      { role: "recorder", task: "record assigned interrupted" }, { role: "recorder", task: "record assigned survivor" }];
    await host.post(path + "/inputs", { requestId, text: "delegate " + JSON.stringify(tasks) });
    const children = await until(async () => {
      const { rows } = await host.db.query<{ child_id: string; generation: string; approval_id: string }>(
        `SELECT j.child_id, j.generation, j.approval_id FROM birbcrew_ts.pi_children j
         JOIN birbcrew_ts.native_launches n ON j.child_id=n.child_id AND j.generation=n.token
         WHERE j.conversation_id=$1 ORDER BY j.ordinal`, [conversationId]);
      if (rows.length !== 2 || !rows[1].approval_id) return;
      if (interruption === "streaming" && !reader.events.some(e => e.type === "TEXT_MESSAGE_CONTENT" && e.subagentRunId === rows[0].child_id)) return;
      if (interruption !== "streaming" && !rows[0].approval_id) return;
      return rows;
    });
    const [lost, sibling] = children;
    if (interruption === "unconfirmed") {
      // Withhold the independent stop receipt after the paused runner has already exited.
      await until(async () => (await host.db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE token=$1 AND stopped",
        [lost.generation])).rowCount || undefined);
      await host.db.query("UPDATE birbcrew_ts.native_launches SET stopped=false WHERE token=$1", [lost.generation]);
    }
    await host.temporal.workflow.getHandle("birbcrew-ts/child/" + lost.child_id).terminate("Native cleanup proof");
    if (interruption === "unconfirmed") {
      await reader.done;
      assert.equal(reader.events.at(-1)?.code, "MEMBER_FAILED");
      const snapshot = await (await host.api(path)).json();
      assert.equal(snapshot.state.phase, "failed");
      assert.deepEqual(snapshot.childText, {});
      assert.deepEqual(snapshot.state.pendingApprovals, []);
      assert.deepEqual(reader.events.filter(e => e.type === "SUBAGENT_ERROR").map(e => e.code),
        ["cleanup_unconfirmed", "cleanup_unconfirmed"]);
      const { rows: [state] } = await host.db.query(`SELECT t.phase, n.stopped,
        (SELECT count(*) FROM birbcrew_ts.native_stop_requests s WHERE s.token IN ($2,$3)) AS stops
        FROM birbcrew_ts.turns t JOIN birbcrew_ts.native_launches n USING (conversation_id,request_id)
        WHERE t.conversation_id=$1 AND n.token=$2`, [conversationId, lost.generation, sibling.generation]);
      assert.deepEqual(state, {phase:"uncertain", stopped:false, stops:"2"});
      assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.work_items WHERE conversation_id=$1", [conversationId])).rowCount, 0);
      return;
    }
    await until(async () => reader.events.some(e => e.type === "SUBAGENT_ERROR" && e.subagentRunId === lost.child_id) || undefined);
    const waiting = await (await host.api(path)).json();
    assert.deepEqual(waiting.state.pendingApprovals.map((a: {approvalId:string}) => a.approvalId), [sibling.approval_id]);
    const { rows: [stopped] } = await host.db.query(`SELECT j.phase,n.stopped FROM birbcrew_ts.pi_children j
      JOIN birbcrew_ts.native_launches n ON n.token=j.generation WHERE j.child_id=$1`, [lost.child_id]);
    assert.deepEqual(stopped, { phase:"failed", stopped:true });
    if (interruption === "pending") {
      assert.equal(reader.events.filter(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === lost.approval_id &&
        JSON.parse(String(e.content)).kind === "cancelled").length, 1);
      const late = await host.api(path + "/human", {memberId, requestId, invocationId:lost.child_id, approvalId:lost.approval_id, version:1, choice:"approve"});
      assert.ok(!late.ok);
    }
    await host.post(path + "/human", {memberId, requestId, invocationId:sibling.child_id, approvalId:sibling.approval_id, version:1, choice:"approve"});
    const terminal = await until(async () => {
      const snapshot = await (await host.api(path)).json();
      return snapshot.state.phase === "idle" ? snapshot : undefined;
    });
    assert.deepEqual(terminal.childText, {});
    const reply = JSON.parse(terminal.messages.at(-1).content.slice("delegated ".length));
    assert.deepEqual(reply.map((item: {kind:string}) => item.kind), ["failed", "completed"]);
    assert.equal((await host.db.query("SELECT 1 FROM birbcrew_ts.work_items WHERE conversation_id=$1 AND approval_id=$2", [conversationId,sibling.approval_id])).rowCount, 1);
  });
}

test("two HttpAgents keep a silent child step open across a sibling decision", { timeout: 90_000 }, async t => {
  const host = await service(t);
  const requestId = randomUUID(), conversationId = randomUUID(), path = "/conversations/" + conversationId;
  const {memberId} = await host.post("/members", {requestId:randomUUID(), engine:"pi", profile:"fixture.crew.v1"});
  await host.post("/conversations", {conversationId, memberId});
  const first = host.attach(conversationId);
  await until(async () => first.events.some(e => e.type === "STATE_SNAPSHOT") || undefined);
  await host.post(path + "/inputs", {requestId, text: "delegate " + JSON.stringify([
    {role:"analyst", task:"silent stream " + requestId}, {role:"recorder", task:"record assigned checkpoint"}
  ])});
  const paused = await until(async () => {
    const s = await (await host.api(path)).json();
    return s.state.pendingApprovals.length && s.state.children?.some((c: {openStep?: string}) => c.openStep) ? s : undefined;
  });
  const child = paused.state.children.find((c: {role:string}) => c.role === "analyst");
  assert.ok(child.openStep);
  assert.deepEqual(paused.childText, {});
  const second = host.attach(conversationId);
  await until(async () => second.events.some(e => e.type === "STEP_STARTED" && e.stepName === child.openStep) || undefined);
  const {approvalId, invocationId, version} = paused.state.pendingApprovals[0];
  await host.post(path + "/human", {requestId, memberId, approvalId, invocationId, version, choice:"deny"});
  await until(async () => second.events.some(e => e.type === "SUBAGENT_FINISHED" && e.subagentRunId === invocationId) || undefined);
  await writeFile(join(process.env.BIRBCREW_PROOF_STREAM_DIR!, requestId), "release");
  const end = await until(async () => {
    const s = await (await host.api(path)).json();
    return s.state.phase === "idle" && [first, second].every(r => r.agent.messages.length === s.messages.length) ? s : undefined;
  });
  for (const reader of [first, second]) {
    const lifecycle = reader.events.filter(e => e.subagentRunId === child.childId &&
      (e.type.startsWith("SUBAGENT_") || e.type.startsWith("STEP_")));
    assert.deepEqual(lifecycle.map(e => e.type), ["SUBAGENT_STARTED","STEP_STARTED","STEP_FINISHED","SUBAGENT_FINISHED"]);
    assert.equal(lifecycle[2].stepName, child.openStep);
    assert.deepEqual(reader.agent.messages, end.messages);
  }
});

for (const engine of ["pi", "claude"]) {
  test(`${engine} observers resolve an ordinary question through the authenticated gateway`, async (t) => {
    const host = await service(t);
    const { memberId } = await host.post("/members", { requestId: randomUUID(), engine, profile: "fixture.next-step.v1" });
    const cid = randomUUID(), requestId = randomUUID(), path = "/conversations/" + cid;
    await host.post("/conversations", { memberId, conversationId: cid });
    const first = host.attach(cid);
    await host.post(path + "/inputs", { requestId, text: "next step" });
    const card = await until(async () => (await (await host.api(path)).json()).state.pendingQuestions?.[0]);
    const second = host.attach(cid);
    for (const observer of [first, second]) {
      await until(async () => observer.agent.state?.pendingQuestions?.[0] || undefined);
      assert.deepEqual(observer.agent.state.pendingQuestions, [card]);
      assert.deepEqual(observer.agent.state.pendingApprovals, []);
    }
    assert.equal(card.toolName, "choose_next_step");
    assert.deepEqual(card.choices, ["inspect", "test"]);
    assert.ok(!("nativeCallId" in card));
    const { invocationId, approvalId, version } = card;
    const answer = { memberId, requestId, invocationId, approvalId, version, choice: "inspect" };
    assert.equal((await host.api(path + "/human", answer, host.stranger)).status, 404);
    assert.equal((await host.api(path + "/human", { ...answer, version: version + 1 })).status, 409);
    assert.equal((await host.api(path + "/human", { ...answer, choice: "approve" })).status, 409);
    assert.equal((await host.api(path + "/human", { ...answer, choice: "invent" })).status, 400);
    await host.post(path + "/human", answer);
    await host.post(path + "/human", answer);
    assert.equal((await host.api(path + "/human", { ...answer, choice: "test" })).status, 409);
    for (const observer of [first, second]) {
      await until(async () => observer.agent.messages.at(-1)?.content === "selected inspect" || undefined);
      const result = observer.agent.messages.find((entry) => entry.role === "tool");
      assert.equal(result?.toolCallId, approvalId);
      assert.equal(result?.content, "inspect");
      await until(async () => observer.agent.state?.phase === "idle" || undefined);
      assert.deepEqual(observer.agent.state.pendingQuestions, []);
    }
    assert.deepEqual(first.agent.messages, second.agent.messages);
    assert.equal((await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.work_items WHERE conversation_id=$1", [cid])).rows[0].n, "0");
  });
}

for (const engine of ["claude", "pi"]) {
  test(`${engine} observers see a granted call run without a card, and its history replays`, { timeout: 120_000 }, async (t) => {
    const host = await service(t);
    const { memberId } = await host.post("/members", { requestId: randomUUID(), engine, profile: "fixture.approval.v1" });
    const cid = randomUUID(), path = "/conversations/" + cid;
    await host.post("/conversations", { memberId, conversationId: cid });
    const observer = host.attach(cid);
    const idle = () => until(async () => { const s = await (await host.api(path)).json(); return s.state.phase === "idle" ? s : undefined; });
    const first = randomUUID();
    await host.post(`/v1${path}/requests`, { requestId: first, text: "record " + first });
    const card = await until(async () => (await (await host.api(path)).json()).state.pendingApprovals[0]);
    assert.deepEqual([card.choices, card.standingChoices], [["approve", "deny"], ["allow_conversation", "allow_always"]]);
    const { invocationId, approvalId, version } = card;
    assert.deepEqual(await host.post(path + "/human", { memberId, requestId: first, invocationId, approvalId, version, choice: "allow_conversation" }),
      { approvalId, decision: "allow_conversation" });
    await idle();
    // The workflow skips its wait behind a patch marker that only a granted call records.
    const workflowId = `birbcrew-ts/member/${memberId}/conversation/${cid}`;
    const patchMarkers = async () => ((await host.temporal.workflow.getHandle(workflowId).fetchHistory()).events ?? [])
      .flatMap((e) => e.markerRecordedEventAttributes?.markerName === "core_patch"
        ? (e.markerRecordedEventAttributes.details?.["patch-data"]?.payloads ?? []).map((payload) => Buffer.from(payload.data ?? []).toString()) : [])
      .filter((patch) => patch.includes("standing-grants-v1"));
    assert.deepEqual(await patchMarkers(), [], "a carded call records no marker");
    const second = randomUUID();
    await host.post(`/v1${path}/requests`, { requestId: second, text: "record " + second });
    const end = await until(async () => { const s = await (await host.api(path)).json();
      return s.state.phase === "idle" && s.messages.filter((m: { role: string }) => m.role === "user").length === 2 ? s : undefined; });
    const [granted] = end.state.grantedCalls;
    assert.equal(end.state.grantedCalls.length, 1);
    assert.deepEqual({ ...granted, approvalId: undefined, grantId: undefined }, { requestId: second, approvalId: undefined, grantId: undefined, scope: "conversation" });
    const { rows: [grant] } = await host.db.query("SELECT grant_id FROM birbcrew_ts.tool_grants WHERE approval_id=$1", [approvalId]);
    assert.equal(granted.grantId, grant.grant_id);
    assert.equal((await host.db.query("SELECT count(*) AS n FROM birbcrew_ts.work_items WHERE conversation_id=$1", [cid])).rows[0].n, "2");
    await until(async () => observer.events.some((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === granted.approvalId) || undefined);
    assert.ok(!observer.events.some((e) => e.type === "STATE_SNAPSHOT" &&
      (e.snapshot as { pendingApprovals: { requestId: string }[] }).pendingApprovals.some((p) => p.requestId === second)), "no card for the granted call");
    const toolFrames = (id: string) => observer.events.filter((e) => String(e.type).startsWith("TOOL_CALL") && e.toolCallId === id).map((e) => e.type);
    assert.deepEqual(toolFrames(granted.approvalId), toolFrames(approvalId), "the same tool-call frames as the carded call");
    assert.equal(toolFrames(approvalId).at(-1), "TOOL_CALL_RESULT");

    assert.equal((await patchMarkers()).length, 1);
    const history = await host.temporal.workflow.getHandle(workflowId).fetchHistory();
    await Worker.runReplayHistory({ workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)) }, history, workflowId);
  });
}
