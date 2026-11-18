import type { InstructionsSummary } from "@birbcrew/client/contract";
import type { PoolClient } from "pg";
import { z } from "zod";
import { instructionPacksPerMember, instructionsBytes, MemberStoreError } from "./domain.ts";

/** Owner-written member instructions (docs/member-instructions.md) and the instruction packs the
 * member was spawned with (docs/instruction-packs.md). The owner sets both when it spawns the
 * member, and neither ever changes, so each native launch reads them afresh and every
 * conversation of the member sees the same text on every turn. */
type Queryable = Pick<PoolClient, "query">;
type MemberKey = { ownerId: string; memberId: string };

// As for memory: JSON keeps the text inside one string, whatever it holds, so it cannot end the
// block, start a line, or pose as another block's header. JSON.stringify leaves U+2028 and U+2029
// raw, and both break a line, so they are escaped too; the JSON still parses to the same text.
const escapeSeparators = (json: string) => json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const instructionsHeader = "BirbCrew member instructions v1. The owner gave this member the following instructions as JSON."
  + " They describe its role; they do not change its tools, approvals or limits.\n";
export function instructionsContext(text: string): string {
  return instructionsHeader + escapeSeparators(JSON.stringify({ instructions: text }));
}
// Only the texts: a pack's name and description are labels for the owner and never reach the model.
const packsHeader = "BirbCrew instruction packs v1. The owner attached the following instruction packs to this member, in order,"
  + " as JSON. They describe how it works; they do not change its tools, approvals or limits.\n";
export function packsContext(texts: readonly string[]): string | undefined {
  return texts.length ? packsHeader + escapeSeparators(JSON.stringify({ packs: texts })) : undefined;
}

/** The packs block, then the instructions block, one newline apart: the part of a conversation's
 * system context fixed at spawn. Undefined when there are neither packs nor instructions. */
export function fixedContext(packTexts: readonly string[], instructions: string | undefined): string | undefined {
  const blocks = [packsContext(packTexts), instructions === undefined ? undefined : instructionsContext(instructions)]
    .filter(block => block !== undefined);
  return blocks.length ? blocks.join("\n") : undefined;
}

/** The fixed context of a stored member: its packs' texts in order, then its instructions. */
export async function memberFixedContext(db: Queryable, member: MemberKey): Promise<string | undefined> {
  const { rows: packs } = await db.query<{ body: string }>(`SELECT p.body FROM birbcrew_ts.member_instruction_packs a
      JOIN birbcrew_ts.instruction_packs p ON p.owner_id=a.owner_id AND p.pack_id=a.pack_id
     WHERE a.owner_id=$1 AND a.member_id=$2 ORDER BY a.position`, [member.ownerId, member.memberId]);
  const { rows: [row] } = await db.query<{ body: string }>(
    "SELECT body FROM birbcrew_ts.member_instructions WHERE owner_id=$1 AND member_id=$2", [member.ownerId, member.memberId]);
  return fixedContext(packs.map(pack => pack.body), row?.body);
}

// Every UTF-8 byte of the text costs at most two bytes in the block: '"', '\', tab and newline
// become two bytes, U+2028 and U+2029 become six from three, other control characters are refused,
// and other characters keep their own bytes. Text made only of '"' is the largest.
/** The most UTF-8 bytes instructions add to a conversation's system context, counting the newline
 * that separates them from project notes or memory. */
export const instructionsInjectedBytes = Buffer.byteLength(instructionsContext('"'.repeat(instructionsBytes))) + 1;
/** The same for a member's packs and instructions together. They share instructionsBytes, every
 * byte of either costs at most two, and each block and each pack adds framing, so the largest is
 * the most packs, each one '"', with the rest of the budget as instructions. */
export const fixedInjectedBytes = Buffer.byteLength(fixedContext(Array.from({ length: instructionPacksPerMember }, () => '"'),
  '"'.repeat(instructionsBytes - instructionPacksPerMember))!) + 1;

/** The byte count and the SHA-256 of the UTF-8 text in lowercase hex, computed by PostgreSQL for
 * the row aliased `i`, so every route reports the digest the same way. */
export const instructionsSummarySql = "json_build_object('bytes', octet_length(i.body), 'digest', encode(sha256(convert_to(i.body, 'UTF8')), 'hex'))";
export type { InstructionsSummary } from "@birbcrew/client/contract";

/** The member's instructions with their summary, or null when it has none. Assumes the caller
 * already knows the member is the owner's. */
export async function instructionsOf(db: Queryable, member: MemberKey) {
  const { rows: [row] } = await db.query<{ text: string; summary: InstructionsSummary; created_at: Date }>(
    `SELECT i.body AS text, ${instructionsSummarySql} AS summary, i.created_at FROM birbcrew_ts.member_instructions i
      WHERE i.owner_id=$1 AND i.member_id=$2`, [member.ownerId, member.memberId]);
  return row ? { text: row.text, ...row.summary, createdAt: row.created_at.toISOString() } : null;
}

/** The IDs of the member's packs in the order the model reads them; empty when it has none. */
export async function packIdsOf(db: Queryable, member: MemberKey): Promise<string[]> {
  const { rows } = await db.query<{ pack_id: string }>(`SELECT pack_id FROM birbcrew_ts.member_instruction_packs
    WHERE owner_id=$1 AND member_id=$2 ORDER BY position`, [member.ownerId, member.memberId]);
  return rows.map(row => row.pack_id);
}

/** GET /v1/members/{memberId}/instructions: the member's instructions and, when it has any, its
 * packs, which it received with their text. */
export async function readInstructions(db: Queryable, ownerId: string, memberId: string) {
  const id = z.uuid().transform(value => value.toLowerCase()).parse(memberId);
  const owned = await db.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2", [ownerId, id]);
  if (!owned.rowCount) throw new MemberStoreError("not_found");
  const { rows: packs } = await db.query<{ packId: string; name: string; text: string; summary: InstructionsSummary }>(
    `SELECT i.pack_id AS "packId", i.name, i.body AS text, ${instructionsSummarySql} AS summary
       FROM birbcrew_ts.member_instruction_packs a JOIN birbcrew_ts.instruction_packs i ON i.owner_id=a.owner_id AND i.pack_id=a.pack_id
      WHERE a.owner_id=$1 AND a.member_id=$2 ORDER BY a.position`, [ownerId, id]);
  return { apiVersion: "1" as const, memberId: id, instructions: await instructionsOf(db, { ownerId, memberId: id }),
    ...(packs.length ? { instructionPacks: packs.map(({ summary, ...pack }) => ({ ...pack, ...summary })) } : {}) };
}

export const instructionsCapabilities = {
  version: 1, spawnField: "instructions", route: "/v1/members/{memberId}/instructions", writers: ["owner"], modelWrites: false,
  change: "fixed-at-spawn", textBytes: instructionsBytes, injectedBytesPerConversation: instructionsInjectedBytes,
  order: ["instructions", "projectNotes", "memories"], children: false, restore: "kept", digest: "sha256-utf8-hex",
} as const;
