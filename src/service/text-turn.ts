import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { DriverInput, DriverResult } from "./activities.ts";
import type { Conversation, TextEngine } from "./domain.ts";

// The one-turn text-member turn protocol shared by cursor-turn.ts and opencode-turn.ts. The private
// directory lifecycle it relies on stays in private-directory.ts.

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

export class TextTurnFailed extends Error {
  constructor() {
    super("Text engine turn failed");
    this.name = "TextTurnFailed";
  }
}

export const textTurnFailed = () => new TextTurnFailed();

/** Refuses what every one-turn text member cannot run, before any filesystem work, and names its
 * private root: <stateDir>/<engine>/<sha256(ownerId)>/<memberId>/<conversationId>. An engine may refuse
 * more before calling it (OpenCode checks its prompt first); this is not the whole pre-filesystem gate. */
export function textTurnRoot(input: DriverInput, member: Conversation, engine: TextEngine, stateDir: string) {
  if (input.checkpoint !== null || input.projectContext !== undefined || input.childProfile || input.childResults || input.continuation
    || !isAbsolute(stateDir)) throw textTurnFailed();
  return join(stateDir, engine, createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
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

/** A text turn returns only a completed result from a turn whose signal never aborted. */
export function textTurnResult(signal: AbortSignal, result: DriverResult | undefined): DriverResult {
  if (signal.aborted || !result) throw textTurnFailed();
  return result;
}
