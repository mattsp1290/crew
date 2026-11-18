import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowUpdateFailedError } from "@temporalio/client";
import type { PoolClient } from "pg";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import type { MemberClient } from "./client.ts";
import { approvalDeadlineSeconds, MemberStoreError, submitSchema, type RequestInitiator } from "./domain.ts";
import type { IntegrationApi, ServerRequestReceipt } from "./integration-api.ts";
import { latestWindow, minimumIntervalMinutes, nextWindow, parseSchedule, scheduleProblem, type Schedule } from "./routine-schedule.ts";
import type { MemberStore } from "./store.ts";

export const routineLimits = {
  enabledPerOwner: 20, // limit_enabled_routines in 025-routines.sql repeats it
  minimumIntervalMinutes,
  promptBytes: 16_384,
  latenessMs: 5 * 60_000,
  consecutiveFailures: 10,
  // A claim's lease outlasts one admission attempt, so one process never drives a firing twice at once.
  leaseMs: 2 * 60_000,
  admissionDeadlineMs: 60_000,
  // A pass waits this long for its drives; a stalled one continues alone and cannot block later passes.
  driveWaitMs: 75_000,
  observeEveryMs: 5_000,
  batch: 32,
} as const;

export const approvalPolicies = ["wait", "fail_closed"] as const;
type ApprovalPolicy = typeof approvalPolicies[number];
export type Clock = () => Date;

// Routine lifecycle. Every state change after creation is one of these transitions, applied
// by transitionRoutine. A deleted routine is a tombstone (025-routines.sql refuses changes).
type RoutineState = "enabled" | "disabled" | "deleted";
export const routineTransitions = {
  enable: { from: ["disabled"], to: "enabled", event: "routine.enabled" },
  disable: { from: ["enabled"], to: "disabled", reason: "owner", event: "routine.disabled" },
  exhaust: { from: ["enabled"], to: "disabled", reason: "consecutive_failures", event: "routine.disabled" },
  delete: { from: ["enabled", "disabled"], to: "deleted", event: "routine.deleted" },
} as const satisfies Record<string, { from: readonly RoutineState[]; to: RoutineState; reason?: string; event: string }>;
type RoutineAction = keyof typeof routineTransitions;

// Firing lifecycle. A window is recorded once, as claimed or skipped; these are the only moves
// after that, applied by moveFiring. A move to the same status only changes its reason.
export const firingStatuses = ["claimed", "admitted", "waiting", "succeeded", "failed", "skipped"] as const;
type FiringStatus = typeof firingStatuses[number];
export const firingTransitions: Record<FiringStatus, readonly FiringStatus[]> = {
  claimed: ["admitted", "failed"],
  admitted: ["waiting", "succeeded", "failed"],
  waiting: ["admitted", "succeeded", "failed"],
  succeeded: [], failed: [], skipped: [],
};
const settledStatuses: readonly FiringStatus[] = ["succeeded", "failed", "skipped"];
// The firing reason CHECK (routine_firings_reason_check) repeats both lists.
export const skipReasons = ["missed", "overlap", "owner_unavailable"] as const;
export const failReasons = ["rejected", "approval_required", "approval_expired", "turn_failed", "turn_cancelled", "turn_uncertain",
  "usage_limit"] as const;
type SkipReason = typeof skipReasons[number];
type FailReason = typeof failReasons[number];
type FiringReason = SkipReason | FailReason;

export const routineCapabilities = {
  version: 1, route: "/v1/routines", schedule: "cron-5-field", timezone: "UTC",
  minimumIntervalMinutes, maximumEnabledPerOwner: routineLimits.enabledPerOwner, promptBytes: routineLimits.promptBytes,
  approvalPolicies, conversation: "new-per-firing", missedWindows: "skipped-not-replayed",
  latenessMinutes: routineLimits.latenessMs / 60_000, overlap: "skipped",
  autoDisableAfterConsecutiveFailures: routineLimits.consecutiveFailures, firingStatuses,
  firingPagination: "scheduled-for-keyset-newest-first",
} as const;

