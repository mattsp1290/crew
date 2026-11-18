import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import { initiatorFromColumns, MemberStoreError } from "./domain.ts";
import type { MemberStore } from "./store.ts";
import type { Launch } from "./supervisor.ts";
import type { TrustedClaim } from "./trusted-context.ts";
import type { SegmentUsage } from "./usage-capture.ts";
import { estimateCost, priceSetting, priceUnit, type Price, type PriceTable } from "./usage-prices.ts";

/** Usage metering (docs/usage-metering.md): a ledger row per native segment, owner-scoped totals,
 * and an optional per-member token budget that request admission enforces as a soft cap. */
export const usageLimits = {
  tokenLimitMaximum: 1_000_000_000_000, // the token_limit CHECK in 031-usage.sql repeats it
  listPage: 100,
  recordPage: 1000,
  defaultPage: 100,
} as const;

// Values that were true before estimates and still are keep their wording: `cost` and each engine's
// `cost` describe costUsd, which is still billed only. Estimates are described by the new keys.
export const usageCapabilities = {
  version: 1, route: "/v1/usage", ledger: "one-row-per-native-segment", states: ["reported", "unknown"],
  tokens: "input-includes-cache; output-includes-reasoning",
  cost: "provider-billed-only; never-estimated",
  estimate: { field: "estimatedCostUsd", source: "operator-price-table", setting: priceSetting, unit: priceUnit,
    keyedBy: "recorded-model", computed: "at-write; never-recomputed", builtInPrices: false,
    withBilledCost: "never-on-one-segment; totals-never-added" },
  lanes: ["member", "trusted"],
  engines: {
    pi: { usage: "per-model-call", model: "reported", modelSource: "answering-model", cost: "when-provider-billed",
      estimate: "when-priced-and-not-billed" },
    claude: { usage: "per-query", model: "reported", cost: "never", estimate: "when-priced" },
    codex: { usage: "per-turn-from-thread-total", model: "from-rollout-turn-context", cost: "never", estimate: "when-priced" },
  },
  budget: { route: "/v1/usage/budgets/{memberId}", period: "utc_day", counts: "input+output", scope: "member",
    lanesCounted: ["member", "trusted"], lanesRefused: ["member"],
    enforcement: "admission-soft-cap", refusal: "usage_limit", refusalClosingConversation: "usage_limit_closed",
    tokenLimitMaximum: usageLimits.tokenLimitMaximum },
  recordPagination: "usage-id-keyset-newest-first", restore: "rewound-with-database; usage-ids-after-recovery-point-reissued",
} as const;

type Queryable = Pick<PoolClient, "query">;

/** Records what a native segment's SDK reported, once per launch generation, before its outcome
 * commits: the model work happened whether or not the commit that follows succeeds. A segment
 * whose driver reported nothing is recorded as unknown. The launch's execution identity must
 * match the reserved native_launches row. With a price for the segment's model, the row keeps an
 * estimated cost, computed now and never again. */
export async function recordSegmentUsage(db: Pool, launch: Launch, usage?: SegmentUsage, prices: PriceTable | null = null) {
  await record(db, { lane: "member", launch }, usage, prices);
}

/** The same record for a trusted-context request, which has no launch generation: one row per
 * trusted request, bound to the generation and token its start claimed. A trusted request runs
 * at most once, so its ID identifies the model work as a launch generation does. */
export async function recordTrustedUsage(db: Pool, claim: TrustedClaim, usage: SegmentUsage, prices: PriceTable | null = null) {
  await record(db, { lane: "trusted", claim }, usage, prices);
}

type Segment = { lane: "member"; launch: Launch } | { lane: "trusted"; claim: TrustedClaim };
const unknownUsage: SegmentUsage = { state: "unknown", model: null };

const refused = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "23514");

