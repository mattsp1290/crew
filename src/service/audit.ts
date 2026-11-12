import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { nextStep, standingChoice, toolNameSchema } from "./deferral.ts";
import { engineSchema, type RequestInitiator } from "./domain.ts";

const uuid = z.uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Trusted-context registration accepts exactly the tool names an audit row can hold. */
export const trustedToolName = /^[a-z][a-z0-9_]{0,63}$/;

// Each key names one partial unique index in 021-audit.sql. A naming mismatch fails
// loudly, and unrelated conflicts (such as a primary key) still raise errors.
const requestFact = "(event_type, conversation_id, request_id) WHERE event_type IN ('request.accepted', 'request.cancellation_requested', 'request.finished')";
const routineFact = "((payload->>'routineId'), (payload->>'revision')) WHERE event_type IN ('routine.created', 'routine.enabled', 'routine.disabled', 'routine.deleted')";
const routineChange = { routineId: uuid, revision: z.int().min(2).max(2_147_483_647) };
const grantFact = "(event_type, (payload->>'grantId'), (payload->>'approvalId')) WHERE event_type IN ('approval.auto_approved', 'grant.created', 'grant.revoked')";
const memoryFact = "((payload->>'memoryId'), event_type) WHERE event_type IN ('memory.created', 'memory.deleted', 'memory.suspended')";

type Actor = "owner" | "system";
/** The closed audit vocabulary. 021-audit.sql repeats these types in a CHECK, widened by
 * 024-standing-grants.sql, 025-routines.sql and 026-memories.sql. Payloads are strict: identifiers, digests, choices and statuses only,
 * never prompt/reply text, tool arguments or secrets. An actor given as a function is
 * decided by the validated payload. A routine acts with its owner's authority, so rows its
 * firings cause name the owner; Crew's own decisions about a routine name the system. */
export const auditEvents = {
  // capabilityDigest: the digest of the capability set the member was given (capabilities.ts); absent when it has none.
  "member.spawned": { actor: "owner", key: "(member_id) WHERE event_type = 'member.spawned'",
    payload: z.strictObject({ spawnRequestId: uuid, engine: engineSchema, profile: z.string().min(1), capabilityDigest: sha256.optional() }) },
  // routineId: the routine firing that opened it, read from the firing row.
  "conversation.opened": { actor: "owner", key: "(conversation_id) WHERE event_type = 'conversation.opened'",
    payload: z.strictObject({ routineId: uuid.optional() }) },
  "request.accepted": { actor: "owner", key: requestFact, payload: z.strictObject({ promptDigest: sha256 }) },
  "approval.decided": { actor: "owner", key: "((payload->>'approvalId')) WHERE event_type = 'approval.decided'",
    payload: z.strictObject({
      approvalId: uuid, invocationId: uuid, toolName: toolNameSchema, argumentDigest: sha256,
      choice: z.enum(["approve", "deny", ...nextStep.options, ...standingChoice.options]),
    }) },
  "approval.auto_approved": { actor: "system", key: grantFact, payload: z.strictObject({
    approvalId: uuid, invocationId: uuid, toolName: z.literal("record_work_item"), argumentDigest: sha256, grantId: uuid,
  }) },
  "grant.created": { actor: "owner", key: grantFact,
    payload: z.strictObject({ grantId: uuid, approvalId: uuid, scope: z.enum(["conversation", "member"]) }) },
  // The owner revokes through the gateway; Crew revokes every grant when a restored installation resumes.
  "grant.revoked": { actor: (payload: { reason: string }) => payload.reason === "owner" ? "owner" : "system", key: grantFact,
    payload: z.strictObject({ grantId: uuid, reason: z.enum(["owner", "recovery_restore"]) }) },
  "work_item.committed": { actor: "system", key: "((payload->>'receiptId')) WHERE event_type = 'work_item.committed'",
    payload: z.strictObject({ receiptId: uuid, approvalId: uuid }) },
  // `policy` marks an intent a routine's fail_closed policy requested with its owner's authority.
  "request.cancellation_requested": { actor: "owner", key: requestFact,
    payload: z.strictObject({ receiptId: uuid.optional(), policy: z.literal("fail_closed").optional() }) },
  "request.finished": { actor: "system", key: requestFact, payload: z.strictObject({
    status: z.enum(["completed", "failed", "cancelled", "uncertain"]),
    reason: z.enum(["predecessor_failed", "predecessor_cancelled", "admission_unconfirmed"]).optional(),
  }) },
  "trusted_effect.completed": { actor: "system", key: "((payload->>'operationId')) WHERE event_type = 'trusted_effect.completed'",
    payload: z.strictObject({ operationId: uuid, toolName: z.string().regex(trustedToolName) }) },
  "routine.created": { actor: "owner", key: routineFact, payload: z.strictObject({
    routineId: uuid, revision: z.literal(1), schedule: z.string().min(9).max(128),
    approvalPolicy: z.enum(["wait", "fail_closed"]), promptDigest: sha256,
  }) },
  "routine.enabled": { actor: "owner", key: routineFact, payload: z.strictObject(routineChange) },
  // The owner disables a routine; Crew does after its tenth consecutive failure.
  "routine.disabled": { actor: (payload: { reason: string }): Actor => payload.reason === "owner" ? "owner" : "system",
    key: routineFact, payload: z.strictObject({ ...routineChange, reason: z.enum(["owner", "consecutive_failures"]) }) },
  "routine.deleted": { actor: "owner", key: routineFact, payload: z.strictObject(routineChange) },
  "routine.firing_settled": { actor: "system",
    key: "((payload->>'routineId'), (payload->>'scheduledFor')) WHERE event_type = 'routine.firing_settled'",
    payload: z.strictObject({
      routineId: uuid, scheduledFor: z.iso.datetime(), status: z.enum(["succeeded", "failed", "skipped"]),
      reason: z.enum(["missed", "overlap", "owner_unavailable", "rejected", "approval_required", "turn_failed",
        "turn_cancelled", "turn_uncertain"]).optional(),
    }) },
  // No digest of the text: an entry is deletable owner content, and an unsalted digest kept in
  // this append-only table would let an export holder confirm a guess of deleted text.
  "memory.created": { actor: "owner", key: memoryFact, payload: z.strictObject({ memoryId: uuid }) },
  "memory.deleted": { actor: "owner", key: memoryFact, payload: z.strictObject({ memoryId: uuid }) },
  // Crew suspends every active entry when a restored installation resumes.
  "memory.suspended": { actor: "system", key: memoryFact,
    payload: z.strictObject({ memoryId: uuid, reason: z.literal("recovery_restore") }) },
} as const;
export type AuditEventType = keyof typeof auditEvents;
export const auditEventTypes = Object.keys(auditEvents) as AuditEventType[];

