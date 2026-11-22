import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { nextStep, standingChoice, toolNameSchema } from "./deferral.ts";
import { approvalDeadlineSeconds, engineSchema, initiatorKinds, instructionPacksPerMember, instructionsBytes, type RequestInitiator } from "./domain.ts";

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
const webhookFact = "((payload->>'webhookId'), (payload->>'revision')) WHERE event_type IN ('webhook.created', 'webhook.enabled', 'webhook.disabled', 'webhook.deleted')";
// URL.host: lowercase ASCII (IDNs arrive as punycode), an optional port, brackets for IPv6. Never a path.
const webhookHost = z.string().max(300).regex(/^[a-z0-9._\-[\]:]+$/);
const webhookChange = { webhookId: uuid, revision: z.int().min(2).max(2_147_483_647), host: webhookHost };
const budgetFact = "(member_id, (payload->>'revision')) WHERE event_type IN ('usage.budget_set', 'usage.budget_cleared')";
const packFact = "((payload->>'packId'), event_type) WHERE event_type IN ('instruction_pack.created', 'instruction_pack.deleted')";
const delegationFact = "(event_type, (payload->>'childId')) WHERE event_type IN ('delegation.started', 'delegation.finished')";
const tokenLimit = z.int().min(1).max(1_000_000_000_000);

/** The actors audit_events_actor_check in 021-audit.sql allows. */
export const actorKinds = ["owner", "system"] as const;
type Actor = (typeof actorKinds)[number];
/** The closed audit vocabulary. 021-audit.sql repeats these types in a CHECK, widened by
 * 024-standing-grants.sql, 025-routines.sql, 026-memories.sql, 027-handoffs.sql, 028-approval-expiry.sql, 029-member-instructions.sql, 031-usage.sql, 032-webhooks.sql, 033-instruction-packs.sql 036-delegation-audit.sql and 043-conversation-content-erasure.sql (which preserves the prior catalog expression). Payloads are strict: identifiers, digests, choices and statuses only,
 * never prompt/reply text, tool arguments or secrets. An actor given as a function is
 * decided by the validated payload. A routine acts with its owner's authority, so rows its
 * firings cause name the owner; Crew's own decisions about a routine name the system.
 * `member: false` marks a type that belongs to no member: its rows have a null memberId. */
