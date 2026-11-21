import type { ChildOutcome } from "@birbcrew/pi-subagents";
import type { ChildKey } from "./children.ts";
import type { Approval } from "./approvals.ts";
import { z } from "zod";

import { engineSchema, childEngineSchema, boundedText, ownerText, instructionsBytes, instructionPacksPerMember, promptBytes, approvalDeadline, approvalDeadlineSeconds,
  createMemberSchema, conversationIdentitySchema, openConversationSchema, requestIdentitySchema, submitRequestSchema,
  requestInitiator, type RequestInitiator } from "@birbcrew/client/contract";
export { engineSchema, childEngineSchema, ownerText, instructionsBytes, instructionPacksPerMember, promptBytes, approvalDeadline, approvalDeadlineSeconds, requestInitiator, type RequestInitiator };
export type Engine = z.infer<typeof engineSchema>;
export type ChildEngine = z.infer<typeof childEngineSchema>;
export function isTextEngine(engine: Engine): engine is "cursor" | "opencode" {
  return engine === "cursor" || engine === "opencode";
}
/** What each engine supports beyond a plain turn. Gates read the trait they mean, so a new engine fills in one row. */
export interface EngineTraits {
  /** Hands a conversation to, or receives one from, another member. */
  readonly handoff: boolean;
  /** Runs trusted context and trusted native execution. */
  readonly trustedContext: boolean;
  /** Takes member memories, fixed context, and notes. */
  readonly memories: boolean;
  /** Takes member instructions and instruction packs at spawn. */
  readonly instructions: boolean;
  /** Reports token usage that is recorded against prices. */
  readonly meteredUsage: boolean;
}
const nativeTraits: EngineTraits = { handoff: true, trustedContext: true, memories: true, instructions: true, meteredUsage: true };
const textTraits: EngineTraits = { handoff: false, trustedContext: false, memories: false, instructions: false, meteredUsage: false };
export const engineTraits: Readonly<Record<Engine, EngineTraits>> = {
  pi: nativeTraits, claude: nativeTraits, codex: nativeTraits, cursor: textTraits, opencode: textTraits,
};
/** True when `value` holds a C0 control (0-31), or a C1 control or DEL (127-159) unless `c1` is false,
 * other than the characters in `allow`. */
export function hasControlCharacter(value: string, { c1 = true, allow = "" }: { c1?: boolean; allow?: string } = {}): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 31 || (c1 && code >= 127 && code <= 159)) && !allow.includes(value[index])) return true;
  }
  return false;
}
/** OpenCode refuses a slash command, including one later in the prompt, and C0/C1 controls other than tab, LF, and CR. */
export function opencodePromptRejected(text: string): boolean {
  if (text.split(/\r\n|\n|\r/).some((line) => line.trimStart().startsWith("/"))) return true;
  return hasControlCharacter(text, { allow: "\t\n\r" });
}
const ownerId = boundedText(256);
const uuid = requestIdentitySchema.shape.requestId;
export const spawnSchema = createMemberSchema.extend({ ownerId });
export const conversationKey = conversationIdentitySchema.extend({ ownerId });
export const openSchema = openConversationSchema.extend({ ownerId });
export const turnKey = requestIdentitySchema.extend({ ownerId });
export const submitSchema = submitRequestSchema.extend({ ownerId });
/** Only a handoff's reserved first request may exceed promptBytes. Admission checks the reservation. */
export const turnTextBytes = 65_536;
export const turnRequestSchema = submitSchema.extend({ text: boundedText(turnTextBytes) });
export const executionSchema = z.strictObject({
  workflowRunId: boundedText(256),
  activityId: boundedText(256),
  attempt: z.number().int().min(1).max(2_147_483_647),
});
export type TurnRequest = z.infer<typeof submitSchema>;
export const claimSchema = turnKey.extend({ token: uuid });

export const checkpointSchema = z.strictObject({
  version: z.literal(1),
  engine: engineSchema,
  state: z.json(),
}).refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 4 * 1024 * 1024, "Checkpoint exceeds 4 MiB");

export const commitSchema = claimSchema.extend({ reply: boundedText(65_536), checkpoint: checkpointSchema });

export const initiatorKinds = requestInitiator.options.map(option => option.shape.kind.value);
export const ownerInitiator: RequestInitiator = Object.freeze({ kind: "owner" });

/** The (initiator_kind, initiator_id) pair stored in request_admissions. */
export function initiatorColumns(initiator: RequestInitiator): [kind: RequestInitiator["kind"], id: string | null] {
  switch (initiator.kind) {
    case "owner": return ["owner", null];
    case "routine": return ["routine", initiator.id];
    case "handoff": return ["handoff", initiator.id];
  }
}

/** A stored kind this release does not know (after a rollback) is a server fault, never invalid input. */
export function initiatorFromColumns(kind: string, id: string | null): RequestInitiator {
  const initiator = requestInitiator.safeParse(id === null ? { kind } : { kind, id });
  if (!initiator.success) throw new Error("Unknown request initiator");
  return initiator.data;
}

export type Member = Pick<z.infer<typeof spawnSchema>, "ownerId" | "engine" | "profile"> & { memberId: string };
export type Conversation = Member & { conversationId: string };
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type BeginTurn =
  | { kind: "start"; conversation: Conversation; token: string; checkpoint: Checkpoint | null; childResults?: ChildOutcome[] }
  | { kind: "pending"; approval: Approval }
  | { kind: "delegated"; children: ChildKey[] }
  | { kind: "replay"; reply: string }
  | { kind: "uncertain" };

export class MemberStoreError extends Error {
  readonly code: "not_found" | "conflict" | "busy" | "stale" | "input_limit" | "history_unavailable" | "request_rejected"
    | "routine_limit" | "routine_deleted" | "memory_limit" | "memory_deleted" | "instructions_limit"
    | "handed_off" | "handoff_pending" | "handoff_empty" | "handoff_too_large" | "trusted_conversation"
    | "usage_limit" | "usage_limit_closed" | "webhook_limit" | "webhook_deleted" | "pack_limit" | "pack_deleted" | "pack_in_use" | "decision_conflict" | "decision_unverifiable";

  constructor(code: MemberStoreError["code"]) {
    super(code);
    this.name = "MemberStoreError";
    this.code = code;
  }
}

/** A text-engine admission refusal. The argument is the non-retryable Temporal type. */
export class TextAdmissionError extends MemberStoreError {
  readonly failureType: "prompt_rejected" | "input_limit";
  constructor(failureType: "prompt_rejected" | "input_limit") {
    super(failureType === "input_limit" ? "input_limit" : "conflict");
    this.name = "TextAdmissionError";
    this.failureType = failureType;
  }
}
