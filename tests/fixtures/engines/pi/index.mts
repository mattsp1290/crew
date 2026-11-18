import { handoffAcknowledgement } from "../handoff.mts";
import { holdResumedReceipt, streamGate, waitForGate } from "../stream-gate.mts";
import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { createTranslator, toAguiMessages } from "@ag-ui/pi";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  type Context,
  getCurrentTools,
  type ToolCall,
  type JsonObject,
  contentText,
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  type ProviderStreams,
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { Observable } from "rxjs";

const recordToolSchema = z.object({
  properties: z.object({ operation_id: z.object({ const: z.string() }) }),
});

const model = fauxProvider({ api: "birbcrew-fixture" }).getModel();

function scriptedStream(context: Context, signal: AbortSignal | undefined, onProviderFailure?: () => void) {
  const prompts = context.messages
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content));
  const latest = prompts.at(-1);
  const wait = latest === "wait" || latest === "child wait";
  const prefix = "remember ";
  const remembered = prompts.findLast((text) => text.startsWith(prefix))?.slice(prefix.length);
  const stream = createAssistantMessageEventStream();

  function fail(reason: "error" | "aborted") {
    const error = fauxAssistantMessage("", { stopReason: reason, errorMessage: "Pi fixture " + reason });
    stream.push({ type: "error", reason, error });
  }

  if (latest === "fail") {
    onProviderFailure?.();
    fail("error");
    return stream;
  }
  const last = context.messages.findLast((message) => message.role !== "system");
  let calls: ToolCall[] | undefined;
  if (latest?.startsWith("delegate ") && last?.role !== "toolResult") {
    const tasks: JsonObject[] = JSON.parse(latest.slice("delegate ".length));
    calls = tasks.map((args) => fauxToolCall("delegate_task", args, { id: "call_" + randomUUID() }));
  }
  if (calls) {
    const preamble = "Assigning tasks.";
    const message = fauxAssistantMessage([{type:"text", text:preamble},...calls],{stopReason:"toolUse",responseId:randomUUID()});
    stream.push({type:"start",partial:fauxAssistantMessage("")});
    stream.push({type:"text_delta",contentIndex:0,partial:fauxAssistantMessage(preamble),delta:preamble});
    stream.push({type:"done",reason:"toolUse",message});
    return stream;
  }
  if ((latest?.startsWith("record ") || latest === "next step") && last?.role !== "toolResult") {
    const [, operation, ...words] = latest.split(" ");
    const gate = streamGate(latest.slice(7));
    const tool = getCurrentTools(context.messages).find(t => t.name === "record_work_item");
    const operation_id = gate ? words[0] : operation === "assigned" ? recordToolSchema.parse(tool?.parameters).properties.operation_id.const : operation;
    const args: JsonObject = { operation_id, note: !gate && words.length ? words.join(" ") : "private fixture note" };
    const call = latest === "next step" ? fauxToolCall("choose_next_step", {}, { id: "call_" + randomUUID() }) :
      fauxToolCall("record_work_item", args, { id: "call_" + randomUUID() });
    const message = fauxAssistantMessage([call], { stopReason: "toolUse", responseId: randomUUID() });
    stream.push({ type: "start", partial: fauxAssistantMessage("") });
    if (gate) {
      const partial = fauxAssistantMessage([fauxToolCall(call.name, { note: args.note }, { id: call.id })]);
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      stream.push({ type: "toolcall_delta", contentIndex: 0, partial, delta: '{"note":"private fixture note",' });
      void waitForGate(gate + ".value").then(async () => {
        stream.push({ type: "toolcall_delta", contentIndex: 0, partial: message, delta: '"operation_id":' + JSON.stringify(operation_id) });
        await waitForGate(gate);
        stream.push({ type: "toolcall_delta", contentIndex: 0, partial: message, delta: "}" });
        stream.push({ type: "toolcall_end", contentIndex: 0, partial: message, toolCall: call });
        stream.push({ type: "done", reason: "toolUse", message });
      }).catch(() => fail("error"));
      return stream;
    }
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  }
  const silentGate = latest?.startsWith("silent ") && streamGate(latest.slice(7));
  if (silentGate) {
    stream.push({ type: "start", partial: fauxAssistantMessage("") });
    void waitForGate(silentGate).then(() => {
      stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("step complete", { responseId: randomUUID() }) });
    }, () => fail("error"));
    return stream;
  }
  const gate = streamGate(latest);
  if (gate) {
    const first = fauxAssistantMessage("first");
    const complete = fauxAssistantMessage("first second", { responseId: randomUUID() });
    stream.push({ type: "start", partial: fauxAssistantMessage("") });
    stream.push({ type: "text_delta", contentIndex: 0, partial: first, delta: "first" });
    void waitForGate(gate).then(() => {
      stream.push({ type: "text_delta", contentIndex: 0, partial: complete, delta: " second" });
      stream.push({ type: "done", reason: "stop", message: complete });
    }, () => fail("error"));
    return stream;
  }
  let text: string;
  if (latest?.startsWith("delegate ") && last?.role === "toolResult") {
    const start = context.messages.findLastIndex((m) => m.role === "assistant");
    const outcomes = context.messages.slice(start + 1).filter((m) => m.role === "toolResult");
    text = "delegated " + JSON.stringify(outcomes.map((m) => JSON.parse(contentText(m.content))));
  } else if (latest === "next step" && last?.role === "toolResult") {
    const proposal = context.messages.findLast((message) => message.role === "assistant");
    if (!proposal?.content.some((part) => part.type === "toolCall" && part.id === last.toolCallId && part.name === "choose_next_step")) {
      throw new Error("Wrong human answer binding");
    }
    const answer = contentText(last.content);
    text = last.isError ? JSON.parse(answer).kind : "selected " + answer;
  } else if (latest?.startsWith("record ") && last?.role === "toolResult") text = "settled " + contentText(last.content);
  else if (handoffAcknowledgement(latest)) text = handoffAcknowledgement(latest)!;
  else if (latest === "recall") text = "recalled " + (remembered ?? "none");
  else if (latest?.startsWith(prefix)) text = "stored " + latest.slice(prefix.length);
  else if (wait) text = "waiting";
  else throw new Error("Unexpected Pi fixture prompt");

  const message = fauxAssistantMessage(text, { responseId: randomUUID() });
  stream.push({ type: "start", partial: fauxAssistantMessage("") });
  stream.push({ type: "text_delta", contentIndex: 0, partial: message, delta: text });
  if (wait || (last?.role === "toolResult" && holdResumedReceipt(latest))) {
    if (!signal) throw new Error("Pi must supply a cancellation signal");
    if (signal.aborted) fail("aborted");
    else signal.addEventListener("abort", () => fail("aborted"), { once: true });
  } else {
    stream.push({ type: "done", reason: "stop", message });
  }
  return stream;
}

