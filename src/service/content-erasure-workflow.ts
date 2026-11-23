import { proxyActivities } from "@temporalio/workflow";
import type {
  contentErasureActivities,
  ErasureKey,
  textLocationCleanupActivity,
} from "./content-erasure-activities.ts";
import { textCleanupQueue } from "./queues.ts";

export async function conversationContentErasure(key: ErasureKey) {
  const control = proxyActivities<ReturnType<typeof contentErasureActivities>>({
    startToCloseTimeout: "20 seconds",
    retry: {
      initialInterval: "1 second",
      maximumInterval: "30 seconds",
      maximumAttempts: 10,
    },
  });
  await Promise.all(
    (await control.contentErasureLocations(key)).map(async (location) => {
      const { cleanTextLocation } = proxyActivities<{
        cleanTextLocation: ReturnType<typeof textLocationCleanupActivity>;
      }>({
        taskQueue: textCleanupQueue(location),
        startToCloseTimeout: "30 seconds",
        scheduleToCloseTimeout: "5 minutes",
        retry: {
          initialInterval: "1 second",
          maximumInterval: "30 seconds",
          maximumAttempts: 10,
        },
      });
      await cleanTextLocation(key);
    }),
  );
  await control.finalizeContentErasure(key);
}