/** Which window to act on and what to do with it. A window fires only if this dispatcher was
 * armed (started, or saw the installation active again) at or before it and it is at most
 * 5 minutes late. A later one is skipped as missed. A recent window this dispatcher was not
 * armed for is left for an armed replica; once 5 minutes late any replica skips it. */
export function decideWindow(schedule: Schedule, due: Date, now: Date, armedAt: Date) {
  const window = latestWindow(schedule, due, now);
  if (now.getTime() - window.getTime() > routineLimits.latenessMs) return { window, act: "missed" as const };
  if (armedAt > window) return { window, act: "wait" as const };
  return { window, act: "fire" as const };
}

/** What an observed request receipt means for its open firing. A fail_closed routine cancels
 * a request that reaches a human decision, and its firing fails whatever the request's end; so
 * does a firing whose card expired, which counts as a failure like any other. */
export function observedFiring(
  firing: { status: "admitted" | "waiting"; reason: FiringReason | null },
  receipt: Pick<ServerRequestReceipt, "status" | "expiredApproval">, policy: ApprovalPolicy,
): { status: FiringStatus; reason: FiringReason | null; outcome?: "success" | "failure"; cancel: boolean } {
  const closed: FailReason | undefined = firing.reason === "approval_required" ? "approval_required"
    : receipt.expiredApproval ? "approval_expired" : undefined;
  const failed = (reason: FailReason) => ({ status: "failed" as const, reason: closed ?? reason,
    outcome: "failure" as const, cancel: false });
  switch (receipt.status) {
    case "completed": return closed ? failed(closed) : { status: "succeeded", reason: null, outcome: "success", cancel: false };
    case "failed": return failed("turn_failed");
    case "cancelled": return failed("turn_cancelled");
    case "uncertain": return failed("turn_uncertain");
    case "waiting": return policy === "fail_closed"
      ? { status: "waiting", reason: "approval_required", cancel: true }
      : { status: "waiting", reason: firing.reason, cancel: false };
    case "cancellation_requested": return { status: firing.status, reason: firing.reason, cancel: false };
    case "accepted": case "running": return { status: "admitted", reason: firing.reason, cancel: false };
  }
}

type RoutineRow = {
  routine_id: string; owner_id: string; create_request_id: string; member_id: string; schedule: string; prompt: string;
  approval_policy: ApprovalPolicy; created_at: Date; state: RoutineState; disabled_reason: "owner" | "consecutive_failures" | null;
  consecutive_failures: number; next_window: Date | null; revision: number; approval_deadline_seconds: number | null;
};
type FiringRow = {
  routine_id: string; scheduled_for: Date; status: FiringStatus; reason: FiringReason | null; conversation_id: string | null;
  request_id: string | null; recorded_at: Date; settled_at: Date | null;
};
type FiringRef = { routine_id: string; scheduled_for: Date; owner_id: string; member_id: string };

