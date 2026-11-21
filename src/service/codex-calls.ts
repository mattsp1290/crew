import { traced } from "./telemetry.ts";
import { createHash } from "node:crypto";
import { ApplicationFailure } from "@temporalio/client";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ApprovalStore, confirmedApproval, decisionSchema, recordedChoice, settlement, type Approval, type Decision, type Refusal } from "./approvals.ts";
import { appendAudit } from "./audit.ts";
import { toolNameSchema, type DeferredTool, type ToolOutcome } from "./deferral.ts";
import { MemberStoreError, openSchema, turnKey } from "./domain.ts";
import { publishObservation } from "./observation.ts";
import type { Launch } from "./supervisor.ts";

type Scope = Pick<Launch, "ownerId" | "conversationId" | "requestId">;
type LiveProposal = { threadId: string; nativeCallId: string; toolName: DeferredTool; args: unknown; expiresAt: string };
const cancelScope = openSchema.extend({requestId: turnKey.shape.requestId});

async function lockMember(db: PoolClient, key: Scope) {
  const {rows: [member]} = await db.query<{memberId: string; profile: string}>(`SELECT c.member_id AS "memberId",m.profile
    FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING(owner_id,member_id)
    WHERE c.owner_id=$1 AND c.conversation_id=$2 AND m.engine='codex' FOR UPDATE OF c`, [key.ownerId,key.conversationId]);
  if (!member) throw new MemberStoreError("not_found");
  return member;
}

// Match the original launch even during cleanup after the turn has been retired.
async function launchRecord(db: PoolClient, launch: Launch, protect = false) {
  if (launch.childId) throw new MemberStoreError("stale");
  const {rows: [record]} = await db.query<{active:boolean}>(`SELECT
    (t.token=n.token AND t.phase='started' AND NOT n.stopped AND NOT n.recovery_closed
      AND (t.workflow_run_id,t.activity_id,t.attempt)=(n.workflow_run_id,n.activity_id,n.attempt)
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests s
        WHERE (s.conversation_id,s.request_id,s.token)=(n.conversation_id,n.request_id,n.token))
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.tool_cancellations x
        WHERE (x.conversation_id,x.request_id)=(n.conversation_id,n.request_id))) AS active
    FROM birbcrew_ts.native_launches n JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
    WHERE n.conversation_id=$1 AND n.request_id=$2 AND n.token=$3 AND n.workflow_run_id=$4 AND n.activity_id=$5
      AND n.attempt=$6 AND n.child_id IS NULL AND t.prompt_digest=$7`,
    [launch.conversationId,launch.requestId,launch.token,launch.execution.workflowRunId,
      launch.execution.activityId,launch.execution.attempt,createHash("sha256").update(launch.text).digest()]);
  if (!record) throw new MemberStoreError("stale");
  if (protect && record.active) {
    // Serialize physical stop acknowledgement with this short proposal/effect transaction.
    const lease = await db.query(`SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND request_id=$2
      AND token=$3 AND NOT stopped FOR SHARE`, [launch.conversationId,launch.requestId,launch.token]);
    if (!lease.rowCount) return {active:false};
  }
  return record;
}

/** The model’s operation id is not the approval key. A live record stores the request id and keeps a note only when the model sent one. */
export function boundLiveArguments(tool: DeferredTool, requestId: string, args: unknown) {
  if (tool !== "record_work_item") return args;
  const record = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  return { operation_id: requestId, ...("note" in record ? { note: record.note } : {}) };
}

