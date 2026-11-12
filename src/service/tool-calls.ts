import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonical, canonicalDigest } from "./canonical-json.ts";
import { MemberStoreError, openSchema, turnKey } from "./domain.ts";
import { argumentDigest, classify, type Classified, type ToolCall } from "./tool-catalog.ts";

/** The tool-call ledger (docs/member-capabilities.md, 033-tool-calls.sql): one row for each
 * call of a Crew tool the gate decided, from its verdict to the delivery of its outcome. The
 * database enforces every phase rule; this module is the only writer and maps what it finds
 * to what the caller should do next. Arguments and results are private: never audit, publish
 * or log them.
 *
 * Nothing calls this yet: no engine offers a Crew tool, and the gate is a later slice. */
export const toolCallLimits = {
  perRequest: 256, // guard_tool_call in 033-tool-calls.sql repeats it
  argumentBytes: 2 * 1024 * 1024, // canonical JSON; the arguments CHECK allows twice this
  resultBytes: 65_536, // canonical JSON; the result CHECK allows twice this
} as const;

const uuid = turnKey.shape.requestId;
const callKey = openSchema.extend({
  requestId: uuid, invocationId: uuid,
  nativeCallId: z.string().min(1).refine(id => id.isWellFormed() && !id.includes("\0") && Buffer.byteLength(id) <= 256),
});
/** A call's identity: the engine's call inside one invocation of one request of one conversation. */
export type ToolCallKey = z.input<typeof callKey>;
type Key = z.output<typeof callKey>;

/** What the gate decided and what decided it. Nothing allows an effect by default: only a
 * grant can. A later slice adds the owner's answer to an ask, and policy rules. */
export type Verdict =
  | { verdict: "allow"; by: "default" }
  | { verdict: "allow"; by: "grant"; grantId: string }
  | { verdict: "ask"; by: "default" }
  | { verdict: "deny"; by: "capability" | "budget" | "credential_scan" };
const verdictSchema: z.ZodType<Verdict> = z.union([
  z.strictObject({ verdict: z.literal("allow"), by: z.literal("default") }),
  z.strictObject({ verdict: z.literal("allow"), by: z.literal("grant"), grantId: uuid }),
  z.strictObject({ verdict: z.literal("ask"), by: z.literal("default") }),
  z.strictObject({ verdict: z.literal("deny"), by: z.enum(["capability", "budget", "credential_scan"]) }),
]);

const failureCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const resultSchema = z.record(z.string(), z.json());
type Json = z.infer<ReturnType<typeof z.json>>;
type Result = z.infer<typeof resultSchema>;

/** Where a call is. `waiting`, `ready` and `refused` are where a verdict puts it (ask, allow,
 * deny); `admitted` means an execution holds it; the rest are outcomes. */
export type ToolCallOutcome =
  | { phase: "waiting" | "ready" }
  | { phase: "admitted"; executionId: string }
  | { phase: "completed"; result: Result }
  | { phase: "failed"; failure: string }
  /** It may or may not have happened. Never run it again. */
  | { phase: "uncertain"; reason: "worker_lost" | "recovery_restore" }
  | { phase: "refused" };
export type ToolCallRecord = Key & ToolCallOutcome & {
  callId: string;
  toolName: string; catalogVersion: number; kind: "read" | "effect"; scope: Json;
  arguments: Json; argumentDigest: string; priorSha256?: string;
  verdict: Verdict;
  /** Whether the model has been given the outcome. */
  delivered: boolean;
};

interface Row {
  call_id: string; invocation_id: string; native_call_id: string; request_id: string;
  tool_name: string; catalog_version: number; kind: "read" | "effect"; scope: Json; arguments: Json; argument_digest: string;
  prior_sha256: string | null; verdict: Verdict["verdict"]; decided_by: string; grant_id: string | null;
  phase: ToolCallOutcome["phase"]; execution_id: string | null; result: Result | null; failure: string | null;
  uncertain_reason: "worker_lost" | "recovery_restore" | null; delivered: boolean;
}

