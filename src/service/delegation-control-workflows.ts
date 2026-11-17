import { Client, WorkflowNotFoundError, isGrpcServiceError } from "@temporalio/client";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MemberActivities } from "./activities.ts";
import type { ChildExecutionKey, ChildExecutionObservation, ChildWorkflowControl, ParentResultObservation,
  SettledParentResult, WakeObservation } from "./delegation-control.ts";
import { turnRequestSchema } from "./domain.ts";
import { childWorkflowId, conversationWorkflowId } from "./queues.ts";
import type { MemberStore } from "./store.ts";

const resultSchema = z.strictObject({ kind: z.literal("complete"), text: z.string() });
const resumeArgumentsSchema = z.tuple([turnRequestSchema, z.strictObject({ children: z.literal(true) })]);
const reconciliationArgumentsSchema = z.tuple([turnRequestSchema, z.string(), z.literal(true)]);
const eventIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"HistoryEventId">();
const closedStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);
const grpcNotFound = 5;
const resumeActivity = "executeTurn" satisfies keyof MemberActivities;
const reconcileActivity = "reconcileTurn" satisfies keyof MemberStore;

type History = Awaited<ReturnType<ReturnType<Client["workflow"]["getHandle"]>["fetchHistory"]>>;
type Events = Readonly<NonNullable<History["events"]>>;
type Converter = Client["options"]["loadedDataConverter"];
type Payload = Parameters<Converter["payloadConverter"]["fromPayload"]>[0];
type Position = { id: z.infer<typeof eventIdSchema>; index: number };
type Terminal =
  | { kind: "complete"; index: number; payloads: readonly Payload[] }
  | { kind: "rejected"; index: number }
  | { kind: "pending" }
  | { kind: "unknown" };
type TaskProgress = { kind: "completed"; position: Position } | { kind: "pending" } | { kind: "unknown" };
type Reconciliation = { kind: "scheduled"; position: Position } | { kind: "pending" } | { kind: "unknown" };

function eventPosition(events: Events, index: number): Position | undefined {
  const id = eventIdSchema.safeParse(events[index]?.eventId?.toString());
  if (!id.success || events.filter(event => event.eventId?.toString() === id.data).length !== 1) return undefined;
  return { id: id.data, index };
}

function terminalFor(events: Events, schedule: Position): Terminal {
  let terminal: Terminal = { kind: "pending" };
  for (const [index, event] of events.entries()) {
    const attributes = [event.activityTaskCompletedEventAttributes, event.activityTaskFailedEventAttributes,
      event.activityTaskTimedOutEventAttributes, event.activityTaskCanceledEventAttributes].filter(value => value != null);
    if (!attributes.some(value => value.scheduledEventId?.toString() === schedule.id)) continue;
    if (attributes.length !== 1 || terminal.kind !== "pending" || index <= schedule.index || !eventPosition(events, index)) {
      return { kind: "unknown" };
    }
    const completion = event.activityTaskCompletedEventAttributes;
    if (completion) {
      if (!completion.result?.payloads) return { kind: "unknown" };
      terminal = { kind: "complete", index, payloads: completion.result.payloads };
    } else {
      terminal = { kind: "rejected", index };
    }
  }
  return terminal;
}

function firstSuccessfulTaskAfter(events: Events, resultIndex: number): TaskProgress {
  for (let index = resultIndex + 1; index < events.length; index++) {
    const completed = events[index].workflowTaskCompletedEventAttributes;
    if (!completed) continue;
    const position = eventPosition(events, index);
    const startedId = eventIdSchema.safeParse(completed.startedEventId?.toString());
    if (!position || !startedId.success) return { kind: "unknown" };
    const startedIndex = events.findIndex(event => event.eventId?.toString() === startedId.data);
    if (!eventPosition(events, startedIndex) || !events[startedIndex].workflowTaskStartedEventAttributes
      || startedIndex >= index) return { kind: "unknown" };
    const terminals = events.flatMap(event => [event.workflowTaskCompletedEventAttributes,
      event.workflowTaskFailedEventAttributes, event.workflowTaskTimedOutEventAttributes])
      .filter(attributes => attributes?.startedEventId?.toString() === startedId.data);
    if (terminals.length !== 1) return { kind: "unknown" };
    if (startedIndex > resultIndex) return { kind: "completed", position };
  }
  return { kind: "pending" };
}

async function decodePayloads(converter: Converter, payloads: readonly Payload[]): Promise<unknown[]> {
  let decoded = [...payloads];
  for (const codec of [...converter.payloadCodecs].reverse()) decoded = await codec.decode(decoded);
  return decoded.map(payload => converter.payloadConverter.fromPayload<unknown>(payload));
}

