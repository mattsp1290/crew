import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DriverInput, DriverResult } from "./activities.ts";
import { turnTextBytes, type Conversation } from "./domain.ts";
import { removePrivate, scrubTextEngineEnvironment, TextTurnFailed } from "./private-directory.ts";

export interface CursorRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly model: string;
}
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
}
export interface CursorProfile {
  model: string;
  apiKey: string;
  cwd: string;
  /** Test double. Production profiles omit it, and registration does not store it. */
  runtime?: (options: CursorRuntimeOptions) => CursorRuntimeHandle | Promise<CursorRuntimeHandle>;
}

const failed = () => new TextTurnFailed();
const closeBoundMs = 5_000;

async function defaultRuntime(options: CursorRuntimeOptions): Promise<CursorRuntimeHandle> {
  // The runner's database pool is already open. Scrub before the SDK import so a later homedir
  // read cannot land on the operator home shared with Codex and Claude.
  scrubTextEngineEnvironment();
  process.env.HOME = options.sessionDirectory;
  process.env.TMPDIR = options.sessionDirectory;
  process.env.CURSOR_DATA_DIR = options.sessionDirectory;
  const { createCursorRuntime } = await import("@mattsp1290/switchboard/cursor");
  return createCursorRuntime(options);
}

function raceAbort<T extends { abort(): Promise<void> }>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const tracked = work.then((handle) => {
    if (signal.aborted) void handle.abort().catch(() => undefined);
    return handle;
  });
  tracked.catch(() => undefined);
  if (signal.aborted) return Promise.reject(failed());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(failed());
    signal.addEventListener("abort", onAbort, { once: true });
    tracked.then((handle) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(failed());
      else resolve(handle);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(failed()), closeBoundMs);
    timer.unref?.();
  });
  work.catch(() => undefined);
  timeout.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function settleCursorClose(runtime: CursorRuntimeHandle | undefined, signal: AbortSignal, sessionDirectory: string, ownsSessionEnvironment: boolean) {
  let closing: Promise<void> | undefined;
  try { closing = runtime?.close(); }
  catch { closing = undefined; }
  try {
    if (!closing) return;
    let endWait: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      endWait = resolve;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", endWait, { once: true });
    });
    await bounded(closing).catch(() => undefined);
    const settled = await Promise.race([
      closing.then(() => true, () => true),
      stopped.then(() => false),
    ]);
    signal.removeEventListener("abort", endWait);
    if (settled && ownsSessionEnvironment) {
      delete process.env.HOME;
      delete process.env.TMPDIR;
      delete process.env.CURSOR_DATA_DIR;
    }
  } finally {
    await removePrivate(sessionDirectory);
  }
}

/** One Cursor text turn. A tool event, an unknown event, or a rewritten snapshot fails the turn. */
export async function runCursorTurn(input: DriverInput, member: Conversation, profile: CursorProfile, stateDir: string): Promise<DriverResult> {
  if (input.checkpoint !== null || input.projectContext !== undefined || input.childProfile || input.childResults || input.continuation) throw failed();
  const sessionDirectory = join(stateDir, "cursor", createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
  const ownsSessionEnvironment = profile.runtime === undefined;
  let runtime: CursorRuntimeHandle | undefined;
  let result: DriverResult | undefined;
  try {
    await removePrivate(sessionDirectory);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    try {
      runtime = await (profile.runtime ?? defaultRuntime)({
        cwd: profile.cwd, sessionDirectory, apiKey: profile.apiKey, model: profile.model,
      });
    } catch {
      throw failed();
    }
    let latest = "";
    let outcome: string | undefined;
    let refusal = false;
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
        || latest.length === 0 || Buffer.byteLength(latest) > turnTextBytes) throw failed();
      result = {
        kind: "complete", text: latest,
        checkpoint: { version: 1, engine: "cursor", state: { model: profile.model, cwd: profile.cwd, agentId: turn.agentId } },
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (error instanceof TextTurnFailed) throw error;
    throw failed();
  } finally {
    await settleCursorClose(runtime, input.signal, sessionDirectory, ownsSessionEnvironment);
  }
  if (input.signal.aborted || !result) throw failed();
  return result;
}
