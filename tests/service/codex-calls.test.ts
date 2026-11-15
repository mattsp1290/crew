import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {after,before,test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {Pool} from "pg";
import {ApprovalStore, type Approval, type Decision} from "../../src/service/approvals.ts";
import {answerLive,cancelLive,confirmDelivery,interruptLive,proposeLive,settleLive} from "../../src/service/codex-calls.ts";
import {requestNativeStop,withNativeAdmission} from "../../src/service/native-admission.ts";
import {readSnapshot} from "../../src/service/observation.ts";
import {MemberStore} from "../../src/service/store.ts";
import type {DeferredTool} from "../../src/service/deferral.ts";
import {ownerInitiator} from "../../src/service/domain.ts";

const pool = new Pool({connectionString:process.env.BIRBCREW_TEST_DATABASE_URL});
const store = new MemberStore(pool);
before(() => store.migrate());
after(() => pool.end());

async function member(tool:DeferredTool) {
  const ownerId = randomUUID(), profile = "live-" + randomUUID();
  const columns = tool === "record_work_item" ? "protected_tool" : "human_tool";
  await pool.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,volume,${columns})
    VALUES ($1,'codex',$2,$3,$4)`,[profile,Buffer.alloc(32),randomUUID(),tool]);
  return store.spawn({ownerId,requestId:randomUUID(),engine:"codex",profile});
}

async function conversation(m: Awaited<ReturnType<typeof member>>, admitted = false) {
  const {ownerId,memberId} = m;
  const conversationId=randomUUID(), requestId=randomUUID(), scope={ownerId,memberId,conversationId,requestId};
  await store.openConversation({ownerId,memberId,conversationId});
  const execution={workflowRunId:randomUUID(),activityId:"sdk",attempt:1};
  const request={ownerId,conversationId,requestId,text:"one live turn"};
  if (admitted) await store.recordAcceptance(request,ownerInitiator);
  const start=await store.beginTurn(request,execution);
  assert.equal(start.kind,"start");
  const launch={...request,execution,token:start.token};
  await pool.query(`INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`,[conversationId,requestId,start.token,execution.workflowRunId,execution.activityId]);
  function proposal(toolName:DeferredTool="record_work_item") {
    return {threadId:randomUUID(),nativeCallId:"private-" + randomUUID(),toolName,
      args:toolName==="record_work_item" ? {operation_id:requestId,note:"private note"} : {},
      expiresAt:new Date(Date.now()+45_000).toISOString()};
  }
  const writes = async () => (await pool.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1",[conversationId])).rows;
  const view = async () => readSnapshot(pool,ownerId,conversationId);
  return {scope,launch,proposal,writes,view};
}

function decision(a:Approval,choice:Decision["choice"]):Decision {
  const {ownerId,memberId,conversationId,requestId,invocationId,nativeCallId,approvalId,argumentDigest,version}=a;
  return {ownerId,memberId,conversationId,requestId,invocationId,nativeCallId,approvalId,argumentDigest,version,choice};
}

test("live MCP consumes one authenticated decision and confirms native delivery once", async () => {
  const {scope,launch,proposal,writes,view}=await conversation(await member("record_work_item"));
  const body=proposal();
  const a=await proposeLive(pool,launch,body);
  const ledger=new ApprovalStore(pool);
  const choice=decision(a,"approve");
  await assert.rejects(proposeLive(pool,launch,body));
  await assert.rejects(proposeLive(pool,launch,proposal("choose_next_step")));
  await assert.rejects(answerLive(pool,{...choice,nativeCallId:"forged"}));
  await assert.rejects(answerLive(pool,{...choice,ownerId:randomUUID()}));
  await assert.rejects(settleLive(pool,{...launch,token:randomUUID()},a.approvalId));
  assert.deepEqual(await settleLive(pool,launch,a.approvalId),{kind:"pending"});
  assert.deepEqual(await writes(),[]);
  assert.equal((await view()).state.pendingApprovals[0].expiresAt,body.expiresAt);
  const {memberId,ownerId,conversationId}=scope;
  assert.equal((await ledger.pending({memberId,ownerId,conversationId})).length,1);
  await assert.rejects(ledger.decide(choice),{code:"stale"});
  assert.equal(await answerLive(pool,choice),"approve");
  await assert.rejects(ledger.settleConfirmed(a),{code:"stale"});
  const replies=await Promise.all([settleLive(pool,launch,a.approvalId),settleLive(pool,launch,a.approvalId)]);
  assert.deepEqual(replies.map(r=>r.kind).sort(),["interrupted","recorded"]);
  const [receipt]=await writes();
  assert.ok(receipt.receipt_id);
  const op={requestId:scope.requestId,approvalId:a.approvalId,effect:"committed",receiptId:receipt.receipt_id};
  assert.deepEqual((await view()).state.liveOperations,[{...op,delivery:"unknown"}]);
  await confirmDelivery(pool,launch,a.approvalId);
  await confirmDelivery(pool,launch,a.approvalId);
  await interruptLive(pool,launch);
  const final=await view();
  assert.deepEqual(final.state.liveOperations,[{...op,delivery:"confirmed"}]);
  assert.equal(final.state.interruptedCalls,undefined);
  assert.equal((await writes()).length,1);
  assert.ok(!JSON.stringify(final).includes(body.nativeCallId));
  assert.ok(!JSON.stringify(final).includes(body.threadId));
  assert.ok(!JSON.stringify(final).includes("private note"));
});

test("a crash after an effect retains its receipt and bars native redelivery", async () => {
  const {scope,launch,proposal,view,writes}=await conversation(await member("record_work_item"));
  const a=await proposeLive(pool,launch,proposal());
  await answerLive(pool,decision(a,"approve"));
  assert.equal((await settleLive(pool,launch,a.approvalId)).kind,"recorded");
  await interruptLive(pool,launch);
  await interruptLive(pool,launch);
  assert.equal((await settleLive(pool,launch,a.approvalId)).kind,"interrupted");
  await assert.rejects(confirmDelivery(pool,launch,a.approvalId));
  const [receipt]=await writes();
  assert.deepEqual((await view()).state.interruptedCalls,[{requestId:scope.requestId,approvalId:a.approvalId,
    effect:"committed",receiptId:receipt.receipt_id,delivery:"unknown"}]);
});

for (const stopped of ["cancel","expiry","revocation"] as const) {
  test(`live MCP ${stopped} before a protected effect prevents new decisions and writes`,async () => {
    const {scope,launch,proposal,view,writes}=await conversation(await member("record_work_item"));
    const a=await proposeLive(pool,launch,proposal());
    if (stopped==="cancel") await cancelLive(pool,scope);
    if (stopped==="expiry") await pool.query("UPDATE birbcrew_ts.codex_live_calls SET expires_at=clock_timestamp() WHERE approval_id=$1",[a.approvalId]);
    if (stopped==="revocation") await requestNativeStop(pool,launch,{token:launch.token});
    await assert.rejects(answerLive(pool,decision(a,"approve")));
    assert.equal((await settleLive(pool,launch,a.approvalId)).kind,"interrupted");
    assert.deepEqual(await writes(),[]);
    assert.deepEqual((await view()).state.interruptedCalls,[{requestId:scope.requestId,approvalId:a.approvalId,effect:"none",delivery:"unknown"}]);
  });
}

test("live settlement honors the deadline even after the owner approved",async () => {
  const {launch,proposal,writes}=await conversation(await member("record_work_item"));
  const a=await proposeLive(pool,launch,proposal());
  await answerLive(pool,decision(a,"approve"));
  await pool.query("UPDATE birbcrew_ts.codex_live_calls SET expires_at=clock_timestamp() WHERE approval_id=$1",[a.approvalId]);
  assert.equal((await settleLive(pool,launch,a.approvalId)).kind,"interrupted");
  assert.deepEqual(await writes(),[]);
});

test("member capacity is shared across live conversations and released after expiry and delivery", async () => {
  const m=await member("choose_next_step");
  const [first,second,third]=await Promise.all([conversation(m),conversation(m),conversation(m)]);
  const a=await proposeLive(pool,first.launch,first.proposal("choose_next_step"));
  const results=await Promise.allSettled([second,third].map(v=>proposeLive(pool,v.launch,v.proposal("choose_next_step"))));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const blocked=results[0].status==="rejected" ? second : third;
  const rejection=results.find(r=>r.status==="rejected");
  assert.equal(rejection?.reason.code,"input_limit");
  await pool.query("UPDATE birbcrew_ts.codex_live_calls SET expires_at=clock_timestamp() WHERE approval_id=$1",[a.approvalId]);
  const b=await proposeLive(pool,blocked.launch,blocked.proposal("choose_next_step"));
  await answerLive(pool,decision(b,"inspect"));
  assert.deepEqual(await settleLive(pool,blocked.launch,b.approvalId),{nativeCallId:b.nativeCallId,kind:"answered",choice:"inspect"});
  await confirmDelivery(pool,blocked.launch,b.approvalId);
  await proposeLive(pool,first.launch,first.proposal("choose_next_step"));
  assert.deepEqual(await blocked.writes(),[]);
});

test("a hanging Codex chat can be cancelled while its native grant is held",async () => {
  const {launch,scope,proposal,writes}=await conversation(await member("record_work_item"));
  const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const sdk=withNativeAdmission(pool,launch,new AbortController().signal,async signal=>{
    entered.resolve();
    await release.promise;
    assert.ok(signal.aborted);
  });
  await entered.promise;
  let draining;
  try {
    // Decisions and cancellation must not compete with an SDK-lifetime lock on the turn.
    await pool.query("SELECT 1 FROM birbcrew_ts.turns WHERE token=$1 FOR UPDATE NOWAIT",[launch.token]);
    await cancelLive(pool,scope);
    draining=requestNativeStop(pool,launch,{token:launch.token});
    const waited=await Promise.race([draining.then(()=>false),delay(200).then(()=>true)]);
    assert.ok(waited,"Revocation still waits for the native launch lease");
    await pool.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE NOWAIT",[scope.conversationId]);
    await assert.rejects(proposeLive(pool,launch,proposal()));
  } finally {
    release.resolve();
    await Promise.all([sdk,draining]);
  }
  assert.deepEqual(await writes(),[]);
});

test("a live native denial returns once and consumes none of the work-item budget",async () => {
  const {launch,proposal,writes}=await conversation(await member("record_work_item"));
  const a=await proposeLive(pool,launch,proposal());
  assert.equal(await answerLive(pool,decision(a,"deny")),"deny");
  assert.deepEqual(await settleLive(pool,launch,a.approvalId),{kind:"denied",nativeCallId:a.nativeCallId});
  await confirmDelivery(pool,launch,a.approvalId);
  assert.equal((await settleLive(pool,launch,a.approvalId)).kind,"interrupted");
  assert.deepEqual(await writes(),[]);
  for (const expected of ["recorded","budget_exhausted"]) {
    const other=await proposeLive(pool,launch,proposal());
    await answerLive(pool,decision(other,"approve"));
    assert.equal((await settleLive(pool,launch,other.approvalId)).kind,expected);
    await confirmDelivery(pool,launch,other.approvalId);
  }
  assert.equal((await writes()).length,1);
});

for (const first of ["stop","effect"] as const) {
  test(`live stop and effect serialize when ${first} obtains the conversation first`,async () => {
    const {scope,launch,proposal,writes}=await conversation(await member("record_work_item"));
    const a=await proposeLive(pool,launch,proposal());
    await answerLive(pool,decision(a,"approve"));
    const gate=await pool.connect();
    let settle,stop;
    try {
      await gate.query("BEGIN");
      const {rows:[blocker]}=await gate.query("SELECT pg_backend_pid() AS pid FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE",
        [scope.conversationId]);
      const stopping=()=>requestNativeStop(pool,launch,{token:launch.token});
      const settling=()=>settleLive(pool,launch,a.approvalId);
      if (first==="stop") stop=stopping();
      else settle=settling();
      let blocked=false;
      for (let i=0;i<100 && !blocked;i++) {
        const current=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[blocker.pid]);
        blocked=Boolean(current.rowCount);
        if (!blocked) await delay(10);
      }
      assert.ok(blocked,"The first operation is waiting on the conversation lock");
      if (first==="stop") settle=settling();
      else stop=stopping();
    } finally {
      await gate.query("ROLLBACK");
      gate.release();
    }
    await stop;
    assert.equal((await settle)?.kind,first==="stop" ? "interrupted" : "recorded");
    assert.equal((await writes()).length,first==="stop" ? 0 : 1);
    await interruptLive(pool,launch);
    const after=await settleLive(pool,launch,a.approvalId);
    assert.equal(after.kind,"interrupted");
  });
}

test("a projected native item commits only against its original UTF-8 bytes", async () => {
  const {scope,launch,view} = await conversation(await member("record_work_item"));
  const {ownerId,conversationId,requestId} = scope;
  const claim = {ownerId,conversationId,requestId,token:launch.token};
  const raw = "Résumé private", item = "Résumé [tool call]";
  const receipt = {bytes:Buffer.byteLength(raw),digest:createHash("sha256").update(raw).digest()};
  await store.appendCodexItem(claim,0,item,receipt);
  await store.appendCodexItem(claim,0,item,receipt);
  await assert.rejects(store.appendCodexItem(claim,0,item,{...receipt,digest:Buffer.alloc(32)}),{code:"conflict"});
  const checkpoint = {version:1, engine:"codex", state:{}};
  await assert.rejects(store.commitTurn({...claim,reply:"Résumé changed",checkpoint}),{code:"conflict"});
  assert.equal((await view()).state.phase,"running");
  assert.equal(await store.commitTurn({...claim,reply:raw,checkpoint}),raw);
  const snapshot = await view();
  assert.equal(snapshot.state.phase,"idle");
  assert.equal(snapshot.messages.at(-1)?.content,item);
});

test("a standing grant approves a Codex live call at its first poll; the deadline and member capacity still apply", async () => {
  const m=await member("record_work_item");
  const first=await conversation(m,true);
  const card=await proposeLive(pool,first.launch,first.proposal());
  assert.deepEqual((await first.view()).state.pendingApprovals[0].standingChoices,["allow_conversation","allow_always"]);
  assert.equal(await answerLive(pool,decision(card,"allow_always")),"allow_always");
  assert.equal(await answerLive(pool,decision(card,"allow_always")),"allow_always");
  await assert.rejects(answerLive(pool,decision(card,"approve")),{code:"conflict"});
  assert.equal((await settleLive(pool,first.launch,card.approvalId)).kind,"recorded");
  await confirmDelivery(pool,first.launch,card.approvalId);
  const {rows:[grant]}=await pool.query("SELECT grant_id FROM birbcrew_ts.tool_grants WHERE member_id=$1",[m.memberId]);

  const second=await conversation(m,true);
  const granted=await proposeLive(pool,second.launch,second.proposal());
  assert.equal(granted.grantId,grant.grant_id);
  const view=await second.view();
  assert.deepEqual(view.state.pendingApprovals,[]);
  assert.deepEqual(view.state.grantedCalls,[{requestId:second.scope.requestId,approvalId:granted.approvalId,grantId:grant.grant_id,scope:"member"}]);
  const settled=await settleLive(pool,second.launch,granted.approvalId);
  assert.equal(settled.kind,"recorded");
  const [receipt]=await second.writes();
  assert.deepEqual((await second.view()).state.liveOperations,[{requestId:second.scope.requestId,approvalId:granted.approvalId,
    effect:"committed",delivery:"unknown",receiptId:receipt.receipt_id}]);
  await confirmDelivery(pool,second.launch,granted.approvalId);

  // An expired granted call is interrupted, not dispatched.
  const late=await conversation(m,true);
  const expired=await proposeLive(pool,late.launch,late.proposal());
  assert.ok(expired.grantId);
  await pool.query("UPDATE birbcrew_ts.codex_live_calls SET expires_at=clock_timestamp() WHERE approval_id=$1",[expired.approvalId]);
  assert.equal((await settleLive(pool,late.launch,expired.approvalId)).kind,"interrupted");
  assert.deepEqual(await late.writes(),[]);

  // A request with no admission row asks, with no standing choice, even under the member's grant.
  const legacy=await conversation(m);
  const asked=await proposeLive(pool,legacy.launch,legacy.proposal());
  assert.equal(asked.grantId,undefined);
  assert.equal((await legacy.view()).state.pendingApprovals[0].standingChoices,undefined);
  await assert.rejects(answerLive(pool,decision(asked,"allow_conversation")),{code:"conflict"});
  await pool.query("UPDATE birbcrew_ts.codex_live_calls SET expires_at=clock_timestamp() WHERE approval_id=$1",[asked.approvalId]);

  // Granted calls count toward the member's two open live calls until they are settled.
  const open=await Promise.all([conversation(m,true),conversation(m,true),conversation(m,true)]);
  const calls=[await proposeLive(pool,open[0].launch,open[0].proposal()),await proposeLive(pool,open[1].launch,open[1].proposal())];
  assert.ok(calls.every(call=>call.grantId));
  await assert.rejects(proposeLive(pool,open[2].launch,open[2].proposal()),{code:"input_limit"});
});

for (const note of [undefined, "", "private note"]) {
  test(`live protected call completeness requires no hidden note (${note === undefined ? "absent" : note === "" ? "empty" : "present"})`, async () => {
    const {scope,launch,proposal,view}=await conversation(await member("record_work_item"));
    const body={...proposal(),args:{operation_id:scope.requestId,...(note === undefined ? {} : {note})}};
    await proposeLive(pool,launch,body);
    const snapshot=await view();
    assert.equal(snapshot.state.pendingApprovals[0].argumentsComplete,note === undefined ? true : undefined);
    assert.ok(!JSON.stringify(snapshot).includes("private note"));
  });
}