export async function createFixture(onProviderFailure: () => void) {
  const sessions = new Map<string, Agent>();
  const messageIds = new WeakMap<object, string>();

  return {
    run({ threadId, runId, messages }: RunAgentInput, signal: AbortSignal) {
      return new Observable<BaseEvent>((subscriber) => {
        const agent = sessions.get(threadId) ?? new Agent({
          sessionId: threadId,
          initialState: { model },
          streamFn: (_model, context, options) => scriptedStream(context, options?.signal, onProviderFailure),
        });
        sessions.set(threadId, agent);
        const assistantId = runId + ":assistant";
        const translator = createTranslator({
          threadId,
          runId,
          completion: "caller",
          messageId: () => assistantId,
          getMessages: () => toAguiMessages(agent.state.messages.flatMap((message) => {
            const id = messageIds.get(message);
            return id === undefined ? [] : [{ id, message }];
          })),
        });
        const emit = (events: BaseEvent[]) => events.forEach((event) => subscriber.next(event));
        emit(translator.start());
        const prompt = messages.at(-1);
        if (
          prompt?.role !== "user" || typeof prompt.content !== "string" ||
          agent.state.isStreaming || signal.aborted
        ) {
          emit(translator.error("Pi cannot start the requested turn"));
          subscriber.complete();
          return;
        }
        const unsubscribe = agent.subscribe((event) => {
          if (event.type === "message_end") {
            messageIds.set(event.message, event.message.role === "user" ? prompt.id : assistantId);
          }
          emit(translator.translate(event));
        });
        const abort = () => agent.abort();
        signal.addEventListener("abort", abort, { once: true });
        let settled = false;

        async function runTurn(text: string) {
          try {
            await agent.prompt(text);
            const last = agent.state.messages.at(-1);
            const reason = last?.role === "assistant" ? last.stopReason : undefined;
            if (reason === "stop") emit(translator.finish());
            else emit(translator.error(reason === "aborted" ? "Pi run aborted" : "Pi model request failed"));
          } catch {
            emit(translator.error("Pi model request failed"));
          } finally {
            settled = true;
            signal.removeEventListener("abort", abort);
            unsubscribe();
            subscriber.complete();
          }
        }
        void runTurn(prompt.content);
        return () => {
          if (!settled) abort();
        };
      });
    },
    async close() {
      for (const agent of sessions.values()) agent.abort();
      await Promise.all([...sessions.values()].map((agent) => agent.waitForIdle()));
      sessions.clear();
    },
  };
}

export async function createPiFixtureOptions(
  observe?: (context: Context, options?: { sessionId?: string; model?: string }) => void,
  identity?: { id: string; baseUrl: string },
) {
  const fixtureModel = identity ? { ...model, ...identity } : model;
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const stream: ProviderStreams["stream"] = (_model, context, options) => {
    observe?.(context, { ...options, model: _model.id });
    return scriptedStream(context, options?.signal);
  };
  modelRuntime.registerNativeProvider(createProvider({
    id: fixtureModel.provider, models: [fixtureModel],
    auth: { apiKey: { name: "BirbCrew fixture", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return { model: fixtureModel, modelRuntime };
}
