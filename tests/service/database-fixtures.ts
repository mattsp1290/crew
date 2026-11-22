import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { appendAudit } from "../../src/service/audit.ts";
import type { Engine } from "../../src/service/domain.ts";
import type { MemberStore } from "../../src/service/store.ts";

export function testDatabaseName(defaultPrefix: string) {
  const prefix = process.env.BIRBCREW_TEST_DATABASE_PREFIX ?? defaultPrefix;
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error("Invalid test database prefix");
  return prefix + randomUUID().replaceAll("-", "");
}

export async function migrateThrough(store: MemberStore, version: number) {
  const directory = new URL("../../src/service/sql/", import.meta.url);
  await store.transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('birbcrew_ts.migration',0))");
    for (const file of (await readdir(directory)).sort()) {
      const next = Number(file.slice(0, 3));
      if (next > version || (await db.query("SELECT 1 FROM birbcrew_ts.schema_versions WHERE version=$1", [next])).rowCount) continue;
      await db.query(await readFile(new URL(file, directory), "utf8"));
      await db.query("INSERT INTO birbcrew_ts.schema_versions VALUES($1)", [next]);
    }
  });
}


export async function spawnHistoricalMember(store: MemberStore, input: { ownerId: string; requestId: string; engine: Engine; profile: string }) {
  return store.transaction(async db => {
    const { rows: [member] } = await db.query<{ memberId: string }>(`INSERT INTO birbcrew_ts.members(owner_id,spawn_request_id,engine,profile)
      VALUES($1,$2,$3,$4) RETURNING member_id AS "memberId"`, [input.ownerId, input.requestId, input.engine, input.profile]);
    await appendAudit(db, { type: "member.spawned", ownerId: input.ownerId, memberId: member.memberId,
      payload: { spawnRequestId: input.requestId, engine: input.engine, profile: input.profile } });
    return { ...member, ownerId: input.ownerId };
  });
}

/** Released migrations use both literal CHECKs and dynamic SQL that preserves a
 * catalog expression. Unescape the latter's SQL string before collecting names. */
export function auditTypesNamedInMigration(source: string): string[] {
  const normalized = source.replaceAll("''", "'");
  const check = /ADD CONSTRAINT audit_events_type_check CHECK \(([\s\S]*?)\) NOT VALID'?;/.exec(normalized);
  return [...(check?.[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g) ?? [])].map(match => match[1]);
}
