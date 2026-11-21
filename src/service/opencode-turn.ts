import { spawn } from "node:child_process";
import type { DriverInput, DriverResult } from "./activities.ts";
import { opencodePromptRejected, turnTextBytes } from "./domain.ts";
import type { Conversation } from "./domain.ts";
import type { OpenCodeProfile, OpenCodeSpawnRequest, OpenCodeSpawned } from "./profiles.ts";

const failed = () => new Error("Text engine turn failed");
const maxPrompt = 1_048_576;

function promptAllowed(value: string) {
  return value.length >= 1 && Buffer.byteLength(value) <= maxPrompt && !opencodePromptRejected(value);
}
function sameEnvironment(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
function spawnProcess(request: OpenCodeSpawnRequest, signal: AbortSignal): OpenCodeSpawned {
  const child = spawn(request.args[0], request.args.slice(1), {
    cwd: request.cwd, env: { ...request.env }, stdio: ["pipe", "pipe", "pipe"],
  });
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
    closing = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
        if (signal.aborted) return Promise.reject(failed());
        return new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(failed());
          signal.addEventListener("abort", onAbort, { once: true });
          child.stdin?.write(frame, (error) => {
            signal.removeEventListener("abort", onAbort);
            if (error) reject(failed());
            else resolve();
          });
        });
      },
      endInput() {
        closing = true;
        child.stdin?.end();
        stop();
      },
    },
  };
}

/** One OpenCode ACP turn. The spawn environment is the profile map, and the argv is `[executable, "acp"]`. */
export async function runOpenCodeTurn(input: DriverInput, _member: Conversation, profile: OpenCodeProfile): Promise<DriverResult> {
  if (input.checkpoint !== null || input.projectContext !== undefined || input.childProfile || input.childResults || input.continuation || !promptAllowed(input.text)) throw failed();
  const { opencodeHostAdapter } = await import("@mattsp1290/switchboard/host/opencode");
  const opened = await opencodeHostAdapter.open({
    model: profile.model,
    environment: { variables: { ...profile.env }, nativeConfig: { cwd: profile.cwd, executable: profile.executable, account: profile.account } },
    launch: {
      kind: "spawn",
      spawn: (request, signal) => {
        const args = [...request.args];
        if (args.length !== 2 || args[0] !== profile.executable || args[1] !== "acp" || request.cwd !== profile.cwd
          || !sameEnvironment(request.env, profile.env)) throw failed();
        return (profile.spawn ?? spawnProcess)(request, signal);
      },
    },
  }, input.signal);
  if (opened.kind !== "ok") throw failed();
  const adapter = opened.value;
  const subscription = adapter.events.subscribe((event) => {
    if (event.kind === "text-delta") void input.onText?.(event.text);
  });
  try {
    const result = await adapter.run({
      prompt: input.text, signal: input.signal, hostOperationId: input.runId, recordIntent: async () => undefined,
    });
    const closed = await adapter.close();
    const text = result.kind === "complete" ? result.text : "";
    if (result.kind !== "complete" || text.length === 0 || Buffer.byteLength(text) > turnTextBytes || closed.kind !== "ok") throw failed();
    return {
      kind: "complete", text,
      checkpoint: {
        version: 1, engine: "opencode",
        state: { model: profile.model, cwd: profile.cwd, executable: profile.executable, account: profile.account, session: result.session },
      },
    };
  } catch (error) {
    await adapter.close().catch(() => undefined);
    if (error instanceof Error && error.message === "Text engine turn failed") throw error;
    throw failed();
  } finally {
    if (subscription.kind === "ok") subscription.value.dispose();
  }
}