export interface AuditFact<T extends AuditEventType> {
  type: T; ownerId: string; memberId: string; conversationId?: string; requestId?: string;
  payload: z.input<(typeof auditEvents)[T]["payload"]>;
}

// No caller chooses the initiator. A request's row copies the one its admission recorded,
// read by the insert itself inside the caller's transaction. A request with no admission row
// (workflow histories older than durable admission, and the trusted-context lane, which
// records none) is attributed to the owner, as before admissions recorded an initiator.
// An owner admission stores no initiator_id; the audit row names the owner. The type CHECK
// gives every request-tied type a request_id and the others, spawn and open, none.
const initiatorFromAdmission = `SELECT $1,$2,$3,coalesce(a.initiator_kind,'owner'),coalesce(a.initiator_id,$1),$4,$5,$6,$7,$8
    FROM (VALUES (1)) fact LEFT JOIN birbcrew_ts.request_admissions a ON a.conversation_id=$6 AND a.request_id=$7`;
const actingOwner = "VALUES ($1,$2,$3,'owner',$1,$4,$5,$6,$7,$8)";

/** Call inside the transaction that commits the recorded fact, after that transaction has
 * inserted or locked the conversation row it names: the audit row's foreign keys take FOR
 * KEY SHARE on its member and conversation, and locking the conversation first avoids
 * deadlocks. Call it as late as possible.
 * Await nothing outside the database after it: the insert holds a shared lock that
 * every owner's audit reads wait for until commit. */
export async function appendAudit<T extends AuditEventType>(db: Pick<PoolClient, "query">, fact: AuditFact<T>) {
  const definition: { actor: Actor | ((payload: never) => Actor); key: string; payload: z.ZodType } = auditEvents[fact.type];
  const payload = definition.payload.parse(fact.payload);
  const actor = typeof definition.actor === "function" ? definition.actor(payload as never) : definition.actor;
  await db.query(`INSERT INTO birbcrew_ts.audit_events (owner_id,actor_kind,actor_id,initiator_kind,initiator_id,
      event_type,member_id,conversation_id,request_id,payload)
    ${fact.requestId === undefined ? actingOwner : initiatorFromAdmission} ON CONFLICT ${definition.key} DO NOTHING`,
    [fact.ownerId, actor, actor === "owner" ? fact.ownerId : null, fact.type, fact.memberId,
      fact.conversationId ?? null, fact.requestId ?? null, JSON.stringify(payload)]);
}

// Same default for both formats, so a format change never changes which rows return.
export const auditLimits = { default: 100, json: 1000, csv: 10_000 } as const;

