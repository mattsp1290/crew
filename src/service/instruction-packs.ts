import type { PoolClient } from "pg";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import { instructionPacksPerMember, instructionsBytes, MemberStoreError, ownerText } from "./domain.ts";
import { fixedInjectedBytes, instructionsSummarySql, type InstructionsSummary } from "./instructions.ts";
import type { MemberStore } from "./store.ts";

/** Reusable instruction packs (docs/instruction-packs.md). An owner writes a pack once through the
 * API and attaches it, at spawn, to as many of their members as they like. A pack never changes,
 * and one attached to a member is never deleted, so a member's packs stay what it was spawned with.
 * instructions.ts gives them to every native launch, before the member's own instructions. */
export const packLimits = {
  textBytes: instructionsBytes, // the body CHECK in 033-instruction-packs.sql repeats it
  nameBytes: 128, // the name CHECK repeats it
  descriptionBytes: 512, // the description CHECK repeats it
  activePerOwner: 32, // limit_active_instruction_packs in 033-instruction-packs.sql repeats it
  perMember: instructionPacksPerMember,
  // A member's own instructions and the texts of its packs, together. The same budget instructions
  // had alone, so the fixed part of the context still fits every engine on its own.
  combinedTextBytes: instructionsBytes,
  pageSize: 100,
} as const;

export const packCapabilities = {
  version: 1, route: "/v1/instruction-packs", spawnField: "instructionPacks", writers: ["owner"], modelWrites: false, sharing: "owner-only",
  change: "immutable", attachment: "fixed-at-spawn", textBytes: packLimits.textBytes, nameBytes: packLimits.nameBytes,
  descriptionBytes: packLimits.descriptionBytes, activePerOwner: packLimits.activePerOwner, perMember: packLimits.perMember,
  combinedTextBytes: packLimits.combinedTextBytes, injectedBytesPerConversation: fixedInjectedBytes, modelReceives: "text-only",
  order: ["instructionPacks", "instructions", "projectNotes", "memories"], children: false,
  deletion: "refused-while-attached-text-erased-tombstone-kept", restore: "kept", digest: "sha256-utf8-hex",
} as const;

type Queryable = Pick<PoolClient, "query">;

/** Inside spawn's transaction, after it inserted the member and any instructions: attaches the
 * owner's packs in the given order. Each pack is locked FOR SHARE until commit, so a delete either
 * committed first, and the pack is refused as deleted, or waits and then sees the attachment. */
export async function attachPacks(db: Queryable, member: { ownerId: string; memberId: string }, packIds: readonly string[],
  instructions: string | undefined) {
  const { rows } = await db.query<{ state: "active" | "deleted"; bytes: number | null }>(`SELECT state, octet_length(body) AS bytes
      FROM birbcrew_ts.instruction_packs WHERE owner_id=$1 AND pack_id=ANY($2::uuid[]) ORDER BY pack_id FOR SHARE`,
    [member.ownerId, packIds]);
  if (rows.length !== packIds.length) throw new MemberStoreError("not_found");
  if (rows.some(row => row.state !== "active")) throw new MemberStoreError("pack_deleted");
  const bytes = rows.reduce((sum, row) => sum + row.bytes!, instructions === undefined ? 0 : Buffer.byteLength(instructions));
  if (bytes > packLimits.combinedTextBytes) throw new MemberStoreError("pack_limit");
  await db.query(`INSERT INTO birbcrew_ts.member_instruction_packs (member_id, position, owner_id, pack_id)
    SELECT $1, position::smallint, $2, pack_id FROM unnest($3::uuid[]) WITH ORDINALITY AS attached(pack_id, position)`,
  [member.memberId, member.ownerId, packIds]);
}

const lowerUuid = z.uuid().transform(value => value.toLowerCase());
// A label on one line: no tab or newline either.
const packName = ownerText(packLimits.nameBytes).refine(name => !/[\t\n]/.test(name), { message: "Expected a name on one line" });
const createSchema = z.strictObject({
  requestId: lowerUuid, name: packName, description: ownerText(packLimits.descriptionBytes).optional(), text: ownerText(packLimits.textBytes),
});
const listParameters = {
  after: lowerUuid.optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).refine(value => Number(value) <= packLimits.pageSize).transform(Number).optional(),
};
// A strict object still accepts inherited names such as __proto__; the gateway checks names too.
export const packListParameterNames: readonly string[] = Object.keys(listParameters);
const listQuery = z.strictObject(listParameters);

type PackRow = {
  pack_id: string; name: string | null; description: string | null; body: string | null;
  state: "active" | "deleted"; created_at: Date; deleted_at: Date | null; member_count: number; summary: InstructionsSummary | null;
};
// The members a pack is attached to, and its byte count and digest while it has text. A listing
// leaves the text in the database: a page of 100 full packs would carry 1.6 MB the gateway drops.
const packSelection = (withText: boolean) => `SELECT i.pack_id, i.name, i.description,
    ${withText ? "i.body" : "NULL::text AS body"}, i.state, i.created_at, i.deleted_at,
    (SELECT count(*)::integer FROM birbcrew_ts.member_instruction_packs a WHERE a.pack_id=i.pack_id) AS member_count,
    CASE WHEN i.body IS NOT NULL THEN ${instructionsSummarySql} END AS summary
  FROM birbcrew_ts.instruction_packs i`;

