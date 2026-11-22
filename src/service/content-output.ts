import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryConfig, QueryResultRow } from "pg";
import { warn } from "./diagnostics.ts";
import { MemberStoreError } from "./domain.ts";

type Enqueued = { backpressure: boolean };
type Output =
  | { kind: "retained"; backpressure: boolean }
  | { kind: "erasing" | "erased" };
/** Serialize each conversation before acquiring a connection. No socket waits in SQL. */
export class ConversationContentOutput {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly acknowledgements = new Map<string, string>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private retrying: Promise<void> | undefined;
  private stopped = false;
  private readonly pool: Pool;
  private readonly gatewayId = randomUUID();
  constructor(pool: Pool) {
    this.pool = pool;
  }
  private async connect(): Promise<PoolClient> {
    // Configure checkout only after authorization, when output actually needs SQL.
    // pg removes expired waiters; an external Promise race cannot.
    const options = this.pool.options;
    options.connectionTimeoutMillis = Math.min(options.connectionTimeoutMillis || 2000, 2000);
    return this.pool.connect();
  }
  private async acknowledge(db: PoolClient, outputId: string) {
    const statement = {
      text: "DELETE FROM birbcrew_ts.content_output_reservations WHERE output_id=$1 AND gateway_id=$2",
      values: [outputId, this.gatewayId],
      query_timeout: 2000,
    };
    await db.query(statement);
  }
  private retryAcknowledgement(outputId: string, conversationId: string) {
    this.acknowledgements.set(outputId, conversationId);
    warn("content_output_acknowledgement_delayed", { code: "retrying" });
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.retrying) return;
      this.retrying = this.flushAcknowledgements().finally(() => {
        this.retrying = undefined;
      });
    }, 1000);
    this.retryTimer.unref();
  }
  private async flushAcknowledgements() {
    for (const [id, conversationId] of this.acknowledgements) {
      let db: PoolClient | undefined;
      const connectionError = () => {};
      try {
        db = await this.connect();
        db.on("error", connectionError);
        // The abandoned frame can never emit. Serialize with its original
        // transaction so DELETE cannot miss a reservation still committing.
        const begin = {
          text: "BEGIN; SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='2000ms'",
          query_timeout: 2000,
        };
        await db.query(begin);
        const lock = {
          text: "SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE",
          values: [conversationId],
          query_timeout: 2000,
        };
        await db.query(lock);
        await this.acknowledge(db, id);
        const commit = { text: "COMMIT", query_timeout: 2000 };
        await db.query(commit);
        this.acknowledgements.delete(id);
        db.release();
        db.off("error", connectionError);
        db = undefined;
      } catch {
        db?.release(true);
        db?.off("error", connectionError);
        continue;
      }
    }
    if (!this.acknowledgements.size) {
      clearInterval(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.retryTimer);
    await this.retrying;
    await this.flushAcknowledgements();
  }
  async enqueue(
    key: { ownerId: string; conversationId: string },
    emit: () => Enqueued,
    signal?: AbortSignal,
  ): Promise<Output> {
    const queueKey = key.conversationId.toLowerCase();
    let release!: () => void;
    const previous = this.tails.get(queueKey) ?? Promise.resolve();
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    this.tails.set(queueKey, tail);
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
      const db = await this.connect();
      const query = <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: QueryConfig["values"],
      ) => {
        const statement = { text, values, query_timeout: 2000 };
        return db.query<Row>(statement);
      };
      let committed = false;
      let ticket: string | undefined;
      let poisoned = false;
      const connectionError = () => {};
      db.on("error", connectionError);
      try {
        await query(
          "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='2000ms'",
        );
        const locked = await query(
          "SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2 FOR UPDATE",
          [key.ownerId, key.conversationId],
        );
        if (!locked.rowCount) throw new MemberStoreError("not_found");
        // Fresh statement after the lock: a fence committed while the lock was pending is visible.
        const {
          rows: [state],
        } = await query<{
          content_erasure_id: string | null;
          erased_at: Date | null;
        }>(
          `SELECT c.content_erasure_id,e.erased_at FROM birbcrew_ts.conversations c
          LEFT JOIN birbcrew_ts.conversation_content_erasures e USING(conversation_id) WHERE c.conversation_id=$1`,
          [key.conversationId],
        );
        signal?.throwIfAborted();
        if (state.content_erasure_id) {
          await query("COMMIT");
          committed = true;
          return { kind: state.erased_at ? "erased" : "erasing" };
        }
        ticket = randomUUID();
        await query(
          "INSERT INTO birbcrew_ts.content_output_reservations(output_id,conversation_id,gateway_id) VALUES($1,$2,$3)",
          [ticket, key.conversationId, this.gatewayId],
        );
        await query("COMMIT");
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
          if (ticket) await this.acknowledge(db, ticket);
        } catch {
          poisoned = true;
          // Emit returned or this frame has been irrevocably abandoned. A live
          // owner can release either ticket after serializing with its transaction.
          if (ticket) this.retryAcknowledgement(ticket, key.conversationId);
        } finally {
          db.release(poisoned || !committed);
          db.off("error", connectionError);
        }
      }
    } finally {
      release();
      void tail.then(() => {
        if (this.tails.get(queueKey) === tail) this.tails.delete(queueKey);
      });
    }
  }
}
