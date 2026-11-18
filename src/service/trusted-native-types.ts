import type { PiProfile } from "./pi.ts";
import type { runClaudeTurn } from "./claude.ts";
import type { CodexProfile } from "./codex.ts";
import type { SegmentUsage } from "./usage-capture.ts";

export interface TrustedNativeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  maxArgumentBytes: number;
  maxResultBytes: number;
  deadlineMs: number;
}
export interface TrustedNativeInput {
  engine: "pi" | "claude" | "codex";
  threadId: string;
  runId: string;
  text: string;
  context: string;
  binding: string;
  checkpoint: unknown | null;
  signal: AbortSignal;
  tools: readonly TrustedNativeTool[];
  dispatch(call: {nativeCallId: string; toolName: string; args: unknown; signal: AbortSignal}): Promise<{text: string; isError: boolean}>;
  onText?: (text: string) => void | Promise<void>;
  onToolDelivered?: (call: {nativeCallId: string; toolName: string}) => void | Promise<void>;
}
/** What every trusted driver returns: its reply, its native checkpoint state and what its SDK
 * reported, built by the usage-capture functions, which return `unknown` for anything unusable. */
export interface TrustedNativeResult {
  text: string;
  checkpoint: unknown;
  usage: SegmentUsage;
}
export type TrustedNativeProfile =
  | {engine: "pi"; profile: PiProfile}
  | {engine: "claude"; profile: Parameters<typeof runClaudeTurn>[1]}
  | {engine: "codex"; profile: CodexProfile};