// Zod runs refinements even after a failed regex, so they must accept any input.
const auditParameters = {
  after: z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine(value => value.length < 19 || value <= "9223372036854775807").optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,4}$/).optional(),
  conversationId: z.uuid().transform(value => value.toLowerCase()).optional(),
  format: z.enum(["json", "csv"]).optional(),
};
// A strict object still accepts inherited names such as __proto__; callers check names too.
export const auditParameterNames: readonly string[] = Object.keys(auditParameters);
export const auditQuerySchema = z.strictObject(auditParameters)
  .refine(query => Number(query.limit ?? 1) <= auditLimits[query.format === "csv" ? "csv" : "json"], { path: ["limit"] })
  .transform(query => ({ after: query.after ?? "0", limit: query.limit ? Number(query.limit) : auditLimits.default,
    conversationId: query.conversationId ?? null, format: query.format ?? "json" }));
export type AuditQuery = z.output<typeof auditQuerySchema>;

export interface AuditEvent {
  eventId: string; occurredAt: string; type: AuditEventType;
  actor: { kind: "owner" | "system"; id: string | null };
  initiator: { kind: RequestInitiator["kind"]; id: string };
  memberId: string; conversationId: string | null; requestId: string | null;
  payload: Record<string, unknown>;
}

export const auditSettleWindowMs = 5_000;
/** An audited transaction stayed open for the whole read window. Retrying later is safe. */
export class AuditUnsettledError extends Error {
  constructor() { super("Audit writers did not settle"); this.name = "AuditUnsettledError"; }
}

// Identity values are allocated before commit, so a later ID can become visible first;
// paging past it would lose the earlier row forever. Inserts hold the shared lock taken
// by 021-audit.sql's statement trigger. Obtaining it exclusively proves every allocated
// ID has committed or rolled back, and this statement's snapshot predates the lock, so
// its maximum is a safe horizon. Polling with try-lock never queues ahead of writers.
// The lock is global, so one stalled writer makes every owner's read wait out the window.
// The backoff keeps those waiting readers from crowding the gateway's small pool.
async function stableHorizon(pool: Pool): Promise<string> {
  const deadline = Date.now() + auditSettleWindowMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    const { rows: [row] } = await pool.query<{ horizon: string | null }>(`SELECT CASE
      WHEN pg_try_advisory_xact_lock(hashtextextended('birbcrew_ts.audit_events', 0))
      THEN (SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events)::text END AS horizon`);
    if (row.horizon !== null) return row.horizon;
    const left = deadline - Date.now();
    if (left <= 0) throw new AuditUnsettledError();
    await delay(Math.min(wait, left));
  }
}

/** Owner comes from authentication only. Another owner's conversation filter matches nothing. */
export async function readAudit(pool: Pool, ownerId: string, query: AuditQuery) {
  const horizon = await stableHorizon(pool);
  const { rows } = await pool.query<AuditEvent>(`SELECT event_id::text AS "eventId",
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", event_type AS type,
      json_build_object('kind', actor_kind, 'id', actor_id) AS actor,
      json_build_object('kind', initiator_kind, 'id', initiator_id) AS initiator,
      member_id AS "memberId", conversation_id AS "conversationId", request_id AS "requestId", payload
    FROM birbcrew_ts.audit_events
    WHERE owner_id=$1 AND event_id>$2 AND event_id<=$3 AND ($4::uuid IS NULL OR conversation_id=$4)
    ORDER BY event_id LIMIT $5`, [ownerId, query.after, horizon, query.conversationId, query.limit + 1]);
  const events = rows.slice(0, query.limit);
  return { events, nextAfter: events.at(-1)?.eventId ?? query.after, hasMore: rows.length > query.limit };
}

const csvColumns = ["eventId", "occurredAt", "type", "actorKind", "actorId", "initiatorKind", "initiatorId",
  "memberId", "conversationId", "requestId", "payload"];
// Spreadsheets run a cell that starts with = + - @ tab or CR as a formula; owner IDs are
// free text. Prefixing ' keeps such a cell inert. A leading ' gets one too, so a reader
// recovers every value exactly by dropping one leading '.
function csvCell(value: string | null) {
  if (value === null) return "";
  const inert = /^[=+\-@\t\r']/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(inert) ? `"${inert.replaceAll('"', '""')}"` : inert;
}
export function auditCsv(events: AuditEvent[]) {
  const lines = [csvColumns.join(",")];
  for (const event of events) {
    lines.push([event.eventId, event.occurredAt, event.type, event.actor.kind, event.actor.id, event.initiator.kind,
      event.initiator.id, event.memberId, event.conversationId, event.requestId, JSON.stringify(event.payload)].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
