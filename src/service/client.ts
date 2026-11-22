import { assertContentWritable, contentErasureState, preflightContentErasure, reserveTextWorkflowStart, settleTextWorkflowStart, sealTextClosure, terminalWorkflowStatuses, type ClosureEvidence } from "./content-erasure-store.ts";
import { isTextEngine } from "./domain.ts";
import { hasFailureType as erasureFailureType } from "./failure-type.ts";
import { ApprovalStore, decisionSchema } from "./approvals.ts";
import { ApplicationFailure, Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, WorkflowUpdateFailedError } from "@temporalio/client";
import { MemberStoreError, openSchema, TextAdmissionError, turnRequestSchema, conversationKey, turnKey, type Conversation, type TurnRequest } from "./domain.ts";
import type { MemberStore } from "./store.ts";
import type { memberConversation } from "./workflow.ts";

import { memberTaskQueue } from "./queues.ts";
import { hasFailureType, textAdmissionFailure } from "./failure-type.ts";


export class MemberClient {
  private readonly store: MemberStore;
  private readonly temporal: Client;

  constructor(store: MemberStore, temporal: Client) {
    this.store = store;
    this.temporal = temporal;
  }

  private async workflow(conversation: Conversation) {
    const workflowId = `birbcrew-ts/member/${conversation.memberId}/conversation/${conversation.conversationId}`;
    if (isTextEngine(conversation.engine)) {
      await assertContentWritable(this.store.pool, conversation, false);
      const state = await contentErasureState(this.store.pool,conversation);
      if (state.text_lifecycle === "sealed_closed" || (await this.store.pool.query(
        "SELECT 1 FROM birbcrew_ts.conversation_workflow_starts WHERE conversation_id=$1 AND state='acknowledged' LIMIT 1", [conversation.conversationId])).rowCount) {
        return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
      }
      const attempt = await reserveTextWorkflowStart(this.store,conversation,workflowId);
      if (!attempt) return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
      try {
        const handle = await this.temporal.connection.withDeadline(Date.now()+10_000, () => this.temporal.workflow.start<typeof memberConversation>("memberConversation", {
          taskQueue: memberTaskQueue, workflowId, workflowIdConflictPolicy: "USE_EXISTING", workflowIdReusePolicy: "REJECT_DUPLICATE", args: [conversation],
        }));
        await settleTextWorkflowStart(this.store,conversation,attempt,handle.firstExecutionRunId);
        return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          const execution = await this.temporal.connection.withDeadline(Date.now()+10_000, () => this.temporal.workflow.getHandle(workflowId).describe());
          await settleTextWorkflowStart(this.store,conversation,attempt,execution.runId);
          return this.temporal.workflow.getHandle<typeof memberConversation>(workflowId);
        }
        await settleTextWorkflowStart(this.store,conversation,attempt);
        throw error;
      }
    }
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

  async describeClosure(key: Pick<Conversation,"ownerId"|"conversationId">): Promise<ClosureEvidence> {
    const candidate = await this.store.transaction(async db => {
      const row = await contentErasureState(db,key,true);
      if (!isTextEngine(row.engine)) throw new MemberStoreError("content_erasure_unsupported");
      if ((await db.query("SELECT 1 FROM birbcrew_ts.conversation_workflow_starts WHERE conversation_id=$1 AND state IN ('reserved','ambiguous') LIMIT 1", [key.conversationId])).rowCount) throw new MemberStoreError("content_start_unresolved");
      return row;
    });
    if (candidate.text_closure) return candidate.text_closure;
    const workflowId = `birbcrew-ts/member/${candidate.memberId}/conversation/${candidate.conversationId}`;
    let execution;
    try { execution = await this.temporal.connection.withDeadline(Date.now()+5_000, () => this.temporal.workflow.getHandle(workflowId).describe()); }
    catch (error) { if (error instanceof WorkflowNotFoundError) throw new MemberStoreError("conversation_open"); throw error; }
    if (!terminalWorkflowStatuses.includes(execution.status.name)) throw new MemberStoreError("conversation_open");
    return sealTextClosure(this.store,key,{workflowId,runId:execution.runId,status:execution.status.name,
      namespace:this.temporal.options.namespace,generation:candidate.text_start_generation});
  }

