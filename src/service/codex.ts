import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHostAdapter } from "@mattsp1290/switchboard/host/codex";
import { z } from "zod";
import { codexSubscriptionEndpoint } from "./accounts.ts";
import { exitGraceMs } from "./codex-subscription.ts";
import { codexExecutable } from "./codex-executable.ts";
import { redact } from "./diagnostics.ts";
import { turnTextBytes } from "./domain.ts";
import { codexAdapterTotal, codexUsage, modelName, type SegmentUsage } from "./usage-capture.ts";

const uuid = z.uuid();
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const bindingSchema = z.strictObject({
  engine: z.string(), nativeVersion: z.string(), account: z.string(),
  authorizedScope: z.string(), nativeFormat: z.string(),
});
const sessionSchema = z.strictObject({
  kind: z.literal("session"), formatVersion: z.literal(1), binding: bindingSchema, opaque: uuid,
});
const fingerprintSchema = z.strictObject({
  kind: z.literal("checkpoint"), formatVersion: z.literal(1), binding: bindingSchema,
  sessionOpaque: z.string(), opaque: z.string(),
});
const legacyCheckpoint = z.strictObject({
  version: z.literal(1), engine: z.literal("codex"),
  state: z.strictObject({ rollout: z.string() }).passthrough(),
});
const checkpointSchema = z.strictObject({
  version: z.literal(1), engine: z.literal("codex"), state: z.strictObject({
    threadId: uuid, nativeId: uuid, memberId: uuid, ownerDigest: z.hash("sha256"), model: z.string(),
    requestId: uuid, session: sessionSchema, fingerprint: fingerprintSchema.nullable(),
    priorTotal: z.record(z.string(), z.unknown()).nullable(),
  }),
});
export type CodexCheckpoint = z.infer<typeof checkpointSchema>;
type OpenedAdapter = Extract<Awaited<ReturnType<typeof codexHostAdapter.open>>, { kind: "ok" }>["value"];
type CodexSegment = Awaited<ReturnType<OpenedAdapter["run"]>>;
export type CodexToolCall = Extract<CodexSegment, { kind: "pending" }>["calls"][number];
export interface CodexHold {
  readonly tool: "record_work_item" | "choose_next_step";
  answer(call: CodexToolCall, signal: AbortSignal): Promise<ReturnType<typeof codexToolContinuation>>;
  delivered?(nativeCallId: string, text: string): void | Promise<void>;
}
interface CodexInput {
  threadId: string; runId: string; text: string; checkpoint: unknown; signal: AbortSignal;
  projectContext?: string;
  onText?: (text: string) => void | Promise<void>;
  onThreadStarted?: (nativeId: string) => void | Promise<void>;
  onToolDelivered?: (nativeCallId: string, text: string) => void | Promise<void>;
  hold?: CodexHold;
}
export interface CodexProfile {
  ownerId: string; memberId: string; stateDir: string; model: string; apiKey?: string; baseUrl?: string;
  authorize?: () => Promise<void>;
  subscription?: () => Promise<{ accessToken: string; accountId: string }>;
  proxyTransport?: (signal: AbortSignal) => Promise<{ baseUrl: string; apiKey: string; close: () => Promise<void> }>;
}

const extension = (data: Readonly<Record<string, unknown>>) =>
  ({ namespace: "codex", schemaVersion: 1, data });

/** The text a host tool returns to the model. `isError` marks a refusal the model can read. */
export function codexToolContinuation(target: CodexToolCall["pending"]["target"], text: string, isError: boolean) {
  const body = extension({ text });
  return {
    formatVersion: 1 as const, kind: "tool" as const,
    outcome: {
      target,
      result: isError ? { kind: "error" as const, error: body } : { kind: "ok" as const, value: body },
      effect: { kind: "known" as const, effect: "none" as const, evidence: extension({}) },
      delivery: { kind: "unknown" as const },
    },
  };
}

