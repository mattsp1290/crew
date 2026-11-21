import { isAbsolute, resolve } from "node:path";
import { runCodexTurn } from "./codex.ts";
import { runPiTurn, runPiSegment, runPiDelegatingSegment } from "./pi.ts";
import { runClaudeTurn, runClaudeSegment } from "./claude.ts";
import { runCursorTurn } from "./cursor-turn.ts";
import { runOpenCodeTurn } from "./opencode-turn.ts";
import type { MemberProfiles, TurnDriver } from "./activities.ts";
import { ChildTargetError, holdsChildTools, type ChildTarget, type ChildRole } from "./child-target.ts";
import type { ProviderIdentity } from "./provider-identity.ts";
import type { ChildEngine, Engine } from "./domain.ts";
import type { CapabilityInput } from "./capabilities.ts";

const identifierLimit = 1024;

export interface CursorRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly model: string;
}
export interface CursorRuntimeHandle {
  start(request: {
    readonly text: string;
    readonly onEvent: (event: { readonly kind: string; readonly text?: string; readonly outcome?: string }) => void;
  }): Promise<{ readonly agentId: string; readonly finished: Promise<string>; abort(): Promise<void> }>;
  close(): Promise<void>;
}
export interface CursorProfile {
  model: string;
  apiKey: string;
  cwd: string;
  /** Test double. Production profiles omit it, and registration does not store it. */
  runtime?: (options: CursorRuntimeOptions) => CursorRuntimeHandle | Promise<CursorRuntimeHandle>;
}
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
  /** Test double. Production profiles omit it, and registration does not store it. */
  spawn?: (request: OpenCodeSpawnRequest, signal: AbortSignal) => OpenCodeSpawned | Promise<OpenCodeSpawned>;
}

function controlCharacter(value: string, c1: boolean) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (c1 && code >= 127 && code <= 159)) return true;
  }
  return false;
}
function callerModelId(value: string) {
  return value.trim() === value && value.length > 0 && value.length <= 256 && !/\p{Cs}/u.test(value) && !controlCharacter(value, true);
}
function apiKeyText(value: string) {
  return value.trim() === value && value.length > 0 && value.length <= 512 && !controlCharacter(value, false);
}
function identifier(value: string) {
  return value.trim().length > 0 && value.length <= identifierLimit && !controlCharacter(value, true);
}
function resolvedPath(value: string) {
  return isAbsolute(value) && resolve(value) === value;
}
function invalid(name: string, field: string): never {
  throw new Error(`Profile ${JSON.stringify(name)} field ${field} is invalid`);
}

/** Rejects a cursor or opencode profile that cannot be spawned, before a member row exists. */
export function assertTextProfile(name: string, entry: MemberProfile) {
  if (!entry.cursor && !entry.opencode) return;
  for (const field of ["capabilities", "protectedTool", "humanTool", "delegateTask"] as const) {
    if (entry[field] !== undefined) throw new Error(`Profile ${JSON.stringify(name)} refuses ${field}`);
  }
  const cursor = entry.cursor;
  if (cursor) {
    if (!callerModelId(cursor.model)) invalid(name, "cursor.model");
    if (!apiKeyText(cursor.apiKey)) invalid(name, "cursor.apiKey");
    if (!resolvedPath(cursor.cwd)) invalid(name, "cursor.cwd");
  }
  const opencode = entry.opencode;
  if (opencode) {
    if (!callerModelId(opencode.model)) invalid(name, "opencode.model");
    if (!resolvedPath(opencode.executable) || !identifier(opencode.executable)) invalid(name, "opencode.executable");
    if (!resolvedPath(opencode.cwd) || !identifier(opencode.cwd)) invalid(name, "opencode.cwd");
    if (!identifier(opencode.account)) invalid(name, "opencode.account");
    if (opencode.env === null || typeof opencode.env !== "object" || Array.isArray(opencode.env)) invalid(name, "opencode.env");
    for (const value of Object.values(opencode.env)) if (typeof value !== "string") invalid(name, "opencode.env");
  }
}

export interface MemberProfile {
  accountId: string;
  /** The capability ceiling for members of this profile (docs/member-capabilities.md). Absent
   * means none. Set it here, in trusted operator code; no request can. A ceiling with a shell
   * needs a profile from createProxyProfile. No engine offers a capability tool yet. */
  capabilities?: CapabilityInput;
  childTargets?: Readonly<Partial<Record<ChildEngine, Readonly<Partial<Record<ChildRole, ChildTarget>>>>>>;
  upstreamIdentity?: Readonly<Partial<Record<Engine, ProviderIdentity>>>;
  delegateTask?: true;
  humanTool?: "choose_next_step";
  protectedTool?: "record_work_item";
  pi?: Omit<Parameters<typeof runPiTurn>[1], "invocationGroup">;
  codex?: Omit<Parameters<typeof runCodexTurn>[1], "ownerId" | "memberId" | "stateDir">;
  claude?: Omit<Parameters<typeof runClaudeTurn>[1], "ownerId" | "memberId" | "stateDir" | "invocationGroup">;
  cursor?: CursorProfile;
  opencode?: OpenCodeProfile;
}

export function memberProfiles(config: ReadonlyMap<string, MemberProfile>, stateDir: string, invocationGroup?: number): MemberProfiles {
  const profiles = new Map<string, Partial<Record<Engine, TurnDriver>>>();
  for (const [name, { pi, claude, codex, cursor, opencode, protectedTool, delegateTask, humanTool }] of config) {
    const tool = protectedTool ?? humanTool;
    const drivers: Partial<Record<Engine, TurnDriver>> = {};
    if (pi) drivers.pi = async (input) => {
      const member = { ...pi, invocationGroup };
      if (input.childProfile) {
        const child = input.childProfile;
        if (!holdsChildTools(protectedTool, child) || child.model !== pi.model.id) {
          throw new Error("Child profile differs from member");
        }
        const options = { ...member, instructions: child.instructions };
        return child.tools.includes("record_work_item") ? runPiSegment(input, options) :
          { kind: "complete", ...await runPiTurn(input, options) };
      }
      if (delegateTask) return runPiDelegatingSegment(input, { ...member, allowRecordWorkItem: !!protectedTool });
      return tool ? runPiSegment(input, member, tool) : { kind: "complete", ...await runPiTurn(input, member) };
    };
    // Only Pi runs delegated children so far. Refuse one here rather than run it as a member turn.
    if (claude) drivers.claude = async (input, { ownerId, memberId }) => {
      if (input.childProfile) throw new ChildTargetError("unsupported_engine");
      const options = { ...claude, ownerId, memberId, stateDir, invocationGroup };
      return tool ? runClaudeSegment(input, options, tool) : { kind: "complete", ...await runClaudeTurn(input, options) };
    };
    if (cursor) drivers.cursor = (input, member) => runCursorTurn(input, member, cursor, stateDir);
    if (opencode) drivers.opencode = (input, member) => runOpenCodeTurn(input, member, opencode);
    if (codex) drivers.codex = async (input, { ownerId, memberId }) => {
      if (input.childProfile) throw new ChildTargetError("unsupported_engine");
      const turn: Parameters<typeof runCodexTurn>[0] = input;
      if (input.childResults || input.continuation || turn.mcp?.tool !== tool) {
        throw new Error("Codex invocation differs from the member profile");
      }
      return { kind: "complete", ...await runCodexTurn(turn, { ...codex, ownerId, memberId, stateDir }) };
    };
    profiles.set(name, drivers);
  }
  return profiles;
}
