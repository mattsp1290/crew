/** Private runner -> live host protocol. No path or content crosses it. Unknown SDK helpers
 * deliberately leave the inventory open and require the trusted installation drain. */
export function registerTextWriterGroup(processGroup: number) {
  if (!Number.isSafeInteger(processGroup) || processGroup <= 1)
    throw new Error("Invalid text writer group");
  process.send?.({ textWriterGroup: processGroup });
}
export function completeTextWriterInventory(
  groups: readonly number[] | null | undefined,
) {
  if (groups == null) return;
  for (const group of groups) registerTextWriterGroup(group);
  process.send?.({ textWriterInventoryComplete: true });
}