async function record(db: Pool, segment: Segment, usage: SegmentUsage = unknownUsage, prices: PriceTable | null) {
  // Metering must not cost a finished segment its result: a row the ledger's CHECKs refuse is kept
  // as unknown instead. Dropping only the estimate would never help: estimateCost prices only a
  // reported, named, unbilled segment at canonical rates, so a refusal comes from its counts or
  // model. Callers pass the pool, so a failed insert left no transaction to abort.
  try { await insertUsage(db, segment, usage, estimateCost(usage, prices)); }
  catch (error) {
    if (usage.state === "unknown" || !refused(error)) throw error;
    await insertUsage(db, segment, unknownUsage, null);
  }
}

// One list, so the columns, their placeholders and the values cannot drift apart.
const usageColumnList = ["state", "model", "input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens",
  "reasoning_tokens", "cost_usd", "estimated_cost_usd", "estimate_price"] as const;
const usageColumns = usageColumnList.join(",");
const usageValues = (first: number) => usageColumnList.map((column, i) => "$" + (first + i) + (column === "estimate_price" ? "::jsonb" : "")).join(",");

async function insertUsage(db: Queryable, segment: Segment, usage: SegmentUsage, estimate: ReturnType<typeof estimateCost>) {
  const counts = usage.state === "reported" ? usage : undefined;
  const byColumn: Record<typeof usageColumnList[number], unknown> = { state: usage.state, model: usage.model,
    input_tokens: counts?.inputTokens ?? null, output_tokens: counts?.outputTokens ?? null,
    cached_input_tokens: counts?.cachedInputTokens ?? null, cache_write_tokens: counts?.cacheWriteTokens ?? null,
    reasoning_tokens: counts?.reasoningTokens ?? null, cost_usd: counts?.costUsd ?? null,
    estimated_cost_usd: estimate?.costUsd ?? null, estimate_price: estimate ? JSON.stringify(estimate.price) : null };
  const values = usageColumnList.map(column => byColumn[column]);
  // Each lane's WHERE parameters come first; the shared values follow them.
  if (segment.lane === "trusted") {
    const { claim } = segment;
    const identity = [claim.ownerId, claim.conversationId, claim.requestId, claim.generation, claim.token];
    await db.query(`INSERT INTO birbcrew_ts.usage_ledger (owner_id,member_id,conversation_id,request_id,trusted_request_id,engine,${usageColumns})
      SELECT c.owner_id,c.member_id,r.conversation_id,r.request_id,r.request_id,m.engine,${usageValues(identity.length + 1)}
        FROM birbcrew_ts.trusted_requests r JOIN birbcrew_ts.conversations c USING (conversation_id)
        JOIN birbcrew_ts.members m USING (owner_id,member_id)
       WHERE c.owner_id=$1 AND r.conversation_id=$2 AND r.request_id=$3 AND r.generation=$4 AND r.token=$5
      ON CONFLICT (conversation_id,trusted_request_id) WHERE trusted_request_id IS NOT NULL DO NOTHING`,
    [...identity, ...values]);
    return;
  }
  const { launch } = segment;
  // A child's segment records the engine its target ran on, and stays the parent member's spend. Its
  // estimate is keyed on the model the segment reported, whatever engine ran it.
  const identity = [launch.ownerId, launch.conversationId, launch.requestId, launch.token, launch.execution.workflowRunId,
    launch.execution.activityId, launch.execution.attempt, launch.childId ?? null];
  await db.query(`INSERT INTO birbcrew_ts.usage_ledger (owner_id,member_id,conversation_id,request_id,token,child_id,engine,${usageColumns})
    SELECT c.owner_id,c.member_id,n.conversation_id,n.request_id,n.token,n.child_id,
        coalesce(j.role_profile->'target'->>'engine',m.engine),${usageValues(identity.length + 1)}
      FROM birbcrew_ts.native_launches n JOIN birbcrew_ts.conversations c USING (conversation_id)
      JOIN birbcrew_ts.members m USING (owner_id,member_id)
      LEFT JOIN birbcrew_ts.pi_children j ON j.child_id=n.child_id
     WHERE c.owner_id=$1 AND n.conversation_id=$2 AND n.request_id=$3 AND n.token=$4 AND n.workflow_run_id=$5
       AND n.activity_id=$6 AND n.attempt=$7 AND n.child_id IS NOT DISTINCT FROM $8::uuid
    ON CONFLICT (conversation_id,request_id,token) DO NOTHING`,
  [...identity, ...values]);
}

