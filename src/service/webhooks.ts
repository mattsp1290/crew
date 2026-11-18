import { createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { appendAudit, auditEvents, settledHorizon, stableHorizon, type AuditEventType } from "./audit.ts";
import { toolNameSchema } from "./deferral.ts";
import { MemberStoreError } from "./domain.ts";
import type { MemberStore } from "./store.ts";
import { defaultTargetPolicy, parseTarget, postToTarget, resolveTarget, TargetRefusedError, TargetUnreachableError,
  targetLimits, type TargetPolicy, type Timeouts } from "./webhook-target.ts";

export type Clock = () => Date;

export const webhookLimits = {
  enabledPerOwner: 10, // limit_enabled_webhooks in 032-webhooks.sql repeats it
  maximumAttempts: 10, // the webhook_deliveries.attempts CHECK repeats it
  consecutiveFailures: 10, // the webhook_endpoints.consecutive_failures CHECK repeats it
  firstRetryMs: 30_000,
  retryCapMs: 60 * 60_000,
  // Far beyond one attempt's total timeout, so a live dispatcher always settles before its lease ends.
  leaseMs: 60_000,
  // Endpoints one process sends to at once, and deliveries it sends to one endpoint, one after
  // another, before giving the next pass a turn.
  endpointsInFlight: 32,
  chainLength: 100,
  fanOutBatch: 256,
  fanOutBatchesPerPass: 8,
  pageSize: 100,
} as const;

/** The wait after a failed attempt: 30 s, doubling, at most an hour. Ten attempts span about three hours. */
export function retryDelayMs(attempts: number) {
  return Math.min(webhookLimits.firstRetryMs * 2 ** (attempts - 1), webhookLimits.retryCapMs);
}

/** A committed audit row as the dispatcher reads it. */
export type AuditRow = {
  eventId: string; ownerId: string; type: string; occurredAt: string; memberId: string | null;
  conversationId: string | null; requestId: string | null; payload: Record<string, unknown>;
};

const uuid = z.uuid();
// The fan-out adds webhookId, the one field that differs between endpoints, as it records each row.
const envelope = {
  eventId: z.string().regex(/^[1-9][0-9]{0,18}$/), occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), memberId: uuid,
};
type Envelope = z.output<z.ZodObject<typeof envelope>>;
/** A readable message: a title and labelled values, every one a field of the body. */
type Message = { title: string; details: readonly (readonly [string, string])[] };
type KindDefinition = { auditType: AuditEventType; when?: (row: AuditRow) => boolean; body: z.ZodType;
  fields: (row: AuditRow) => Record<string, unknown>; toMessage: (fields: unknown) => Message };
/** Pairs a kind's strict body with its fixed template. `toMessage` parses with this kind's own
 * schema, so a template only ever sees a body that schema accepted and can only name its fields,
 * then adds the lines every message ends with. */
const defineKind = <S extends z.ZodType<Envelope>>({ message, ...definition }:
  Omit<KindDefinition, "body" | "toMessage"> & { body: S; message: (body: z.output<S>) => Message }) => ({
  ...definition,
  toMessage: (fields: unknown): Message => {
    const body: z.output<S> & Envelope = definition.body.parse(fields);
    const { title, details } = message(body);
    return { title, details: [...details, ["Member", body.memberId], ["Event", body.eventId], ["Occurred at", body.occurredAt]] };
  },
});
// A stored outbox body: the kind's body plus the webhookId the fan-out added.
const storedBody = z.looseObject({ webhookId: uuid });

/** What an endpoint can subscribe to. Each kind is one committed audit event type (and, for
 * routine.disabled, one reason), so a delivery exists only for a change that committed. A body
 * carries identifiers, the kind, the time and a status, never prompt, reply, note or memory
 * text: the strict schema refuses anything else. A status is whatever its audit payload allows,
 * so a status the trail gains is delivered, not skipped. `message` is the fixed template the
 * readable formats send. 032-webhooks.sql repeats the names. */
