import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DriverInput, DriverResult } from "./activities.ts";
import { opencodePromptRejected, turnTextBytes } from "./domain.ts";
import type { Conversation } from "./domain.ts";
import { removePrivate, TextTurnFailed } from "./private-directory.ts";
import type { OpenCodeProfile, OpenCodeSpawnRequest, OpenCodeSpawned } from "./profiles.ts";

const failed = () => new TextTurnFailed();
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
function bounded<T>(work: Promise<T>, kill: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(failed()), closeBoundMs);
    timer.unref?.();
  });
  work.catch(() => undefined);
  timeout.catch(() => undefined);
  return Promise.race([work, timeout]).catch((error: unknown) => {
    kill();
    throw error instanceof TextTurnFailed ? error : failed();
  }).finally(() => { if (timer) clearTimeout(timer); });
}
function spawnProcess(request: OpenCodeSpawnRequest, signal: AbortSignal, home: string, tmp: string, assignKill: (kill: () => void) => void, _invocationGroup?: number): OpenCodeSpawned {
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
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const target = -child.pid;
    try { process.kill(target, "SIGKILL"); }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ESRCH") {
        try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
        catch { return; }
      }
    }
    closing = true;
  };
  assignKill(stop);
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
        child.stdin?.end();
        stop();
      },
    },
  };
}

/** One OpenCode ACP turn. The spawn environment is the profile map, and the argv is `[executable, "acp"]`. */
export async function runOpenCodeTurn(input: DriverInput, member: Conversation, profile: OpenCodeProfile, stateDir: string, invocationGroup?: number): Promise<DriverResult> {
  if (input.checkpoint !== null || input.projectContext !== undefined || input.childProfile || input.childResults || input.continuation || !promptAllowed(input.text)) throw failed();
  const root = join(stateDir, "opencode", createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  await removePrivate(root);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(tmp, 0o700);
  let killGroup = () => {};
  let completed: DriverResult | undefined;
  const { opencodeHostAdapter } = await import("@mattsp1290/switchboard/host/opencode");
  try {
  const opened = await opencodeHostAdapter.open({
    model: profile.model,
    environment: { variables: { ...profile.env }, nativeConfig: { cwd: profile.cwd, executable: profile.executable, account: profile.account } },
    launch: {
      kind: "spawn",
      spawn: (request, signal) => {
        const args = [...request.args];
        if (args.length !== 2 || args[0] !== profile.executable || args[1] !== "acp" || request.cwd !== profile.cwd
          || !sameEnvironment(request.env, profile.env)) throw failed();
        return profile.spawn ? profile.spawn(request, signal) : spawnProcess(request, signal, home, tmp, (kill) => { killGroup = kill; }, invocationGroup);
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
    await bounded(adapter.close(), killGroup).catch(() => undefined);
    killGroup();
    const text = result.kind === "complete" ? result.text : "";
    if (input.signal.aborted || result.kind !== "complete" || text.length === 0 || Buffer.byteLength(text) > turnTextBytes) throw failed();
    completed = {
      kind: "complete", text,
      checkpoint: {
        version: 1, engine: "opencode",
        state: { model: profile.model, cwd: profile.cwd, executable: profile.executable, account: profile.account, session: result.session },
      },
    };
  } catch (error) {
    await bounded(adapter.close().then(() => undefined, () => undefined), killGroup).catch(() => undefined);
    killGroup();
    if (error instanceof TextTurnFailed) throw error;
    throw failed();
  } finally {
    if (subscription.kind === "ok") subscription.value.dispose();
  }
  } finally {
    killGroup();
    await removePrivate(root);
  }
  if (input.signal.aborted || !completed) throw failed();
  return completed;
}
