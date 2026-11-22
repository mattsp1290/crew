import type { Pool } from "pg";
import { MemberStoreError } from "./domain.ts";

type Enqueued = { backpressure: boolean };
type Output =
  | { kind: "retained"; backpressure: boolean }
  | { kind: "erasing" | "erased" };
/** One active guard per gateway, acquired before a connection. No socket waits in SQL. */
export class ConversationContentOutput {
  private tail: Promise<void> = Promise.resolve();
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async enqueue(
    key: { ownerId: string; conversationId: string },
    emit: () => Enqueued,
    signal?: AbortSignal,
  ): Promise<Output> {
    let release!: () => void;
    const previous = this.tail;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => next);
    try {
      if (signal) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          previous.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, reject);
        });
      } else await previous;
      signal?.throwIfAborted();
      const db = await this.pool.connect();
      let committed = false;
      try {
        await db.query(
          "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='2000ms'",
        );
        const locked = await db.query(
          "SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2 FOR SHARE",
          [key.ownerId, key.conversationId],
        );
        if (!locked.rowCount) throw new MemberStoreError("not_found");
        // Fresh statement after the lock: a fence committed while the lock was pending is visible.
        const {
          rows: [state],
        } = await db.query<{
          content_erasure_id: string | null;
          erased_at: Date | null;
        }>(
          `SELECT c.content_erasure_id,e.erased_at FROM birbcrew_ts.conversations c
          LEFT JOIN birbcrew_ts.conversation_content_erasures e USING(conversation_id) WHERE c.conversation_id=$1`,
          [key.conversationId],
        );
        signal?.throwIfAborted();
        const result: Output = state.content_erasure_id
          ? { kind: state.erased_at ? "erased" : "erasing" }
          : { kind: "retained", ...emit() };
        await db.query("COMMIT");
        committed = true;
        return result;
      } finally {
        db.release(!committed);
      }
    } finally {
      release();
    }
  }
}
