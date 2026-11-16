import { matchesNativeReply, type ItemReceipt } from "./codex-items.ts";
import { interruptLiveLocked } from "./codex-calls.ts";
import { captureProjectNotes } from "./project-notes.ts";
import { requestNativeStop } from "./native-admission.ts";
import { textProjection } from "./text-stream.ts";
import { publishObservation } from "./observation.ts";
import type { ChildOutcome } from "@birbcrew/pi-subagents";
import { childrenFor } from "./children.ts";
import { savedProposal, type Approval } from "./approvals.ts";
import { appendAudit } from "./audit.ts";
import { firingConversation, firingInitiator } from "./routines.ts";
import { snapshotMemories } from "./memories.ts";
import { instructionsOf, packIdsOf, type InstructionsSummary } from "./instructions.ts";
import { attachPacks } from "./instruction-packs.ts";
import { handoffAdmission } from "./handoffs.ts";
import { budgetApplies, refuseOverBudget } from "./usage.ts";
import { ApplicationFailure } from "@temporalio/client";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import {
  checkpointSchema, claimSchema, commitSchema, conversationKey, executionSchema, initiatorColumns, initiatorFromColumns,
  MemberStoreError, openSchema, ownerInitiator, requestInitiator, spawnSchema, submitSchema, turnRequestSchema,
  type BeginTurn, type Conversation, type Member, type RequestInitiator, type TurnRequest,
} from "./domain.ts";

type SpawnedMember = Member & { instructions?: InstructionsSummary; instructionPacks?: string[] };
const memberColumns = `owner_id AS "ownerId", member_id AS "memberId", engine, profile`;
/** The spawn response, the same for the first spawn and its replays: the instructions summary and
 * the pack IDs only when the member has them. */
function spawnedMember(member: Member, stored: InstructionsSummary | null, packs: string[]): SpawnedMember {
  return { ...member, ...(stored ? { instructions: { bytes: stored.bytes, digest: stored.digest } } : {}),
    ...(packs.length ? { instructionPacks: packs } : {}) };
}

type ConversationKey = z.input<typeof conversationKey>;
type Claim = z.input<typeof claimSchema>;
type Execution = z.input<typeof executionSchema>;

type TurnRow = {
  phase: "started" | "uncertain" | "committed";
  prompt_digest: Buffer;
  workflow_run_id: string | null;
  activity_id: string | null;
  attempt: number;
  reply: string | null;
};

async function conversationFor(
  db: Pool | PoolClient, key: ConversationKey, lock: boolean,
): Promise<Conversation> {
  const result = await db.query<Conversation>(
    `SELECT c.owner_id AS "ownerId", c.conversation_id AS "conversationId",
            m.member_id AS "memberId", m.engine, m.profile
       FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING (owner_id, member_id)
      WHERE c.owner_id = $1 AND c.conversation_id = $2 ${lock ? "FOR UPDATE OF c" : ""}`,
    [key.ownerId, key.conversationId],
  );
  if (!result.rows.length) throw new MemberStoreError("not_found");
  if (lock && (await db.query("SELECT 1 FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1", [key.conversationId])).rowCount) {
    throw new MemberStoreError("conflict");
  }
  return result.rows[0];
}

/** A request's identity is equivalent only with the same exact text and approval deadline. */
function sameTerms(admission: { prompt_digest: Buffer; approval_deadline_seconds: number | null }, request: TurnRequest) {
  return admission.prompt_digest.equals(createHash("sha256").update(request.text).digest())
    && admission.approval_deadline_seconds === (request.approvalDeadlineSeconds ?? null);
}

/** recordAcceptance's checks of a request with no admission row that come before its member's
 * budget, in its order, inside the caller's transaction after it locked the conversation: a turn
 * a legacy submit already started, the conversation's request bound, a handoff's seal or
 * reservation, a routine firing's terms and the prompt bound. A refusal throws. Returns the
 * initiator an admission would record, and whether the request's turn already started. */
async function admissionTerms(db: PoolClient, key: TurnRequest, conversation: Conversation, attested: RequestInitiator) {
  const digest=createHash("sha256").update(key.text).digest();
  const {rows:[existingTurn]}=await db.query<{prompt_digest:Buffer}>(
    "SELECT prompt_digest FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",[key.conversationId,key.requestId]);
  if(existingTurn) {
    if(!existingTurn.prompt_digest.equals(digest))throw new MemberStoreError("conflict");
  } else {
    const {rows:[budget]}=await db.query<{limit:number;used:number}>(`SELECT turn_limit AS "limit",
      (SELECT count(*) FROM (SELECT request_id FROM birbcrew_ts.request_admissions WHERE conversation_id=$1
       UNION SELECT request_id FROM birbcrew_ts.turns WHERE conversation_id=$1) ids)::integer AS used
      FROM birbcrew_ts.conversations WHERE conversation_id=$1`,[key.conversationId]);
    if(budget.used>=budget.limit)throw new MemberStoreError("input_limit");
  }
  const handoff=existingTurn?null:await handoffAdmission(db,key);
  const recorded=handoff??await firingInitiator(db,key,conversation)??attested;
  if(recorded.kind!=="handoff")submitSchema.parse(key);
  return {recorded,started:Boolean(existingTurn)};
}

/** The initiator a request's admission recorded, read inside the caller's open transaction,
 * which has already checked that the conversation is its owner's (as proposeLocked's lockTurn
 * does). The trigger in 023-request-initiator.sql keeps it from changing, so no row lock is needed.
 * Null when the request has no admission row: one admitted by a workflow history older than
 * bounded-conversations-v1, before admissions were durable, or one Crew never admitted.
 * Null is not the owner: policy must decide it explicitly. Audit rows for such a request
 * record the owner, as before admissions recorded an initiator. */
