import { z } from "zod";
import { canonicalDigest, hasProtoKey } from "./canonical-json.ts";
import { spawnSchema, type Member } from "./domain.ts";
import { hostPatternSchema, patternCovers, type HostPattern } from "./hosts.ts";

/** Member capabilities (docs/member-capabilities.md). A capability set says which Crew tools a
 * member may be offered. The operator's profile holds a ceiling; an owner may ask for a set
 * within it at spawn; the member keeps that set for life. No set means no capabilities. Every
 * rule about what one set allows inside another lives in this module.
 *
 * Nothing here runs a tool, and no engine offers one yet. */
export const capabilityLimits = { hostPatterns: 32 } as const;

export type ShellNetwork = "off" | "proxied";
/** A shell lives only in a writable workspace: it can write anything there, so a read-only
 * workspace with a shell would be a false promise. */
export type Workspace = { files: "read" } | { files: "write"; shell?: { network: ShellNetwork } };
export interface CapabilitySet {
  version: 1;
  /** fs_read, fs_list and fs_search; `write` adds fs_write and fs_edit; `shell` adds shell_run. */
  workspace?: Workspace;
  /** web_fetch, to any host or only to hosts a pattern matches (hosts.ts). */
  webFetch?: { hosts: "any" | HostPattern[] };
  /** web_search. */
  webSearch?: Record<string, never>;
}

const shell = z.strictObject({ network: z.enum(["off", "proxied"]) });
const workspace = z.discriminatedUnion("files", [
  z.strictObject({ files: z.literal("read"),
    shell: z.never({ error: 'A shell needs a writable workspace: set files to "write"' }).optional() }),
  z.strictObject({ files: z.literal("write"), shell: shell.optional() }),
]);
const hosts = z.union([z.literal("any"), z.array(hostPatternSchema).min(1).max(capabilityLimits.hostPatterns)]);
const shape = z.strictObject({
  version: z.literal(1),
  workspace: workspace.optional(),
  webFetch: z.strictObject({ hosts }).optional(),
  webSearch: z.strictObject({}).optional(),
});

// Rebuilt key by key so the result holds only the keys above, never one set to undefined, with
// host patterns in one order: equal sets then have equal JSON and one digest.
function canonicalSet(set: z.output<typeof shape>): CapabilitySet {
  return {
    version: 1,
    ...(set.workspace && { workspace: set.workspace.files === "write"
      ? { files: "write", ...(set.workspace.shell && { shell: { network: set.workspace.shell.network } }) }
      : { files: "read" } }),
    ...(set.webFetch && { webFetch: { hosts: set.webFetch.hosts === "any" ? "any" : [...new Set(set.webFetch.hosts)].sort() } }),
    ...(set.webSearch && { webSearch: {} }),
  };
}

/** Parses what an operator or an owner wrote into the canonical set. A set is at most three
 * levels deep, so the `__proto__` check reaches every key the schema could accept. */
export const capabilitySchema = z.custom<z.input<typeof shape>>(value => !hasProtoKey(value), { message: "Unknown key __proto__" })
  .pipe(shape).transform(canonicalSet);
export type CapabilityInput = z.input<typeof capabilitySchema>;

/** A spawn request. `capabilities` asks for a set within the profile's ceiling; absent, or a
 * set with no capability, gives the member none. Kept out of domain.ts, which the Temporal
 * workflow bundle includes: this module reaches node:crypto. */
export const spawnRequestSchema = spawnSchema.extend({ capabilities: capabilitySchema.optional() });
/** A member as spawn and the member listing report it: `capabilities` only when it has some. */
export type SpawnedMember = Member & { capabilities?: CapabilitySet };

export function hasCapabilities(set: CapabilitySet | null | undefined): set is CapabilitySet {
  return !!set && (set.workspace !== undefined || set.webFetch !== undefined || set.webSearch !== undefined);
}

export function includesShell(set: CapabilitySet | null | undefined): boolean {
  return set?.workspace?.files === "write" && set.workspace.shell !== undefined;
}

const networkRank: Record<ShellNetwork, number> = { off: 0, proxied: 1 };

function workspaceWithin(requested: Workspace | undefined, ceiling: Workspace | undefined): boolean {
  if (!requested) return true;
  if (!ceiling) return false;
  if (requested.files === "read") return true;
  if (ceiling.files !== "write") return false;
  if (!requested.shell) return true;
  return ceiling.shell !== undefined && networkRank[requested.shell.network] <= networkRank[ceiling.shell.network];
}

function fetchWithin(requested: CapabilitySet["webFetch"], ceiling: CapabilitySet["webFetch"]): boolean {
  if (!requested) return true;
  if (!ceiling) return false;
  const allowed = ceiling.hosts;
  if (allowed === "any") return true;
  if (requested.hosts === "any") return false;
  return requested.hosts.every(inner => allowed.some(outer => patternCovers(outer, inner)));
}

/** Whether everything `requested` allows, `ceiling` allows too. No ceiling allows nothing. */
export function capabilitiesWithin(requested: CapabilitySet, ceiling: CapabilitySet | null): boolean {
  return workspaceWithin(requested.workspace, ceiling?.workspace)
    && fetchWithin(requested.webFetch, ceiling?.webFetch)
    && (!requested.webSearch || ceiling?.webSearch !== undefined);
}

/** The same for every way of writing one set: key order, host order, case and repeated
 * patterns do not change it. Two sets that list different patterns for the same hosts are
 * different sets. */
export function capabilityDigest(set: CapabilitySet): string {
  return canonicalDigest(canonicalSet(set));
}

/** A set as stored in PostgreSQL. One this release cannot read (after a rollback) is a server
 * fault, never an empty set. */
export function storedCapabilities(value: unknown): CapabilitySet | null {
  if (value === null || value === undefined) return null;
  const parsed = capabilitySchema.safeParse(value);
  if (!parsed.success || !hasCapabilities(parsed.data)) throw new Error("Unknown stored capabilities");
  return parsed.data;
}

/** A spawn asked for more than its profile's ceiling allows. The caller's mistake: HTTP 400. */
export class CapabilityCeilingError extends Error {
  constructor() {
    super("capabilities_exceed_profile");
    this.name = "CapabilityCeilingError";
  }
}

/** The `memberCapabilities` entry of GET /v1/capabilities. */
export const capabilityReport = {
  version: 1, spawnField: "capabilities", memberField: "capabilities", auditField: "capabilityDigest",
  default: "none", ceiling: "operator-profile", fixedAtSpawn: true,
  kinds: ["workspace", "webFetch", "webSearch"], workspaceFiles: ["read", "write"], shellNetwork: ["off", "proxied"],
  maximumHostPatterns: capabilityLimits.hostPatterns,
  toolExecution: "not-implemented",
} as const;