export const webhookKinds = {
  "approval.pending": defineKind({ auditType: "approval.requested",
    body: z.strictObject({ ...envelope, kind: z.literal("approval.pending"), conversationId: uuid, requestId: uuid,
      approvalId: uuid, toolName: toolNameSchema }),
    fields: row => ({ conversationId: row.conversationId, requestId: row.requestId, approvalId: row.payload.approvalId,
      toolName: row.payload.toolName }),
    message: body => ({ title: "Crew: approval pending", details: [["Tool", body.toolName], ["Conversation", body.conversationId],
      ["Request", body.requestId], ["Approval", body.approvalId]] }) }),
  "request.finished": defineKind({ auditType: "request.finished",
    body: z.strictObject({ ...envelope, kind: z.literal("request.finished"), conversationId: uuid, requestId: uuid,
      status: auditEvents["request.finished"].payload.shape.status }),
    fields: row => ({ conversationId: row.conversationId, requestId: row.requestId, status: row.payload.status }),
    message: body => ({ title: `Crew: request ${body.status}`, details: [["Conversation", body.conversationId], ["Request", body.requestId]] }) }),
  "routine.firing_settled": defineKind({ auditType: "routine.firing_settled",
    body: z.strictObject({ ...envelope, kind: z.literal("routine.firing_settled"), routineId: uuid, scheduledFor: z.iso.datetime().max(32),
      status: auditEvents["routine.firing_settled"].payload.shape.status }),
    fields: row => ({ routineId: row.payload.routineId, scheduledFor: row.payload.scheduledFor, status: row.payload.status }),
    message: body => ({ title: `Crew: routine firing ${body.status}`, details: [["Routine", body.routineId], ["Scheduled for", body.scheduledFor]] }) }),
  // Only Crew's own decision: an owner who disables a routine already knows.
  "routine.disabled": defineKind({ auditType: "routine.disabled", when: row => row.payload.reason === "consecutive_failures",
    body: z.strictObject({ ...envelope, kind: z.literal("routine.disabled"), routineId: uuid, status: z.literal("consecutive_failures") }),
    fields: row => ({ routineId: row.payload.routineId, status: row.payload.reason }),
    message: body => ({ title: "Crew: routine disabled", details: [["Routine", body.routineId], ["Reason", body.status]] }) }),
} as const satisfies Record<string, KindDefinition>;
export type WebhookKind = keyof typeof webhookKinds;
export const webhookKindNames = Object.keys(webhookKinds) as [WebhookKind, ...WebhookKind[]];
const deliveredAuditTypes = [...new Set(webhookKindNames.map(kind => webhookKinds[kind].auditType))];

/** The message a readable format sends for a stored body. The body is parsed again by its kind's
 * strict schema first, so a message can only ever hold what the signed `crew` body holds. A schema
 * tightened later would fail rows queued under the old one, for these formats only, until they give up. */
export function webhookMessage(kind: WebhookKind, stored: string): Message {
  const { webhookId: _webhookId, ...fields } = storedBody.parse(JSON.parse(stored));
  return webhookKinds[kind].toMessage(fields);
}

type Rendered = { body: string; headers: Record<string, string> };
/** How each delivery is written for an endpoint, chosen when it is created. Only `crew` is signed:
 * a chat or push service never checks Crew's signature, so its endpoints get none. Every format
 * goes through the same outbox, target checks, timeouts and retries. The format column's CHECK in
 * 034-notification-formats.sql bounds only a name's shape, so a new format is one entry here. */
export const webhookFormats = {
  // The stored body, exactly as the fan-out wrote it.
  crew: { signed: true, render: (_kind, body) => ({ body, headers: { "Content-Type": "application/json" } }) },
  // A JSON `text` field, which Slack's incoming webhooks, Mattermost's and Discord's /slack path read.
  slack: { signed: false, render: (kind, body) => {
    const { title, details } = webhookMessage(kind, body);
    const text = [title, ...details.map(([label, value]) => `${label}: \`${value}\``)].join("\n");
    return { body: JSON.stringify({ text }), headers: { "Content-Type": "application/json" } };
  } },
  // An ntfy topic URL: the body is the notification's text and the Title header its title.
  ntfy: { signed: false, render: (kind, body) => {
    const { title, details } = webhookMessage(kind, body);
    return { body: details.map(([label, value]) => `${label}: ${value}`).join("\n"),
      headers: { "Content-Type": "text/plain; charset=utf-8", Title: title } };
  } },
} as const satisfies Record<string, { signed: boolean; render: (kind: WebhookKind, body: string) => Rendered }>;
export type WebhookFormat = keyof typeof webhookFormats;
export const webhookFormatNames = Object.keys(webhookFormats) as [WebhookFormat, ...WebhookFormat[]];
// 034-notification-formats.sql repeats it as the column default.
export const defaultWebhookFormat: WebhookFormat = "crew";

/** The kind and body fields one committed audit row yields, or null when no kind covers it. A row
 * that does not fit its kind's schema, or would not fit the 1 KiB body CHECK once the fan-out adds
 * webhookId, yields nothing: its insert would roll back the batch and hold up every later event. */
export function webhookEvent(row: AuditRow): { kind: WebhookKind; body: Record<string, unknown> } | null {
  for (const kind of webhookKindNames) {
    const definition: KindDefinition = webhookKinds[kind];
    if (definition.auditType !== row.type || (definition.when && !definition.when(row))) continue;
    const body = definition.body.safeParse({ eventId: row.eventId, kind, occurredAt: row.occurredAt, memberId: row.memberId,
      ...definition.fields(row) });
    return body.success && Buffer.byteLength(JSON.stringify(body.data)) <= 800 ? { kind, body: body.data as Record<string, unknown> } : null;
  }
  return null;
}

