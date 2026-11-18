import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import type { DeferredTool } from "./deferral.ts";
import { MemberStoreError, turnKey } from "./domain.ts";
import { admittedInitiator } from "./store.ts";

/** Standing approval grants (docs/standing-grants.md). Every rule about which call a grant
 * covers lives in this module. */
export type GrantScope = "conversation" | "member";
export type StandingChoice = "allow_conversation" | "allow_always";
const scopes: Record<StandingChoice, GrantScope> = { allow_conversation: "conversation", allow_always: "member" };
export function standingScope(choice: string): GrantScope | null {
  return Object.hasOwn(scopes, choice) ? scopes[choice as StandingChoice] : null;
}

type Call = { ownerId: string; memberId: string; conversationId: string; requestId: string; invocationId: string; toolName: DeferredTool };
export type ActiveGrant = { grantId: string; scope: GrantScope };

/** Only a top-level record_work_item call of a request its owner admitted can use or create a
 * grant. Child calls (invocation != request), choose_next_step questions, and requests with
 * another initiator or no admission row at all always get a card. */
export async function grantable(db: Pick<PoolClient, "query">, call: Call) {
  if (call.toolName !== "record_work_item" || call.invocationId !== call.requestId) return false;
  return (await admittedInitiator(db, call))?.kind === "owner";
}

// A conversation grant ends when its conversation stops accepting requests: its turns reach the
// limit, a handoff sealed it, or a cancellation, an uncertain turn or a rejected admission has closed it.
const conversationOpen = `(g.conversation_id IS NULL OR (
  (SELECT count(*) FROM birbcrew_ts.turns t WHERE t.conversation_id=g.conversation_id AND t.phase='committed')
    < (SELECT c.turn_limit FROM birbcrew_ts.conversations c WHERE c.conversation_id=g.conversation_id)
  AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.conversation_handoffs h WHERE h.source_conversation_id=g.conversation_id)
  AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.turns t WHERE t.conversation_id=g.conversation_id AND t.phase='uncertain')
  AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.tool_cancellations x WHERE x.conversation_id=g.conversation_id)
  AND NOT EXISTS (SELECT 1 FROM birbcrew_ts.request_admissions a WHERE a.conversation_id=g.conversation_id AND a.phase='rejected')))`;
const active = `(g.revoked_at IS NULL AND ${conversationOpen})`;

/** How a proposal is decided: by an active grant, or by a card that offers the standing choices
 * when the call is grantable. Call while holding the conversation row lock. The grant is read
 * FOR SHARE, so a revoke either committed before this read, and the call gets a card, or waits
 * until this proposal commits, and the call stays approved. */
export async function proposalGrant(db: PoolClient, call: Call): Promise<{ grantable: boolean; grant: ActiveGrant | null }> {
  if (!await grantable(db, call)) return { grantable: false, grant: null };
  const { rows: [grant] } = await db.query<ActiveGrant>(`SELECT g.grant_id AS "grantId",
      CASE WHEN g.conversation_id IS NULL THEN 'member' ELSE 'conversation' END AS scope
    FROM birbcrew_ts.tool_grants g
    WHERE g.owner_id=$1 AND g.member_id=$2 AND (g.conversation_id=$3 OR g.conversation_id IS NULL)
      AND g.tool_name='record_work_item' AND g.policy_version=1 AND g.initiator_kind='owner' AND ${active}
    ORDER BY g.conversation_id NULLS LAST LIMIT 1 FOR SHARE OF g`, [call.ownerId, call.memberId, call.conversationId]);
  return { grantable: true, grant: grant ?? null };
}

/** Records the grant a standing answer chose, inside the decision's transaction. An active grant
 * with the same key already covers it: then nothing is created and nothing is audited. */
export async function createGrant(db: PoolClient, call: Call & { approvalId: string }, scope: GrantScope) {
  const { rows: [grant] } = await db.query<{ grant_id: string }>(`INSERT INTO birbcrew_ts.tool_grants
      (owner_id,member_id,conversation_id,tool_name,policy_version,initiator_kind,approval_id)
    VALUES ($1,$2,$3,'record_work_item',1,'owner',$4)
    ON CONFLICT (owner_id,member_id,conversation_id,tool_name,policy_version,initiator_kind) WHERE revoked_at IS NULL
    DO NOTHING RETURNING grant_id`,
    [call.ownerId, call.memberId, scope === "conversation" ? call.conversationId : null, call.approvalId]);
  if (grant) await appendAudit(db, { type: "grant.created", ownerId: call.ownerId, memberId: call.memberId,
    conversationId: call.conversationId, requestId: call.requestId,
    payload: { grantId: grant.grant_id, approvalId: call.approvalId, scope } });
}

