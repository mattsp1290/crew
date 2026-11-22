import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { conversationContentTombstoneSchema } from "@birbcrew/client/contract";
import { appendAudit } from "./audit.ts";
import {
  conversationKey,
  isTextEngine,
  MemberStoreError,
  type Conversation,
} from "./domain.ts";
import { requestStatusFromRow } from "./request-status.ts";
import type { MemberStore } from "./store.ts";

type Key = Pick<Conversation, "ownerId" | "conversationId">;
export type ClosureEvidence = {
  workflowId: string;
  runId: string;
  status: string;
  namespace: string;
  generation: string;
};
async function erasureTransaction<T>(
  store: MemberStore,
  action: (db: PoolClient) => Promise<T>,
) {
  return store.transaction(async (db) => {
    await db.query(
      "SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='2000ms'",
    );
    return action(db);
  });
}
export const terminalWorkflowStatuses = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "CANCELED",
  "TERMINATED",
  "TIMED_OUT",
];

export async function assertContentWritable(
  db: Pool | PoolClient,
  key: Key,
  lock = true,
) {
  const {
    rows: [row],
  } = await db.query<{ content_erasure_id: string | null }>(
    `SELECT content_erasure_id FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [key.ownerId, key.conversationId],
  );
  if (!row) throw new MemberStoreError("not_found");
  if (row.content_erasure_id) throw new MemberStoreError("conversation_erased");
}

export async function contentErasureState(
  db: Pool | PoolClient,
  input: Key,
  lock = false,
) {
  const key = conversationKey.parse({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
  });
  const {
    rows: [row],
  } = await db.query<
    Conversation & {
      content_erasure_id: string | null;
      erased_at: Date | null;
      terminal_phase: "complete" | "failed" | "cancelled" | null;
      text_location_inventory_complete: boolean;
      text_lifecycle: "startable" | "sealed_closed";
      text_start_generation: string;
      text_closure: ClosureEvidence | null;
    }
  >(
    `SELECT c.owner_id AS "ownerId",c.conversation_id AS "conversationId",c.member_id AS "memberId",m.engine,m.profile,
    c.content_erasure_id,e.erased_at,e.terminal_phase,c.text_location_inventory_complete,c.text_lifecycle,c.text_start_generation,c.text_closure
    FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING(owner_id,member_id)
    LEFT JOIN birbcrew_ts.conversation_content_erasures e USING(conversation_id)
    WHERE c.owner_id=$1 AND c.conversation_id=$2 ${lock ? "FOR UPDATE OF c" : ""}`,
    [key.ownerId, key.conversationId],
  );
  if (!row) throw new MemberStoreError("not_found");
  return row;
}
export async function contentTombstone(db: Pool | PoolClient, key: Key) {
  const row = await contentErasureState(db, key);
  if (!row.content_erasure_id || !row.erased_at) return null;
  return conversationContentTombstoneSchema.parse({
    apiVersion: "1",
    conversationId: row.conversationId,
    memberId: row.memberId,
    engine: row.engine,
    erasureId: row.content_erasure_id,
    erased: true,
    erasedAt: row.erased_at.toISOString(),
  });
}

/** The same predicate drives natural completion, safe close and fence/finalization checks. */
export async function terminalTextRequests(db: Pool | PoolClient, key: Key) {
  const row = await contentErasureState(db, key);
  if (!isTextEngine(row.engine))
    throw new MemberStoreError("content_erasure_unsupported");
  const { rows } = await db.query<{
    request_id: string;
    admission: string | null;
    reason: string | null;
    phase: string | null;
  }>(
    `SELECT COALESCE(a.request_id,t.request_id) AS request_id,a.phase AS admission,a.reason,t.phase
    FROM birbcrew_ts.request_admissions a FULL JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
    WHERE COALESCE(a.conversation_id,t.conversation_id)=$1`,
    [key.conversationId],
  );
  if (
    !rows.length ||
    rows.some(
      (r) =>
        r.phase === "started" ||
        r.phase === "uncertain" ||
        !["completed", "failed", "cancelled"].includes(requestStatusFromRow(r)),
    )
  )
    throw new MemberStoreError("content_requests_unresolved");
  return rows;
}
export async function textStopProofs(db: Pool | PoolClient, key: Key) {
  const {
    rows: [bad],
  } = await db.query(
    `SELECT 1 FROM birbcrew_ts.native_launches n
    LEFT JOIN birbcrew_ts.text_runtime_cleanup_proofs p USING(conversation_id,request_id,token)
    LEFT JOIN birbcrew_ts.text_conversation_locations l ON l.conversation_id=n.conversation_id AND l.location_id=p.location_id
    WHERE n.conversation_id=$1 AND (NOT n.stopped OR p.confirmed_at IS NULL OR l.location_id IS NULL)
    UNION ALL SELECT 1 FROM birbcrew_ts.request_admissions a WHERE a.conversation_id=$1
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=a.conversation_id AND n.request_id=a.request_id)
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.text_request_no_launch_proofs p WHERE p.conversation_id=a.conversation_id AND p.request_id=a.request_id)
    UNION ALL SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=$1
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=t.conversation_id AND n.request_id=t.request_id)
    UNION ALL SELECT 1 FROM birbcrew_ts.text_request_no_launch_proofs p WHERE p.conversation_id=$1 AND (
      EXISTS(SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=p.conversation_id AND t.request_id=p.request_id) OR
      EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n WHERE n.conversation_id=p.conversation_id AND n.request_id=p.request_id) OR
      EXISTS(SELECT 1 FROM birbcrew_ts.text_conversation_locations l WHERE l.conversation_id=p.conversation_id)) LIMIT 1`,
    [key.conversationId],
  );
  if (bad) throw new MemberStoreError("content_runtime_unconfirmed");
}
export async function recordNoLaunchProof(
  db: PoolClient,
  key: Key & { requestId: string },
) {
  await db.query(
    `INSERT INTO birbcrew_ts.text_request_no_launch_proofs(conversation_id,request_id,reason)
    SELECT a.conversation_id,a.request_id,a.reason FROM birbcrew_ts.request_admissions a
    JOIN birbcrew_ts.conversations c USING(conversation_id) JOIN birbcrew_ts.members m USING(owner_id,member_id)
    WHERE a.conversation_id=$1 AND a.request_id=$2 AND a.phase='rejected' AND m.engine IN ('cursor','opencode')
      AND c.text_location_inventory_complete AND c.content_erasure_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2)
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND request_id=$2)
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.text_runtime_cleanup_proofs WHERE conversation_id=$1 AND request_id=$2)
      AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.text_conversation_locations WHERE conversation_id=$1)
    ON CONFLICT DO NOTHING`,
    [key.conversationId, key.requestId],
  );
}
async function resolvedStarts(db: Pool | PoolClient, key: Key) {
  if (
    (
      await db.query(
        "SELECT 1 FROM birbcrew_ts.conversation_workflow_starts WHERE conversation_id=$1 AND state IN ('reserved','ambiguous') LIMIT 1",
        [key.conversationId],
      )
    ).rowCount
  ) {
    throw new MemberStoreError("content_start_unresolved");
  }
}
export async function preflightContentErasure(
  store: MemberStore,
  key: Key,
  inventory = true,
) {
  return erasureTransaction(store, async (db) => {
    const row = await contentErasureState(db, key, true);
    await terminalTextRequests(db, key);
    await textStopProofs(db, key);
    await resolvedStarts(db, key);
    if (inventory && !row.text_location_inventory_complete)
      throw new MemberStoreError("content_location_unknown");
    return row;
  });
}
export async function reserveTextWorkflowStart(
  store: MemberStore,
  key: Key,
  workflowId: string,
) {
  return erasureTransaction(store, async (db) => {
    await assertContentWritable(db, key);
    const row = await contentErasureState(db, key);
    if (row.text_lifecycle === "sealed_closed") return null;
    const attemptId = randomUUID();
    const {
      rows: [generation],
    } = await db.query<{ value: string }>(
      "UPDATE birbcrew_ts.conversations SET text_start_generation=text_start_generation+1 WHERE conversation_id=$1 RETURNING text_start_generation AS value",
      [key.conversationId],
    );
    await db.query(
      "INSERT INTO birbcrew_ts.conversation_workflow_starts(attempt_id,conversation_id,generation,workflow_id,state) VALUES($1,$2,$3,$4,'reserved')",
      [attemptId, key.conversationId, generation.value, workflowId],
    );
    return attemptId;
  });
}
export async function settleTextWorkflowStart(
  store: MemberStore,
  key: Key,
  attemptId: string,
  runId?: string,
) {
  await erasureTransaction(store, async (db) => {
    await assertContentWritable(db, key);
    await db.query(
      "UPDATE birbcrew_ts.conversation_workflow_starts SET state=$3,run_id=$4 WHERE conversation_id=$1 AND attempt_id=$2 AND state IN ('reserved','ambiguous')",
      [
        key.conversationId,
        attemptId,
        runId ? "acknowledged" : "ambiguous",
        runId ?? null,
      ],
    );
  });
}
export async function sealTextClosure(
  store: MemberStore,
  key: Key,
  evidence: ClosureEvidence,
) {
  if (!terminalWorkflowStatuses.includes(evidence.status))
    throw new MemberStoreError("conversation_open");
  return erasureTransaction(store, async (db) => {
    const row = await contentErasureState(db, key, true);
    if (row.text_lifecycle === "sealed_closed") return row.text_closure!;
    if (row.text_start_generation !== evidence.generation)
      throw new MemberStoreError("content_start_unresolved");
    await resolvedStarts(db, key);
    await db.query(
      "UPDATE birbcrew_ts.conversations SET text_lifecycle='sealed_closed',text_closure=$2 WHERE conversation_id=$1 AND text_start_generation=$3 AND text_lifecycle='startable'",
      [
        key.conversationId,
        JSON.stringify({ ...evidence, observedAt: new Date().toISOString() }),
        evidence.generation,
      ],
    );
    return evidence;
  });
}
export async function beginContentErasure(store: MemberStore, key: Key) {
  return erasureTransaction(store, async (db) => {
    const row = await contentErasureState(db, key, true);
    if (row.content_erasure_id) return row.content_erasure_id;
    if (
      (
        await db.query(
          "SELECT 1 FROM birbcrew_ts.content_output_reservations WHERE conversation_id=$1 LIMIT 1",
          [key.conversationId],
        )
      ).rowCount
    )
      throw new MemberStoreError("content_output_busy");
    const receipts = await terminalTextRequests(db, key);
    await textStopProofs(db, key);
    await resolvedStarts(db, key);
    if (row.text_lifecycle !== "sealed_closed")
      throw new MemberStoreError("conversation_open");
    if (!row.text_location_inventory_complete)
      throw new MemberStoreError("content_location_unknown");
    const {
      rows: [snapshot],
    } = await db.query<{ phase: string }>(
      "SELECT state->>'phase' AS phase FROM birbcrew_ts.public_snapshots WHERE conversation_id=$1",
      [key.conversationId],
    );
    const phase =
      snapshot && ["complete", "failed", "cancelled"].includes(snapshot.phase)
        ? snapshot.phase
        : receipts.some((r) => requestStatusFromRow(r) === "cancelled")
          ? "cancelled"
          : receipts.some((r) => requestStatusFromRow(r) === "failed")
            ? "failed"
            : "complete";
    const erasureId = randomUUID();
    await db.query(
      "INSERT INTO birbcrew_ts.conversation_content_erasures(conversation_id,erasure_id,terminal_phase) VALUES($1,$2,$3)",
      [key.conversationId, erasureId, phase],
    );
    await db.query(
      "INSERT INTO birbcrew_ts.conversation_content_cleanup(conversation_id,erasure_id,location_id) SELECT conversation_id,$2,location_id FROM birbcrew_ts.text_conversation_locations WHERE conversation_id=$1",
      [key.conversationId, erasureId],
    );
    await db.query(
      "UPDATE birbcrew_ts.conversations SET content_erasure_id=$2 WHERE conversation_id=$1",
      [key.conversationId, erasureId],
    );
    return erasureId;
  });
}
export async function finishContentErasure(store: MemberStore, key: Key) {
  return erasureTransaction(store, async (db) => {
    const row = await contentErasureState(db, key, true);
    if (row.erased_at) return contentTombstone(db, key);
    if (!row.content_erasure_id) throw new MemberStoreError("conflict");
    await terminalTextRequests(db, key);
    await textStopProofs(db, key);
    await resolvedStarts(db, key);
    if (
      row.text_lifecycle !== "sealed_closed" ||
      !row.text_location_inventory_complete
    )
      throw new MemberStoreError("conflict");
    if (
      (
        await db.query(
          "SELECT 1 FROM birbcrew_ts.conversation_content_cleanup WHERE conversation_id=$1 AND cleaned_at IS NULL",
          [key.conversationId],
        )
      ).rowCount
    )
      return null;
    await db.query(
      "UPDATE birbcrew_ts.turns SET erased=true,reply=NULL,checkpoint=NULL WHERE conversation_id=$1",
      [key.conversationId],
    );
    await db.query(
      "UPDATE birbcrew_ts.public_snapshots SET messages='[]',state=birbcrew_ts.erased_projection($1),open_text=NULL,open_tools='{}',child_open_text='{}' WHERE conversation_id=$1",
      [key.conversationId],
    );
    await db.query(
      `UPDATE birbcrew_ts.public_events SET event='{"type":"CUSTOM","name":"crew.content_erased","value":null}' WHERE conversation_id=$1`,
      [key.conversationId],
    );
    await db.query(
      "UPDATE birbcrew_ts.conversation_content_erasures SET erased_at=clock_timestamp() WHERE conversation_id=$1 AND erased_at IS NULL",
      [key.conversationId],
    );
    await appendAudit(db, {
      type: "conversation.content_erased",
      ownerId: key.ownerId,
      memberId: row.memberId,
      conversationId: key.conversationId,
      payload: { erasureId: row.content_erasure_id },
    });
    return contentTombstone(db, key);
  });
}