/** `text` only where asked: a listing carries the byte count and digest. A deleted pack keeps
 * nothing the owner wrote. */
function packView(row: PackRow, withText: boolean) {
  return {
    apiVersion: "1" as const, packId: row.pack_id, state: row.state, name: row.name, description: row.description,
    ...(withText ? { text: row.body } : {}), bytes: row.summary?.bytes ?? null, digest: row.summary?.digest ?? null,
    memberCount: row.member_count, createdAt: row.created_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

function constraintError(error: unknown): never {
  const constraint = error && typeof error === "object" && "constraint" in error ? error.constraint : undefined;
  if (constraint === "instruction_packs_active_limit") throw new MemberStoreError("pack_limit");
  if (constraint === "instruction_packs_in_use") throw new MemberStoreError("pack_in_use");
  throw error;
}

/** Owner-facing pack operations. The owner always comes from authentication; another owner's
 * pack is not found. */
export class PackApi {
  private readonly store: MemberStore;
  constructor(store: MemberStore) { this.store = store; }

  /** Idempotent by requestId. A replay is answered before the insert, whose cap trigger would
   * count the owner's limit. A deleted pack's text is gone, so its replay is never compared. */
  async create(ownerId: string, input: unknown) {
    const body = createSchema.parse(input);
    return this.store.transaction(async db => {
      const existing = async () => (await db.query<PackRow>(`${packSelection(true)} WHERE i.owner_id=$1 AND i.create_request_id=$2`,
        [ownerId, body.requestId])).rows[0];
      const replay = (row: PackRow) => {
        if (row.state === "deleted") throw new MemberStoreError("pack_deleted");
        if (row.name !== body.name || row.description !== (body.description ?? null) || row.body !== body.text) {
          throw new MemberStoreError("conflict");
        }
        return packView(row, true);
      };
      const prior = await existing();
      if (prior) return replay(prior);
      const { rows: [inserted] } = await db.query<{ pack_id: string }>(`INSERT INTO birbcrew_ts.instruction_packs
          (owner_id, create_request_id, name, description, body) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (owner_id, create_request_id) DO NOTHING RETURNING pack_id`,
        [ownerId, body.requestId, body.name, body.description ?? null, body.text]).catch(constraintError);
      // A concurrent duplicate committed first: answer as its replay.
      if (!inserted) return replay((await existing())!);
      await appendAudit(db, { type: "instruction_pack.created", ownerId, memberId: null, payload: { packId: inserted.pack_id } });
      return packView((await existing())!, true);
    });
  }

  async get(ownerId: string, packId: string) {
    return packView(await this.owned(this.store.pool, ownerId, packId), true);
  }

  /** Every state, deleted tombstones included, ordered by packId; without text. */
  async list(ownerId: string, input: unknown) {
    const query = listQuery.parse(input);
    const limit = query.limit ?? packLimits.pageSize;
    const { rows } = await this.store.pool.query<PackRow>(`${packSelection(false)}
      WHERE i.owner_id=$1 AND ($2::uuid IS NULL OR i.pack_id>$2) ORDER BY i.pack_id LIMIT $3`, [ownerId, query.after ?? null, limit + 1]);
    const instructionPacks = rows.slice(0, limit).map(row => packView(row, false));
    return { apiVersion: "1" as const, instructionPacks, nextAfter: instructionPacks.at(-1)?.packId ?? query.after ?? null,
      hasMore: rows.length > limit };
  }

  /** Erases the name, description and text and keeps a tombstone, unless a member has the pack:
   * that member's instructions would change, so the delete is refused. Repeating it returns the
   * tombstone. */
  async delete(ownerId: string, packId: string) {
    return this.store.transaction(async db => {
      const row = await this.owned(db, ownerId, packId, true);
      if (row.state === "deleted") return packView(row, true);
      // guard_instruction_pack makes the same check, but the UPDATE's statement-level recovery
      // barrier fires before it, so only this check answers pack_in_use while recovery holds
      // writes. A later statement than the lock, so it sees a spawn that held the pack and committed.
      const { rows: [{ attached }] } = await db.query<{ attached: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM birbcrew_ts.member_instruction_packs WHERE pack_id=$1) AS attached", [row.pack_id]);
      if (attached) throw new MemberStoreError("pack_in_use");
      await db.query(`UPDATE birbcrew_ts.instruction_packs SET state='deleted', name=NULL, description=NULL, body=NULL,
        deleted_at=clock_timestamp() WHERE pack_id=$1`, [row.pack_id]).catch(constraintError);
      await appendAudit(db, { type: "instruction_pack.deleted", ownerId, memberId: null, payload: { packId: row.pack_id } });
      return packView(await this.owned(db, ownerId, row.pack_id), true);
    });
  }

  private async owned(db: Queryable, ownerId: string, packId: string, lock = false) {
    const { rows: [row] } = await db.query<PackRow>(`${packSelection(true)} WHERE i.owner_id=$1 AND i.pack_id=$2 ${lock ? "FOR UPDATE OF i" : ""}`,
      [ownerId, lowerUuid.parse(packId)]);
    if (!row) throw new MemberStoreError("not_found");
    return row;
  }
}
