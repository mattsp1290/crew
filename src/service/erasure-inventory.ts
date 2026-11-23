import { conversationWorkflowId } from "./queues.ts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Client } from "@temporalio/client";
import { WorkflowNotFoundError } from "@temporalio/client";
import {
  assertContentWritable,
  contentErasureState,
  bindTextWorkflowNamespace,
  recordNoLaunchProof,
  sealClosureLocked,
  terminalWorkflowStatuses,
  terminalTextRequests,
} from "./content-erasure-store.ts";
import { isTextEngine, MemberStoreError } from "./domain.ts";
import type { PoolClient } from "pg";
import type { MemberStore } from "./store.ts";

const locationSchema = z.strictObject({
  locationId: z.uuid(),
  engine: z.enum(["cursor", "opencode"]),
  profile: z.string().min(1).max(128),
});
export const erasureInventorySchema = z.strictObject({
  version: z.literal(1),
  conversations: z
    .array(
      z.strictObject({
        ownerId: z.string().min(1).max(256),
        conversationId: z.uuid(),
        inventory: z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("locations"),
            locations: z.array(locationSchema).min(1),
          }),
          z.strictObject({ kind: z.literal("no_launch") }),
        ]),
      }),
    )
    .min(1),
});

/** Trusted teardown evidence only: the caller must first await every gateway's termination.
 * There is deliberately no expiry or heartbeat shortcut for a gateway that could resume. */
export async function clearQuiescedContentOutputs(
  db: PoolClient,
  key: { ownerId: string; conversationId: string },
  drainId: string,
) {
  z.uuid().parse(drainId);
  await assertContentWritable(db, key);
  await db.query(
    `INSERT INTO birbcrew_ts.content_output_drains(drain_id,conversation_id,output_ids)
    SELECT $2,conversation_id,array_agg(output_id ORDER BY output_id) FROM birbcrew_ts.content_output_reservations
    WHERE conversation_id=$1 GROUP BY conversation_id`,
    [key.conversationId, drainId],
  );
  await db.query(
    "DELETE FROM birbcrew_ts.content_output_reservations WHERE conversation_id=$1",
    [key.conversationId],
  );
}

/** Trusted operator only. quiesce must drain ALL old senders and writer descendants,
 * fence/drain Temporal RPCs, then make Temporal available for observation with pollers still stopped. */