export const webhookHeaders = {
  id: "Crew-Webhook-Id", event: "Crew-Webhook-Event", timestamp: "Crew-Webhook-Timestamp", signature: "Crew-Webhook-Signature",
} as const;
/** `v1=` and the hex HMAC-SHA256, keyed by the secret's UTF-8 bytes, of `<timestamp>.<body>`. */
export function webhookSignature(secret: string, timestamp: number, body: string) {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export const webhookCapabilities = {
  version: 1, route: "/v1/webhooks", kinds: webhookKindNames, maximumEnabledPerOwner: webhookLimits.enabledPerOwner,
  schemes: ["https"], insecureTargets: "operator-setting-off-by-default", source: "committed-audit-events", payload: "identifiers-kind-time-status",
  formats: webhookFormatNames, defaultFormat: defaultWebhookFormat,
  signature: { version: "v1", algorithm: "hmac-sha256", signed: "timestamp.body", header: webhookHeaders.signature,
    timestampHeader: webhookHeaders.timestamp, formats: webhookFormatNames.filter(format => webhookFormats[format].signed) },
  secret: "returned-once-at-creation", delivery: "at-least-once-unordered", maximumAttempts: webhookLimits.maximumAttempts,
  retry: { firstMs: webhookLimits.firstRetryMs, factor: 2, capMs: webhookLimits.retryCapMs },
  autoDisableAfterConsecutiveFailures: webhookLimits.consecutiveFailures, redirects: "not-followed",
  timeouts: { connectMs: targetLimits.connectTimeoutMs, totalMs: targetLimits.totalTimeoutMs }, responseBytes: targetLimits.responseBytes,
  restore: "endpoints-disabled-undelivered-cancelled",
} as const;

type EndpointState = "enabled" | "disabled" | "deleted";
type DisabledReason = "owner" | "consecutive_failures" | "recovery_restore";
type EndpointRow = {
  webhook_id: string; owner_id: string; create_request_id: string; url: string | null; host: string; kinds: WebhookKind[];
  // Any name the column's CHECK allows: a later release can store a format this one does not know.
  format: string; secret: string | null; state: EndpointState; disabled_reason: DisabledReason | null; consecutive_failures: number;
  enabled_at: Date | null; created_at: Date; revision: number;
};
type DeliveryState = "pending" | "delivering" | "delivered" | "failed" | "cancelled";
type Outcome = "delivered" | "http_status" | "timeout" | "network" | "address_refused" | "url_refused" | "interrupted";
type DeliveryRow = {
  event_id: string; kind: WebhookKind; state: DeliveryState; reason: string | null; attempts: number; next_attempt_at: Date | null;
  last_attempt_at: Date | null; last_outcome: Outcome | null; last_status_code: number | null; created_at: Date; settled_at: Date | null;
};

// Endpoint lifecycle. Every state change after creation is one of these, applied by
// transitionWebhook. Leaving `enabled` cancels the endpoint's undelivered rows with `cancels`.
export const webhookTransitions = {
  enable: { from: ["disabled"], to: "enabled", event: "webhook.enabled" },
  disable: { from: ["enabled"], to: "disabled", reason: "owner", cancels: "endpoint_disabled", event: "webhook.disabled" },
  exhaust: { from: ["enabled"], to: "disabled", reason: "consecutive_failures", cancels: "endpoint_disabled", event: "webhook.disabled" },
  restore: { from: ["enabled"], to: "disabled", reason: "recovery_restore", cancels: "recovery_restore", event: "webhook.disabled" },
  delete: { from: ["enabled", "disabled"], to: "deleted", cancels: "endpoint_deleted", event: "webhook.deleted" },
} as const satisfies Record<string, { from: readonly EndpointState[]; to: EndpointState; reason?: DisabledReason; cancels?: string; event: string }>;
type WebhookAction = keyof typeof webhookTransitions;

function endpointView(row: EndpointRow) {
  return {
    apiVersion: "1" as const, webhookId: row.webhook_id, url: row.url, host: row.host, kinds: row.kinds, format: row.format, state: row.state,
    disabledReason: row.disabled_reason, consecutiveFailures: row.consecutive_failures, createdAt: row.created_at.toISOString(),
  };
}
function deliveryView(row: DeliveryRow) {
  return {
    eventId: row.event_id, kind: row.kind, state: row.state, reason: row.reason, attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null, lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastOutcome: row.last_outcome, lastStatusCode: row.last_status_code,
    createdAt: row.created_at.toISOString(), settledAt: row.settled_at?.toISOString() ?? null,
  };
}

const lowerUuid = z.uuid().transform(value => value.toLowerCase());
const createSchema = z.strictObject({
  requestId: lowerUuid, url: z.string().min(1).max(targetLimits.urlBytes),
  kinds: z.array(z.enum(webhookKindNames)).min(1).max(webhookKindNames.length).refine(kinds => new Set(kinds).size === kinds.length),
  format: z.enum(webhookFormatNames).default(defaultWebhookFormat),
});
const pageLimit = z.string().regex(/^[1-9][0-9]{0,2}$/).refine(value => Number(value) <= webhookLimits.pageSize).transform(Number).optional();
// Zod runs refinements even after a failed regex, so they must accept any input.
const eventCursor = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => value.length < 19 || value <= "9223372036854775807");
const listParameters = { after: lowerUuid.optional(), limit: pageLimit };
const deliveryParameters = { before: eventCursor.optional(), limit: pageLimit };
// A strict object still accepts inherited names such as __proto__; the gateway checks names too.
export const webhookListParameterNames: readonly string[] = Object.keys(listParameters);
export const deliveryParameterNames: readonly string[] = Object.keys(deliveryParameters);
const listQuery = z.strictObject(listParameters);
const deliveryQuery = z.strictObject(deliveryParameters);

