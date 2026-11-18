import { z } from "zod";

// What one native segment's SDK reported, normalised across engines (docs/usage-metering.md).
// inputTokens counts every input token the model read, cache reads and writes included;
// cachedInputTokens and cacheWriteTokens are parts of it as each SDK reports them.
// outputTokens includes reasoningTokens. A field the SDK does not report is null, never 0.
// costUsd is only a provider-billed cost; SDK and catalog estimates are never kept.
const count = z.int().min(0).max(2_147_483_647);
// 256 UTF-8 bytes, as the ledger's CHECK counts them.
export const modelName = z.string().min(1).refine(text => Buffer.byteLength(text) <= 256 && !/[\p{Cc}]/u.test(text));
const model = modelName.nullable();
export const segmentUsage = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("reported"), model,
    inputTokens: count, outputTokens: count,
    cachedInputTokens: count.nullable(), cacheWriteTokens: count.nullable(), reasoningTokens: count.nullable(),
    costUsd: z.number().min(0).max(1_000_000).nullable(),
  }),
  z.strictObject({ state: z.literal("unknown"), model }),
]);
export type SegmentUsage = z.infer<typeof segmentUsage>;

const unknown = (name: string | null = null): SegmentUsage => ({ state: "unknown", model: name });

/** The model.invoke span's usage attributes: the state and, when reported, the two counts the
 * budget uses. Never the model name or cost, which the trace has no need for. */
export function usageAttributes(usage: SegmentUsage = unknown()): Record<string, string | number> {
  return usage.state === "reported"
    ? { "usage.state": "reported", "usage.input_tokens": usage.inputTokens, "usage.output_tokens": usage.outputTokens }
    : { "usage.state": "unknown" };
}
const reportedModel = (value: unknown) => model.safeParse(typeof value === "string" ? value : null).data ?? null;
const tokens = (value: unknown) => count.safeParse(value).success ? value as number : undefined;

/** Builds the reported shape, or unknown when a required count is missing or out of range. A model
 * call always reads input, so zero input means the provider sent no usage and the SDK defaulted it. */
function reported(name: string | null, fields: { input?: number; output?: number; cached?: number | null;
  cacheWrite?: number | null; reasoning?: number | null; cost?: number | null }): SegmentUsage {
  const parsed = segmentUsage.safeParse({ state: "reported", model: name, inputTokens: fields.input, outputTokens: fields.output,
    cachedInputTokens: fields.cached ?? null, cacheWriteTokens: fields.cacheWrite ?? null,
    reasoningTokens: fields.reasoning ?? null, costUsd: fields.cost ?? null });
  return parsed.success && fields.input! > 0 ? parsed.data : unknown(name);
}

const piMessage = z.looseObject({
  role: z.literal("assistant"), model: z.unknown().optional(), responseModel: z.unknown().optional(),
  usage: z.looseObject({
    input: z.unknown(), output: z.unknown(), cacheRead: z.unknown(), cacheWrite: z.unknown(), reasoning: z.unknown().optional(),
    cost: z.looseObject({ total: z.unknown(), totalFromProvider: z.unknown().optional() }).optional(),
  }),
});

/** The one model every call names, else null: an operator's price is keyed on it, so a segment whose
 * calls disagree has no model to price. */
function sameModel(names: readonly unknown[]) {
  const distinct = new Set(names.map(reportedModel));
  return distinct.size === 1 ? [...distinct][0] : null;
}

/** Pi (pi-ai): every assistant message carries the usage of the model call that produced it. Its
 * `input` excludes cache reads and writes. Its cost is a catalog estimate unless
 * `totalFromProvider` is true; the segment keeps a cost only when every call has a billed one. The
 * model is the one that answered: pi-ai sets `responseModel` when the provider names another model
 * than the one requested, as a router or a fallback does. */
export function piUsage(messages: readonly unknown[]): SegmentUsage {
  const calls = messages.map(message => piMessage.safeParse(message));
  const name = sameModel(calls.map(call => typeof call.data?.responseModel === "string" ? call.data.responseModel : call.data?.model));
  if (!calls.length || calls.some(call => !call.success)) return unknown(name);
  const sum = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 as number | null, cost: 0 as number | null };
  for (const { data } of calls) {
    const { input, output, cacheRead, cacheWrite, reasoning, cost } = data!.usage;
    const values = [tokens(input), tokens(output), tokens(cacheRead), tokens(cacheWrite)];
    if (values.some(value => value === undefined)) return unknown(name);
    sum.input += values[0]! + values[2]! + values[3]!;
    sum.output += values[1]!;
    sum.cached += values[2]!;
    sum.cacheWrite += values[3]!;
    sum.reasoning = sum.reasoning === null || tokens(reasoning) === undefined ? null : sum.reasoning + (reasoning as number);
    const billed = cost?.totalFromProvider === true && typeof cost.total === "number" && Number.isFinite(cost.total) ? cost.total : null;
    sum.cost = sum.cost === null || billed === null ? null : sum.cost + billed;
  }
  return reported(name, sum);
}