export const auditEvents = {
  // capabilityDigest: the digest of the capability set the member was given (capabilities.ts); absent when it has none.
  "member.spawned": { actor: "owner", key: "(member_id) WHERE event_type = 'member.spawned'",
    payload: z.strictObject({ spawnRequestId: uuid, engine: engineSchema, profile: z.string().min(1), capabilityDigest: sha256.optional() }) },
  // routineId: the routine firing that opened it, read from the firing row.
  "conversation.opened": { actor: "owner", key: "(conversation_id) WHERE event_type = 'conversation.opened'",
    payload: z.strictObject({ routineId: uuid.optional() }) },
  "conversation.content_erased": { actor: "owner", key: "(conversation_id) WHERE event_type = 'conversation.content_erased'",
    payload: z.strictObject({ erasureId: uuid }) },
  "request.accepted": { actor: "owner", key: requestFact, payload: z.strictObject({ promptDigest: sha256 }) },
  "approval.decided": { actor: "owner", key: "((payload->>'approvalId')) WHERE event_type = 'approval.decided'",
    payload: z.strictObject({
      approvalId: uuid, invocationId: uuid, toolName: toolNameSchema, argumentDigest: sha256,
      choice: z.enum(["approve", "deny", ...nextStep.options, ...standingChoice.options]),
    }) },
  "approval.auto_approved": { actor: "system", key: grantFact, payload: z.strictObject({
    approvalId: uuid, invocationId: uuid, toolName: z.literal("record_work_item"), argumentDigest: sha256, grantId: uuid,
  }) },
  // Nobody decided the card before the deadline its request carried; Crew cancelled the request.
  "approval.expired": { actor: "system", key: "((payload->>'approvalId')) WHERE event_type = 'approval.expired'",
    payload: z.strictObject({ approvalId: uuid, invocationId: uuid, toolName: toolNameSchema, expiresAt: z.iso.datetime() }) },
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
  "delegation.started": { actor: "system", key: delegationFact, payload: z.strictObject({
    childId: uuid, role: z.enum(["analyst", "recorder"]), engine: engineSchema, profile: z.string().min(1),
  }) },
  "delegation.finished": { actor: "system", key: delegationFact, payload: z.discriminatedUnion("outcome", [
    z.strictObject({ childId: uuid, outcome: z.literal("completed") }),
    z.strictObject({ childId: uuid, outcome: z.literal("cancelled") }),
    z.strictObject({ childId: uuid, outcome: z.literal("failed"), code: z.enum(["child_failed", "budget_exhausted"]) }),
  ]) },
  "request.finished": { actor: "system", key: requestFact, payload: z.strictObject({
    status: z.enum(["completed", "failed", "cancelled", "uncertain"]),
    reason: z.enum(["predecessor_failed", "predecessor_cancelled", "admission_unconfirmed"]).optional(),
  }) },
  "trusted_effect.completed": { actor: "system", key: "((payload->>'operationId')) WHERE event_type = 'trusted_effect.completed'",
    payload: z.strictObject({ operationId: uuid, toolName: z.string().regex(trustedToolName) }) },
  "routine.created": { actor: "owner", key: routineFact, payload: z.strictObject({
    routineId: uuid, revision: z.literal(1), schedule: z.string().min(9).max(128),
    approvalPolicy: z.enum(["wait", "fail_closed"]), promptDigest: sha256, approvalDeadlineSeconds: approvalDeadlineSeconds.optional(),
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
      reason: z.enum(["missed", "overlap", "owner_unavailable", "rejected", "approval_required", "approval_expired",
        "turn_failed", "turn_cancelled", "turn_uncertain", "usage_limit"]).optional(),
    }) },
  // No digest of the text: an entry is deletable owner content, and an unsalted digest kept in
  // this append-only table would let an export holder confirm a guess of deleted text.
  "memory.created": { actor: "owner", key: memoryFact, payload: z.strictObject({ memoryId: uuid }) },
  "memory.deleted": { actor: "owner", key: memoryFact, payload: z.strictObject({ memoryId: uuid }) },
  // Crew suspends every active entry when a restored installation resumes.
  "memory.suspended": { actor: "system", key: memoryFact,
    payload: z.strictObject({ memoryId: uuid, reason: z.literal("recovery_restore") }) },
  // On the source conversation. The digest is of the server-written transcript; never its text.
  "conversation.handed_off": { actor: "owner", key: "((payload->>'handoffId')) WHERE event_type = 'conversation.handed_off'",
    payload: z.strictObject({
      handoffId: uuid, targetConversationId: uuid, targetMemberId: uuid, firstRequestId: uuid,
      carriedTurns: z.int().min(1).max(128), omittedTurns: z.int().min(0).max(127), uncertainTurns: z.int().min(0).max(128),
      transcriptDigest: sha256,
    }) },
  // Instructions remain retained. Request promptDigest is also permanent, including
  // after conversation erasure, and can confirm a guess of the erased prompt.
  "member.instructions_set": { actor: "owner", key: "(member_id) WHERE event_type = 'member.instructions_set'",
    payload: z.strictObject({ digest: sha256, bytes: z.int().min(1).max(instructionsBytes) }) },
  "usage.budget_set": { actor: "owner", key: budgetFact,
    payload: z.strictObject({ revision: z.int().min(1).max(2_147_483_647), tokenLimit, period: z.literal("utc_day") }) },
  "usage.budget_cleared": { actor: "owner", key: budgetFact, payload: z.strictObject({ revision: z.int().min(2).max(2_147_483_647) }) },
  // The first refusal the trail records: Crew's own decision under the owner's budget, made
  // inside admission, keyed by the request so a retried refusal adds nothing. routineId: the
  // firing that submitted it, as conversation.opened names one; the request has no admission.
  "usage.request_refused": { actor: "system", key: "(conversation_id, request_id) WHERE event_type = 'usage.request_refused'",
    payload: z.strictObject({ tokenLimit, usedTokens: z.int().min(0), period: z.literal("utc_day"), windowStart: z.iso.datetime(),
      budgetRevision: z.int().min(1), routineId: uuid.optional() }) },
  // A card or question became pending: proposeLocked inserted a call no standing grant approved.
  "approval.requested": { actor: "system", key: "((payload->>'approvalId')) WHERE event_type = 'approval.requested'",
    payload: z.strictObject({ approvalId: uuid, invocationId: uuid, toolName: toolNameSchema, argumentDigest: sha256 }) },
  // Webhook endpoints are the owner's, not a member's. The host only: a URL can carry a credential.
  // format: webhookFormats in webhooks.ts. Rows written before 034-notification-formats.sql have none; those endpoints are `crew`.
  "webhook.created": { actor: "owner", member: false, key: webhookFact, payload: z.strictObject({
    webhookId: uuid, revision: z.literal(1), host: webhookHost, kinds: z.array(z.string().regex(/^[a-z]+\.[a-z_]+$/)).min(1).max(4),
    format: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  }) },
  "webhook.enabled": { actor: "owner", member: false, key: webhookFact, payload: z.strictObject(webhookChange) },
  // The owner disables an endpoint; Crew does after its tenth failed delivery in a row, and when a restore resumes.
  "webhook.disabled": { actor: (payload: { reason: string }): Actor => payload.reason === "owner" ? "owner" : "system",
    member: false, key: webhookFact,
    payload: z.strictObject({ ...webhookChange, reason: z.enum(["owner", "consecutive_failures", "recovery_restore"]) }) },
  "webhook.deleted": { actor: "owner", member: false, key: webhookFact, payload: z.strictObject(webhookChange) },
  // Instruction packs are the owner's, not a member's. As with memory, no digest: a pack can be
  // deleted, and a digest kept here would let an export holder confirm a guess of its erased text.
  "instruction_pack.created": { actor: "owner", member: false, key: packFact, payload: z.strictObject({ packId: uuid }) },
  "instruction_pack.deleted": { actor: "owner", member: false, key: packFact, payload: z.strictObject({ packId: uuid }) },
  // Follows member.spawned in the spawn's transaction: the packs, in the order the model reads them.
  "member.instruction_packs_attached": { actor: "owner", key: "(member_id) WHERE event_type = 'member.instruction_packs_attached'",
    payload: z.strictObject({ packIds: z.array(uuid).min(1).max(instructionPacksPerMember) }) },
} as const;
export type AuditEventType = keyof typeof auditEvents;
export const auditEventTypes = Object.keys(auditEvents) as AuditEventType[];
type Memberless = { [T in AuditEventType]: (typeof auditEvents)[T] extends { member: false } ? T : never }[AuditEventType];