export async function proposeLive(pool: Pool, launch: Launch, input: LiveProposal): Promise<Approval> {
  const threadId = z.uuid().parse(input.threadId);
  const expiresAt = z.iso.datetime({offset:true}).parse(input.expiresAt);
  const tool = toolNameSchema.parse(input.toolName);
  const ledger = new ApprovalStore(pool);
  return ledger.transaction(async db => {
    const member = await lockMember(db, launch);
    if (!(await launchRecord(db, launch, true)).active) throw new MemberStoreError("stale");
    const permitted = await db.query(`SELECT 1 FROM birbcrew_ts.profiles WHERE engine='codex' AND name=$1
      AND (protected_tool=$2 OR human_tool=$2) AND $3::timestamptz>clock_timestamp()
      AND $3::timestamptz<=clock_timestamp()+interval '170 seconds'`, [member.profile,tool,expiresAt]);
    if (!permitted.rowCount) throw new MemberStoreError("conflict");
    await db.query("SELECT 1 FROM birbcrew_ts.members WHERE member_id=$1 FOR NO KEY UPDATE", [member.memberId]);
    const capacity = await db.query(`SELECT 1 FROM birbcrew_ts.codex_live_calls l
      JOIN birbcrew_ts.conversations c USING(conversation_id)
      JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
      JOIN birbcrew_ts.native_launches n ON (n.conversation_id,n.request_id,n.token)=(l.conversation_id,l.request_id,l.token)
      WHERE c.member_id=$1 AND l.phase IN ('waiting','dispatching') AND l.expires_at>clock_timestamp()
        AND t.phase='started' AND t.token=l.token AND NOT n.stopped AND NOT EXISTS
          (SELECT 1 FROM birbcrew_ts.native_stop_requests s WHERE
            (s.conversation_id,s.request_id,s.token)=(l.conversation_id,l.request_id,l.token))
      LIMIT 1 OFFSET 1`, [member.memberId]);
    if (capacity.rowCount) throw new MemberStoreError("input_limit");
    const key = {ownerId:launch.ownerId, memberId:member.memberId, conversationId:launch.conversationId,
      requestId:launch.requestId, token:launch.token, invocationId:launch.requestId, nativeCallId:input.nativeCallId};
    // A request's approval deadline (docs/approval-expiry.md) can only shorten the live deadline:
    // the earlier one is the card's, and the live-call machinery below enforces it.
    const {rows: [live]} = await db.query<{deadline: Date}>(`SELECT least($3::timestamptz,
      (SELECT date_trunc('milliseconds', clock_timestamp()) + make_interval(secs => approval_deadline_seconds)
         FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2)) AS deadline`,
      [key.conversationId,key.requestId,expiresAt]);
    const liveDeadline = live.deadline.toISOString();
    const approval = await ledger.proposeLocked(db, {...key,toolName:tool,arguments:boundLiveArguments(tool, key.requestId, input.args)},
      undefined, {liveDeadline});
    const inserted = await db.query(`INSERT INTO birbcrew_ts.codex_live_calls
      (approval_id,conversation_id,request_id,token,thread_id,expires_at)
      SELECT $1,$2,$3,$4,$5,$6::timestamptz WHERE $6::timestamptz>clock_timestamp() ON CONFLICT DO NOTHING`, [approval.approvalId,key.conversationId,key.requestId,key.token,threadId,liveDeadline]);
    // A new HTTP request must never acquire the original native callback.
    if (!inserted.rowCount) throw new MemberStoreError("conflict");
    return approval;
  });
}

async function callRecord(db: PoolClient, key: Scope, approvalId: string) {
  const {rows: [call]} = await db.query<{
    token:string; phase:"waiting"|"dispatching"|"delivered"|"interrupted"; active:boolean; decision:string|null; choice:Decision["choice"]|null;
    decisionId:string|null; grantId:string|null;
  }>(`SELECT l.token,l.phase,p.decision,${recordedChoice} AS choice,p.decision_id AS "decisionId",p.grant_id AS "grantId",
    (l.expires_at>clock_timestamp() AND t.phase='started' AND t.token=l.token AND NOT n.stopped AND NOT n.recovery_closed
      AND (t.workflow_run_id,t.activity_id,t.attempt)=(n.workflow_run_id,n.activity_id,n.attempt)
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests s WHERE
        (s.conversation_id,s.request_id,s.token)=(l.conversation_id,l.request_id,l.token))
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.tool_cancellations x WHERE
        (x.conversation_id,x.request_id)=(l.conversation_id,l.request_id))) AS active
    FROM birbcrew_ts.codex_live_calls l JOIN birbcrew_ts.deferred_calls p USING(approval_id)
    JOIN birbcrew_ts.native_launches n ON (n.conversation_id,n.request_id,n.token)=(l.conversation_id,l.request_id,l.token)
    JOIN birbcrew_ts.turns t ON (t.conversation_id,t.request_id)=(l.conversation_id,l.request_id)
    WHERE l.conversation_id=$1 AND l.request_id=$2 AND l.approval_id=$3`, [key.conversationId,key.requestId,approvalId]);
  if (!call) throw new MemberStoreError("not_found");
  return call;
}

