import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { codexExecutable } from "./codex-executable.ts";
import { redact, warn } from "./diagnostics.ts";

const envelope = z.object({ id: z.number().optional(), result: z.unknown().optional() });
const status = z.object({ authMethod: z.literal("chatgpt"), requiresOpenaiAuth: z.literal(true), authToken: z.string().min(1) });
const claims = z.object({
  exp: z.number().int().positive(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
});

type Subscription = { accessToken: string; accountId: string };
const reads = new Map<string, Promise<Subscription>>();
const signInRequired = "A current ChatGPT Codex sign-in for the approved account is required";
const loginBytes = 1 << 20;
const scratchPrefix = "birb-codex-signin-";
const readDeadlineMs = 25_000;
// A descendant that inherited app-server's pipes keeps them open. The read waits this long for their end, then stops.
const exitGraceMs = 500;
const stderrChars = 8192;
// Every read ends within its deadline, so an older scratch directory belongs to a reader that was killed.
const abandonedScratchMs = 5 * 60_000;
// Codex refreshes an access token that expires within minutes, even when asked not to. The executor owns rotation.
const closedRefreshEndpoint = "http://127.0.0.1:0/oauth/token";

/** What a test replaces. A member turn reads with the bundled Codex, the closed refresh endpoint and the full deadline. */
export interface ReadOptions { binary?: string; refreshEndpoint?: string; deadlineMs?: number }

export type SignInFailure = "login-file" | "scratch" | "start" | "exited" | "timeout" | "protocol" | "signed-out" | "token" | "expired" | "account";

/** Every reason has the same message. The reason is logged and kept on the error. */
export class CodexSignInError extends Error {
  readonly reason: SignInFailure;
  constructor(reason: SignInFailure) {
    super(signInRequired);
    this.name = "CodexSignInError";
    this.reason = reason;
  }
}

function failed(reason: SignInFailure, details: Record<string, string | number | undefined> = {}): never {
  warn("codex_signin_unavailable", { reason, ...details });
  throw new CodexSignInError(reason);
}

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
};

export async function readCodexSubscription(codexHome: string, expectedAccountId?: string): Promise<Subscription> {
  if (!isAbsolute(codexHome) || !(await stat(codexHome)).isDirectory()) throw new Error("Select an existing absolute Codex sign-in home");
  const home = await realpath(codexHome);
  let current = reads.get(home);
  if (!current) {
    current = readLogin(home).finally(() => reads.delete(home));
    reads.set(home, current);
  }
  const subscription = await current;
  if (expectedAccountId !== undefined && subscription.accountId !== expectedAccountId) failed("account");
  return subscription;
}

// The executor's Codex is the only writer of the shared login and owns refresh-token rotation, and the member worker
// mounts it read-only. App-server creates installation_id and skills in its CODEX_HOME at startup and stops when it
// cannot, so it runs on a private copy of auth.json that has no refresh token. Only the current access token crosses
// its stdio channel.
export async function readLogin(codexHome: string, options: ReadOptions = {}): Promise<Subscription> {
  const { binary = codexExecutable(), refreshEndpoint = closedRefreshEndpoint, deadlineMs = readDeadlineMs } = options;
  await removeAbandonedScratch();
  const file = join(codexHome, "auth.json");
  let login: Buffer | undefined;
  try {
    if ((await stat(file)).size <= loginBytes) login = await readFile(file);
  } catch (error) {
    failed("login-file", { code: errorCode(error) });
  }
  if (!login || login.length > loginBytes) failed("login-file", { code: "too large" });
  const copy = signInCopy(login);
  let scratch: string;
  try {
    scratch = await mkdtemp(join(tmpdir(), scratchPrefix));
  } catch (error) {
    failed("scratch", { code: errorCode(error) });
  }
  try {
    try {
      await writeFile(join(scratch, "auth.json"), copy, { mode: 0o600, flag: "wx" });
    } catch (error) {
      failed("scratch", { code: errorCode(error) });
    }
    return await askAppServer(binary, scratch, refreshEndpoint, deadlineMs);
  } finally {
    // The next read sweeps a copy that could not be removed now.
    await rm(scratch, { recursive: true, force: true })
      .catch((error) => warn("codex_signin_copy_left", { code: errorCode(error) }));
  }
}

