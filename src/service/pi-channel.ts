import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { DriverInput } from "./activities.ts";
import type { PiMode } from "./pi-state.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";

// The host and its confined Pi worker exchange newline-delimited JSON over descriptor 3, and this module is
// the only definition of what crosses it. Node's own IPC channel is not used: one malformed line from the
// worker would throw out of Node's reader and end the host.

/** The JSON fields of a member segment's input; callbacks stay on the host. */
export type MemberInput = Pick<DriverInput, "threadId" | "runId" | "text" | "checkpoint" | "projectContext" | "childResults" | "continuation">;
/** The JSON fields of a trusted application turn's input; the registered tools run on the host. */
export type TrustedInput = Pick<TrustedNativeInput, "text" | "context" | "checkpoint" | "tools">;
export type PiCommand =
  | { kind: "member"; mode: PiMode; instructions?: string; allowRecordWorkItem?: boolean; input: MemberInput }
  | { kind: "trusted"; instructions?: string; input: TrustedInput };
/** Host to worker, the first frame. The profile's headers never cross. */
export type PiStart = PiCommand & { model: Omit<Model<Api>, "headers"> };
/** Host to worker, every later frame. A failed dispatch kills the worker, so no frame reports one. */
export type HostFrame =
  | { stream: number; event: AssistantMessageEvent }
  | { dispatch: number; result: { text: string; isError: boolean } };

/** The request options the worker's session may set. The host fixes retries and identity, and keeps
 * credentials, headers and callbacks; Crew runs Pi with thinking off, so reasoning never crosses. */
export const forwardedOptions = z.strictObject({
  sessionId: z.uuid().optional(),
  transport: z.enum(["sse", "websocket", "websocket-cached", "auto"]).optional(),
  timeoutMs: z.int().min(1).max(2_147_483_647).optional(),
  websocketConnectTimeoutMs: z.int().min(1).max(600_000).optional(),
  maxRetries: z.literal(0).optional(),
  maxRetryDelayMs: z.int().min(0).max(600_000).optional(),
});
const id = z.int().min(1);
export const toolCallRef = z.strictObject({ nativeCallId: z.string().min(1).max(256), toolName: z.string().min(1).max(64) });
/** Worker to host: untrusted, so parsed. The worker reports no text or previews: the host derives both from
 * the events it relays. A request's context stays unchecked because the worker builds the model's context. */
export const workerFrame = z.union([
  z.strictObject({ request: id, context: z.record(z.string(), z.unknown()), options: forwardedOptions }),
  z.strictObject({ cancel: id }),
  z.strictObject({ dispatch: id, ...toolCallRef.shape }),
  z.strictObject({ delivered: toolCallRef }),
  z.strictObject({ result: z.unknown() }),
  z.strictObject({ error: z.string().max(1024) }),
]);

// A frame holds at most one model context: a 4 MiB checkpoint's turns, the instructions and context, and
// the tool schemas. The limit counts characters.
const frameLimit = 16 * 1024 * 1024;

export function readFrames(stream: Duplex, onFrame: (value: unknown) => void, onError: (error: Error) => void) {
  let pending: string[] = [], size = 0, failed = false;
  const fail = (error: Error) => { failed = true; pending = []; onError(error); };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0 && !failed; end = chunk.indexOf("\n", start)) {
      const line = pending.join("") + chunk.slice(start, end);
      pending = []; size = 0; start = end + 1;
      let value: unknown;
      try { value = JSON.parse(line); } catch { return fail(new Error("Malformed Pi channel frame")); }
      onFrame(value);
    }
    if (failed) return;
    size += chunk.length - start;
    if (size > frameLimit) return fail(new Error("Oversized Pi channel frame"));
    if (start < chunk.length) pending.push(chunk.slice(start));
  });
}

export function writeFrame(stream: Duplex, value: unknown, done?: (error?: Error | null) => void) {
  stream.write(JSON.stringify(value) + "\n", done);
}