// The budget's window: the current UTC calendar day of the database clock. It counts every reported
// row of the member, the trusted-context lane's included, though only the member lane is refused.
const windowStart = "date_trunc('day', now(), 'UTC')";
const windowUsed = (member: string) => `(SELECT coalesce(sum(w.input_tokens::bigint + w.output_tokens), 0) FROM birbcrew_ts.usage_ledger w
  WHERE w.member_id=${member} AND w.state='reported' AND w.recorded_at>=${windowStart})`;

/** The member's active budget when its current window is used up, else null. */
async function exhaustedBudget(db: Queryable, ownerId: string, memberId: string) {
  const { rows: [budget] } = await db.query<{ token_limit: string; revision: number; used: string; window_start: Date }>(
    `SELECT b.token_limit, b.revision, ${windowUsed("b.member_id")} AS used, ${windowStart} AS window_start
       FROM birbcrew_ts.usage_budgets b WHERE b.owner_id=$1 AND b.member_id=$2 AND b.state='active'`, [ownerId, memberId]);
  return budget && BigInt(budget.used) >= BigInt(budget.token_limit) ? budget : null;
}

/** Whether the member's budget is used up. A handoff asks this of its target before it commits,
 * because the request it reserves is never refused by the budget afterwards (handoffs.ts). */
export async function overBudget(db: Queryable, ownerId: string, memberId: string) {
  return await exhaustedBudget(db, ownerId, memberId) !== null;
}

/** The budget check of an admission, inside its transaction after the conversation is locked.
 * A refusal is audited, once per request identity, and the caller then refuses the request. */
export async function refuseOverBudget(db: Queryable, key: { ownerId: string; conversationId: string; requestId: string },
  memberId: string, routineId?: string): Promise<boolean> {
  const budget = await exhaustedBudget(db, key.ownerId, memberId);
  if (!budget) return false;
  await appendAudit(db, { type: "usage.request_refused", ownerId: key.ownerId, memberId, conversationId: key.conversationId,
    requestId: key.requestId, payload: { tokenLimit: Number(budget.token_limit), usedTokens: Number(budget.used), period: "utc_day",
      windowStart: budget.window_start.toISOString(), budgetRevision: budget.revision, ...(routineId && { routineId }) } });
  return true;
}

/** Whether the request's member has an active budget, which MemberStore.checkAdmission then
 * checks before the request reaches its workflow, so a refusal leaves the conversation open and
 * answers at once. Most members have none, and they cost this one read. A trusted-context
 * conversation is refused by admission itself. */
export async function budgetApplies(db: Queryable, request: { ownerId: string; conversationId: string }) {
  const { rowCount } = await db.query(`SELECT 1 FROM birbcrew_ts.conversations c JOIN birbcrew_ts.usage_budgets b USING (member_id)
    WHERE c.owner_id=$1 AND c.conversation_id=$2 AND b.state='active'
      AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.trusted_sessions s WHERE s.conversation_id=c.conversation_id)`,
  [request.ownerId, request.conversationId]);
  return Boolean(rowCount);
}

const lowerUuid = z.uuid().transform(value => value.toLowerCase());
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/).refine(value => !Number.isNaN(Date.parse(value)))
  .transform(value => new Date(value));
const pageLimit = (maximum: number) => z.string().regex(/^[1-9][0-9]{0,3}$/).refine(value => Number(value) <= maximum)
  .transform(Number).optional();
