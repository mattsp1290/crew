import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PI_ATTRIBUTION, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Model, type ProviderResponse, type ToolCall } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Duplex } from "node:stream";
import type { z } from "zod";
import { readFrames, workerFrame, writeFrame, type forwardedOptions, type HostFrame, type PiCommand, type PiStart, type toolCallRef } from "./pi-channel.ts";
import type { PiProfile } from "./pi.ts";
import { replyBytes } from "./pi-state.ts";
import { toolPreviewReporter } from "./tool-preview.ts";

const source = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const launcher = join(source, ".proof/bin/member-launch");
const worker = fileURLToPath(new URL("./pi-worker.ts", import.meta.url));

/** The member launcher invocation of every Pi worker. Its private directory is the only place it may write
 * files, and descriptor 3 (a socket pair) is its only channel. */
export function piLaunch(directory: string, args: string[], invocationGroup?: number) {
  return {
    command: launcher,
    args: [String(process.pid), process.execPath, ...args],
    options: {
      cwd: directory, detached: !invocationGroup, stdio: ["ignore", "ignore", "ignore", "pipe"] as ("ignore" | "pipe")[],
      env: { HOME: directory, TMPDIR: directory, BIRBCREW_NATIVE_SOURCE: source },
    },
  };
}

// The most the host buffers for a worker that has stopped reading its channel.
const unreadBytes = 64 * 1024 * 1024;

export interface PiHost {
  profile: PiProfile;
  signal: AbortSignal;
  /** A member segment ends after one model reply; a trusted turn adds one per registered tool call. */
  modelRequests: number;
  onText?: (delta: string) => void | Promise<void>;
  /** Also publish text a reply sent without deltas, as the member session's AG-UI translator does. */
  translatedText?: boolean;
  /** The request whose fresh record_work_item call may publish argument previews, as the in-process session did. */
  previews?: string;
  onToolArgs?: (nativeCallId: string, matchedOperation: boolean) => void;
  /** Present only for trusted turns: the registered tools run here, with the call the model sent. */
  dispatch?: (call: ToolCall, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>;
  onToolDelivered?: (call: z.infer<typeof toolCallRef>) => void | Promise<void>;
}

export interface Delivered { toolCallId: string; toolName: string; text: string; isError: boolean }

// The identity the SDK's own session sends for this host (pi-coding-agent core/client-identity.js).
function identity() {
  const telemetry = process.env.PI_TELEMETRY;
  return { userAgent: "detailed" as const, version: VERSION,
    attribution: telemetry === undefined || ["1", "true", "yes"].includes(telemetry.toLowerCase()) ? PI_ATTRIBUTION : null };
}

const providerEvents = new Set(["before_provider_headers", "before_provider_request", "after_provider_response", "provider_stream_event"]);
type Handler = (event: object, context: never) => unknown;

// The worker never holds the profile's closures, so its extension runs here, limited to the provider request.
async function providerHooks(profile: PiProfile) {
  const prepared = await profile.prepare?.();
  const handlers = new Map<string, Handler[]>();
  const refuse = () => { throw new Error("A Pi profile extension may only observe the provider request"); };
  if (prepared) await prepared.extension(new Proxy({}, {
    get: (_, key) => key === "on" ? (event: string, handler: Handler) => {
      if (!providerEvents.has(event)) refuse();
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
    } : refuse(),
  }) as ExtensionAPI);
  const context = new Proxy({}, { get: refuse }) as never;
  const emit = async (type: string, event: object) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
  };
  return {
    verify: () => prepared?.verify(),
    options: {
      ...handlers.has("before_provider_headers") && {
        transformHeaders: async (headers: Record<string, string | null>) => { await emit("before_provider_headers", { headers }); return headers; },
      },
      ...handlers.has("before_provider_request") && {
        onPayload: async (payload: unknown) => {
          for (const handler of handlers.get("before_provider_request")!) {
            payload = await handler({ type: "before_provider_request", payload }, context) ?? payload;
          }
          return payload;
        },
      },
      ...handlers.has("after_provider_response") && {
        onResponse: async ({ status, headers }: ProviderResponse) => { await emit("after_provider_response", { status, headers }); },
      },
      ...handlers.has("provider_stream_event") && {
        onProviderStreamEvent: async (data: unknown, model: Model<Api>) => {
          await emit("provider_stream_event", { data, provider: model.provider, api: model.api, model: model.id });
        },
      },
    },
  };
}

function failed(model: Model<Api>, aborted: boolean): AssistantMessageEvent {
  const reason = aborted ? "aborted" : "error";
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { type: "error", reason, error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: reason,
    errorMessage: "Pi model request failed", timestamp: Date.now(),
  } };
}

