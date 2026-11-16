import { Client, WorkflowNotFoundError } from "@temporalio/client";
import { z } from "zod";
import type { ChildExecutionKey, ChildExecutionObservation, ChildWorkflowControl, ParentResultKey,
  ParentResultObservation, WakeObservation } from "./delegation-control.ts";

const resultSchema = z.strictObject({ kind: z.literal("complete"), text: z.string() });
const closedStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);

export class TemporalDelegationWorkflows implements ChildWorkflowControl {
  private readonly client: Client;
  constructor(client: Client) { this.client = client; }
  async signalDecision(key: ChildExecutionKey): Promise<WakeObservation> {
    try {
      await this.client.connection.withDeadline(Date.now() + 3000, () => this.client.workflow
        .getHandle(`birbcrew-ts/child/${key.childId}`, key.workflowRunId ?? undefined).signal("childDecision"));
      return { kind: "accepted" };
    } catch (error) { return { kind: error instanceof WorkflowNotFoundError ? "missing" : "unavailable" }; }
  }
  async observe(key: ChildExecutionKey): Promise<ChildExecutionObservation> {
    try {
      const execution = await this.client.connection.withDeadline(Date.now() + 3000, () => this.client.workflow
        .getHandle(`birbcrew-ts/child/${key.childId}`, key.workflowRunId ?? undefined).describe());
      if (key.workflowRunId !== null && key.workflowRunId !== execution.runId) return { kind: "unknown" };
      if (closedStatuses.has(execution.status.name)) return { kind: "closed", runId: execution.runId, status: execution.status.name };
      if (execution.status.name === "RUNNING" || execution.status.name === "PAUSED") {
        return { kind: "open", runId: execution.runId, status: execution.status.name };
      }
      return { kind: "unknown" };
    } catch (error) {
      return { kind: error instanceof WorkflowNotFoundError ? key.workflowRunId === null ? "not_started" : "missing" : "unavailable" };
    }
  }
  async observeParentResult(key: ParentResultKey): Promise<ParentResultObservation> {
    if (key.workflowRunId === null) return { kind: "missing" };
    if (key.resumeActivityId === null || key.reply === null) return { kind: "pending" };
    try {
      return await this.client.connection.withDeadline(Date.now() + 5000, async () => {
        const history = await this.client.workflow.getHandle(
          `birbcrew-ts/member/${key.memberId}/conversation/${key.conversationId}`, key.workflowRunId ?? undefined).fetchHistory();
        const events = history.events ?? [];
        const scheduled = events.find(event => event.activityTaskScheduledEventAttributes?.activityId === key.resumeActivityId
          && event.activityTaskScheduledEventAttributes.activityType?.name === "executeTurn");
        if (!scheduled?.eventId) return { kind: "pending" };
        const completedIndex = events.findIndex(event => event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString()
          === scheduled.eventId?.toString());
        if (completedIndex < 0) return { kind: "pending" };
        const payloads = events[completedIndex].activityTaskCompletedEventAttributes?.result?.payloads;
        if (!payloads || payloads.length !== 1) return { kind: "unknown" };
        const converter = this.client.options.loadedDataConverter;
        let decoded = payloads;
        for (const codec of [...converter.payloadCodecs].reverse()) decoded = await codec.decode(decoded);
        if (decoded.length !== 1) return { kind: "unknown" };
        const result = resultSchema.safeParse(converter.payloadConverter.fromPayload(decoded[0]));
        if (!result.success || result.data.text !== key.reply) return { kind: "unknown" };
        const processed = events.slice(completedIndex + 1).some(event => {
          const startedId = event.workflowTaskCompletedEventAttributes?.startedEventId?.toString();
          return startedId !== undefined && events.slice(completedIndex + 1).some(started =>
            started.workflowTaskStartedEventAttributes && started.eventId?.toString() === startedId);
        });
        return { kind: processed ? "observed" : "pending" };
      });
    } catch (error) { return { kind: error instanceof WorkflowNotFoundError ? "missing" : "unavailable" }; }
  }
}
