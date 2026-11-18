import { handoffAcknowledgement } from "../handoff.mts";
import { holdResumedReceipt, streamGate, waitForGate } from "../stream-gate.mts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAgentInput } from "@ag-ui/core";
import { ClaudeAgentAdapter, type SessionBinding, type SessionRecoveryConfig } from "@ag-ui/claude-agent-sdk";
import { InMemorySessionStore, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { defer, finalize } from "rxjs";

const model = "claude-sonnet-4-6";

const providerRequest = z.object({
  system: z.union([z.string(), z.array(z.object({ text: z.string() }))]).optional(),
  tools: z.array(z.object({ name: z.string() })).default([]),
  messages: z.array(z.object({
    role: z.enum(["assistant", "user"]),
    content: z.union([z.string(), z.array(z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional(), text: z.string().optional(), tool_use_id: z.string().optional(),
        content: z.unknown().optional(), is_error: z.boolean().optional() }))]),
  })),
});

type ObserveRequest = (request: {
  prompt?: string; tools: string[]; result?: { id?: string; error?: boolean; content: unknown };
}) => void;

type InspectSystem = (system: string, messages: string, continuation: boolean) => void;

async function respond(
  request: IncomingMessage, response: ServerResponse, onProviderFailure: () => void, observe?: ObserveRequest, inspect?: InspectSystem,
) {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/v1/messages/count_tokens") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
    return;
  }
  if (request.method !== "POST" || path !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }

  const { messages, tools, system } = providerRequest.parse(await json(request));
  const prompts = messages.filter((message) => message.role === "user").flatMap(({ content }) =>
    typeof content === "string" ? [content] : content.flatMap((part) => part.type === "text" && part.text ? [part.text] : []),
  );
  const prompt = prompts.at(-1);
  const content = messages.at(-1)?.content;
  const toolResult = Array.isArray(content) ? content.find((block) => block.type === "tool_result") : undefined;
  inspect?.(typeof system === "string" ? system : (system ?? []).map((part) => part.text).join("\n"),
    JSON.stringify(messages), !!toolResult);
  observe?.({ prompt, tools: tools.map((tool) => tool.name),
    ...(toolResult ? { result: { id: toolResult.tool_use_id, content: toolResult.content, error: toolResult.is_error } } : {}),
  });
  const remembered = prompts.findLast((text) => text.startsWith("remember "))?.slice(9);
  let tool: { id: string; name: string; input: { operation_id?: string; note?: string } } | undefined;
  let reply = "";
  let holdReceipt = false;
  if (toolResult) {
    const text = typeof toolResult.content === "string" ? toolResult.content :
      z.array(z.object({ text: z.string() })).nonempty().parse(toolResult.content)[0].text;
    const answer = text.split("\n")[0];
    if (["inspect", "test"].includes(answer)) {
      const origin = messages.flatMap(({ content }) => typeof content === "string" ? [] : content)
        .find((part) => part.type === "tool_use" && part.id === toolResult.tool_use_id);
      if (toolResult.is_error || origin?.name !== "mcp__ag_ui__choose_next_step") throw new Error("Wrong human answer binding");
      reply = "selected " + answer;
    } else {
      const outcome = JSON.parse(answer);
      if (outcome.nativeCallId !== toolResult.tool_use_id) throw new Error("Mismatched provider result");
      if (outcome.kind === "recorded") holdReceipt = holdResumedReceipt("record " + outcome.receipt.operationId);
      reply = outcome.kind === "recorded" ? "recorded " + outcome.receipt.receiptId : outcome.kind;
    }
  } else if (prompt === "next step" && tools.some((t) => t.name === "mcp__ag_ui__choose_next_step")) {
    tool = { id: "toolu_" + randomUUID(), name: "mcp__ag_ui__choose_next_step", input: {} };
  } else if (prompt?.startsWith("record ") && tools.some((t) => t.name === "mcp__ag_ui__record_work_item")) {
    tool = { id: "toolu_" + randomUUID(), name: "mcp__ag_ui__record_work_item", input: { operation_id: prompt.replace(/^record (?:stream )?/, ""), note: "private fixture note" } };
  } else if (streamGate(prompt)) reply = "first";
  else if (handoffAcknowledgement(prompt)) reply = handoffAcknowledgement(prompt)!;
  else if (prompt?.startsWith("remember ")) reply = `stored ${remembered}`;
  else if (prompt === "recall") reply = `recalled ${remembered ?? "none"}`;
  else if (prompt === "wait") reply = "waiting";
  else {
    if (prompt === "fail") onProviderFailure();
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
      type: "error", error: { type: "invalid_request_error", message: "Scripted provider failure" },
    }));
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: tool ?
    { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" } });
  const toolGate = tool && streamGate(prompt?.slice(7));
  if (tool && toolGate) {
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"note":"private fixture note",' } });
    await waitForGate(toolGate + ".value");
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"operation_id":' + JSON.stringify(tool.input.operation_id) } });
    await waitForGate(toolGate);
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '}' } });
  } else {
    send("content_block_delta", {
      index: 0, delta: tool ?
        { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: reply }
    });
  }
  if (prompt === "wait" || holdReceipt) return;
  const gate = streamGate(prompt);
  if (gate) {
    await waitForGate(gate);
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: " second" } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", {});
  response.end();
}

export async function startClaudeFixtureProvider(onProviderFailure = () => {}, observe?: ObserveRequest, inspect?: InspectSystem) {
  const server = createServer((req, res) => {
    respond(req, res, onProviderFailure, observe, inspect).catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a localhost TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function createFixture(onProviderFailure: () => void) {
  const cwd = await mkdtemp(join(tmpdir(), "birb-claude-"));
  const provider = await startClaudeFixtureProvider(onProviderFailure);
  const exits: Promise<void>[] = [];
  const options: Options = {
    spawnClaudeCodeProcess({ command, args, env, signal }) {
      const cli = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "ignore"] });
      exits.push(new Promise((resolve) => cli.once("close", () => resolve())));
      return cli;
    },
    cwd,
    model,
    tools: [],
    settingSources: [],
    sessionStore: new InMemorySessionStore(),
    sessionStoreFlush: "eager",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      CLAUDE_CONFIG_DIR: join(cwd, "config"),
      ANTHROPIC_API_KEY: "synthetic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: provider.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    },
  };
  const bindings = new Map<string, SessionBinding>();
  const sessionRecovery: SessionRecoveryConfig = {
    profile: "fixture",
    resolveProfile: async () => options,
    store: {
      load: async (threadId) => bindings.get(threadId),
      save: async (threadId, binding) => { bindings.set(threadId, binding); },
    },
  };

  return {
    run(input: RunAgentInput, signal: AbortSignal) {
      return defer(() => {
        const abortController = new AbortController();
        const cancel = () => abortController.abort();
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const adapter = new ClaudeAgentAdapter({ abortController, sessionRecovery });
        return adapter.run(input).pipe(finalize(() => signal.removeEventListener("abort", cancel)));
      });
    },
    async close() {
      await Promise.all(exits);
      await provider.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