async function reconciliationAfter(events: Events, rejectedIndex: number, key: SettledParentResult,
  request: z.infer<typeof turnRequestSchema>, converter: Converter): Promise<Reconciliation> {
  const commandTask = firstSuccessfulTaskAfter(events, rejectedIndex);
  if (commandTask.kind !== "completed") return commandTask;
  let found: Position | undefined;
  for (const [index, event] of events.entries()) {
    const candidate = event.activityTaskScheduledEventAttributes;
    if (candidate?.activityType?.name !== reconcileActivity
      || candidate.workflowTaskCompletedEventId?.toString() !== commandTask.position.id) continue;
    const position = eventPosition(events, index);
    if (!position || index <= commandTask.position.index || !candidate.input?.payloads) return { kind: "unknown" };
    const args = reconciliationArgumentsSchema.safeParse(await decodePayloads(converter, candidate.input.payloads));
    if (!args.success) return { kind: "unknown" };
    if (args.data[1] !== key.workflowRunId || !isDeepStrictEqual(args.data[0], request)) continue;
    if (found) return { kind: "unknown" };
    found = position;
  }
  return found ? { kind: "scheduled", position: found } : { kind: "pending" };
}

async function observeDelivery({ events, key, converter }: {
  events: Events; key: SettledParentResult; converter: Converter;
}): Promise<ParentResultObservation> {
  const anchors = events.flatMap((event, index) => event.activityTaskScheduledEventAttributes?.activityId === key.resumeActivityId
    ? [index] : []);
  if (anchors.length === 0) return { kind: "pending" };
  if (anchors.length !== 1) return { kind: "unknown" };
  const anchor = eventPosition(events, anchors[0]);
  const scheduled = events[anchors[0]].activityTaskScheduledEventAttributes;
  if (!anchor || scheduled?.activityType?.name !== resumeActivity || !scheduled.input?.payloads) return { kind: "unknown" };
  const resume = resumeArgumentsSchema.safeParse(await decodePayloads(converter, scheduled.input.payloads));
  if (!resume.success || resume.data[0].conversationId !== key.conversationId || resume.data[0].requestId !== key.requestId) {
    return { kind: "unknown" };
  }
  let terminal = terminalFor(events, anchor);
  if (terminal.kind === "rejected") {
    const reconciliation = await reconciliationAfter(events, terminal.index, key, resume.data[0], converter);
    if (reconciliation.kind !== "scheduled") return reconciliation;
    terminal = terminalFor(events, reconciliation.position);
  }
  if (terminal.kind === "rejected") return { kind: "pending" };
  if (terminal.kind !== "complete") return terminal;
  const decoded = await decodePayloads(converter, terminal.payloads);
  if (decoded.length !== 1) return { kind: "unknown" };
  const result = resultSchema.safeParse(decoded[0]);
  if (!result.success || result.data.text !== key.reply) return { kind: "unknown" };
  const consumed = firstSuccessfulTaskAfter(events, terminal.index);
  return consumed.kind === "completed" ? { kind: "observed" } : consumed;
}

export class TemporalDelegationWorkflows implements ChildWorkflowControl {
  private readonly client: Client;
  constructor(client: Client) { this.client = client; }
  async signalDecision(key: ChildExecutionKey): Promise<WakeObservation> {
    try {
      await this.client.connection.withDeadline(Date.now() + 3000, () => this.client.workflow
        // workflow.ts:19 defines this signal. It cannot export the name: the rollback proof needs workflow.ts byte-identical.
        .getHandle(childWorkflowId(key.childId), key.workflowRunId ?? undefined).signal("childDecision"));
      return { kind: "accepted" };
    } catch (error) { return { kind: error instanceof WorkflowNotFoundError ? "missing" : "unavailable" }; }
  }
  async observe(key: ChildExecutionKey): Promise<ChildExecutionObservation> {
    try {
      const execution = await this.client.connection.withDeadline(Date.now() + 3000, () => this.client.workflow
        .getHandle(childWorkflowId(key.childId), key.workflowRunId ?? undefined).describe());
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
  async observeParentResult(key: SettledParentResult): Promise<ParentResultObservation> {
    try {
      return await this.client.connection.withDeadline(Date.now() + 5000, async () => {
        const handle = this.client.workflow.getHandle(conversationWorkflowId(key.memberId, key.conversationId), key.workflowRunId);
        // fetchHistory surfaces raw NOT_FOUND for both a missing run and a missing namespace; describe tells them apart.
        const history = await handle.fetchHistory().catch(async (error: unknown) => {
          if (isGrpcServiceError(error) && error.code === grpcNotFound) await handle.describe();
          throw error;
        });
        return observeDelivery({ events: history.events ?? [], key, converter: this.client.options.loadedDataConverter });
      });
    } catch (error) { return { kind: error instanceof WorkflowNotFoundError ? "missing" : "unavailable" }; }
  }
}