/**
 * Runs one Pi command in a worker confined by the member launcher. The worker gets no credentials and no
 * sockets: this host makes each model request with the operator's profile and runs each tool dispatch.
 * Resolves with the worker's unvalidated result and what the host itself saw: the private directory, the
 * assistant messages it relayed, the text it published from them, and the tool results it delivered.
 */
export async function runPiWorker(command: PiCommand, host: PiHost) {
  host.signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "birb-pi-worker-"));
  try {
    return await supervise(directory, command, host);
  } finally {
    await removePrivate(directory);
  }
}

// A worker can leave a directory its host cannot list (mode 0300) or a tree deeper than PATH_MAX, which
// defeat Node's rm. GNU chmod and rm walk with descriptors; the worker has exited and could make no symlinks.
async function removePrivate(directory: string) {
  try { return await rm(directory, { recursive: true, force: true }); } catch { /* retried below */ }
  const run = promisify(execFile);
  await run("/bin/chmod", ["-R", "u+rwx", "--", directory]).catch(() => undefined);
  await run("/bin/rm", ["-rf", "--one-file-system", "--", directory]);
}

function supervise(directory: string, command: PiCommand, host: PiHost) {
  const { profile, signal } = host;
  const { headers: _, ...model } = profile.model;
  const launch = piLaunch(directory, [worker], profile.invocationGroup);
  return new Promise<{ result: unknown; directory: string; observed: AssistantMessage[]; streamed: string; delivered: Delivered[] }>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, launch.options);
    const channel = child.stdio[3] as Duplex | null;
    const halted = new AbortController(), exited = new AbortController();
    // The one model request being served (see serve).
    let active: { id: number; controller: AbortController } | undefined;
    const observed: AssistantMessage[] = [];
    // Trusted tool calls the model made, those dispatched, and the results not yet delivered to the model.
    const relayed = new Map<string, ToolCall>(), dispatched = new Set<string>(), undelivered = new Map<string, Delivered>();
    const delivered: Delivered[] = [];
    let reply: z.infer<typeof workerFrame> | undefined, failure: unknown, requests = 0, inflight = 0;
    let streamed = "", streamedBytes = 0;
    let hooks: ReturnType<typeof providerHooks> | undefined;
    let callbacks = Promise.resolve();
    const record = (error: unknown) => { if (!halted.signal.aborted) { failure = error; halted.abort(); } };
    const kill = (target: number) => {
      try { process.kill(target, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) record(error); }
    };
    // A worker in its own group is killed with the group, which lives while any process in it does.
    const stop = () => {
      if (!child.pid) return;
      if (!profile.invocationGroup) kill(-child.pid);
      else if (child.exitCode === null && child.signalCode === null) kill(child.pid);
    };
    // After a failure nothing the worker sent is acted on, and every request made for it is cancelled.
    const fail = (error: unknown) => { record(error); stop(); };
    const inOrder = (action: () => unknown) => {
      callbacks = callbacks.then(async () => { if (!halted.signal.aborted) await action(); }).catch(fail);
    };
    const post = (frame: PiStart | HostFrame) => {
      if (!channel?.writable || exited.signal.aborted) return;
      if (channel.writableLength > unreadBytes) return fail(new Error("Pi worker stopped reading its channel"));
      writeFrame(channel, frame, (error) => { if (error) fail(error); });
    };
    const working = () => AbortSignal.any([signal, halted.signal, exited.signal]);
    const preview = host.previews === undefined ? undefined :
      toolPreviewReporter(host.previews, (callId, matched) => inOrder(() => host.onToolArgs?.(callId, matched)));
    // sent counts the characters published for each content part of the reply being relayed.
    function publish(event: AssistantMessageEvent, sent: Map<number, number>) {
      const text = (index: number, delta: string) => {
        if (!delta) return;
        sent.set(index, (sent.get(index) ?? 0) + delta.length);
        streamedBytes += Buffer.byteLength(delta);
        if (streamedBytes > replyBytes) throw new Error("Pi model reply exceeded its bound");
        streamed += delta;
        inOrder(() => host.onText?.(delta));
      };
      if (event.type === "text_delta") text(event.contentIndex, event.delta);
      else if (host.translatedText && event.type === "text_end") text(event.contentIndex, event.content.slice(sent.get(event.contentIndex) ?? 0));
      else if (host.translatedText && (event.type === "done" || event.type === "error")) {
        for (const [index, part] of (event.type === "done" ? event.message : event.error).content.entries()) {
          if (part.type === "text") text(index, part.text.slice(sent.get(index) ?? 0));
        }
      } else if (preview && event.type === "toolcall_delta" && event.delta) {
        const call = event.partial.content[event.contentIndex];
        if (call?.type === "toolCall" && call.name === "record_work_item" && call.id) preview(call.id, call.arguments.operation_id);
      }
    }

    // The SDK waits for each reply before it asks again, so a worker never needs two requests at once.
    async function serve(id: number, context: Context, options: z.infer<typeof forwardedOptions>) {
      if (active || ++requests > host.modelRequests) throw new Error("Pi worker exceeded its model requests");
      const controller = new AbortController();
      active = { id, controller };
      let settled = false;
      const sent = new Map<number, number>();
      try {
        const extension = await (hooks ??= providerHooks(profile));
        const events = profile.modelRuntime.streamSimple(profile.model, context, {
          ...options, maxRetries: 0, identity: identity(), ...extension.options, signal: AbortSignal.any([working(), controller.signal]),
        });
        for await (const event of events) {
          publish(event, sent);
          if (event.type === "done" || event.type === "error") {
            observed.push(event.type === "done" ? event.message : event.error);
            // The agent runs a reply's tool calls unless it failed or was cut off by its token limit.
            if (event.type === "done" && event.message.stopReason !== "length") {
              for (const part of event.message.content) if (part.type === "toolCall") relayed.set(part.id, part);
            }
            settled = true;
          }
          post({ stream: id, event });
          if (settled) break;
        }
      } finally {
        active = undefined;
        if (!settled) post({ stream: id, event: failed(profile.model, controller.signal.aborted) });
      }
    }

    // The tool runs with the call the model sent, never with arguments from the worker. As in process, a
    // failed dispatch fails the turn.
    async function dispatch(id: number, { nativeCallId, toolName }: z.infer<typeof toolCallRef>) {
      const call = relayed.get(nativeCallId);
      if (!host.dispatch || call?.name !== toolName || dispatched.has(nativeCallId)) {
        throw new Error("Pi worker dispatched a tool call its model did not make");
      }
      dispatched.add(nativeCallId);
      inflight++;
      try {
        const { text, isError } = await host.dispatch(call, working());
        undelivered.set(nativeCallId, { toolCallId: nativeCallId, toolName, text, isError });
        post({ dispatch: id, result: { text, isError } });
      } finally {
        inflight--;
      }
    }

    function receive(value: unknown) {
      if (halted.signal.aborted) return;
      const parsed = workerFrame.safeParse(value);
      if (!parsed.success || reply) return fail(new Error("Unexpected Pi worker message"));
      const message = parsed.data;
      if ("request" in message) serve(message.request, message.context as unknown as Context, message.options).catch(fail);
      else if ("cancel" in message) { if (active?.id === message.cancel) active.controller.abort(); }
      else if ("dispatch" in message) {
        const { dispatch: id, ...call } = message;
        dispatch(id, call).catch(fail);
      } else if ("delivered" in message) {
        const result = undelivered.get(message.delivered.nativeCallId);
        if (result?.toolName !== message.delivered.toolName) return fail(new Error("Unpaired Pi tool result"));
        undelivered.delete(result.toolCallId);
        delivered.push(result);
        inOrder(() => host.onToolDelivered?.(message.delivered));
      } else {
        // The worker's last frame: its result, or the error that ended its session.
        if ("result" in message && (inflight || undelivered.size || active)) return fail(new Error("Pi worker finished before its model reply or tool results"));
        reply = message;
      }
    }

    if (channel) {
      channel.on("error", fail);
      readFrames(channel, receive, fail);
    }
    child.once("error", (error) => {
      if (child.pid === undefined) reject(error);
      else fail(error);
    });
    child.once("exit", () => {
      exited.abort();
      if (!profile.invocationGroup) stop();
      // Settle even if something still holds the channel open.
      const grace = setTimeout(() => { fail(new Error("Pi worker left its channel open")); channel?.destroy(); }, 5_000);
      grace.unref();
      child.once("close", () => clearTimeout(grace));
    });
    // close, not exit: it follows the last frame on the channel.
    child.once("close", async (code) => {
      signal.removeEventListener("abort", stop);
      try {
        await callbacks;
        signal.throwIfAborted();
        if (code === 126) throw new Error("The native launcher refused to start the Pi worker");
        if (halted.signal.aborted) throw failure ?? new Error("Pi worker failed");
        if (code !== 0 || !reply || !("result" in reply || "error" in reply)) throw new Error("Pi worker exited without a result");
        if ("error" in reply) throw new Error(reply.error);
        if (!observed.length) throw new Error("Pi worker answered without a model request");
        if (profile.prepare) (await hooks!).verify();
        resolve({ result: reply.result, directory, observed, streamed, delivered });
      } catch (error) {
        reject(error);
      }
    });
    signal.addEventListener("abort", stop, { once: true });
    post({ ...command, model });
    if (signal.aborted) stop();
  });
}