// Caller holds the conversation row. Retain actual effects when MCP delivery was never confirmed.
export async function interruptLiveLocked(db: PoolClient, key: Scope, token?: string, approvalId?: string) {
  const {rows} = await db.query<{approval_id:string;receipt_id:string|null}>(`WITH closed AS (
    UPDATE birbcrew_ts.codex_live_calls SET phase='interrupted' WHERE conversation_id=$1 AND request_id=$2
      AND ($3::uuid IS NULL OR token=$3) AND ($4::uuid IS NULL OR approval_id=$4)
      AND phase IN ('waiting','dispatching') RETURNING approval_id)
    SELECT c.approval_id,w.receipt_id FROM closed c LEFT JOIN birbcrew_ts.work_items w USING(approval_id)`,
    [key.conversationId,key.requestId,token ?? null,approvalId ?? null]);
  for (const row of rows) {
    await publishObservation(db, key.conversationId, {kind:"liveClosed",requestId:key.requestId,approvalId:row.approval_id,
      effect:row.receipt_id ? "committed" : "none",delivery:"unknown",...(row.receipt_id && {receiptId:row.receipt_id})});
  }
}

export async function interruptLive(pool: Pool, launch: Launch, approvalId?: string) {
  return new ApprovalStore(pool).transaction(async db => {
    await lockMember(db, launch);
    await launchRecord(db, launch);
    await interruptLiveLocked(db, launch, launch.token, approvalId);
  });
}

export async function answerLive(pool: Pool, input: Decision): Promise<Decision["choice"]> {
  const key = decisionSchema.parse(input);
  const ledger = new ApprovalStore(pool);
  const answer = await ledger.transaction(async (db): Promise<{ choice: Decision["choice"] } | { refused: Refusal }> => {
    const member = await lockMember(db, key);
    if (member.memberId !== key.memberId) throw new MemberStoreError("not_found");
    const proposal = await confirmedApproval(db, key);
    if (proposal.nativeCallId !== key.nativeCallId || proposal.version !== key.version ||
        proposal.argumentDigest !== key.argumentDigest) throw new MemberStoreError("conflict");
    const call = await callRecord(db, key, key.approvalId);
    const settled = settlement(call, key);
    if (settled.kind === "replay") return { choice: settled.choice };
    // A refusal is returned, not thrown, so the interruption of a call that is no longer active commits.
    if (settled.kind === "refused" || call.phase !== "waiting" || !call.active) {
      if (!call.active) await interruptLiveLocked(db,key,call.token,key.approvalId);
      return { refused: settled.kind === "refused" ? settled.code : "conflict" };
    }
    try {
      return { choice: await ledger.decideLocked(db,key,true) };
    } catch (error) {
      if (!(error instanceof MemberStoreError) || error.code !== "stale") throw error;
      await interruptLiveLocked(db,key,call.token,key.approvalId);
      return { refused: "conflict" };
    }
  });
  if ("refused" in answer) throw new MemberStoreError(answer.refused);
  return answer.choice;
}

/** The decideLive activity. A decision refusal is deterministic, so Temporal must not retry it. */
export async function decideLiveActivity(pool: Pool, input: Decision): Promise<Decision["choice"]> {
  try {
    return await answerLive(pool, input);
  } catch (error) {
    if (error instanceof MemberStoreError && (error.code === "decision_conflict" || error.code === "decision_unverifiable")) {
      throw ApplicationFailure.nonRetryable(error.code);
    }
    throw error;
  }
}

