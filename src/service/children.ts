import { createHash } from "node:crypto";
import { requestChildStop } from "./supervisor-child.ts";
import { setTimeout as delay } from "node:timers/promises";
import { textProjection } from "./text-stream.ts";
import { publishObservation } from "./observation.ts";
import type { Pool, PoolClient } from "pg";
import type { ChildOutcome, Delegation } from "@birbcrew/pi-subagents";
import { ApprovalStore, confirmedApproval, type Approval } from "./approvals.ts";
import { appendAudit } from "./audit.ts";
import { overBudget } from "./usage.ts";
import { childTarget, ChildTargetError, childConsentSchema, fixedProposal, keyTarget, sameDestination, storedTarget, type ChildProfile,
  type ChildTarget } from "./child-target.ts";
import { checkpointSchema, MemberStoreError, type Conversation, type Checkpoint, type TurnRequest } from "./domain.ts";
import { transaction } from "./transaction.ts";


export class ChildNativeStopUnconfirmed extends Error {
  constructor() { super("Child native stop unconfirmed"); this.name = "ChildNativeStopUnconfirmed"; }
}

export interface ChildKey {
  ownerId: string;
  memberId: string;
  conversationId: string;
  requestId: string;
  childId: string;
  /** Absent: the child runs on its parent's Pi profile, as every key recorded before targets. A
   * stored target this release cannot read is left off too, and the child's activity refuses it. */
  target?: ChildTarget;
}
interface ChildRow {
  native_call_id: string;
  task: string;
  role_profile: ChildProfile;
  phase: "ready" | "running" | "waiting" | "resuming" | "complete" | "failed" | "cancelled";
  approval_id: string | null;
  generation: string | null;
  launch_revoked: boolean;
  workflow_run_id: string | null;
  activity_id: string | null;
  attempt: number | null;
  native_checkpoint: Checkpoint | null;
  outcome: ChildOutcome | null;
}
type ChildSettlement =
  | { kind: "completed"; text: string; checkpoint: Checkpoint }
  | { kind: "failed"; code: Extract<ChildOutcome, { kind: "failed" }>["code"] }
  | { kind: "cancelled" };
type Execution = { workflowRunId: string; activityId: string; attempt: number };
type ChildStart =
  | { kind: "start"; generation: string; task: string }
  | { kind: "revoked" | "draining"; generation: string }
  | { kind: "settled"; outcome: ChildOutcome }
  | { kind: "waiting"; approval: Approval };

const unbounded = ["BEGIN"] as const;
const settlement = ["BEGIN", "SET LOCAL lock_timeout='8s'", "SET LOCAL statement_timeout='10s'"] as const;
async function lockParent(db: PoolClient, key: Omit<ChildKey, "childId">) {
  const { rows: [conversation] } = await db.query<Conversation>(`SELECT c.owner_id AS "ownerId", c.member_id AS "memberId",
    c.conversation_id AS "conversationId",m.engine,m.profile FROM birbcrew_ts.conversations c
    JOIN birbcrew_ts.members m USING(owner_id,member_id) WHERE c.owner_id=$1 AND c.member_id=$2 AND c.conversation_id=$3
    FOR UPDATE OF c`, [key.ownerId, key.memberId, key.conversationId]);
  if (!conversation || conversation.engine !== "pi") throw new MemberStoreError("not_found");
  return conversation;
}
async function childRow(db: PoolClient, key: ChildKey) {
  const { rows: [row] } = await db.query<ChildRow>(`SELECT * FROM birbcrew_ts.pi_children
    WHERE child_id=$1 AND conversation_id=$2 AND request_id=$3`, [key.childId, key.conversationId, key.requestId]);
  if (!row) throw new MemberStoreError("not_found");
  return row;
}
async function retireChild(db: PoolClient, key: ChildKey, row: ChildRow) {
  if (row.outcome) return;
  if (row.generation) await requestChildStop(db, key, { token: row.generation, includeWaiting: true });
  else await db.query("UPDATE birbcrew_ts.pi_children SET launch_revoked=true WHERE child_id=$1", [key.childId]);
}
export async function childrenFor(db: PoolClient, conversation: Conversation, requestId: string): Promise<ChildKey[]> {
  const { rows } = await db.query<{ child_id: string; target: unknown }>(`SELECT child_id,role_profile->'target' AS target
    FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2 ORDER BY ordinal`, [conversation.conversationId, requestId]);
  return rows.map(({ child_id, target }) => {
    // A key without a target keeps exactly the shape recorded in histories before targets.
    const stored = keyTarget(target);
    return { ownerId: conversation.ownerId, memberId: conversation.memberId, conversationId: conversation.conversationId, requestId,
      childId: child_id, ...(stored && { target: stored }) };
  });
}