function enabledLimit(error: unknown): never {
  if (error && typeof error === "object" && "constraint" in error && error.constraint === "webhook_endpoints_enabled_limit") {
    throw new MemberStoreError("webhook_limit");
  }
  throw error;
}

/** Taken before an endpoint becomes enabled and before its enabled_at is read, so that time falls
 * after any fan-out in progress: a fan-out holds the cursor exclusively, and an event that occurs
 * from enabled_at on draws an audit ID above every ID that fan-out passed. */
async function holdCursor(db: Pick<PoolClient, "query">) {
  await db.query("SELECT 1 FROM birbcrew_ts.webhook_cursor WHERE singleton FOR SHARE");
}

/** The one place an endpoint changes state after creation. Leaving `enabled` cancels its
 * undelivered rows in the same transaction; deleting erases its URL and secret. */
async function transitionWebhook(db: PoolClient, row: EndpointRow, action: WebhookAction, now: Date): Promise<EndpointRow> {
  const transition = webhookTransitions[action];
  const reason = "reason" in transition ? transition.reason : null;
  const { rows: [changed] } = await db.query<EndpointRow>(`UPDATE birbcrew_ts.webhook_endpoints SET state=$3, disabled_reason=$4,
      enabled_at=CASE WHEN $3='enabled' THEN clock_timestamp() END,
      consecutive_failures=CASE WHEN $3='enabled' THEN 0 ELSE consecutive_failures END,
      url=CASE WHEN $3='deleted' THEN NULL ELSE url END, secret=CASE WHEN $3='deleted' THEN NULL ELSE secret END, revision=revision+1
    WHERE webhook_id=$1 AND state=ANY($2) RETURNING *`, [row.webhook_id, transition.from, transition.to, reason]).catch(enabledLimit);
  if (!changed) throw new MemberStoreError("conflict");
  if ("cancels" in transition) {
    await db.query(`UPDATE birbcrew_ts.webhook_deliveries SET state='cancelled', reason=$2, next_attempt_at=NULL, lease_until=NULL,
      settled_at=$3 WHERE webhook_id=$1 AND state IN ('pending','delivering')`, [row.webhook_id, transition.cancels, now]);
  }
  const fact = { ownerId: changed.owner_id, memberId: null, payload: { webhookId: changed.webhook_id, revision: changed.revision, host: changed.host } };
  if (transition.event === "webhook.disabled") await appendAudit(db, { type: transition.event, ...fact, payload: { ...fact.payload, reason: reason! } });
  else await appendAudit(db, { type: transition.event, ...fact });
  return changed;
}

/** Inside the activation transaction of a restored installation (recovery.ts). The restore can
 * bring back an endpoint the owner deleted or disabled after the recovery point, and undelivered
 * rows that may already have reached their receiver on the lost timeline. So every enabled
 * endpoint is disabled, every undelivered row cancelled, and the cursor moved past every restored
 * event: nothing from before the restore is ever sent. */
export async function settleRestoredWebhooks(db: PoolClient) {
  const now = new Date();
  // The cursor first, as a fan-out takes it before endpoints.
  await db.query("SELECT 1 FROM birbcrew_ts.webhook_cursor WHERE singleton FOR UPDATE");
  const { rows } = await db.query<EndpointRow>(`SELECT * FROM birbcrew_ts.webhook_endpoints WHERE state='enabled'
    ORDER BY created_at, webhook_id FOR UPDATE`);
  for (const row of rows) await transitionWebhook(db, row, "restore", now);
  await db.query(`UPDATE birbcrew_ts.webhook_deliveries SET state='cancelled', reason='recovery_restore', next_attempt_at=NULL,
    lease_until=NULL, settled_at=$1 WHERE state IN ('pending','delivering')`, [now]);
  await db.query(`UPDATE birbcrew_ts.webhook_cursor SET last_event_id=greatest(last_event_id,
    (SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events)) WHERE singleton`);
}

/** Owner-facing endpoint operations. The owner always comes from authentication. */
export class WebhookApi {
  private readonly store: MemberStore;
  private readonly clock: Clock;
  private readonly policy: TargetPolicy;
  constructor(store: MemberStore, clock: Clock, policy: TargetPolicy = defaultTargetPolicy) {
    this.store = store; this.clock = clock; this.policy = policy;
  }

