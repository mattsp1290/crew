import { assertNativeJsonBudget, assertTranscriptFileBudget, nativeTranscriptBytes } from "./native-limits.ts";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai";
import { toolPreviewReporter } from "./tool-preview.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { RunAgentInput } from "@ag-ui/core";
import { nativeProposal, nativeResult } from "./deferral.ts";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { ClaudeAgentAdapter, type SessionBinding } from "@ag-ui/claude-agent-sdk";
import { getSessionMessages, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeCheckpoint, claudeCommand } from "./claude.ts";
import { claudeUsage } from "./usage-capture.ts";

const recordTools: RunAgentInput["tools"] = [{
  name: "record_work_item", description: "Record one work item after the owner approves.",
  parameters: {
    type: "object", properties: { operation_id: { type: "string" }, note: { type: "string" } },
    required: ["operation_id"], additionalProperties: false,
  },
}];
const nextStepTools: RunAgentInput["tools"] = [{
  name: "choose_next_step", description: "Ask the owner whether to inspect or test next.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
}];
type Command = z.infer<typeof claudeCommand>;
type Binding = z.infer<typeof claudeCheckpoint>["state"]["binding"];
const storedBinding = z.strictObject({
  version: z.literal(1), threadId: z.uuid(), runId: z.uuid(), model: z.string(), promptDigest: z.string(),
  priorTranscriptDigest: z.string().nullable(), binding: claudeCheckpoint.shape.state.shape.binding,
});

const cwd = process.cwd();
const controller = new AbortController();
class ClaudeTurnError extends Error {}

