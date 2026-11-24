import type { TextStateRoot } from "./text-state-location.ts";
import type { createCursorTextRuntime } from "@operatorworks/switchboard/cursor";
import { join } from "node:path";
import { warn } from "./diagnostics.ts";
import { completeTextWriterInventory } from "./text-runtime-inventory.ts";
import type { DriverInput, DriverResult } from "./activities.ts";
import { turnTextBytes, type Conversation } from "./domain.ts";
import { preparePrivate, removePrivate, sweepWhenSettled } from "./private-directory.ts";
import { boundedBy, scrubTextEngineEnvironment, TextTurnFailed, textTurnFailed, textTurnResult, textTurnRoot } from "./text-turn.ts";

export type CursorRuntimeOptions = Parameters<typeof createCursorTextRuntime>[0];
export type CursorRuntimeEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly callId: string; readonly name: string; readonly status: "running" | "completed" | "error" }
  | { readonly kind: "ended"; readonly outcome: "completed" | "failed" | "interrupted" };
export interface CursorRuntimeHandle {
  start(request: {
    readonly text: string;
    readonly onEvent: (event: CursorRuntimeEvent) => void;
  }): Promise<{ readonly agentId: string; readonly finished: Promise<string>; abort(): Promise<void> }>;
  close(): Promise<void>;
  /** Trusted runtime adapter attestation; absent means unknown helper groups. */
  writerGroups?(): readonly number[] | null;
}
export interface CursorProfile {
  model: string;
  apiKey: string;
  cwd: string;
  /** Test double. Production profiles omit it; only then does the turn publish the process session environment. It lives on the profile, not a separate argument, because
   * worker-level tests (text-member-gateway) can only inject doubles through the operator profile
   * module the worker loads; assertTextProfile still validates every production field. */
  runtime?: (options: CursorRuntimeOptions) => CursorRuntimeHandle | Promise<CursorRuntimeHandle>;
}

const closeBoundMs = 5_000;

async function defaultRuntime(options: CursorRuntimeOptions): Promise<CursorRuntimeHandle> {
  // The runner's database pool is already open. Scrub before the SDK import so a later homedir
  // read cannot land on the operator home shared with Codex and Claude.
  scrubTextEngineEnvironment();
  process.env.HOME = options.sessionDirectory;
  process.env.TMPDIR = options.sessionDirectory;
  process.env.CURSOR_DATA_DIR = options.sessionDirectory;
  try {
    const { createCursorTextRuntime } = await import("@operatorworks/switchboard/cursor");
    return createCursorTextRuntime(options);
  } catch {
    warn("cursor_policy_unsupported");
    throw textTurnFailed();
  }
}

function raceAbort<T extends { abort(): Promise<void> }>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(textTurnFailed());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then((handle) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        void Promise.resolve().then(() => handle.abort()).catch(() => undefined);
        reject(textTurnFailed());
      }
      else resolve(handle);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

/** True when close settled, false when the turn was stopped while close was still running.
 * closeBoundMs (5s) is only the grace an aborted turn gives close before abandoning it. A close
 * that is not aborted is awaited until the runner's turn signal aborts (supervisor-runner.ts),
 * because the session environment must outlive close. Do not align this with OpenCode's hard
 * close-and-kill bound: Cursor runs in-process and has no group to kill. */
async function waitForClose(closing: Promise<void>, signal: AbortSignal) {
  let endWait: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    endWait = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", endWait, { once: true });
  });
  await boundedBy(closing, closeBoundMs).catch(() => undefined);
  const settled = await Promise.race([
    closing.then(() => true, () => true),
    stopped.then(() => false),
  ]);
  signal.removeEventListener("abort", endWait);
  return settled;
}

async function settleCursorClose(runtime: CursorRuntimeHandle | undefined, signal: AbortSignal, sessionDirectory: string) {
  let closing: Promise<void> | undefined;
  try { closing = runtime?.close(); }
  catch { closing = undefined; }
  try {
    // The opaque SDK may resolve an abandoned admission after close returns. Keep this
    // dedicated runner's environment private until process exit, including late disposal.
    const settled = closing ? await waitForClose(closing, signal) : true;
    // An abandoned close can still write under the session directory; sweep it again when it ends.
    if (!settled && closing) sweepWhenSettled(closing, sessionDirectory);
  } finally {
    await removePrivate(sessionDirectory);
  }
}

/** One Cursor text turn. A tool event, an unknown event, or a rewritten snapshot fails the turn. */
export async function runCursorTurn(input: DriverInput, member: Conversation, profile: CursorProfile, stateDir: TextStateRoot): Promise<DriverResult> {
  const sessionDirectory = textTurnRoot(input, member, "cursor", stateDir);
  let runtime: CursorRuntimeHandle | undefined;
  let result: DriverResult | undefined;
  try {
    await preparePrivate(sessionDirectory, ["workspace"]);
    try {
      runtime = await (profile.runtime ?? defaultRuntime)({
        cwd: join(sessionDirectory, "workspace"), sessionDirectory, apiKey: profile.apiKey, model: profile.model,
      });
    } catch {
      throw textTurnFailed();
    }
    let latest = "";
    let outcome: string | undefined;
    let refusal = false;
    if (input.signal.aborted) throw textTurnFailed();
    const started = runtime.start({
      text: input.text,
      onEvent(event) {
        if (refusal) return;
        if (event.kind === "text") {
          if (!event.text.startsWith(latest)) { refusal = true; return; }
          const suffix = event.text.slice(latest.length);
          if (suffix.length > 0) void input.onText?.(suffix);
          latest = event.text;
          return;
        }
        if (event.kind === "ended") { outcome = event.outcome; return; }
        refusal = true;
      },
    });
    const turn = await raceAbort(started, input.signal);
    const onAbort = () => { void turn.abort().catch(() => undefined); };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort);
    try {
      const finished = await turn.finished;
      if (refusal || input.signal.aborted || finished !== "completed" || outcome !== "completed"
        || latest.length === 0 || Buffer.byteLength(latest) > turnTextBytes) throw textTurnFailed();
      result = {
        kind: "complete", text: latest,
        checkpoint: { version: 1, engine: "cursor", state: { model: profile.model, cwd: profile.cwd, agentId: turn.agentId } },
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "cursor_policy_unsupported") warn("cursor_policy_unsupported");
    if (error instanceof TextTurnFailed) throw error;
    throw textTurnFailed();
  } finally {
    await settleCursorClose(runtime, input.signal, sessionDirectory);
    if (!input.signal.aborted) completeTextWriterInventory(runtime?.writerGroups?.());
  }
  return textTurnResult(input.signal, result);
}
