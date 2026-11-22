import type { Conversation } from "./domain.ts";
import { isTextEngine, MemberStoreError } from "./domain.ts";
import {
  beginContentErasure,
  contentErasureState,
  contentTombstone,
  finishContentErasure,
  preflightContentErasure,
} from "./content-erasure-store.ts";
import type { ClosureEvidence } from "./content-erasure-store.ts";
import type { MemberStore } from "./store.ts";

type Key = Pick<Conversation, "ownerId" | "conversationId">;
export interface TextErasureLifecycle {
  describeClosure(key: Key): Promise<ClosureEvidence>;
  ensureCleanupWorkflow(key: Key & { erasureId: string }): Promise<void>;
  closeTextConversation(key: Key): Promise<{
    apiVersion: "1";
    conversationId: string;
    closure: "closed" | "requested";
  }>;
}
export async function eraseConversationContent({
  store,
  lifecycle,
  key,
  deadline = Date.now() + 5_000,
}: {
  store: MemberStore;
  lifecycle: TextErasureLifecycle;
  key: Key;
  deadline?: number;
}) {
  let state = await contentErasureState(store.pool, key);
  if (!isTextEngine(state.engine))
    throw new MemberStoreError("content_erasure_unsupported");
  if (state.erased_at) return (await contentTombstone(store.pool, key))!;
  if (!state.content_erasure_id) {
    await preflightContentErasure(store, key);
    await lifecycle.describeClosure(key);
    await beginContentErasure(store, key);
    state = await contentErasureState(store.pool, key);
  }
  try {
    const finalized = await finishContentErasure(store, key);
    if (finalized) return finalized;
    await lifecycle.ensureCleanupWorkflow({
      ...key,
      erasureId: state.content_erasure_id!,
    });
    while (Date.now() < deadline) {
      const tombstone = await contentTombstone(store.pool, key);
      if (tombstone) return tombstone;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch {
    throw new MemberStoreError("content_erasure_pending");
  }
  throw new MemberStoreError("content_erasure_pending");
}