export class ChildStore {
  private readonly pool: Pool;
  private readonly ledger: ApprovalStore;
  constructor(pool: Pool) { this.pool = pool; this.ledger = new ApprovalStore(pool); }

  async delegate(conversation: Conversation, requestId: string, token: string, rawProposals: readonly unknown[], rawCheckpoint: unknown) {
    const proposals = rawProposals.map(fixedProposal);
    if (proposals.length < 1 || proposals.length > 2 || new Set(proposals.map(p => p.nativeCallId)).size !== proposals.length) {
      throw new MemberStoreError("input_limit");
    }
    const checkpoint = checkpointSchema.parse(rawCheckpoint);
    if (checkpoint.engine !== "pi") throw new MemberStoreError("conflict");
    return transaction(this.pool, unbounded, async db => {
      const active = await db.query("SELECT 1 FROM birbcrew_ts.recovery_control WHERE singleton AND phase='active' FOR SHARE");
      if (!active.rowCount) throw new Error("Installation is held for recovery");
      const parent = await lockParent(db, { ...conversation, requestId });
      const args = [conversation.conversationId, requestId];
      // Only the parent turn's own token delegates: a child's launch generation is never a turn
      // token, so a child cannot delegate further.
      const admitted = await db.query(`SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2
        AND token=$3 AND phase='started'`, [...args, token]);
      if (!admitted.rowCount) throw new MemberStoreError("stale");
      await db.query("SELECT birbcrew_ts.lock_child_authority($1,$2)", [parent.engine, parent.profile]);
      const { rows: [authority] } = await db.query<{ consent: unknown; seal: unknown; active: string[] | null }>(
        `SELECT m.child_target_consent AS consent,p.child_target_seal AS seal,p.child_target_active AS active
         FROM birbcrew_ts.members m LEFT JOIN birbcrew_ts.profiles p ON p.engine=m.engine AND p.name=m.profile
         WHERE m.owner_id=$1 AND m.member_id=$2`, [parent.ownerId, parent.memberId]);
      const consent = childConsentSchema.parse(authority.consent);
      const planned = proposals.map(proposal => {
        if (consent.mode === "legacy") return proposal;
        const seal = childConsentSchema.parse(authority.seal);
        const role = proposal.profile.role;
        const destination = consent.roles[role];
        if (!destination || seal.mode !== "named" || !authority.active?.includes(role) || !sameDestination(destination, seal.roles[role])) {
          throw new ChildTargetError("ineligible_target");
        }
        if (destination.engine !== "pi") throw new ChildTargetError("unsupported_engine");
        return { ...proposal, profile: { ...proposal.profile, model: destination.model, target: { version: 1, ...destination } } };
      });
      await db.query(`INSERT INTO birbcrew_ts.delegations (conversation_id,request_id,parent_checkpoint)
        VALUES ($1,$2,$3)`, [...args, JSON.stringify(checkpoint)]);
      for (const [index, proposal] of planned.entries()) {
        await db.query(`INSERT INTO birbcrew_ts.pi_children (conversation_id,request_id,native_call_id,ordinal,task,role_profile)
          VALUES ($1,$2,$3,$4,$5,$6)`, [...args, proposal.nativeCallId, index, proposal.task,
          JSON.stringify(proposal.profile)]);
      }
      const children = await childrenFor(db, conversation, requestId);
      await publishObservation(db, conversation.conversationId, {kind:"delegation",requestId,
        children:children.map(({childId}, index) => ({childId, role:proposals[index].profile.role}))});
      return children;
    });
  }

  /** The (engine, profile) the child's row says it runs on, whatever its key claims. */
  async target(key: ChildKey): Promise<ChildTarget> {
    const { rows: [row] } = await this.pool.query<{ target: unknown; profile: string }>(`SELECT j.role_profile->'target' AS target,
      m.profile FROM birbcrew_ts.pi_children j JOIN birbcrew_ts.conversations c USING (conversation_id)
      JOIN birbcrew_ts.members m USING (owner_id,member_id)
      WHERE c.owner_id=$1 AND c.member_id=$2 AND j.conversation_id=$3 AND j.request_id=$4 AND j.child_id=$5`,
    [key.ownerId, key.memberId, key.conversationId, key.requestId, key.childId]);
    if (!row) throw new MemberStoreError("not_found");
    return childTarget(storedTarget(row.target), row.profile);
  }