/** The host lane declines `request_user_input`. A payload that is not a list of identified questions is refused. */
function declineUserInput(call: CodexToolCall) {
  if (!Array.isArray(call.arguments) || call.arguments.length === 0) throw new Error("Unexpected native Codex tool");
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of call.arguments) {
    if (!question || typeof question !== "object" || !("id" in question) || typeof question.id !== "string" || question.id === "") {
      throw new Error("Unexpected native Codex tool");
    }
    answers[question.id] = { answers: ["No person is attached."] };
  }
  return {
    formatVersion: 1 as const, kind: "tool" as const,
    outcome: {
      target: call.pending.target,
      result: { kind: "ok" as const, value: extension({ answers }) },
      effect: { kind: "known" as const, effect: "none" as const, evidence: extension({}) },
      delivery: { kind: "unknown" as const },
    },
  };
}

export function codexTurnFailure(code: string, message: unknown): Error {
  const failure = new Error("Codex native turn failed");
  const reason = typeof message === "string" ? redact(message, 64) : undefined;
  Object.assign(failure, { code, ...(reason && { reason }) });
  return failure;
}

function canonicalEndpoint(raw: string) {
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected a scoped loopback endpoint");
  }
  return url.href;
}

/** Stable for the life of the native thread. The host adapter refuses a resume whose declarations differ, so a
 * per-turn operation id stays out of the schema and out of the owner text. The approval store binds the id. */
function toolSchema(tool: CodexHold["tool"]): Readonly<Record<string, unknown>> {
  if (tool === "choose_next_step") return { type: "object", additionalProperties: false, properties: {} };
  return {
    type: "object", additionalProperties: false, required: ["operation_id"],
    properties: { operation_id: { type: "string" }, note: { type: "string", maxLength: 4096, description: "At most 4096 UTF-8 bytes." } },
  };
}

export async function runCodexTurn(input: CodexInput, profile: CodexProfile): Promise<{ text: string; checkpoint: CodexCheckpoint; usage: SegmentUsage }> {
  if (!profile.proxyTransport) return executeCodexTurn(input, profile);
  if (profile.subscription) throw new Error("Proxy transport cannot use a subscription");
  const transport = await profile.proxyTransport(input.signal);
  try {
    return await executeCodexTurn(input, { ...profile, baseUrl: transport.baseUrl, apiKey: transport.apiKey, authorize: profile.authorize ?? (async () => {}) });
  } finally { await transport.close(); }
}

/** Publishes the first delta of an assistant item immediately and holds the rest until the item changes. */
function codexTranscript(onText?: (text: string) => void | Promise<void>) {
  let transcript = "", itemId = "", pending = "", opened = false, closed = false;
  const publish = async (text: string) => {
    if (!text) return;
    transcript += text;
    if (Buffer.byteLength(transcript) > 65_536) throw new Error("Codex reply exceeds limit");
    await onText?.(text);
  };
  return {
    async delta(id: string, text: string) {
      if (closed) throw new Error("Codex text arrived after the transcript closed");
      if (id !== itemId) {
        if (opened) await publish(pending);
        itemId = id;
        pending = "";
        opened = false;
      }
      if (!opened) { opened = true; await publish(text); }
      else pending += text;
    },
    async finish() {
      closed = true;
      const tail = pending;
      pending = "";
      await publish(tail);
    },
    text: () => transcript,
  };
}