  /** Idempotent by requestId. The secret is in this response only; a replay returns the endpoint
   * without it. The target is checked, including DNS, before anything is written. */
  async create(ownerId: string, input: unknown) {
    const body = createSchema.parse(input);
    const target = parseTarget(body.url, this.policy);
    const kinds = [...body.kinds].sort();
    const existing = async (db: Pick<PoolClient, "query">) => (await db.query<EndpointRow>(
      "SELECT * FROM birbcrew_ts.webhook_endpoints WHERE owner_id=$1 AND create_request_id=$2", [ownerId, body.requestId])).rows[0];
    const replay = (row: EndpointRow) => {
      if (row.state === "deleted") throw new MemberStoreError("webhook_deleted");
      if (row.url !== target.href || row.kinds.join() !== kinds.join() || row.format !== body.format) throw new MemberStoreError("conflict");
      return endpointView(row);
    };
    const prior = await existing(this.store.pool);
    if (prior) return replay(prior);
    await resolveTarget(target, this.policy);
    return this.store.transaction(async db => {
      await holdCursor(db);
      const { rows: [inserted] } = await db.query<EndpointRow>(`INSERT INTO birbcrew_ts.webhook_endpoints
          (owner_id,create_request_id,url,host,kinds,format,secret,state,enabled_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'enabled',clock_timestamp()) ON CONFLICT (owner_id,create_request_id) DO NOTHING RETURNING *`,
        [ownerId, body.requestId, target.href, target.host, kinds, body.format, randomBytes(32).toString("base64url")]).catch(enabledLimit);
      // A concurrent duplicate committed first: answer as its replay.
      if (!inserted) return replay((await existing(db))!);
      await appendAudit(db, { type: "webhook.created", ownerId, memberId: null,
        payload: { webhookId: inserted.webhook_id, revision: 1, host: inserted.host, kinds, format: inserted.format } });
      return { ...endpointView(inserted), secret: inserted.secret! };
    });
  }

  async get(ownerId: string, webhookId: string) {
    return endpointView(await this.owned(this.store.pool, ownerId, webhookId));
  }

  /** Every state, including deleted tombstones, ordered by webhookId. */
  async list(ownerId: string, input: unknown) {
    const query = listQuery.parse(input);
    const limit = query.limit ?? webhookLimits.pageSize;
    const { rows } = await this.store.pool.query<EndpointRow>(`SELECT * FROM birbcrew_ts.webhook_endpoints
      WHERE owner_id=$1 AND ($2::uuid IS NULL OR webhook_id>$2) ORDER BY webhook_id LIMIT $3`, [ownerId, query.after ?? null, limit + 1]);
    const webhooks = rows.slice(0, limit).map(endpointView);
    return { apiVersion: "1" as const, webhooks, nextAfter: webhooks.at(-1)?.webhookId ?? query.after ?? null, hasMore: rows.length > limit };
  }

  /** enable, disable and delete. Repeating the current state is a no-op; a deleted endpoint refuses the others. */
  async change(ownerId: string, webhookId: string, action: "enable" | "disable" | "delete") {
    const now = this.clock();
    return this.store.transaction(async db => {
      if (action === "enable") await holdCursor(db);
      const row = await this.owned(db, ownerId, webhookId, true);
      if (row.state === webhookTransitions[action].to) return endpointView(row);
      if (row.state === "deleted") throw new MemberStoreError("webhook_deleted");
      return endpointView(await transitionWebhook(db, row, action, now));
    });
  }

  /** Newest first, by audit event ID. */
  async deliveries(ownerId: string, webhookId: string, input: unknown) {
    const query = deliveryQuery.parse(input);
    const limit = query.limit ?? webhookLimits.pageSize;
    await this.owned(this.store.pool, ownerId, webhookId);
    // d.event_id: unqualified, ORDER BY would sort the text output column.
    const { rows } = await this.store.pool.query<DeliveryRow>(`SELECT d.event_id::text AS event_id, kind, state, reason, attempts,
        next_attempt_at, last_attempt_at, last_outcome, last_status_code, created_at, settled_at
      FROM birbcrew_ts.webhook_deliveries d WHERE webhook_id=$1 AND ($2::bigint IS NULL OR d.event_id<$2::bigint)
      ORDER BY d.event_id DESC LIMIT $3`, [webhookId.toLowerCase(), query.before ?? null, limit + 1]);
    const deliveries = rows.slice(0, limit).map(deliveryView);
    return { apiVersion: "1" as const, deliveries, nextBefore: deliveries.at(-1)?.eventId ?? query.before ?? null, hasMore: rows.length > limit };
  }

  private async owned(db: Pick<PoolClient, "query">, ownerId: string, webhookId: string, lock = false) {
    const { rows: [row] } = await db.query<EndpointRow>(`SELECT * FROM birbcrew_ts.webhook_endpoints WHERE owner_id=$1 AND webhook_id=$2
      ${lock ? "FOR UPDATE" : ""}`, [ownerId, lowerUuid.parse(webhookId)]);
    if (!row) throw new MemberStoreError("not_found");
    return row;
  }
}

