import { ApprovalStore, decisionSchema } from "./approvals.ts";
import { ApplicationFailure, Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, WorkflowUpdateFailedError } from "@temporalio/client";
import { MemberStoreError, openSchema, turnRequestSchema, conversationKey, turnKey, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberStore } from "./store.ts";
import type { memberConversation } from "./workflow.ts";

import { memberTaskQueue } from "./queues.ts";

/** The admission activity refused the request under its member's budget (ownerAdmissionActivity).
 * A refused admission closes the conversation's workflow, so the caller is told so. */
function usageRefusal(error: unknown) {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ApplicationFailure && cause.type === "usage_limit") return true;
  }
  return false;
}

export class MemberClient {
  private readonly store: MemberStore;
  private readonly temporal: Client;

  constructor(store: MemberStore, temporal: Client) {
    this.store = store;
    this.temporal = temporal;
  }

  private async workflow(conversation: Conversation) {
    const workflowId = `birbcrew-ts/member/${conversation.memberId}/conversation/${conversation.conversationId}`;
    const runId = await this.store.workflowRunId(conversation);
    // A persisted first-turn run ID is evidence of a started logical conversation, not
    // a routing target: Continue-As-New advances its active run.
    if (runId) return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
    try {
      await this.temporal.workflow.start<typeof memberConversation>("memberConversation", {
        taskQueue: memberTaskQueue,
        workflowId,
        workflowIdConflictPolicy: "USE_EXISTING",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        args: [conversation],
      });
      return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
    }
  }

  private async throughRollover<T>(conversation: Conversation, request: TurnRequest,
    action: (handle: Awaited<ReturnType<MemberClient["workflow"]>>) => Promise<T>): Promise<T> {
    // Rejected updates were not accepted and are safe to resubmit. Never retry arbitrary
    // failures or an accepted update whose result is uncertain.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        // Before every attempt and any workflow call: a handoff can seal the source, or the
        // member's budget run out, while a rollover holds this request back, and admission
        // refusing it would fail the conversation.
        await this.store.checkAdmission(request);
        return await action(await this.workflow(conversation));
      }
      catch (error) {
        if (!(error instanceof WorkflowUpdateFailedError) || !(error.cause instanceof ApplicationFailure) ||
            error.cause.type !== "RolloverInProgress") throw error;
        if (Date.now() >= deadline) throw new MemberStoreError("busy");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /** Readiness probe: the same frontend RPC Temporal's own connect check uses. Never touches a workflow. */
  async temporalReachable(deadline: number): Promise<void> {
    await this.temporal.connection.withDeadline(deadline, () => this.temporal.connection.workflowService.getSystemInfo({}));
  }

  async open(input: unknown, deadline?: number): Promise<Conversation> {
    if (deadline !== undefined) return this.temporal.connection.withDeadline(deadline, () => this.open(input));
    const conversation = await this.store.openConversation(openSchema.parse(input));
    await this.workflow(conversation);
    return conversation;
  }

  async requestStatus(input: unknown) {
    const key=turnKey.parse(input);
    const conversation=await this.store.getConversation({ownerId:key.ownerId,conversationId:key.conversationId});
    let status=await this.store.requestStatus(key);
    if(status.phase!=="accepted")return status;
    // Observation only: do not start a workflow or repeat an update to repair status.
    const workflowId=`birbcrew-ts/member/${conversation.memberId}/conversation/${conversation.conversationId}`;
    const execution=await this.temporal.connection.withDeadline(Date.now()+10_000,
      ()=>this.temporal.workflow.getHandle(workflowId).describe());
    if(["COMPLETED","FAILED","CANCELLED","CANCELED","TERMINATED","TIMED_OUT"].includes(execution.status.name)) {
      await this.store.rejectUnstartedAdmission(key);
      status=await this.store.requestStatus(key);
    }
    return status;
  }

  private async reconcileAcceptance(request: ReturnType<typeof turnRequestSchema.parse>) {
    if((await this.store.requestAdmission(request))?.phase!=="accepted")return;
    const {ownerId,conversationId,requestId}=request;
    const status=await this.requestStatus({ownerId,conversationId,requestId});
    if(status.phase==="rejected")throw new MemberStoreError("request_rejected");
  }

  async pending(input: unknown) {
    const key = conversationKey.parse(input);
    const { memberId } = await this.store.getConversation(key);
    return new ApprovalStore(this.store.pool).pending({ ...key, memberId });
  }

  async decide(input: unknown) {
    const value = decisionSchema.parse(input);
    const key = { ownerId: value.ownerId, conversationId: value.conversationId };
    const conversation = await this.store.getConversation(key);
    if (conversation.memberId !== value.memberId) throw new MemberStoreError("not_found");
    const ledger = new ApprovalStore(this.store.pool);
    const prior = await ledger.previousDecision(value);
    if (prior) return prior;
    const handle = await this.workflow(conversation);
    try {
      return await handle.executeUpdate<string, [typeof value]>("decide", { args: [value] });
    } catch (error) {
      const recorded = await ledger.previousDecision(value);
      if (recorded) return recorded;
      throw error;
    }
  }

  async cancelPending(input: unknown, deadline?: number): Promise<void> {
    if (deadline !== undefined) return this.temporal.connection.withDeadline(deadline, () => this.cancelPending(input));
    const key = turnKey.parse(input);
    const conversation = await this.store.getConversation({ ownerId: key.ownerId, conversationId: key.conversationId });
    const ledger = new ApprovalStore(this.store.pool);
    if (await ledger.isCancelled({ ...key, memberId: conversation.memberId })) return;
    const handle = await this.workflow(conversation);
    return handle.executeUpdate<void, [typeof key]>("cancelPending", { args: [key] });
  }

  async accept(input: unknown, deadline?: number): Promise<{ requestId: string }> {
    if (deadline !== undefined) return this.temporal.connection.withDeadline(deadline, () => this.accept(input));
    const request = turnRequestSchema.parse(input);
    const conversation = await this.store.getConversation({ ownerId: request.ownerId, conversationId: request.conversationId });
    await this.reconcileAcceptance(request);
    if (await this.store.committedReply(request) === undefined) {
      try {
        await this.throughRollover(conversation, request, handle => handle.executeUpdate<string, [typeof request]>("acceptTurn", { args: [request] }));
      } catch (error) {
        if (usageRefusal(error)) throw new MemberStoreError("usage_limit_closed");
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        if (await this.store.committedReply(request) === undefined) throw new MemberStoreError("conflict");
      }
    }
    return { requestId: request.requestId };
  }

  async submit(input: unknown): Promise<string> {
    const request = turnRequestSchema.parse(input);
    const conversation = await this.store.getConversation({ ownerId: request.ownerId, conversationId: request.conversationId });
    await this.reconcileAcceptance(request);
    const reply = await this.store.committedReply(request);
    if (reply !== undefined) return reply;
    try {
      return await this.throughRollover(conversation, request, handle => handle.executeUpdate<string, [typeof request]>("submitTurn", { args: [request] }));
    } catch (error) {
      if (usageRefusal(error)) throw new MemberStoreError("usage_limit_closed");
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      const settled = await this.store.committedReply(request);
      if (settled !== undefined) return settled;
      throw new MemberStoreError("conflict");
    }
  }
}