function routineView(row: RoutineRow) {
  return {
    apiVersion: "1" as const, routineId: row.routine_id, memberId: row.member_id, schedule: row.schedule, timezone: "UTC" as const,
    prompt: row.prompt, approvalPolicy: row.approval_policy,
    ...(row.approval_deadline_seconds !== null && { approvalDeadlineSeconds: row.approval_deadline_seconds }),
    state: row.state, disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures, nextWindow: row.next_window?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
function firingView(row: FiringRow) {
  return {
    scheduledFor: row.scheduled_for.toISOString(), status: row.status, reason: row.reason,
    conversationId: row.conversation_id, requestId: row.request_id,
    recordedAt: row.recorded_at.toISOString(), settledAt: row.settled_at?.toISOString() ?? null,
  };
}

const lowerUuid = z.uuid().transform(value => value.toLowerCase());
const createSchema = z.strictObject({
  requestId: lowerUuid, memberId: lowerUuid, schedule: z.string().max(128),
  prompt: submitSchema.shape.text, approvalPolicy: z.enum(approvalPolicies),
  approvalDeadlineSeconds: approvalDeadlineSeconds.optional(),
});
const pageLimit = (maximum: number) => z.string().regex(/^[1-9][0-9]{0,3}$/).refine(value => Number(value) <= maximum)
  .transform(Number).optional();
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/).refine(value => !Number.isNaN(Date.parse(value)))
  .transform(value => new Date(value));
// A routine carries its prompt (up to 16 KiB), so a list page holds at most 100.
const listParameters = { after: lowerUuid.optional(), limit: pageLimit(100) };
const firingParameters = { before: instant.optional(), limit: pageLimit(1000) };
// A strict object still accepts inherited names such as __proto__; the gateway checks names too.
export const routineListParameterNames: readonly string[] = Object.keys(listParameters);
export const firingParameterNames: readonly string[] = Object.keys(firingParameters);
const listQuery = z.strictObject(listParameters);
const firingQuery = z.strictObject(firingParameters);

function enabledLimit(error: unknown): never {
  if (error && typeof error === "object" && "constraint" in error && error.constraint === "routines_enabled_limit") {
    throw new MemberStoreError("routine_limit");
  }
  throw error;
}

/** The one place a routine changes state after creation. Enabling resets the failure count
 * and schedules the first window after `now`; the cap trigger rechecks the owner's limit. */
async function transitionRoutine(db: PoolClient, row: RoutineRow, action: RoutineAction, now: Date): Promise<RoutineRow> {
  const transition = routineTransitions[action];
  const next = transition.to === "enabled" ? nextWindow(parseSchedule(row.schedule)!, now) : null;
  if (transition.to === "enabled" && !next) throw new MemberStoreError("conflict");
  const reason = "reason" in transition ? transition.reason : null;
  const { rows: [changed] } = await db.query<RoutineRow>(`UPDATE birbcrew_ts.routines SET state=$3, disabled_reason=$4,
      next_window=$5, consecutive_failures=CASE WHEN $3='enabled' THEN 0 ELSE consecutive_failures END, revision=revision+1
    WHERE routine_id=$1 AND state=ANY($2) RETURNING *`, [row.routine_id, transition.from, transition.to, reason, next])
    .catch(enabledLimit);
  if (!changed) throw new MemberStoreError("conflict");
  const change = { routineId: changed.routine_id, revision: changed.revision };
  const fact = { ownerId: changed.owner_id, memberId: changed.member_id };
  if (transition.event === "routine.disabled") await appendAudit(db, { type: transition.event, ...fact, payload: { ...change, reason: reason! } });
  else await appendAudit(db, { type: transition.event, ...fact, payload: change });
  return changed;
}

/** The one place a recorded firing changes. A settled firing gets its audit row. */
async function moveFiring(db: PoolClient, firing: FiringRef, from: FiringStatus, to: FiringStatus, reason: FiringReason | null, now: Date) {
  if (to !== from && !firingTransitions[from].includes(to)) throw new Error(`A routine firing cannot move from ${from} to ${to}`);
  const settled = settledStatuses.includes(to);
  const { rowCount } = await db.query(`UPDATE birbcrew_ts.routine_firings SET status=$4, reason=$5, lease_until=NULL,
      settled_at=CASE WHEN $6 THEN $7::timestamptz END
    WHERE routine_id=$1 AND scheduled_for=$2 AND status=$3`,
    [firing.routine_id, firing.scheduled_for, from, to, reason, settled, now]);
  if (rowCount && settled) await settledFact(db, firing, to as "succeeded" | "failed", reason);
  return rowCount === 1;
}

async function settledFact(db: PoolClient, firing: FiringRef, status: "succeeded" | "failed" | "skipped", reason: FiringReason | null) {
  await appendAudit(db, { type: "routine.firing_settled", ownerId: firing.owner_id, memberId: firing.member_id,
    payload: { routineId: firing.routine_id, scheduledFor: firing.scheduled_for.toISOString(), status, ...(reason ? { reason } : {}) } });
}

/** Success resets the consecutive-failure count; the tenth failure in a row disables the
 * routine in the same transaction. Only an enabled routine counts. */
async function countOutcome(db: PoolClient, routineId: string, outcome: "success" | "failure", now: Date) {
  const { rows: [row] } = await db.query<RoutineRow>(`UPDATE birbcrew_ts.routines
    SET consecutive_failures=CASE WHEN $2 THEN 0 ELSE least(consecutive_failures + 1, $3) END
    WHERE routine_id=$1 AND state='enabled' RETURNING *`, [routineId, outcome === "success", routineLimits.consecutiveFailures]);
  if (row && row.consecutive_failures >= routineLimits.consecutiveFailures) await transitionRoutine(db, row, "exhaust", now);
}

/** The routine a firing row says started this request, read inside recordAcceptance's
 * transaction after it locked the conversation. Null when no firing names the request. The
 * firing row is the only authority: an admission for its identity is refused unless the
 * firing is still claimed, the conversation is the routine's owner and member, and the text
 * and approval deadline are the routine's. The share lock orders this admission with the
 * dispatcher's settlement. */
export async function firingInitiator(
  db: Pick<PoolClient, "query">, key: { conversationId: string; requestId: string; text: string; approvalDeadlineSeconds?: number },
  conversation: { ownerId: string; memberId: string },
): Promise<RequestInitiator | null> {
  const { rows: [firing] } = await db.query<{ routine_id: string; status: string; owner_id: string; member_id: string; prompt: string;
    approval_deadline_seconds: number | null }>(
    `SELECT f.routine_id, f.status, r.owner_id, r.member_id, r.prompt, r.approval_deadline_seconds
       FROM birbcrew_ts.routine_firings f JOIN birbcrew_ts.routines r USING (routine_id)
      WHERE f.conversation_id=$1 AND f.request_id=$2 FOR SHARE OF f`, [key.conversationId, key.requestId]);
  if (!firing) return null;
  if (firing.status !== "claimed" || firing.owner_id !== conversation.ownerId || firing.member_id !== conversation.memberId
      || firing.prompt !== key.text || firing.approval_deadline_seconds !== (key.approvalDeadlineSeconds ?? null)) {
    throw new MemberStoreError("conflict");
  }
  return { kind: "routine", id: firing.routine_id };
}

/** The routine whose firing reserved this conversation, for its conversation.opened audit row.
 * A conversation the firing reserved for another member is refused, as its admission would be. */
export async function firingConversation(db: Pick<PoolClient, "query">, conversation: { ownerId: string; memberId: string;
  conversationId: string }): Promise<string | undefined> {
  const { rows: [firing] } = await db.query<{ routine_id: string; owner_id: string; member_id: string }>(
    `SELECT f.routine_id, r.owner_id, r.member_id FROM birbcrew_ts.routine_firings f JOIN birbcrew_ts.routines r USING (routine_id)
      WHERE f.conversation_id=$1`, [conversation.conversationId]);
  if (firing && (firing.owner_id !== conversation.ownerId || firing.member_id !== conversation.memberId)) {
    throw new MemberStoreError("conflict");
  }
  return firing?.routine_id;
}

/** Owner-facing routine operations. The owner always comes from authentication. */
export class RoutineApi {
  private readonly store: MemberStore;
  private readonly clock: Clock;
  constructor(store: MemberStore, clock: Clock) { this.store = store; this.clock = clock; }

  async create(ownerId: string, input: unknown) {
    const now = this.clock();
    const body = createSchema.parse(input);
    const problem = scheduleProblem(body.schedule, now);
    if (problem) throw new z.ZodError([{ code: "custom", path: ["schedule"], message: problem, input: body.schedule }]);
    const deadline = body.approvalDeadlineSeconds ?? null;
    const same = (row: RoutineRow) => row.member_id === body.memberId && row.schedule === body.schedule
      && row.prompt === body.prompt && row.approval_policy === body.approvalPolicy && row.approval_deadline_seconds === deadline;
    return this.store.transaction(async db => {
      const existing = async () => (await db.query<RoutineRow>(
        "SELECT * FROM birbcrew_ts.routines WHERE owner_id=$1 AND create_request_id=$2", [ownerId, body.requestId])).rows[0];
      // A replay is answered before the insert, whose cap trigger would count the owner's limit.
      const prior = await existing();
      if (prior) {
        if (!same(prior)) throw new MemberStoreError("conflict");
        return routineView(prior);
      }
      const member = await db.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2", [ownerId, body.memberId]);
      if (!member.rowCount) throw new MemberStoreError("not_found");
      const { rows: [inserted] } = await db.query<RoutineRow>(`INSERT INTO birbcrew_ts.routines
          (owner_id,create_request_id,member_id,schedule,prompt,approval_policy,created_at,state,next_window,approval_deadline_seconds)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'enabled',$8,$9) ON CONFLICT (owner_id,create_request_id) DO NOTHING RETURNING *`,
        [ownerId, body.requestId, body.memberId, body.schedule, body.prompt, body.approvalPolicy, now,
          nextWindow(parseSchedule(body.schedule)!, now), deadline]).catch(enabledLimit);
      if (!inserted) {
        const winner = (await existing())!;
        if (!same(winner)) throw new MemberStoreError("conflict");
        return routineView(winner);
      }
      await appendAudit(db, { type: "routine.created", ownerId, memberId: inserted.member_id, payload: {
        routineId: inserted.routine_id, revision: 1, schedule: inserted.schedule, approvalPolicy: inserted.approval_policy,
        promptDigest: createHash("sha256").update(inserted.prompt).digest("hex"),
        ...(deadline !== null && { approvalDeadlineSeconds: deadline }) } });
      return routineView(inserted);
    });
  }

  async get(ownerId: string, routineId: string) {
    return routineView(await this.owned(this.store.pool, ownerId, routineId));
  }

  async list(ownerId: string, input: unknown) {
    const query = listQuery.parse(input);
    const limit = query.limit ?? 100;
    const { rows } = await this.store.pool.query<RoutineRow>(`SELECT * FROM birbcrew_ts.routines
      WHERE owner_id=$1 AND ($2::uuid IS NULL OR routine_id>$2) ORDER BY routine_id LIMIT $3`, [ownerId, query.after ?? null, limit + 1]);
    const routines = rows.slice(0, limit).map(routineView);
    return { apiVersion: "1" as const, routines, nextAfter: routines.at(-1)?.routineId ?? query.after ?? null, hasMore: rows.length > limit };
  }

  /** enable, disable and delete. Repeating the current state is a no-op; a deleted routine refuses the others. */
  async change(ownerId: string, routineId: string, action: "enable" | "disable" | "delete") {
    const now = this.clock();
    return this.store.transaction(async db => {
      const row = await this.owned(db, ownerId, routineId, true);
      const target = routineTransitions[action].to;
      if (row.state === target) return routineView(row);
      if (row.state === "deleted") throw new MemberStoreError("routine_deleted");
      return routineView(await transitionRoutine(db, row, action, now));
    });
  }

  async firings(ownerId: string, routineId: string, input: unknown) {
    const query = firingQuery.parse(input);
    const limit = query.limit ?? 100;
    await this.owned(this.store.pool, ownerId, routineId);
    const { rows } = await this.store.pool.query<FiringRow>(`SELECT * FROM birbcrew_ts.routine_firings
      WHERE routine_id=$1 AND ($2::timestamptz IS NULL OR scheduled_for<$2) ORDER BY scheduled_for DESC LIMIT $3`,
      [routineId, query.before ?? null, limit + 1]);
    const firings = rows.slice(0, limit).map(firingView);
    return { apiVersion: "1" as const, firings, nextBefore: firings.at(-1)?.scheduledFor ?? query.before?.toISOString() ?? null,
      hasMore: rows.length > limit };
  }

  private async owned(db: Pick<PoolClient, "query">, ownerId: string, routineId: string, lock = false) {
    const { rows: [row] } = await db.query<RoutineRow>(`SELECT * FROM birbcrew_ts.routines WHERE owner_id=$1 AND routine_id=$2
      ${lock ? "FOR UPDATE" : ""}`, [ownerId, lowerUuid.parse(routineId)]);
    if (!row) throw new MemberStoreError("not_found");
    return row;
  }
}

type DueRoutine = Pick<RoutineRow, "routine_id" | "owner_id" | "member_id" | "schedule" | "prompt" | "approval_deadline_seconds">
  & { next_window: Date; open: boolean };
type Claim = FiringRef & Pick<RoutineRow, "approval_deadline_seconds"> & { conversation_id: string; request_id: string; prompt: string };
type OpenFiring = FiringRef & { status: "admitted" | "waiting"; reason: FiringReason | null; conversation_id: string;
  request_id: string; approval_policy: ApprovalPolicy };

/** Starting a turn is refused for good; anything else may have been admitted and is retried. */
function refused(error: unknown) {
  return (error instanceof MemberStoreError && error.code !== "busy") || error instanceof WorkflowUpdateFailedError
    || error instanceof z.ZodError;
}

/** The leased-queue dispatcher the gateway runs beside its cancellation outbox. Times come
 * from the injected clock and reach SQL as parameters. Claims lock due routines with SKIP
 * LOCKED and each window has a primary key, so replicas never fire a window twice. */
export class RoutineDispatcher {
  private readonly store: MemberStore;
  private readonly members: Pick<MemberClient, "open" | "accept">;
  private readonly integration: Pick<IntegrationApi, "status" | "cancel">;
  private readonly owners: ReadonlySet<string>;
  private readonly clock: Clock;
  private readonly driveWaitMs: number;
  // Drives still running in this process, including any that outlived a pass's wait.
  private readonly driving = new Set<string>();
  private armedAt: Date | null = null;
  private ticking: Promise<void> | undefined;
  private waiting: AbortController | undefined;
  private stopped = false;

  constructor(options: { store: MemberStore; members: Pick<MemberClient, "open" | "accept">;
    integration: Pick<IntegrationApi, "status" | "cancel">; owners: Iterable<string>; clock: Clock; driveWaitMs?: number }) {
    this.store = options.store; this.members = options.members; this.integration = options.integration;
    this.owners = new Set(options.owners); this.clock = options.clock;
    this.driveWaitMs = options.driveWaitMs ?? routineLimits.driveWaitMs;
  }

  /** One pass. A call while a pass runs joins it instead of starting another. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.ticking ??= this.run().finally(() => { this.ticking = undefined; });
  }

  /** No pass starts after this; the returned promise settles with the one in flight. */
  stop(): Promise<void> {
    this.stopped = true;
    this.waiting?.abort();
    return (this.ticking ?? Promise.resolve()).catch(() => {});
  }

  /** Dispatcher transactions give up on a lock after 10 s rather than stall every later pass. */
  private transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    return this.store.transaction(async db => {
      await db.query("SET LOCAL lock_timeout = '10s'");
      return action(db);
    });
  }

  private async run() {
    const now = this.clock();
    const { rows: [control] } = await this.store.pool.query<{ active: boolean }>(
      "SELECT phase='active' AS active FROM birbcrew_ts.recovery_control WHERE singleton");
    if (!control?.active) { this.armedAt = null; return; }
    this.armedAt ??= now;
    try {
      const claims = [...await this.claim(now, this.armedAt), ...await this.expiredLeases(now)];
      const waiting = this.waiting = new AbortController();
      if (this.stopped) waiting.abort(); // stop() came during the claim
      await Promise.race([Promise.allSettled(claims.map(claim => this.drive(claim))),
        delay(this.driveWaitMs, undefined, { ref: false, signal: waiting.signal }).catch(() => {})]);
      waiting.abort();
      if (!this.stopped) await this.observe(this.clock());
    } catch (error) {
      // The write barrier refused a write: the installation was held after the check above.
      if (error && typeof error === "object" && "code" in error && error.code === "55000") this.armedAt = null;
      throw error;
    }
  }

  private claim(now: Date, armedAt: Date): Promise<Claim[]> {
    return this.transaction(async db => {
      const { rows } = await db.query<DueRoutine>(`SELECT r.routine_id, r.owner_id, r.member_id, r.schedule, r.prompt, r.next_window,
          r.approval_deadline_seconds,
          EXISTS (SELECT 1 FROM birbcrew_ts.routine_firings f WHERE f.routine_id=r.routine_id
            AND f.status IN ('claimed','admitted','waiting')) AS open
        FROM birbcrew_ts.routines r WHERE r.state='enabled' AND r.next_window<=$1
          -- A recent window this dispatcher was not armed for is left to an armed replica
          -- (decideWindow's "wait"); keeping it out of the batch lets later windows through.
          AND NOT (r.next_window>=$3 AND r.next_window<$4)
        ORDER BY r.next_window LIMIT $2 FOR UPDATE OF r SKIP LOCKED`,
        [now, routineLimits.batch, new Date(now.getTime() - routineLimits.latenessMs), armedAt]);
      const claims: Claim[] = [];
      for (const routine of rows) {
        const schedule = parseSchedule(routine.schedule)!;
        const { window, act } = decideWindow(schedule, routine.next_window, now, armedAt);
        if (act === "wait") continue;
        const skip: SkipReason | undefined = act === "missed" ? "missed"
          : !this.owners.has(routine.owner_id) ? "owner_unavailable" : routine.open ? "overlap" : undefined;
        const firing = { ...routine, scheduled_for: window };
        let unavailable = false;
        if (skip) {
          const { rowCount } = await db.query(`INSERT INTO birbcrew_ts.routine_firings
              (routine_id,scheduled_for,status,reason,recorded_at,settled_at) VALUES ($1,$2,'skipped',$3,$4,$4)
            ON CONFLICT (routine_id,scheduled_for) DO NOTHING`, [routine.routine_id, window, skip, now]);
          if (rowCount) await settledFact(db, firing, "skipped", skip);
          unavailable = rowCount === 1 && skip === "owner_unavailable";
        } else {
          // The identity is drawn once, here; every later attempt reuses it.
          const { rows: [identity] } = await db.query<Pick<Claim, "conversation_id" | "request_id">>(`INSERT INTO birbcrew_ts.routine_firings
              (routine_id,scheduled_for,status,conversation_id,request_id,recorded_at,lease_until)
            VALUES ($1,$2,'claimed',gen_random_uuid(),gen_random_uuid(),$3,$4) ON CONFLICT (routine_id,scheduled_for) DO NOTHING
            RETURNING conversation_id, request_id`,
            [routine.routine_id, window, now, new Date(now.getTime() + routineLimits.leaseMs)]);
          if (identity) claims.push({ ...firing, ...identity });
        }
        await db.query("UPDATE birbcrew_ts.routines SET next_window=$2 WHERE routine_id=$1 AND state='enabled'",
          [routine.routine_id, nextWindow(schedule, window)]);
        if (unavailable) await countOutcome(db, routine.routine_id, "failure", now);
      }
      return claims;
    });
  }

  /** Claims whose holder stopped before settling them, re-leased to retry the stored identity. */
  private async expiredLeases(now: Date): Promise<Claim[]> {
    const { rows } = await this.store.pool.query<Claim>(`UPDATE birbcrew_ts.routine_firings f SET lease_until=$2
      FROM birbcrew_ts.routines r WHERE r.routine_id=f.routine_id AND (f.routine_id,f.scheduled_for) IN (
        SELECT routine_id,scheduled_for FROM birbcrew_ts.routine_firings
         WHERE status='claimed' AND lease_until<=$1 AND NOT conversation_id=ANY($4::uuid[])
         ORDER BY lease_until LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING f.routine_id, f.scheduled_for, f.conversation_id, f.request_id, r.owner_id, r.member_id, r.prompt,
        r.approval_deadline_seconds`,
      [now, new Date(now.getTime() + routineLimits.leaseMs), routineLimits.batch, [...this.driving]]);
    return rows;
  }

  /** Opens the firing's conversation and submits its prompt through the owner's admission path.
   * Only the admission row decides that the firing was admitted. */
  private async drive(claim: Claim) {
    if (this.driving.has(claim.conversation_id)) return;
    this.driving.add(claim.conversation_id);
    try {
      let refusal: FailReason | undefined;
      try {
        const deadline = Date.now() + routineLimits.admissionDeadlineMs;
        const key = { ownerId: claim.owner_id, conversationId: claim.conversation_id };
        await this.members.open({ ...key, memberId: claim.member_id }, deadline);
        await this.members.accept({ ...key, requestId: claim.request_id, text: claim.prompt,
          ...(claim.approval_deadline_seconds !== null && { approvalDeadlineSeconds: claim.approval_deadline_seconds }) }, deadline);
      } catch (error) {
        refusal = error instanceof MemberStoreError && (error.code === "usage_limit" || error.code === "usage_limit_closed") ? "usage_limit"
          : refused(error) ? "rejected" : undefined;
      }
      const now = this.clock();
      await this.transaction(async db => {
        const { rows: [current] } = await db.query<{ status: FiringStatus }>(`SELECT status FROM birbcrew_ts.routine_firings
          WHERE routine_id=$1 AND scheduled_for=$2 FOR UPDATE`, [claim.routine_id, claim.scheduled_for]);
        if (current?.status !== "claimed") return;
        // A separate statement: its snapshot sees an admission that committed while the row lock
        // above waited for recordAcceptance's share lock.
        const admitted = await db.query("SELECT 1 FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2",
          [claim.conversation_id, claim.request_id]);
        if (admitted.rowCount) await moveFiring(db, claim, "claimed", "admitted", null, now);
        else if (refusal && await moveFiring(db, claim, "claimed", "failed", refusal, now)) {
          await countOutcome(db, claim.routine_id, "failure", now);
        }
        // Otherwise the outcome is unknown: the claim stays, and its lease expiry retries the same identity.
      });
    } finally { this.driving.delete(claim.conversation_id); }
  }

  private async observe(now: Date) {
    const { rows } = await this.store.pool.query<OpenFiring>(`UPDATE birbcrew_ts.routine_firings f SET observed_at=$1
      FROM birbcrew_ts.routines r WHERE r.routine_id=f.routine_id AND (f.routine_id,f.scheduled_for) IN (
        SELECT routine_id,scheduled_for FROM birbcrew_ts.routine_firings
         WHERE status IN ('admitted','waiting') AND (observed_at IS NULL OR observed_at<=$2)
         ORDER BY observed_at NULLS FIRST LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING f.routine_id, f.scheduled_for, f.status, f.reason, f.conversation_id, f.request_id,
        r.owner_id, r.member_id, r.approval_policy`,
      [now, new Date(now.getTime() - routineLimits.observeEveryMs), routineLimits.batch]);
    await Promise.allSettled(rows.map(async firing => {
      const key = { ownerId: firing.owner_id, conversationId: firing.conversation_id, requestId: firing.request_id };
      const change = observedFiring(firing, await this.integration.status(key), firing.approval_policy);
      if (change.status !== firing.status || change.reason !== firing.reason) {
        await this.transaction(async db => {
          if (await moveFiring(db, firing, firing.status, change.status, change.reason, now) && change.outcome) {
            await countOutcome(db, firing.routine_id, change.outcome, now);
          }
        });
      }
      // Recorded first, so a lost cancellation is requested again on the next observation.
      if (change.cancel) await this.integration.cancel(key, "fail_closed");
    }));
  }
}