async function executeCodexTurn(input: CodexInput, profile: CodexProfile): Promise<{ text: string; checkpoint: CodexCheckpoint; usage: SegmentUsage }> {
  input.signal.throwIfAborted();
  const threadId = uuid.parse(input.threadId), requestId = uuid.parse(input.runId), memberId = uuid.parse(profile.memberId);
  const ownerDigest = hash(profile.ownerId);
  if (!isAbsolute(profile.stateDir) || !profile.model || !input.text || Buffer.byteLength(input.text) > turnTextBytes) throw new Error("Invalid Codex member input");
  // The stored envelope stays version 1: domain.checkpointSchema rejects any other version, so a
  // host-adapter turn would never commit. A pre-adapter checkpoint is the one whose state names a rollout.
  if (input.checkpoint !== null && legacyCheckpoint.safeParse(input.checkpoint).success) {
    throw new Error("Codex checkpoint predates the host adapter");
  }
  const prior = input.checkpoint === null ? null : checkpointSchema.parse(input.checkpoint).state;
  if (prior && (prior.threadId !== threadId || prior.memberId !== memberId || prior.ownerDigest !== ownerDigest ||
      prior.model !== profile.model || prior.requestId === requestId || prior.session.opaque !== prior.nativeId)) {
    throw new Error("Codex checkpoint identity mismatch");
  }
  const approved = profile.authorize !== undefined;
  const credentialCount = Number(profile.apiKey !== undefined) + Number(profile.subscription !== undefined);
  if (credentialCount !== Number(approved) || profile.apiKey === "" || (!approved && !profile.baseUrl)) {
    throw new Error("Approved Codex account required");
  }
  if (input.hold && input.hold.tool !== "record_work_item" && input.hold.tool !== "choose_next_step") throw new Error("Invalid Codex tool binding");
  if (!prior) await mkdir(profile.stateDir, { mode: 0o700, recursive: true });
  let parent = await realpath(profile.stateDir);
  for (const part of ["codex", ownerDigest, memberId]) {
    parent = join(parent, part);
    if (!prior) await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent) throw new Error("Invalid Codex member directory");
  }
  const root = join(parent, threadId), home = join(root, "home"), scratch = join(root, "workspace");
  const sqliteHome = join(root, "sqlite"), logDir = join(root, "logs");
  if (!prior) {
    for (const directory of [root, home, scratch, sqliteHome, logDir]) await mkdir(directory, { mode: 0o700 });
  }
  if (await realpath(home) !== home || await realpath(scratch) !== scratch ||
      await realpath(sqliteHome) !== sqliteHome || await realpath(logDir) !== logDir) throw new Error("Invalid Codex storage");
  const ambient = ["auth.json", "config.toml", "mcp.json", "hooks.json", "AGENTS.md", "AGENTS.override.md", "plugins", "rules", "agents", ".codex", ".agents"];
  if ((await readdir(home)).some((name) => ambient.includes(name)) || (await readdir(scratch)).some((name) => ambient.includes(name))) {
    throw new Error("Unexpected Codex configuration in native storage");
  }
  await profile.authorize?.();
  const subscription = await profile.subscription?.();
  if (profile.subscription && (!subscription?.accessToken || !subscription.accountId)) throw new Error("Missing Codex subscription identity");
  input.signal.throwIfAborted();
  const endpoint = canonicalEndpoint(profile.baseUrl ?? (profile.apiKey ? "https://api.openai.com/v1" : codexSubscriptionEndpoint));
  const url = new URL(endpoint);
  const loopbackRelay = url.hostname === "127.0.0.1";
  if (profile.baseUrl && (!loopbackRelay || url.protocol !== "http:" || url.port === "")) throw new Error("Expected a scoped loopback endpoint");
  const form = profile.apiKey || subscription ? "bearer" as const : "none" as const;
  const envKey = subscription ? "BIRBCREW_CODEX_BEARER" : "CODEX_API_KEY";
  const variables: Record<string, string> = {
    HOME: home, CODEX_HOME: home, PATH: "", TMPDIR: home,
    ...(subscription && { BIRBCREW_CODEX_BEARER: subscription.accessToken, BIRBCREW_CODEX_ACCOUNT: subscription.accountId }),
    ...(profile.apiKey && { CODEX_API_KEY: profile.apiKey }),
  };
  const account = ownerDigest;
  const principal = `crew:${form}:${ownerDigest}:${memberId}`;
  const route = {
    config: {
      kind: "host-route" as const, endpoint, protocol: "responses" as const, credentialPurpose: "host-route" as const,
      credentialForm: form, principal, model: profile.model,
      resolve: () => form === "none" ? { purpose: "host-route" as const, form } : {
        purpose: "host-route" as const, form, token: subscription?.accessToken ?? profile.apiKey ?? "",
        ...(subscription && { headers: { "ChatGPT-Account-Id": subscription.accountId } }),
      },
    },
    scope: { engine: "codex", account, adapterInstanceId: "crew", sessionId: threadId },
  };
  const launcher = fileURLToPath(new URL("../../.proof/bin/member-launch", import.meta.url));
  const launched: { child: ChildProcess; processExit: Promise<unknown> }[] = [];
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  let adapter: OpenedAdapter | undefined;
  let subscriptionHandle: ReturnType<OpenedAdapter["events"]["subscribe"]> | undefined;
  try {
    const opened = await codexHostAdapter.open({
      launch: { kind: "spawn", spawn: (request, signal) => {
        const started = borrowLauncher(launcher, request, signal, port, sqliteHome, logDir);
        launched.push(started);
        return { processExit: started.processExit, channel: started.channel };
      } },
      environment: {
        variables,
        nativeConfig: {
          home, cwd: scratch, executable: codexExecutable(), sqliteHome, logDir, providerId: "crew",
          loopbackRelay, sandbox: "read-only",
          ...(form === "bearer" && { envKey, ...(subscription && { headerEnv: { "ChatGPT-Account-Id": "BIRBCREW_CODEX_ACCOUNT" } }) }),
        },
      },
      instructions: "You are a BirbCrew coworker." + (input.projectContext ? "\n" + input.projectContext : ""),
      ...(input.hold && { tools: [{
        name: input.hold.tool,
        description: input.hold.tool === "record_work_item" ? "Ask the owner to record a work item." : "Ask the owner to choose the next step.",
        inputSchema: toolSchema(input.hold.tool),
      }] }),
      builtInTools: ["view_image", "request_user_input"],
      subagents: "off",
      route,
      ...(prior && { resume: { session: prior.session, ...(prior.fingerprint && { expectedHistory: prior.fingerprint }) } }),
    }, input.signal);
    if (opened.kind === "error") throw codexTurnFailure(opened.error.code, opened.error.message);
    adapter = opened.value;
    const answered = new Map<string, string>();
    const observerStop = new AbortController();
    const turnSignal = AbortSignal.any([input.signal, observerStop.signal]);
    const reply = codexTranscript(input.onText);
    let observerError: unknown, observed = Promise.resolve();
    subscriptionHandle = adapter.events.subscribe((event) => {
      observed = observed.then(async () => {
        if (event.kind === "text-delta" && event.text) await reply.delta(event.nativeItemId, event.text);
        if (event.kind !== "tool-delivery") return;
        const text = answered.get(event.target.nativeToolCallId);
        if (text === undefined) return;
        await input.onToolDelivered?.(event.target.nativeToolCallId, text);
        await input.hold?.delivered?.(event.target.nativeToolCallId, text);
      }).catch((error: unknown) => { observerError ??= error; observerStop.abort(); });
    });
    const recordIntent = (_identity: unknown, signal: AbortSignal) => { signal.throwIfAborted(); };
    const failedObserver = () => { if (observerError) throw observerError; };
    if (subscriptionHandle.kind === "ok") {
      void subscriptionHandle.value.ended.then((reason) => {
        if (reason === "overflow" || reason === "listener-error") {
          observerError ??= new Error("Codex event stream ended");
          observerStop.abort();
        }
      });
    }
    if (subscriptionHandle.kind === "error") throw new Error("Codex event subscription failed");
    let segment = await adapter.run({ hostOperationId: requestId, prompt: input.text, recordIntent, signal: turnSignal });
    let announced = false;
    while (segment.kind === "pending" || (segment.kind === "complete" && !announced)) {
      failedObserver();
      if (!announced && (segment.kind === "pending" || segment.kind === "complete")) {
        announced = true;
        if (prior && segment.session.opaque !== prior.nativeId) throw new Error("Unexpected Codex thread identity");
        await input.onThreadStarted?.(segment.session.opaque);
      }
      if (segment.kind !== "pending") break;
      const answers = [];
      for (const call of segment.calls) {
        failedObserver();
        if (call.name === "request_user_input") answers.push(declineUserInput(call));
        else if (input.hold && call.name === input.hold.tool) {
          const answer = await input.hold.answer(call, turnSignal);
          const data = answer.outcome.result.kind === "ok" ? answer.outcome.result.value.data : answer.outcome.result.error.data;
          const text = data && typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text : undefined;
          if (text !== undefined) answered.set(call.pending.target.nativeToolCallId, text);
          answers.push(answer);
        } else throw new Error("Unexpected native Codex tool");
      }
      failedObserver();
      segment = await adapter.continue({ hostOperationId: requestId, answers, recordIntent, signal: turnSignal });
    }
    const whenIdle = async () => {
      let cursor: Promise<void>;
      do {
        cursor = observed;
        await cursor;
      } while (cursor !== observed);
    };
    // finish runs on the subscriber chain. A delta still awaiting onText cannot clear the tail first.
    await whenIdle();
    observed = observed.then(() => reply.finish());
    await whenIdle();
    failedObserver();
    if (segment.kind !== "complete") throw codexTurnFailure(segment.error.code, segment.error.message);
    const text = reply.text();
    if (!text || !text.endsWith(segment.text) || Buffer.byteLength(text) > 65_536) throw new Error("Incomplete native Codex turn");
    const fingerprintApi = adapter.capabilities.fingerprint;
    if (fingerprintApi.kind !== "supported" || fingerprintApi.api.validity !== "segment-end") throw new Error("Codex history fingerprint is unavailable");
    const fingerprint = await fingerprintApi.api.read(turnSignal);
    if (fingerprint.kind === "error") throw codexTurnFailure(fingerprint.error.code, fingerprint.error.message);
    const cumulative = segment.usage.scope === "cumulative" && adapter.capabilities.usage === "cumulative";
    const total = cumulative ? codexAdapterTotal(segment.usage.native.data) : null;
    const baseline = prior && cumulative ? codexAdapterTotal(prior.priorTotal) : null;
    const priorUsage = prior ? (prior.priorTotal === null || baseline === null ? undefined : baseline) : null;
    return {
      text,
      checkpoint: { version: 1, engine: "codex", state: {
        threadId, requestId, nativeId: segment.session.opaque, memberId, ownerDigest, model: profile.model,
        session: segment.session, fingerprint: fingerprint.value, priorTotal: cumulative ? total : null,
      } },
      usage: codexUsage(cumulative ? total : undefined, cumulative ? priorUsage : undefined, modelName.safeParse(profile.model).data ?? null),
    };
  } finally {
    try {
      if (subscriptionHandle?.kind === "ok") subscriptionHandle.value.dispose();
    } finally {
      for (const start of launched) start.child.kill("SIGKILL");
      await Promise.all(launched.map((start) => start.processExit));
      // finish('caller-close') runs reader.close(). The channel grace has to report first.
      if (launched.length > 0) await new Promise((resolve) => setTimeout(resolve, exitGraceMs));
      await adapter?.close();
    }
  }
}