function outcome(row: Row): ToolCallOutcome {
  switch (row.phase) {
    case "waiting": case "ready": case "refused": return { phase: row.phase };
    case "admitted": return { phase: "admitted", executionId: row.execution_id! };
    case "completed": return { phase: "completed", result: row.result! };
    case "failed": return { phase: "failed", failure: row.failure! };
    case "uncertain": return { phase: "uncertain", reason: row.uncertain_reason! };
  }
}

function record(key: Pick<Key, "ownerId" | "memberId" | "conversationId">, row: Row): ToolCallRecord {
  // A stored verdict this release does not know (after a rollback) is a server fault.
  const verdict = verdictSchema.parse({ verdict: row.verdict, by: row.decided_by, ...(row.grant_id && { grantId: row.grant_id }) });
  return {
    ownerId: key.ownerId, memberId: key.memberId, conversationId: key.conversationId, requestId: row.request_id,
    invocationId: row.invocation_id, nativeCallId: row.native_call_id, callId: row.call_id,
    toolName: row.tool_name, catalogVersion: row.catalog_version, kind: row.kind, scope: row.scope,
    arguments: row.arguments, argumentDigest: row.argument_digest, ...(row.prior_sha256 && { priorSha256: row.prior_sha256 }),
    verdict, ...outcome(row), delivered: row.delivered,
  };
}

/** What to do with a call found after its worker was lost. */
export type LostCall =
  /** An ask nobody has answered: nothing ran. */
  | { action: "wait"; call: ToolCallRecord }
  /** Allowed and never admitted: nothing ran, so it can start. */
  | { action: "start"; call: ToolCallRecord }
  /** A read whose execution was lost: run it again. */
  | { action: "rerun"; call: ToolCallRecord }
  /** An outcome the model has not been given: deliver what is stored. An effect that had been
   * admitted is here too, now `uncertain`. */
  | { action: "deliver"; call: ToolCallRecord }
  /** Delivered: nothing is left to do. */
  | { action: "done"; call: ToolCallRecord };

/** Whether an execution may run the call now. */
export type Admission = { run: true; call: ToolCallRecord } | { run: false; call: ToolCallRecord };

const selected = "SELECT * FROM birbcrew_ts.tool_calls WHERE conversation_id=$1 AND request_id=$2 AND invocation_id=$3 AND native_call_id=$4";
const identity = (key: Key) => [key.conversationId, key.requestId, key.invocationId, key.nativeCallId];

/** The conversation must be its owner's and member's: another owner's is not found. Every
 * ledger write takes this row lock first, as proposals and decisions do, so a later slice
 * can append its audit row in the same transaction without a lock-order deadlock. */
async function lockConversation(db: PoolClient, key: Pick<Key, "ownerId" | "memberId" | "conversationId">) {
  const found = await db.query("SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id=$1 AND member_id=$2 AND conversation_id=$3 FOR UPDATE",
    [key.ownerId, key.memberId, key.conversationId]);
  if (!found.rowCount) throw new MemberStoreError("not_found");
}

async function locked(db: PoolClient, key: Key): Promise<Row> {
  await lockConversation(db, key);
  const { rows: [row] } = await db.query<Row>(selected + " FOR UPDATE", identity(key));
  if (!row) throw new MemberStoreError("not_found");
  return row;
}

/** Classifies a stored call again and checks that it is the call that was decided: same
 * digest, kind and catalog version. Whoever runs a stored call does this first and runs the
 * arguments this returns. A call stored under another catalog version does not verify. */
export function verifyStored(call: Pick<ToolCallRecord, "toolName" | "catalogVersion" | "kind" | "arguments" | "argumentDigest" | "priorSha256">): Classified {
  const again = classify({ tool: call.toolName, arguments: call.arguments, ...(call.priorSha256 && { priorSha256: call.priorSha256 }) } as ToolCall);
  if (again.argumentDigest !== call.argumentDigest || again.kind !== call.kind || again.catalogVersion !== call.catalogVersion) {
    throw new MemberStoreError("conflict");
  }
  return again;
}

export class ToolCallStore {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  /** Records a decided call. The verdict is fixed by the first record of an identity: a retry
   * returns the stored call, whatever verdict it brings, and a different call under the same
   * identity is a conflict. */
  async record(key: ToolCallKey, call: Classified, verdict: Verdict): Promise<ToolCallRecord> {
    return this.transaction(db => this.recordLocked(db, key, call, verdict));
  }

