import { spawn } from "node:child_process";
import { join } from "node:path";
import type { DriverInput, DriverResult } from "./activities.ts";
import { opencodePromptRejected, turnTextBytes } from "./domain.ts";
import type { Conversation } from "./domain.ts";
import { preparePrivate, removePrivate, sweepWhenSettled } from "./private-directory.ts";
import { boundedBy, TextTurnFailed, textTurnFailed, textTurnResult, textTurnRoot } from "./text-turn.ts";

export interface OpenCodeSpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface OpenCodeSpawned {
  readonly channel: {
    listen(sink: { (chunk: Uint8Array): void; ended(): void }): () => void;
    write(frame: Uint8Array, signal: AbortSignal): PromiseLike<void>;
    endInput(): void;
  };
  readonly processExit: PromiseLike<unknown>;
}
export interface OpenCodeProfile {
  model: string;
  executable: string;
  cwd: string;
  account: string;
  env: Readonly<Record<string, string>>;
  /** Test double. Production profiles omit it. It lives on the profile, not a separate argument, because
   * worker-level tests (text-member-gateway) can only inject doubles through the operator profile
   * module the worker loads; assertTextProfile still validates every production field. */
  spawn?: (request: OpenCodeSpawnRequest, signal: AbortSignal) => OpenCodeSpawned | Promise<OpenCodeSpawned>;
}

const maxPrompt = 1_048_576;
const closeBoundMs = 2_000;

function promptAllowed(value: string) {
  return value.length >= 1 && Buffer.byteLength(value) <= maxPrompt && !opencodePromptRejected(value);
}
function sameEnvironment(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
/** Spawns the detached ACP process. `kill` SIGKILLs its whole process group. */
function spawnProcess(request: OpenCodeSpawnRequest, signal: AbortSignal, home: string, tmp: string): OpenCodeSpawned & { kill(): void } {
  const child = spawn(request.args[0], request.args.slice(1), {
    cwd: request.cwd, env: { ...request.env, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: tmp, XDG_DATA_HOME: home },
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => undefined);
  child.stderr?.on("data", () => undefined);
  let settled = false;
  let closing = false;
  let resolveExit: (value: unknown) => void = () => undefined;
  let rejectExit: (error: unknown) => void = () => undefined;
  const processExit = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    if (ok) resolveExit(undefined);
    else rejectExit(new Error("exit"));
  };
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ESRCH" && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* the group signal is the stop */ }
      }
    }
    closing = true;
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  child.once("exit", (code) => {
    signal.removeEventListener("abort", stop);
    finish(code === 0 || closing);
  });
  child.once("error", () => finish(false));
  return {
    processExit,
    kill: stop,
    channel: {
      listen(sink) {
        const onData = (chunk: Buffer) => sink(chunk);
        const onEnd = () => sink.ended();
        child.stdout?.on("data", onData);
        child.stdout?.on("end", onEnd);
        return () => {
          child.stdout?.off("data", onData);
          child.stdout?.off("end", onEnd);
        };
      },
      write(frame, signal) {
        if (signal.aborted) return Promise.reject(textTurnFailed());
        return new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(textTurnFailed());
          signal.addEventListener("abort", onAbort, { once: true });
          child.stdin?.write(frame, (error) => {
            signal.removeEventListener("abort", onAbort);
            if (error) reject(textTurnFailed());
            else resolve();
          });
        });
      },
      endInput() {
        child.stdin?.end();
        stop();
      },
    },
  };
}

/** One OpenCode ACP turn. The spawn environment is the profile map, and the argv is `[executable, "acp"]`. */
export async function runOpenCodeTurn(input: DriverInput, member: Conversation, profile: OpenCodeProfile, stateDir: string): Promise<DriverResult> {
  if (!promptAllowed(input.text)) throw textTurnFailed();
  const root = textTurnRoot(input, member, "opencode", stateDir);
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  // Set only when this turn spawned the real process; a test double owns its own lifetime.
  let local: { kill(): void; exit: Promise<unknown> } | undefined;
  const killGroup = () => local?.kill();
  let completed: DriverResult | undefined;
  try {
    await preparePrivate(root, ["home", "tmp"]);
    const { opencodeHostAdapter } = await import("@mattsp1290/switchboard/host/opencode");
    const opened = await opencodeHostAdapter.open({
      model: profile.model,
      environment: { variables: { ...profile.env }, nativeConfig: { cwd: profile.cwd, executable: profile.executable, account: profile.account } },
      launch: {
        kind: "spawn",
        spawn: (request, signal) => {
          const args = [...request.args];
          if (args.length !== 2 || args[0] !== profile.executable || args[1] !== "acp" || request.cwd !== profile.cwd
            || !sameEnvironment(request.env, profile.env)) throw textTurnFailed();
          if (profile.spawn) return profile.spawn(request, signal);
          const { kill, ...spawned } = spawnProcess(request, signal, home, tmp);
          local = { kill, exit: Promise.resolve(spawned.processExit) };
          return spawned;
        },
      },
    }, input.signal);
    if (opened.kind !== "ok") throw textTurnFailed();
    const adapter = opened.value;
    const subscription = adapter.events.subscribe((event) => {
      if (event.kind === "text-delta") void input.onText?.(event.text);
    });
    try {
      const result = await adapter.run({
        prompt: input.text, signal: input.signal, hostOperationId: input.runId, recordIntent: async () => undefined,
      });
      const text = result.kind === "complete" ? result.text : "";
      if (input.signal.aborted || result.kind !== "complete" || text.length === 0 || Buffer.byteLength(text) > turnTextBytes) throw textTurnFailed();
      completed = {
        kind: "complete", text,
        checkpoint: {
          version: 1, engine: "opencode",
          state: { model: profile.model, cwd: profile.cwd, executable: profile.executable, account: profile.account, session: result.session },
        },
      };
    } catch (error) {
      if (error instanceof TextTurnFailed) throw error;
      throw textTurnFailed();
    } finally {
      if (subscription.kind === "ok") subscription.value.dispose();
      await boundedBy(adapter.close(), closeBoundMs, killGroup).catch(() => undefined);
    }
  } finally {
    killGroup();
    const processExit = local?.exit ?? Promise.resolve();
    // `exited` means the process settled (either way) within the bound, not that it exited cleanly.
    const exited = await boundedBy(processExit.then(() => undefined, () => undefined), closeBoundMs, killGroup).then(() => true, () => false);
    await removePrivate(root);
    // A process still alive after the bound can write under HOME after the removal; sweep again,
    // best-effort, if it exits while this runner is still alive.
    if (!exited) sweepWhenSettled(processExit, root);
  }
  return textTurnResult(input.signal, completed);
}