  async begin(key: ChildKey, exec: Execution, resume = false): Promise<ChildStart> {
    return transaction(this.pool, unbounded, async db => {
      const parent = await lockParent(db, key);
      const row = await childRow(db, key);
      if (row.outcome) return { kind: "settled", outcome: row.outcome };
      const turn = await db.query("SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2 AND phase='started'",
        [key.conversationId, key.requestId]);
      if (!turn.rowCount) throw new MemberStoreError("stale");
      if (row.phase === "waiting" && !resume && row.approval_id) {
        return { kind: "waiting", approval: await confirmedApproval(db, { ...key, invocationId: key.childId, approvalId: row.approval_id }) };
      }
      const phase = resume ? "waiting" : "ready";
      if (row.phase !== phase) {
        if (row.workflow_run_id !== exec.workflowRunId || row.activity_id !== exec.activityId ||
          !row.attempt || exec.attempt <= row.attempt) throw new MemberStoreError("stale");
        if (!row.generation) throw new MemberStoreError("stale");
        await requestChildStop(db,key,{token:row.generation});
        return { kind: "revoked", generation: row.generation };
      }
      if (row.launch_revoked) throw new MemberStoreError("stale");
      if (resume) {
        if (row.workflow_run_id !== exec.workflowRunId || !row.generation) throw new MemberStoreError("stale");
        const revoked = await db.query("SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3",
          [key.conversationId, key.requestId, row.generation]);
        if (revoked.rowCount) throw new MemberStoreError("stale");
        const prior = await db.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1 AND token=$2 AND NOT stopped",
          [key.childId,row.generation]);
        if (prior.rowCount) return {kind:"draining",generation:row.generation};
      }
      const firstLaunch = !resume && row.phase === "ready" && row.generation === null;
      if (firstLaunch && await overBudget(db, parent.ownerId, parent.memberId)) {
        const cancelled = await db.query("SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2",
          [key.conversationId, key.requestId]);
        const outcome = await this.settleLocked(db, key, row, cancelled.rowCount
          ? { kind: "cancelled" } : { kind: "failed", code: "budget_exhausted" });
        return { kind: "settled", outcome };
      }
      const admitted = await db.query<{ generation: string }>(`UPDATE birbcrew_ts.pi_children SET generation=gen_random_uuid(),
        workflow_run_id=$2,activity_id=$3,attempt=$4,phase=$5 WHERE child_id=$1 RETURNING generation`,
        [key.childId, exec.workflowRunId, exec.activityId, exec.attempt, resume ? "resuming" : "running"]);
      await publishObservation(db, key.conversationId, { kind: resume ? "childResumed" : "childStarted", requestId: key.requestId, childId: key.childId });
      if (firstLaunch) {
        const target = childTarget(storedTarget(row.role_profile.target), parent.profile);
        await appendAudit(db, { type: "delegation.started", ...parent, requestId: key.requestId,
          payload: { childId: key.childId, role: row.role_profile.role, engine: target.engine, profile: target.profile } });
      }
      return { kind: "start", generation: admitted.rows[0].generation, task: row.task };
    });
  }

  async reconcile(key: ChildKey, runId: string, resuming: boolean) {
    const interrupted = await transaction(this.pool, unbounded, async db => {
      await lockParent(db,key);
      const row = await childRow(db,key);
      if (row.workflow_run_id && row.workflow_run_id !== runId) throw new MemberStoreError("stale");
      if (row.outcome) return {kind:"complete"} as const;
      const { rows: [{ retired }] } = await db.query<{ retired: boolean }>(
        "SELECT birbcrew_ts.delegation_child_retired($1) AS retired", [key.childId]);
      if (!retired && !resuming && row.phase === "waiting" && row.approval_id) {
        const approval = await confirmedApproval(db,{...key,invocationId:key.childId,approvalId:row.approval_id});
        return {kind:"pending",approval} as const;
      }
      await retireChild(db, key, row);
      return {kind:"interrupted",generation:row.generation} as const;
    });
    if (interrupted.kind !== "interrupted") return interrupted;
    if (interrupted.generation) await this.waitStopped(key,interrupted.generation);
    await this.finish(key,interrupted.generation,null,true);
    return {kind:"complete"} as const;
  }

  async closeExitedChild(key: ChildKey, cancelled: boolean) {
    const generation = await transaction(this.pool, settlement, async db => {
      await lockParent(db, key);
      const row = await childRow(db, key);
      await retireChild(db, key, row);
      return row.generation;
    });
    if (generation) await this.waitStopped(key, generation);
    if (cancelled) await this.cancel(key);
    else await this.finish(key, generation, null, true);
  }

  async quarantineDelegation(conversation: Conversation, request: TurnRequest, runId: string) {
    await transaction(this.pool, unbounded, async db => {
      const parent = await lockParent(db, {...conversation, requestId: request.requestId});
      const args = [conversation.conversationId, request.requestId];
      const retired = await db.query(`UPDATE birbcrew_ts.turns SET phase='uncertain'
        WHERE conversation_id=$1 AND request_id=$2 AND workflow_run_id=$3 AND prompt_digest=$4
          AND phase IN ('started','uncertain')`, [...args,runId,createHash("sha256").update(request.text).digest()]);
      if (!retired.rowCount) throw new MemberStoreError("stale");
      await db.query(`INSERT INTO birbcrew_ts.native_stop_requests (conversation_id,request_id,token)
        SELECT conversation_id,request_id,generation FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2
          AND generation IS NOT NULL AND outcome IS NULL ON CONFLICT DO NOTHING`, args);
      await publishObservation(db, conversation.conversationId, {kind:"failed",requestId:request.requestId});
      // The workflow fails without reconcileTurn after a quarantined delegation.
      await appendAudit(db, {type:"request.finished", ownerId:parent.ownerId, memberId:parent.memberId,
        conversationId:parent.conversationId, requestId:request.requestId, payload:{status:"uncertain"}});
    });
  }

  async waitStopped(key: ChildKey, token: string) {
    const deadline = performance.now() + 6000;
    while (performance.now() < deadline) {
      const { rows: [launch] } = await this.pool.query<{stopped:boolean}>(
        "SELECT stopped FROM birbcrew_ts.native_launches WHERE child_id=$1 AND token=$2", [key.childId, token]);
      if (!launch || launch.stopped) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) await delay(Math.min(100, remaining));
    }
    throw new ChildNativeStopUnconfirmed();
  }

  private async cancel(key: ChildKey) {
    return transaction(this.pool, settlement, async db => {
      await lockParent(db, key);
      const row = await childRow(db, key);
      if (row.outcome) return row.outcome;
      return this.settleLocked(db, key, row, { kind: "cancelled" });
    });
  }

  async finish(key: ChildKey, generation: string | null, result: { text: string; checkpoint: unknown } | null, reconciled = false) {
    return transaction(this.pool, reconciled ? settlement : unbounded, async db => {
      await lockParent(db, key);
      const row = await childRow(db, key);
      if (row.generation !== generation) throw new MemberStoreError("stale");
      if (row.outcome) return row.outcome;
      const cancelled = await db.query("SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2",
        [key.conversationId,key.requestId]);
      if (cancelled.rowCount) return this.settleLocked(db, key, row, { kind: "cancelled" });
      if (!reconciled) {
        const stopped = await db.query("SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3",
          [key.conversationId,key.requestId,generation]);
        if (row.launch_revoked || stopped.rowCount) throw new MemberStoreError("stale");
      }
      if (!reconciled && row.phase !== "running" && row.phase !== "resuming") throw new MemberStoreError("conflict");
      if (result && (Buffer.byteLength(result.text) > 16384 || !result.text.trim() || !result.text.isWellFormed() || result.text.includes("\0"))) {
        result = null;
      }
      const checkpoint = result ? checkpointSchema.parse(result.checkpoint) : null;
      if (checkpoint && checkpoint.engine !== "pi") throw new MemberStoreError("conflict");
      return this.settleLocked(db, key, row, result && checkpoint
        ? { kind: "completed", text: result.text, checkpoint } : { kind: "failed", code: "child_failed" });
    });
  }

  private async settleLocked(db: PoolClient, key: ChildKey, row: ChildRow, settlement: ChildSettlement): Promise<ChildOutcome> {
    const outcome: ChildOutcome = settlement.kind === "completed"
      ? { kind: "completed", nativeCallId: row.native_call_id, text: settlement.text }
      : { ...settlement, nativeCallId: row.native_call_id };
    const checkpoint = settlement.kind === "completed" ? settlement.checkpoint : null;
    await db.query(`UPDATE birbcrew_ts.pi_children SET phase=$2,outcome=$3,
      native_checkpoint=CASE WHEN $2='cancelled' THEN native_checkpoint ELSE $4::jsonb END WHERE child_id=$1`,
      [key.childId, outcome.kind === "completed" ? "complete" : outcome.kind, JSON.stringify(outcome), checkpoint && JSON.stringify(checkpoint)]);
    if (outcome.kind !== "completed" && row.approval_id) await this.ledger.closeChildApproval(db, key, row.approval_id);
    await publishObservation(db, key.conversationId, { kind: "childEnded", requestId: key.requestId, childId: key.childId, outcome: outcome.kind,
      ...(outcome.kind === "completed" && { text: (await textProjection(db, key.conversationId))(outcome.text, true) }) });
    await appendAudit(db, { type: "delegation.finished", ownerId: key.ownerId, memberId: key.memberId,
      conversationId: key.conversationId, requestId: key.requestId, payload: outcome.kind === "failed"
        ? { childId: key.childId, outcome: outcome.kind, code: outcome.code } : { childId: key.childId, outcome: outcome.kind } });
    return outcome;
  }
}
