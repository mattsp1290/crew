import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DriverInput, DriverResult } from "./activities.ts";
import { turnTextBytes, type Conversation } from "./domain.ts";
import type { CursorProfile, CursorRuntimeHandle, CursorRuntimeOptions } from "./profiles.ts";

const failed = () => new Error("Text engine turn failed");

async function defaultRuntime(options: CursorRuntimeOptions): Promise<CursorRuntimeHandle> {
  const { createCursorRuntime } = await import("@mattsp1290/switchboard/cursor");
  return createCursorRuntime(options);
}

/** One Cursor text turn. The committed reply is the last text snapshot. Tool events are discarded. */
export async function runCursorTurn(input: DriverInput, member: Conversation, profile: CursorProfile, stateDir: string): Promise<DriverResult> {
  if (input.checkpoint !== null || input.projectContext !== undefined) throw failed();
  const sessionDirectory = join(stateDir, "cursor", createHash("sha256").update(member.ownerId).digest("hex"), member.memberId);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  let runtime: CursorRuntimeHandle;
  try {
    runtime = await (profile.runtime ?? defaultRuntime)({
      cwd: profile.cwd, sessionDirectory, apiKey: profile.apiKey, model: profile.model,
    });
  } catch {
    throw failed();
  }
  let latest = "";
  let publish = true;
  let outcome: string | undefined;
  const started = runtime.start({
    text: input.text,
    onEvent(event) {
      if (event.kind === "text" && typeof event.text === "string") {
        const text = event.text;
        if (publish && text.startsWith(latest)) {
          const suffix = text.slice(latest.length);
          if (suffix.length > 0) void input.onText?.(suffix);
        } else publish = false;
        latest = text;
      } else if (event.kind === "ended" && typeof event.outcome === "string") outcome = event.outcome;
    },
  });
  let rejectPending: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
  void aborted.catch(() => undefined);
  const onEarlyAbort = () => rejectPending(failed());
  if (input.signal.aborted) onEarlyAbort();
  else input.signal.addEventListener("abort", onEarlyAbort);
  let turn: Awaited<ReturnType<CursorRuntimeHandle["start"]>>;
  try {
    turn = await Promise.race([started, aborted]);
  } catch {
    await runtime.close().catch(() => undefined);
    throw failed();
  } finally {
    input.signal.removeEventListener("abort", onEarlyAbort);
  }
  const onAbort = () => { void turn.abort().catch(() => undefined); };
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort);
  try {
    const finished = await turn.finished;
    if (input.signal.aborted || finished !== "completed" || outcome !== "completed"
      || latest.length === 0 || Buffer.byteLength(latest) > turnTextBytes) throw failed();
    return {
      kind: "complete", text: latest,
      checkpoint: { version: 1, engine: "cursor", state: { model: profile.model, cwd: profile.cwd, sessionDirectory, agentId: turn.agentId } },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Text engine turn failed") throw error;
    throw failed();
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    await runtime.close().catch(() => undefined);
  }
}