async function digest(sessionId: string, pending?: SessionBinding["pending"]) {
  await assertTranscriptFileBudget(cwd, sessionId);
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  assertNativeJsonBudget(messages, nativeTranscriptBytes, "Claude transcript");
  if (messages.at(-1)?.type !== "assistant") throw new ClaudeTurnError("Claude recovery failed: original transcript is missing or incomplete");
  if (pending) {
    const blocks = z.object({ content: z.array(z.object({
      type: z.string(), id: z.string().optional(), name: z.string().optional(),
      input: z.unknown().optional(), tool_use_id: z.string().optional(),
    })) });
    const latest = blocks.parse(messages.at(-1)?.message).content.filter((block) => block.type === "tool_use");
    if (latest.length !== 1 || latest[0].id !== pending.id || latest[0].name !== pending.name ||
        !isDeepStrictEqual(latest[0].input, pending.input)) throw new ClaudeTurnError("Claude pending transcript mismatch");
    const history = messages.flatMap((message) => blocks.safeParse(message.message).data?.content ?? []);
    if (history.some((b) => b.type === "tool_result" && b.tool_use_id === pending.id) ||
        history.filter((b) => b.type === "tool_use" && b.id === pending.id).length !== 1) {
      throw new ClaudeTurnError("Claude pending call is consumed or ambiguous");
    }
  }
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function provenance(command: Command) {
  return { version: 1, threadId: command.threadId, runId: command.runId, model: command.model,
    priorTranscriptDigest: command.checkpoint?.state.transcriptDigest ?? null,
    promptDigest: createHash("sha256").update(command.text).digest("hex") };
}

async function checkpointFor(command: Command, binding: Binding) {
  return claudeCheckpoint.parse({
    version: 1, engine: "claude",
    state: { threadId: command.threadId, model: command.model, binding, transcriptDigest: await digest(binding.sessionId, binding.pending) },
  });
}

async function confirmedProposal(command: Command, binding: Binding) {
  const call = binding.pending;
  const tools = command.tool === "choose_next_step" ? nextStepTools : recordTools;
  if (binding.unsupportedPendingTools?.length || !call || call.name !== "mcp__ag_ui__" + command.tool ||
      !isDeepStrictEqual(binding.frontendTools, tools)) throw new ClaudeTurnError("Claude deferral was not confirmed");
  const proposal = nativeProposal.parse({ nativeCallId: call.id, name: command.tool, arguments: call.input });
  if (proposal.name === "record_work_item" && proposal.arguments.operation_id !== command.runId) throw new ClaudeTurnError("Claude tool operation mismatch");
  return { kind: "pending", proposal,
    checkpoint: await checkpointFor(command, binding) };
}

async function run(command: Command) {
  const profile = command.mode === "chat" ? "claude-chat-v1" : command.tool === "choose_next_step" ? "claude-next-step-v1" : "claude-record-v1";
  let binding: Binding | undefined = command.checkpoint?.state.binding;
  if (command.mode === "recover") {
    const { binding: confirmed, ...intent } = storedBinding.parse(JSON.parse(await readFile("binding.json", "utf8")));
    if (!isDeepStrictEqual(intent, provenance(command)) || confirmed.profile !== profile ||
        (binding && confirmed.sessionId !== binding.sessionId)) throw new ClaudeTurnError("Claude pending intent mismatch");
    return confirmedProposal(command, confirmed);
  }
  if (binding) {
    const raw = JSON.parse(await readFile("binding.json", "utf8"));
    const saved = storedBinding.safeParse(raw);
    // Completed chat checkpoints from the initial driver saved the binding directly.
    if (!isDeepStrictEqual(saved.success ? saved.data.binding : raw, binding) ||
        binding.profile !== profile || await digest(binding.sessionId, binding.pending) !== command.checkpoint?.state.transcriptDigest) {
      throw new ClaudeTurnError("Claude recovery failed: original transcript does not match its checkpoint");
    }
  }
  let exited: Promise<void> | undefined;
  const options: Options = {
    cwd,
    spawnClaudeCodeProcess({ command, args, env, signal }) {
      const launcher = fileURLToPath(new URL("../../.proof/bin/member-launch", import.meta.url));
      const cli = spawn(launcher, [String(process.pid), command, ...args], {
        cwd, env, signal, stdio: ["pipe", "pipe", "ignore"],
      });
      exited = new Promise<void>((resolve) => cli.once("close", () => resolve()));
      return cli;
    },
    model: command.model,
    ...(command.projectContext && { systemPrompt: "You are a BirbCrew coworker.\n" + command.projectContext }),
    env: process.env,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    settingSources: [],
    permissionMode: "dontAsk",
    maxTurns: command.mode === "protected" ? 3 : 1,
  };
  const adapter = new ClaudeAgentAdapter({
    abortController: controller,
    sessionRecovery: {
      profile,
      resolveProfile: async () => options,
      store: {
        load: async () => binding,
        async save(_, value) {
          const confirmed = claudeCheckpoint.shape.state.shape.binding.parse(value);
          if (confirmed.profile !== profile || (binding && binding.sessionId !== confirmed.sessionId)) {
            throw new ClaudeTurnError("Claude session identity changed");
          }
          await writeFile("binding.tmp", JSON.stringify({ ...provenance(command), binding: confirmed }), { mode: 0o600, flush: true });
          await rename("binding.tmp", "binding.json");
          binding = confirmed;
        },
      },
    },
  });
  let text = "";
  let finished = false;
  let pendingIds: string[] | undefined;
  let resultCount = 0;
  let initModel: unknown, queryResult: unknown;
  let streamingCall: { id: string; bytes: number; args: ToolCallArgumentsStream } | undefined;
  const reportPreview = toolPreviewReporter(command.runId, (toolArgs, matchedOperation) => process.send?.({ toolArgs, matchedOperation }));
  const textEvent = z.object({ delta: z.string() });
  const terminal = z.object({ outcome: z.object({
    type: z.literal("success"),
    pendingToolCallIds: z.array(z.string()).max(1).optional(),
  }).optional(), result: z.unknown() });
  await adapter.run({
    threadId: command.threadId, runId: command.runId,
    messages: command.continuation ? [{
      role: "tool", id: command.runId + ":result", toolCallId: command.continuation.nativeCallId,
      content: nativeResult(command.continuation.result),
      ...(["recorded", "answered"].includes(command.continuation.result.kind) ? {} : { error: command.continuation.result.kind }),
    }] : [{ role: "user", id: command.runId, content: command.text }],
    tools: command.tool === "choose_next_step" ? nextStepTools : command.tool === "record_work_item" ? recordTools : [], state: null, forwardedProps: {},
    context: command.tool === "record_work_item" ? [{ description: "Work item operation_id for this input", value: command.runId }] : [],
  }).forEach((event) => {
    if (finished) throw new Error("Unexpected event after Claude terminal");
    if (event.type === "RUN_ERROR") throw new ClaudeTurnError("Claude SDK run failed");
    if (event.type === "TEXT_MESSAGE_CONTENT") {
      const { delta } = textEvent.parse(event);
      text += delta;
      if (Buffer.byteLength(text) > 65_536) throw new ClaudeTurnError("Claude response exceeded size limit");
      process.send?.({ delta });
    }
    if (event.type === "TOOL_CALL_START") {
      const { toolCallName, toolCallId } = z.object({ toolCallName: z.string(), toolCallId: z.string() }).parse(event);
      if (command.mode !== "protected" || toolCallName !== command.tool) throw new ClaudeTurnError("Undeclared Claude tool");
      if (!command.continuation && command.tool === "record_work_item") streamingCall = { id: toolCallId, bytes: 0, args: new ToolCallArgumentsStream() };
    }
    if (event.type === "TOOL_CALL_ARGS" && streamingCall) {
      const { toolCallId, delta } = z.object({ toolCallId: z.string(), delta: z.string() }).parse(event);
      if (toolCallId !== streamingCall.id) throw new ClaudeTurnError("Mismatched partial call");
      streamingCall.bytes += Buffer.byteLength(delta);
      if (streamingCall.bytes > 65536) throw new ClaudeTurnError("Tool arguments exceeded size limit");
      if (delta) reportPreview(toolCallId, streamingCall.args.append(delta).operation_id);
    }
    if (event.type === "TOOL_CALL_RESULT") {
      if (!command.continuation || z.object({ toolCallId: z.string() }).parse(event).toolCallId !== command.continuation.nativeCallId)
        throw new ClaudeTurnError("Unexpected Claude tool result");
      resultCount++;
    }
    if (event.type === "CUSTOM") {
      const init = z.object({ name: z.literal("system:init"), value: z.object({ model: z.unknown() }) }).safeParse(event);
      if (init.success) initModel = init.data.value.model;
    }
    if (event.type === "RUN_FINISHED") {
      const done = terminal.parse(event);
      pendingIds = done.outcome?.pendingToolCallIds;
      queryResult = done.result;
      finished = true;
    }
  });
  const usage = claudeUsage(queryResult, initModel);
  await exited;
  if (!finished || !binding || binding.unsupportedPendingTools?.length || resultCount !== Number(!!command.continuation)) throw new ClaudeTurnError("Claude turn did not settle");
  if (binding.pending) {
    if (command.mode !== "protected" || !isDeepStrictEqual(pendingIds, [binding.pending.id])) {
      throw new ClaudeTurnError("Claude deferral was not confirmed");
    }
    return { ...await confirmedProposal(command, binding), usage };
  }
  if (pendingIds?.length || !text.length) throw new ClaudeTurnError("Claude turn did not complete");
  return { kind: "complete", text, checkpoint: await checkpointFor(command, binding), usage };
}

// The adapter owns a detached process group. Losing the host revokes that entire turn.
const invocationGroup = Number(process.env.BIRBCREW_INVOCATION_GROUP ?? process.pid);
delete process.env.BIRBCREW_INVOCATION_GROUP;
const hostLost = () => process.kill(-invocationGroup, "SIGKILL");
process.once("disconnect", hostLost);
process.once("message", async (payload) => {
  let reply;
  try {
    reply = await run(claudeCommand.parse(payload));
  } catch (error) {
    controller.abort();
    reply = { error: error instanceof ClaudeTurnError ? error.message : "Claude turn or native session recovery failed" };
  }
  if (process.connected) process.send?.(reply, () => {
    process.removeListener("disconnect", hostLost);
    process.disconnect();
  });
});
