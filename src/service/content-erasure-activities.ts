import { z } from "zod";
import { ApplicationFailure } from "@temporalio/activity";
import { conversationKey, isTextEngine, MemberStoreError } from "./domain.ts";
import {
  contentErasureState,
  finishContentErasure,
  terminalTextRequests,
  textStopProofs,
} from "./content-erasure-store.ts";
import {
  assertTextVolumeRoot,
  rootAbsent,
  pinTextStateLocation,
} from "./text-state-location.ts";
import { removePrivateDurably } from "./private-directory.ts";
import type { MemberStore } from "./store.ts";

export const erasureKeySchema = conversationKey.extend({ erasureId: z.uuid() });
export type ErasureKey = z.infer<typeof erasureKeySchema>;
export function contentErasureActivities(store: MemberStore) {
  return {
    async confirmTerminalTextRequests(input: unknown) {
      const key = conversationKey.parse(input);
      try {
        await terminalTextRequests(store.pool, key);
      } catch (error) {
        if (error instanceof MemberStoreError)
          throw ApplicationFailure.nonRetryable(error.code, error.code);
        throw error;
      }
    },
    async canCloseTextConversation(input: unknown) {
      const key = conversationKey.parse(input);
      try {
        await store.transaction(async (db) => {
          await db.query(
            "SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='2000ms'",
          );
          await contentErasureState(db, key, true);
          await terminalTextRequests(db, key);
          await textStopProofs(db, key);
        });
      } catch (error) {
        if (error instanceof MemberStoreError)
          throw ApplicationFailure.nonRetryable(error.code, error.code);
        throw error;
      }
    },
    async textClosingHint(input: unknown) {
      const key = conversationKey.parse(input);
      await store.pool.query(
        "UPDATE birbcrew_ts.conversations SET text_closing_at=COALESCE(text_closing_at,clock_timestamp()) WHERE owner_id=$1 AND conversation_id=$2 AND content_erasure_id IS NULL AND text_lifecycle='startable'",
        [key.ownerId, key.conversationId],
      );
    },
    async contentErasureLocations(input: ErasureKey) {
      const key = erasureKeySchema.parse(input),
        row = await contentErasureState(store.pool, key);
      if (row.content_erasure_id !== key.erasureId)
        throw ApplicationFailure.nonRetryable("Invalid erasure identity");
      const { rows } = await store.pool.query<{ location_id: string }>(
        "SELECT location_id FROM birbcrew_ts.conversation_content_cleanup WHERE conversation_id=$1 AND erasure_id=$2 AND cleaned_at IS NULL ORDER BY location_id",
        [key.conversationId, key.erasureId],
      );
      return rows.map((r) => r.location_id);
    },
    async finalizeContentErasure(input: ErasureKey) {
      const key = erasureKeySchema.parse(input),
        row = await contentErasureState(store.pool, key);
      if (row.content_erasure_id !== key.erasureId)
        throw ApplicationFailure.nonRetryable("Invalid erasure identity");
      if (!(await finishContentErasure(store, key)))
        throw new Error("content_erasure_pending");
    },
  };
}
export function textLocationCleanupActivity(
  store: MemberStore,
  stateDir: string,
  locationId: string,
  engine: "cursor" | "opencode",
) {
  return async function cleanTextLocation(input: ErasureKey) {
    try {
      const key = erasureKeySchema.parse(input);
      const marker = await pinTextStateLocation(stateDir, engine);
      try {
        if (marker.locationId !== locationId)
          throw new Error("content_location_unknown");
        const row = await contentErasureState(store.pool, key);
        if (
          row.content_erasure_id !== key.erasureId ||
          !isTextEngine(row.engine) ||
          row.engine !== engine
        )
          throw new Error("Invalid cleanup assignment");
        const {
          rows: [assignment],
        } = await store.pool.query<{ cleaned_at: Date | null }>(
          "SELECT cleaned_at FROM birbcrew_ts.conversation_content_cleanup WHERE conversation_id=$1 AND erasure_id=$2 AND location_id=$3",
          [key.conversationId, key.erasureId, locationId],
        );
        if (!assignment) throw new Error("Invalid cleanup assignment");
        if (assignment.cleaned_at || row.erased_at) return;
        await textStopProofs(store.pool, key);
        const root = await assertTextVolumeRoot(marker.directory, row, engine);
        try {
          await removePrivateDurably(root);
          if (!(await rootAbsent(root))) throw new Error();
        } catch {
          throw new Error("content_cleanup_failed");
        }
        await store.transaction(async (db) => {
          await contentErasureState(db, key, true);
          await textStopProofs(db, key);
          await db.query(
            "UPDATE birbcrew_ts.conversation_content_cleanup SET cleaned_at=clock_timestamp() WHERE conversation_id=$1 AND erasure_id=$2 AND location_id=$3 AND cleaned_at IS NULL",
            [key.conversationId, key.erasureId, locationId],
          );
        });
      } finally { await marker.close(); }
    } catch {
      throw new Error("content_cleanup_failed");
    }
  };
}