const range = { from: instant.optional(), to: instant.optional() };
const ordered = (query: { from?: Date; to?: Date }) => !query.from || !query.to || query.from < query.to;
const parameters = {
  summary: range,
  members: { ...range, after: lowerUuid.optional(), limit: pageLimit(usageLimits.listPage) },
  conversations: { ...range, memberId: lowerUuid.optional(), after: lowerUuid.optional(), limit: pageLimit(usageLimits.listPage) },
  records: { ...range, memberId: lowerUuid.optional(), conversationId: lowerUuid.optional(),
    before: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(), limit: pageLimit(usageLimits.recordPage) },
};
type UsageView = keyof typeof parameters;
// A strict object still accepts inherited names such as __proto__; the gateway checks names too.
export const usageParameterNames: Record<UsageView, readonly string[]> = {
  summary: Object.keys(parameters.summary), members: Object.keys(parameters.members),
  conversations: Object.keys(parameters.conversations), records: Object.keys(parameters.records),
};
const summaryQuery = z.strictObject(parameters.summary).refine(ordered, { path: ["to"] });
const membersQuery = z.strictObject(parameters.members).refine(ordered, { path: ["to"] });
const conversationsQuery = z.strictObject(parameters.conversations).refine(ordered, { path: ["to"] });
const recordsQuery = z.strictObject(parameters.records).refine(ordered, { path: ["to"] });
const budgetBody = z.strictObject({ tokenLimit: z.int().min(1).max(usageLimits.tokenLimitMaximum) });

// One set of totals per filter: every segment, those whose request a routine started (the
// initiator its admission recorded; a request without an admission row is the owner's), and
// those of the trusted-context lane.
const totalsColumns = (name: string, filter: string) => `
  count(u.usage_id) FILTER (WHERE ${filter})::bigint AS ${name}_segments,
  count(u.usage_id) FILTER (WHERE ${filter} AND u.state='unknown')::bigint AS ${name}_unknown,
  coalesce(sum(u.input_tokens) FILTER (WHERE ${filter}), 0)::bigint AS ${name}_input,
  coalesce(sum(u.output_tokens) FILTER (WHERE ${filter}), 0)::bigint AS ${name}_output,
  coalesce(sum(u.cached_input_tokens) FILTER (WHERE ${filter}), 0)::bigint AS ${name}_cached,
  coalesce(sum(u.cache_write_tokens) FILTER (WHERE ${filter}), 0)::bigint AS ${name}_cache_write,
  coalesce(sum(u.reasoning_tokens) FILTER (WHERE ${filter}), 0)::bigint AS ${name}_reasoning,
  (sum(u.cost_usd) FILTER (WHERE ${filter}))::text AS ${name}_cost,
  count(u.cost_usd) FILTER (WHERE ${filter})::bigint AS ${name}_cost_segments,
  (sum(u.estimated_cost_usd) FILTER (WHERE ${filter}))::text AS ${name}_estimated_cost,
  count(u.estimated_cost_usd) FILTER (WHERE ${filter})::bigint AS ${name}_estimated_segments`;
const allTotals = totalsColumns("total", "true") + ","
  + totalsColumns("routine", "u.trusted_request_id IS NULL AND a.initiator_kind='routine'") + ","
  + totalsColumns("trusted", "u.trusted_request_id IS NOT NULL");
const admission = "LEFT JOIN birbcrew_ts.request_admissions a ON a.conversation_id=u.conversation_id AND a.request_id=u.request_id";
const inRange = (from: string, to: string) => `(${from}::timestamptz IS NULL OR u.recorded_at>=${from}) AND (${to}::timestamptz IS NULL OR u.recorded_at<${to})`;