const claudeResult = z.looseObject({
  usage: z.looseObject({
    input_tokens: z.unknown(), output_tokens: z.unknown(),
    cache_read_input_tokens: z.unknown().optional(), cache_creation_input_tokens: z.unknown().optional(),
  }),
});

/** Claude (Agent SDK through the AG-UI adapter): RUN_FINISHED carries the query's result usage,
 * which covers the main loop of this one query() call. Anthropic counts cache reads and writes
 * apart from input_tokens. The SDK's total_cost_usd is a price-table estimate, so no cost. */
export function claudeUsage(result: unknown, initModel: unknown): SegmentUsage {
  const name = reportedModel(initModel);
  const parsed = claudeResult.safeParse(result);
  if (!parsed.success) return unknown(name);
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = parsed.data.usage;
  const input = tokens(input_tokens), read = tokens(cache_read_input_tokens ?? 0), write = tokens(cache_creation_input_tokens ?? 0);
  if (input === undefined || read === undefined || write === undefined) return unknown(name);
  return reported(name, { input: input + read + write, output: tokens(output_tokens), cached: read, cacheWrite: write });
}

const codexFields = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"] as const;
const codexTotal = z.looseObject({ input_tokens: z.unknown(), output_tokens: z.unknown() });

/** The running total a Codex rollout holds: the last token_count event's total_token_usage. Null
 * when the thread has recorded none yet; undefined when a line cannot be read. */
export function codexRolloutTotal(lines: readonly string[]): Record<string, unknown> | null | undefined {
  let total: Record<string, unknown> | null = null;
  for (const line of lines) {
    let entry: { type?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: unknown } | null } };
    try { entry = JSON.parse(line); } catch { return undefined; }
    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count" || !entry.payload.info) continue;
    const parsed = codexTotal.safeParse(entry.payload.info.total_token_usage);
    if (!parsed.success) return undefined;
    total = parsed.data;
  }
  return total;
}

/** The model of a Codex rollout's last turn: CLI 0.167.1 writes a turn_context entry naming it after
 * each task_started. Null when that turn names none, or names more than one. */
export function codexRolloutModel(lines: readonly string[]): string | null {
  const names: unknown[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; payload?: { type?: unknown; model?: unknown } };
    try { entry = JSON.parse(lines[i]); } catch { return null; }
    if (entry?.type === "event_msg" && entry.payload?.type === "task_started") return names.length ? sameModel(names) : null;
    if (entry?.type === "turn_context") names.push(entry.payload?.model);
  }
  return null;
}

/** Codex (SDK 0.167.1 turn.completed): the usage is the native thread's running total, carried
 * across resumed turns, so this turn's share is the total less the one the prior rollout ended
 * on. Responses API counts: input_tokens already includes the cached tokens and output_tokens
 * the reasoning tokens. Codex reports no cost, and names the model only in its rollout. */
export function codexUsage(total: unknown, prior: Record<string, unknown> | null | undefined, name: string | null = null): SegmentUsage {
  const now = codexTotal.safeParse(total);
  if (!now.success || prior === undefined) return unknown(name);
  const share = (field: typeof codexFields[number]) => {
    const after = tokens(now.data[field]), before = tokens(prior?.[field] ?? 0);
    return after === undefined || before === undefined || after < before ? undefined : after - before;
  };
  // A part of the input or output that cannot be read is left out; the counts themselves must be sound.
  return reported(name, { input: share("input_tokens"), output: share("output_tokens"),
    cached: share("cached_input_tokens") ?? null, cacheWrite: share("cache_write_input_tokens") ?? null,
    reasoning: share("reasoning_output_tokens") ?? null });
}

/** A trusted Claude request runs one query per tool round trip, and its one row is their sum. Any
 * query that reported nothing usable makes the whole request unknown, and a part one query leaves
 * out is left out of the sum. */
export function combinedUsage(parts: readonly SegmentUsage[]): SegmentUsage {
  const name = sameModel(parts.map(part => part.model));
  const counted = parts.flatMap(part => part.state === "reported" ? [part] : []);
  if (!parts.length || counted.length !== parts.length) return unknown(name);
  type Part = "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens" | "costUsd";
  const sum = (field: Part) => counted.every(part => part[field] !== null) ? counted.reduce((total, part) => total + part[field]!, 0) : null;
  return reported(name, { input: sum("inputTokens")!, output: sum("outputTokens")!, cached: sum("cachedInputTokens"),
    cacheWrite: sum("cacheWriteTokens"), reasoning: sum("reasoningTokens"), cost: sum("costUsd") });
}
