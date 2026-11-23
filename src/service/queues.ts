import type { Engine } from "./domain.ts";

export const memberTaskQueue = "birbcrew-ts-members-v1";
export function activityQueue(engine: Engine, profile: string) {
  return `${memberTaskQueue}/${engine}/${profile}`;
}
export const childWorkflowId = (childId: string) => `birbcrew-ts/child/${childId}`;
// Schema 044 also pins this format in its immutable closure evidence CHECK.
export const conversationWorkflowId = (memberId: string, conversationId: string) =>
  `birbcrew-ts/member/${memberId}/conversation/${conversationId}`;

export const textCleanupQueue = (locationId: string) => "birbcrew-ts/text-cleanup/" + locationId;