export interface AuditFact<T extends AuditEventType> {
  type: T; ownerId: string; memberId: T extends Memberless ? null : string; conversationId?: string; requestId?: string;
  payload: z.input<(typeof auditEvents)[T]["payload"]>;
}

// No caller chooses the initiator. A request's row copies the one its admission recorded,
// read by the insert itself inside the caller's transaction. A request with no admission row
// (workflow histories older than durable admission, the trusted-context lane, which records
// none, and a request refused under its member's usage budget) is attributed to the owner, as
// before admissions recorded an initiator.
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

const lowerUuid = z.uuid().transform(value => value.toLowerCase());
// RFC 3339 with its offset required, narrowed to what PostgreSQL reads exactly, so a valid value never
// fails in SQL: at most microseconds (the trail's own precision, so a bound is never rounded), no
// leap second (read as the next minute), no year 0000 and no offset beyond 15:59.
const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
function isRfc3339(value: string) {
  const parts = rfc3339.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.slice(1).map(part => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && day >= 1 && day <= (days ?? 0) && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 15 && offsetMinute <= 59;
}
const instant = z.string().refine(isRfc3339).transform(value => value.toUpperCase());

/** Every filter GET /v1/audit accepts: how its value is validated, and the predicate it adds after the
 * owner and the cursor. Filters combine with AND. A value is only ever bound; `where` gets its placeholder
 * and the validated value, which may choose the predicate's shape but never appears in it.
 * 030-audit-filters.sql says which filters have an index and why the others need none. */
const auditFilters = {
  conversationId: { value: lowerUuid, where: (p: string) => `conversation_id = ${p}::uuid` },
  memberId: { value: lowerUuid, where: (p: string) => `member_id = ${p}::uuid` },
  // Comma-separated; each a registered type, once. A type outside the registry would match nothing silently.
  // One type is an equality, which reads audit_events_type_page in page order; ANY would sort every match left.
  eventType: {
    value: z.string().transform(value => value.split(","))
      .pipe(z.array(z.enum(auditEventTypes)).refine(types => new Set(types).size === types.length)),
    where: (p: string, types: readonly string[]) => types.length === 1 ? `event_type = (${p}::text[])[1]` : `event_type = ANY(${p}::text[])`,
  },
  actorKind: { value: z.enum(actorKinds), where: (p: string) => `actor_kind = ${p}` },
  initiatorKind: { value: z.enum(initiatorKinds), where: (p: string) => `initiator_kind = ${p}` },
  // An owner row stores the owner ID here, so this names the other initiators: a routine or a handoff, by
  // its ID, and combines with initiatorKind like any filter. The kind test is also what lets the planner use
  // the partial audit_events_initiator_page.
  initiatorId: { value: lowerUuid, where: (p: string) => `initiator_kind <> 'owner' AND initiator_id = ${p}` },
  // A half-open window on occurred_at: from inclusive, to exclusive.
  from: { value: instant, where: (p: string) => `occurred_at >= ${p}::timestamptz` },
  to: { value: instant, where: (p: string) => `occurred_at < ${p}::timestamptz` },
} as const;
type AuditFilterName = keyof typeof auditFilters;
// Each predicate takes what its own schema outputs; the call in filterClause erases that link.
auditFilters satisfies { [K in AuditFilterName]: { where: (p: string, value: z.output<(typeof auditFilters)[K]["value"]>) => string } };
export const auditFilterNames: readonly AuditFilterName[] = Object.freeze(Object.keys(auditFilters) as AuditFilterName[]);
const optionalFilters = Object.fromEntries(auditFilterNames.map(name => [name, auditFilters[name].value.optional()])) as
  { [K in AuditFilterName]: z.ZodOptional<(typeof auditFilters)[K]["value"]> };

// Zod runs refinements even after a failed regex, so they must accept any input.
const auditParameters = {
  after: z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine(value => value.length < 19 || value <= "9223372036854775807").optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,4}$/).optional(),
  format: z.enum(["json", "csv"]).optional(),
  ...optionalFilters,
};
// A strict object still accepts inherited names such as __proto__; callers check names too.
export const auditParameterNames: readonly string[] = Object.keys(auditParameters);
export const auditQuerySchema = z.strictObject(auditParameters)
  .refine(query => Number(query.limit ?? 1) <= auditLimits[query.format === "csv" ? "csv" : "json"], { path: ["limit"] })
  .transform(({ after, limit, format, ...filters }) => ({ after: after ?? "0", limit: limit ? Number(limit) : auditLimits.default,
    format: format ?? "json", filters }));
