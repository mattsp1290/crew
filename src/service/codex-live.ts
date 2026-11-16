import { Client, Connection } from "@temporalio/client";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import type { DriverInput, DriverResult } from "./activities.ts";
import { confirmDelivery, interruptLive, proposeLive, settleLive } from "./codex-calls.ts";
import { serveNativeTool } from "./codex-mcp.ts";
import type { DeferredTool, ToolOutcome } from "./deferral.ts";
import type { Launch } from "./supervisor.ts";
import type { Conversation } from "./domain.ts";
import { temporalConnectionOptions, type TemporalSettings } from "./temporal-config.ts";

// The MCP envelope already attributes the response to the native call.
function resultText(outcome: ToolOutcome) {
  if (outcome.kind === "answered") return outcome.choice;
  return JSON.stringify(outcome.kind === "recorded" ? {kind:outcome.kind,receipt:outcome.receipt} : {kind:outcome.kind});
}

export async function runLiveTool(
  pool: Pool, temporal: TemporalSettings, launch: Launch, member: Conversation, tool: DeferredTool, input: DriverInput,
  run: (input:DriverInput) => Promise<DriverResult>, discloseCallId: (id: string) => Promise<void>,
) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal,stopped.signal]);
  const nativeThread = Promise.withResolvers<string>();
  const workflowId = "birbcrew-ts/member/" + member.memberId + "/conversation/" + member.conversationId;
  let delivery: {approvalId:string; text:string} | undefined;
  let active = false;
  const server = await serveNativeTool(tool, launch.requestId, signal, async call => {
    if (active || delivery) throw new Error("This invocation already has a tool call");
    active = true;
    try {
      const threadId = await Promise.race([nativeThread.promise,delay(5000,undefined,{signal:call.signal})]);
      if (threadId !== call.threadId) throw new Error("Unexpected native thread");
      await discloseCallId(call.nativeCallId);
      const deadline = Date.now() + 120_000;
      const approval = await proposeLive(pool,launch,{...call,args:call.args,expiresAt:new Date(deadline).toISOString()});
      try {
        const connection = Connection.lazy(await temporalConnectionOptions(temporal));
        try {
          const client = new Client({connection, namespace:temporal.namespace});
          await connection.withDeadline(Date.now()+2000, () =>
            client.workflow.getHandle(workflowId,launch.execution.workflowRunId).signal("liveProposal", {
              requestId:launch.requestId, approvalId:approval.approvalId, invocationId:approval.invocationId
            }));
        } finally { await connection.close(); }
      } catch { /* The workflow can also resolve the durable proposal on demand. */ }
      while (Date.now() < deadline) {
        call.signal.throwIfAborted();
        const result = await settleLive(pool,launch,approval.approvalId);
        if (result.kind === "interrupted") break;
        if (result.kind !== "pending" && "nativeCallId" in result) {
          const text = resultText(result);
          delivery = {approvalId:approval.approvalId,text};
          return {text,isError:result.kind !== "recorded" && result.kind !== "answered"};
        }
        await delay(75,undefined,{signal:call.signal});
      }
      throw new Error("Native tool decision expired or interrupted");
    } catch {
      await interruptLive(pool,launch);
      stopped.abort();
      throw new Error("Native tool call interrupted");
    } finally { active = false; }
  });
  try {
    return await run({...input, signal, mcp:server.endpoint, onThreadStarted(id) {nativeThread.resolve(id);},
      async onToolDelivered(text) {
        if (!delivery || delivery.text !== text) throw new Error("Native SDK result differs from the returned tool result");
        await confirmDelivery(pool,launch,delivery.approvalId);
      }});
  } finally {
    stopped.abort();
    await server.close();
    await interruptLive(pool,launch);
  }
}
