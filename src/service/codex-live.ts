import { Client, Connection } from "@temporalio/client";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import type { DriverInput, DriverResult } from "./activities.ts";
import { confirmDelivery, interruptLive, proposeLive, settleLive } from "./codex-calls.ts";
import { codexToolContinuation, type CodexHold, type CodexToolCall } from "./codex.ts";
import type { DeferredTool, ToolOutcome } from "./deferral.ts";
import type { Launch } from "./supervisor.ts";
import { MemberStoreError, type Conversation } from "./domain.ts";
import { temporalConnectionOptions, type TemporalSettings } from "./temporal-config.ts";

function resultText(outcome: ToolOutcome) {
  if (outcome.kind === "answered") return outcome.choice;
  return JSON.stringify(outcome.kind === "recorded" ? { kind: outcome.kind, receipt: outcome.receipt } : { kind: outcome.kind });
}

/** One profile tool, answered through the live ledger. The driver declines `request_user_input` itself. */
export async function runLiveTool(
  pool: Pool, temporal: TemporalSettings, launch: Launch, member: Conversation, tool: DeferredTool, input: DriverInput,
  run: (input: DriverInput) => Promise<DriverResult>, discloseCallId: (...ids: string[]) => Promise<void>,
) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal, stopped.signal]);
  const nativeThread = Promise.withResolvers<string>();
  const workflowId = "birbcrew-ts/member/" + member.memberId + "/conversation/" + member.conversationId;
  const deliveries = new Map<string, { approvalId: string; text: string }>();
  let active = false, consumed = false;
  const hold: CodexHold = {
    tool,
    answer: (call, turn) => answer(pool, temporal, launch, workflowId, tool, signal, turn, nativeThread.promise, discloseCallId, call, () => active || consumed, (value) => { active = value; if (value) consumed = true; }, deliveries, () => stopped.abort()),
    async delivered(nativeCallId, text) {
      const pending = deliveries.get(nativeCallId);
      if (!pending || pending.text !== text) throw new Error("Native SDK result differs from the returned tool result");
      await confirmDelivery(pool, launch, pending.approvalId);
      deliveries.delete(nativeCallId);
    },
  };
  try {
    return await run({
      ...input, signal, hold,
      onThreadStarted(id) { nativeThread.resolve(id); },
    });
  } finally {
    stopped.abort();
    await interruptLive(pool, launch);
  }
}

async function answer(
  pool: Pool, temporal: TemporalSettings, launch: Launch, workflowId: string, tool: DeferredTool,
  signal: AbortSignal, turn: AbortSignal, nativeThread: Promise<string>, discloseCallId: (...ids: string[]) => Promise<void>,
  call: CodexToolCall, isActive: () => boolean, setActive: (value: boolean) => void,
  deliveries: Map<string, { approvalId: string; text: string }>, stop: () => void,
) {
  if (isActive()) throw new Error("This invocation already has a tool call");
  setActive(true);
  const callSignal = AbortSignal.any([signal, turn]);
  try {
    const threadId = await Promise.race([nativeThread, delay(5000, undefined, { signal: callSignal })]);
    if (threadId !== call.pending.target.session.opaque) throw new Error("Unexpected native thread");
    if (call.name !== tool) throw new Error("Unexpected native Codex tool");
    const nativeId = call.pending.target.nativeToolCallId;
    const visible = modelVisibleCallId(nativeId);
    // One flush, after every id the model can write is known. The ledger cannot redact an item it already published.
    await discloseCallId(nativeId, ...(visible && visible !== nativeId ? [visible] : []));
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
        deliveries.set(call.pending.target.nativeToolCallId, { approvalId: approval.approvalId, text });
        return codexToolContinuation(call.pending.target, text, result.kind !== "recorded" && result.kind !== "answered");
      }
      await delay(75, undefined, { signal: callSignal });
    }
    throw new Error("Native tool decision expired or interrupted");
  } catch (error) {
    if ((error instanceof MemberStoreError && error.code === "conflict") || error instanceof z.ZodError) {
      stop();
      throw new Error("Native tool proposal was rejected", { cause: error });
    }
    await interruptLive(pool, launch);
    stop();
    throw new Error("Native tool call interrupted", { cause: error });
  } finally { setActive(false); }
}

/** The adapter's ledger id is a JSON list whose third entry is the id the model can write back. */
function modelVisibleCallId(id: string) {
  try {
    const parts = JSON.parse(id);
    return Array.isArray(parts) && typeof parts[2] === "string" && parts[2] !== "" ? parts[2] : undefined;
  } catch { return undefined; }
}
