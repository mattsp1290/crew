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
  private readonly acknowledgements = new Set<string>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private retrying: Promise<void> | undefined;
  private stopped = false;
  private readonly pool: Pool;
  private readonly gatewayId = randomUUID();
  constructor(pool: Pool) {
    this.pool = pool;
  }
  private async connect(): Promise<PoolClient> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acquisition = this.pool.connect();
    try {
      return await Promise.race([
        acquisition,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Content output connection deadline")),
            2000,
          );
        }),
      ]);
    } catch (error) {
      void acquisition.then(
        (db) => db.release(true),
        () => {},
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async acknowledge(db: PoolClient, outputId: string) {
    const statement = {
      text: "DELETE FROM birbcrew_ts.content_output_reservations WHERE output_id=$1 AND gateway_id=$2",
      values: [outputId, this.gatewayId],
      query_timeout: 2000,
    };
    await db.query(statement);
  }
  private retryAcknowledgement(outputId: string) {
    this.acknowledgements.add(outputId);
    warn("content_output_acknowledgement_delayed", { code: "retrying" });
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.retrying) return;
      this.retrying = (async () => {
        for (const id of this.acknowledgements) {
          let db: PoolClient | undefined;
          const connectionError = () => {};
          try {
            db = await this.connect();
            db.on("error", connectionError);
            await this.acknowledge(db, id);
            this.acknowledgements.delete(id);
            db.release();
            db.off("error", connectionError);
            db = undefined;
          } catch {
            db?.release(true);
            db?.off("error", connectionError);
            break;
          }
        }
        if (!this.acknowledgements.size) {
          clearInterval(this.retryTimer);
          this.retryTimer = undefined;
        }
      })().finally(() => {
        this.retrying = undefined;
      });
    }, 1000);
    this.retryTimer.unref();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.retryTimer);
    await this.retrying;
  }
  async enqueue(
    key: { ownerId: string; conversationId: string },
    emit: () => Enqueued,
    signal?: AbortSignal,
  ): Promise<Output> {
    let release!: () => void;
    const previous = this.tails.get(key.conversationId) ?? Promise.resolve();
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    this.tails.set(key.conversationId, tail);
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
          // Once COMMIT is acknowledged, this process can prove that emit either
          // returned or will never run. Retry its own release without failing a
          // frame already delivered. Ambiguous COMMIT tickets stay fail-closed.
          if (committed && ticket) this.retryAcknowledgement(ticket);
        } finally {
          db.release(poisoned || !committed);
          db.off("error", connectionError);
        }
      }
    } finally {
      release();
      void tail.then(() => {
        if (this.tails.get(key.conversationId) === tail)
          this.tails.delete(key.conversationId);
      });
    }
  }
}