type Claim = { webhook_id: string; event_id: string; attempts: number; prior_attempts: number; lease_until: Date;
  // claim() takes only endpoints whose format webhookFormats knows.
  kind: WebhookKind; body: string; url: string; format: WebhookFormat; secret: string };
type Result = { outcome: Outcome; status?: number };

/** The outbox dispatcher every gateway runs beside its routine dispatcher. Each pass fans newly
 * committed audit rows out to the matching enabled endpoints, then claims a due delivery for each
 * endpoint this process is not already sending to, with SKIP LOCKED and a lease. It does not wait
 * for them: each endpoint's deliveries go one after another, so a slow endpoint holds up only its own. */
export class WebhookDispatcher {
  private readonly store: MemberStore;
  private readonly owners: string[];
  private readonly clock: Clock;
  private readonly policy: TargetPolicy;
  private readonly timeouts: Timeouts | undefined;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private idleAdvancedAt = -Infinity;

  constructor(options: { store: MemberStore; owners: Iterable<string>; clock: Clock; policy?: TargetPolicy; timeouts?: Timeouts }) {
    this.store = options.store; this.owners = [...new Set(options.owners)]; this.clock = options.clock;
    this.policy = options.policy ?? defaultTargetPolicy; this.timeouts = options.timeouts;
  }

  /** One pass. A call while a pass runs joins it instead of starting another. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.ticking ??= this.run().finally(() => { this.ticking = undefined; });
  }

  /** Settles once every delivery this process has started has settled. */
  async idle() { await Promise.allSettled([...this.inflight.values()]); }

  /** No pass starts after this. Attempts in flight are abandoned unsettled: their lease expires
   * and any dispatcher retries them, so a receiver may see such a delivery twice. */
  async stop() {
    this.stopped = true;
    this.abort.abort();
    await (this.ticking ?? Promise.resolve()).catch(() => {});
    await this.idle();
  }

