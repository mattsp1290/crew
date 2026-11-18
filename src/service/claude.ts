import { matchesTool, nativeProposal, outcomeSchema, toolNameSchema, type DeferredTool } from "./deferral.ts";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { turnTextBytes } from "./domain.ts";
import { segmentUsage } from "./usage-capture.ts";

const call = z.strictObject({ id: z.string().min(1).max(256), name: z.string(), input: z.record(z.string(), z.json()) });
const binding = z.strictObject({
  profile: z.string(), sessionId: z.uuid(), pending: call.optional(),
  unsupportedPendingTools: z.array(call.extend({ parentToolUseId: z.string().optional() })).optional(),
  frontendTools: z.array(z.strictObject({
    name: z.string(), description: z.string(), parameters: z.record(z.string(), z.json()),
  })).optional(),
});
const nativeCallId = call.shape.id;
const continuation = z.strictObject({
  nativeCallId, result: outcomeSchema,
});

export const claudeCheckpoint = z.strictObject({
  version: z.literal(1),
  engine: z.literal("claude"),
  state: z.strictObject({
    threadId: z.uuid(),
    model: z.string(),
    binding,
    transcriptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export const claudeCommand = z.strictObject({
  threadId: z.uuid(),
  runId: z.uuid(),
  text: z.string().min(1).refine(text => Buffer.byteLength(text) <= turnTextBytes),
  model: z.string().min(1),
  checkpoint: claudeCheckpoint.nullable(),
  projectContext: z.string().max(262_144).optional(),
  mode: z.enum(["chat", "protected", "recover"]),
  tool: toolNameSchema.optional(),
  continuation: continuation.optional(),
});

// usage is absent only from a recovered proposal, which makes no model call.
const success = z.strictObject({ kind: z.literal("complete"), text: z.string().min(1).max(65_536), checkpoint: claudeCheckpoint,
  usage: segmentUsage.optional() });
const pending = z.strictObject({ kind: z.literal("pending"), checkpoint: claudeCheckpoint,
  proposal: nativeProposal, usage: segmentUsage.optional(),
});
const response = z.union([success, pending, z.strictObject({ error: z.string() })]);

interface ClaudeProfile {
  invocationGroup?: number;
  stateDir: string;
  memberId: string;
  ownerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  authorize?: () => Promise<void>;
}

interface ClaudeInput {
  projectContext?: string;
  threadId: string; runId: string; text: string; checkpoint: unknown; signal: AbortSignal;
  continuation?: z.infer<typeof continuation>;
  onToolArgs?: (nativeCallId: string, matchedOperation: boolean) => void;
  onText?: (delta: string) => void;
}

export async function runClaudeTurn(input: ClaudeInput, profile: ClaudeProfile) {
  const result = await executeSegment(input, profile, "chat");
  if (result.kind !== "complete") throw new Error("Unexpected tool proposal in Claude chat");
  return { text: result.text, checkpoint: result.checkpoint, usage: result.usage };
}

export function runClaudeSegment(input: ClaudeInput, profile: ClaudeProfile, tool: DeferredTool = "record_work_item") {
  return executeSegment(input, profile, "protected", tool);
}

export async function recoverClaudeProposal(input: ClaudeInput, profile: ClaudeProfile, tool: DeferredTool = "record_work_item") {
  const recovered = await executeSegment(input, profile, "recover", tool);
  if (recovered.kind !== "pending") throw new Error("No confirmed Claude proposal");
  return recovered;
}

async function executeSegment(
  input: ClaudeInput,
  profile: ClaudeProfile,
  mode: z.infer<typeof claudeCommand>["mode"],
  tool?: DeferredTool,
): Promise<z.infer<typeof success> | z.infer<typeof pending>> {
  const { signal, onText, onToolArgs, ...turn } = input;
  signal.throwIfAborted();
  if (mode !== "recover") await profile.authorize?.();
  signal.throwIfAborted();
  const command = claudeCommand.parse({ ...turn, model: profile.model, mode, tool });
  const savedCall = command.checkpoint?.state.binding.pending;
  if (command.continuation || savedCall) {
    const answer = command.continuation;
    if (mode !== "protected" || !savedCall || !answer || savedCall.id !== answer.nativeCallId ||
        savedCall.id !== answer.result.nativeCallId || savedCall.name !== "mcp__ag_ui__" + tool ||
        !tool || !matchesTool(tool, answer.result, command.runId) ||
        (tool === "record_work_item" && savedCall.input.operation_id !== command.runId)) {
      throw new Error("Claude continuation does not match its pending tool call");
    }
  }
  if (!isAbsolute(profile.stateDir)) throw new Error("Claude state directory must be absolute");
  const member = z.uuid().parse(profile.memberId);
  const owner = createHash("sha256").update(profile.ownerId).digest("hex");
  if (mode !== "recover" && !command.checkpoint) await mkdir(profile.stateDir, { recursive: true, mode: 0o700 });
  const parent = join(await realpath(profile.stateDir), "claude", owner, member);
  const cwd = join(parent, command.threadId);
  if (mode === "recover" || command.checkpoint) {
    if (command.checkpoint && (command.checkpoint.state.threadId !== command.threadId || command.checkpoint.state.model !== profile.model)) {
      throw new Error("Claude checkpoint does not match the conversation profile");
    }
    if (await realpath(cwd) !== cwd) throw new Error("Unexpected Claude session directory");
  } else {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent) throw new Error("Unexpected Claude member directory");
    await mkdir(cwd, { mode: 0o700 });
  }
  const tmp = join(cwd, "tmp");
  if (mode !== "recover") await mkdir(tmp, { recursive: true, mode: 0o700 });
  const child = fork(new URL("./claude-worker.ts", import.meta.url), [], {
    cwd,
    execArgv: [],
    detached: !profile.invocationGroup,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      ...(profile.invocationGroup && { BIRBCREW_INVOCATION_GROUP: String(profile.invocationGroup) }),
      HOME: cwd,
      TMPDIR: tmp,
      CLAUDE_CONFIG_DIR: join(cwd, "config"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      ANTHROPIC_API_KEY: profile.apiKey,
      ANTHROPIC_BASE_URL: profile.baseUrl,
    },
  });
  return new Promise((resolve, reject) => {
    let result: unknown;
    const stop = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(profile.invocationGroup ? child.pid : -child.pid, "SIGKILL"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) reject(error);
        }
      }
    };
    child.once("error", reject);
    child.on("message", (value) => {
      if (value && typeof value === "object" && "delta" in value && typeof value.delta === "string") onText?.(value.delta);
      else if (value && typeof value === "object" && "toolArgs" in value && typeof value.toolArgs === "string") onToolArgs?.(value.toolArgs, "matchedOperation" in value && value.matchedOperation === true);
      else result = value;
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(new Error("Claude turn cancelled"));
      const reply = response.safeParse(result);
      if (code !== 0 || !reply.success) return reject(new Error("Claude worker exited without a result"));
      if ("error" in reply.data) return reject(new Error(reply.data.error));
      resolve(reply.data);
    });
    signal.addEventListener("abort", stop, { once: true });
    child.send(command);
    if (signal.aborted) stop();
  });
}
