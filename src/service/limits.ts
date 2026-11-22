// Finite public service budgets. Keep SQL migration 016 in sync.
export const conversationTurnLimit = 128;
/** A text-engine conversation runs exactly one turn (migration 042 enforces it). */
export const textConversationTurnLimit = 1;
export const workflowGenerationTurnLimit = 4;
// Soft drain trigger: pending decisions remain serviceable before the run can roll.
export const workflowHistoryEventLimit = 2_000;

export function historyRequiresRollover(info: {historyLength: number; continueAsNewSuggested: boolean}): boolean {
  return info.continueAsNewSuggested || info.historyLength >= workflowHistoryEventLimit;
}