type Row = Record<string, string | number | Date | null>;
const decimal = (value: string | null) => value === null ? null : value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
function totalsView(row: Row, name: string) {
  const n = (field: string) => Number(row[`${name}_${field}`]);
  return {
    segments: n("segments"), unknownSegments: n("unknown"), inputTokens: n("input"), outputTokens: n("output"),
    totalTokens: n("input") + n("output"), cachedInputTokens: n("cached"), cacheWriteTokens: n("cache_write"),
    reasoningTokens: n("reasoning"), costUsd: decimal(row[`${name}_cost`] as string | null), costReportedSegments: n("cost_segments"),
    // Never added to costUsd: an estimate is not a bill. The two count disjoint segments.
    estimatedCostUsd: decimal(row[`${name}_estimated_cost`] as string | null), costEstimatedSegments: n("estimated_segments"),
  };
}
const totals = (row: Row) => ({ total: totalsView(row, "total"), routine: totalsView(row, "routine"), trusted: totalsView(row, "trusted") });

type LedgerRow = { usage_id: string; recorded_at: Date; member_id: string; conversation_id: string; request_id: string;
  child_id: string | null; trusted: boolean; engine: string; state: string; model: string | null; input_tokens: number | null; output_tokens: number | null;
  cached_input_tokens: number | null; cache_write_tokens: number | null; reasoning_tokens: number | null; cost_usd: string | null;
  estimated_cost_usd: string | null; estimate_price: Price | null; initiator_kind: string | null; initiator_id: string | null };
function recordView(row: LedgerRow) {
  return {
    usageId: row.usage_id, recordedAt: row.recorded_at.toISOString(), memberId: row.member_id, conversationId: row.conversation_id,
    requestId: row.request_id, childId: row.child_id, lane: row.trusted ? "trusted" as const : "member" as const,
    engine: row.engine, state: row.state, model: row.model,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens, reasoningTokens: row.reasoning_tokens, costUsd: decimal(row.cost_usd),
    estimatedCostUsd: decimal(row.estimated_cost_usd), estimatePrice: row.estimate_price,
    // A trusted request is the owner's, as the lane's effects are in the audit trail; it has no admission row.
    initiator: row.trusted || row.initiator_kind === null ? { kind: "owner" as const }
      : initiatorFromColumns(row.initiator_kind, row.initiator_id),
  };
}

type BudgetRow = { state: "active" | "cleared"; token_limit: string | null; revision: number; changed_at: Date };
type WindowRow = { used: string; window_start: Date };

/** Owner-scoped usage reads and budget changes. The owner always comes from authentication;
 * another owner's member or conversation is not found. */
export class UsageApi {
  private readonly store: MemberStore;
  constructor(store: MemberStore) { this.store = store; }

  async summary(ownerId: string, input: unknown) {
    const query = summaryQuery.parse(input);
    const { rows: [row] } = await this.store.pool.query<Row>(`SELECT ${allTotals} FROM birbcrew_ts.usage_ledger u ${admission}
      WHERE u.owner_id=$1 AND ${inRange("$2", "$3")}`, [ownerId, query.from ?? null, query.to ?? null]);
    return { apiVersion: "1" as const, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null, ...totals(row) };
  }

