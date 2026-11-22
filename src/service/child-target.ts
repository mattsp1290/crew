import { fixedRoles, type Delegation } from "@birbcrew/pi-subagents";
import { z } from "zod";
import { childEngineSchema, spawnSchema, type Engine } from "./domain.ts";

export const childRoleSchema = z.enum(["analyst", "recorder"]);
export type ChildRole = z.infer<typeof childRoleSchema>;
export const childTargetSchema = z.strictObject({ engine: childEngineSchema, profile: spawnSchema.shape.profile });
export type ChildTarget = z.infer<typeof childTargetSchema>;
export const destinationSchema = childTargetSchema.extend({
  model: z.string().min(1).max(256), providerHost: z.string().min(1).max(512), accountDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const sealedTargetSchema = destinationSchema.extend({ version: z.literal(1) });
export type SealedTarget = z.infer<typeof sealedTargetSchema>;
const rolesSchema = z.strictObject({ analyst: destinationSchema.optional(), recorder: destinationSchema.optional() });
export const childConsentSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("legacy") }), z.strictObject({ mode: z.literal("named"), roles: rolesSchema }),
]);
export type MemberChildConsent = z.infer<typeof childConsentSchema>;
export type ProfileTargetSeal = MemberChildConsent;
export type ChildProfile = Delegation["profile"] & { target?: ChildTarget | SealedTarget };
export type MemberSubagents = { mode: MemberChildConsent["mode"]; targets: (z.infer<typeof destinationSchema> & {
  role: ChildRole; availability: "executable" | "unsupported_engine" | "removed";
})[] };
export class ChildTargetError extends Error {
  readonly code: "invalid_target" | "unsupported_engine" | "ineligible_target";
  constructor(code: ChildTargetError["code"]) {
    super(`Child target refused: ${code}`);
    this.name = "ChildTargetError";
    this.code = code;
  }
}
export function hasChildDriver(engine: Engine) { return engine === "pi"; }
export function childTarget(target: ChildTarget | undefined, parentProfile: string): ChildTarget {
  return target ? { engine: target.engine, profile: target.profile } : { engine: "pi", profile: parentProfile };
}
export function storedTarget(value: unknown): SealedTarget | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = sealedTargetSchema.safeParse(value);
  if (!parsed.success) throw new ChildTargetError("invalid_target");
  return parsed.data;
}
export function keyTarget(value: unknown): ChildTarget | undefined {
  const parsed = z.union([sealedTargetSchema, childTargetSchema]).safeParse(value);
  return parsed.success ? { engine: parsed.data.engine, profile: parsed.data.profile } : undefined;
}
export function holdsChildTools(protectedTool: string | null | undefined, child: Pick<ChildProfile, "tools">) {
  return child.tools.every(tool => tool === protectedTool);
}
const proposalSchema = z.strictObject({
  nativeCallId: z.string().min(1).max(256), task: z.string().min(1).max(4096),
  profile: z.strictObject({ role: childRoleSchema, version: z.literal(1), instructions: z.string(),
    model: z.string().min(1).max(256), tools: z.array(z.literal("record_work_item")).max(1) }),
});
export function fixedProposal(raw: unknown): Delegation {
  const proposal = proposalSchema.parse(raw);
  const fixed = fixedRoles[proposal.profile.role];
  if (proposal.profile.instructions !== fixed.instructions || JSON.stringify(proposal.profile.tools) !== JSON.stringify(fixed.tools)) {
    throw new ChildTargetError("invalid_target");
  }
  return { ...proposal, profile: { ...proposal.profile, instructions: fixed.instructions } };
}
export function memberSubagents(engine: Engine, rawConsent: unknown, rawSeal: unknown, active: string[] | null): MemberSubagents {
  const consent = childConsentSchema.parse(rawConsent);
  if (consent.mode === "legacy") return { mode: "legacy", targets: [] };
  const seal = childConsentSchema.parse(rawSeal);
  return { mode: "named", targets: childRoleSchema.options.flatMap(role => {
    const destination = consent.roles[role];
    if (!destination) return [];
    const allowed = seal.mode === "named" && active?.includes(role) && sameDestination(destination, seal.roles[role]);
    return [{ ...destination, role, availability: !allowed ? "removed" : engine === "pi" && destination.engine === "pi" ? "executable" : "unsupported_engine" }];
  }) };
}
export function sameDestination(a: z.infer<typeof destinationSchema>, b: z.infer<typeof destinationSchema> | undefined) {
  return b !== undefined && a.engine === b.engine && a.profile === b.profile && a.model === b.model && a.providerHost === b.providerHost && a.accountDigest === b.accountDigest;
}
