import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Client, type Connection } from "@temporalio/client";
import proto from "@temporalio/proto";
import { z } from "zod";
import type { ParentResultObservation, SettledParentResult } from "../../src/service/delegation-control.ts";
import { TemporalDelegationWorkflows } from "../../src/service/delegation-control-workflows.ts";

const { temporal: protocol } = proto;
type History = Awaited<ReturnType<ReturnType<Client["workflow"]["getHandle"]>["fetchHistory"]>>;
type Events = NonNullable<History["events"]>;
type HistoryEvent = Events[number];

/**
 * Runs the public adapter against modified deep clones of one captured parent history, served through mocked handles,
 * and writes the cloned-history and codec evidence even when a case fails.
 */
export async function adapterHistoryCases({ context, connection, temporal, evidence, history, key, request, delivered, workflowId }: {
  context: TestContext; connection: Connection; temporal: Client; evidence(name: string, value: unknown): Promise<void>;
  history: { raw: History; execute: HistoryEvent; failed: HistoryEvent; reconcile: HistoryEvent; completed: HistoryEvent;
    postCompletionWorkflowTasks: HistoryEvent[] };
  key: SettledParentResult; request: { ownerId: string; conversationId: string; requestId: string; text: string };
  delivered: string; workflowId: string;
}) {
  const actualHistoryBytes = protocol.api.history.v1.History.encode(history.raw).finish();
  const cloneHistory = () => protocol.api.history.v1.History.decode(actualHistoryBytes);
  const eventId = (event: HistoryEvent) => { assert.ok(event.eventId); return event.eventId.toString(); };
  const executeId = eventId(history.execute), failureId = eventId(history.failed);
  const reconcileId = eventId(history.reconcile), resultId = eventId(history.completed);
  const commandTaskId = history.reconcile.activityTaskScheduledEventAttributes?.workflowTaskCompletedEventId?.toString();
  assert.ok(commandTaskId);
  const consumingTaskId = eventId(history.postCompletionWorkflowTasks[0]);
  function required(events: Events, id: string) {
    const event = events.find(event => event.eventId?.toString() === id);
    assert.ok(event, "The captured actual history contains required fixture event " + id);
    return event;
  }
  function scheduled(events: Events, id: string) {
    const attributes = required(events, id).activityTaskScheduledEventAttributes;
    assert.ok(attributes); return attributes;
  }
  function completedTask(events: Events, id: string) {
    const attributes = required(events, id).workflowTaskCompletedEventAttributes;
    assert.ok(attributes); return attributes;
  }
  function payload(value: unknown) {
    const encoded = temporal.options.loadedDataConverter.payloadConverter.toPayload(value);
    assert.ok(encoded); return encoded;
  }
  function setArguments(events: Events, id: string, args: unknown[]) {
    scheduled(events, id).input = { payloads: args.map(payload) };
  }
  function setResult(events: Events, values: unknown[]) {
    const attributes = required(events, resultId).activityTaskCompletedEventAttributes;
    assert.ok(attributes); attributes.result = { payloads: values.map(payload) };
  }
  function remove(events: Events, id: string) {
    const index = events.findIndex(event => event.eventId?.toString() === id);
    assert.ok(index >= 0); events.splice(index, 1);
  }
  function moveBefore(events: Events, id: string, beforeId: string) {
    const event = required(events, id); remove(events, id);
    const index = events.findIndex(event => event.eventId?.toString() === beforeId);
    assert.ok(index >= 0); events.splice(index, 0, event);
  }
  const fixtureClient = new Client({ connection });
  const fixtureHandle = fixtureClient.workflow.getHandle(workflowId, key.workflowRunId);
  let fixture = cloneHistory();
  assert.ok(fixture.events && fixture.events.length < 200, "Captured history bounds every cloned adapter fixture");
  const historyMock = context.mock.method(fixtureHandle, "fetchHistory", async () => fixture);
  const handleMock = context.mock.method(fixtureClient.workflow, "getHandle", () => fixtureHandle);
  const fixtureObserver = new TemporalDelegationWorkflows(fixtureClient);
  const fixtureChecks: { name: string; expected: "conservative" | "observed"; observation: ParentResultObservation }[] = [];
  async function checkFixture(name: string, alter: (events: Events) => void, expected: "conservative" | "observed" = "conservative") {
    fixture = cloneHistory();
    assert.ok(fixture.events); alter(fixture.events);
    const observation = await fixtureObserver.observeParentResult(key);
    fixtureChecks.push({ name, expected, observation });
    if (expected === "observed") assert.deepEqual(observation, { kind: "observed" }, name);
    else assert.ok(observation.kind === "pending" || observation.kind === "unknown", name + " must remain conservative");
  }
  try {
    await checkFixture("unmodified-clone-control", () => {}, "observed");
    for (const [name, args] of [
      ["reconcile-other-request-same-text", [{ ...request, requestId: randomUUID() }, key.workflowRunId, true]],
      ["reconcile-other-conversation-same-text", [{ ...request, conversationId: randomUUID() }, key.workflowRunId, true]],
      ["reconcile-wrong-request-text", [{ ...request, text: request.text + " changed" }, key.workflowRunId, true]],
      ["reconcile-wrong-owner", [{ ...request, ownerId: request.ownerId + "-other" }, key.workflowRunId, true]],
      ["reconcile-wrong-run", [request, randomUUID(), true]],
      ["reconcile-not-resuming", [request, key.workflowRunId, false]],
      ["reconcile-extra-argument", [request, key.workflowRunId, true, false]],
      ["reconcile-missing-argument", [request, key.workflowRunId]],
    ] satisfies [string, unknown[]][]) await checkFixture(name, events => setArguments(events, reconcileId, args));
    for (const [name, args] of [
      ["anchor-other-request", [{ ...request, requestId: randomUUID() }, { children: true }]],
      ["anchor-other-conversation", [{ ...request, conversationId: randomUUID() }, { children: true }]],
      ["anchor-initial-turn", [request]],
      ["anchor-not-child-resume", [request, { children: false }]],
      ["anchor-approval-resume", [request, { approval: randomUUID() }]],
      ["anchor-extra-argument", [request, { children: true }, true]],
    ] satisfies [string, unknown[]][]) await checkFixture(name, events => setArguments(events, executeId, args));
    for (const [name, values] of [
      ["result-wrong-text", [{ kind: "complete", text: delivered + " changed" }]],
      ["result-wrong-kind", [{ kind: "recover", text: delivered }]],
      ["result-extra-field", [{ kind: "complete", text: delivered, unrelated: true }]],
      ["result-empty", []],
      ["result-duplicate", [{ kind: "complete", text: delivered }, { kind: "complete", text: delivered }]],
    ] satisfies [string, unknown[]][]) await checkFixture(name, events => setResult(events, values));
    for (const [name, id] of [
      ["missing-anchor", executeId], ["missing-resume-terminal", failureId],
      ["missing-reconciliation", reconcileId], ["missing-reconcile-completion", resultId],
      ["missing-command-task-completion", commandTaskId], ["missing-consuming-task-completion", consumingTaskId],
    ]) await checkFixture(name, events => remove(events, id));
    for (const [name, id] of [
      ["duplicate-anchor", executeId], ["duplicate-resume-terminal", failureId],
      ["duplicate-reconciliation", reconcileId], ["duplicate-reconcile-completion", resultId],
      ["duplicate-command-task-completion", commandTaskId], ["duplicate-consuming-task-completion", consumingTaskId],
    ]) await checkFixture(name, events => events.push({ ...required(events, id) }));
    await checkFixture("broken-resume-terminal-schedule-reference", events => {
      const attributes = required(events, failureId).activityTaskFailedEventAttributes;
      assert.ok(attributes); attributes.scheduledEventId = required(events, resultId).eventId;
    });
    await checkFixture("broken-result-schedule-reference", events => {
      const attributes = required(events, resultId).activityTaskCompletedEventAttributes;
      assert.ok(attributes); attributes.scheduledEventId = required(events, executeId).eventId;
    });
    await checkFixture("missing-anchor-input", events => { scheduled(events, executeId).input = null; });
    await checkFixture("missing-reconciliation-input", events => { scheduled(events, reconcileId).input = null; });
    await checkFixture("missing-result-payloads", events => {
      const attributes = required(events, resultId).activityTaskCompletedEventAttributes;
      assert.ok(attributes); attributes.result = {};
    });
    await checkFixture("missing-anchor-event-id", events => { required(events, executeId).eventId = null; });
    await checkFixture("missing-reconciliation-event-id", events => { required(events, reconcileId).eventId = null; });
    await checkFixture("missing-reconciliation-command-reference", events => { scheduled(events, reconcileId).workflowTaskCompletedEventId = null; });
    await checkFixture("later-unrelated-command-task-despite-equal-reply", events => {
      const reconciliation = required(events, reconcileId), result = required(events, resultId);
      const resultAttributes = result.activityTaskCompletedEventAttributes;
      assert.ok(resultAttributes);
      const activityStartId = resultAttributes.startedEventId?.toString(); assert.ok(activityStartId);
      const activityStart = required(events, activityStartId);
      const task = required(events, consumingTaskId), taskAttributes = completedTask(events, consumingTaskId);
      const startId = taskAttributes.startedEventId?.toString(), scheduleId = taskAttributes.scheduledEventId?.toString();
      assert.ok(startId); assert.ok(scheduleId);
      const laterSchedule = protocol.api.history.v1.HistoryEvent.fromObject({ ...reconciliation, eventId: "900101",
        activityTaskScheduledEventAttributes: { ...scheduled(events, reconcileId), workflowTaskCompletedEventId: task.eventId },
      });
      const laterStart = protocol.api.history.v1.HistoryEvent.fromObject({ ...activityStart, eventId: "900102",
        activityTaskStartedEventAttributes: { ...activityStart.activityTaskStartedEventAttributes, scheduledEventId: laterSchedule.eventId },
      });
      const laterResult = protocol.api.history.v1.HistoryEvent.fromObject({ ...result, eventId: "900103",
        activityTaskCompletedEventAttributes: { ...resultAttributes, scheduledEventId: laterSchedule.eventId, startedEventId: laterStart.eventId },
      });
      const consumingSchedule = protocol.api.history.v1.HistoryEvent.fromObject({ ...required(events, scheduleId), eventId: "900104" });
      const consumingStart = protocol.api.history.v1.HistoryEvent.fromObject({ ...required(events, startId), eventId: "900105",
        workflowTaskStartedEventAttributes: { ...required(events, startId).workflowTaskStartedEventAttributes, scheduledEventId: consumingSchedule.eventId },
      });
      const consumingCompletion = protocol.api.history.v1.HistoryEvent.fromObject({ ...task, eventId: "900106",
        workflowTaskCompletedEventAttributes: { ...taskAttributes, scheduledEventId: consumingSchedule.eventId, startedEventId: consumingStart.eventId },
      });
      for (const id of [reconcileId, activityStartId, resultId]) remove(events, id);
      events.push(laterSchedule, laterStart, laterResult, consumingSchedule, consumingStart, consumingCompletion);
    });
    await checkFixture("resume-terminal-before-anchor", events => moveBefore(events, failureId, executeId));
    await checkFixture("reconcile-result-before-schedule", events => moveBefore(events, resultId, reconcileId));
    await checkFixture("nonterminal-cancellation-request", events => {
      const event = required(events, failureId);
      event.activityTaskFailedEventAttributes = null;
      event.eventType = protocol.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_CANCEL_REQUESTED;
      event.activityTaskCancelRequestedEventAttributes = { scheduledEventId: required(events, executeId).eventId };
    });
    await checkFixture("conflicting-resume-terminal", events => {
      const completion = required(events, resultId);
      assert.ok(completion.activityTaskCompletedEventAttributes);
      events.push({ ...completion, activityTaskCompletedEventAttributes: {
        ...completion.activityTaskCompletedEventAttributes, scheduledEventId: required(events, executeId).eventId,
      } });
    });
    for (const taskId of [commandTaskId, consumingTaskId]) {
      const boundaryId = taskId === commandTaskId ? failureId : resultId;
      const label = taskId === commandTaskId ? "command" : "consuming";
      await checkFixture(label + "-task-started-before-result-or-failure", events => {
        const startedId = completedTask(events, taskId).startedEventId?.toString();
        assert.ok(startedId); moveBefore(events, startedId, boundaryId);
      });
      await checkFixture(label + "-task-missing-start-reference", events => { completedTask(events, taskId).startedEventId = null; });
      await checkFixture(label + "-task-broken-start-reference", events => {
        completedTask(events, taskId).startedEventId = required(events, executeId).eventId;
      });
      await checkFixture(label + "-task-missing-start-event", events => {
        const startedId = completedTask(events, taskId).startedEventId?.toString();
        assert.ok(startedId); remove(events, startedId);
      });
      await checkFixture(label + "-task-duplicate-start-event", events => {
        const startedId = completedTask(events, taskId).startedEventId?.toString();
        assert.ok(startedId); events.push({ ...required(events, startedId) });
      });
      for (const outcome of ["failed", "timed-out"]) await checkFixture(label + "-task-" + outcome + "-retry-before-success", events => {
        const completed = completedTask(events, taskId);
        const startedId = completed.startedEventId?.toString();
        assert.ok(startedId);
        const started = required(events, startedId);
        const scheduledId = started.workflowTaskStartedEventAttributes?.scheduledEventId?.toString();
        assert.ok(scheduledId);
        const retrySchedule = protocol.api.history.v1.HistoryEvent.fromObject({
          ...required(events, scheduledId), eventId: "900001",
        });
        const retryStart = protocol.api.history.v1.HistoryEvent.fromObject({ ...started, eventId: "900002",
          workflowTaskStartedEventAttributes: { ...started.workflowTaskStartedEventAttributes, scheduledEventId: retrySchedule.eventId },
        });
        const attributes = { scheduledEventId: retrySchedule.eventId, startedEventId: retryStart.eventId };
        const retryTerminal = protocol.api.history.v1.HistoryEvent.fromObject({ eventId: "900003",
          eventType: outcome === "failed" ? protocol.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED
            : protocol.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_TIMED_OUT,
          ...(outcome === "failed" ? { workflowTaskFailedEventAttributes: attributes } : { workflowTaskTimedOutEventAttributes: attributes }),
        });
        const index = events.indexOf(required(events, scheduledId));
        events.splice(index, 0, retrySchedule, retryStart, retryTerminal);
      }, "observed");
    }
  } finally {
    handleMock.mock.restore(); historyMock.mock.restore();
    await evidence("reconciled-parent-cloned-history-adapter-checks", {
      source: "modified-deep-clones-of-captured-actual-history-public-adapter-only",
      actualTemporalExecutionClaim: false, checks: fixtureChecks,
    });
  }

  const packedSchema = z.strictObject({ fixturePayloadArray: z.array(z.unknown()) });
  const codecClient = new Client({ connection, dataConverter: { payloadCodecs: [{
    async encode(payloads) { return payloads; },
    async decode(payloads) {
      assert.ok(payloads[0]);
      const packed = packedSchema.parse(temporal.options.loadedDataConverter.payloadConverter.fromPayload<unknown>(payloads[0]));
      return packed.fixturePayloadArray.map(payload);
    },
  }] } });
  const codecHandle = codecClient.workflow.getHandle(workflowId, key.workflowRunId);
  const codecHistoryMock = context.mock.method(codecHandle, "fetchHistory", async () => fixture);
  const codecHandleMock = context.mock.method(codecClient.workflow, "getHandle", () => codecHandle);
  const codecObserver = new TemporalDelegationWorkflows(codecClient);
  const codecChecks = [];
  try {
    for (const [name, args, results, expected] of [
      ["encoded-one-to-decoded-two-and-three-arguments-and-encoded-two-to-decoded-one-result",
        [request, key.workflowRunId, true], [{ kind: "complete", text: delivered }], "observed"],
      ["codec-decoded-extra-reconcile-argument", [request, key.workflowRunId, true, false], [{ kind: "complete", text: delivered }], "unknown"],
      ["codec-decoded-extra-result", [request, key.workflowRunId, true], [{ kind: "complete", text: delivered }, { kind: "complete", text: delivered }], "unknown"],
    ] satisfies [string, unknown[], unknown[], "observed" | "unknown"][]) {
      fixture = cloneHistory(); assert.ok(fixture.events);
      setArguments(fixture.events, executeId, [{ fixturePayloadArray: [request, { children: true }] }]);
      setArguments(fixture.events, reconcileId, [{ fixturePayloadArray: args }]);
      setResult(fixture.events, [{ fixturePayloadArray: results }, "encoded-padding"]);
      const observation = await codecObserver.observeParentResult(key);
      codecChecks.push({ name, expected, observation });
      assert.deepEqual(observation, { kind: expected }, name);
    }
  } finally {
    codecHandleMock.mock.restore(); codecHistoryMock.mock.restore();
    await evidence("reconciled-parent-codec-array-adapter-checks", {
      source: "modified-cloned-history-with-isolated-client-custom-array-codec",
      actualTemporalExecutionClaim: false, checks: codecChecks,
    });
  }
  assert.deepEqual(protocol.api.history.v1.History.encode(history.raw).finish(), actualHistoryBytes,
    "Adapter fixtures preserve the captured actual Temporal history byte for byte");
}
