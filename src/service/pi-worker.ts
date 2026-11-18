import {
  createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type AssistantMessageEventStream, type Model, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Socket } from "node:net";
import { forwardedOptions, readFrames, writeFrame, type HostFrame, type PiStart } from "./pi-channel.ts";
import { runSegment } from "./pi-session.ts";
import type { SessionProfile } from "./pi-state.ts";
import { runTrustedSession } from "./trusted-pi-session.ts";

// Started only by pi-launch.ts through the member launcher: no credentials, no sockets, only descriptor 3.
// Pi sessions here must stay in memory: file-backed Pi storage locks with utimes, which the launcher refuses.

// The host stops a worker by killing it, so the SDK's own signal never fires.
const signal = new AbortController().signal;
const streams = new Map<number, { events: AssistantMessageEventStream; release: () => void }>();
const calls = new Map<number, (result: { text: string; isError: boolean }) => void>();
let sequence = 0;
let started = false;
// Wrapping the inherited descriptor needs no socket call, which the launcher denies.
const channel = new Socket({ fd: 3, readable: true, writable: true });
const send = (message: object) => writeFrame(channel, message);
const forwarded = Object.keys(forwardedOptions.shape);

async function hostModels(model: Model<Api>) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  const stream: ProviderStreams["stream"] = (_model, context, options) => {
    const id = ++sequence;
    const events = createAssistantMessageEventStream();
    const cancel = () => send({ cancel: id });
    streams.set(id, { events, release: () => options?.signal?.removeEventListener("abort", cancel) });
    const values = options as Record<string, unknown> | undefined;
    send({ request: id, context, options: Object.fromEntries(forwarded.flatMap((key) => values?.[key] === undefined ? [] : [[key, values[key]]])) });
    if (options?.signal?.aborted) cancel();
    else options?.signal?.addEventListener("abort", cancel, { once: true });
    return events;
  };
  runtime.registerNativeProvider(createProvider({
    id: model.provider, models: [model],
    auth: { apiKey: { name: "Crew host", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return runtime;
}

// The host runs the tool with the arguments the model sent through it.
function dispatch(call: { nativeCallId: string; toolName: string }) {
  return new Promise<{ text: string; isError: boolean }>((resolve) => {
    const id = ++sequence;
    calls.set(id, resolve);
    send({ dispatch: id, nativeCallId: call.nativeCallId, toolName: call.toolName });
  });
}

async function run(command: PiStart) {
  const { model, instructions } = command;
  const profile: SessionProfile = { model, modelRuntime: await hostModels(model), ...(instructions !== undefined && { instructions }),
    allowRecordWorkItem: command.kind === "member" ? command.allowRecordWorkItem : undefined };
  // Text and argument previews are published by the host from the events it relays.
  if (command.kind === "trusted") {
    return runTrustedSession({ ...command.input, signal, dispatch, onToolDelivered: (delivered) => send({ delivered }) }, profile);
  }
  return runSegment({ ...command.input, signal }, profile, command.mode);
}

function receive(message: unknown) {
  if (!started) {
    started = true;
    run(message as PiStart).then((result) => ({ result }), (error: unknown) =>
      ({ error: (error instanceof Error ? error.message : "Pi worker failed").slice(0, 1024) }))
      .then((reply) => writeFrame(channel, reply, () => process.exit(0)));
    return;
  }
  // The host is trusted, so its frames are not parsed.
  const frame = message as HostFrame;
  if ("stream" in frame) {
    const entry = streams.get(frame.stream);
    if (!entry) return;
    if (frame.event.type === "done" || frame.event.type === "error") {
      streams.delete(frame.stream);
      entry.release();
    }
    entry.events.push(frame.event);
  } else {
    const resolve = calls.get(frame.dispatch);
    calls.delete(frame.dispatch);
    resolve?.(frame.result);
  }
}

// Losing the host ends the worker.
channel.once("end", () => process.exit(1));
channel.once("error", () => process.exit(1));
readFrames(channel, receive, () => process.exit(1));