  /** Every member of the owner, with or without usage, each with its budget's current window. */
  async members(ownerId: string, input: unknown) {
    const query = membersQuery.parse(input);
    const limit = query.limit ?? usageLimits.defaultPage;
    const { rows } = await this.store.pool.query<Row>(`SELECT m.member_id, m.engine, ${allTotals},
        b.token_limit::text AS budget_limit, b.revision AS budget_revision, b.changed_at AS budget_changed_at,
        ${windowUsed("m.member_id")}::text AS window_used, ${windowStart} AS window_start
      FROM (SELECT member_id, engine FROM birbcrew_ts.members WHERE owner_id=$1 AND ($4::uuid IS NULL OR member_id>$4)
            ORDER BY member_id LIMIT $5) m
      LEFT JOIN birbcrew_ts.usage_ledger u ON u.member_id=m.member_id AND ${inRange("$2", "$3")}
      ${admission}
      LEFT JOIN birbcrew_ts.usage_budgets b ON b.member_id=m.member_id AND b.state='active'
      GROUP BY m.member_id, m.engine, b.member_id ORDER BY m.member_id`,
    [ownerId, query.from ?? null, query.to ?? null, query.after ?? null, limit + 1]);
    const members = rows.slice(0, limit).map(row => ({
      memberId: row.member_id as string, engine: row.engine as string, ...totals(row),
      budget: row.budget_limit === null ? null : { tokenLimit: Number(row.budget_limit), period: "utc_day" as const,
        revision: row.budget_revision as number, changedAt: (row.budget_changed_at as Date).toISOString(),
        windowStart: (row.window_start as Date).toISOString(), usedTokens: Number(row.window_used) },
    }));
    return { apiVersion: "1" as const, members, nextAfter: members.at(-1)?.memberId ?? query.after ?? null, hasMore: rows.length > limit };
  }

  /** Conversations with at least one ledger row in the range. */
  async conversations(ownerId: string, input: unknown) {
    const query = conversationsQuery.parse(input);
    const limit = query.limit ?? usageLimits.defaultPage;
    if (query.memberId) await this.member(ownerId, query.memberId);
    const { rows } = await this.store.pool.query<Row>(`SELECT u.conversation_id, u.member_id, ${allTotals}
      FROM birbcrew_ts.usage_ledger u ${admission}
      WHERE u.owner_id=$1 AND ${inRange("$2", "$3")} AND ($4::uuid IS NULL OR u.member_id=$4) AND ($5::uuid IS NULL OR u.conversation_id>$5)
      GROUP BY u.conversation_id, u.member_id ORDER BY u.conversation_id LIMIT $6`,
    [ownerId, query.from ?? null, query.to ?? null, query.memberId ?? null, query.after ?? null, limit + 1]);
    const conversations = rows.slice(0, limit).map(row => ({ conversationId: row.conversation_id as string,
      memberId: row.member_id as string, ...totals(row) }));
    return { apiVersion: "1" as const, conversations, nextAfter: conversations.at(-1)?.conversationId ?? query.after ?? null,
      hasMore: rows.length > limit };
  }

  /** Ledger rows, newest first. */
  async records(ownerId: string, input: unknown) {
    const query = recordsQuery.parse(input);
    const limit = query.limit ?? usageLimits.defaultPage;
    if (query.memberId) await this.member(ownerId, query.memberId);
    if (query.conversationId && !(await this.store.pool.query("SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2",
      [ownerId, query.conversationId])).rowCount) throw new MemberStoreError("not_found");
    const { rows } = await this.store.pool.query<LedgerRow>(`SELECT u.usage_id::text AS usage_id, u.recorded_at, u.member_id,
        u.conversation_id, u.request_id, u.child_id, u.trusted_request_id IS NOT NULL AS trusted, u.engine, u.state, u.model, u.input_tokens, u.output_tokens,
        u.cached_input_tokens, u.cache_write_tokens, u.reasoning_tokens, u.cost_usd::text AS cost_usd,
        u.estimated_cost_usd::text AS estimated_cost_usd, u.estimate_price, a.initiator_kind, a.initiator_id
      FROM birbcrew_ts.usage_ledger u ${admission}
      WHERE u.owner_id=$1 AND ${inRange("$2", "$3")} AND ($4::uuid IS NULL OR u.member_id=$4)
        AND ($5::uuid IS NULL OR u.conversation_id=$5) AND ($6::bigint IS NULL OR u.usage_id<$6)
      ORDER BY u.usage_id DESC LIMIT $7`,
    [ownerId, query.from ?? null, query.to ?? null, query.memberId ?? null, query.conversationId ?? null, query.before ?? null, limit + 1]);
    const records = rows.slice(0, limit).map(recordView);
    return { apiVersion: "1" as const, records, nextBefore: records.at(-1)?.usageId ?? query.before ?? null, hasMore: rows.length > limit };
  }

