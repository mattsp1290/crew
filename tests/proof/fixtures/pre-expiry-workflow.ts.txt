import {
  allHandlersFinished, ApplicationFailure, CancellationScope, workflowInfo, condition, continueAsNew, patched, defineSignal, defineUpdate,
  executeChild, getExternalWorkflowHandle, isCancellation, proxyActivities, setHandler
} from "@temporalio/workflow";
import { workflowGenerationTurnLimit, historyRequiresRollover } from "./limits.ts";
import { acceptsChoice } from "./deferral.ts";
import { turnRequestSchema, type Conversation, type TurnRequest } from "./domain.ts";
import type { Approval, Decision, Choice } from "./approvals.ts";
import type { ChildKey, ChildStore } from "./children.ts";
import type { MemberActivities, Resume } from "./activities.ts";

import type { MemberStore, ownerAdmissionActivity } from "./store.ts";
import { activityQueue, memberTaskQueue } from "./queues.ts";

export const submitTurn = defineUpdate<string, [TurnRequest]>("submitTurn");
export const acceptTurn = defineUpdate<string, [TurnRequest]>("acceptTurn");

const childDecision = defineSignal("childDecision");

function actions(queue: string) {
  return proxyActivities<MemberActivities>({
    taskQueue: queue, startToCloseTimeout: "3 minutes", scheduleToCloseTimeout: "10 minutes",
    heartbeatTimeout: "15 seconds", retry: { maximumAttempts: 3 }, cancellationType: "WAIT_CANCELLATION_COMPLETED",
  });
}

export async function piChildWorkflow(key: ChildKey, profile: string): Promise<void> {
  const { executeChildSegment, settleApproval } = actions(activityQueue("pi", profile));
  const {reconcileChild, closeExitedChild} = proxyActivities<{reconcileChild:ChildStore["reconcile"]; closeExitedChild:ChildStore["closeExitedChild"]}>({
    taskQueue:memberTaskQueue,startToCloseTimeout:"20 seconds",scheduleToCloseTimeout:"2 minutes",
  });
  async function segment(resume?: Resume) {
    try {
      return await executeChildSegment(key,resume);
    } catch (error) {
      if (isCancellation(error)) throw error;
      return reconcileChild(key,workflowInfo().runId,!!resume);
    }
  }
  let answered = false;
  setHandler(childDecision, () => { answered = true; });
  try {
    const first = await segment();
    if (first.kind === "complete") return;
    await condition(() => answered);
    const outcome = await settleApproval(first.approval);
    const last = await segment({ approval: first.approval, outcome });
    if (last.kind !== "complete") throw ApplicationFailure.nonRetryable("Repeated child approval");
  } catch (error) {
    if (!isCancellation(error)) throw error;
    await CancellationScope.nonCancellable(() => closeExitedChild(key, true));
    throw error;
  }
}

