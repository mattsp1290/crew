import { nativeTranscriptBytes } from "./native-limits.ts";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { codexExecutable } from "./codex-executable.ts";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Codex, type McpToolCallItem, type ThreadEvent } from "@openai/codex-sdk";
import { z } from "zod";
import { codexSubscriptionEndpoint } from "./accounts.ts";
import { redact } from "./diagnostics.ts";
import { turnTextBytes } from "./domain.ts";
import { codexRolloutModel, codexRolloutTotal, codexUsage, type SegmentUsage } from "./usage-capture.ts";

const uuid = z.uuid();
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const checkpointSchema = z.strictObject({
  version: z.literal(1), engine: z.literal("codex"), state: z.strictObject({
    threadId: uuid, nativeId: uuid, memberId: uuid, ownerDigest: z.hash("sha256"), model: z.string(),
    requestId: uuid, rollout: z.string(), bytes: z.int().positive(), sha256: z.hash("sha256"),
  }),
});
export type CodexCheckpoint = z.infer<typeof checkpointSchema>;
interface CodexInput {
  threadId: string; runId: string; text: string; checkpoint: unknown; signal: AbortSignal;
  projectContext?: string;
  onText?: (text: string) => void | Promise<void>;
  onThreadStarted?: (nativeId: string) => void | Promise<void>;
  onToolDelivered?: (text: string) => void | Promise<void>;
  mcp?: { url: string; token: string; tool: "record_work_item" | "choose_next_step" };
}
export interface CodexProfile {
  ownerId: string; memberId: string; stateDir: string; model: string; apiKey?: string; baseUrl?: string;
  authorize?: () => Promise<void>;
  subscription?: () => Promise<{ accessToken: string; accountId: string }>;
  proxyTransport?: (signal: AbortSignal) => Promise<{ baseUrl: string; apiKey: string; close: () => Promise<void> }>;
}

const loopback = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected a scoped loopback endpoint");
  }
  return url;
};
export async function nativeHistory(home: string, scratch: string, nativeId: string, known?: string,
  read?: (lines: readonly string[]) => void) {
  // The CLI places rollout files in sessions/YYYY/MM/DD.
  const filePattern = /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/;
  const index = join(home, "state_5.sqlite");
  if (await realpath(index) !== index || !(await lstat(index)).isFile()) throw new Error("Invalid native thread index");
  const db = new DatabaseSync(index, { readOnly: true });
  let path: string;
  try {
    const row = db.prepare("SELECT rollout_path,cwd FROM threads WHERE id=?").get(nativeId);
    if (!row || row.cwd !== scratch || typeof row.rollout_path !== "string") throw new Error("Native thread is absent");
    path = relative(home, row.rollout_path);
    if (known && path !== known) throw new Error("Codex native thread location changed");
  } finally {
    db.close();
  }
  if (filePattern.exec(path)?.[1] !== nativeId) throw new Error("Invalid native rollout");
  const file = resolve(home, path);
  if (relative(home, file) !== path || await realpath(file) !== file) throw new Error("Invalid native rollout path");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || !stat.size || stat.size > nativeTranscriptBytes) throw new Error("Invalid native rollout file");
  const bytes = await readFile(file);
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  const first = JSON.parse(lines[0]), last = JSON.parse(lines[lines.length - 1]);
  if (first.type !== "session_meta" || first.payload?.id !== nativeId || last.type !== "event_msg" ||
      last.payload?.type !== "task_complete") throw new Error("Codex native turn is incomplete");
  read?.(lines);
  return { rollout: path, bytes: bytes.length, sha256: hash(bytes) };
}

async function delivered(item: McpToolCallItem, input: CodexInput) {
  if (!input.mcp || item.server !== "birbcrew" || item.tool !== input.mcp.tool) throw new Error("Unexpected native Codex tool");
  const content = item.result?.content;
  if (content?.length === 1 && content[0].type === "text") await input.onToolDelivered?.(content[0].text);
}

function codexTurnFailure(event: Extract<ThreadEvent, { type: "error" | "turn.failed" }>): Error {
  const failure = new Error("Codex native turn failed");
  try {
    const code = event.type;
    if (code !== "error" && code !== "turn.failed") return failure;
    const message = code === "error" ? event.message : event.error?.message;
    const reason = typeof message === "string" ? redact(message, 64) : undefined;
    Object.assign(failure, { code, ...(reason && { reason }) });
  } catch {}
  return failure;
}