  /** Dispatcher transactions give up on a lock after 10 s rather than stall every later pass. */
  private transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    return this.store.transaction(async db => {
      await db.query("SET LOCAL lock_timeout = '10s'");
      return action(db);
    });
  }

  private async run() {
    const { rows: [control] } = await this.store.pool.query<{ active: boolean; endpoints: boolean }>(`SELECT phase='active' AS active,
      EXISTS (SELECT 1 FROM birbcrew_ts.webhook_endpoints WHERE state='enabled') AS endpoints
      FROM birbcrew_ts.recovery_control WHERE singleton`);
    if (!control?.active) return;
    const now = this.clock();
    if (!control.endpoints) return this.advanceIdle(now);
    // A fan-out that cannot settle the audit horizon or a lock is retried by the next pass.
    await this.fanOut(now).catch(() => {});
    if (this.stopped) return;
    for (const claim of await this.claim(now)) {
      const chain = this.drain(claim).catch(() => {}).finally(() => { this.inflight.delete(claim.webhook_id); });
      this.inflight.set(claim.webhook_id, chain);
    }
  }

  /** With no endpoint enabled, no event that has occurred can ever be delivered (an endpoint gets
   * only events from when it is enabled), so the cursor moves to the audit horizon, at most once a
   * minute, and the first endpoint enabled later does not scan the idle stretch. Every event at or
   * below the horizon had committed, with its time, when the horizon was read. The cursor is taken
   * next and the check reads after it: an enable holds the cursor until it commits, so it is either
   * seen here or reads its time after this commits. One try, so this never waits on audit writers. */
  private async advanceIdle(now: Date) {
    if (now.getTime() - this.idleAdvancedAt < 60_000) return;
    this.idleAdvancedAt = now.getTime();
    const horizon = await settledHorizon(this.store.pool);
    if (horizon === null) return;
    await this.transaction(async db => {
      const { rowCount } = await db.query("SELECT 1 FROM birbcrew_ts.webhook_cursor WHERE singleton FOR UPDATE SKIP LOCKED");
      if (!rowCount) return;
      await db.query(`UPDATE birbcrew_ts.webhook_cursor SET last_event_id=greatest(last_event_id, $1::bigint)
        WHERE singleton AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.webhook_endpoints WHERE state='enabled')`, [horizon]);
    });
  }

  /** Sends an endpoint's due deliveries one after another. A failure only ends the chain: the
   * lease of a row it could not settle expires, and a later pass claims it again. */
  private async drain(first: Claim) {
    let claim = first;
    for (let sent = 1; ; sent++) {
      await this.attempt(claim);
      // Claim the next one only to send it: a claim counts an attempt.
      if (this.stopped || sent >= webhookLimits.chainLength) return;
      const [next] = await this.claim(this.clock(), claim.webhook_id);
      if (!next) return;
      claim = next;
    }
  }

  /** Reads committed audit rows after the cursor, up to a horizon below which every ID has
   * committed or rolled back (audit.ts), and records one pending delivery for each enabled endpoint
   * of the row's owner that subscribes to its kind and was enabled when it occurred. One gateway
   * fans out at a time: the others skip the locked cursor. */
  private async fanOut(now: Date) {
    for (let batch = 0; batch < webhookLimits.fanOutBatchesPerPass && !this.stopped; batch++) {
      const horizon = await stableHorizon(this.store.pool);
      const more = await this.transaction(async db => {
        const { rows: [cursor] } = await db.query<{ last: string }>(`SELECT last_event_id::text AS last FROM birbcrew_ts.webhook_cursor
          WHERE singleton FOR UPDATE SKIP LOCKED`);
        if (!cursor || BigInt(cursor.last) >= BigInt(horizon)) return false;
        // Per owner, on the audit owner index: an owner's events from the time its first endpoint was enabled.
        const { rows } = await db.query<AuditRow>(`SELECT a.event_id::text AS "eventId", a.owner_id AS "ownerId", a.event_type AS type,
            to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", a.member_id AS "memberId",
            a.conversation_id AS "conversationId", a.request_id AS "requestId", a.payload
          FROM (SELECT owner_id, min(enabled_at) AS since FROM birbcrew_ts.webhook_endpoints WHERE state='enabled' GROUP BY owner_id) o
          CROSS JOIN LATERAL (SELECT * FROM birbcrew_ts.audit_events e WHERE e.owner_id=o.owner_id AND e.event_id>$1::bigint
              AND e.event_id<=$2::bigint AND e.event_type=ANY($3::text[]) AND e.occurred_at>=o.since ORDER BY e.event_id LIMIT $4) a
          ORDER BY a.event_id LIMIT $4`, [cursor.last, horizon, deliveredAuditTypes, webhookLimits.fanOutBatch]);
        const events = rows.flatMap(row => { const event = webhookEvent(row); return event ? [{ row, ...event }] : []; });
        if (events.length) {
          // Shares each endpoint against a concurrent disable, which then cancels what this inserts.
          const { rows: endpoints } = await db.query<{ webhook_id: string }>(`SELECT webhook_id FROM birbcrew_ts.webhook_endpoints
            WHERE state='enabled' AND owner_id=ANY($1::text[]) ORDER BY webhook_id FOR SHARE`, [[...new Set(events.map(e => e.row.ownerId))]]);
          await db.query(`INSERT INTO birbcrew_ts.webhook_deliveries (webhook_id,event_id,kind,body,state,next_attempt_at,created_at)
            SELECT w.webhook_id, e.event_id, e.kind, (jsonb_build_object('webhookId', w.webhook_id) || e.body)::text, 'pending', $6, $6
              FROM unnest($1::bigint[], $2::text[], $3::text[], $4::timestamptz[], $5::jsonb[]) AS e(event_id, owner_id, kind, occurred_at, body)
              JOIN birbcrew_ts.webhook_endpoints w ON w.owner_id=e.owner_id AND w.webhook_id=ANY($7::uuid[])
                AND e.kind=ANY(w.kinds) AND w.enabled_at<=e.occurred_at
            ON CONFLICT (webhook_id,event_id) DO NOTHING`,
            [events.map(e => e.row.eventId), events.map(e => e.row.ownerId), events.map(e => e.kind), events.map(e => e.row.occurredAt),
              events.map(e => JSON.stringify(e.body)), now, endpoints.map(e => e.webhook_id)]);
        }
        const full = rows.length === webhookLimits.fanOutBatch;
        await db.query("UPDATE birbcrew_ts.webhook_cursor SET last_event_id=$1::bigint WHERE singleton", [full ? rows.at(-1)!.eventId : horizon]);
        return full;
      });
      if (!more) return;
    }
  }

  /** Due deliveries, the oldest-due first and at most one per endpoint, leased to this process:
   * for every endpoint it is not sending to, or for `only`, the endpoint whose chain asks. An
   * expired lease is a claim whose holder stopped; it is claimed again and counts again. An
   * endpoint whose format this process does not know (a later release wrote it) is left, unattempted. */
  private async claim(now: Date, only?: string): Promise<Claim[]> {
    const room = only ? 1 : webhookLimits.endpointsInFlight - this.inflight.size;
    if (room <= 0) return [];
    const { rows } = await this.store.pool.query<Claim>(`WITH picked AS (
        SELECT d.webhook_id, d.event_id, d.attempts FROM birbcrew_ts.webhook_endpoints w
        CROSS JOIN LATERAL (SELECT webhook_id, event_id, attempts, coalesce(next_attempt_at, lease_until) AS due
            FROM birbcrew_ts.webhook_deliveries d WHERE d.webhook_id=w.webhook_id
             AND ((d.state='pending' AND d.next_attempt_at<=$1) OR (d.state='delivering' AND d.lease_until<=$1))
           ORDER BY d.event_id LIMIT 1 FOR UPDATE SKIP LOCKED) d
        WHERE w.state='enabled' AND w.owner_id=ANY($2::text[]) AND w.format=ANY($8::text[])
          AND ($7::uuid IS NULL AND NOT w.webhook_id=ANY($3::uuid[]) OR w.webhook_id=$7::uuid)
        ORDER BY d.due LIMIT $4)
      UPDATE birbcrew_ts.webhook_deliveries d SET state='delivering', attempts=least(d.attempts+1, $6), next_attempt_at=NULL,
          lease_until=$5, last_attempt_at=$1
        FROM picked p, birbcrew_ts.webhook_endpoints w
       WHERE d.webhook_id=p.webhook_id AND d.event_id=p.event_id AND w.webhook_id=d.webhook_id
      RETURNING d.webhook_id, d.event_id::text AS event_id, d.attempts, p.attempts AS prior_attempts, d.lease_until, d.kind, d.body, w.url,
        w.format, w.secret`,
      [now, this.owners, [...this.inflight.keys()], room, new Date(now.getTime() + webhookLimits.leaseMs), webhookLimits.maximumAttempts,
        only ?? null, webhookFormatNames]);
    return rows;
  }

  private async attempt(claim: Claim) {
    // The last attempt's holder stopped before settling it: its outcome is unknown, and none is left.
    const result = claim.prior_attempts >= webhookLimits.maximumAttempts ? { outcome: "interrupted" as const } : await this.send(claim);
    if (result) await this.settle(claim, result);
  }

  /** Checks the target again, resolving it now and connecting only to what that check accepted. */
  private async send(claim: Claim): Promise<Result | undefined> {
    try {
      const target = parseTarget(claim.url, this.policy);
      const format = webhookFormats[claim.format];
      const message = format.render(claim.kind, claim.body);
      const addresses = await resolveTarget(target, this.policy);
      const timestamp = Math.floor(this.clock().getTime() / 1000);
      const status = await postToTarget(target, addresses, message.body, {
        ...message.headers, "User-Agent": "Crew-Webhooks/1",
        ...(format.signed && { [webhookHeaders.id]: claim.webhook_id, [webhookHeaders.event]: claim.event_id,
          [webhookHeaders.timestamp]: String(timestamp), [webhookHeaders.signature]: webhookSignature(claim.secret, timestamp, message.body) }),
      }, this.abort.signal, this.timeouts);
      if (status < 100 || status > 599) return { outcome: "network" };
      return { outcome: status >= 200 && status < 300 ? "delivered" : "http_status", status };
    } catch (error) {
      if (error instanceof TargetRefusedError) {
        return { outcome: error.reason === "url" ? "url_refused" : error.reason === "address" ? "address_refused" : "network" };
      }
      if (error instanceof TargetUnreachableError) return error.reason === "aborted" ? undefined : { outcome: error.reason };
      return { outcome: "network" };
    }
  }

  /** Records one attempt. The endpoint is locked first, as every transition locks it before its
   * deliveries. Only the lease holder settles: a row cancelled or claimed again meanwhile is left
   * alone. A delivery given up on counts against an enabled endpoint, and the tenth in a row
   * disables it in this transaction; a delivered one resets the count. */
  private async settle(claim: Claim, result: Result) {
    const now = this.clock();
    await this.transaction(async db => {
      const { rows: [endpoint] } = await db.query<EndpointRow>(`SELECT * FROM birbcrew_ts.webhook_endpoints WHERE webhook_id=$1
        FOR NO KEY UPDATE`, [claim.webhook_id]);
      const delivered = result.outcome === "delivered";
      const state: DeliveryState = delivered ? "delivered" : claim.attempts >= webhookLimits.maximumAttempts ? "failed" : "pending";
      const { rowCount } = await db.query(`UPDATE birbcrew_ts.webhook_deliveries SET state=$5, reason=$6, lease_until=NULL,
          next_attempt_at=$7, settled_at=$8, last_outcome=$9, last_status_code=$10
        WHERE webhook_id=$1 AND event_id=$2::bigint AND state='delivering' AND attempts=$3 AND lease_until=$4`,
        [claim.webhook_id, claim.event_id, claim.attempts, claim.lease_until, state, state === "failed" ? "attempts_exhausted" : null,
          state === "pending" ? new Date(now.getTime() + retryDelayMs(claim.attempts)) : null, state === "pending" ? null : now,
          result.outcome, result.status ?? null]);
      if (!rowCount || state === "pending" || endpoint?.state !== "enabled" || (delivered && !endpoint.consecutive_failures)) return;
      const { rows: [counted] } = await db.query<EndpointRow>(`UPDATE birbcrew_ts.webhook_endpoints
        SET consecutive_failures=CASE WHEN $2 THEN 0 ELSE least(consecutive_failures + 1, $3) END WHERE webhook_id=$1 RETURNING *`,
        [claim.webhook_id, delivered, webhookLimits.consecutiveFailures]);
      if (counted.consecutive_failures >= webhookLimits.consecutiveFailures) await transitionWebhook(db, counted, "exhaust", now);
    });
  }
}