/** Features the previous driver forced off. The host adapter does not emit these, and 0.169.0 defaults the first four on.
 * `web_search` is separate: 0.169.0 defaults an unset mode to Cached. */
export const codexPinnedConfigArgs = [
  "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "features.goals=false",
  "-c", "features.image_generation=false", "-c", "features.code_mode=false",
  "-c", "analytics.enabled=false", "-c", "feedback.enabled=false",
  "-c", "web_search=\"disabled\"",
] as const;

function borrowLauncher(launcher: string, request: { executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> },
  signal: AbortSignal, port: string, sqliteHome: string, logDir: string) {
  if (signal.aborted) throw signal.reason;
  if (request.args[0] !== request.executable || request.args[1] !== "app-server" || request.args[2] !== "--stdio") {
    throw new Error("Unexpected Codex launcher arguments");
  }
  const child = spawn(launcher, [...request.args.slice(1), ...codexPinnedConfigArgs], {
    cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...request.env, BIRBCREW_NATIVE_BINARY: request.executable, BIRBCREW_NATIVE_PARENT: String(process.pid),
      BIRBCREW_NATIVE_WORKSPACE: request.cwd, BIRBCREW_NATIVE_PROVIDER_PORT: port,
      BIRBCREW_NATIVE_SQLITE_HOME: sqliteHome, BIRBCREW_NATIVE_LOG_DIR: logDir,
    },
  });
  const channel = codexProcessChannel(child);
  const stopChild = () => { child.kill("SIGKILL"); };
  const onAbort = () => stopChild();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  child.once("exit", () => signal.removeEventListener("abort", onAbort));
  return {
    child,
    processExit: new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); }),
    channel,
  };
}

