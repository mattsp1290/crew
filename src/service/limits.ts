// Finite public service budgets. Keep SQL migration 016 in sync.
export const conversationTurnLimit = 128;
/** A text-engine conversation runs exactly one turn (migration 042 enforces it). */
export const textConversationTurnLimit = 1;
export const workflowGenerationTurnLimit = 4;
/** How long the supervisor host lets a stopped runner end before it kills the runner's process group.
 * A native runner has nothing to close. A text runner gets longer than Cursor's 5s and OpenCode's 2s
 * close bounds so its private files are removed first. */
export const nativeStopGraceMs = 3_000;
export const textStopGraceMs = 12_000;
/** A stop waits for the runner's launch lease, which the runner holds until it exits: the grace kill,
 * groupStopped's one-second poll, and margin for the connection to close. Native: 8s, as before. */
export function stopLeaseWaitMs(textEngine: boolean) {
  return (textEngine ? textStopGraceMs : nativeStopGraceMs) + 5_000;
}
// Soft drain trigger: pending decisions remain serviceable before the run can roll.
export const workflowHistoryEventLimit = 2_000;

export function historyRequiresRollover(info: {historyLength: number; continueAsNewSuggested: boolean}): boolean {
  return info.continueAsNewSuggested || info.historyLength >= workflowHistoryEventLimit;
}