export async function admittedInitiator(
  db: Pick<PoolClient, "query">, key: { conversationId: string; requestId: string },
): Promise<RequestInitiator | null> {
  const { rows: [row] } = await db.query<{ initiator_kind: string; initiator_id: string | null }>(
    "SELECT initiator_kind,initiator_id FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2",
    [key.conversationId, key.requestId]);
  return row ? initiatorFromColumns(row.initiator_kind, row.initiator_id) : null;
}

/** The member workflow's recordAcceptance activity. Only MemberClient issues that workflow's
 * acceptTurn and submitTurn updates, for the owner-authenticated gateway, the operator CLI
 * acting as the owner, the gateway's routine dispatcher and its handoff route, so the caller
 * attests the owner. recordAcceptance records a routine instead only when a routine firing row
 * names the request, and a handoff only for the request a handoff row reserved. The initiator
 * is not a workflow or update argument, so recorded histories replay unchanged.
 * A seal lifts only through a recovery restore, so retrying it only delays the failure the workflow reaches anyway; and a
 * request that reached admission ahead of its target's reserved one must not slip in once that
 * one is admitted. Either refusal fails at once. The workflow does not inspect why an activity
 * failed, and a failure is history data, not a command, so replay is unaffected. */
export function ownerAdmissionActivity(store: MemberStore) {
  return async (request: TurnRequest): Promise<void> => {
    try {
      await store.recordAcceptance(request, ownerInitiator);
    } catch (error) {
      if (error instanceof MemberStoreError && (error.code === "handed_off" || error.code === "handoff_pending")) {
        throw ApplicationFailure.nonRetryable(error.code);
      }
      // Retrying cannot change a budget refusal within the activity's deadline. MemberClient
      // reads this failure type back as usage_limit_closed.
      if (error instanceof MemberStoreError && error.code === "usage_limit") throw ApplicationFailure.nonRetryable("usage_limit", "usage_limit");
      throw error;
    }
  };
}

export class MemberStore {
  readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

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

