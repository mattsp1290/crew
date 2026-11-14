import { z } from "zod";
import { serverRequestReceiptSchema, type ServerRequestReceipt } from "@birbcrew/client/contract";
import { actorKinds, appendAudit, auditEventTypes, auditFilterNames, auditLimits } from "./audit.ts";
import type { MemberClient } from "./client.ts";
import { approvalDeadline, initiatorColumns, initiatorFromColumns, initiatorKinds, MemberStoreError, ownerInitiator, submitSchema,
  turnKey, type Engine } from "./domain.ts";
import { standingChoice } from "./deferral.ts";
import { grantListLimit } from "./grants.ts";
import { handoffCapabilities } from "./handoffs.ts";
import { conversationTurnLimit, workflowGenerationTurnLimit } from "./limits.ts";
import { memoryCapabilities } from "./memories.ts";
import { instructionsCapabilities, instructionsSummarySql, type InstructionsSummary } from "./instructions.ts";
import { packCapabilities } from "./instruction-packs.ts";
import { routineCapabilities } from "./routines.ts";
import type { MemberStore } from "./store.ts";
import { webhookCapabilities } from "./webhooks.ts";
import { usageCapabilities } from "./usage.ts";

const listDefaultLimit = 50, listMaximumLimit = 100;

export const integrationCapabilities = {
  apiVersion: "1",
  requestContract: "sql-admission-temporal-queue-v1",
  identity: "owner/conversation/request UUID; exact UTF-8 text equivalence",
  cancellation: "durable-intent-v1",
  retention: "receipts-and-results-retained-with-database; no-automatic-TTL",
  rollover: { version: 1, maximumTurns: conversationTurnLimit, generationTurns: workflowGenerationTurnLimit },
  proxy: { version: 1, protocols: ["anthropic-messages", "openai-responses", "openai-chat-completions"] },
  trustedContext: { version: 1, transport: "operator-configured-local-runtime", httpSubmission: false },
  initiatorKinds,
  observation: { version: 1, protocol: "AG-UI", mode: "snapshot-and-bounded-tail", cursorExpiry: "reconnect-for-snapshot" },
  health: { version: 1, dependencies: ["database", "temporal"] },
  listing: { version: 1, resources: ["members", "conversations"], defaultLimit: listDefaultLimit, maximumLimit: listMaximumLimit },
  audit: {
    version: 1, route: "/v1/audit", eventTypes: auditEventTypes, pagination: "event-id-keyset-no-skipped-commits",
    formats: ["json", "csv"], limits: auditLimits, retention: "append-only-with-database; no-automatic-TTL",
    filters: auditFilterNames, actorKinds,
  },
  routines: routineCapabilities,
  standingGrants: {
    version: 1, choices: standingChoice.options, cardField: "standingChoices", stateField: "grantedCalls", tools: ["record_work_item"], policyVersion: 1,
    initiatorKinds: ["owner"], route: "/v1/members/{memberId}/grants", inactiveListLimit: grantListLimit,
    revocation: "later-proposals-only",
  },
  memories: memoryCapabilities,
  handoffs: handoffCapabilities,
  approvalExpiry: {
    version: 1, field: "approvalDeadlineSeconds", routes: ["/v1/conversations/{conversationId}/requests", "/v1/routines"],
    minimumSeconds: approvalDeadline.minimumSeconds, maximumSeconds: approvalDeadline.maximumSeconds,
    engines: ["claude", "pi"], cardField: "expiresAt", stateField: "expiredCalls", receiptField: "expiredApproval",
    outcome: "request-cancelled", auditEvent: "approval.expired", firingReason: "approval_expired",
    codex: "earlier-of-live-and-request-deadline", piChildCards: "not-covered",
  },
  memberInstructions: instructionsCapabilities,
  usage: usageCapabilities,
  webhooks: webhookCapabilities,
  instructionPacks: packCapabilities,
} as const;

type Listing = "member" | "conversation";
// Opaque keyset position: the last returned identifier, tagged by listing. It is only
// compared, never looked up, so another owner's identifier confirms nothing.
const encodeAfter = (kind: Listing, id: string) => Buffer.from(kind + ":" + id).toString("base64url");
// Cursors carry PostgreSQL's lowercase uuid output, so the same rule as memberId plus that case.
const listedId = z.uuid().refine(id => id === id.toLowerCase());
function decodeAfter(kind: Listing, value: string) {
  const id = Buffer.from(value, "base64url").toString("utf8").slice(kind.length + 1);
  return listedId.safeParse(id).success && encodeAfter(kind, id) === value ? id : undefined;
}
const after = (kind: Listing) => z.string().max(128).refine(value => decodeAfter(kind, value) !== undefined)
  .transform(value => decodeAfter(kind, value)!).optional();
