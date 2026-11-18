import { requestNativeStop } from "./native-admission.ts";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Pool, type PoolClient } from "pg";
import { ApprovalStore, savedProposal } from "./approvals.ts";
import type { PublicSegment } from "./activities.ts";
import { inspectChild, requestChildStop, revokeChild, type ReadySegment } from "./supervisor-child.ts";
import type { ChildOutcome } from "@birbcrew/pi-subagents";
import { ChildStore, childrenFor } from "./children.ts";
import type { Conversation, Checkpoint } from "./domain.ts";
import { textProjection, textWriter } from "./text-stream.ts";
import { MemberStore } from "./store.ts";
import { commandSchema, runnerResultSchema, type Launch } from "./supervisor.ts";
import { recordSegmentUsage } from "./usage.ts";
import { operatorPrices } from "./usage-prices.ts";
import { errorSummary, relayWarning, warn } from "./diagnostics.ts";

// Read before "ready": a table the worker accepted cannot fail here later, mid-segment.
const prices = operatorPrices();
const pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL });
const store = new MemberStore(pool);
const ledger = new ApprovalStore(pool);
const children = new ChildStore(pool);
type SegmentResult = PublicSegment | {kind:"childDone"};
const active = new Map<string, ChildProcess>();
const starts = new Map<string, { launch: Launch; result: Promise<SegmentResult> }>();
let closing = false;
const stopping = new WeakSet<ChildProcess>();

function killNativeGroup(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
}

async function groupStopped(pid: number) {
  for (let i = 0; i < 20; i++) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      throw error;
    }
    await delay(50);
  }
  return false;
}

function stopRunner(child: ChildProcess | undefined) {
  if (!child || stopping.has(child) || child.exitCode !== null || child.signalCode !== null) return;
  stopping.add(child);
  if (child.connected) child.send("stop", () => { });
  const timeout = setTimeout(() => killNativeGroup(child), 3000);
  timeout.unref();
  child.once("close", () => clearTimeout(timeout));
}

