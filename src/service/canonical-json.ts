import { createHash } from "node:crypto";

/** The one canonical JSON encoding: object keys in UTF-16 code unit order, no whitespace. The
 * trusted lane's digests, the capability digest and the tool catalog's argument digest all use
 * it. Pass only JSON values (parsed or schema-validated): a key holding `undefined` is not JSON. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string,unknown>)[k])).join(",") + "}";
}

/** Lowercase hexadecimal SHA-256 of the canonical encoding. */
export const canonicalDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Whether parsed JSON holds an own `__proto__` key within `depth` levels. JSON.parse makes
 * one, and zod drops it from a strict object without refusing it. Nothing is polluted, but a
 * schema that refuses unknown keys must refuse this one too. */
export function hasProtoKey(value: unknown, depth = 4): boolean {
  if (typeof value !== "object" || value === null || depth < 0) return false;
  return Object.hasOwn(value, "__proto__") || Object.values(value).some(inner => hasProtoKey(inner, depth - 1));
}