  async migrate(): Promise<void> {
    await this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('birbcrew_ts.migration', 0))");
      await db.query("CREATE SCHEMA IF NOT EXISTS birbcrew_ts");
      await db.query("CREATE TABLE IF NOT EXISTS birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
      const migrations = [[1, "001-members.sql"], [2, "002-approvals.sql"], [3, "003-native-launches.sql"],
      [4, "004-observation.sql"], [5, "005-pi-children.sql"], [6, "006-open-text.sql"], [7, "007-native-stops.sql"], [8, "008-tool-previews.sql"], [9, "009-project-notes.sql"], [10, "010-next-step.sql"], [11, "011-codex-members.sql"], [12, "012-codex-calls.sql"], [13, "013-codex-item-receipts.sql"], [14, "014-trusted-context.sql"], [15, "015-trusted-receipt-authority.sql"], [16, "016-conversation-rollover.sql"], [17, "017-conversation-admissions.sql"], [18, "018-integration-cancellations.sql"], [19, "019-recovery.sql"], [20, "020-admission-reconciliation.sql"], [21, "021-audit.sql"], [22, "022-conversation-owner-index.sql"], [23, "023-request-initiator.sql"], [24, "024-standing-grants.sql"], [25, "025-routines.sql"], [26, "026-memories.sql"], [27, "027-handoffs.sql"], [28, "028-approval-expiry.sql"], [29, "029-member-instructions.sql"], [30, "030-audit-filters.sql"], [31, "031-usage.sql"], [32, "032-webhooks.sql"], [33, "033-instruction-packs.sql"], [34, "034-notification-formats.sql"], [35, "035-usage-cost.sql"], [36, "036-delegation-audit.sql"]] as const;
      // Number a new migration above every one already released.
      const { rows: [{ latest }] } = await db.query<{ latest: number | null }>("SELECT max(version) AS latest FROM birbcrew_ts.schema_versions");
      for (const [version, name] of migrations) {
        const applied = await db.query("SELECT 1 FROM birbcrew_ts.schema_versions WHERE version=$1", [version]);
        if (applied.rowCount) continue;
        // Migrations replace whole CHECK constraints, so one applied after a later one would
        // silently narrow what the later one allowed. Releases up to 26 shipped some out of
        // order (22 after 26), and those upgrades keep working.
        if (version > 26 && latest !== null && version < latest) throw new Error(`Migration ${version} would apply after migration ${latest}`);
        await db.query(await readFile(new URL("./sql/" + name, import.meta.url), "utf8"));
        await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [version]);
      }
    });
  }

  /** Instructions and instruction packs are written only here, in the member's own spawn
   * transaction (instructions.ts, instruction-packs.ts). A replay must repeat each exactly, or
   * leave it out exactly when the member has none. */
  async spawn(input: z.input<typeof spawnSchema>): Promise<SpawnedMember> {
    const { ownerId, requestId, engine, profile, instructions, instructionPacks = [] } = spawnSchema.parse(input);
    return this.transaction(async (db) => {
      const { rows: [created] } = await db.query<Member>(
        `INSERT INTO birbcrew_ts.members (owner_id, spawn_request_id, engine, profile)
         VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id, spawn_request_id) DO NOTHING RETURNING ${memberColumns}`,
        [ownerId, requestId, engine, profile],
      );
      if (created) {
        // This call made the member: it writes what it was given, then records it. Only
        // attachPacks reads a table it did not write (instruction_packs, to check and lock the
        // named packs), so a spawn without packs or instructions works on a database migrated
        // before them.
        if (instructions !== undefined) await db.query(
          "INSERT INTO birbcrew_ts.member_instructions (owner_id, member_id, body) VALUES ($1, $2, $3)",
          [ownerId, created.memberId, instructions]);
        if (instructionPacks.length) await attachPacks(db, created, instructionPacks, instructions);
        const stored = instructions === undefined ? null : await instructionsOf(db, created);
        await appendAudit(db, { type: "member.spawned", ownerId, memberId: created.memberId,
          payload: { spawnRequestId: requestId, engine, profile } });
        if (stored) await appendAudit(db, { type: "member.instructions_set", ownerId, memberId: created.memberId,
          payload: { digest: stored.digest, bytes: stored.bytes } });
        if (instructionPacks.length) await appendAudit(db, { type: "member.instruction_packs_attached", ownerId,
          memberId: created.memberId, payload: { packIds: instructionPacks } });
        return spawnedMember(created, stored, instructionPacks);
      }
      // A replay writes nothing, and must name exactly what the first spawn named.
      const { rows: [member] } = await db.query<Member>(
        `SELECT ${memberColumns} FROM birbcrew_ts.members WHERE owner_id = $1 AND spawn_request_id = $2`,
        [ownerId, requestId],
      );
      const stored = await instructionsOf(db, member);
      const packs = await packIdsOf(db, member);
      if (member.engine !== engine || member.profile !== profile || stored?.text !== instructions
        || packs.join() !== instructionPacks.join()) throw new MemberStoreError("conflict");
      return spawnedMember(member, stored, packs);
    });
  }

  openConversation(input: z.input<typeof openSchema>): Promise<Conversation> {
    const key = openSchema.parse(input);
    return this.transaction(db => this.openWithin(db, key));
  }

  /** openConversation inside the caller's transaction, which a handoff uses to open its target
   * with the same notes capture, memory snapshot and audit row. */
  async openWithin(db: PoolClient, input: z.input<typeof openSchema>): Promise<Conversation> {
    const key = openSchema.parse(input);
    const inserted = await db.query(
      `INSERT INTO birbcrew_ts.conversations (owner_id, member_id, conversation_id)
       SELECT owner_id, member_id, $3 FROM birbcrew_ts.members WHERE owner_id = $1 AND member_id = $2
       ON CONFLICT (conversation_id) DO NOTHING`,
      [key.ownerId, key.memberId, key.conversationId],
    );
    const conversation = await conversationFor(db, key, false);
    if (conversation.memberId !== key.memberId) throw new MemberStoreError("conflict");
    if (inserted.rowCount) {
      const capture = await captureProjectNotes(key.ownerId);
      if (capture) await db.query("INSERT INTO birbcrew_ts.conversation_notes (conversation_id,capture) VALUES ($1,$2)",
        [key.conversationId, JSON.stringify(capture)]);
      await snapshotMemories(db, conversation);
      const routineId = await firingConversation(db, key);
      await appendAudit(db, { type: "conversation.opened", ownerId: key.ownerId, memberId: key.memberId,
        conversationId: key.conversationId, payload: routineId ? { routineId } : {} });
    }
    return conversation;
  }

  getConversation(key: ConversationKey): Promise<Conversation> {
    return conversationFor(this.pool, conversationKey.parse(key), false);
  }

  async requestAdmission(input: z.input<typeof turnRequestSchema>): Promise<{phase:"accepted"|"rejected";reason:string|null}|undefined> {
    const key=turnRequestSchema.parse(input);
    const {rows:[row]}=await this.pool.query<{phase:"accepted"|"rejected";reason:string|null;prompt_digest:Buffer;approval_deadline_seconds:number|null}>(`
      SELECT a.phase,a.reason,a.prompt_digest,a.approval_deadline_seconds FROM birbcrew_ts.request_admissions a
      JOIN birbcrew_ts.conversations c USING(conversation_id)
      WHERE c.owner_id=$1 AND a.conversation_id=$2 AND a.request_id=$3`,[key.ownerId,key.conversationId,key.requestId]);
    if(!row)return undefined;
    if(!sameTerms(row,key))throw new MemberStoreError("conflict");
    return {phase:row.phase,reason:row.reason};
  }

  /** recordAcceptance's refusals of a new request, checked before MemberClient sends any workflow
   * update: the same refusal inside the workflow's admission activity fails the whole conversation.
   * recordAcceptance repeats them under the conversation's lock. The member's budget comes last,
   * so a request refused for another reason records no budget refusal. A handoff's reserved
   * request met its target's budget when the handoff committed (handoffs.ts) and is never
   * refused by it afterwards: a refusal then would strand a sealed source. */
  async checkAdmission(input: z.input<typeof turnRequestSchema>): Promise<void> {
    const key = turnRequestSchema.parse(input);
    await conversationFor(this.pool, key, false);
    if (await this.requestAdmission(key) !== undefined) return;
    const turn = await this.pool.query("SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",
      [key.conversationId, key.requestId]);
    if (turn.rowCount) return;
    if ((await handoffAdmission(this.pool, key))?.kind === "handoff") return;
    submitSchema.parse(key);
    if (!await budgetApplies(this.pool, key)) return;
    // The lock waits for an admission, turn start or handoff that holds the conversation, and
    // recordAcceptance's earlier checks run again under it, so a request refused under the budget
    // and audited as such is one admission would refuse for the budget alone.
    const refused = await this.transaction(async db => {
      await db.query("SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2 FOR KEY SHARE",
        [key.ownerId, key.conversationId]);
      // Read again under the lock: the trusted lane may have attached, or the budget been cleared.
      if (!await budgetApplies(db, key)) return false;
      const conversation = await conversationFor(db, key, false);
      const admitted = await db.query("SELECT 1 FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2",
        [key.conversationId, key.requestId]);
      if (admitted.rowCount) return false;
      const { recorded, started } = await admissionTerms(db, key, conversation, ownerInitiator);
      return !started && recorded.kind !== "handoff"
        && refuseOverBudget(db, key, conversation.memberId, recorded.kind === "routine" ? recorded.id : undefined);
    });
    if (refused) throw new MemberStoreError("usage_limit");
  }

  /** A replay of an admitted request keeps the initiator its first admission recorded. A routine
   * is recorded only from its firing row, and a handoff only from its own row for the request it
   * reserved, both read in this transaction; a caller cannot name either. Only that reserved
   * request may carry more than promptBytes. */
  async recordAcceptance(input: z.input<typeof turnRequestSchema>, initiator: RequestInitiator): Promise<void> {
    const key=turnRequestSchema.parse(input);
    const attested=requestInitiator.parse(initiator);
    if(attested.kind!=="owner")throw new MemberStoreError("conflict");
    const digest=createHash("sha256").update(key.text).digest();
    // A budget refusal commits its audit row, then refuses.
    const refused=await this.transaction(async db=>{
      const conversation=await conversationFor(db,key,true);
      const {rows:[prior]}=await db.query<{phase:"accepted"|"rejected";reason:string|null;prompt_digest:Buffer;approval_deadline_seconds:number|null}>(
        "SELECT phase,reason,prompt_digest,approval_deadline_seconds FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2",[key.conversationId,key.requestId]);
      if(prior){
        if(!sameTerms(prior,key))throw new MemberStoreError("conflict");
        if(prior.phase==="rejected")throw new MemberStoreError("request_rejected");
        return;
      }
      const {recorded,started}=await admissionTerms(db,key,conversation,attested);
      // A request whose turn already started (a legacy non-durable submit) is running, never refused,
      // and a handoff's reserved request met its target's budget when the handoff committed.
      if(!started&&recorded.kind!=="handoff"&&await refuseOverBudget(db,key,conversation.memberId,recorded.kind==="routine"?recorded.id:undefined))return true;
      const [initiatorKind,initiatorId]=initiatorColumns(recorded);
      await db.query(`INSERT INTO birbcrew_ts.request_admissions(conversation_id,request_id,prompt_digest,initiator_kind,initiator_id,approval_deadline_seconds)
        VALUES($1,$2,$3,$4,$5,$6)`,[key.conversationId,key.requestId,digest,initiatorKind,initiatorId,key.approvalDeadlineSeconds??null]);
      await appendAudit(db,{type:"request.accepted",ownerId:key.ownerId,memberId:conversation.memberId,
        conversationId:key.conversationId,requestId:key.requestId,payload:{promptDigest:digest.toString("hex")}});
    });
    if(refused)throw new MemberStoreError("usage_limit");
  }

  async rejectAccepted(input: z.input<typeof turnRequestSchema>, reason:"predecessor_failed"|"predecessor_cancelled"): Promise<void> {
    const key=turnRequestSchema.parse(input);
    if(reason!=="predecessor_failed"&&reason!=="predecessor_cancelled")throw new MemberStoreError("conflict");
    await this.transaction(async db=>{
      const conversation=await conversationFor(db,key,true);
      const result=await db.query(`UPDATE birbcrew_ts.request_admissions a SET phase='rejected',reason=$4
        WHERE conversation_id=$1 AND request_id=$2 AND prompt_digest=$3
        AND (phase='accepted' OR reason=$4)
        AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=a.conversation_id AND t.request_id=a.request_id)`,
        [key.conversationId,key.requestId,createHash("sha256").update(key.text).digest(),reason]);
      if(!result.rowCount)throw new MemberStoreError("conflict");
      await appendAudit(db,{type:"request.finished",ownerId:key.ownerId,memberId:conversation.memberId,conversationId:key.conversationId,
        requestId:key.requestId,payload:{status:reason==="predecessor_cancelled"?"cancelled":"failed",reason}});
    });
  }

  // Caller must have either an admission activity failure (with original text)
  // or a confirmed terminal logical workflow. Never infer this from a timeout.
  async rejectUnstartedAdmission(input: z.input<typeof turnRequestSchema> | {ownerId:string;conversationId:string;requestId:string}): Promise<void> {
    const parsed=turnRequestSchema.safeParse(input);
    const key=parsed.success?parsed.data:claimSchema.omit({token:true}).parse(input);
    const digest=parsed.success?createHash("sha256").update(parsed.data.text).digest():null;
    await this.transaction(async db=>{
      const conversation=await conversationFor(db,key,true);
      const rejected=await db.query(`UPDATE birbcrew_ts.request_admissions a SET phase='rejected',reason='admission_unconfirmed'
        WHERE conversation_id=$1 AND request_id=$2 AND phase='accepted'
        AND ($3::bytea IS NULL OR prompt_digest=$3)
        AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=a.conversation_id AND t.request_id=a.request_id)`,
        [key.conversationId,key.requestId,digest]);
      if(rejected.rowCount)await appendAudit(db,{type:"request.finished",ownerId:key.ownerId,memberId:conversation.memberId,
        conversationId:key.conversationId,requestId:key.requestId,payload:{status:"failed",reason:"admission_unconfirmed"}});
    });
  }

  async requestStatus(input: {ownerId:string;conversationId:string;requestId:string}) {
    const key=claimSchema.omit({token:true}).parse(input);
    await conversationFor(this.pool,key,false);
    const {rows:[row]}=await this.pool.query(`SELECT a.phase AS admission,a.reason,t.phase,t.reply
      FROM birbcrew_ts.request_admissions a FULL JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
      WHERE COALESCE(a.conversation_id,t.conversation_id)=$1 AND COALESCE(a.request_id,t.request_id)=$2`,[key.conversationId,key.requestId]);
    if(!row)throw new MemberStoreError("not_found");
    return {requestId:key.requestId,phase:row.admission==="rejected"?"rejected":row.phase??"accepted",
      ...(row.reason?{reason:row.reason}:{}),...(row.phase==="committed"?{reply:row.reply}:{})};
  }

  async conversationProgress(key: ConversationKey): Promise<{ turns: number; terminal: boolean; limit: number }> {
    const parsed = conversationKey.parse(key);
    const { rows: [row] } = await this.pool.query<{turns:number;terminal:boolean;limit:number}>(`
      SELECT count(t.request_id)::integer AS turns, c.turn_limit AS "limit",
        (count(t.request_id) >= c.turn_limit OR bool_or(t.phase='uncertain') OR
         EXISTS (SELECT 1 FROM birbcrew_ts.tool_cancellations x WHERE x.conversation_id=c.conversation_id)) AS terminal
      FROM birbcrew_ts.conversations c LEFT JOIN birbcrew_ts.turns t USING(conversation_id)
      WHERE c.owner_id=$1 AND c.conversation_id=$2 GROUP BY c.conversation_id`,
      [parsed.ownerId,parsed.conversationId]);
    if (!row) throw new MemberStoreError("not_found");
    return {...row, terminal: Boolean(row.terminal)};
  }

  async workflowRunId(key: ConversationKey): Promise<string | undefined> {
    const { rows: [turn] } = await this.pool.query<{ run: string | null }>(
      `SELECT t.workflow_run_id AS run
         FROM birbcrew_ts.turns t JOIN birbcrew_ts.conversations c USING (conversation_id)
        WHERE c.owner_id = $1 AND c.conversation_id = $2 AND t.position = 1`,
      [key.ownerId, key.conversationId],
    );
    return turn?.run ?? undefined;
  }

  async committedReply(input: z.input<typeof turnRequestSchema>): Promise<string | undefined> {
    const key = turnRequestSchema.parse(input);
    if((await this.requestAdmission(key))?.phase === "rejected")throw new MemberStoreError("request_rejected");
    const { rows: [turn] } = await this.pool.query<Pick<TurnRow, "prompt_digest" | "phase" | "reply">>(
      `SELECT t.prompt_digest, t.phase, t.reply
         FROM birbcrew_ts.turns t JOIN birbcrew_ts.conversations c USING (conversation_id)
        WHERE c.owner_id = $1 AND c.conversation_id = $2 AND t.request_id = $3`,
      [key.ownerId, key.conversationId, key.requestId],
    );
    if (!turn) return undefined;
    const digest = createHash("sha256").update(key.text, "utf8").digest();
    if (!turn.prompt_digest.equals(digest) || turn.phase === "uncertain") throw new MemberStoreError("conflict");
    return turn.reply ?? undefined;
  }

  async cancelGenerating(key: Pick<TurnRequest, "ownerId" | "conversationId" | "requestId">) {
    return this.transaction(async db => {
      const member = await conversationFor(db,key,true);
      const args = [key.conversationId,key.requestId];
      const {rows:[turn]} = await db.query<{token:string;phase:string}>(
        "SELECT token,phase FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",args);
      if (!turn || turn.phase !== "started") throw new MemberStoreError("conflict");
      const waiting = await db.query(`SELECT 1 FROM birbcrew_ts.paused_segments
        WHERE conversation_id=$1 AND request_id=$2 AND resume_activity_id IS NULL
        UNION ALL SELECT 1 FROM birbcrew_ts.delegations
        WHERE conversation_id=$1 AND request_id=$2 AND resume_activity_id IS NULL`, args);
      if (waiting.rowCount) return false;
      // Stop publication cannot wait for the SDK's shared grant on the turn row.
      await db.query("INSERT INTO birbcrew_ts.native_stop_requests VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[...args,turn.token]);
      const marked = await db.query("INSERT INTO birbcrew_ts.tool_cancellations VALUES ($1,$2) ON CONFLICT DO NOTHING",args);
      await publishObservation(db,key.conversationId,{kind:"cancelled",requestId:key.requestId});
      if (marked.rowCount) await appendAudit(db,{type:"request.cancellation_requested",ownerId:key.ownerId,memberId:member.memberId,
        conversationId:key.conversationId,requestId:key.requestId,payload:{}});
      return true;
    });
  }

  async reconcileTurn(input: z.input<typeof turnRequestSchema>, workflowRunId: string, resuming: boolean, allowRecovery = true) {
    const key = turnRequestSchema.parse(input);
    const digest = createHash("sha256").update(key.text).digest();
    await requestNativeStop(this.pool, key, { workflowRunId });
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const {rows:[admission]}=await db.query<{phase:string;prompt_digest:Buffer}>(
        "SELECT phase,prompt_digest FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2",[key.conversationId,key.requestId]);
      if(admission&&!admission.prompt_digest.equals(digest))throw new MemberStoreError("conflict");
      if(admission?.phase==="rejected")throw new MemberStoreError("request_rejected");
      const { rows: [turn] } = await db.query<TurnRow>(
        "SELECT reply, phase, prompt_digest, workflow_run_id FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2",
        [key.conversationId, key.requestId],
      );
      if (turn) {
        if (turn.workflow_run_id !== workflowRunId || !turn.prompt_digest.equals(digest)) {
          throw new MemberStoreError("conflict");
        }
        if (turn.reply !== null) return { kind: "complete", text: turn.reply } as const;
        if (!resuming && turn.phase === "started") {
          const children = await childrenFor(db, conversation, key.requestId);
          if (children.length) return {kind:"delegated" as const, children};
          const approval = await savedProposal(db, conversation, key.requestId);
          if (approval) return { kind: "pending", approval } as const;
        }
        await db.query("UPDATE birbcrew_ts.turns SET phase='uncertain' WHERE conversation_id=$1 AND request_id=$2",
          [key.conversationId, key.requestId]);
        if (!resuming && allowRecovery && conversation.engine === "claude") {
          const admitted = await db.query(`SELECT 1 FROM birbcrew_ts.native_launches n
            JOIN birbcrew_ts.turns t USING (conversation_id,request_id,token)
            JOIN birbcrew_ts.profiles p ON p.name=$3 AND p.engine='claude' AND (p.protected_tool='record_work_item' OR p.human_tool='choose_next_step')
            WHERE n.conversation_id=$1 AND n.request_id=$2 AND NOT n.recovery_closed
            AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2)`, [key.conversationId, key.requestId, conversation.profile]);
          if (admitted.rowCount) return { kind: "recover" } as const;
        }
      } else {
        await db.query(`INSERT INTO birbcrew_ts.turns
          (conversation_id,request_id,position,prompt_digest,phase,workflow_run_id,activity_id,attempt)
          SELECT $1,$2,coalesce(max(position),0)+1,$3,'uncertain',$4,'unadmitted',1
          FROM birbcrew_ts.turns WHERE conversation_id=$1`, [key.conversationId, key.requestId, digest, workflowRunId]);
      }
      await db.query("UPDATE birbcrew_ts.native_launches SET recovery_closed=true WHERE conversation_id=$1 AND request_id=$2",
        [key.conversationId, key.requestId]);
      if (conversation.engine === "codex") await interruptLiveLocked(db, key);
      const stopped = await db.query(`SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2
        AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND request_id=$2 AND NOT stopped)`,
        [key.conversationId,key.requestId]);
      await publishObservation(db, key.conversationId, { kind: stopped.rowCount ? "stopped" : "failed", requestId:key.requestId });
      // recovery_closed above makes this uncertain outcome final; the "recover" return is not.
      await appendAudit(db, { type: "request.finished", ownerId: key.ownerId, memberId: conversation.memberId,
        conversationId: key.conversationId, requestId: key.requestId, payload: { status: "uncertain" } });
      return null;
    });
  }

  async stoppedProposal(input: TurnRequest, workflowRunId: string) {
    const key = turnRequestSchema.parse(input);
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      if (conversation.engine !== "claude") return null;
      const { rows: [row] } = await db.query<{ token: string; stopped: boolean; phase: string; checkpoint: unknown }>(
        `SELECT t.token, n.stopped, t.phase, previous.checkpoint FROM birbcrew_ts.turns t
         JOIN birbcrew_ts.native_launches n USING (conversation_id,request_id,token)
         LEFT JOIN birbcrew_ts.turns previous ON previous.conversation_id=t.conversation_id AND previous.position=t.position-1
         WHERE t.conversation_id=$1 AND t.request_id=$2 AND t.workflow_run_id=$3 AND t.prompt_digest=$4 AND NOT n.recovery_closed
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.paused_segments s
             WHERE s.conversation_id=t.conversation_id AND s.request_id=t.request_id AND s.resume_activity_id IS NOT NULL)`,
        [key.conversationId, key.requestId, workflowRunId, createHash("sha256").update(key.text).digest()]);
      if (!row) return null;
      if (row.phase === "started") {
        const approval = await savedProposal(db, conversation, key.requestId);
        return approval ? { kind: "pending", approval } as const : null;
      }
      if (row.phase !== "uncertain") return null;
      if (!row.stopped) return { kind: "stopping" } as const;
      return { kind: "recover" as const, conversation, token: row.token,
        checkpoint: row.checkpoint === null ? null : checkpointSchema.parse(row.checkpoint) };
    });
  }

  async beginTurn(input: z.input<typeof turnRequestSchema>, identity?: Execution): Promise<BeginTurn> {
    const key = turnRequestSchema.parse(input);
    const execution = executionSchema.optional().parse(identity);
    const digest = createHash("sha256").update(key.text, "utf8").digest();
    if (execution && execution.attempt > 1) await requestNativeStop(this.pool, key, {
      workflowRunId: execution.workflowRunId,
      activityId: execution.activityId, beforeAttempt: execution.attempt
    });
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const {rows:[admission]}=await db.query<{phase:string;prompt_digest:Buffer}>(
        "SELECT phase,prompt_digest FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2",[key.conversationId,key.requestId]);
      if(admission&&!admission.prompt_digest.equals(digest))throw new MemberStoreError("conflict");
      if(admission?.phase==="rejected")throw new MemberStoreError("request_rejected");
      const { rows: [turn] } = await db.query<TurnRow>(
        `SELECT phase, prompt_digest, workflow_run_id, activity_id, attempt, reply
           FROM birbcrew_ts.turns WHERE conversation_id = $1 AND request_id = $2`,
        [key.conversationId, key.requestId],
      );
      if (turn) {
        if (!turn.prompt_digest.equals(digest)) throw new MemberStoreError("conflict");
        if (turn.reply !== null) return { kind: "replay", reply: turn.reply };
        if (turn.phase === "started") {
          const children = await childrenFor(db, conversation, key.requestId);
          if (children.length) return { kind: "delegated", children };
          const approval = await savedProposal(db, conversation, key.requestId);
          if (approval) return { kind: "pending", approval };
        }
        if (turn.phase === "started" && execution) {
          if (turn.workflow_run_id !== execution.workflowRunId || turn.activity_id !== execution.activityId
              || turn.attempt > execution.attempt) throw new MemberStoreError("stale");
          if (turn.attempt < execution.attempt) {
            await db.query(
              `UPDATE birbcrew_ts.turns SET phase = 'uncertain', attempt = $3
                WHERE conversation_id = $1 AND request_id = $2`,
              [key.conversationId, key.requestId, execution.attempt],
            );
          }
        }
        return { kind: "uncertain" };
      }
      const { rows: [last] } = await db.query<{ position: number; phase: string; checkpoint: unknown }>(
        `SELECT position, phase, checkpoint FROM birbcrew_ts.turns
          WHERE conversation_id = $1 ORDER BY position DESC LIMIT 1`,
        [key.conversationId],
      );
      if (last && last.phase !== "committed") throw new MemberStoreError("busy");
      const {rows:[budget]} = await db.query<{turn_limit:number}>(
        "SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id=$1", [key.conversationId]);
      if ((last?.position ?? 0) >= budget.turn_limit) throw new MemberStoreError("input_limit");
      const { rows: [{ token }] } = await db.query<{ token: string }>(
        `INSERT INTO birbcrew_ts.turns
           (conversation_id, request_id, prompt_digest, position, phase, workflow_run_id, activity_id, attempt)
         VALUES ($1, $2, $3, $4, 'started', $5, $6, $7) RETURNING token`,
        [key.conversationId, key.requestId, digest, (last?.position ?? 0) + 1,
          execution?.workflowRunId ?? null, execution?.activityId ?? null, execution?.attempt ?? 1],
      );
      await publishObservation(db, key.conversationId, { kind: "input", requestId: key.requestId, text: key.text });
      return { kind: "start", conversation, token, checkpoint: last ? checkpointSchema.parse(last.checkpoint) : null };
    });
  }

  async beginResume(request: TurnRequest, approval: Approval | null, execution: Execution) {
    const key = turnRequestSchema.parse(request);
    if (execution && execution.attempt > 1) await requestNativeStop(this.pool, key, {
      workflowRunId: execution.workflowRunId,
      activityId: execution.activityId, beforeAttempt: execution.attempt
    });
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const args = [key.conversationId, key.requestId];
      const paused = approval
        ? "SELECT checkpoint,resume_activity_id FROM birbcrew_ts.paused_segments WHERE conversation_id=$1 AND request_id=$2 AND approval_id=$3"
        : "SELECT parent_checkpoint AS checkpoint,resume_activity_id FROM birbcrew_ts.delegations WHERE conversation_id=$1 AND request_id=$2";
      const { rows: [turn] } = await db.query<TurnRow & {
        checkpoint: unknown; resume_activity_id: string | null;
      }>(`SELECT t.*,s.checkpoint,s.resume_activity_id FROM birbcrew_ts.turns t CROSS JOIN (${paused}) s
          WHERE t.conversation_id=$1 AND t.request_id=$2`, approval ? [...args, approval.approvalId] : args);
      if (!turn || !turn.prompt_digest.equals(createHash("sha256").update(key.text).digest()) ||
          turn.workflow_run_id !== execution.workflowRunId) throw new MemberStoreError("stale");
      if (turn.phase === "committed" && turn.reply !== null) return { kind: "replay" as const, reply: turn.reply };
      if (turn.phase === "uncertain") return { kind: "uncertain" as const };
      if (turn.resume_activity_id !== null) {
        if (turn.resume_activity_id !== execution.activityId || turn.attempt > execution.attempt) {
          throw new MemberStoreError("stale");
        }
        if (turn.attempt < execution.attempt) {
          await db.query("UPDATE birbcrew_ts.turns SET phase='uncertain',attempt=$3 WHERE conversation_id=$1 AND request_id=$2",
            [key.conversationId, key.requestId, execution.attempt]);
        }
        return { kind: "uncertain" as const };
      }
      // Pre-effect cancellation still delivers its native tool result. A committed receipt survives a stopped turn.
      const { rows: [grant] } = await db.query<{token: string}>(
        `UPDATE birbcrew_ts.turns SET token=gen_random_uuid(),activity_id=$3,attempt=$4
         WHERE conversation_id=$1 AND request_id=$2 AND NOT EXISTS (
           SELECT 1 FROM birbcrew_ts.work_items w JOIN birbcrew_ts.tool_cancellations USING (conversation_id,request_id)
           WHERE w.approval_id=$5
         ) RETURNING token`,
        [key.conversationId, key.requestId, execution.activityId, execution.attempt, approval?.approvalId ?? null]);
      if (!grant) throw new MemberStoreError("stale");
      const { token } = grant;
      let childResults: ChildOutcome[] | undefined;
      if (approval) {
        await db.query("UPDATE birbcrew_ts.paused_segments SET resume_activity_id=$2 WHERE approval_id=$1",
          [approval.approvalId, execution.activityId]);
        await publishObservation(db,key.conversationId,{kind:"resume",approvalId:approval.approvalId});
      } else {
        const { rows } = await db.query<{ outcome: ChildOutcome | null }>(
          "SELECT outcome FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2 ORDER BY ordinal", args);
        childResults = rows.map(({ outcome }) => {
          if (!outcome) throw new MemberStoreError("busy");
          return outcome;
        });
        if (!childResults.length) throw new MemberStoreError("not_found");
        await db.query("UPDATE birbcrew_ts.delegations SET resume_activity_id=$3 WHERE conversation_id=$1 AND request_id=$2",
          [...args, execution.activityId]);
      }
      return { kind: "start" as const, token, conversation, checkpoint: checkpointSchema.parse(turn.checkpoint), childResults };
    });
  }

  async previewTool(claim: Claim & {childId?:string}, nativeCallId: string, matchedOperation = false) {
    await this.transaction(async (db) => {
      await conversationFor(db, { ownerId: claim.ownerId, conversationId: claim.conversationId }, true);
      const { rows: [preview] } = await db.query<{ public_id: string }>(`INSERT INTO birbcrew_ts.tool_previews AS p
        (conversation_id,request_id,invocation_id,native_call_id,generation)
        SELECT n.conversation_id,n.request_id,COALESCE(n.child_id,t.request_id),$4,n.token
          FROM birbcrew_ts.native_launches n JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
          LEFT JOIN birbcrew_ts.pi_children j ON j.child_id=n.child_id
         WHERE n.conversation_id=$1 AND n.request_id=$2 AND n.token=$3 AND n.child_id IS NOT DISTINCT FROM $5::uuid
           AND t.phase='started' AND NOT n.stopped AND
           ((n.child_id IS NULL AND t.token=n.token) OR (j.generation=n.token AND j.phase='running' AND NOT j.launch_revoked))
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)
        ON CONFLICT (conversation_id,request_id,invocation_id) DO UPDATE SET public_id=p.public_id
        WHERE p.native_call_id=EXCLUDED.native_call_id AND p.generation=EXCLUDED.generation RETURNING public_id`,
        [claim.conversationId, claim.requestId, claim.token, nativeCallId, claim.childId ?? null]);
      if (!preview) throw new MemberStoreError("stale");
      await publishObservation(db, claim.conversationId, { kind: "toolPreview", invocationId: claim.childId ?? claim.requestId, publicId: preview.public_id });
      if (matchedOperation) await publishObservation(db, claim.conversationId, {
        kind: "toolValue", invocationId: claim.childId ?? claim.requestId, publicId: preview.public_id, requestId: claim.requestId,
      });
    });
  }

  async appendText(claim: Claim & { childId?: string }, messageId: string, index: number, delta: string) {
    await this.transaction(async (db) => {
      await conversationFor(db, { ownerId: claim.ownerId, conversationId: claim.conversationId }, true);
      const args = [claim.conversationId,claim.requestId,claim.token];
      const active = claim.childId
        ? await db.query(`SELECT 1 FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2 AND generation=$3
           AND child_id=$4 AND phase IN ('running','resuming') AND NOT launch_revoked
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)`, [...args,claim.childId])
        : await db.query(`SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2 AND token=$3 AND phase='started'
           AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)`, args);
      if (!active.rowCount) throw new MemberStoreError("stale");
      await publishObservation(db, claim.conversationId, { kind:"text", messageId,index,delta,childId:claim.childId });
    });
  }

  async appendCodexItem(claim: Claim, index: number, text: string, receipt: ItemReceipt) {
    await this.transaction(async db => {
      const member = await conversationFor(db, claim, true);
      if (member.engine !== "codex") throw new MemberStoreError("conflict");
      const current = await db.query("SELECT 1 FROM birbcrew_ts.turns t WHERE conversation_id=$1 AND request_id=$2 AND token=$3 AND phase='started' " +
        "AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.native_stop_requests WHERE conversation_id=$1 AND request_id=$2 AND token=$3)",
        [claim.conversationId, claim.requestId, claim.token]);
      if (!current.rowCount) throw new MemberStoreError("stale");
      const saved = await db.query(`INSERT INTO birbcrew_ts.codex_item_receipts AS r
        (conversation_id,request_id,ordinal,bytes,digest) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (conversation_id,request_id,ordinal) DO UPDATE SET digest=r.digest
          WHERE r.bytes=EXCLUDED.bytes AND r.digest=EXCLUDED.digest`,
        [claim.conversationId,claim.requestId,index,receipt.bytes,receipt.digest]);
      if (!saved.rowCount) throw new MemberStoreError("conflict");
      await publishObservation(db,claim.conversationId,{kind:"nativeItem",requestId:claim.requestId,index,text});
    });
  }

  async commitTurn(input: Claim & { checkpoint: unknown; reply: string }): Promise<string> {
    const key = commitSchema.parse(input);
    return this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      if (key.checkpoint.engine !== conversation.engine) throw new MemberStoreError("conflict");
      const args = [key.conversationId, key.requestId, key.token, key.reply, JSON.stringify(key.checkpoint)];
      const update = await db.query(
        `UPDATE birbcrew_ts.turns SET phase = 'committed', reply = $4, checkpoint = $5
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase = 'started'`, args,
      );
      if (update.rowCount) {
        const receipts = conversation.engine === "codex" ? (await db.query<ItemReceipt & {ordinal:number}>(
          "SELECT ordinal,bytes,digest FROM birbcrew_ts.codex_item_receipts WHERE conversation_id=$1 AND request_id=$2 ORDER BY ordinal",
          [key.conversationId,key.requestId])).rows : [];
        if (receipts.length && !matchesNativeReply(key.reply, receipts)) throw new MemberStoreError("conflict");
        const content = receipts.length ? {itemCount:receipts.length} : {text:(await textProjection(db, key.conversationId))(key.reply,true)};
        const cancelled = await db.query("SELECT 1 FROM birbcrew_ts.tool_cancellations WHERE conversation_id=$1 AND request_id=$2",
          [key.conversationId,key.requestId]);
        await publishObservation(db, key.conversationId, { kind: "reply", requestId: key.requestId, ...content, cancelled:!!cancelled.rowCount });
        await appendAudit(db, { type: "request.finished", ownerId: key.ownerId, memberId: conversation.memberId,
          conversationId: key.conversationId, requestId: key.requestId, payload: { status: "completed" } });
        return key.reply;
      }
      const replay = await db.query<{ reply: string }>(
        `SELECT reply FROM birbcrew_ts.turns
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase = 'committed'
            AND reply = $4 AND checkpoint = $5::jsonb`, args,
      );
      if (replay.rows.length) return replay.rows[0].reply;
      throw new MemberStoreError("stale");
    });
  }

  async markUncertain(input: Claim): Promise<void> {
    const key = claimSchema.parse(input);
    await requestNativeStop(this.pool, key, { token: key.token });
    await this.transaction(async (db) => {
      const conversation = await conversationFor(db, key, true);
      const result = await db.query(
        `UPDATE birbcrew_ts.turns SET phase = 'uncertain'
          WHERE conversation_id = $1 AND request_id = $2 AND token = $3 AND phase IN ('started', 'uncertain')`,
        [key.conversationId, key.requestId, key.token],
      );
      if (!result.rowCount) throw new MemberStoreError("stale");
      if (conversation.engine === "codex") await interruptLiveLocked(db, key, key.token);
      await publishObservation(db, key.conversationId, { kind: "failed", requestId: key.requestId });
    });
  }
}