async function transaction<T>(body: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await body(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

async function lockedTurn(db: PoolClient, launch: Launch, allowRevokedAttempt = false) {
  const lock = await db.query("SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND conversation_id=$2 FOR UPDATE",
    [launch.ownerId, launch.conversationId]);
  if (!lock.rowCount) throw new Error("Unknown conversation");
  const { rows: [turn] } = await db.query<Conversation & {
    phase: string; reply: string | null; checkpoint: Checkpoint | null; paused: boolean; resuming: boolean; delegated: boolean; child_resume: boolean;
  }>(`SELECT c.owner_id AS "ownerId", c.member_id AS "memberId", c.conversation_id AS "conversationId",
          m.engine, m.profile, t.phase, t.reply, s.approval_id IS NOT NULL AS paused,
          s.resume_activity_id IS NOT NULL AS resuming,
          d.request_id IS NOT NULL AS delegated, d.resume_activity_id IS NOT NULL AS child_resume,
          CASE WHEN d.resume_activity_id IS NOT NULL THEN d.parent_checkpoint WHEN s.resume_activity_id IS NOT NULL THEN s.checkpoint ELSE previous.checkpoint END AS checkpoint
       FROM birbcrew_ts.turns t JOIN birbcrew_ts.conversations c USING (conversation_id)
       JOIN birbcrew_ts.members m USING (owner_id, member_id)
       LEFT JOIN birbcrew_ts.paused_segments s USING (conversation_id,request_id)
       LEFT JOIN birbcrew_ts.delegations d USING(conversation_id,request_id)
       LEFT JOIN birbcrew_ts.turns previous ON previous.conversation_id=t.conversation_id AND previous.position=t.position-1
      WHERE c.owner_id=$1 AND t.conversation_id=$2 AND t.request_id=$3 AND t.token=$4
        AND t.workflow_run_id=$5 AND t.activity_id=$6 AND t.prompt_digest=$8
        AND (t.attempt=$7 OR ($9 AND t.attempt>$7 AND t.phase='uncertain'))`,
    [launch.ownerId, launch.conversationId, launch.requestId, launch.token, launch.execution.workflowRunId,
      launch.execution.activityId, launch.execution.attempt, createHash("sha256").update(launch.text).digest(), allowRevokedAttempt]);
  if (!turn) throw new Error("Invalid native generation");
  return turn;
}

async function start(launch: Launch): Promise<SegmentResult> {
  const args = [launch.conversationId, launch.requestId, launch.token];
  // Commit the one-shot reservation before forking; a lost fork acknowledgement must never start a second process.
  const inspect = async (db: PoolClient): Promise<SegmentResult | ReadySegment> => {
    if (launch.childId) return inspectChild(db,launch);
    const turn = await lockedTurn(db, launch);
    if (turn.reply !== null) return { kind: "complete", text: turn.reply } as const;
    if (turn.phase !== "started") throw new Error("Native admission revoked");
    const approval = turn.paused ? await savedProposal(db, turn, launch.requestId) : undefined;
    if (turn.paused && !approval) throw new Error("Missing canonical proposal");
    if (approval && !turn.resuming) return { kind: "pending", approval } as const;
    const {ownerId,memberId,conversationId,engine,profile} = turn;
    const conversation = {ownerId,memberId,conversationId,engine,profile};
    if (turn.delegated && !turn.child_resume) {
      return {kind:"delegated",children:await childrenFor(db,conversation,launch.requestId)};
    }
    let childResults: ChildOutcome[] | undefined;
    if (turn.child_resume) {
      const {rows} = await db.query<{outcome:ChildOutcome|null}>(
        "SELECT outcome FROM birbcrew_ts.pi_children WHERE conversation_id=$1 AND request_id=$2 ORDER BY ordinal",
        [conversationId,launch.requestId]);
      childResults = rows.map(({outcome}) => {
        if (!outcome) throw new Error("Child outcome missing");
        return outcome;
      });
      if (!childResults.length) throw new Error("Delegation has no children");
    }
    return {kind:"ready", approval, conversation, checkpoint:turn.checkpoint, parentToken:launch.token, childResults};

  };
  const admission = await transaction(async (db) => {
    const status = await inspect(db);
    if (status.kind !== "ready") return status;
    const { approval } = status;
    const continuation = approval ? { nativeCallId: approval.nativeCallId,
      result: await ledger.settleLocked(db, { ...approval, token: status.parentToken }) } : undefined;
    const digest = continuation ? createHash("sha256").update(JSON.stringify(continuation.result)).digest() : null;
    const inserted = await db.query(`INSERT INTO birbcrew_ts.native_launches
      (conversation_id,request_id,token,approval_id,receipt_digest,workflow_run_id,activity_id,attempt,child_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (conversation_id,request_id,token) DO NOTHING`,
      [...args, approval?.approvalId ?? null, digest, launch.execution.workflowRunId, launch.execution.activityId, launch.execution.attempt, launch.childId ?? null]);
    return { kind: inserted.rowCount ? "launch" : "observe", continuation, resuming:!!(continuation || status.childResults) } as const;
  });
  if (!("continuation" in admission)) return admission;
  if (admission.kind === "observe") {
    const until = Date.now() + 170_000;
    while (!closing && Date.now() < until) {
      const status = await transaction(inspect);
      if (status.kind !== "ready") return status;
      await delay(100);
    }
    throw new Error("Previous SDK launch outcome is uncertain");
  }

  let reply: unknown;
  let preview: Promise<void> | undefined;
  let exited: Promise<boolean> | undefined;
  let confirmed = false;
  let reaped = false;
  let runnerEnd = "no exit";
  try {
    const { continuation } = admission;
    const project = await textProjection(pool, launch.conversationId);
    const messageId = (launch.childId ?? launch.requestId) + (admission.resuming ? "/resumed-assistant" : "/assistant");
    const stream = textWriter((index, delta) => store.appendText(launch, messageId, index, delta));
    // Recheck under the takeover lock after reservation. Both the fork and its command happen before releasing it.
    const member = await transaction(async (db) => {
      const status = await inspect(db);
      if (closing || status.kind !== "ready") throw new Error("Native admission revoked");
      const { conversation, checkpoint, childProfile, childResults } = status;
      const child = fork(new URL("./supervisor-runner.ts", import.meta.url), process.argv.slice(2), {
        stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], detached: true,
      });
      active.set(launch.token, child);
      child.on("message", (value) => {
        if (value && typeof value === "object" && "delta" in value && typeof value.delta === "string") {
          stream.push(project(value.delta));
        } else if (value && typeof value === "object" && "toolArgs" in value && typeof value.toolArgs === "string" && !continuation) {
          const id = value.toolArgs;
          const matched = "matchedOperation" in value && value.matchedOperation === true;
          preview = (preview ?? stream.drain()).then(() => store.previewTool(launch, id, matched));
          void preview.catch(() => { });
        } else if (value && typeof value === "object" && "warning" in value && typeof value.warning === "string") {
          relayWarning(value.warning, { conversationId: launch.conversationId, requestId: launch.requestId });
        } else {
          reply = value;
        }
      });
      exited = new Promise<boolean>((resolve) => {
        child.once("error", () => { runnerEnd = "process error"; resolve(false); });
        child.once("close", (code, signal) => { runnerEnd = signal ? "signal " + signal : "exit code " + code; resolve(code === 0); });
      });
      child.send({ launch, conversation, checkpoint, continuation, childProfile, childResults,threadId:launch.childId ?? conversation.conversationId, runId: launch.requestId, text: launch.text }, (error) => {
        if (error) killNativeGroup(child);
      });
      return status;
    });
    confirmed = Boolean(await exited && reply !== undefined);
    stream.push(project("", true));
    await stream.drain();
    await preview;
    const pid = active.get(launch.token)?.pid;
    reaped = pid !== undefined && await groupStopped(pid);
    if (!confirmed || !reaped) {
      const state = [runnerEnd, reply === undefined && "no reply", !reaped && "process group still running"].filter(Boolean).join(", ");
      throw new Error("SDK process stopped without a confirmed result (" + state + ")");
    }
    const {ownerId,conversationId,requestId,token} = launch;
    const childKey = launch.childId ? {ownerId,conversationId,requestId,memberId:member.conversation.memberId,childId:launch.childId} : undefined;
    if (z.strictObject({error:z.literal("Native SDK turn failed")}).safeParse(reply).success) {
      if (!childKey) throw new Error("Native runner reported a failed turn");
      await children.finish(childKey,token,null);
      return {kind:"childDone"};
    }
    const result = runnerResultSchema.parse(reply);
    // Before the outcome commits: the model work happened even if that commit then fails.
    await recordSegmentUsage(pool, launch, result.usage, prices);
    if (result.kind === "delegated") {
      if (childKey || continuation || member.childResults || member.conversation.engine !== "pi") throw new Error("Unexpected delegation");
      return {kind:"delegated",children:await children.delegate(member.conversation,requestId,token,result.proposals,result.checkpoint)};
    }
    if (result.kind === "pending") {
      if (continuation || member.childResults || result.checkpoint.engine !== member.conversation.engine) throw new Error("Invalid protected call");
      const { name: toolName, nativeCallId, arguments: args } = result.proposal;
      const approval = await ledger.propose({ ownerId, conversationId, requestId, token, memberId: member.conversation.memberId,
        invocationId: childKey?.childId ?? requestId, toolName, nativeCallId, arguments: args }, result.checkpoint, childKey ? {childGeneration:token} : undefined);
      return { kind: "pending", approval };
    }
    if (childKey) {
      await children.finish(childKey,token,result);
      return {kind:"childDone"};
    }
    const text = await store.commitTurn({ ownerId, conversationId, requestId, token,
      reply: result.text, checkpoint: result.checkpoint });
    return { kind: "complete", text };
  } finally {
    const runner = active.get(launch.token);
    if (runner && !confirmed) killNativeGroup(runner);
    active.delete(launch.token);
    if (!runner || reaped || (runner.pid && await groupStopped(runner.pid))) {
      await pool.query("UPDATE birbcrew_ts.native_launches SET stopped=true WHERE conversation_id=$1 AND request_id=$2 AND token=$3", args);
    }
  }
}

async function handle(launch: Launch, action: "start" | "stop") {
  if (action === "stop") {
    if (launch.childId) await requestChildStop(pool,{...launch,childId:launch.childId},{...launch.execution,token:launch.token});
    else await requestNativeStop(pool, launch, {
      workflowRunId: launch.execution.workflowRunId, activityId: launch.execution.activityId,
      token: launch.token, attempt: launch.execution.attempt
    });
    await transaction(async (db) => {
      if (launch.childId) return revokeChild(db,launch);
      const retired = await db.query(`SELECT 1 FROM birbcrew_ts.native_launches n
        JOIN birbcrew_ts.turns t USING (conversation_id,request_id)
        JOIN birbcrew_ts.conversations c USING (conversation_id)
        WHERE c.owner_id=$1 AND n.conversation_id=$2 AND n.request_id=$3 AND n.token=$4 AND n.stopped
          AND n.workflow_run_id=$5 AND n.activity_id=$6 AND n.attempt=$7 AND t.prompt_digest=$8 AND t.token<>n.token`,
        [launch.ownerId, launch.conversationId, launch.requestId, launch.token, launch.execution.workflowRunId,
          launch.execution.activityId, launch.execution.attempt, createHash("sha256").update(launch.text).digest()]);
      if (retired.rowCount) return;
      const turn = await lockedTurn(db, launch, true);
      if (turn.phase === "started" && (!turn.paused || turn.resuming) && (!turn.delegated || turn.child_resume)) {
        await db.query("UPDATE birbcrew_ts.turns SET phase='uncertain' WHERE conversation_id=$1 AND request_id=$2 AND token=$3",
          [launch.conversationId, launch.requestId, launch.token]);
      }
    });
    stopRunner(active.get(launch.token));
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const { rows: [admitted] } = await pool.query<{ stopped: boolean }>(
        "SELECT stopped FROM birbcrew_ts.native_launches WHERE conversation_id=$1 AND request_id=$2 AND token=$3",
        [launch.conversationId, launch.requestId, launch.token]);
      if (!admitted || admitted.stopped) return null;
      await delay(100);
    }
    throw new Error("Native stop unconfirmed");
  }
  const existing = starts.get(launch.token);
  if (existing) {
    if (JSON.stringify(existing.launch) !== JSON.stringify(launch)) throw new Error("Conflicting launch");
    return existing.result;
  }
  const pending = start(launch);
  starts.set(launch.token, { launch: launch, result: pending });
  try { return await pending; }
  finally { starts.delete(launch.token); }
}

