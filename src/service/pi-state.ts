import { delegationToolName } from "@birbcrew/pi-subagents";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { toolNameSchema, type DeferredTool } from "./deferral.ts";
import { checkpointSchema } from "./domain.ts";
import { conversationTurnLimit } from "./limits.ts";
import { nativeCall } from "./pi-tools.ts";

// What the host and its confined Pi worker must agree on: the checkpoint shapes, and the facts the host
// uses to recognise what the worker's session wrote. The session runs in pi-session.ts and
// trusted-pi-session.ts (worker only); the checks run in pi.ts and trusted-pi.ts (host only).

export const defaultInstructions = "You are a BirbCrew coworker.";
/** The mkdtemp prefixes of the sessions' working directories inside the worker's private directory. */
export const memberSessionPrefix = "birb-pi-", trustedSessionPrefix = "birb-trusted-pi-";
/** The most reply text, in bytes, a segment or trusted turn may publish. */
export const replyBytes = 65_536;

export type PiMode = "text" | DeferredTool | "delegating";
/** The proposal tool a segment offers: none for text, record_work_item beside delegation when allowed. */
export function segmentTool(mode: PiMode, allowRecordWorkItem?: boolean): DeferredTool | undefined {
  return mode === "text" ? undefined : mode === "delegating" ? (allowRecordWorkItem ? "record_work_item" : undefined) : mode;
}

/** The fields a Pi session reads. In the worker (pi-worker.ts), modelRuntime's only provider forwards to the host;
 * PiProfile (pi.ts) extends this on the host with prepare and invocationGroup, and there modelRuntime is the
 * operator's own, which makes each request (pi-launch.ts). */
export interface SessionProfile {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  instructions?: string;
  allowRecordWorkItem?: boolean;
}

/** A system entry the SDK writes into a session; the member lane names only its own tools. */
export function systemEntrySchema<Name extends z.ZodType<string>, Part extends z.ZodType<{ type: "text"; text: string }>>(name: Name, part: Part) {
  return z.strictObject({
    role: z.literal("system"), content: z.union([z.string(), z.array(part)]), timestamp: z.number(),
    sections: z.record(z.string(), z.string().nullable()).optional(),
    toolsAdded: z.array(z.looseObject({ name, description: z.string(), parameters: z.object({}).passthrough() })).optional(),
    toolsRemoved: z.array(z.object({ name })).optional(),
  });
}
export type SystemEntry = z.infer<ReturnType<typeof systemEntrySchema>>;

const textPart = z.object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() });
const thinkingPart = z.object({
  type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const tokens = {
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
};
const piToolName = z.enum([...toolNameSchema.options, delegationToolName]);
const systemMessage = systemEntrySchema(piToolName, textPart);
const userMessage = z.looseObject({
  role: z.literal("user"), timestamp: z.number(), content: z.union([z.string(), z.array(textPart)]),
});
const assistantMessage = z.looseObject({
  role: z.literal("assistant"), timestamp: z.number(), content: z.array(z.union([textPart, thinkingPart])),
  api: z.string(), provider: z.string(), model: z.string(), stopReason: z.literal("stop"),
  usage: z.looseObject({
    ...tokens, totalTokens: z.number(), cost: z.looseObject({ ...tokens, total: z.number() }),
  }),
});
const delegationCall = z.looseObject({
  type: z.literal("toolCall"), name: z.literal(delegationToolName), id: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.json()), argumentsError: z.never().optional(),
});
const proposalMessage = assistantMessage.extend({
  stopReason: z.literal("toolUse"), content: z.array(z.union([textPart, thinkingPart, nativeCall, delegationCall])),
});
const resultMessage = z.strictObject({
  role: z.literal("toolResult"), toolCallId: z.string(), toolName: piToolName,
  timestamp: z.number(), isError: z.boolean(), content: z.array(textPart).length(1),
});
const turnPrefix = z.strictObject({
  runId: z.string(), system: z.array(systemMessage).max(4), user: userMessage,
});
export const pendingTurn = turnPrefix.extend({ proposal: proposalMessage });
export const completedTurn = turnPrefix.extend({
  tool: z.union([
    z.strictObject({ proposal: proposalMessage, result: resultMessage, system: z.array(systemMessage).max(4) }),
    z.strictObject({ proposal: proposalMessage, results: z.array(resultMessage).min(1).max(2), system: z.array(systemMessage).max(4) }),
  ]).optional(),
  assistant: assistantMessage,
});
export const stateSchema = z.strictObject({
  threadId: z.string(), sessionId: z.uuid(), turns: z.array(completedTurn).max(conversationTurnLimit), pending: pendingTurn.optional(),
}).refine((s) => s.turns.length || s.pending, "Pi checkpoint has no native history");

export type PiState = z.infer<typeof stateSchema>;
type Pending = z.infer<typeof pendingTurn>;

/** A trusted application turn's Pi checkpoint: the session and its messages as the SDK stored them. */
export const trustedStateSchema = z.strictObject({ sessionId: z.uuid(), messages: z.array(z.json()).max(256) });

export function onlyCall(pending: Pending) {
  const calls = pending.proposal.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0].name === delegationToolName ||
      (calls[0].name === "record_work_item" && calls[0].arguments.operation_id !== pending.runId)) {
    throw new Error("Expected one Pi tool call for this input");
  }
  return calls[0];
}

export function privateCheckpoint(state: PiState) {
  const data = stateSchema.parse(state);
  return checkpointSchema.parse({ engine: "pi", version: 1, state: JSON.parse(JSON.stringify(data)) });
}