export async function enrollErasureInventory(
  store: MemberStore,
  temporal: Client,
  input: unknown,
  hooks: { quiesce(): Promise<void> },
) {
  const manifest = erasureInventorySchema.parse(input),
    drainId = randomUUID();
  if (
    new Set(manifest.conversations.map((c) => c.conversationId)).size !==
    manifest.conversations.length
  )
    throw new MemberStoreError("conflict");
  await hooks.quiesce();
  const observations = new Map<
    string,
    { workflowId: string; runId: string; status: string } | null
  >();
  for (const key of manifest.conversations) {
    const row = await contentErasureState(store.pool, key);
    if (!isTextEngine(row.engine))
      throw new MemberStoreError("content_erasure_unsupported");
    const workflowId = conversationWorkflowId(row.memberId, row.conversationId);
    try {
      const execution = await temporal.connection.withDeadline(
        Date.now() + 5_000,
        () => temporal.workflow.getHandle(workflowId).describe(),
      );
      observations.set(key.conversationId, {
        workflowId,
        runId: execution.runId,
        status: execution.status.name,
      });
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      observations.set(key.conversationId, null);
    }
  }
  await store.transaction(async (db) => {
    // Stable ordering also makes simultaneous operator manifests serialize consistently.
    for (const key of [...manifest.conversations].sort((a, b) =>
      a.conversationId.localeCompare(b.conversationId),
    )) {
      await assertContentWritable(db, key);
      const row = await bindTextWorkflowNamespace(db,key,temporal.options.namespace);
      await clearQuiescedContentOutputs(db, key, drainId);
      if (key.inventory.kind === "no_launch") {
        if (
          (
            await db.query(
              `SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 UNION ALL
          SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 UNION ALL
          SELECT 1 FROM birbcrew_ts.text_conversation_locations WHERE conversation_id=$1 LIMIT 1`,
              [key.conversationId],
            )
          ).rowCount
        )
          throw new MemberStoreError("content_runtime_unconfirmed");
      } else {
        for (const location of key.inventory.locations) {
          if (
            location.engine !== row.engine ||
            location.profile !== row.profile
          )
            throw new MemberStoreError("content_location_unknown");
          if (
            !(
              await db.query(
                "SELECT 1 FROM birbcrew_ts.text_state_locations WHERE location_id=$1 AND engine=$2",
                [location.locationId, location.engine],
              )
            ).rowCount
          )
            throw new MemberStoreError("content_location_unknown");
        }
        const declared = key.inventory.locations.map((l) => l.locationId);
        if (
          (
            await db.query(
              "SELECT 1 FROM birbcrew_ts.text_conversation_locations WHERE conversation_id=$1 AND NOT(location_id=ANY($2::uuid[]))",
              [key.conversationId, declared],
            )
          ).rowCount
        )
          throw new MemberStoreError("content_location_unknown");
        for (const location of key.inventory.locations) {
          await db.query(
            "INSERT INTO birbcrew_ts.text_conversation_locations(conversation_id,location_id,profile) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [key.conversationId, location.locationId, location.profile],
          );
          await db.query(
            `INSERT INTO birbcrew_ts.text_runtime_cleanup_proofs(conversation_id,request_id,token,location_id,confirmed_at,drain_id)
            SELECT conversation_id,request_id,token,$2,clock_timestamp(),$3 FROM birbcrew_ts.native_launches WHERE conversation_id=$1 ON CONFLICT DO NOTHING`,
            [key.conversationId, location.locationId, drainId],
          );
        }
        await db.query(
          "UPDATE birbcrew_ts.text_runtime_cleanup_proofs SET confirmed_at=clock_timestamp(),drain_id=$2 WHERE conversation_id=$1 AND confirmed_at IS NULL",
          [key.conversationId, drainId],
        );
        await db.query(
          "UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND NOT stopped",
          [key.conversationId],
        );
      }
      await db.query(
        "UPDATE birbcrew_ts.conversations SET text_location_inventory_complete=true WHERE conversation_id=$1",
        [key.conversationId],
      );
      const rejected = await db.query<{ request_id: string }>(
        "SELECT request_id FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND phase='rejected'",
        [key.conversationId],
      );
      for (const request of rejected.rows)
        await recordNoLaunchProof(db, {
          ...key,
          requestId: request.request_id,
        });
      const observed = observations.get(key.conversationId);
      const workflowId =
        observed?.workflowId ??
        conversationWorkflowId(row.memberId, key.conversationId);
      // After a trusted drain, a negative observation resolves only the send, never closure.
      const starts = await db.query(
        "SELECT 1 FROM birbcrew_ts.conversation_workflow_starts WHERE conversation_id=$1",
        [key.conversationId],
      );
      if (!starts.rowCount && row.text_lifecycle !== "sealed_closed") {
        await db.query(
          "UPDATE birbcrew_ts.conversations SET text_start_generation=text_start_generation+1 WHERE conversation_id=$1",
          [key.conversationId],
        );
        await db.query(
          `INSERT INTO birbcrew_ts.conversation_workflow_starts(conversation_id,generation,workflow_id,state,run_id,drain_id,namespace)
          SELECT conversation_id,text_start_generation,$2,$3,$4,$5,$6 FROM birbcrew_ts.conversations WHERE conversation_id=$1`,
          [
            key.conversationId,
            workflowId,
            observed ? "acknowledged" : "absent_after_trusted_drain",
            observed?.runId ?? null,
            drainId,
            temporal.options.namespace,
          ],
        );
      }
      await db.query(
        "UPDATE birbcrew_ts.conversation_workflow_starts SET state=$2,run_id=$3,drain_id=$4,namespace=$5 WHERE conversation_id=$1 AND state IN ('reserved','ambiguous')",
        [
          key.conversationId,
          observed ? "acknowledged" : "absent_after_trusted_drain",
          observed?.runId ?? null,
          drainId,
          temporal.options.namespace,
        ],
      );
      let settled=false;
      try { await terminalTextRequests(db,key); settled=true; }
      catch(error) {if(!(error instanceof MemberStoreError && error.code==="content_requests_unresolved"))throw error;}
      if (
        settled && observed &&
        terminalWorkflowStatuses.includes(observed.status) &&
        row.text_lifecycle !== "sealed_closed"
      ) {
        const current = await contentErasureState(db, key);
        await sealClosureLocked(db, current, {
          workflowId, runId: observed.runId, status: observed.status,
          namespace: temporal.options.namespace, generation: current.text_start_generation, drainId,
        });
      }
    }
  });
  return {
    drainId,
    conversations: manifest.conversations.map((c) => c.conversationId),
  };
}
export async function runErasureInventoryCommand(
  store: MemberStore,
  temporal: Client,
  args: string[],
) {
  const options = new Map<string, string>();
  let complete = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--confirm-complete") {
      if (complete) throw new Error("Invalid inventory arguments");
      complete = true;
      continue;
    }
    if (
      !["--manifest", "--quiesce-module"].includes(key) ||
      options.has(key) ||
      !args[i + 1]
    )
      throw new Error("Invalid inventory arguments");
    options.set(key, args[++i]);
  }
  const manifest = options.get("--manifest"),
    modulePath = options.get("--quiesce-module");
  if (
    !complete ||
    !manifest ||
    !modulePath ||
    !isAbsolute(manifest) ||
    !isAbsolute(modulePath)
  )
    throw new Error(
      "Supply absolute --manifest and --quiesce-module with --confirm-complete",
    );
  const module: unknown = await import(pathToFileURL(modulePath).href);
  if (
    !module ||
    typeof module !== "object" ||
    !("quiesce" in module) ||
    typeof module.quiesce !== "function"
  )
    throw new Error("Trusted module must export quiesce");
  const quiesce = module.quiesce;
  return enrollErasureInventory(
    store,
    temporal,
    JSON.parse(await readFile(manifest, "utf8")),
    {
      async quiesce() {
        await quiesce();
      },
    },
  );
}
