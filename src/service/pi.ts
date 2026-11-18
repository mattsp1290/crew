import { isDeepStrictEqual } from "node:util";
import { createDelegationBatch, delegationToolName, delegationToolResults, type Delegation } from "@birbcrew/pi-subagents";
import { contentText, toToolDeclaration, type AssistantMessage, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DriverInput } from "./activities.ts";
import { nativeProposal, type DeferredTool } from "./deferral.ts";
import { proposalTool, toolResult } from "./pi-tools.ts";
import { runPiWorker } from "./pi-launch.ts";
import {
  defaultInstructions, memberSessionPrefix, onlyCall, privateCheckpoint, segmentTool, stateSchema,
  type PiMode, type SessionProfile, type SystemEntry,
} from "./pi-state.ts";
import { piUsage } from "./usage-capture.ts";

// Host side of Pi member segments. The SDK runs in a confined worker (pi-launch.ts, pi-session.ts); this
// module checks what the worker returns against the prior checkpoint and what the host relayed.

export interface PiProfile extends SessionProfile {
  /** Runs on the host. Its extension may register only provider request hooks (pi-launch.ts). */
  prepare?: () => Promise<{ extension: ExtensionFactory; verify: () => void }>;
  /** The supervised process group the confined worker joins; without it the worker gets its own group. */
  invocationGroup?: number;
}

export function runPiDelegatingSegment(input: DriverInput, profile: PiProfile) {
  return confinedSegment(input, profile, "delegating");
}

export async function runPiSegment(input: DriverInput, profile: PiProfile, tool: DeferredTool = "record_work_item") {
  const segment = await confinedSegment(input, profile, tool);
  if (segment.kind === "delegated") throw new Error("Unexpected Pi delegation in a protected session");
  return segment;
}

export async function runPiTurn(input: DriverInput, profile: PiProfile) {
  const segment = await confinedSegment(input, profile, "text");
  if (segment.kind !== "complete") throw new Error("Unexpected Pi tool proposal on a text turn");
  return { text: segment.text, checkpoint: segment.checkpoint, usage: segment.usage };
}

const piCheckpoint = z.strictObject({ version: z.literal(1), engine: z.literal("pi"), state: z.unknown() });
const workerSegment = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("complete"), text: z.string().min(1), checkpoint: piCheckpoint, usage: z.unknown() }),
  z.strictObject({ kind: z.literal("pending"), proposal: nativeProposal, checkpoint: piCheckpoint, usage: z.unknown() }),
  z.strictObject({ kind: z.literal("delegated"), proposals: z.array(z.unknown()), checkpoint: piCheckpoint, usage: z.unknown() }),
]);