  async budget(ownerId: string, memberId: string) {
    const member = lowerUuid.parse(memberId);
    await this.member(ownerId, member);
    return this.budgetView(this.store.pool, member);
  }

  /** Sets the member's limit. The same limit again changes nothing and writes no audit row. */
  async setBudget(ownerId: string, memberId: string, input: unknown) {
    const member = lowerUuid.parse(memberId);
    const { tokenLimit } = budgetBody.parse(input);
    return this.store.transaction(async db => {
      await this.member(db, ownerId, member);
      const inserted = await db.query<BudgetRow>(`INSERT INTO birbcrew_ts.usage_budgets (owner_id,member_id,state,token_limit,revision)
        VALUES ($1,$2,'active',$3,1) ON CONFLICT (member_id) DO NOTHING RETURNING revision`, [ownerId, member, tokenLimit]);
      let revision = inserted.rows[0]?.revision;
      if (!revision) {
        const { rows: [current] } = await db.query<BudgetRow>("SELECT * FROM birbcrew_ts.usage_budgets WHERE member_id=$1 FOR UPDATE", [member]);
        if (current.state === "active" && Number(current.token_limit) === tokenLimit) return this.budgetView(db, member);
        ({ rows: [{ revision }] } = await db.query<BudgetRow>(`UPDATE birbcrew_ts.usage_budgets SET state='active', token_limit=$2,
          revision=revision+1, changed_at=clock_timestamp() WHERE member_id=$1 RETURNING revision`, [member, tokenLimit]));
      }
      await appendAudit(db, { type: "usage.budget_set", ownerId, memberId: member, payload: { revision, tokenLimit, period: "utc_day" } });
      return this.budgetView(db, member);
    });
  }

  /** Removes the member's limit. Clearing a member without one changes nothing. */
  async clearBudget(ownerId: string, memberId: string) {
    const member = lowerUuid.parse(memberId);
    return this.store.transaction(async db => {
      await this.member(db, ownerId, member);
      const { rows: [cleared] } = await db.query<BudgetRow>(`UPDATE birbcrew_ts.usage_budgets SET state='cleared', token_limit=NULL,
        revision=revision+1, changed_at=clock_timestamp() WHERE member_id=$1 AND state='active' RETURNING revision`, [member]);
      if (cleared) await appendAudit(db, { type: "usage.budget_cleared", ownerId, memberId: member, payload: { revision: cleared.revision } });
      return this.budgetView(db, member);
    });
  }

  private async budgetView(db: Queryable, memberId: string) {
    const { rows: [window] } = await db.query<WindowRow>(`SELECT ${windowUsed("$1::uuid")}::text AS used, ${windowStart} AS window_start`, [memberId]);
    const { rows: [budget] } = await db.query<BudgetRow>(
      "SELECT * FROM birbcrew_ts.usage_budgets WHERE member_id=$1 AND state='active'", [memberId]);
    const used = Number(window.used), limit = budget ? Number(budget.token_limit) : null;
    return {
      apiVersion: "1" as const, memberId,
      budget: budget ? { tokenLimit: limit!, period: "utc_day" as const, revision: budget.revision, changedAt: budget.changed_at.toISOString() } : null,
      window: { start: window.window_start.toISOString(), end: new Date(window.window_start.getTime() + 86_400_000).toISOString() },
      usedTokens: used, remainingTokens: limit === null ? null : Math.max(0, limit - used), admitting: limit === null || used < limit,
    };
  }

  private async member(...args: [string, string] | [Queryable, string, string]) {
    const [db, ownerId, memberId] = args.length === 2 ? [this.store.pool, ...args] : args;
    const found = await db.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2 FOR KEY SHARE", [ownerId, memberId]);
    if (!found.rowCount) throw new MemberStoreError("not_found");
  }
}
