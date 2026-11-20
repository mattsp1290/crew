import { runCodexTurn } from "./codex.ts";
import { runPiTurn, runPiSegment, runPiDelegatingSegment } from "./pi.ts";
import { runClaudeTurn, runClaudeSegment } from "./claude.ts";
import type { MemberProfiles, TurnDriver } from "./activities.ts";
import { ChildTargetError, holdsChildTools, type ChildTarget, type ChildRole } from "./child-target.ts";
import type { ProviderIdentity } from "./provider-identity.ts";
import type { Engine } from "./domain.ts";
import type { CapabilityInput } from "./capabilities.ts";

export interface MemberProfile {
  accountId: string;
  /** The capability ceiling for members of this profile (docs/member-capabilities.md). Absent
   * means none. Set it here, in trusted operator code; no request can. A ceiling with a shell
   * needs a profile from createProxyProfile. No engine offers a capability tool yet. */
  capabilities?: CapabilityInput;
  childTargets?: Readonly<Partial<Record<Engine, Readonly<Partial<Record<ChildRole, ChildTarget>>>>>>;
  upstreamIdentity?: Readonly<Partial<Record<Engine, ProviderIdentity>>>;
  delegateTask?: true;
  humanTool?: "choose_next_step";
  protectedTool?: "record_work_item";
  pi?: Omit<Parameters<typeof runPiTurn>[1], "invocationGroup">;
  codex?: Omit<Parameters<typeof runCodexTurn>[1], "ownerId" | "memberId" | "stateDir">;
  claude?: Omit<Parameters<typeof runClaudeTurn>[1], "ownerId" | "memberId" | "stateDir" | "invocationGroup">;
}

export function memberProfiles(config: ReadonlyMap<string, MemberProfile>, stateDir: string, invocationGroup?: number): MemberProfiles {
  const profiles = new Map<string, Partial<Record<Engine, TurnDriver>>>();
  for (const [name, { pi, claude, codex, protectedTool, delegateTask, humanTool }] of config) {
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
    if (codex) drivers.codex = async (input, { ownerId, memberId }) => {
      if (input.childProfile) throw new ChildTargetError("unsupported_engine");
      const turn: Parameters<typeof runCodexTurn>[0] = input;
      if (input.childResults || input.continuation || turn.hold?.tool !== tool) {
        throw new Error("Codex invocation differs from the member profile");
      }
      return { kind: "complete", ...await runCodexTurn(turn, { ...codex, ownerId, memberId, stateDir }) };
    };
    profiles.set(name, drivers);
  }
  return profiles;
}
