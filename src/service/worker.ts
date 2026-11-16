import { progressActivity } from "./progress-activity.ts";
import { answerLive, cancelLive } from "./codex-calls.ts";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { DelegationControl } from "./delegation-control.ts";
import { TemporalDelegationWorkflows } from "./delegation-control-workflows.ts";
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
  return { rejectUnstartedAdmission:store.rejectUnstartedAdmission.bind(store), recordAcceptance:ownerAdmissionActivity(store), rejectAccepted:store.rejectAccepted.bind(store), conversationProgress:progressActivity(store), cancelGenerating:store.cancelGenerating.bind(store), decideLive:answerLive.bind(null,store.pool), cancelLive:cancelLive.bind(null,store.pool),
    reconcileTurn: store.reconcileTurn.bind(store), reconcileChild:children.reconcile.bind(children),
    closeExitedChild: children.closeExitedChild.bind(children), quarantineDelegation: children.quarantineDelegation.bind(children),
    expireApproval: expiryActivity(store) };
}

export async function runMemberWorker(store: MemberStore, temporal: TemporalSettings, profiles: ReadonlyMap<string, MemberProfile>,
  configPath: string, stateDir: string, heartbeat?: string) {
  const connection = await NativeConnection.connect(await temporalConnectionOptions(temporal));
  const { namespace } = temporal;
  const workers: Worker[] = [];
  let supervisor;
  let clientConnection: Connection | undefined;
  try {
    clientConnection = await Connection.connect(await temporalConnectionOptions(temporal));
    const control = new DelegationControl({ pool: store.pool, workflows: new TemporalDelegationWorkflows(
      new Client({ connection: clientConnection, namespace })) });
    workers.push(await Worker.create({
      connection, namespace, taskQueue: memberTaskQueue, activities: memberQueueActivities(store),
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    }));
    supervisor = await startSupervisor(configPath, stateDir);
    for (const [profile, engines] of profiles) {
      for (const engine of engineSchema.options) {
        if (!engines[engine]) continue;
        const activities = memberActivities(store, supervisor, profiles, stateDir, engine);
        workers.push(await Worker.create({
          connection, namespace, activities, taskQueue: activityQueue(engine, profile),
          ...(engine === "codex" && { maxConcurrentActivityTaskExecutions: 2 }),
        }));
      }
    }
    if (workers.length === 1) throw new Error("No member engines configured");
    const running = workers.map((worker) => worker.run());
    let reported = false;
    let controlHealthy = true;
    let pass: Promise<void> | undefined;
    const reconcile = () => {
      if (pass) return;
      pass = control.flush().then(result => {
        controlHealthy = !result.children.some(child => child.wake.kind === "unavailable");
        if (!controlHealthy || result.children.some(child => child.settlement === "pending")) {
          console.error(JSON.stringify({ event: "delegation_control_pending", ...result }));
        }
      }, () => {
        controlHealthy = false;
        console.error(JSON.stringify({ event: "delegation_control_failed" }));
      }).finally(() => { pass = undefined; });
    };
    reconcile();
    const reconciliation = setInterval(reconcile, 2000);
    const beat = () => {
      if (!controlHealthy || heartbeat === undefined || !workers.every((worker) => worker.getState() === "RUNNING")) return;
      void touch(heartbeat).catch(() => {
        if (!reported) console.error("Cannot update BIRBCREW_WORKER_HEARTBEAT_FILE");
        reported = true;
      });
    };
    beat();
    const beats = heartbeat === undefined ? undefined : setInterval(beat, 5000);
    try {
      await Promise.race([Promise.all(running), supervisor.exited.then(() => { throw new Error("SDK supervisor stopped"); })]);
    } finally {
      clearInterval(beats);
      clearInterval(reconciliation);
      for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
      await pass;
      await Promise.allSettled(running);
    }
  } finally {
    try { await supervisor?.close(); }
    finally {
      try { await clientConnection?.close(); } finally { await connection.close(); }
    }
  }
}
