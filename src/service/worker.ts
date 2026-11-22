import { contentErasureActivities, textLocationCleanupActivity } from "./content-erasure-activities.ts";
import { textStateLocation, textCleanupQueue } from "./text-state-location.ts";
import { startContentErasureReconciliation } from "./content-erasure-reconciliation.ts";
import { Pool } from "pg";
import { progressActivity } from "./progress-activity.ts";
import { cancelLive, decideLiveActivity } from "./codex-calls.ts";
import { open, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { DelegationReconciler } from "./delegation-control.ts";
import { TemporalDelegationWorkflows } from "./delegation-control-workflows.ts";
import { startDelegationReconciliation } from "./delegation-reconciliation.ts";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ChildStore } from "./children.ts";
import { startSupervisor } from "./supervisor.ts";
import { engineSchema } from "./domain.ts";
import type { MemberProfile } from "./profiles.ts";
import { expiryActivity, memberActivities } from "./activities.ts";
import { memberTaskQueue, activityQueue } from "./queues.ts";
import { ownerAdmissionActivity, type MemberStore } from "./store.ts";
import { temporalConnectionOptions, type TemporalSettings } from "./temporal-config.ts";

async function touch(path: string) {
  const file = await open(path, "a");
  try { const now = new Date(); await file.utimes(now, now); } finally { await file.close(); }
}

/** The activities the member task queue serves beside the conversation workflows. */
export function memberQueueActivities(store: MemberStore) {
  const children = new ChildStore(store.pool);
  return { ...contentErasureActivities(store), rejectUnstartedAdmission:store.rejectUnstartedAdmission.bind(store), recordAcceptance:ownerAdmissionActivity(store), rejectAccepted:store.rejectAccepted.bind(store), conversationProgress:progressActivity(store), cancelGenerating:store.cancelGenerating.bind(store), decideLive:decideLiveActivity.bind(null,store.pool), cancelLive:cancelLive.bind(null,store.pool),
    reconcileTurn: store.reconcileTurn.bind(store), reconcileChild:children.reconcile.bind(children),
    closeExitedChild: children.closeExitedChild.bind(children), quarantineDelegation: children.quarantineDelegation.bind(children),
    expireApproval: expiryActivity(store) };
}

export async function runMemberWorker({ store, temporal, profiles, configPath, stateDir, heartbeat, controlPool }: {
  store: MemberStore; temporal: TemporalSettings; profiles: ReadonlyMap<string, MemberProfile>;
  configPath: string; stateDir: string; heartbeat?: string; controlPool: Pool;
}) {
  await mkdir(stateDir,{recursive:true,mode:0o700});
  stateDir=await realpath(stateDir);
  const { namespace } = temporal;
  const erasurePool = new Pool({ ...store.pool.options, password: store.pool.options.password, max: 2, connectionTimeoutMillis: 2000, statement_timeout: 5000, query_timeout: 7000 });
  const workers: Worker[] = [];
  const running: Promise<void>[] = [];
  let connection: NativeConnection | undefined;
  let supervisor;
  let clientConnection: Connection | undefined;
  let reconciler: ReturnType<typeof startDelegationReconciliation> | undefined;
  let erasureReconciler: ReturnType<typeof startContentErasureReconciliation> | undefined;
  let beats: ReturnType<typeof setInterval> | undefined;
  const serve = (worker: Worker) => {
    workers.push(worker);
    const run = worker.run();
    void run.catch(() => {});
    running.push(run);
  };
  try {
    connection = await NativeConnection.connect(await temporalConnectionOptions(temporal));
    clientConnection = await Connection.connect(await temporalConnectionOptions(temporal));
    const control = new DelegationReconciler({ pool: controlPool, workflows: new TemporalDelegationWorkflows(
      new Client({ connection: clientConnection, namespace })) });
    serve(await Worker.create({
      connection, namespace, taskQueue: memberTaskQueue, activities: memberQueueActivities(store),
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    }));
    for (const engine of ["cursor", "opencode"] as const) {
      if (![...profiles.values()].some(entry=>entry[engine])) continue;
      const { locationId } = await textStateLocation(stateDir,engine);
      serve(await Worker.create({ connection, namespace, taskQueue:textCleanupQueue(locationId),
        activities:{cleanTextLocation:textLocationCleanupActivity(store,stateDir,locationId,engine)} }));
    }
    supervisor = await startSupervisor(configPath, stateDir);
    for (const [profile, engines] of profiles) {
      for (const engine of engineSchema.options) {
        if (!engines[engine]) continue;
        const activities = memberActivities(store, supervisor, profiles, stateDir, engine);
        serve(await Worker.create({
          connection, namespace, activities, taskQueue: activityQueue(engine, profile),
          ...(engine === "codex" && { maxConcurrentActivityTaskExecutions: 2 }),
        }));
      }
    }
    if (workers.length === 1) throw new Error("No member engines configured");
    reconciler = startDelegationReconciliation(control, controlPool);
    erasureReconciler = startContentErasureReconciliation(erasurePool,new Client({connection:clientConnection,namespace}));
    let reported = false;
    const beat = () => {
      if (!erasureReconciler?.healthy() || !reconciler?.healthy() || heartbeat === undefined || !workers.every((worker) => worker.getState() === "RUNNING")) return;
      void touch(heartbeat).catch(() => {
        if (!reported) console.error("Cannot update BIRBCREW_WORKER_HEARTBEAT_FILE");
        reported = true;
      });
    };
    beats = heartbeat === undefined ? undefined : setInterval(beat, 5000);
    await Promise.race([Promise.all(running), supervisor.exited.then(() => { throw new Error("SDK supervisor stopped"); })]);
  } finally {
    clearInterval(beats);
    const settled = Promise.all([reconciler?.stop(),erasureReconciler?.stop()]);
    try {
      const errors: unknown[] = [];
      for (const worker of workers.filter(worker => worker.getState() === "RUNNING")) {
        try { worker.shutdown(); } catch (error) { errors.push(error); }
      }
      try { await settled; } finally { await Promise.allSettled(running); }
      if (errors.length) throw new AggregateError(errors, "Member worker shutdown failed");
    } finally {
      try { await supervisor?.close(); }
      finally {
        try { await clientConnection?.close(); }
        finally { try { await connection?.close(); } finally { await erasurePool.end(); } }
      }
    }
  }
}