export async function runCodexTurn(input: CodexInput, profile: CodexProfile): Promise<{ text: string; checkpoint: CodexCheckpoint; usage: SegmentUsage }> {
  if (!profile.proxyTransport) return executeCodexTurn(input, profile);
  if (profile.subscription) throw new Error("Proxy transport cannot use a subscription");
  const transport = await profile.proxyTransport(input.signal);
  try {
    return await executeCodexTurn(input, { ...profile, baseUrl: transport.baseUrl, apiKey: transport.apiKey, authorize: profile.authorize ?? (async () => {}) });
  } finally { await transport.close(); }
}

async function executeCodexTurn(input: CodexInput, profile: CodexProfile): Promise<{ text: string; checkpoint: CodexCheckpoint; usage: SegmentUsage }> {
  input.signal.throwIfAborted();
  const threadId = uuid.parse(input.threadId), requestId = uuid.parse(input.runId), memberId = uuid.parse(profile.memberId);
  const ownerDigest = hash(profile.ownerId);
  if (!isAbsolute(profile.stateDir) || !profile.model || !input.text || Buffer.byteLength(input.text) > turnTextBytes) throw new Error("Invalid Codex member input");
  const provider = profile.baseUrl ? loopback(profile.baseUrl) : undefined;
  const approved = profile.authorize !== undefined;
  const credentialCount = Number(profile.apiKey !== undefined) + Number(profile.subscription !== undefined);
  if (credentialCount !== Number(approved) || profile.apiKey === "" || (!approved && !provider)) {
    throw new Error("Approved Codex account required");
  }
  const endpoint = input.mcp && loopback(input.mcp.url);
  if (input.mcp && (!input.mcp.token || !["record_work_item", "choose_next_step"].includes(input.mcp.tool))) throw new Error("Invalid Codex tool binding");
  const prior = input.checkpoint === null ? null : checkpointSchema.parse(input.checkpoint).state;
  if (prior && (prior.threadId !== threadId || prior.memberId !== memberId || prior.ownerDigest !== ownerDigest ||
      prior.model !== profile.model || prior.requestId === requestId)) throw new Error("Codex checkpoint identity mismatch");
  if (!prior) await mkdir(profile.stateDir, { mode: 0o700, recursive: true });
  let parent = await realpath(profile.stateDir);
  for (const part of ["codex", ownerDigest, memberId]) {
    parent = join(parent, part);
    if (!prior) await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent) throw new Error("Invalid Codex member directory");
  }
  const root = join(parent, threadId), home = join(root, "home"), scratch = join(root, "workspace");
  if (!prior) {
    await mkdir(root, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
  }
  if (await realpath(home) !== home || await realpath(scratch) !== scratch) throw new Error("Invalid Codex storage");
  let priorTotal: ReturnType<typeof codexRolloutTotal> = null;
  if (prior) {
    const saved = await nativeHistory(home, scratch, prior.nativeId, prior.rollout, lines => { priorTotal = codexRolloutTotal(lines); });
    if (saved.sha256 !== prior.sha256 || saved.bytes !== prior.bytes) throw new Error("Codex native history changed");
  }
  // The host owns configuration. Native session files can survive a restart, configuration from disk cannot.
  const ambient = ["auth.json", "config.toml", "mcp.json", "hooks.json", "AGENTS.md", "AGENTS.override.md", "plugins", "rules", "agents", ".codex", ".agents"];
  if ((await readdir(home)).some((name) => ambient.includes(name)) || (await readdir(scratch)).some((name) => ambient.includes(name))) {
    throw new Error("Unexpected Codex configuration in native storage");
  }
  await profile.authorize?.();
  const subscription = await profile.subscription?.();
  if (profile.subscription && (!subscription?.accessToken || !subscription.accountId)) throw new Error("Missing Codex subscription identity");
  input.signal.throwIfAborted();
  const sdk = new Codex({
    codexPathOverride: fileURLToPath(new URL("../../.proof/bin/member-launch", import.meta.url)),
    env: {
      HOME: home, CODEX_HOME: home, PATH: "", TMPDIR: home, BIRBCREW_NATIVE_BINARY: codexExecutable(),
      BIRBCREW_NATIVE_PARENT: String(process.pid), BIRBCREW_NATIVE_WORKSPACE: scratch,
      BIRBCREW_NATIVE_PROVIDER_PORT: provider?.port ?? "443",
      ...(subscription && { BIRBCREW_CODEX_BEARER: subscription.accessToken, BIRBCREW_CODEX_ACCOUNT: subscription.accountId }),
      ...(input.mcp && endpoint && { BIRBCREW_NATIVE_MCP_PORT: endpoint.port, BIRBCREW_MCP_AUTH: input.mcp.token }),
    },
    ...(profile.apiKey && { apiKey: profile.apiKey, baseUrl: provider?.href ?? "https://api.openai.com/v1" }),
    config: {
      ...(subscription && { model_provider: "birbcrew_subscription", model_providers: { birbcrew_subscription: {
        name: "ChatGPT subscription", base_url: provider?.href.replace(/\/$/, "") ?? codexSubscriptionEndpoint,
        wire_api: "responses", env_key: "BIRBCREW_CODEX_BEARER", env_http_headers: { "ChatGPT-Account-Id": "BIRBCREW_CODEX_ACCOUNT" },
        requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
      } } }),
      ...(profile.apiKey && provider && { model_provider: "birbcrew_proxy", model_providers: { birbcrew_proxy: {
        name: "Operator proxy relay", base_url: provider.href.replace(/\/$/, ""),
        wire_api: "responses", env_key: "CODEX_API_KEY", requires_openai_auth: false,
        supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
      } } }),
      ...(!approved && provider && { model_provider: "fixture", model_providers: { fixture: { name: "BirbCrew local fixture",
        base_url: provider.href.replace(/\/$/, ""), wire_api: "responses", requires_openai_auth: false,
        supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } } }),
      features: { plugins: false, apps: false, shell_tool: false, unified_exec: false, shell_snapshot: false, multi_agent: false, multi_agent_v2: false, code_mode: false, goals: false, image_generation: false },
      analytics: { enabled: false }, feedback: { enabled: false },
      developer_instructions: "You are a BirbCrew coworker." + (input.projectContext ? "\n" + input.projectContext : ""),
      ...(input.mcp && endpoint && { mcp_servers: { birbcrew: { url: endpoint.href,
        bearer_token_env_var: "BIRBCREW_MCP_AUTH", enabled_tools: [input.mcp.tool], required: true,
        startup_timeout_sec: 8, tool_timeout_sec: 150, default_tools_approval_mode: "approve" } } }),
    },
  });
  const options = { workingDirectory: scratch, model: profile.model, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", webSearchMode: "disabled" } as const;
  const thread = prior ? sdk.resumeThread(prior.nativeId, options) : sdk.startThread(options);
  let nativeId: string | undefined, completed: { usage: unknown } | undefined, text = "";
  for await (const event of (await thread.runStreamed(input.text, { signal: input.signal })).events) {
    if (event.type === "thread.started") {
      if (nativeId || (prior && event.thread_id !== prior.nativeId)) throw new Error("Unexpected Codex thread identity");
      nativeId = uuid.parse(event.thread_id);
      await input.onThreadStarted?.(nativeId);
    } else if (event.type === "item.completed" && event.item.type === "agent_message") {
      const delta = event.item.text;
      if (Buffer.byteLength(text) + Buffer.byteLength(delta) > 65_536) throw new Error("Codex reply exceeds limit");
      text += delta;
      if (delta) await input.onText?.(delta);
    } else if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
      await delivered(event.item, input);
    } else if (event.type === "turn.completed") completed = event;
    else if (event.type === "error" || event.type === "turn.failed") throw codexTurnFailure(event);
  }
  input.signal.throwIfAborted();
  if (!nativeId || !text || !completed) throw new Error("Incomplete native Codex turn");
  let model: string | null = null;
  const history = await nativeHistory(home, scratch, nativeId, undefined, lines => { model = codexRolloutModel(lines); });
  return { text, checkpoint: { version: 1, engine: "codex", state: {
    threadId, requestId, nativeId, memberId, ownerDigest, model: profile.model, ...history,
  } }, usage: codexUsage(completed.usage, priorTotal, model) };
}