// The same batch the worker's session registers, built from pi-subagents' role table on the host.
async function delegationBatch(model: string, allowRecordWorkItem: boolean) {
  const batch = createDelegationBatch({ model, allowRecordWorkItem });
  let tool: ToolDefinition | undefined;
  await batch.extension({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as unknown as ExtensionAPI);
  return { batch, tool: tool! };
}

// The child profiles come from pi-subagents' role table, as they did in process, never from the worker.
async function confirmDelegations(calls: ToolCall[], { batch, tool }: Awaited<ReturnType<typeof delegationBatch>>) {
  const execute = tool.execute as unknown as (id: string, args: unknown) => Promise<unknown>;
  for (const call of calls) await execute(call.id, call.arguments);
  return batch.confirm(calls, calls.map((call) => ({ role: "toolResult", toolName: delegationToolName,
    toolCallId: call.id, isError: false, content: [] })));
}

const untimed = <T extends { timestamp: number }>(message: T) => ({ ...message, timestamp: 0 });

/**
 * What the SDK writes into a session's system entries for this segment, so the host can recognise them. The
 * section names and forms are pi-coding-agent's (core/system-prompt.js); the session's working directory is
 * a mkdtemp of `sessionPrefix` inside the worker's private directory.
 */
export function sdkSystemEntries(expected: { instructions?: string; context?: string; directory: string; sessionPrefix: string; tools: Tool[] }) {
  const preamble = expected.instructions ?? defaultInstructions;
  const addendum = expected.context ? `<addendum>\n${expected.context}\n</addendum>` : undefined;
  const cwd = `<cwd>\n${expected.directory}/${expected.sessionPrefix}`;
  const declarations = new Map(expected.tools.map((tool) => [tool.name, toToolDeclaration(tool)]));
  return (entry: SystemEntry) => contentText(entry.content) === "" &&
    Object.entries(entry.sections ?? {}).every(([name, value]) => name === "preamble" ? value === preamble :
      name === "addendum" ? value === (addendum ?? null) :
      name === "cwd" && typeof value === "string" && value.startsWith(cwd) && /^[A-Za-z0-9]{6}\n<\/cwd>$/.test(value.slice(cwd.length))) &&
    (entry.toolsAdded ?? []).every((tool) => isDeepStrictEqual(tool, declarations.get(tool.name)));
}

/**
 * The worker made every check below too, but the host no longer trusts its answer: the result must extend
 * the prior checkpoint by exactly this request, and its reply or calls must be what the model sent through
 * this host. Usage comes from the replies the host relayed.
 */
async function confinedSegment(input: DriverInput, profile: PiProfile, mode: PiMode) {
  const { threadId, runId, text, projectContext, childResults, continuation } = input;
  const tool = segmentTool(mode, profile.allowRecordWorkItem);
  const { result, directory, observed, streamed } = await runPiWorker({
    kind: "member", mode, instructions: profile.instructions, allowRecordWorkItem: profile.allowRecordWorkItem,
    input: { threadId, runId, text, checkpoint: input.checkpoint, projectContext, childResults, continuation },
  }, { profile, signal: input.signal, modelRequests: 1, onText: input.onText, translatedText: true, onToolArgs: input.onToolArgs,
    previews: tool === "record_work_item" && !continuation && !childResults ? runId : undefined });
  const segment = workerSegment.parse(result);
  const state = stateSchema.parse(segment.checkpoint.state);
  const prior = input.checkpoint === null ? undefined : stateSchema.parse(input.checkpoint.state);
  // Compared as JSON, the form the worker's checkpoint took (JSON has no -0, for one).
  const relayed = JSON.parse(JSON.stringify(observed[0])) as AssistantMessage;
  const current = segment.kind === "complete" ? state.turns.at(-1) : state.pending;
  const message = current && ("proposal" in current ? current.proposal : current.assistant);
  const calls = relayed.content.filter((part) => part.type === "toolCall");
  const outside = () => new Error("Pi worker returned a result outside its segment");
  if (!current || !message || state.threadId !== threadId || current.runId !== runId || contentText(current.user.content) !== text ||
      (segment.kind === "complete") === Boolean(state.pending) ||
      state.turns.length !== (prior?.turns.length ?? 0) + Number(segment.kind === "complete") ||
      (prior && (state.sessionId !== prior.sessionId || !isDeepStrictEqual(state.turns.slice(0, prior.turns.length), prior.turns))) ||
      (prior?.pending && !("tool" in current && current.tool && isDeepStrictEqual(
        [current.system, current.user, current.tool.proposal], [prior.pending.system, prior.pending.user, prior.pending.proposal]))) ||
      !isDeepStrictEqual(message.content, relayed.content)) throw outside();
  // The system entries the worker added must be the SDK's own, and a resumed call's results the host's.
  const delegation = mode === "delegating" ? await delegationBatch(profile.model.id, tool === "record_work_item") : undefined;
  const sdkWritten = sdkSystemEntries({ instructions: profile.instructions, context: projectContext, directory,
    sessionPrefix: memberSessionPrefix, tools: [...(tool ? [proposalTool(runId, tool).definition] : []), ...(delegation ? [delegation.tool] : [])] });
  const resumed = "tool" in current ? current.tool : undefined;
  if (!(prior?.pending ? resumed?.system ?? [] : current.system).every(sdkWritten)) throw outside();
  if (prior?.pending) {
    const pendingCalls = prior.pending.proposal.content.filter((part) => part.type === "toolCall");
    const expected = continuation ? [toolResult(onlyCall(prior.pending), continuation)] : childResults ?
      delegationToolResults(pendingCalls.map((call) => ({ nativeCallId: call.id })), childResults, prior.pending.proposal.timestamp) : [];
    const stored = !resumed ? [] : "result" in resumed ? [resumed.result] : resumed.results;
    if (!isDeepStrictEqual(stored.map(untimed), expected.map(untimed))) throw outside();
  }
  let proposals: Delegation[] | undefined;
  if (segment.kind === "complete") {
    if (segment.text !== streamed || segment.text !== contentText(relayed.content, "") || calls.length) throw outside();
  } else if (segment.kind === "pending") {
    const { proposal } = segment;
    if (proposal.name !== tool || calls.length !== 1 || !isDeepStrictEqual([calls[0].id, calls[0].name, calls[0].arguments],
        [proposal.nativeCallId, proposal.name, proposal.arguments]) ||
        (proposal.name === "record_work_item" && proposal.arguments.operation_id !== runId)) throw outside();
  } else {
    if (!delegation) throw outside();
    proposals = await confirmDelegations(calls, delegation);
  }
  const checkpoint = privateCheckpoint(state), usage = piUsage(observed);
  return segment.kind === "delegated" ? { ...segment, proposals: proposals!, checkpoint, usage } : { ...segment, checkpoint, usage };
}