export async function settleLive(pool: Pool, launch: Launch, approvalId: string):
Promise<ToolOutcome | {kind:"pending"|"interrupted"}> {
  const ledger = new ApprovalStore(pool);
  return ledger.transaction(async db => {
    const member = await lockMember(db,launch);
    const grant = await launchRecord(db,launch,true);
    const call = await callRecord(db,launch,approvalId);
    if (call.token !== launch.token) throw new MemberStoreError("stale");
    if (!grant.active || !call.active) {
      await interruptLiveLocked(db,launch,launch.token,approvalId);
      return {kind:"interrupted"};
    }
    if (call.phase !== "waiting") return {kind:"interrupted"};
    if (!call.decision) return {kind:"pending"};
    const claimed = await db.query(`UPDATE birbcrew_ts.codex_live_calls SET phase='dispatching'
      WHERE approval_id=$1 AND phase='waiting' AND expires_at>clock_timestamp()`, [approvalId]);
    if (!claimed.rowCount) {
      await interruptLiveLocked(db,launch,launch.token,approvalId);
      return {kind:"interrupted"};
    }
    const approval = await confirmedApproval(db,{...member,ownerId:launch.ownerId,conversationId:launch.conversationId,
      requestId:launch.requestId,invocationId:launch.requestId,approvalId});
    try {
      return await traced("tool.settle",{...launch,engine:"codex",workflowRunId:launch.execution.workflowRunId},
        () => ledger.settleLocked(db,{...approval,token:launch.token},true));
    } catch (error) {
      if (!(error instanceof MemberStoreError) || error.code !== "stale") throw error;
      await interruptLiveLocked(db,launch,launch.token,approvalId);
      return {kind:"interrupted"};
    }
  });
}

export async function confirmDelivery(pool: Pool, launch: Launch, approvalId: string) {
  await new ApprovalStore(pool).transaction(async db => {
    await lockMember(db,launch);
    const grant = await launchRecord(db,launch,true);
    const call = await callRecord(db,launch,approvalId);
    if (call.token !== launch.token) throw new MemberStoreError("stale");
    if (call.phase === "delivered") return;
    if (call.phase !== "dispatching" || !grant.active) throw new MemberStoreError("stale");
    await db.query("UPDATE birbcrew_ts.codex_live_calls SET phase='delivered' WHERE approval_id=$1", [approvalId]);
    await publishObservation(db,launch.conversationId,{kind:"liveDelivered",requestId:launch.requestId,approvalId});
  });
}

export async function cancelLive(pool: Pool, input: Scope & {memberId: string}) {
  const key = cancelScope.parse(input);
  await new ApprovalStore(pool).transaction(async db => {
    const member = await lockMember(db,key);
    if (member.memberId !== key.memberId) throw new MemberStoreError("not_found");
    const {rows: [turn]} = await db.query<{token:string;phase:string}>(`SELECT token,phase FROM birbcrew_ts.turns
      WHERE conversation_id=$1 AND request_id=$2`, [key.conversationId,key.requestId]);
    if (!turn) throw new MemberStoreError("not_found");
    const args = [key.conversationId,key.requestId];
    const prior = await db.query("SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2",args);
    if (prior.rowCount) return;
    if (turn.phase !== "started") throw new MemberStoreError("conflict");
    await db.query("INSERT INTO birbcrew_ts.tool_cancellations (conversation_id,request_id) VALUES ($1,$2)",args);
    await db.query(`INSERT INTO birbcrew_ts.native_stop_requests (conversation_id,request_id,token)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [...args,turn.token]);
    await interruptLiveLocked(db,key,turn.token);
    await publishObservation(db,key.conversationId,{kind:"cancelled",requestId:key.requestId});
    await appendAudit(db,{type:"request.cancellation_requested",ownerId:key.ownerId,memberId:key.memberId,
      conversationId:key.conversationId,requestId:key.requestId,payload:{}});
  });
}
