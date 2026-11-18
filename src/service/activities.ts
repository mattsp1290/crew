import { nativeProposal } from "./deferral.ts";
import type { z } from "zod";
import { traced } from "./telemetry.ts";
import type { Supervisor } from "./supervisor.ts";
import type { MemberProfile } from "./profiles.ts";
import { recoverClaudeProposal } from "./claude.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { Delegation, ChildOutcome } from "@birbcrew/pi-subagents";
import { ChildStore, type ChildKey } from "./children.ts";
import { ChildTargetError, hasChildDriver, type ChildTarget } from "./child-target.ts";
import { activityQueue } from "./queues.ts";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/client";
import { ApprovalStore, type Approval, type Decision, type ToolOutcome } from "./approvals.ts";
import { MemberStoreError, type Checkpoint, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberStore } from "./store.ts";
import type { SegmentUsage } from "./usage-capture.ts";

export interface DriverInput {
  threadId: string;
  runId: string;
  text: string;
  checkpoint: Checkpoint | null;
  signal: AbortSignal;
  projectContext?: string;
  mcp?: import("./codex-mcp.ts").NativeToolEndpoint;
  onThreadStarted?: (nativeThreadId:string) => void | Promise<void>;
  onToolDelivered?: (text:string) => void | Promise<void>;
  onToolArgs?: (nativeCallId: string, matchedOperation: boolean) => void;
  onText?: (delta: string) => void | Promise<void>;
  childProfile?: Delegation["profile"];
  childResults?: ChildOutcome[];
  continuation?: { nativeCallId: string; result: ToolOutcome };
}

// usage: what the SDK reported for this segment's model calls; the supervisor records it once.
export type DriverResult =
  | { kind: "complete"; text: string; checkpoint: unknown; usage?: SegmentUsage }
  | { kind: "delegated"; proposals: Delegation[]; checkpoint: unknown; usage?: SegmentUsage }
  | { kind: "pending"; proposal: z.infer<typeof nativeProposal>; checkpoint: unknown; usage?: SegmentUsage };
export type TurnDriver = (input: DriverInput, member: Conversation) => Promise<DriverResult>;
export type MemberProfiles = ReadonlyMap<string, Readonly<Partial<Record<Conversation["engine"], TurnDriver>>>>;
export type PublicSegment = { kind: "complete"; text: string } | { kind: "pending"; approval: Approval } | { kind: "delegated"; children: ChildKey[] };
export type Resume = { approval: Approval; outcome: ToolOutcome };

/** Refuses, before a launch is reserved, a child that is not on the queue its row names. A workflow
 * worker from before child targets schedules every child on its parent's Pi queue, and replay does
 * not compare task queues, so this check is what stops such a worker from misrouting a targeted child;
 * the workflow then settles it failed. It also refuses a stored target this release cannot read, and
 * one whose engine has no child driver yet. */
async function refuseMisroutedChild(children: ChildStore, key: ChildKey, taskQueue: string) {
  let target: ChildTarget;
  try {
    target = await children.target(key);
  } catch (error) {
    if (error instanceof ChildTargetError) throw ApplicationFailure.nonRetryable(error.message, "ChildTargetError");
    throw error;
  }
  if (taskQueue !== activityQueue(target.engine, target.profile)) {
    throw ApplicationFailure.nonRetryable("Child scheduled on another engine queue", "ChildTargetMismatch");
  }
  if (!hasChildDriver(target.engine)) throw ApplicationFailure.nonRetryable("Only Pi runs delegated children so far", "ChildTargetError");
}