/** The login that app-server reads. It is the shared auth.json with its refresh token blanked. */
export function signInCopy(login: Buffer) {
  let value: unknown;
  // A parse error quotes the file, and the file holds tokens.
  try { value = JSON.parse(login.toString("utf8")); } catch { failed("login-file", { code: "not JSON" }); }
  const tokens = typeof value === "object" && value !== null && "tokens" in value ? value.tokens : undefined;
  if (typeof tokens === "object" && tokens !== null && "refresh_token" in tokens && typeof tokens.refresh_token === "string") {
    tokens.refresh_token = "";
  }
  return JSON.stringify(value);
}

async function removeAbandonedScratch() {
  const root = tmpdir();
  const names = await readdir(root).catch(() => []);
  await Promise.all(names.filter((name) => name.startsWith(scratchPrefix)).map(async (name) => {
    const path = join(root, name);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isDirectory() && info.uid === process.getuid?.() && Date.now() - info.mtimeMs > abandonedScratchMs) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }));
}

async function askAppServer(binary: string, scratch: string, refreshEndpoint: string, deadlineMs: number): Promise<Subscription> {
  // App-server normally fetches a catalog at startup. This process only handles sign-in.
  const child = spawn(binary, ["app-server", "--listen", "stdio://",
    "-c", 'model_provider="openai"', "-c", 'chatgpt_base_url="http://127.0.0.1:0"', "-c", 'cli_auth_credentials_store="file"',
    "-c", "log_dir=" + JSON.stringify(scratch), "-c", "analytics.enabled=false"], {
    cwd: scratch,
    env: {
      HOME: scratch, CODEX_HOME: scratch, CODEX_SQLITE_HOME: scratch, CODEX_REFRESH_TOKEN_URL_OVERRIDE: refreshEndpoint,
      PATH: "/usr/local/bin:/usr/bin:/bin", RUST_LOG: "off",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stopReading = () => {};
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: unknown }>((resolve) => {
    child.once("error", (error) => { stopReading(); resolve({ code: null, signal: null, error }); });
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("exit", (code, signal) => setTimeout(() => {
      stopReading();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, signal });
    }, exitGraceMs).unref());
  });
  // A spawn that fails for lack of descriptors leaves no pipes and reports its error afterwards.
  if (!child.stdin || !child.stdout || !child.stderr) failed("start", { code: errorCode((await ended).error) });
  const lines = createInterface({ input: child.stdout });
  stopReading = () => lines.close();
  let stderr = "", clipped = false;
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
    if (stderr.length > stderrChars) {
      stderr = stderr.slice(-stderrChars);
      clipped = true;
    }
  });
  // The clip can leave the end of a token that no longer looks like one, so the clipped word is dropped.
  const output = () => redact(clipped ? stderr.replace(/^\S*/, "") : stderr, 512, "end") || undefined;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; lines.close(); child.kill("SIGKILL"); }, deadlineMs);
  child.stdin.on("error", () => {});
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  let answer: { result?: unknown } | undefined;
  try {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "birbcrew", version: "1" } } });
    for await (const line of lines) {
      let response: z.infer<typeof envelope>;
      // A parse error quotes the line, and the line can hold the token.
      try { response = envelope.parse(JSON.parse(line)); } catch (error) { failed("protocol", { error: errorCode(error), stderr: output() }); }
      if (response.id === 1) {
        if (!response.result) failed("protocol", { error: "initialize refused", stderr: output() });
        send({ method: "initialized" });
        send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken: false } });
      }
      if (response.id === 2) {
        if (response.result === undefined) failed("protocol", { error: "status refused", stderr: output() });
        answer = response;
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.destroy();
    child.kill("SIGKILL");
    await ended;
  }
  if (!answer) {
    const exit = await ended;
    if (exit.error) failed("start", { code: errorCode(exit.error) });
    if (timedOut) failed("timeout", { stderr: output() });
    failed("exited", { exitCode: exit.code ?? undefined, signal: exit.signal ?? undefined, stderr: output() });
  }
  const signedIn = status.safeParse(answer.result);
  if (!signedIn.success) {
    const method = z.object({ authMethod: z.string().regex(/^[A-Za-z]{1,32}$/) }).safeParse(answer.result);
    failed("signed-out", { authMethod: method.success ? method.data.authMethod : "none", stderr: output() });
  }
  const token = signedIn.data.authToken;
  const parts = token.split(".");
  if (parts.length !== 3) failed("token", { stderr: output() });
  let parsed: z.infer<typeof claims>;
  // Claim errors can quote claim values.
  try { parsed = claims.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))); } catch { failed("token", { stderr: output() }); }
  if (parsed.exp * 1000 <= Date.now()) failed("expired", { expiredAt: new Date(parsed.exp * 1000).toISOString() });
  return { accessToken: token, accountId: parsed["https://api.openai.com/auth"].chatgpt_account_id };
}