  /** `record` inside the caller's transaction, for a gate that decides and records at once. */
  async recordLocked(db: PoolClient, input: ToolCallKey, call: Classified, decided: Verdict): Promise<ToolCallRecord> {
    const key = callKey.parse(input), verdict = verdictSchema.parse(decided);
    if (verdict.verdict === "allow" && verdict.by === "default" && call.kind !== "read") throw new MemberStoreError("conflict");
    if (argumentDigest(call) !== call.argumentDigest) throw new MemberStoreError("conflict");
    if (Buffer.byteLength(canonical(call.arguments)) > toolCallLimits.argumentBytes) throw new MemberStoreError("input_limit");
    await lockConversation(db, key);
    const turn = await db.query("SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1 AND request_id=$2", [key.conversationId, key.requestId]);
    if (!turn.rowCount) throw new MemberStoreError("not_found");
    const { rows: [prior] } = await db.query<Row>(selected, identity(key));
    if (prior) {
      if (prior.tool_name !== call.tool || prior.argument_digest !== call.argumentDigest) throw new MemberStoreError("conflict");
      return record(key, prior);
    }
    const phase = { allow: "ready", ask: "waiting", deny: "refused" }[verdict.verdict];
    try {
      const { rows: [row] } = await db.query<Row>(`INSERT INTO birbcrew_ts.tool_calls
        (owner_id,member_id,conversation_id,request_id,invocation_id,native_call_id,tool_name,catalog_version,kind,scope,arguments,
         argument_digest,prior_sha256,verdict,decided_by,grant_id,phase)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [key.ownerId, key.memberId, ...identity(key), call.tool, call.catalogVersion, call.kind, JSON.stringify(call.scope),
          JSON.stringify(call.arguments), call.argumentDigest, call.priorSha256 ?? null, verdict.verdict, verdict.by,
          verdict.verdict === "allow" && verdict.by === "grant" ? verdict.grantId : null, phase]);
      return record(key, row);
    } catch (error) {
      if (error instanceof Error && "constraint" in error && error.constraint === "tool_calls_request_limit") throw new MemberStoreError("input_limit");
      throw error;
    }
  }

  /** An execution asks to run the call. It may when the call is ready, when this same
   * execution already holds it (a retry), or when the call is a read another execution held
   * (the read is run again, and the earlier execution can no longer finish it). It may not
   * run an effect another execution holds: that effect may already have happened. */
  async admit(input: ToolCallKey, executionId: string): Promise<Admission> {
    const key = callKey.parse(input), execution = uuid.parse(executionId);
    return this.transaction(async (db) => {
      const row = await locked(db, key);
      const run = row.phase === "ready" || (row.phase === "admitted" && (row.execution_id === execution || row.kind === "read"));
      if (!run) return { run: false, call: record(key, row) };
      const { rows: [admitted] } = await db.query<Row>(`UPDATE birbcrew_ts.tool_calls
        SET phase='admitted', execution_id=$2, admitted_at=coalesce(admitted_at, clock_timestamp()) WHERE call_id=$1 RETURNING *`,
        [row.call_id, execution]);
      return { run: true, call: record(key, admitted) };
    });
  }

  private async finish(input: ToolCallKey, executionId: string,
    change: { phase: "completed"; result: Result } | { phase: "failed"; failure: string }): Promise<ToolCallRecord> {
    const key = callKey.parse(input), execution = uuid.parse(executionId);
    return this.transaction(async (db) => {
      const row = await locked(db, key);
      if (row.execution_id !== execution) throw new MemberStoreError("stale");
      if (row.phase !== "admitted") {
        // The same execution reporting the same outcome again reads it back; anything else is refused.
        const same = change.phase === "completed" ? row.phase === "completed" && canonicalDigest(row.result) === canonicalDigest(change.result)
          : row.phase === "failed" && row.failure === change.failure;
        if (!same) throw new MemberStoreError(row.phase === "completed" || row.phase === "failed" ? "conflict" : "stale");
        return record(key, row);
      }
      const { rows: [finished] } = await db.query<Row>(`UPDATE birbcrew_ts.tool_calls SET phase=$2, result=$3, failure=$4, finished_at=clock_timestamp()
        WHERE call_id=$1 RETURNING *`, [row.call_id, change.phase,
        change.phase === "completed" ? JSON.stringify(change.result) : null, change.phase === "failed" ? change.failure : null]);
      return record(key, finished);
    });
  }

  /** The execution that holds the call stores its result, a JSON object. Another execution is stale. */
  async complete(key: ToolCallKey, executionId: string, result: unknown): Promise<ToolCallRecord> {
    const value = resultSchema.parse(result);
    if (Buffer.byteLength(canonical(value)) > toolCallLimits.resultBytes) throw new MemberStoreError("input_limit");
    return this.finish(key, executionId, { phase: "completed", result: value });
  }

  /** The execution that holds the call reports that it did not complete, with a code such as `timeout`. */
  async fail(key: ToolCallKey, executionId: string, failure: string): Promise<ToolCallRecord> {
    return this.finish(key, executionId, { phase: "failed", failure: failureCode.parse(failure) });
  }

  /** Decides what to do with a call whose worker was lost. Call it only once the worker is
   * known to be gone: an admitted effect becomes uncertain here and can never be completed
   * afterwards, even if its execution was still running. Repeating it gives the same answer. */
  async classifyLost(input: ToolCallKey): Promise<LostCall> {
    const key = callKey.parse(input);
    return this.transaction(async (db) => {
      let row = await locked(db, key);
      if (row.phase === "admitted" && row.kind === "effect") {
        ({ rows: [row] } = await db.query<Row>(`UPDATE birbcrew_ts.tool_calls SET phase='uncertain', uncertain_reason='worker_lost',
          finished_at=clock_timestamp() WHERE call_id=$1 RETURNING *`, [row.call_id]));
      }
      const call = record(key, row);
      switch (call.phase) {
        case "waiting": return { action: "wait", call };
        case "ready": return { action: "start", call };
        case "admitted": return { action: "rerun", call };
        case "completed": case "failed": case "uncertain": case "refused": return { action: call.delivered ? "done" : "deliver", call };
      }
    });
  }

  /** The model has been given the call's outcome. Only an outcome can be delivered. */
  async deliver(input: ToolCallKey): Promise<ToolCallRecord> {
    const key = callKey.parse(input);
    return this.transaction(async (db) => {
      const row = await locked(db, key);
      if (row.delivered) return record(key, row);
      if (!["completed", "failed", "uncertain", "refused"].includes(row.phase)) throw new MemberStoreError("conflict");
      const { rows: [delivered] } = await db.query<Row>(
        "UPDATE birbcrew_ts.tool_calls SET delivered=true, delivered_at=clock_timestamp() WHERE call_id=$1 RETURNING *", [row.call_id]);
      return record(key, delivered);
    });
  }

  /** One call, for its owner only. */
  async get(input: ToolCallKey): Promise<ToolCallRecord> {
    const key = callKey.parse(input);
    const { rows: [row] } = await this.pool.query<Row>(`SELECT t.* FROM birbcrew_ts.tool_calls t JOIN birbcrew_ts.conversations c USING (conversation_id)
      WHERE c.owner_id=$1 AND c.member_id=$2 AND t.conversation_id=$3 AND t.request_id=$4 AND t.invocation_id=$5 AND t.native_call_id=$6`,
      [key.ownerId, key.memberId, ...identity(key)]);
    if (!row) throw new MemberStoreError("not_found");
    return record(key, row);
  }
}

/** A restore rewinds the ledger to its recovery point. An effect that was allowed there but
 * had not finished may have run on the timeline the restore discarded, so when a restored
 * installation resumes, every such effect, admitted or not, becomes uncertain and is never
 * run. Reads are left to run again, outcomes are left to be delivered, and an ask stays
 * waiting. Runs in the activation's transaction (recovery.ts), where any other writer still
 * meets the write barrier, so it needs no conversation lock. */
export async function settleRestoredToolCalls(db: Pick<PoolClient, "query">): Promise<number> {
  const settled = await db.query(`UPDATE birbcrew_ts.tool_calls SET phase='uncertain', uncertain_reason='recovery_restore', finished_at=clock_timestamp()
    WHERE kind='effect' AND phase IN ('ready','admitted')`);
  return settled.rowCount ?? 0;
}