const limit = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(listMaximumLimit)).default(listDefaultLimit);
const memberListQuery = z.strictObject({ limit, after: after("member") });
const conversationListQuery = memberListQuery.extend({
  after: after("conversation"), memberId: z.uuid().transform(value => value.toLowerCase()).optional(),
});

function page<T>(kind: Listing, rows: T[], size: number, id: (row: T) => string) {
  return { items: rows.slice(0, size), next: rows.length > size ? encodeAfter(kind, id(rows[size - 1])) : null };
}

const keySchema = turnKey;
type Key = z.infer<typeof keySchema>;
export type { ServerRequestReceipt } from "@birbcrew/client/contract";
export class ReceiptContractError extends Error {
  constructor() { super("Request receipt violates the public contract"); this.name = "ReceiptContractError"; }
}
type Status = ServerRequestReceipt["status"];

/** Public contract adapter; no SDK or Temporal internals are exposed to HTTP consumers. */
export class IntegrationApi {
  readonly store: MemberStore;
  readonly members: Pick<MemberClient, "accept" | "cancelPending" | "requestStatus">;
  private readonly delivering = new Set<string>();
  private scanning = false;

  constructor(store: MemberStore, members: Pick<MemberClient, "accept" | "cancelPending" | "requestStatus">) {
    this.store = store;
    this.members = members;
  }

  async submit(input: unknown): Promise<ServerRequestReceipt> {
    const request = submitSchema.parse(input);
    // Unlike the legacy ACCEPTED stage, acceptTurn waits for SQL admission.
    // On lost acknowledgement the caller must reconcile, never choose a new UUID.
    await this.members.accept(request);
    return this.status({ ownerId: request.ownerId, conversationId: request.conversationId, requestId: request.requestId });
  }

  async status(input: unknown): Promise<ServerRequestReceipt> {
    const key = keySchema.parse(input);
    // Reconcile an accepted/no-turn receipt against a terminal logical workflow.
    // This observes Temporal only: it never starts a workflow or dispatches inference.
    await this.members.requestStatus(key);
    const { rows: [row] } = await this.store.pool.query<{
      admission: string | null; reason: string | null; initiator_kind: string | null; initiator_id: string | null;
      phase: string | null; reply: string | null; receipt_id: string | null; delivered_at: Date | null; stopped: boolean; waiting: boolean;
      approval_deadline_seconds: number | null; expired_id: string | null; expires_at: Date | null; expired_at: Date | null;
    }>(`SELECT a.phase AS admission,a.reason,a.initiator_kind,a.initiator_id,t.phase,t.reply,x.receipt_id,x.delivered_at,
       a.approval_deadline_seconds,e.approval_id AS expired_id,e.expires_at,e.expired_at,
       EXISTS(SELECT 1 FROM birbcrew_ts.deferred_calls d WHERE d.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND d.request_id=COALESCE(a.request_id,t.request_id) AND d.decision IS NULL AND d.expired_at IS NULL) AS waiting,
       (EXISTS(SELECT 1 FROM birbcrew_ts.tool_cancellations tc WHERE tc.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND tc.request_id=COALESCE(a.request_id,t.request_id))
        AND EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND n.request_id=COALESCE(a.request_id,t.request_id))
        AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND n.request_id=COALESCE(a.request_id,t.request_id) AND NOT n.stopped)) AS stopped
       FROM birbcrew_ts.request_admissions a FULL JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
       JOIN birbcrew_ts.conversations c ON c.conversation_id=COALESCE(a.conversation_id,t.conversation_id)
       LEFT JOIN birbcrew_ts.integration_cancellations x ON x.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND x.request_id=COALESCE(a.request_id,t.request_id)
       LEFT JOIN LATERAL (SELECT d.approval_id,d.expires_at,d.expired_at FROM birbcrew_ts.deferred_calls d
         WHERE d.conversation_id=COALESCE(a.conversation_id,t.conversation_id) AND d.request_id=COALESCE(a.request_id,t.request_id)
           AND d.expired_at IS NOT NULL LIMIT 1) e ON true
       WHERE c.owner_id=$1 AND COALESCE(a.conversation_id,t.conversation_id)=$2 AND COALESCE(a.request_id,t.request_id)=$3`,
      [key.ownerId,key.conversationId,key.requestId]);
    if (!row) throw new MemberStoreError("not_found");
    // A cancellation intent never overwrites the committed winner or claims rollback.
    const status: Status = row.phase === "committed" ? "completed"
      : row.admission === "rejected" ? (row.reason === "predecessor_cancelled" ? "cancelled" : "failed")
      : row.phase === "uncertain" ? "uncertain"
      : row.receipt_id ? "cancellation_requested"
      : row.waiting ? "waiting" : row.phase === "started" ? "running" : "accepted";
    const receipt = serverRequestReceiptSchema.safeParse({
      apiVersion: "1", conversationId: key.conversationId, requestId: key.requestId,
      acceptance: { boundary: "sql_admission_and_temporal_queue" }, status,
      ...(row.initiator_kind ? { initiator: initiatorFromColumns(row.initiator_kind, row.initiator_id) } : {}),
      ...(row.phase === "committed" ? { result: { text: row.reply! } } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.receipt_id ? { cancellation: {
        receiptId: row.receipt_id, delivery: row.delivered_at ? "delivered" as const : "pending" as const,
        nativeTermination: row.stopped ? "confirmed" as const : "unconfirmed" as const, effects: "not_assessed" as const,
      } } : {}),
      ...(row.approval_deadline_seconds !== null ? { approvalDeadlineSeconds: row.approval_deadline_seconds } : {}),
      ...(row.expired_id ? { expiredApproval: { approvalId: row.expired_id, expiresAt: row.expires_at!.toISOString(),
        expiredAt: row.expired_at!.toISOString() } } : {}),
    });
    if (!receipt.success) throw new ReceiptContractError();
    return receipt.data;
  }

