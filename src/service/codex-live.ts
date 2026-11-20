import { Client, Connection } from "@temporalio/client";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import type { DriverInput, DriverResult } from "./activities.ts";
import { confirmDelivery, interruptLive, proposeLive, settleLive } from "./codex-calls.ts";
import { codexToolContinuation, type CodexHold, type CodexToolCall } from "./codex.ts";
import type { DeferredTool, ToolOutcome } from "./deferral.ts";
import type { Launch } from "./supervisor.ts";
import type { Conversation } from "./domain.ts";
import { temporalConnectionOptions, type TemporalSettings } from "./temporal-config.ts";

function resultText(outcome: ToolOutcome) {
  if (outcome.kind === "answered") return outcome.choice;
  return JSON.stringify(outcome.kind === "recorded" ? { kind: outcome.kind, receipt: outcome.receipt } : { kind: outcome.kind });
}

/** One profile tool, answered through the live ledger. The driver declines `request_user_input` itself. */
export async function runLiveTool(
  pool: Pool, temporal: TemporalSettings, launch: Launch, member: Conversation, tool: DeferredTool, input: DriverInput,
  run: (input: DriverInput) => Promise<DriverResult>, discloseCallId: (id: string) => Promise<void>,
) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal, stopped.signal]);
  const nativeThread = Promise.withResolvers<string>();
  const workflowId = "birbcrew-ts/member/" + member.memberId + "/conversation/" + member.conversationId;
  let delivery: { approvalId: string; text: string } | undefined;
  let active = false;
  const hold: CodexHold = {
    tool,
    answer: (call, turn) => answer(pool, temporal, launch, workflowId, tool, signal, turn, nativeThread.promise, discloseCallId, call, () => active, (value) => { active = value; }, (value) => { delivery = value; }, () => stopped.abort()),
  };
  try {
    return await run({
      ...input, signal, hold,
      onThreadStarted(id) { nativeThread.resolve(id); },
      async onToolDelivered(text) {
        if (!delivery || delivery.text !== text) throw new Error("Native SDK result differs from the returned tool result");
        await confirmDelivery(pool, launch, delivery.approvalId);
      },
    });
  } finally {
    stopped.abort();
    await interruptLive(pool, launch);
  }
}

async function answer(
  pool: Pool, temporal: TemporalSettings, launch: Launch, workflowId: string, tool: DeferredTool,
  signal: AbortSignal, turn: AbortSignal, nativeThread: Promise<string>, discloseCallId: (id: string) => Promise<void>,
  call: CodexToolCall, isActive: () => boolean, setActive: (value: boolean) => void,
  setDelivery: (value: { approvalId: string; text: string }) => void, stop: () => void,
) {
  if (isActive()) throw new Error("This invocation already has a tool call");
  setActive(true);
  const callSignal = AbortSignal.any([signal, turn]);
  try {
    const threadId = await Promise.race([nativeThread, delay(5000, undefined, { signal: callSignal })]);
    if (threadId !== call.pending.target.session.opaque) throw new Error("Unexpected native thread");
    if (call.name !== tool) throw new Error("Unexpected native Codex tool");
    await discloseCallId(call.pending.target.nativeToolCallId);
    const deadline = Date.now() + 120_000;
    const approval = await proposeLive(pool, launch, {
      threadId, nativeCallId: call.pending.target.nativeToolCallId, toolName: tool, args: call.arguments,
      expiresAt: new Date(deadline).toISOString(),
    });
    try {
      const connection = Connection.lazy(await temporalConnectionOptions(temporal));
      try {
        const client = new Client({ connection, namespace: temporal.namespace });
        await connection.withDeadline(Date.now() + 2000, () =>
          client.workflow.getHandle(workflowId, launch.execution.workflowRunId).signal("liveProposal", {
            requestId: launch.requestId, approvalId: approval.approvalId, invocationId: approval.invocationId,
          }));
      } finally { await connection.close(); }
    } catch { /* The workflow can also resolve the durable proposal on demand. */ }
    while (Date.now() < deadline) {
      callSignal.throwIfAborted();
      const result = await settleLive(pool, launch, approval.approvalId);
      if (result.kind === "interrupted") break;
      if (result.kind !== "pending" && "nativeCallId" in result) {
        const text = resultText(result);
        setDelivery({ approvalId: approval.approvalId, text });
        return codexToolContinuation(call.pending.target, text, result.kind !== "recorded" && result.kind !== "answered");
      }
      await delay(75, undefined, { signal: callSignal });
    }
    throw new Error("Native tool decision expired or interrupted");
  } catch {
    await interruptLive(pool, launch);
    stop();
    throw new Error("Native tool call interrupted");
  } finally { setActive(false); }
}