export async function memberConversation(conversation: Conversation): Promise<void> {
  // Preserve pre-rollover histories: existing proof workflows still close after four turns.
  const rollover = patched("bounded-conversations-v1");
  const generationLimit = rollover ? workflowGenerationTurnLimit : 4;
  const historyBoundary = () => rollover && historyRequiresRollover(workflowInfo());
  const { conversationProgress, recordAcceptance, rejectAccepted, rejectUnstartedAdmission } = proxyActivities<Pick<MemberStore, "conversationProgress" | "rejectAccepted" | "rejectUnstartedAdmission">
    & { recordAcceptance: ReturnType<typeof ownerAdmissionActivity> }>({
    taskQueue: memberTaskQueue, startToCloseTimeout: "20 seconds", scheduleToCloseTimeout: "60 seconds",
  });
  const { executeTurn, decideApproval, settleApproval, cancelPending } = actions(activityQueue(conversation.engine, conversation.profile));
  const { reconcileTurn } = proxyActivities<Pick<MemberStore, "reconcileTurn">>({
    taskQueue: memberTaskQueue, startToCloseTimeout: "20 seconds",
  });
  const { recoverPending } = proxyActivities<MemberActivities>({
    taskQueue: activityQueue(conversation.engine, conversation.profile),
    startToCloseTimeout: "20 seconds", scheduleToCloseTimeout: "60 seconds", retry: { maximumAttempts: 2 },
  });
  const { closeExitedChild } = proxyActivities<Pick<ChildStore, "closeExitedChild">>({
    taskQueue: memberTaskQueue, startToCloseTimeout: "15 seconds", scheduleToCloseTimeout: "35 seconds",
  });
  const { quarantineDelegation } = proxyActivities<Pick<ChildStore, "quarantineDelegation">>({
    taskQueue: memberTaskQueue, startToCloseTimeout: "15 seconds",
  });
  const turns = new Map<string, { text: string; durable: boolean; admission: Promise<void>; result: Promise<string> }>();
  let previous = Promise.resolve();
  let failed = false;
  let cancelled = false;
  let inFlight = 0;

  const liveCalls = new Map<string,string>();
  const commands = proxyActivities<{
    decideLive(input: Decision): Promise<Choice>;
    cancelGenerating(input: Pick<TurnRequest,"ownerId"|"conversationId"|"requestId">): Promise<boolean>;
    cancelLive(input: Pick<Approval,"ownerId"|"memberId"|"conversationId"|"requestId">): Promise<void>;
  }>({taskQueue:memberTaskQueue,startToCloseTimeout:"10 seconds",scheduleToCloseTimeout:"20 seconds",
    retry:{maximumAttempts:3}});
  setHandler(defineSignal<[{requestId:string;approvalId:string;invocationId:string}]>("liveProposal"), card => {
    if (conversation.engine === "codex" && turns.has(card.requestId) && card.requestId === card.invocationId) {
      liveCalls.set(card.requestId,card.approvalId);
    }
  });

  let pending: Approval | undefined;
  let answered = false;
  let batch: { requestId: string; children: ChildKey[]; scope: CancellationScope } | undefined;

  async function waitForPublishedCall(requestId: string) {
    const turn = turns.get(requestId);
    if (!pending && !batch && turn) {
      await Promise.race([condition(() => pending?.requestId === requestId || batch?.requestId === requestId), turn.result]);
    }
  }

  function matches(value: Decision) {
    return pending && acceptsChoice(pending.toolName, value.choice) &&
      value.ownerId === pending.ownerId && value.memberId === pending.memberId &&
      value.conversationId === pending.conversationId && value.requestId === pending.requestId &&
      value.invocationId === pending.invocationId && value.nativeCallId === pending.nativeCallId &&
      value.approvalId === pending.approvalId && value.version === pending.version &&
      value.argumentDigest === pending.argumentDigest;
  }

  setHandler(defineUpdate<string, [Decision]>("decide"), async (value) => {
    if (value.ownerId !== conversation.ownerId) throw ApplicationFailure.nonRetryable("Conversation not found");
    if (conversation.engine === "codex") {
      const advertised = liveCalls.get(value.requestId);
      if (!turns.has(value.requestId) || (advertised && advertised !== value.approvalId)) {
        throw ApplicationFailure.nonRetryable("Unknown live call");
      }
      // A committed proposal can reach the gateway before its Temporal signal arrives.
      return commands.decideLive(value);
    }
    await waitForPublishedCall(value.requestId);
    const child = batch?.requestId === value.requestId && batch.children.find(({ childId }) => childId === value.invocationId);
    if (child) {
      const choice = await decideApproval(value);
      await getExternalWorkflowHandle(`birbcrew-ts/child/${child.childId}`).signal(childDecision);
      return choice;
    }
    if (!matches(value)) throw ApplicationFailure.nonRetryable("Unknown or stale approval");
    const decision = await decideApproval(value);
    answered = true;
    return decision;
  });

  setHandler(defineUpdate<void, [{ ownerId: string; conversationId: string; requestId: string }]>("cancelPending"),
    async (value) => {
      if (value.ownerId !== conversation.ownerId) throw ApplicationFailure.nonRetryable("Conversation not found");
      if (conversation.engine === "codex") {
        if (!turns.has(value.requestId) || value.conversationId !== conversation.conversationId) {
          throw ApplicationFailure.nonRetryable("Unknown live turn");
        }
        await commands.cancelLive({...value,memberId:conversation.memberId});
        cancelled = true;
        return;
      }
      if (!batch && !pending && turns.has(value.requestId) && value.conversationId === conversation.conversationId &&
          await commands.cancelGenerating(value)) {
        cancelled = true;
        return;
      }
      await waitForPublishedCall(value.requestId);
      const active = batch;
      if (active && active.requestId === value.requestId && value.conversationId === conversation.conversationId) {
        await cancelPending({ ...value, memberId: conversation.memberId });
        cancelled = true;
        active.scope.cancel();
        return;
      }
      if (!pending || value.ownerId !== conversation.ownerId || value.conversationId !== conversation.conversationId ||
          value.requestId !== pending.requestId) throw ApplicationFailure.nonRetryable("No matching pending turn");
      await cancelPending(pending);
      cancelled = true;
      answered = true;
    });

  async function segment(request: TurnRequest, resume?: Resume | {children:true}) {
    try {
      return await executeTurn(request, resume);
    } catch (error) {
      const run = workflowInfo().runId;
      const result = await CancellationScope.nonCancellable(() => reconcileTurn(request, run, Boolean(resume)));
      if (result?.kind === "recover") {
        try {
          const pending = await recoverPending(request, run);
          if (pending) return pending;
        } catch {
          // The final database check also handles a lost recovery acknowledgement.
        }
        const final = await CancellationScope.nonCancellable(() => reconcileTurn(request, run, false, false));
        if (final?.kind === "pending" || final?.kind === "complete") return final;
      } else if (result) {
        return result;
      }
      throw error;
    }
  }

  async function run(request: TurnRequest) {
    const first = await segment(request);
    liveCalls.delete(request.requestId);
    if (first.kind === "complete") return first.text;
    if (first.kind === "delegated") {
      const scope = new CancellationScope();
      batch = { requestId: request.requestId, children: first.children, scope };
      try {
        await Promise.all(first.children.map(async key => {
          try {
            await scope.run(() => executeChild(piChildWorkflow, {
              workflowId: `birbcrew-ts/child/${key.childId}`, workflowIdReusePolicy: "REJECT_DUPLICATE",
              cancellationType: "WAIT_CANCELLATION_COMPLETED", args: [key, conversation.profile],
            }));
          } catch (error) {
            // Temporal termination bypasses the child's own cancellation handler.
            await CancellationScope.nonCancellable(() => closeExitedChild(key, isCancellation(error)));
          }
        }));
      } catch (error) {
        await CancellationScope.nonCancellable(() => quarantineDelegation(conversation, request, workflowInfo().runId));
        scope.cancel();
        throw error;
      } finally {
        batch = undefined;
      }
      const resumed = await segment(request, { children: true });
      if (resumed.kind !== "complete") throw ApplicationFailure.nonRetryable("Expected a completed delegation");
      return resumed.text;
    }
    pending = first.approval;
    answered = false;
    // A standing grant approved the call when it was proposed, so no answer will come. Testing
    // the field first keeps the patch marker out of every history without such a call.
    if (!first.approval.grantId || !patched("standing-grants-v1")) await condition(() => answered);
    const outcome = await settleApproval(first.approval);
    const resumed = await segment(request, { approval: first.approval, outcome });
    pending = undefined;
    if (resumed.kind !== "complete") throw ApplicationFailure.nonRetryable("Expected a completed continuation");
    return resumed.text;
  }

  function validate(value: TurnRequest): TurnRequest {
    // The bound every internal path shares; admission, outside workflow code, decides which request
    // may use more than the public prompt bound. enqueue repeats this check on replay, so it may only
    // widen: every request a recorded history holds passed the narrower bound.
    const parsed = turnRequestSchema.safeParse(value);
    if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid turn request");
    const request = parsed.data;
    if (request.ownerId !== conversation.ownerId || request.conversationId !== conversation.conversationId) {
      throw ApplicationFailure.nonRetryable("Conversation not found");
    }
    // Do not keep admitting duplicate update handlers into an already-full history.
    // Decisions/cancellations stay available so pending work can drain safely.
    if (historyBoundary()) throw ApplicationFailure.nonRetryable("Conversation history is rolling over", "RolloverInProgress");
    const existing = turns.get(request.requestId);
    if (existing) {
      if (existing.text !== request.text) throw ApplicationFailure.nonRetryable("Request payload conflict");
      return request;
    }
    if (failed || cancelled) throw ApplicationFailure.nonRetryable("Conversation closed to new turns");
    if (turns.size >= generationLimit) {
      if (rollover) throw ApplicationFailure.nonRetryable("Conversation history is rolling over", "RolloverInProgress");
      throw ApplicationFailure.nonRetryable("Conversation closed to new turns");
    }
    return request;
  }

  async function persistAdmission(request: TurnRequest) {
    await recordAcceptance(request);
  }

  function enqueue(value: TurnRequest, durable = rollover) {
    const request = validate(value);
    const existing = turns.get(request.requestId);
    if (existing) {
      if (durable && !existing.durable) {
        existing.admission = persistAdmission(request);
        void existing.admission.catch(() => {});
        existing.durable = true;
      }
      return existing;
    }
    // Admission is persisted before acknowledging acceptTurn. History owns the queued
    // execution; if an earlier turn prevents it from running, persist that outcome too.
    const admission = durable ? persistAdmission(request) : Promise.resolve();
    void admission.catch(() => {}); // Also observed by the queued runner and admission handler.
    const entry = { text: request.text, durable, admission, result: undefined! as Promise<string> };
    inFlight++;
    const result = previous.then(async () => {
      try { await entry.admission; }
      catch (error) {
        // The SQL admission may have committed even if Temporal lost every ack.
        // Persist a no-execution outcome before closing whenever storage is available.
        if (patched("recover-admission-ack-v1")) await rejectUnstartedAdmission(request);
        throw error;
      }
      if (failed || cancelled) {
        if (entry.durable) await rejectAccepted(request, cancelled ? "predecessor_cancelled" : "predecessor_failed");
        throw ApplicationFailure.nonRetryable("Accepted request did not execute because the conversation closed", "RequestRejected");
      }
      return run(request);
    });
    entry.result = result;
    turns.set(request.requestId, entry);
    previous = result.then(() => { inFlight--; }, () => { inFlight--; failed = true; });
    return entry;
  }
  setHandler(submitTurn, value => enqueue(value).result, { validator: validate });
  // Completing admission separately from execution makes a rejection distinguishable
  // from acceptance without waiting for a model or human decision.
  setHandler(acceptTurn, async value => {
    await enqueue(value, true).admission;
    return value.requestId;
  }, { validator: validate });

  await condition(() => (failed || cancelled || turns.size >= generationLimit || historyBoundary()) && inFlight === 0 && allHandlersFinished());
  if (failed) throw ApplicationFailure.nonRetryable("Member conversation failed");
  if (rollover && !cancelled) {
    // Keep the recorded full-record command on replay of an affected history.
    // The activity adapter handles that exact legacy DTO while the store stays strict.
    const progressKey = patched("narrow-progress-key-v1")
      ? { ownerId: conversation.ownerId, conversationId: conversation.conversationId }
      : conversation;
    const progress = await conversationProgress(progressKey);
    // Updates/signals can arrive while the progress activity runs. Never abandon a handler,
    // pending approval, child batch or cancellation acknowledgement at the run boundary.
    await condition(() => allHandlersFinished());
    if (!cancelled && !failed && !progress.terminal) await continueAsNew<typeof memberConversation>(conversation);
  }
}
