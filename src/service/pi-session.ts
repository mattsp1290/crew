import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator, toAguiMessages, type HistoryEntry } from "@ag-ui/pi";
import { createDelegationBatch, delegationToolName, delegationToolResults } from "@birbcrew/pi-subagents";
import { contentText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { DriverResult } from "./activities.ts";
import { nativeProposal } from "./deferral.ts";
import { conversationTurnLimit } from "./limits.ts";
import { nativeCheckpointBytes, assertNativeJsonBudget } from "./native-limits.ts";
import type { MemberInput } from "./pi-channel.ts";
import {
  completedTurn, defaultInstructions, memberSessionPrefix, onlyCall, pendingTurn, privateCheckpoint, replyBytes, segmentTool,
  stateSchema, type PiMode, type PiState, type SessionProfile,
} from "./pi-state.ts";
import { continueSession, proposalTool, toolResult } from "./pi-tools.ts";
import { piUsage } from "./usage-capture.ts";

/**
 * Runs one Pi member segment with the SDK. Only the confined worker (pi-worker.ts) imports this module; host
 * callers use the segment functions in pi.ts, which check this result. Text, argument previews and the
 * profile's provider hooks are handled by the host, from the requests and events it relays.
 */
export async function runSegment(input: MemberInput & { signal: AbortSignal }, profile: SessionProfile, mode: PiMode) {
  input.signal.throwIfAborted();
  const prior = input.checkpoint;
  if (prior !== null) assertNativeJsonBudget(prior, nativeCheckpointBytes, "Pi checkpoint");
  if (prior !== null && (prior.engine !== "pi" || prior.version !== 1)) throw new Error("Invalid Pi checkpoint");
  const state: PiState = prior === null
    ? { threadId: input.threadId, sessionId: randomUUID(), turns: [] }
    : stateSchema.parse(prior.state);
  if (state.threadId !== input.threadId || state.turns.some((turn) => turn.runId === input.runId)) {
    throw new Error("Pi checkpoint does not match this turn");
  }
  if (state.turns.length >= conversationTurnLimit) throw new Error("Pi conversation input limit reached");
  const pending = state.pending;
  const toolName = segmentTool(mode, profile.allowRecordWorkItem);
  const hasContinuation = input.continuation !== undefined || input.childResults !== undefined;
  if (Boolean(pending) !== hasContinuation || (input.childResults && input.continuation) ||
      (pending && (pending.runId !== input.runId || contentText(pending.user.content) !== input.text))) {
    throw new Error("Pi continuation does not match the pending turn");
  }
  const results = [];
  if (pending && input.continuation && toolName) {
    const call = onlyCall(pending);
    if (call.name !== toolName) throw new Error("Pending Pi call differs from the member profile");
    results.push(toolResult(call, input.continuation));
  }
  if (pending && input.childResults && mode === "delegating") {
    const calls = pending.proposal.content.filter((part) => part.type === "toolCall");
    if (calls.some((call) => call.name !== delegationToolName)) throw new Error("Expected pending Pi delegations");
    results.push(...delegationToolResults(calls.map((call) => ({ nativeCallId: call.id })), input.childResults, pending.proposal.timestamp));
  }
  if (pending && results.length === 0) throw new Error("Missing authorized Pi continuation");
  const tool = toolName ? proposalTool(input.runId, toolName) : undefined;
  const batch = mode === "delegating" ? createDelegationBatch({ model: profile.model.id, allowRecordWorkItem: toolName === "record_work_item" }) : undefined;
  const factories = batch ? [batch.extension] : [];
  const cwd = await mkdtemp(join(tmpdir(), memberSessionPrefix));
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noContextFiles: true, noThemes: true, systemPrompt: profile.instructions ?? defaultInstructions,
      appendSystemPrompt: input.projectContext ? [input.projectContext] : [], extensionFactories: factories,
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    const expectedPaths = factories.map((_, index) => `<inline:${index + 1}>`);
    if (extensions.errors.length || extensions.extensions.length !== expectedPaths.length ||
        extensions.extensions.some((extension, i) => extension.path !== expectedPaths[i])) {
      throw new Error("Unexpected Pi extensions");
    }
    const sessionManager = SessionManager.inMemory(cwd, { id: state.sessionId });
    const history: HistoryEntry[] = [];
    function append(id: string, message: Parameters<SessionManager["appendMessage"]>[0]) {
      sessionManager.appendMessage(message);
      history.push({ id, message });
    }
    for (const turn of [...state.turns, ...(pending ? [pending] : [])]) {
      for (const change of turn.system) sessionManager.appendMessage(change);
      append(turn.runId + ":user", turn.user);
      const toolHistory = "proposal" in turn
        ? { proposal: turn.proposal, results, system: [] }
        : turn.tool;
      if (toolHistory) {
        const calls = toolHistory.proposal.content.filter((part) => part.type === "toolCall");
        if (calls.some((call) => call.name !== delegationToolName)) onlyCall({ ...turn, proposal: toolHistory.proposal });
        const replies = "result" in toolHistory ? [toolHistory.result] : toolHistory.results;
        if (calls.length !== replies.length || new Set(calls.map((c) => c.id)).size !== calls.length ||
            calls.some((call, i) => call.id !== replies[i].toolCallId || call.name !== replies[i].toolName)) {
          throw new Error("Invalid Pi tool history");
        }
        append(turn.runId + ":assistant", toolHistory.proposal);
        for (const reply of replies) append(turn.runId + ":result:" + reply.toolCallId, reply);
        for (const change of toolHistory.system) sessionManager.appendMessage(change);
      }
      if ("assistant" in turn) append(turn.runId + (toolHistory ? ":resumed" : ":assistant"), turn.assistant);
    }
    const tools = [...(tool ? [tool.definition.name] : []), ...(batch ? [delegationToolName] : [])];
    const { session } = await createAgentSession({
      model: profile.model, modelRuntime: profile.modelRuntime, cwd, agentDir: cwd, resourceLoader, settingsManager, sessionManager,
      tools, customTools: tool ? [tool.definition] : [], thinkingLevel: "off",
    });
    const assistantId = input.runId + (pending ? ":resumed" : ":assistant");
    const translator = createTranslator({
      threadId: input.threadId, runId: input.runId, completion: "caller",
      messageId: () => assistantId, getMessages: () => toAguiMessages(history),
    });
    const abort = () => { void session.abort(); };
    let text = "";
    let bytes = 0;
    translator.start();
    const committedCallIds: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") return;
      for (const frame of translator.translate(event)) {
        if (frame.type === "TOOL_CALL_END") committedCallIds.push(frame.toolCallId);
        if (frame.type !== "TEXT_MESSAGE_CONTENT") continue;
        bytes += Buffer.byteLength(frame.delta);
        if (bytes > replyBytes) abort();
        else text += frame.delta;
      }
    });
    try {
      if (JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...tools].sort())) throw new Error("Unexpected Pi tools");
      session.agent.finishTurn = () => ({ action: "end" });
      const before = sessionManager.getEntries().length;
      input.signal.addEventListener("abort", abort, { once: true });
      input.signal.throwIfAborted();
      if (pending) await continueSession(session);
      else await session.prompt(input.text, { expandPromptTemplates: false });
      await session.waitForIdle();
      input.signal.throwIfAborted();

      const messages = sessionManager.getEntries().slice(before)
        .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      const usage = piUsage(messages.filter((message) => message.role === "assistant"));
      const last = messages.at(-1);
      if (last?.role === "toolResult") {
        if (pending || bytes > replyBytes) throw new Error("Unexpected repeated Pi tool proposal");
        const at = messages.findIndex((message) => message.role === "assistant");
        const proposal = pendingTurn.parse({
          runId: input.runId, system: messages.slice(0, at - 1), user: messages[at - 1], proposal: messages[at],
        });
        const calls = proposal.proposal.content.filter((part) => part.type === "toolCall");
        if (calls.length !== committedCallIds.length || calls.some((call, i) => call.id !== committedCallIds[i])) {
          throw new Error("Pi did not confirm its native calls");
        }
        history.push({ id: input.runId + ":user", message: proposal.user }, { id: assistantId, message: proposal.proposal });
        translator.finish();
        const receipts = messages.slice(at + 1);
        if (batch && calls.every((call) => call.name === delegationToolName)) {
          const proposals = batch.confirm(calls, receipts);
          return { kind: "delegated" as const, proposals, checkpoint: privateCheckpoint({ ...state, pending: proposal }), usage };
        }
        const call = onlyCall(proposal);
        if (!tool || call.name !== toolName || receipts.length !== 1 || call.id !== last.toolCallId || !tool.accepted.has(call.id) || last.isError) {
          throw new Error("Pi did not confirm a permitted tool proposal");
        }
        return { kind: "pending" as const, proposal: nativeProposal.parse({ name: call.name, nativeCallId: call.id, arguments: call.arguments }),
          checkpoint: privateCheckpoint({ ...state, pending: proposal }), usage } satisfies DriverResult;
      }
      if (last?.role !== "assistant" || last.stopReason !== "stop" || committedCallIds.length) {
        throw new Error("Pi did not complete the text turn");
      }
      const turn = completedTurn.parse(pending ? {
        runId: input.runId, system: pending.system, user: pending.user, assistant: last,
        tool: { proposal: pending.proposal, ...(input.continuation ? { result: results[0] } : { results }),
          system: messages.slice(0, -1).filter((m) => m.role === "system") },
      } : {
        runId: input.runId, system: messages.slice(0, -2), user: messages.at(-2), assistant: last,
      });
      if (!pending) history.push({ id: input.runId + ":user", message: turn.user });
      history.push({ id: assistantId, message: turn.assistant });
      const snapshot = translator.finish().find((frame) => frame.type === "MESSAGES_SNAPSHOT");
      const reply = snapshot?.messages.at(-1);
      if (!text || bytes > replyBytes || reply?.id !== assistantId || reply.content !== text) {
        throw new Error("Pi stream did not match its committed reply");
      }
      const next = { threadId: state.threadId, sessionId: state.sessionId, turns: [...state.turns, turn] };
      return { kind: "complete" as const, text, checkpoint: privateCheckpoint(next), usage };
    } finally {
      input.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