export type AuditQuery = z.output<typeof auditQuerySchema>;
export type AuditFilters = AuditQuery["filters"];

/** The filter predicates in table order, numbered from `first`, and the values they bind. */
function filterClause(filters: AuditFilters, first: number) {
  const values: unknown[] = [];
  const where = auditFilterNames.flatMap(name => {
    const value = filters[name];
    if (value === undefined) return [];
    values.push(value);
    const filter: { where: (p: string, value: never) => string } = auditFilters[name];
    // Parenthesised, so a predicate with an OR could never escape the owner and cursor terms.
    return [" AND (" + filter.where("$" + (first + values.length - 1), value as never) + ")"];
  });
  return { where: where.join(""), values };
}

export interface AuditEvent {
  eventId: string; occurredAt: string; type: AuditEventType;
  actor: { kind: "owner" | "system"; id: string | null };
  initiator: { kind: RequestInitiator["kind"]; id: string };
  /** Null only for types that belong to no member (the webhook and instruction pack facts). */
  memberId: string | null; conversationId: string | null; requestId: string | null;
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
// The webhook dispatcher reads its horizons the same way. Never call these inside a
// transaction: the exclusive lock would then be held, against every writer, until commit.
/** One try: the horizon, or null while an audited writer is in flight. */
export async function settledHorizon(pool: Pool): Promise<string | null> {
  const { rows: [row] } = await pool.query<{ horizon: string | null }>(`SELECT CASE
    WHEN pg_try_advisory_xact_lock(hashtextextended('birbcrew_ts.audit_events', 0))
    THEN (SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events)::text END AS horizon`);
  return row.horizon;
}
export async function stableHorizon(pool: Pool): Promise<string> {
  const deadline = Date.now() + auditSettleWindowMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    const horizon = await settledHorizon(pool);
    if (horizon !== null) return horizon;
    const left = deadline - Date.now();
    if (left <= 0) throw new AuditUnsettledError();
    await delay(Math.min(wait, left));
  }
}

/** Owner comes from authentication only, and filters narrow that owner's rows: another owner's
 * conversation, member, routine or handoff matches nothing. */
export async function readAudit(pool: Pool, ownerId: string, query: AuditQuery) {
  const horizon = await stableHorizon(pool);
  const filters = filterClause(query.filters, 4);
  const values = [ownerId, query.after, horizon, ...filters.values, query.limit + 1];
  const { rows } = await pool.query<AuditEvent>(`SELECT event_id::text AS "eventId",
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", event_type AS type,
      json_build_object('kind', actor_kind, 'id', actor_id) AS actor,
      json_build_object('kind', initiator_kind, 'id', initiator_id) AS initiator,
      member_id AS "memberId", conversation_id AS "conversationId", request_id AS "requestId", payload
    FROM birbcrew_ts.audit_events
    WHERE owner_id=$1 AND event_id>$2 AND event_id<=$3${filters.where}
    ORDER BY event_id LIMIT $${values.length}`, values);
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
