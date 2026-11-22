import { randomUUID } from "node:crypto";
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
  private readonly gatewayId = randomUUID();
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
      let ticket: string | undefined;
      let poisoned = false;
      const connectionError = () => {};
      db.on("error", connectionError);
      try {
        await db.query(
          "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='2000ms'",
        );
        const locked = await db.query(
          "SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2 FOR UPDATE",
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
        if (state.content_erasure_id) {
          await db.query("COMMIT");
          committed = true;
          return { kind: state.erased_at ? "erased" : "erasing" };
        }
        ticket = randomUUID();
        await db.query(
          "INSERT INTO birbcrew_ts.content_output_reservations(output_id,conversation_id,gateway_id) VALUES($1,$2,$3)",
          [ticket, key.conversationId, this.gatewayId],
        );
        await db.query("COMMIT");
        committed = true;
        // Backend loss cannot remove this committed ticket. Fence creation refuses it
        // until synchronous enqueue has returned, or a trusted drain proves us stopped.
        signal?.throwIfAborted();
        return { kind: "retained", ...emit() };
      } catch (error) {
        poisoned = true;
        throw error;
      } finally {
        try {
          if (!committed) {
            const rollback = { text: "ROLLBACK", query_timeout: 2000 };
            await db.query(rollback);
          }
          if (ticket) {
            const cleanup = {
              text: "DELETE FROM birbcrew_ts.content_output_reservations WHERE output_id=$1 AND gateway_id=$2",
              values: [ticket, this.gatewayId],
              query_timeout: 2000,
            };
            await db.query(cleanup);
          }
        } catch (error) {
          poisoned = true;
          throw error;
        } finally {
          db.release(poisoned || !committed);
          db.off("error", connectionError);
        }
      }
    } finally {
      release();
    }
  }
}
