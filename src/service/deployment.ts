import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import type { MemberProfile } from "./profiles.ts";
import { capabilitySchema, hasCapabilities, includesShell, type CapabilitySet } from "./capabilities.ts";
import { configuredDestination } from "./provider-identity.ts";
import { childConsentSchema, childRoleSchema, childTargetSchema, holdsChildTools, sameDestination, type ProfileTargetSeal } from "./child-target.ts";
import { fixedRoles } from "@birbcrew/pi-subagents";
import { childEngineSchema, engineSchema, textEngines, type Engine, spawnSchema } from "./domain.ts";
import { promptBytes, requestTextBytesSchema } from "@birbcrew/client/contract";
import { cursorProfileSchema, opencodeProfileSchema } from "./text-profile-validation.ts";
import { usesRelayCredential } from "./proxy-profiles.ts";

async function nativeVolume(directory: string) {
  if (!isAbsolute(directory)) throw new Error("Use an absolute private native state directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const staged = join(directory, `.volume-${id}`);
  const path = join(directory, ".birbcrew-volume");
  await writeFile(staged, id, { flag: "wx", mode: 0o600, flush: true });
  try {
    await link(staged, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    await rm(staged);
  }
  return z.uuid().parse(await readFile(path, "utf8"));
}

/** The canonical ceiling a profile registers, or null for none. A shell runs commands for the
 * model, so a ceiling with one is refused unless every engine of the profile holds only a relay
 * credential: a provider key in the member's environment would be within the shell's reach.
 * The check needs the options createProxyProfile built in this process, so it runs here, in
 * every process that registers profiles before it launches a member, and fails closed. */
function profileCeiling(name: string, entry: MemberProfile): CapabilitySet | null {
  if (entry.capabilities === undefined) return null;
  const ceiling = capabilitySchema.parse(entry.capabilities);
  if (!hasCapabilities(ceiling)) return null;
  if (includesShell(ceiling) && !engineSchema.options.every(engine => !entry[engine] || usesRelayCredential(entry[engine]))) {
    throw new Error(`Profile ${JSON.stringify(name)} has a shell in its capability ceiling, so it must use a relay credential (createProxyProfile)`);
  }
  return ceiling;
}

/** Rejects a cursor or opencode profile that cannot be spawned, before a member row exists. */
function assertTextProfile(name: string, entry: MemberProfile) {
  const hasText = textEngines.some(engine => entry[engine]);
  if (entry.requestTextBytes !== undefined) {
    if (!hasText || !requestTextBytesSchema.safeParse(entry.requestTextBytes).success) {
      throw new Error(`Profile ${JSON.stringify(name)} field requestTextBytes is invalid`);
    }
  }
  if (!hasText) return;
  for (const field of ["pi", "claude", "codex", "childTargets", "capabilities", "protectedTool", "humanTool", "delegateTask"] as const) {
    if (entry[field] !== undefined) throw new Error(`Profile ${JSON.stringify(name)} refuses ${field}`);
  }
  for (const [engine, schema] of [["cursor", cursorProfileSchema], ["opencode", opencodeProfileSchema]] as const) {
    if (!entry[engine]) continue;
    const parsed = schema.safeParse(entry[engine]);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw new Error(`Profile ${JSON.stringify(name)} field ${engine}${field === undefined ? "" : "." + String(field)} is invalid`);
    }
  }
}

export async function registerProfiles(pool: Pool, config: ReadonlyMap<string, MemberProfile>, directory: string) {
  for (const [name, entry] of config) assertTextProfile(name, entry);
  const ceilings = new Map([...config].map(([name, entry]) => [name, profileCeiling(name, entry)]));
  const declarations = new Map<string, ProfileTargetSeal>();
  const roleMap = z.strictObject({ analyst: childTargetSchema.optional(), recorder: childTargetSchema.optional() });
  const configSchema = z.strictObject({ pi: roleMap.optional(), claude: roleMap.optional(), codex: roleMap.optional() });
  for (const [name, profile] of config) {
    const targets = configSchema.parse(profile.childTargets ?? {});
    for (const engine of childEngineSchema.options) {
      const roles = targets[engine];
      if (roles === undefined) continue;
      if (!profile[engine] || (engine === "pi" && !profile.delegateTask)) throw new Error("Child parent engine is unavailable or cannot delegate");
      const resolved: Extract<ProfileTargetSeal, { mode: "named" }> = { mode: "named", roles: {} };
      for (const role of childRoleSchema.options) {
        const route = roles[role];
        if (!route) continue;
        const target = config.get(route.profile);
        if ((engine !== "pi" && role !== "analyst") || (route.engine === "codex" && fixedRoles[role].tools.length)
          || !holdsChildTools(profile.protectedTool, { tools: [...fixedRoles[role].tools] })
          || !target || !holdsChildTools(target.protectedTool, { tools: [...fixedRoles[role].tools] })) {
          throw new Error("Child role exceeds parent or target authority");
        }
        resolved.roles[role] = configuredDestination(config, route);
      }
      declarations.set(JSON.stringify([engine, name]), resolved);
    }
  }
  const profiles = [...config.values()];
  const volumes: Record<Engine, string | null> = {
    pi: null,
    claude: profiles.some((entry) => entry.claude) ? await nativeVolume(directory) : null,
    codex: profiles.some((entry) => entry.codex) ? await nativeVolume(join(directory, "codex")) : null,
    cursor: null,
    opencode: null,
  };
  if (volumes.codex && volumes.codex === volumes.claude) throw new Error("Codex needs its own native state volume");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const active = await db.query("SELECT 1 FROM birbcrew_ts.recovery_control WHERE singleton AND phase='active' FOR SHARE");
    if (!active.rowCount) throw new Error("Installation is held for recovery");
    const keys = [...config].flatMap(([name, entry]) => engineSchema.options.filter(engine => entry[engine]).map(engine => ({ name, engine })));
    keys.sort((a, b) => JSON.stringify([a.engine, a.name]).localeCompare(JSON.stringify([b.engine, b.name])));
    for (const { name, engine } of keys) await db.query("SELECT birbcrew_ts.lock_child_authority($1,$2)", [engine, name]);
    for (const [name, entry] of config) {
      spawnSchema.shape.profile.parse(name);
      if (typeof entry.accountId !== "string" || !entry.accountId.trim()) throw new Error("Missing profile account identity");
      const digest = createHash("sha256").update(entry.accountId).digest();
      for (const engine of engineSchema.options) {
        if (!entry[engine]) continue;
        const ceiling = ceilings.get(name);
        const key = [name, engine, digest, volumes[engine], entry.protectedTool ?? null, engine === "pi" && entry.delegateTask === true, entry.humanTool ?? null,
          ceiling ? JSON.stringify(ceiling) : null, entry.requestTextBytes ?? promptBytes];
        const declaration = declarations.get(JSON.stringify([engine, name]));
        const initial = declaration ?? { mode: "legacy" };
        await db.query(`INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,volume,protected_tool,delegate_task,human_tool,capabilities,request_text_bytes,child_target_seal,child_target_active)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [...key, JSON.stringify(initial), declaration?.mode === "named" ? Object.keys(declaration.roles) : []]);
        const match = await db.query(`SELECT 1 FROM birbcrew_ts.profiles WHERE name=$1 AND engine=$2
                         AND account_digest=$3 AND volume IS NOT DISTINCT FROM $4::uuid AND protected_tool IS NOT DISTINCT FROM $5::text AND delegate_task=$6 AND human_tool IS NOT DISTINCT FROM $7::text
                         AND capabilities IS NOT DISTINCT FROM $8::jsonb AND request_text_bytes=$9`, key);
        if (!match.rowCount) throw new Error(`Profile ${JSON.stringify(name)} registered for another account or native state volume, or with different tools or capabilities or requestTextBytes; use a new profile name in a trusted module`);
        if (declaration?.mode === "named") {
          const { rows: [row] } = await db.query<{ child_target_seal: unknown; child_target_active: string[] }>(
            "SELECT child_target_seal,child_target_active FROM birbcrew_ts.profiles WHERE name=$1 AND engine=$2", [name, engine]);
          const seal = childConsentSchema.parse(row.child_target_seal);
          if (seal.mode !== "named") throw new Error("Legacy profile cannot gain named child authority");
          for (const role of childRoleSchema.options) {
            const target = declaration.roles[role];
            if (target && !sameDestination(target, seal.roles[role])) throw new Error("Child target role or identity cannot change");
          }
          await db.query("UPDATE birbcrew_ts.profiles SET child_target_active=$3 WHERE name=$1 AND engine=$2",
            [name, engine, row.child_target_active.filter(role => Object.hasOwn(declaration.roles, role))]);
        }
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