  /** `policy` marks an intent a routine's fail_closed policy requested rather than the owner. */
  async cancel(input: unknown, policy?: "fail_closed"): Promise<ServerRequestReceipt> {
    const key = keySchema.parse(input);
    // Backfill active legacy turns created after migration17, without inventing an
    // admission for an unknown UUID or accepting a new payload. Such turns come from
    // workflow histories older than durable admission, which only the owner could start.
    await this.store.pool.query(`INSERT INTO birbcrew_ts.request_admissions(conversation_id,request_id,prompt_digest,initiator_kind,initiator_id)
      SELECT t.conversation_id,t.request_id,t.prompt_digest,$4,$5 FROM birbcrew_ts.turns t
      JOIN birbcrew_ts.conversations c USING(conversation_id)
      WHERE c.owner_id=$1 AND t.conversation_id=$2 AND t.request_id=$3
      ON CONFLICT(conversation_id,request_id) DO NOTHING`, [key.ownerId,key.conversationId,key.requestId,...initiatorColumns(ownerInitiator)]);
    // Atomic ownership check and FK admission requirement. Repeated intent has one receipt.
    await this.store.transaction(async db => {
      // Lock the conversation first, like every workflow-side canceller; inserting the
      // shared audit key before this lock can deadlock against them.
      const { rows: [conversation] } = await db.query<{ member_id: string }>(
        "SELECT member_id FROM birbcrew_ts.conversations WHERE conversation_id=$1 AND owner_id=$2 FOR KEY SHARE",
        [key.conversationId,key.ownerId]);
      if (!conversation) return;
      const { rows: [intent] } = await db.query<{ receipt_id: string }>(`INSERT INTO birbcrew_ts.integration_cancellations(conversation_id,request_id)
        SELECT a.conversation_id,a.request_id FROM birbcrew_ts.request_admissions a
        JOIN birbcrew_ts.conversations c USING(conversation_id)
        WHERE c.owner_id=$1 AND a.conversation_id=$2 AND a.request_id=$3
        ON CONFLICT(conversation_id,request_id) DO NOTHING RETURNING receipt_id`, [key.ownerId,key.conversationId,key.requestId]);
      if (intent) await appendAudit(db, { type: "request.cancellation_requested", ownerId: key.ownerId, memberId: conversation.member_id,
        conversationId: key.conversationId, requestId: key.requestId, payload: { receiptId: intent.receipt_id, ...(policy && { policy }) } });
    });
    return this.status(key);
  }

