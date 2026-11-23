import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { promptBytes, requestTextBytesSchema } from "@birbcrew/client/contract";
import { hasControlCharacter } from "./domain.ts";

export const textModelSchema = z.string().refine(value => value.trim() === value && value.length > 0
  && value.length <= 256 && !/\p{Cs}/u.test(value) && !hasControlCharacter(value));
export const textApiKeySchema = z.string().refine(value => value.trim() === value && value.length > 0
  && value.length <= 512 && !hasControlCharacter(value, { c1: false }));
export const textIdentifierSchema = z.string().refine(value => value.trim().length > 0 && value.length <= 1024
  && !hasControlCharacter(value));
export const textPathSchema = textIdentifierSchema.refine(value => isAbsolute(value) && resolve(value) === value);
export const textEnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const textEnvValueSchema = z.string().refine(value => !hasControlCharacter(value, { c1: false }));

export const cursorProfileSchema = z.strictObject({
  model: textModelSchema, apiKey: textApiKeySchema, cwd: textPathSchema,
  runtime: z.custom<NonNullable<import("./cursor-turn.ts").CursorProfile["runtime"]>>(value => typeof value === "function").optional(),
});
export const opencodeProfileSchema = z.strictObject({
  model: textModelSchema, executable: textPathSchema, cwd: textPathSchema, account: textIdentifierSchema,
  env: z.record(textEnvNameSchema, textEnvValueSchema),
  spawn: z.custom<NonNullable<import("./opencode-turn.ts").OpenCodeProfile["spawn"]>>(value => typeof value === "function").optional(),
});

/** Stored authority failures are server faults, never caller validation errors. */
export function storedRequestTextBytes(value: unknown): number {
  const parsed = requestTextBytesSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid stored request-text policy");
  return parsed.data;
}

/** A missing profile keeps the historical default; a registered invalid value is a fault. */
export function effectiveRequestTextBytes(profile: { request_text_bytes: unknown } | undefined) {
  return profile ? storedRequestTextBytes(profile.request_text_bytes) : promptBytes;
}
