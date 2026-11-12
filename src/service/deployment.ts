import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import type { MemberProfile } from "./profiles.ts";
import { capabilitySchema, hasCapabilities, includesShell, type CapabilitySet } from "./capabilities.ts";
import { engineSchema, spawnSchema } from "./domain.ts";
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

export async function registerProfiles(pool: Pool, config: ReadonlyMap<string, MemberProfile>, directory: string) {
  const ceilings = new Map([...config].map(([name, entry]) => [name, profileCeiling(name, entry)]));
  const profiles = [...config.values()];
  const volumes = {
    pi: null,
    claude: profiles.some((entry) => entry.claude) ? await nativeVolume(directory) : null,
    codex: profiles.some((entry) => entry.codex) ? await nativeVolume(join(directory, "codex")) : null,
  };
  if (volumes.codex && volumes.codex === volumes.claude) throw new Error("Codex needs its own native state volume");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const [name, entry] of config) {
      spawnSchema.shape.profile.parse(name);
      if (typeof entry.accountId !== "string" || !entry.accountId.trim()) throw new Error("Missing profile account identity");
      const digest = createHash("sha256").update(entry.accountId).digest();
      for (const engine of engineSchema.options) {
        if (!entry[engine]) continue;
        const ceiling = ceilings.get(name);
        const key = [name, engine, digest, volumes[engine], entry.protectedTool ?? null, engine === "pi" && entry.delegateTask === true, entry.humanTool ?? null,
          ceiling ? JSON.stringify(ceiling) : null];
        await db.query(`INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,volume,protected_tool,delegate_task,human_tool,capabilities)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, key);
        const match = await db.query(`SELECT 1 FROM birbcrew_ts.profiles WHERE name=$1 AND engine=$2
                         AND account_digest=$3 AND volume IS NOT DISTINCT FROM $4::uuid AND protected_tool IS NOT DISTINCT FROM $5::text AND delegate_task=$6 AND human_tool IS NOT DISTINCT FROM $7::text
                         AND capabilities IS NOT DISTINCT FROM $8::jsonb`, key);
        if (!match.rowCount) throw new Error("Profile registered for another account or native state volume, or with different tools or capabilities");
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