  async ensureCleanupWorkflow(key: Pick<Conversation,"ownerId"|"conversationId"> & {erasureId:string}) {
    const state = await contentErasureState(this.store.pool,key);
    if (state.erased_at) return;
    if (state.content_erasure_id !== key.erasureId) throw new MemberStoreError("conflict");
    await this.temporal.connection.withDeadline(Date.now()+5_000, () => this.temporal.workflow.start("conversationContentErasure", {
      taskQueue:memberTaskQueue, workflowId:`birbcrew-ts/content-erasure/${key.conversationId}`,
      workflowIdConflictPolicy:"USE_EXISTING", workflowIdReusePolicy:"ALLOW_DUPLICATE", args:[key],
    }));
  }

  async closeTextConversation(input: Pick<Conversation,"ownerId"|"conversationId">): Promise<{apiVersion:"1";conversationId:string;closure:"closed"|"requested"}> {
    const key = conversationKey.parse(input), state = await contentErasureState(this.store.pool,key);
    if (!isTextEngine(state.engine)) throw new MemberStoreError("content_erasure_unsupported");
    if (state.text_closure) return {apiVersion:"1",conversationId:key.conversationId,closure:"closed"};
    try {
      await this.describeClosure(key);
      return {apiVersion:"1",conversationId:key.conversationId,closure:"closed"};
    } catch (error) { if (!(error instanceof MemberStoreError && error.code === "conversation_open")) throw error; }
    await preflightContentErasure(this.store,key,false);
    const workflowId = `birbcrew-ts/member/${state.memberId}/conversation/${key.conversationId}`;
    try {
      await this.temporal.connection.withDeadline(Date.now()+5_000, () => this.temporal.workflow.getHandle(workflowId).executeUpdate("closeTextConversation", {args:[key]}));
    } catch (error) {
      for (const code of ["content_requests_unresolved","content_runtime_unconfirmed","conversation_open"] as const) {
        if (erasureFailureType(error,code)) throw new MemberStoreError(code);
      }
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      await this.describeClosure(key);
      return {apiVersion:"1",conversationId:key.conversationId,closure:"closed"};
    }
    return {apiVersion:"1",conversationId:key.conversationId,closure:"requested"};
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
        if (hasFailureType(error,"conversation_erased")) throw new MemberStoreError("conversation_erased");
        // A text-engine admission refusal; the workflow keeps that run open.
        const refused = textAdmissionFailure(error);
        if (refused) throw new TextAdmissionError(refused);
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
    if(status.phase!=="accepted") {
      if (isTextEngine(conversation.engine) && !status.erased) await this.describeClosure(key).catch(() => undefined);
      return status;
    }
    // Observation only: do not start a workflow or repeat an update to repair status.
    const workflowId=`birbcrew-ts/member/${conversation.memberId}/conversation/${conversation.conversationId}`;
    const execution=await this.temporal.connection.withDeadline(Date.now()+10_000,
      ()=>this.temporal.workflow.getHandle(workflowId).describe());
    if(["COMPLETED","FAILED","CANCELLED","CANCELED","TERMINATED","TIMED_OUT"].includes(execution.status.name)) {
      await this.store.rejectUnstartedAdmission(key);
      status=await this.store.requestStatus(key);
      if (isTextEngine(conversation.engine)) await this.describeClosure(key).catch(() => undefined);
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
    if(isTextEngine(conversation.engine)) {
      await assertContentWritable(this.store.pool,key,false);
      const status = await this.requestStatus(key);
      if (["committed","rejected"].includes(status.phase)) return;
    }
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
        // usage_limit still closes the member workflow.
        if (hasFailureType(error, "usage_limit")) throw new MemberStoreError("usage_limit_closed");
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
      // usage_limit still closes the member workflow.
      if (hasFailureType(error, "usage_limit")) throw new MemberStoreError("usage_limit_closed");
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      const settled = await this.store.committedReply(request);
      if (settled !== undefined) return settled;
      throw new MemberStoreError("conflict");
    }
  }
}