export function memberActivities(store: MemberStore, supervisor: Supervisor, profiles: ReadonlyMap<string, MemberProfile>, stateDir: string, engine: Conversation["engine"]) {
  const ledger = new ApprovalStore(store.pool);
  const children = new ChildStore(store.pool);
  return {
    async recoverPending(request: TurnRequest, workflowRunId: string): Promise<PublicSegment | null> {
      const signal = Context.current().cancellationSignal;
      for (let count = 0; count < 30; count++) {
        const recovery = await store.stoppedProposal(request, workflowRunId);
        if (!recovery) return null;
        if (recovery.kind === "pending") return recovery;
        if (recovery.kind === "stopping") {
          await delay(200, undefined, { signal });
          continue;
        }
        const { conversation: member, token, checkpoint } = recovery;
        const profile = profiles.get(member.profile);
        const tool = profile?.protectedTool ?? profile?.humanTool;
        const claude = profile?.claude;
        if (!claude || !tool) return null;
        const result = await traced("native.restore", { ...request, engine, workflowRunId }, () => recoverClaudeProposal({
          threadId: request.conversationId, runId: request.requestId, text: request.text, checkpoint, signal,
        }, { ...claude, ownerId: member.ownerId, memberId: member.memberId, stateDir }, tool));
        const approval = await ledger.propose({ ownerId: request.ownerId, conversationId: request.conversationId,
          requestId: request.requestId, memberId: member.memberId, token, invocationId: request.requestId,
          nativeCallId: result.proposal.nativeCallId, toolName: result.proposal.name, arguments: result.proposal.arguments }, result.checkpoint, {recoverStopped:true});
        return { kind: "pending", approval };
      }
      return null;
    },
    async executeChildSegment(key: ChildKey, resume?: Resume): Promise<{ kind: "complete" } | { kind: "pending"; approval: Approval }> {
      const ctx = Context.current();
      const execution = ctx.info.workflowExecution;
      if (execution?.workflowId !== `birbcrew-ts/child/${key.childId}`) throw ApplicationFailure.nonRetryable("Incorrect child workflow");
      const timer = setInterval(() => ctx.heartbeat(), 2000);
      try {
        await refuseMisroutedChild(children, key, ctx.info.taskQueue);
        const identity = {workflowRunId: execution.runId, activityId: ctx.info.activityId, attempt: ctx.info.attempt};
        let start = await children.begin(key, identity, !!resume);
        if (start.kind === "draining") {
          await children.waitStopped(key,start.generation);
          start = await children.begin(key,identity,!!resume);
        }
        if (start.kind === "settled") return {kind:"complete"};
        if (start.kind === "waiting") return {kind:"pending",approval:start.approval};
        if (start.kind === "revoked") {
          await children.waitStopped(key,start.generation);
          await children.finish(key,start.generation,null,true);
          return {kind:"complete"};
        }
        if (start.kind !== "start") throw new Error("Child native stop unconfirmed");
        const {ownerId, conversationId, requestId, childId} = key;
        const result = await supervisor.start({ownerId, conversationId, requestId, childId, text:start.task,
          token:start.generation,execution:identity},ctx.cancellationSignal);
        ctx.cancellationSignal.throwIfAborted();
        if (result.kind === "childDone") return {kind:"complete"};
        if (result.kind === "pending") return result;
        throw ApplicationFailure.nonRetryable("Invalid native child response");
      } finally {
        clearInterval(timer);
      }
    },
    async decideApproval(input: Decision) {
      try {
        return await ledger.decide(input);
      } catch (error) {
        if (error instanceof MemberStoreError) throw ApplicationFailure.nonRetryable(error.code);
        throw error;
      }
    },
    async cancelPending(approval: Pick<Approval, "ownerId" | "memberId" | "conversationId" | "requestId">) {
      const { ownerId, memberId, conversationId, requestId } = approval;
      try {
        await ledger.cancelTurn({ ownerId, memberId, conversationId, requestId });
      } catch (error) {
        if (error instanceof MemberStoreError) throw ApplicationFailure.nonRetryable(error.code);
        throw error;
      }
    },
    async settleApproval(approval: Approval) {
      const workflowRunId = Context.current().info.workflowExecution!.runId;
      return traced("tool.settle", { ...approval, engine, workflowRunId,
        ...(approval.requestId !== approval.invocationId && { childId: approval.invocationId }) },
      () => ledger.settleConfirmed(approval));
    },
    async executeTurn(request: TurnRequest, resume?: Resume | { children: true }): Promise<PublicSegment> {
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat(), 2000);
      try {
        const workflow = ctx.info.workflowExecution;
        if (!workflow) throw ApplicationFailure.nonRetryable("Member turn requires a conversation workflow");
        const identity = { workflowRunId: workflow.runId, activityId: ctx.info.activityId, attempt: ctx.info.attempt };
        const turn = resume ? await store.beginResume(request, "approval" in resume ? resume.approval : null, identity) : await store.beginTurn(request, identity);
        if (turn.kind === "replay") return { kind: "complete", text: turn.reply };
        if (turn.kind === "pending" || turn.kind === "delegated") return turn;
        if (turn.kind === "uncertain") throw ApplicationFailure.nonRetryable("Native turn outcome unknown");
        const result = await supervisor.start({...request, token:turn.token, execution:identity},ctx.cancellationSignal);
        if (result.kind === "childDone") throw ApplicationFailure.nonRetryable("Invalid native parent response");
        return result;
      } catch (error) {
        if (error instanceof MemberStoreError) throw ApplicationFailure.nonRetryable(error.code);
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  };
}
export type MemberActivities = ReturnType<typeof memberActivities>;

/** The conversation workflow's expireApproval activity (docs/approval-expiry.md). It touches only
 * the database, so it runs on the member task queue, not an engine's. */
export function expiryActivity(store: MemberStore) {
  const ledger = new ApprovalStore(store.pool);
  return async (approval: Approval) => {
    try {
      return await ledger.expireTurn(approval);
    } catch (error) {
      if (error instanceof MemberStoreError) throw ApplicationFailure.nonRetryable(error.code);
      throw error;
    }
  };
}
