import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const delegationToolName = "delegate_task";

function boundedText(maxBytes: number) {
  return z.string().min(1).refine((value) =>
    value.isWellFormed() && !value.includes("\0") && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes);
}

const nativeCallId = boundedText(256);
const task = boundedText(4096);
const argumentsSchema = z.strictObject({ role: z.enum(["analyst", "recorder"]), task });
type Arguments = z.infer<typeof argumentsSchema>;
const callSchema = z.looseObject({
  type: z.literal("toolCall"), name: z.literal(delegationToolName), id: nativeCallId, arguments: argumentsSchema,
  argumentsError: z.never().optional(),
});
const receiptSchema = z.looseObject({
  role: z.literal("toolResult"), toolName: z.literal(delegationToolName), toolCallId: nativeCallId,
  isError: z.literal(false), content: z.tuple([]),
});
export const fixedRoles = {
  analyst: { instructions: "Answer the assigned question using only the supplied task context.", tools: [] },
  recorder: { instructions: "Complete the assigned task. Request owner approval to record a work item when asked.",
    tools: ["record_work_item"] },
} as const;

interface Policy {
  model: string;
  allowRecordWorkItem: boolean;
}

function register(pi: ExtensionAPI, allowRecordWorkItem: boolean, accept: (id: string, args: Arguments) => void) {
  const definition: ToolDefinition = {
    name: delegationToolName,
    label: "Delegate task",
    description: "Assign a bounded task to one child coworker.",
    parameters: {
      type: "object", additionalProperties: false, required: ["role", "task"],
      properties: {
        role: { type: "string", enum: allowRecordWorkItem ? ["analyst", "recorder"] : ["analyst"] },
        task: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    prepareArguments: (raw) => argumentsSchema.parse(raw),
    async execute(id, raw, signal) {
      signal?.throwIfAborted();
      const args = argumentsSchema.parse(raw);
      if (args.role === "recorder" && !allowRecordWorkItem) throw new Error("Child role exceeds parent tools");
      accept(nativeCallId.parse(id), args);
      return { content: [], details: {}, terminate: true };
    },
  };
  pi.registerTool(definition);
}

export default function extension(pi: ExtensionAPI) {
  register(pi, false, () => { throw new Error("Delegation needs a BirbCrew host"); });
}

export function createDelegationBatch({ model, allowRecordWorkItem }: Policy) {
  const pinnedModel = boundedText(256).parse(model);
  const accepted = new Map<string, Arguments>();
  const extension: ExtensionFactory = (pi) => register(pi, allowRecordWorkItem, (id, args) => {
    if (accepted.has(id) || accepted.size === 2) throw new Error("Duplicate call or sibling limit exceeded");
    accepted.set(id, args);
  });

  function confirm(nativeCalls: unknown, nativeReceipts: unknown) {
    const calls = z.array(callSchema).min(1).max(2).parse(nativeCalls);
    const receipts = z.array(receiptSchema).min(1).max(2).parse(nativeReceipts);
    const confirmedIds = new Set(receipts.map((receipt) => receipt.toolCallId));
    if (calls.length !== accepted.size || calls.length !== receipts.length) throw new Error("Incomplete delegation batch");
    return calls.map((call) => {
      const { role, task } = call.arguments;
      const executed = accepted.get(call.id);
      if (!confirmedIds.delete(call.id) || executed?.role !== role || executed.task !== task) {
        throw new Error("Delegation did not match its native receipt");
      }
      const { instructions, tools } = fixedRoles[role];
      return { nativeCallId: call.id, task, profile: { role, version: 1 as const, instructions, model: pinnedModel, tools: [...tools] } };
    });
  }
  return { extension, confirm };
}

export type Delegation = ReturnType<ReturnType<typeof createDelegationBatch>["confirm"]>[number];

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed"), nativeCallId, text: boundedText(16384) }),
  z.strictObject({ kind: z.literal("failed"), nativeCallId, code: z.enum(["child_failed", "budget_exhausted"]) }),
  z.strictObject({ kind: z.literal("cancelled"), nativeCallId }),
]);
export type ChildOutcome = z.infer<typeof outcomeSchema>;

export function delegationToolResults(
  proposals: ReadonlyArray<Pick<Delegation, "nativeCallId">>, outcomes: unknown, timestamp: number,
): ToolResultMessage[] {
  const replies = z.array(outcomeSchema).min(1).max(2).parse(outcomes);
  z.number().int().nonnegative().parse(timestamp);
  const byId = new Map(replies.map((reply) => [reply.nativeCallId, reply]));
  if (replies.length !== proposals.length) throw new Error("Child results do not match the delegation batch");
  return proposals.map(({ nativeCallId }) => {
    const reply = byId.get(nativeCallId);
    if (!reply || !byId.delete(nativeCallId)) throw new Error("Missing or duplicate child result");
    return { role: "toolResult", toolName: delegationToolName, toolCallId: nativeCallId,
      content: [{ type: "text", text: JSON.stringify(reply) }], isError: reply.kind !== "completed", timestamp };
  });
}
