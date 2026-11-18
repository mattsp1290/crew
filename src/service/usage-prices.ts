import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { modelName, type SegmentUsage } from "./usage-capture.ts";

/** The operator's price table (docs/usage-metering.md#estimated-cost). Crew ships no prices: they
 * change, and a wrong built-in price is worse than none. A segment's estimate is computed once,
 * exactly, when its ledger row is written, and is never recomputed from a later table. */
export const priceSetting = "BIRBCREW_USAGE_PRICES_PATH";
export const priceUnit = "usd-per-million-tokens";
export const priceTableLimit = 512;

/** USD per million tokens as canonical decimal strings. Every part of the input has a rate: a part
 * the operator did not price separately costs the input rate. */
export interface Price { input: string; cachedInput: string; cacheWrite: string; output: string }
export type PriceTable = ReadonlyMap<string, Price>;

// A string, so no binary fraction enters the table: whole dollars and at most six decimal places.
const rate = z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/);
const canonicalRate = (value: unknown) => rate.safeParse(value).success;
const entry = z.strictObject({ input: rate, output: rate, cachedInput: rate.optional(), cacheWrite: rate.optional() });
// The models object passes through as JSON.parse built it, so a model named __proto__ stays an entry.
const table = z.strictObject({ version: z.literal(1), unit: z.literal(priceUnit),
  models: z.custom<Record<string, unknown>>(value => value !== null && typeof value === "object" && !Array.isArray(value)) });

/** A rate in millionths of a dollar per million tokens, which is also picodollars per token. */
const micro = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
/** `value` × 10^-scale as a decimal string without trailing zeros. */
function scaledDecimal(value: bigint, scale: number) {
  const digits = value.toString().padStart(scale + 1, "0");
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return digits.slice(0, -scale) + (fraction ? "." + fraction : "");
}
const canonical = (value: string) => scaledDecimal(micro(value), 6);

/** Every rate checked and made canonical, whether it came from the operator's file or from code: the
 * estimate is exact only for rates of this form. `invalid` names the failing entry's position. */
function checkedTable(models: readonly (readonly [string, unknown])[], invalid: (position: number) => Error): PriceTable {
  const prices = new Map<string, Price>();
  models.forEach(([name, value], index) => {
    const price = entry.safeParse(value);
    if (!modelName.safeParse(name).success || !price.success) throw invalid(index + 1);
    const { input, output, cachedInput = input, cacheWrite = input } = price.data;
    prices.set(name, { input: canonical(input), cachedInput: canonical(cachedInput), cacheWrite: canonical(cacheWrite), output: canonical(output) });
  });
  return prices;
}

/** A table built in code, such as one a trusted backend passes to runTrustedRequest, checked as
 * strictly as the operator's file. Throws on any entry that file would refuse. */
export function checkedPrices(prices: PriceTable | null): PriceTable | null {
  if (prices === null) return null;
  return checkedTable([...prices], position => new Error(`The price table has an invalid model entry at position ${position}; `
    + "rates are decimal strings of at most six decimal places, USD per million tokens"));
}

/** Reads the table at `path`; null when no path is set. Errors name the setting and the failing
 * entry's position, never the file's contents. */
export function readPrices(path: string | undefined): PriceTable | null {
  if (path === undefined || path === "") return null;
  const failure = (detail: string) => new Error(`${priceSetting} ${detail}. Expected {"version":1,"unit":"${priceUnit}",`
    + `"models":{"<model as the usage ledger records it>":{"input":"3","output":"15","cachedInput":"0.3","cacheWrite":"3.75"}}}`
    + " with rates as decimal strings of at most six decimal places; cachedInput and cacheWrite are optional");
  if (!isAbsolute(path)) throw failure("must be an absolute path");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw failure("must name a readable JSON file"); }
  const parsed = table.safeParse(raw);
  if (!parsed.success) throw failure("names a file that is not a version 1 price table");
  const models = Object.entries(parsed.data.models);
  if (!models.length || models.length > priceTableLimit) throw failure(`must price between 1 and ${priceTableLimit} models`);
  return checkedTable(models, position => failure(`has an invalid model entry at position ${position}`));
}

let loaded: PriceTable | null | undefined;
/** The table the operator named in BIRBCREW_USAGE_PRICES_PATH, read once per process: restart the
 * worker to change prices. Every process that writes ledger rows reads it this way. */
export function operatorPrices() {
  if (loaded === undefined) loaded = readPrices(process.env[priceSetting]);
  return loaded;
}

/** The estimated cost of a reported segment whose model the table prices, else null. A segment
 * with a provider-billed cost is never estimated, so billed and estimated segments never overlap.
 * Computed in integers: picodollars are exact for every rate readPrices or checkedPrices accepts. */
export function estimateCost(usage: SegmentUsage, prices: PriceTable | null): { costUsd: string; price: Price } | null {
  if (!prices || usage.state !== "reported" || usage.model === null || usage.costUsd !== null) return null;
  const price = prices.get(usage.model);
  // The exported writers take any table; a rate readPrices or checkedPrices would refuse prices nothing.
  if (!price || ![price.input, price.cachedInput, price.cacheWrite, price.output].every(canonicalRate)) return null;
  const cached = BigInt(usage.cachedInputTokens ?? 0), written = BigInt(usage.cacheWriteTokens ?? 0);
  const fresh = BigInt(usage.inputTokens) - cached - written;
  if (fresh < 0n) return null;
  const picodollars = fresh * micro(price.input) + cached * micro(price.cachedInput) + written * micro(price.cacheWrite)
    + BigInt(usage.outputTokens) * micro(price.output);
  return { costUsd: scaledDecimal(picodollars, 12), price };
}