export const grantListLimit = 20;
export interface PublicGrant {
  grantId: string; memberId: string; conversationId: string | null; scope: GrantScope; choice: StandingChoice;
  toolName: "record_work_item"; policyVersion: 1; approvalId: string; createdAt: string;
  status: "active" | "revoked" | "conversation_closed";
  revokedAt?: string; revocationReason?: "owner" | "recovery_restore";
}
const time = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const selection = `SELECT g.grant_id AS "grantId", g.member_id AS "memberId", g.conversation_id AS "conversationId",
    CASE WHEN g.conversation_id IS NULL THEN 'member' ELSE 'conversation' END AS scope,
    CASE WHEN g.conversation_id IS NULL THEN 'allow_always' ELSE 'allow_conversation' END AS choice,
    g.tool_name AS "toolName", g.policy_version AS "policyVersion", g.approval_id AS "approvalId",
    ${time("g.created_at")} AS "createdAt",
    CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN ${active} THEN 'active' ELSE 'conversation_closed' END AS status,
    ${time("g.revoked_at")} AS "revokedAt", g.revocation_reason AS "revocationReason"
  FROM birbcrew_ts.tool_grants g`;
function publicGrant({ revokedAt, revocationReason, ...grant }: PublicGrant & { revokedAt: string | null; revocationReason: string | null }) {
  return { ...grant, ...(revokedAt && { revokedAt, revocationReason }) } as PublicGrant;
}

const uuid = turnKey.shape.requestId;
const memberKey = z.strictObject({ ownerId: turnKey.shape.ownerId, memberId: uuid });

/** The member's active grants, then at most grantListLimit others, most recently ended first.
 * Owner comes from authentication only: another owner's member is not found. */
export async function listGrants(pool: Pool, input: z.input<typeof memberKey>) {
  const key = memberKey.parse(input);
  const member = await pool.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2", [key.ownerId, key.memberId]);
  if (!member.rowCount) throw new MemberStoreError("not_found");
  // One statement, so a grant revoked while listing appears in exactly one list.
  const { rows } = await pool.query(`SELECT * FROM (SELECT *, row_number() OVER
      (PARTITION BY status='active' ORDER BY coalesce("revokedAt","createdAt") DESC) AS recent
    FROM (${selection} WHERE g.owner_id=$1 AND g.member_id=$2) listed) ranked
    WHERE status='active' OR recent<=$3 ORDER BY status<>'active', CASE WHEN status='active' THEN "createdAt" END, recent`,
    [key.ownerId, key.memberId, grantListLimit]);
  const grants = rows.map(({ recent: _, ...grant }) => publicGrant(grant));
  return { apiVersion: "1" as const, memberId: key.memberId, active: grants.filter(grant => grant.status === "active"),
    inactive: grants.filter(grant => grant.status !== "active") };
}

/** Revokes for later proposals only: a call a grant already approved stays approved. Repeating
 * it returns the same revoked grant. */
export async function revokeGrant(pool: Pool, input: z.input<typeof memberKey> & { grantId: string }) {
  const key = memberKey.extend({ grantId: uuid }).parse(input);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows: [grant] } = await db.query<{ conversation_id: string | null }>(`SELECT conversation_id FROM birbcrew_ts.tool_grants
      WHERE grant_id=$1 AND owner_id=$2 AND member_id=$3`, [key.grantId, key.ownerId, key.memberId]);
    if (!grant) throw new MemberStoreError("not_found");
    // Conversation before grant, as proposals and observation publication lock them.
    if (grant.conversation_id) await db.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE",
      [grant.conversation_id]);
    const revoked = await db.query(`UPDATE birbcrew_ts.tool_grants SET revoked_at=clock_timestamp(), revocation_reason='owner'
      WHERE grant_id=$1 AND revoked_at IS NULL`, [key.grantId]);
    if (revoked.rowCount) await appendAudit(db, { type: "grant.revoked", ownerId: key.ownerId, memberId: key.memberId,
      conversationId: grant.conversation_id ?? undefined, payload: { grantId: key.grantId, reason: "owner" } });
    const { rows: [current] } = await db.query(selection + " WHERE g.grant_id=$1", [key.grantId]);
    await db.query("COMMIT");
    return { apiVersion: "1" as const, grant: publicGrant(current) };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