let checking = false;
const timer = setInterval(async () => {
  if (checking || !active.size) return;
  checking = true;
  const tokens = [...active.keys()];
  try {
    const { rows } = await pool.query<{token: string}>(
      `SELECT t.token FROM birbcrew_ts.turns t LEFT JOIN birbcrew_ts.native_stop_requests s USING (conversation_id,request_id,token)
       WHERE t.token=ANY($1::uuid[]) AND (t.phase<>'started' OR s.token IS NOT NULL)        UNION ALL SELECT j.generation FROM birbcrew_ts.pi_children j JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
          LEFT JOIN birbcrew_ts.tool_cancellations x USING(conversation_id,request_id)
          LEFT JOIN birbcrew_ts.native_stop_requests st ON st.conversation_id=j.conversation_id AND st.request_id=j.request_id AND st.token=j.generation
          WHERE j.generation=ANY($1::uuid[]) AND (st.token IS NOT NULL OR j.launch_revoked OR x.request_id IS NOT NULL OR t.phase <> 'started')`, [tokens]);
    for (const {token} of rows) stopRunner(active.get(token));
  } catch {
    for (const token of tokens) stopRunner(active.get(token));
  } finally {
    checking = false;
  }
}, 250);
process.once("disconnect", async () => {
  closing = true;
  clearInterval(timer);
  for (const child of active.values()) stopRunner(child);
  await Promise.allSettled([...starts.values()].map(({ result }) => result));
  await pool.end();
});
process.on("message", async (message) => {
  const { id, action, launch } = commandSchema.parse(message);
  let response;
  try {
    response = { id, ok: true, reply: await handle(launch, action) };
  } catch (error) {
    warn("native_turn_unconfirmed", { action, conversationId: launch.conversationId, requestId: launch.requestId, ...errorSummary(error) });
    response = { id, ok: false, error: "Native turn denied or outcome uncertain" };
  }
  if (process.connected) process.send?.(response, () => {});
});
process.send?.("ready");