  /** Owner-scoped keyset page in identifier order; backed by members UNIQUE (owner_id, member_id). */
  async listMembers(ownerId: string, query: unknown) {
    const { limit, after } = memberListQuery.parse(query);
    const { rows } = await this.store.pool.query<{ memberId: string; engine: Engine; profile: string; instructions: InstructionsSummary | null;
      instructionPacks: string[] | null }>(
      `SELECT m.member_id AS "memberId",m.engine,m.profile,
         CASE WHEN i.member_id IS NOT NULL THEN ${instructionsSummarySql} END AS instructions,
         (SELECT array_agg(a.pack_id::text ORDER BY a.position) FROM birbcrew_ts.member_instruction_packs a
           WHERE a.owner_id=m.owner_id AND a.member_id=m.member_id) AS "instructionPacks"
       FROM birbcrew_ts.members m LEFT JOIN birbcrew_ts.member_instructions i ON i.owner_id=m.owner_id AND i.member_id=m.member_id
       WHERE m.owner_id=$1 AND ($2::uuid IS NULL OR m.member_id>$2) ORDER BY m.member_id LIMIT $3`,
      [ownerId, after ?? null, limit + 1]);
    const { items, next } = page("member", rows, limit, row => row.memberId);
    // Never the text: only GET /v1/members/{memberId}/instructions returns it. Pack IDs, in order.
    const members = items.map(({ instructions, instructionPacks, ...member }) => ({ ...member, ...(instructions ? { instructions } : {}),
      ...(instructionPacks ? { instructionPacks } : {}) }));
    return { apiVersion: "1" as const, members, next };
  }

  /**
   * Coarse snapshot phase only; never message text. Phase is null where the snapshot reports history_unavailable.
   * Backed by the owner indexes from migration 022, one per query shape.
   */
  async listConversations(ownerId: string, query: unknown) {
    const { limit, after, memberId } = conversationListQuery.parse(query);
    // Keep unnamed (no `name:`): PostgreSQL plans unnamed statements with the actual values, so the 022 indexes seek on memberId and the cursor; a generic plan seeks on owner_id alone.
    const { rows } = await this.store.pool.query<{ conversationId: string; memberId: string; engine: Engine; profile: string; phase: string | null }>(
      `SELECT c.conversation_id AS "conversationId",c.member_id AS "memberId",m.engine,m.profile,
         CASE WHEN s.conversation_id IS NULL THEN 'idle' WHEN s.history_complete THEN s.state->>'phase' END AS phase
       FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING (owner_id,member_id)
       LEFT JOIN birbcrew_ts.public_snapshots s USING (conversation_id)
       WHERE c.owner_id=$1 AND ($2::uuid IS NULL OR c.member_id=$2) AND ($3::uuid IS NULL OR c.conversation_id>$3)
       ORDER BY c.conversation_id LIMIT $4`,
      [ownerId, memberId ?? null, after ?? null, limit + 1]);
    const { items, next } = page("conversation", rows, limit, row => row.conversationId);
    return { apiVersion: "1" as const, conversations: items, next };
  }

  /** Restart-safe delivery outbox. Reads never call this; gateway invokes it on a timer. */
  async flushCancellations(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { rows } = await this.store.pool.query<Key>(`SELECT c.owner_id AS "ownerId",x.conversation_id AS "conversationId",x.request_id AS "requestId"
        FROM birbcrew_ts.integration_cancellations x JOIN birbcrew_ts.conversations c USING(conversation_id)
        WHERE x.delivered_at IS NULL ORDER BY x.last_attempt_at NULLS FIRST,x.requested_at LIMIT 64`);
      await Promise.all(rows.map(async key => {
        const id = `${key.conversationId}/${key.requestId}`;
        if (this.delivering.has(id)) return;
        this.delivering.add(id);
        try {
          await this.store.pool.query(`UPDATE birbcrew_ts.integration_cancellations SET last_attempt_at=clock_timestamp()
            WHERE conversation_id=$1 AND request_id=$2`, [key.conversationId,key.requestId]);
          const receipt = await this.status(key);
          if (!["completed", "failed", "cancelled"].includes(receipt.status)) await this.members.cancelPending(key, Date.now() + 10_000);
          await this.store.pool.query(`UPDATE birbcrew_ts.integration_cancellations SET delivered_at=COALESCE(delivered_at,clock_timestamp())
            WHERE conversation_id=$1 AND request_id=$2`, [key.conversationId,key.requestId]);
        } catch {
          // A failed/ambiguous delivery remains pending and is retried with the same identity.
        } finally { this.delivering.delete(id); }
      }));
    } finally { this.scanning = false; }
  }
}