/** The stdio channel for one app-server process. Stdin stays open. A descendant that inherited the pipes
 * cannot hold the turn: after exit, unread bytes are kept for `exitGraceMs`, then the pipes are destroyed. */
export function codexProcessChannel(child: ChildProcess) {
  const stdin = child.stdin, stdout = child.stdout, stderr = child.stderr;
  if (!stdin || !stdout || !stderr) throw new Error("The host launcher returned no channel");
  for (const stream of [stdin, stdout, stderr]) stream.on("error", () => {});
  let reported = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let markReported: () => void = () => {};
  const whenReported = new Promise<void>((resolve) => { markReported = resolve; });
  let sink: { ended: (reason: "process-exit") => void } | undefined;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let detach = () => {};
  const report = (releasePipes: boolean) => {
    if (reported || !sink) return;
    reported = true;
    clearTimeout(grace);
    grace = undefined;
    if (releasePipes) {
      stdout.destroy();
      stderr.destroy();
    }
    sink.ended("process-exit");
    markReported();
    detach();
  };
  const armGrace = () => {
    if (reported || grace) return;
    grace = setTimeout(() => report(true), exitGraceMs);
  };
  return {
    listen(next: { data: (bytes: Uint8Array) => void; diagnostic: (bytes: Uint8Array) => void; ended: (reason: "process-exit") => void }) {
      sink = next;
      const onData = (chunk: Buffer) => next.data(chunk);
      const onError = (chunk: Buffer) => next.diagnostic(chunk);
      const onClose = () => report(false);
      stdout.on("data", onData);
      stderr.on("data", onError);
      child.on("exit", armGrace);
      child.on("close", onClose);
      if (exited()) armGrace();
      detach = () => {
        if (!reported) return;
        clearTimeout(grace);
        grace = undefined;
        stdout.off("data", onData);
        stderr.off("data", onError);
        child.off("exit", armGrace);
        child.off("close", onClose);
      };
      return () => detach();
    },
    write(frame: Uint8Array, writeSignal: AbortSignal) {
      if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (failed: boolean, error?: unknown) => {
          if (settled) return;
          settled = true;
          writeSignal.removeEventListener("abort", abort);
          if (failed) reject(error); else resolve();
        };
        // Rejecting before process-exit makes the transport close the reader and drop frames still in the pipe.
        const afterExit = (failed: boolean, error?: unknown) => {
          if (failed && exited() && !reported) {
            armGrace();
            void whenReported.then(() => settle(true, error));
            return;
          }
          settle(failed, error);
        };
        const abort = () => afterExit(true, writeSignal.reason);
        writeSignal.addEventListener("abort", abort, { once: true });
        if (!stdin.writable) {
          afterExit(true, new Error("Codex launcher stdin is closed"));
          return;
        }
        try {
          stdin.write(frame, (error) => afterExit(error != null, error));
        } catch (error) {
          afterExit(true, error);
        }
      });
    },
  };
}
