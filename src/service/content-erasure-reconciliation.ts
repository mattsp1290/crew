import { MemberClient } from "./client.ts";
import { MemberStore } from "./store.ts";
import type { Client } from "@temporalio/client";
import type { Pool } from "pg";
import { warn } from "./diagnostics.ts";

/** Durable keyset closure capture plus restart-safe repair of fenced cleanup operations. */
export function startContentErasureReconciliation(
  pool: Pool,
  temporal: Client,
) {
  const store = new MemberStore(pool),
    members = new MemberClient(store, temporal);
  let stopped = false,
    running: Promise<void> | undefined,
    healthy = true;
  let pendingAfter: string | null = null;
  async function scan() {
    const { rows } = await store.transaction(async (db) => {
      await db.query("SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='2000ms'");
      const {
        rows: [cursor],
      } = await db.query<{ after_id: string | null }>(
        "SELECT after_id FROM birbcrew_ts.text_closure_scan WHERE singleton FOR UPDATE",
      );
      const page = await db.query<{ ownerId: string; conversationId: string }>(
        `SELECT c.owner_id AS "ownerId",c.conversation_id AS "conversationId"
        FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING(owner_id,member_id)
        WHERE m.engine IN ('cursor','opencode') AND c.text_lifecycle='startable' AND c.content_erasure_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=c.conversation_id AND t.phase='uncertain')
          AND (c.text_closing_at IS NOT NULL OR EXISTS(SELECT 1 FROM birbcrew_ts.conversation_workflow_starts s WHERE s.conversation_id=c.conversation_id AND s.state='acknowledged'))
          AND ($1::uuid IS NULL OR c.conversation_id>$1) ORDER BY c.conversation_id LIMIT 64`,
        [cursor.after_id],
      );
      await db.query(
        "UPDATE birbcrew_ts.text_closure_scan SET after_id=$1 WHERE singleton",
        [page.rows.length === 64 ? page.rows.at(-1)!.conversationId : null],
      );
      return page;
    });
    await Promise.all(
      rows.map(async (key) => {
        try {
          await members.describeClosure(key);
        } catch {
          /* Open, unresolved and expired histories stay unsealed. Never infer from age. */
        }
      }),
    );
    const pending = await pool.query<{
      ownerId: string;
      conversationId: string;
      erasureId: string;
      age: number;
      locations: string[];
    }>(
      `SELECT c.owner_id AS "ownerId",e.conversation_id AS "conversationId",e.erasure_id AS "erasureId",
      extract(epoch FROM clock_timestamp()-e.requested_at)::integer AS age,
      ARRAY(SELECT location_id::text FROM birbcrew_ts.conversation_content_cleanup x WHERE x.conversation_id=e.conversation_id AND x.cleaned_at IS NULL) AS locations
      FROM birbcrew_ts.conversation_content_erasures e JOIN birbcrew_ts.conversations c USING(conversation_id)
      WHERE e.erased_at IS NULL AND ($1::uuid IS NULL OR e.conversation_id>$1) ORDER BY e.conversation_id LIMIT 64`,
      [pendingAfter],
    );
    pendingAfter =
      pending.rows.length === 64 ? pending.rows.at(-1)!.conversationId : null;
    await Promise.all(
      pending.rows.map(async ({ age, locations, ...key }) => {
        try {
          await members.ensureCleanupWorkflow(key);
        } catch {
          warn("content_erasure_reconciliation_failed", {
            erasureId: key.erasureId,
          });
        }
        if (age > 60)
          warn("content_erasure_pending", {
            erasureId: key.erasureId,
            age,
            locationIds: locations.join(","),
          });
      }),
    );
    const lag = await pool.query(
      "SELECT 1 FROM birbcrew_ts.conversations c WHERE text_lifecycle='startable' AND text_closing_at<clock_timestamp()-interval '5 minutes' AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=c.conversation_id AND t.phase='uncertain') LIMIT 1",
    );
    healthy = true;
    if (lag.rowCount)
      warn("text_closure_observation_delayed", { code: "closure_lag" });
  }
  function tick() {
    if (stopped || running) return;
    running = scan()
      .catch(() => {
        healthy = false;
        warn("content_erasure_reconciliation_failed", { code: "scan_failed" });
      })
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return {
    healthy: () => healthy,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
