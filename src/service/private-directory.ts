import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { DriverInput, DriverResult } from "./activities.ts";
import type { Conversation } from "./domain.ts";

const inheritedEnvironment = new Set([
  "PATH", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
]);

/** Drop runner secrets before a text-engine SDK or child can read process.env or /proc/pid/environ.
 * supervisor-runner scrubs before every text driver; Cursor's defaultRuntime scrubs again right
 * before its SDK import as defense in depth, because that import is what reads the environment. */
export function scrubTextEngineEnvironment() {
  for (const key of Object.keys(process.env)) if (!inheritedEnvironment.has(key)) delete process.env[key];
}

// A worker can leave a directory its host cannot list (mode 0300) or a tree deeper than PATH_MAX, which
// defeat Node's rm. GNU chmod and rm walk with descriptors; the worker has exited and could make no symlinks.
export async function removePrivate(directory: string) {
  try { await rm(directory, { recursive: true, force: true }); return; }
  catch { /* retried below */ }
  const run = promisify(execFile);
  await run("/bin/chmod", ["-R", "u+rwx", "--", directory]).catch(() => undefined);
  await run("/bin/rm", ["-rf", "--one-file-system", "--", directory]);
}

export class TextTurnFailed extends Error {
  constructor() {
    super("Text engine turn failed");
    this.name = "TextTurnFailed";
  }
}

export const textTurnFailed = () => new TextTurnFailed();

/** Refuses what a one-turn text member cannot run, before any filesystem work, and names its
 * private root: <stateDir>/<engine>/<sha256(ownerId)>/<memberId>/<conversationId>. */
export function textTurnRoot(input: DriverInput, member: Conversation, engine: "cursor" | "opencode", stateDir: string) {
  if (input.checkpoint !== null || input.projectContext !== undefined || input.childProfile || input.childResults || input.continuation
    || !isAbsolute(stateDir)) throw textTurnFailed();
  return join(stateDir, engine, createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
}

/** Replaces `root` with fresh 0700 directories: the root, then each named subdirectory. */
export async function preparePrivate(root: string, subdirectories: readonly string[] = []) {
  await removePrivate(root);
  for (const directory of [root, ...subdirectories.map((name) => join(root, name))]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

/** Rejects with TextTurnFailed after `ms`. `onFailure` runs when the work rejects or the bound wins. */
export function boundedBy<T>(work: Promise<T>, ms: number, onFailure: () => void = () => {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(textTurnFailed()), ms);
    timer.unref?.();
  });
  work.catch(() => undefined);
  timeout.catch(() => undefined);
  return Promise.race([work, timeout]).catch((error: unknown) => {
    onFailure();
    throw error instanceof TextTurnFailed ? error : textTurnFailed();
  }).finally(() => { if (timer) clearTimeout(timer); });
}

/** Removes `directory` again once `work` settles, for work that outlived its bound and may still write there. */
export function sweepWhenSettled(work: PromiseLike<unknown>, directory: string) {
  const sweep = () => removePrivate(directory).catch(() => undefined);
  void Promise.resolve(work).then(sweep, sweep);
}

/** A text turn returns only a completed result from a turn whose signal never aborted. */
export function textTurnResult(signal: AbortSignal, result: DriverResult | undefined): DriverResult {
  if (signal.aborted || !result) throw textTurnFailed();
  return result;
}
