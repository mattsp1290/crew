import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DriverInput, DriverResult } from "./activities.ts";
import { turnTextBytes, type Conversation } from "./domain.ts";
import type { CursorProfile, CursorRuntimeHandle, CursorRuntimeOptions } from "./profiles.ts";

const failed = () => new Error("Text engine turn failed");
const closeBoundMs = 5_000;

async function defaultRuntime(options: CursorRuntimeOptions): Promise<CursorRuntimeHandle> {
  const { createCursorRuntime } = await import("@mattsp1290/switchboard/cursor");
  // The runner's database pool is already open. Tool shells copy process.env, so only the locale
  // and PATH remain for the rest of this one-shot process.
  const inherited = new Set(["PATH", "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]);
  for (const key of Object.keys(process.env)) if (!inherited.has(key)) delete process.env[key];
  process.env.HOME = options.sessionDirectory;
  process.env.TMPDIR = options.sessionDirectory;
  process.env.CURSOR_DATA_DIR = options.sessionDirectory;
  return createCursorRuntime(options);
}

async function removePrivate(directory: string) {
  try { await rm(directory, { recursive: true, force: true }); return; }
  catch { /* a child can leave a directory this uid cannot list */ }
  const run = promisify(execFile);
  await run("/bin/chmod", ["-R", "u+rwx", "--", directory]).catch(() => undefined);
  await run("/bin/rm", ["-rf", "--one-file-system", "--", directory]);
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

/** One Cursor text turn. A tool event, an unknown event, or a rewritten snapshot fails the turn. */
export async function runCursorTurn(input: DriverInput, member: Conversation, profile: CursorProfile, stateDir: string): Promise<DriverResult> {
  if (input.checkpoint !== null || input.projectContext !== undefined || input.childProfile || input.childResults || input.continuation) throw failed();
  const sessionDirectory = join(stateDir, "cursor", createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
  await removePrivate(sessionDirectory);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(sessionDirectory, 0o700);
  let runtime: CursorRuntimeHandle | undefined;
  let result: DriverResult | undefined;
  try {
    try {
      runtime = await (profile.runtime ?? defaultRuntime)({
        cwd: profile.cwd, sessionDirectory, apiKey: profile.apiKey, model: profile.model,
      });
    } catch {
      throw failed();
    }
    let latest = "";
    let outcome: string | undefined;
    let sawDisallowed = false;
    const started = runtime.start({
      text: input.text,
      onEvent(event) {
        if (event.kind === "text" && typeof event.text === "string") {
          const text = event.text;
          if (!text.startsWith(latest)) {
            sawDisallowed = true;
            throw failed();
          }
          const suffix = text.slice(latest.length);
          if (suffix.length > 0) void input.onText?.(suffix);
          latest = text;
          return;
        }
        if (event.kind === "ended" && typeof event.outcome === "string") {
          outcome = event.outcome;
          return;
        }
        sawDisallowed = true;
        throw failed();
      },
    });
    let rejectPending: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
    void aborted.catch(() => undefined);
    const onEarlyAbort = () => rejectPending(failed());
    if (input.signal.aborted) onEarlyAbort();
    else input.signal.addEventListener("abort", onEarlyAbort);
    const pending = started.then((handle) => {
      if (input.signal.aborted) void handle.abort().catch(() => undefined);
      return handle;
    });
    let turn: Awaited<ReturnType<CursorRuntimeHandle["start"]>>;
    try {
      turn = await Promise.race([pending, aborted]);
    } finally {
      input.signal.removeEventListener("abort", onEarlyAbort);
    }
    const onAbort = () => { void turn.abort().catch(() => undefined); };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort);
    try {
      const finished = await turn.finished;
      if (sawDisallowed || input.signal.aborted || finished !== "completed" || outcome !== "completed"
        || latest.length === 0 || Buffer.byteLength(latest) > turnTextBytes) throw failed();
      result = {
        kind: "complete", text: latest,
        checkpoint: { version: 1, engine: "cursor", state: { model: profile.model, cwd: profile.cwd, agentId: turn.agentId } },
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Text engine turn failed") throw error;
    throw failed();
  } finally {
    try {
      if (runtime) await bounded(runtime.close());
      await removePrivate(sessionDirectory);
    } catch (error) {
      if (error instanceof Error && error.message === "Text engine turn failed") throw error;
      throw failed();
    }
  }
  if (input.signal.aborted || !result) throw failed();
  return result;
}
