import { nextStep, standingChoice } from "@birbcrew/client/contract";
import { z } from "zod";
import { turnKey } from "./domain.ts";

export const recordWorkItemArguments = z.strictObject({
  operation_id: turnKey.shape.requestId,
  note: z.string().refine((s) => s.isWellFormed() && !s.includes("\0") && Buffer.byteLength(s) <= 4096).optional(),
});
export const toolNameSchema = z.enum(["record_work_item", "choose_next_step"]);
export type DeferredTool = z.infer<typeof toolNameSchema>;
export { nextStep, standingChoice };
export const toolChoices = {
  record_work_item: ["approve", "deny"],
  choose_next_step: nextStep.options,
} as const;

export function acceptsChoice(tool: DeferredTool, choice: string) {
  return toolChoices[tool].some((allowed) => allowed === choice)
    || (tool === "record_work_item" && standingChoice.options.some((allowed) => allowed === choice));
}
export const emptyToolArguments = z.strictObject({});

export const nativeProposal = z.discriminatedUnion("name", [
  z.strictObject({ nativeCallId: z.string(), name: z.literal("record_work_item"), arguments: recordWorkItemArguments }),
  z.strictObject({ nativeCallId: z.string(), name: z.literal("choose_next_step"), arguments: emptyToolArguments }),
]);

const nativeCallId = z.string().min(1).max(256);
export const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ nativeCallId, kind: z.literal("recorded"), receipt: z.strictObject({ receiptId: z.uuid(), operationId: z.uuid() }) }),
  z.strictObject({ nativeCallId, kind: z.literal("answered"), choice: nextStep }),
  z.strictObject({ nativeCallId, kind: z.enum(["denied", "cancelled", "budget_exhausted"]) }),
]);

export type ToolOutcome = z.infer<typeof outcomeSchema>;

export function matchesTool(tool: DeferredTool, result: ToolOutcome, operationId: unknown) {
  if (result.kind === "cancelled") return true;
  if (tool === "choose_next_step") return result.kind === "answered";
  return result.kind !== "answered" && (result.kind !== "recorded" || result.receipt.operationId === operationId);
}

export function nativeResult(result: ToolOutcome) {
  return result.kind === "answered" ? result.choice : JSON.stringify(result);
}
