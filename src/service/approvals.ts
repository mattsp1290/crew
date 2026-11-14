import { decideSchema, nextStep, standingChoice } from "@birbcrew/client/contract";
import { acceptsChoice, emptyToolArguments, recordWorkItemArguments, toolNameSchema, type DeferredTool, type ToolOutcome } from "./deferral.ts";
import { createGrant, grantable, proposalGrant, standingScope } from "./grants.ts";
import { publishObservation } from "./observation.ts";
import { appendAudit } from "./audit.ts";
import { createHash } from "node:crypto";
import { MemberStore } from "./store.ts";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { checkpointSchema, MemberStoreError, openSchema, turnKey, type Conversation } from "./domain.ts";

const uuid = turnKey.shape.requestId;
const scopeSchema = openSchema.extend({ requestId: uuid });
const callSchema = scopeSchema.extend({
  invocationId: uuid,
  nativeCallId: z.string().min(1).refine((id) =>
    id.isWellFormed() && !id.includes("\0") && Buffer.byteLength(id) <= 256),
});
const claim = callSchema.extend({ token: uuid });
const proposalSchema = z.discriminatedUnion("toolName", [
  claim.extend({ toolName: z.literal("record_work_item"), arguments: recordWorkItemArguments }),
  claim.extend({ toolName: z.literal("choose_next_step"), arguments: emptyToolArguments }),
]);
const approvalKey = callSchema.extend({ approvalId: uuid });
export const decisionSchema = decideSchema.extend({
  ownerId: openSchema.shape.ownerId, nativeCallId: callSchema.shape.nativeCallId,
  argumentDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const settleSchema = approvalKey.extend({ token: uuid });

type Proposal = z.input<typeof claim> & { toolName: DeferredTool; arguments: unknown };
type ProposalMode = {recoverStopped:true} | {childGeneration:string} | {liveDeadline:string};
type Scope = z.infer<typeof scopeSchema>;
type CallKey = z.infer<typeof approvalKey>;
export type Decision = z.infer<typeof decisionSchema>;
export type Choice = z.infer<typeof decisionSchema>["choice"];
export const approvalSchema = approvalKey.extend({
  toolName: toolNameSchema, argumentDigest: decisionSchema.shape.argumentDigest,
  version: z.literal(1), policyVersion: z.literal(1), summary: z.enum(["Record one work item", "Choose the next step"]),
  // The standing grant that approved the call when it was proposed; such a call has no card.
  grantId: uuid.optional(),
  // When the card stops accepting a decision (docs/approval-expiry.md); absent, it waits.
  expiresAt: z.iso.datetime().optional(),
});
export type Approval = z.infer<typeof approvalSchema>;
export type { ToolOutcome } from "./deferral.ts";

/** The choice a card reports, for deferred_calls alias p: a standing choice is stored as approve
 * plus the scope it granted. Module scope must not need grants.ts, which imports this one in a cycle. */
export const recordedChoice = `CASE p.grant_scope WHEN 'conversation' THEN 'allow_conversation'
  WHEN 'member' THEN 'allow_always' ELSE p.decision END`;
type CallRow = {
  approvalId: string; invocationId: string; nativeCallId: string; argumentDigest: string;
  toolName: DeferredTool; version: 1; policyVersion: 1; budget_exhausted: boolean; grantId: string | null;
  /** As stored: a standing choice is stored as approve. */
  decision: "approve" | "deny" | z.infer<typeof nextStep> | null;
  /** As reported, including a standing choice. */
  choice: Choice | null;
  expiresAt: Date | null;
  expiredAt: Date | null;
};
const columns = `p.approval_id AS "approvalId", p.invocation_id AS "invocationId", p.native_call_id AS "nativeCallId",
  p.argument_digest AS "argumentDigest", p.tool_name AS "toolName", p.decision_version AS version,
  p.policy_version AS "policyVersion", p.decision, ${recordedChoice} AS choice, p.grant_id AS "grantId", p.budget_exhausted,
  p.expires_at AS "expiresAt", p.expired_at AS "expiredAt"`;
/** What expireTurn did: settled the card at its deadline, found it already settled by a decision
 * or a cancellation, or found the deadline not yet reached by the database clock. */
export type Expiry = { kind: "expired" } | { kind: "settled" } | { kind: "early"; remainingMs: number };

function publicApproval(scope: Scope, row: CallRow): Approval {
  return {
    ownerId: scope.ownerId, memberId: scope.memberId, conversationId: scope.conversationId, requestId: scope.requestId,
    approvalId: row.approvalId, invocationId: row.invocationId, nativeCallId: row.nativeCallId,
    toolName: row.toolName, argumentDigest: row.argumentDigest, version: row.version, policyVersion: row.policyVersion,
    summary: row.toolName === "choose_next_step" ? "Choose the next step" : "Record one work item",
    ...(row.grantId && { grantId: row.grantId }),
    ...(row.expiresAt && { expiresAt: row.expiresAt.toISOString() }),
  };
}

async function lockTurn(db: PoolClient, scope: Scope) {
  const conversation = await db.query<{engine:string}>(
    `SELECT m.engine FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING(owner_id,member_id)
     WHERE c.owner_id=$1 AND c.member_id=$2 AND c.conversation_id=$3 FOR UPDATE OF c`, [scope.ownerId, scope.memberId, scope.conversationId],
  );
  if (!conversation.rowCount) throw new MemberStoreError("not_found");
  const { rows: [turn] } = await db.query<{ token: string; phase: string }>(
    "SELECT token, phase FROM birbcrew_ts.turns WHERE conversation_id = $1 AND request_id = $2",
    [scope.conversationId, scope.requestId],
  );
  if (!turn) throw new MemberStoreError("not_found");
  return {...turn, engine:conversation.rows[0].engine};
}

export async function confirmedApproval(db: PoolClient, key: Scope & { invocationId: string; approvalId: string }) {
  const { rows: [row] } = await db.query<CallRow>(
    `SELECT ${columns} FROM birbcrew_ts.deferred_calls p WHERE p.conversation_id=$1 AND p.request_id=$2
     AND p.invocation_id=$3 AND p.approval_id=$4`, [key.conversationId, key.requestId, key.invocationId, key.approvalId]);
  if (!row) throw new MemberStoreError("not_found");
  return publicApproval(key, row);
}

const stoppedChildApproval = `SELECT 1 FROM birbcrew_ts.pi_children j WHERE j.child_id=p.invocation_id AND j.approval_id=p.approval_id
  AND (j.outcome IS NOT NULL OR j.launch_revoked OR EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests s
    WHERE (s.conversation_id,s.request_id,s.token)=(j.conversation_id,j.request_id,j.generation)))`;

async function findCall(db: PoolClient, key: CallKey) {
  const { rows: [row] } = await db.query<CallRow & { childStopped: boolean; live: boolean; pastDeadline: boolean }>(
    `SELECT ${columns}, EXISTS (${stoppedChildApproval}) AS "childStopped",
     COALESCE(p.expires_at <= clock_timestamp(), false) AS "pastDeadline",
     EXISTS (SELECT 1 FROM birbcrew_ts.codex_live_calls l WHERE l.approval_id=p.approval_id) AS live FROM birbcrew_ts.deferred_calls p WHERE p.conversation_id = $1 AND p.request_id = $2
     AND p.invocation_id = $3 AND p.native_call_id = $4 AND p.approval_id = $5`,
    [key.conversationId, key.requestId, key.invocationId, key.nativeCallId, key.approvalId],
  );
  if (!row) throw new MemberStoreError("not_found");
  return row;
}

async function cancelled(db: PoolClient, key: Scope) {
  const result = await db.query(
    "SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id = $1 AND request_id = $2",
    [key.conversationId, key.requestId],
  );
  return result.rows.length > 0;
}

export async function savedProposal(db: PoolClient, conversation: Conversation, requestId: string) {
  const { rows: [row] } = await db.query<CallRow>(
    `SELECT ${columns} FROM birbcrew_ts.deferred_calls p JOIN birbcrew_ts.paused_segments s USING (approval_id)
     WHERE p.conversation_id=$1 AND p.request_id=$2`, [conversation.conversationId, requestId],
  );
  return row ? publicApproval({ ...conversation, requestId }, row) : undefined;
}

export class ApprovalStore {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async migrate() {
    await new MemberStore(this.pool).migrate();
  }

  async propose(input: Proposal, pendingCheckpoint?: unknown, mode?: Exclude<ProposalMode, {liveDeadline:string}>): Promise<Approval> {
    return this.transaction(db => this.proposeLocked(db, input, pendingCheckpoint, mode));
  }

  /** A call an active grant covers is inserted already approved and appends approval.auto_approved;
   * any other new call is a pending card or question and appends approval.requested. Either holds
   * the shared lock every owner's audit read waits on until commit. After it returns, run only
   * database statements and commit: await nothing outside the database. */
  async proposeLocked(db: PoolClient, input: Proposal, pendingCheckpoint?: unknown, mode?: ProposalMode): Promise<Approval> {
    const key = proposalSchema.parse(input);
    if (key.toolName === "record_work_item" && key.arguments.operation_id !== key.requestId) throw new MemberStoreError("conflict");
    const checkpoint = pendingCheckpoint === undefined ? undefined : checkpointSchema.parse(pendingCheckpoint);
    const digest = createHash("sha256").update(JSON.stringify(key.toolName === "choose_next_step" ? [key.toolName] :
      [key.toolName, key.arguments.operation_id, key.arguments.note ?? null])).digest("hex");
    const ids = [key.conversationId, key.requestId, key.invocationId, key.nativeCallId];
    const turn = await lockTurn(db, key);
    if ((turn.engine === "codex") !== Boolean(mode && "liveDeadline" in mode)) throw new MemberStoreError("stale");
    const childGeneration = mode && "childGeneration" in mode ? mode.childGeneration : undefined;
    if (childGeneration) {
      if (key.toolName !== "record_work_item") throw new MemberStoreError("conflict");
      const child = await db.query(`SELECT 1 FROM birbcrew_ts.pi_children
        WHERE child_id=$1 AND conversation_id=$2 AND request_id=$3 AND generation=$4 AND NOT launch_revoked AND phase IN ('running','waiting')
        AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests
                        WHERE conversation_id=$2 AND request_id=$3 AND token=$4)`,
        [key.invocationId, key.conversationId, key.requestId, childGeneration]);
      if (!child.rowCount || !checkpoint || key.token !== childGeneration) throw new MemberStoreError("stale");
    }
    if (!childGeneration && turn.token !== key.token) throw new MemberStoreError("stale");
    if (mode && "recoverStopped" in mode && turn.phase === "uncertain" && checkpoint?.engine === "claude") {
      const recovered = await db.query(`UPDATE birbcrew_ts.turns t SET phase='started'
        FROM birbcrew_ts.native_launches n WHERE n.conversation_id=t.conversation_id AND n.request_id=t.request_id
          AND n.token=t.token AND t.token=$3 AND t.conversation_id=$1 AND t.request_id=$2 AND n.stopped AND NOT n.recovery_closed
          AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.paused_segments s
            WHERE s.conversation_id=t.conversation_id AND s.request_id=t.request_id)
          -- A handed-off source admits nothing new: a turn its handoff counted as uncertain stays
          -- uncertain. lockTurn holds the row lock a handoff takes, so the two serialise.
          AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.conversation_handoffs h
            WHERE h.source_conversation_id=t.conversation_id)`, [key.conversationId, key.requestId, key.token]);
      if (!recovered.rowCount) throw new MemberStoreError("stale");
    } else if (turn.phase !== "started") throw new MemberStoreError("stale");
    if (await cancelled(db, key)) throw new MemberStoreError("conflict");
    const existing = await db.query<CallRow>(
      `SELECT ${columns} FROM birbcrew_ts.deferred_calls p WHERE p.conversation_id = $1 AND p.request_id = $2
       AND p.invocation_id = $3 AND p.native_call_id = $4`, ids,
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.argumentDigest !== digest) throw new MemberStoreError("conflict");
      if (checkpoint) {
        const same = await db.query(childGeneration
          ? "SELECT 1 FROM birbcrew_ts.pi_children WHERE approval_id=$1 AND native_checkpoint=$2::jsonb"
          : "SELECT 1 FROM birbcrew_ts.paused_segments WHERE approval_id=$1 AND checkpoint=$2::jsonb",
          [prior.approvalId, JSON.stringify(checkpoint)]);
        if (!same.rowCount) throw new MemberStoreError("conflict");
      }
      return publicApproval(key, prior);
    }
    const { rows: [preview] } = await db.query<{ public_id: string; native_call_id: string; generation: string }>(
      "SELECT public_id,native_call_id,generation FROM birbcrew_ts.tool_previews WHERE conversation_id=$1 AND request_id=$2 AND invocation_id=$3",
      ids.slice(0, 3));
    if (preview && (preview.native_call_id !== key.nativeCallId || preview.generation !== key.token)) throw new MemberStoreError("stale");
    // A grant decides the call at its first insert; retries and replays read that back above.
    const standing = await proposalGrant(db, key);
    // Only a card the conversation workflow itself waits on gets the request's deadline. A Codex
    // live card keeps the earlier of its own deadline and the request's in codex_live_calls.
    const expires = !(mode && ("liveDeadline" in mode || "childGeneration" in mode)) && key.invocationId === key.requestId
      && !standing.grant;
    const inserted = await db.query<CallRow>(
      `INSERT INTO birbcrew_ts.deferred_calls AS p
       (conversation_id, request_id, invocation_id, native_call_id, tool_name, arguments, argument_digest,
        policy_version, decision_version, approval_id, decision, grant_id, expires_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, 1, 1, COALESCE($8::uuid,gen_random_uuid()), $9::text, $10::uuid,
         CASE WHEN $11::boolean THEN (SELECT date_trunc('milliseconds', clock_timestamp())
           + make_interval(secs => a.approval_deadline_seconds) FROM birbcrew_ts.request_admissions a
           WHERE a.conversation_id = $1 AND a.request_id = $2) END
       WHERE (SELECT count(*) FROM birbcrew_ts.deferred_calls WHERE conversation_id = $1 AND request_id = $2) < 16
       RETURNING ${columns}`, [...ids, key.toolName, key.arguments, digest, preview?.public_id ?? null,
        standing.grant && "approve", standing.grant?.grantId ?? null, expires],
    );
    if (!inserted.rows.length) throw new MemberStoreError("input_limit");
    const row = inserted.rows[0];
    if (childGeneration) {
      const updated = await db.query(`UPDATE birbcrew_ts.pi_children SET phase='waiting',native_checkpoint=$2,approval_id=$3
        WHERE child_id=$1 AND phase='running' AND generation=$4`, [key.invocationId, JSON.stringify(checkpoint), row.approvalId, childGeneration]);
      if (!updated.rowCount) throw new MemberStoreError("stale");
    } else if (checkpoint) {
      await db.query(`INSERT INTO birbcrew_ts.paused_segments (approval_id,conversation_id,request_id,checkpoint)
                      VALUES ($1,$2,$3,$4)`, [row.approvalId, key.conversationId, key.requestId, JSON.stringify(checkpoint)]);
    }
    const approval = publicApproval(key, row);
    await publishObservation(db, key.conversationId, { kind: "call", approval,
      ...(mode && "liveDeadline" in mode && { expiresAt: mode.liveDeadline }),
      ...(approval.expiresAt && { deadline: approval.expiresAt }),
      ...(standing.grant ? { grant: standing.grant } : standing.grantable && { standing: true }) });
    if (standing.grant) await appendAudit(db, { type: "approval.auto_approved", ownerId: key.ownerId, memberId: key.memberId,
      conversationId: key.conversationId, requestId: key.requestId, payload: { approvalId: row.approvalId,
        invocationId: key.invocationId, toolName: "record_work_item", argumentDigest: digest, grantId: standing.grant.grantId } });
    else await appendAudit(db, { type: "approval.requested", ownerId: key.ownerId, memberId: key.memberId,
      conversationId: key.conversationId, requestId: key.requestId, payload: { approvalId: row.approvalId,
        invocationId: key.invocationId, toolName: key.toolName, argumentDigest: digest } });
    return approval;
  }

  async pending(input: z.input<typeof openSchema>) {
    const key = openSchema.parse(input);
    const conversation = await this.pool.query(
      "SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id = $1 AND member_id = $2 AND conversation_id = $3",
      [key.ownerId, key.memberId, key.conversationId],
    );
    if (!conversation.rowCount) throw new MemberStoreError("not_found");
    const result = await this.pool.query<CallRow & { requestId: string }>(
      `SELECT ${columns}, p.request_id AS "requestId" FROM birbcrew_ts.deferred_calls p
         JOIN birbcrew_ts.turns t USING (conversation_id, request_id)
         LEFT JOIN birbcrew_ts.tool_cancellations x USING (conversation_id, request_id)
       WHERE p.conversation_id = $1 AND p.decision IS NULL
         AND t.phase = 'started' AND x.request_id IS NULL
         AND (p.expires_at IS NULL OR p.expires_at > clock_timestamp()) AND p.expired_at IS NULL
         AND NOT EXISTS (${stoppedChildApproval})
         AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.codex_live_calls l WHERE l.approval_id=p.approval_id
           AND (l.phase<>'waiting' OR l.expires_at <= clock_timestamp() OR EXISTS
             (SELECT 1 FROM birbcrew_ts.native_stop_requests s WHERE
               (s.conversation_id,s.request_id,s.token)=(l.conversation_id,l.request_id,l.token))))
       ORDER BY p.approval_id`,
      [key.conversationId],
    );
    return result.rows.map((row) => {
      const call = publicApproval({ ...key, requestId: row.requestId }, row);
      return row.toolName === "choose_next_step" ? { ...call, choices: nextStep.options } : call;
    });
  }

  async previousDecision(input: Decision): Promise<Choice | null> {
    const key = decisionSchema.parse(input);
    return this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      const call = await findCall(db, key);
      if (!acceptsChoice(call.toolName, key.choice)) throw new MemberStoreError("conflict");
      if (call.version !== key.version || call.argumentDigest !== key.argumentDigest ||
          (call.choice && call.choice !== key.choice)) throw new MemberStoreError("conflict");
      if (!call.choice && (turn.phase !== "started" || call.childStopped || call.pastDeadline || call.expiredAt || await cancelled(db,key) ||
          (standingScope(key.choice) && !await grantable(db, { ...key, toolName: call.toolName })))) {
        throw new MemberStoreError("conflict");
      }
      if (!call.decision && call.live) {
        const closed = await db.query(`SELECT 1 FROM birbcrew_ts.codex_live_calls l JOIN birbcrew_ts.turns t USING (conversation_id,request_id)
          WHERE l.approval_id=$1 AND (l.phase <> 'waiting' OR t.phase <> 'started' OR l.expires_at <= clock_timestamp()
          OR EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests s WHERE
            (s.conversation_id,s.request_id,s.token)=(l.conversation_id,l.request_id,l.token)))`,[key.approvalId]);
        if (closed.rowCount) throw new MemberStoreError("conflict");
      }
      return call.choice;
    });
  }

  async decide(input: z.input<typeof decisionSchema>): Promise<Choice> {
    return this.transaction(db => this.decideLocked(db, decisionSchema.parse(input)));
  }

  /** Storing a choice appends the approval.decided audit row, and a standing choice also
   * grant.created, whose shared lock every owner's audit read waits on until commit. After it
   * returns, run only database statements and commit: await nothing outside the database. */
  async decideLocked(db: PoolClient, key: Decision, live = false): Promise<Choice> {
    const turn = await lockTurn(db, key);
    const call = await findCall(db, key);
    if (call.live !== live) throw new MemberStoreError("stale");
    if (!acceptsChoice(call.toolName, key.choice)) throw new MemberStoreError("conflict");
    if (call.version !== key.version || call.argumentDigest !== key.argumentDigest) throw new MemberStoreError("conflict");
    if (call.choice === key.choice) return call.choice;
    if (call.choice || turn.phase !== "started" || call.childStopped || call.pastDeadline || call.expiredAt || await cancelled(db, key)) {
      throw new MemberStoreError("conflict");
    }
    const scope = standingScope(key.choice);
    const target = { ...key, toolName: call.toolName };
    if (scope && !await grantable(db, target)) throw new MemberStoreError("conflict");
    // The statement checks the deadline again by its own clock. Under the conversation lock a
    // decision commits before the deadline or not at all, and expireTurn only after it.
    const accepted = await db.query(`UPDATE birbcrew_ts.deferred_calls SET decision=$2, grant_scope=$4 WHERE approval_id=$1
      AND (expires_at IS NULL OR expires_at > clock_timestamp()) AND expired_at IS NULL
      AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM birbcrew_ts.codex_live_calls l WHERE l.approval_id=$1
        AND l.phase='waiting' AND l.expires_at>clock_timestamp()))`, [key.approvalId, scope ? "approve" : key.choice, live, scope]);
    if (!accepted.rowCount) throw new MemberStoreError(live ? "stale" : "conflict");
    await publishObservation(db, key.conversationId, { kind: "answered", approvalId: key.approvalId });
    await appendAudit(db, { type: "approval.decided", ownerId: key.ownerId, memberId: key.memberId,
      conversationId: key.conversationId, requestId: key.requestId, payload: { approvalId: key.approvalId,
        invocationId: key.invocationId, toolName: call.toolName, argumentDigest: call.argumentDigest, choice: key.choice } });
    if (scope) await createGrant(db, target, scope);
    return key.choice;
  }

  async isCancelled(scope: Scope) {
    const key = scopeSchema.parse(scope);
    return this.transaction(async (db) => {
      await lockTurn(db, key);
      return cancelled(db, key);
    });
  }

  async cancelTurn(input: Scope): Promise<void> {
    const key = scopeSchema.parse(input);
    await this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      if (turn.engine === "codex") throw new MemberStoreError("stale");
      if (await cancelled(db, key)) return;
      if (turn.phase !== "started") throw new MemberStoreError("conflict");
      const segments = await db.query<{ resuming: boolean; answered: boolean }>(
        `SELECT s.resume_activity_id IS NOT NULL AS resuming,
           p.tool_name='choose_next_step' AND p.decision IS NOT NULL AS answered
         FROM birbcrew_ts.deferred_calls p LEFT JOIN birbcrew_ts.paused_segments s USING (approval_id)
         WHERE p.conversation_id=$1 AND p.request_id=$2`, [key.conversationId, key.requestId]);
      const segment = segments.rows[0];
      if (segment?.resuming) {
        await db.query("INSERT INTO birbcrew_ts.native_stop_requests VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [key.conversationId, key.requestId, turn.token]);
      } else if (segment?.answered) {
        throw new MemberStoreError("conflict");
      }
      await db.query("INSERT INTO birbcrew_ts.tool_cancellations (conversation_id, request_id) VALUES ($1,$2)",
        [key.conversationId, key.requestId]);
      await publishObservation(db, key.conversationId, { kind: "cancelled", requestId: key.requestId });
      const {rows} = await db.query<CallRow>(`SELECT ${columns}
        FROM birbcrew_ts.deferred_calls p JOIN birbcrew_ts.pi_children j USING (approval_id)
        WHERE p.conversation_id=$1 AND p.request_id=$2 AND j.phase IN ('waiting','resuming')`,
        [key.conversationId,key.requestId]);
      for (const call of rows) {
        await this.settleLocked(db,{...key,invocationId:call.invocationId,nativeCallId:call.nativeCallId,
          approvalId:call.approvalId,token:turn.token});
      }
      await appendAudit(db, { type: "request.cancellation_requested", ownerId: key.ownerId, memberId: key.memberId,
        conversationId: key.conversationId, requestId: key.requestId, payload: {} });
    });
  }

  /** Settles a card that reached its deadline with no decision. Its request is cancelled as an
   * owner's cancel would cancel it (tool_cancellations: the native call gets a cancelled result
   * and the conversation closes to new turns), and the card records that its deadline settled it.
   * Appends approval.expired, whose shared lock every owner's audit read waits on until commit. */
  async expireTurn(approval: Approval): Promise<Expiry> {
    const { ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId } = approval;
    const key = approvalKey.parse({ ownerId, memberId, conversationId, requestId, invocationId, nativeCallId, approvalId });
    return this.transaction(async (db) => {
      const turn = await lockTurn(db, key);
      const call = await findCall(db, key);
      if (call.expiredAt) return { kind: "expired" };
      if (!call.expiresAt || call.live) throw new MemberStoreError("conflict");
      if (call.choice || turn.phase !== "started" || await cancelled(db, key)) return { kind: "settled" };
      const { rows: [expired] } = await db.query<{ expiredAt: Date }>(`UPDATE birbcrew_ts.deferred_calls
        SET expired_at=clock_timestamp() WHERE approval_id=$1 AND decision IS NULL AND expired_at IS NULL
          AND expires_at <= clock_timestamp() RETURNING expired_at AS "expiredAt"`, [key.approvalId]);
      if (!expired) {
        const { rows: [left] } = await db.query<{ ms: number }>(`SELECT ceil(extract(epoch FROM expires_at - clock_timestamp())
          * 1000)::integer AS ms FROM birbcrew_ts.deferred_calls WHERE approval_id=$1`, [key.approvalId]);
        return { kind: "early", remainingMs: Math.max(left.ms, 1) };
      }
      await db.query("INSERT INTO birbcrew_ts.tool_cancellations (conversation_id, request_id) VALUES ($1,$2)",
        [key.conversationId, key.requestId]);
      const expiresAt = call.expiresAt.toISOString();
      await publishObservation(db, key.conversationId, { kind: "expired", requestId: key.requestId, approvalId: key.approvalId,
        expiresAt, expiredAt: expired.expiredAt.toISOString() });
      await appendAudit(db, { type: "approval.expired", ownerId: key.ownerId, memberId: key.memberId,
        conversationId: key.conversationId, requestId: key.requestId, payload: { approvalId: key.approvalId,
          invocationId: key.invocationId, toolName: call.toolName, expiresAt } });
      return { kind: "expired" };
    });
  }

  async closeChildApproval(db: PoolClient, key: Scope & { childId: string }, approvalId: string) {
    const approval = await confirmedApproval(db, { ...key, invocationId: key.childId, approvalId });
    const turn = await lockTurn(db, key);
    await publishObservation(db, key.conversationId, { kind: "answered", approvalId });
    await this.settleLocked(db, { ...approval, token: turn.token });
  }

  async settleConfirmed(approval: Approval): Promise<ToolOutcome> {
    const { ownerId, memberId, conversationId, requestId, approvalId, invocationId, nativeCallId } = approval;
    const { rows: [turn] } = await this.pool.query<{ token: string }>(
      `SELECT token FROM birbcrew_ts.turns JOIN birbcrew_ts.conversations USING (conversation_id)
       WHERE owner_id=$1 AND member_id=$2 AND conversation_id=$3 AND request_id=$4`,
      [ownerId, memberId, conversationId, requestId]);
    if (!turn) throw new MemberStoreError("not_found");
    return this.settle({ ownerId, memberId, conversationId, requestId, approvalId, invocationId, nativeCallId, token: turn.token });
  }

  async settle(input: z.input<typeof settleSchema>): Promise<ToolOutcome> {
    const key = settleSchema.parse(input);
    return this.transaction((db) => this.settleLocked(db, key));
  }

  /** May append the work_item.committed audit row, whose shared lock every owner's audit
   * read waits on until commit. After it returns, run only database statements and commit:
   * await nothing outside the database. */
  async settleLocked(db: PoolClient, key: z.infer<typeof settleSchema>, live = false): Promise<ToolOutcome> {
    const turn = await lockTurn(db, key);
    if (turn.token !== key.token) throw new MemberStoreError("stale");
    const call = await findCall(db, key);
    if (call.live !== live) throw new MemberStoreError("stale");
    const nativeCallId = key.nativeCallId;
    async function finish(outcome: ToolOutcome) {
      await publishObservation(db, key.conversationId, { kind: "result", approvalId: key.approvalId, outcome });
      return outcome;
    }
    if (call.toolName === "choose_next_step") {
      if (call.decision === "inspect" || call.decision === "test") return finish({ nativeCallId, kind: "answered", choice: call.decision });
      if (await cancelled(db, key)) return finish({ nativeCallId, kind: "cancelled" });
      throw new MemberStoreError("conflict");
    }
    if (call.budget_exhausted) return finish({ nativeCallId, kind: "budget_exhausted" });
    if (call.decision === "deny") return finish({ nativeCallId, kind: "denied" });
    const existing = await db.query<{ approval_id: string; receipt_id: string }>(
      "SELECT approval_id, receipt_id FROM birbcrew_ts.work_items WHERE conversation_id = $1 AND request_id = $2",
      [key.conversationId, key.requestId],
    );
    if (existing.rows[0]?.approval_id === key.approvalId) {
      return finish({ nativeCallId, kind: "recorded", receipt: { receiptId: existing.rows[0].receipt_id, operationId: key.requestId } });
    }
    if (call.childStopped || await cancelled(db, key)) return finish({ nativeCallId, kind: "cancelled" });
    if (call.decision !== "approve") throw new MemberStoreError("conflict");
    if (existing.rows.length) {
      await db.query("UPDATE birbcrew_ts.deferred_calls SET budget_exhausted = true WHERE approval_id = $1",
        [key.approvalId]);
      return finish({ nativeCallId, kind: "budget_exhausted" });
    }
    if (turn.phase !== "started") throw new MemberStoreError("stale");
    const inserted = await db.query<{ receipt_id: string }>(
      `INSERT INTO birbcrew_ts.work_items (conversation_id, request_id, approval_id, note)
       SELECT conversation_id, request_id, approval_id, arguments->>'note' FROM birbcrew_ts.deferred_calls
       WHERE approval_id = $1 AND decision = 'approve'
         AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM birbcrew_ts.codex_live_calls l
           WHERE l.approval_id=$1 AND l.phase='dispatching' AND l.expires_at>clock_timestamp())) RETURNING receipt_id`,
      [key.approvalId,live],
    );
    if (!inserted.rowCount) throw new MemberStoreError("stale");
    const receiptId = inserted.rows[0].receipt_id;
    const outcome = await finish({ nativeCallId, kind: "recorded", receipt: { receiptId, operationId: key.requestId } });
    await appendAudit(db, { type: "work_item.committed", ownerId: key.ownerId, memberId: key.memberId,
      conversationId: key.conversationId, requestId: key.requestId, payload: { receiptId, approvalId: key.approvalId } });
    return outcome;
  }
}
