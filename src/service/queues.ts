import type { Engine } from "./domain.ts";

export const memberTaskQueue = "birbcrew-ts-members-v1";
export function activityQueue(engine: Engine, profile: string) {
  return `${memberTaskQueue}/${engine}/${profile}`;
}
export const childWorkflowId = (childId: string) => `birbcrew-ts/child/${childId}`;
export const conversationWorkflowId = (memberId: string, conversationId: string) =>
  `birbcrew-ts/member/${memberId}/conversation/${conversationId}`;
