/** Trusted backend-only API. Never construct authority from an observer request. */
import {acquireRecoveryNativeLease,requireRecoveryActive} from "./recovery-admission.ts";
import { appendAudit, trustedToolName } from "./audit.ts";
import { canonical, canonicalDigest as digest } from "./canonical-json.ts";
import { randomUUID } from "node:crypto";
import { Client, type Pool, type PoolClient } from "pg";
import { z } from "zod";
import { engineTraits, type Engine } from "./domain.ts";

const text = (max: number) => z.string().min(1).refine(v => v.isWellFormed() && !v.includes("\0") && Buffer.byteLength(v) <= max);
const keySchema = z.strictObject({ ownerId: text(256), conversationId: z.uuid() });
const snapshotSchema = z.strictObject({ scope: text(256), version: text(256), text: text(65_536) });
export type TrustedKey = z.infer<typeof keySchema>;
export type ContextSnapshot = z.infer<typeof snapshotSchema>;
export type TrustedClaim = TrustedKey & { requestId: string; generation: number; token: string };
export type AuthorizationPhase = "open" | "submit" | "dispatch" | "release" | "output" | "receipt";
export interface Authorization {
  ownerId: string; conversationId: string; scope: string; version: string;
  phase: AuthorizationPhase; requestId?: string; toolName?: string; arguments?: unknown; operationId?: string;
}
export interface RegisteredTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  kind: "read" | "effect"; maxArgumentBytes: number; maxResultBytes: number; deadlineMs: number;
  execute(input: { args: unknown; operationId: string; signal: AbortSignal; authority: Authorization }): Promise<unknown>;
}
export interface TrustedApplication {
  /** Immutable deployment identifier. Change when tool implementation/policy changes. */
  id: string;
  tools: readonly RegisteredTool[];
  /** Mandatory, fresh application policy check. Anything except true denies. */
  authorize(input: Authorization): Promise<boolean>;
}
export class TrustedContextError extends Error {
  readonly code: "denied" | "conflict" | "busy" | "stale" | "uncertain" | "limit" | "not_found";
  constructor(code: TrustedContextError["code"]) {
    super(`Trusted application ${code}`); this.name = "TrustedContextError"; this.code = code;
  }
}
export { canonical };
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freezeJson(v); Object.freeze(value); }
  return value;
}
export function toolManifest(app: TrustedApplication) {
  text(128).parse(app.id);
  if (typeof app.authorize !== "function" || app.tools.length > 8) throw new TrustedContextError("limit");
  const names = new Set<string>();
  return app.tools.map(tool => {
    if (!trustedToolName.test(tool.name) || names.has(tool.name)) throw new TrustedContextError("conflict");
    names.add(tool.name); text(2048).parse(tool.description);
    if (tool.kind !== "read" && tool.kind !== "effect") throw new TrustedContextError("conflict");
    for (const [n,max] of [[tool.maxArgumentBytes,16_384],[tool.maxResultBytes,65_536],[tool.deadlineMs,30_000]]) {
      if (!Number.isInteger(n) || n < 1 || n > max) throw new TrustedContextError("limit");
    }
    if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false || Buffer.byteLength(canonical(tool.inputSchema)) > 16_384) throw new TrustedContextError("limit");
    z.fromJSONSchema(tool.inputSchema); // Unsupported schemas fail during registration.
    const { execute: _, ...manifest } = tool;
    return manifest;
  });
}
interface SessionRow {
  owner_id: string; member_id:string; conversation_id: string; generation: number; native_thread_id: string;
  phase: "active" | "draining" | "deleted"; scope: string; context_version: string;
  context_text: string | null; application_digest: string; checkpoint: unknown; engine: Engine;
}
export interface TrustedStart {
  claim: TrustedClaim; engine: Engine; memberId:string; threadId: string; text: string; context: string;
  binding: string; checkpoint: unknown;
}

export class TrustedContextStore {
  readonly pool: Pool;
  readonly application: TrustedApplication;
  readonly manifest: ReturnType<typeof toolManifest>;
  readonly applicationDigest: string;
  constructor(pool: Pool, application: TrustedApplication) {
    toolManifest(application);
    this.pool = pool;
    // Snapshot capabilities: a live deployment cannot silently mutate a registered schema or handler.
    const tools = application.tools.map(t => Object.freeze({...t, inputSchema: freezeJson(structuredClone(t.inputSchema))}));
    this.application = Object.freeze({id:application.id, authorize:application.authorize.bind(application), tools:Object.freeze(tools)});
    this.manifest = freezeJson(toolManifest(this.application));
    this.applicationDigest = digest({ id: application.id, tools: this.manifest });
  }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }
  private async session(db: Pool | PoolClient | Client, input: TrustedKey, lock = false): Promise<SessionRow> {
    const key = keySchema.parse(input);
    const { rows: [row] } = await db.query<SessionRow>(`SELECT s.*,m.engine,m.member_id FROM birbcrew_ts.trusted_sessions s
      JOIN birbcrew_ts.conversations c USING(conversation_id) JOIN birbcrew_ts.members m ON m.owner_id=c.owner_id AND m.member_id=c.member_id
      WHERE s.conversation_id=$1 AND c.owner_id=$2 ${lock ? "FOR UPDATE OF s" : ""}`, [key.conversationId,key.ownerId]);
    if (!row) throw new TrustedContextError("not_found");
    if (row.phase === "deleted") throw new TrustedContextError("stale");
    if (row.application_digest !== this.applicationDigest) throw new TrustedContextError("conflict");
    return row;
  }
  private authority(s: SessionRow, phase: AuthorizationPhase, requestId?: string, toolName?: string): Authorization {
    return { ownerId: s.owner_id, conversationId: s.conversation_id, scope:s.scope, version:s.context_version, phase, requestId, toolName };
  }
  private async allowed(input: Authorization) {
    // A policy service hanging must not hold a durable admission lock indefinitely.
    const timeout = AbortSignal.timeout(5_000);
    const approved = await Promise.race([Promise.resolve().then(() => this.application.authorize(input)).catch(() => false), new Promise<boolean>((_,reject) => {
      timeout.addEventListener("abort", () => reject(new TrustedContextError("denied")), {once:true});
    })]);
    if (approved !== true) throw new TrustedContextError("denied");
  }
  async open(input: TrustedKey, value: ContextSnapshot): Promise<void> {
    const key = keySchema.parse(input), snapshot = snapshotSchema.parse(value);
    await this.allowed({ ...key, scope:snapshot.scope,version:snapshot.version,phase:"open" });
    await this.transaction(async db => {
      const member = await db.query<{ engine: Engine }>(
        `SELECT m.engine FROM birbcrew_ts.conversations c
          JOIN birbcrew_ts.members m ON c.owner_id = m.owner_id AND c.member_id = m.member_id
          WHERE c.conversation_id = $1 AND c.owner_id = $2
          FOR UPDATE OF c`,
        [key.conversationId, key.ownerId]);
      if (!member.rows[0]) throw new TrustedContextError("not_found");
      if (!engineTraits[member.rows[0].engine].trustedContext) throw new TrustedContextError("denied");
      if ((await db.query("SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=$1",[key.conversationId])).rowCount) throw new TrustedContextError("conflict");
      // A handoff's source is sealed and its target awaits its reserved first request on the member lane.
      if ((await db.query("SELECT 1 FROM birbcrew_ts.conversation_handoffs WHERE source_conversation_id=$1 OR target_conversation_id=$1",
        [key.conversationId])).rowCount) throw new TrustedContextError("conflict");
      await db.query(`INSERT INTO birbcrew_ts.trusted_sessions (conversation_id,owner_id,scope,context_version,context_text,application_digest)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [key.conversationId,key.ownerId,snapshot.scope,snapshot.version,snapshot.text,this.applicationDigest]);
      const s = await this.session(db,key,true);
      if (s.scope !== snapshot.scope || s.context_version !== snapshot.version || s.context_text !== snapshot.text) throw new TrustedContextError("conflict");
    });
  }
  /** Idempotent acceptance assigns a durable order, including while rotation drains. */
  async submit(input: TrustedKey, requestId: string, prompt: string): Promise<number> {
    const key = keySchema.parse(input); z.uuid().parse(requestId); text(16_384).parse(prompt);
    return this.transaction(async db => {
      const s = await this.session(db,key,true);
      await this.allowed(this.authority(s,"submit",requestId));
      const prior = (await db.query<{position:number;prompt_digest:string}>("SELECT position,prompt_digest FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1 AND request_id=$2",[key.conversationId,requestId])).rows[0];
      if (prior) { if (prior.prompt_digest !== digest(prompt)) throw new TrustedContextError("conflict"); return prior.position; }
      const {rows:[count]} = await db.query<{n:number}>("SELECT coalesce(max(position),0)::int+1 AS n FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1", [key.conversationId]);
      if (count.n > 1024) throw new TrustedContextError("limit");
      await db.query(`INSERT INTO birbcrew_ts.trusted_requests (conversation_id,request_id,position,prompt,prompt_digest,generation,phase)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [key.conversationId,requestId,count.n,prompt,digest(prompt),s.generation,s.phase === "active" ? "queued" : "held"]);
      return count.n;
    });
  }
  async begin(input: TrustedKey): Promise<TrustedStart | null> {
    const key = keySchema.parse(input);
    return this.transaction(async db => {
      const s = await this.session(db,key,true);
      if (!engineTraits[s.engine].trustedContext) throw new TrustedContextError("denied");
      if (s.phase !== "active") throw new TrustedContextError("busy");
      const {rows:[r]} = await db.query<{request_id:string;phase:string;prompt:string;generation:number}>(`SELECT * FROM birbcrew_ts.trusted_requests
        WHERE conversation_id=$1 AND phase IN ('queued','held','running') ORDER BY position LIMIT 1 FOR UPDATE`,[key.conversationId]);
      if (!r) return null;
      if (r.phase !== "queued") throw new TrustedContextError("busy");
      if (r.generation !== s.generation) throw new TrustedContextError("stale");
      await this.allowed(this.authority(s,"dispatch",r.request_id));
      const token = randomUUID();
      await db.query("UPDATE birbcrew_ts.trusted_requests SET phase='running',token=$3 WHERE conversation_id=$1 AND request_id=$2",[key.conversationId,r.request_id,token]);
      return { claim:{...key,requestId:r.request_id,generation:s.generation,token},engine:s.engine,memberId:s.member_id,threadId:s.native_thread_id,
        text:r.prompt,context:s.context_text!,checkpoint:s.checkpoint,
        binding:digest({ownerId:key.ownerId,conversationId:key.conversationId,scope:s.scope,version:s.context_version,generation:s.generation,application:s.application_digest}) };
    });
  }
  private async current(db: Pool | PoolClient | Client, claim: TrustedClaim, lock = false) {
    await requireRecoveryActive(db);
    const s = await this.session(db,{ownerId:claim.ownerId,conversationId:claim.conversationId},lock);
    if (s.phase !== "active" || s.generation !== claim.generation) throw new TrustedContextError("stale");
    const r = await db.query(`SELECT 1 FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1 AND request_id=$2
      AND generation=$3 AND token=$4 AND phase='running'`,[claim.conversationId,claim.requestId,claim.generation,claim.token]);
    if (!r.rowCount) throw new TrustedContextError("stale");
    return s;
  }
  /** Shared PostgreSQL lease, not a process-local mutex. Barrier obtains exclusive lease. */
  async admitted<T>(claim: TrustedClaim, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Native leases use a dedicated connection so long-running SDKs cannot exhaust
    // the control/query pool required for invalidation and receipt settlement.
    const db = new Client({...this.pool.options, application_name:"birbcrew-trusted-native-lease"}); await db.connect();
    const controller = new AbortController();
    const bounded = AbortSignal.any([signal,controller.signal]);
    let checking = false;
    const stop = () => controller.abort();
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await db.query("BEGIN");
      await acquireRecoveryNativeLease(db);
      await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,71))",[claim.conversationId]);
      await this.current(db,claim);
      db.on("error",stop); db.on("end",stop);
      timer = setInterval(async () => {
        if (checking || bounded.aborted) return; checking = true;
        try { await this.current(this.pool,claim); } catch { stop(); } finally { checking = false; }
      },50);
      bounded.throwIfAborted();
      return await run(bounded);
    } finally {
      if (timer) clearInterval(timer); db.off("error",stop); db.off("end",stop);
      try { await db.query("ROLLBACK"); } finally { await db.end(); }
    }
  }
  /** Commits the generation fence before any native cancellation notification. */
  async invalidate(input: TrustedKey, expectedGeneration: number, next: ContextSnapshot, cancel?: () => void | Promise<void>): Promise<number> {
    const snapshot = snapshotSchema.parse(next);
    const generation = await this.transaction(async db => {
      const s = await this.session(db,input,true);
      if (s.generation !== expectedGeneration || s.phase !== "active") throw new TrustedContextError("conflict");
      await this.allowed({...this.authority(s,"open"),scope:snapshot.scope,version:snapshot.version});
      if (s.scope === snapshot.scope && s.context_version === snapshot.version) throw new TrustedContextError("conflict");
      await db.query(`UPDATE birbcrew_ts.trusted_sessions SET generation=generation+1,phase='draining',scope=$2,context_version=$3,
        context_text=$4,checkpoint=NULL,native_thread_id=gen_random_uuid() WHERE conversation_id=$1`,[s.conversation_id,snapshot.scope,snapshot.version,snapshot.text]);
      await db.query("UPDATE birbcrew_ts.trusted_requests SET phase='held' WHERE conversation_id=$1 AND phase='queued'",[s.conversation_id]);
      return s.generation+1;
    });
    await cancel?.();
    return generation;
  }
  /** Nonblocking barrier: no new SDK admitted until every surviving old lease drains. */
  async finishRotation(input: TrustedKey): Promise<void> {
    await this.transaction(async db => {
      const lease = await db.query<{ok:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,71)) AS ok",[input.conversationId]);
      if (!lease.rows[0].ok) throw new TrustedContextError("busy");
      const s = await this.session(db,input,true);
      if (s.phase !== "draining") throw new TrustedContextError("conflict");
      await db.query("UPDATE birbcrew_ts.trusted_requests SET phase='cancelled',prompt=NULL WHERE conversation_id=$1 AND phase='running'",[s.conversation_id]);
      await db.query("UPDATE birbcrew_ts.trusted_tool_calls SET outcome='uncertain' WHERE conversation_id=$1 AND outcome='admitted'",[s.conversation_id]);
      await db.query("UPDATE birbcrew_ts.trusted_sessions SET phase='active' WHERE conversation_id=$1",[s.conversation_id]);
    });
  }
  /** Explicitly reauthorize held prompts in their original order, or cancel them. */
  async releaseHeld(input: TrustedKey, requestId: string, disposition: "run" | "cancel") {
    z.enum(["run","cancel"]).parse(disposition);
    await this.transaction(async db => {
      const s = await this.session(db,input,true);
      if (s.phase !== "active") throw new TrustedContextError("busy");
      if (disposition === "run") await this.allowed(this.authority(s,"submit",requestId));
      const changed = await db.query(`UPDATE birbcrew_ts.trusted_requests SET phase=$3,generation=$4,
        prompt=CASE WHEN $3='cancelled' THEN NULL ELSE prompt END WHERE conversation_id=$1 AND request_id=$2 AND phase='held'`,
      [s.conversation_id,requestId,disposition === "run" ? "queued" : "cancelled",s.generation]);
      if (!changed.rowCount) throw new TrustedContextError("conflict");
    });
  }
  async dispatch(claim: TrustedClaim, nativeCallId: string, toolName: string, args: unknown, signal: AbortSignal): Promise<{text:string;isError:boolean}> {
    text(256).parse(nativeCallId);
    const tool = this.application.tools.find(t => t.name === toolName);
    if (!tool) throw new TrustedContextError("denied");
    const encoded = canonical(z.json().parse(args));
    if (Buffer.byteLength(encoded) > tool.maxArgumentBytes) throw new TrustedContextError("limit");
    const parsed = z.fromJSONSchema(tool.inputSchema).parse(args);
    const fingerprint = digest({toolName,args:parsed});
    let authority!: Authorization;
    const admission = await this.transaction(async db => {
      const s = await this.current(db,claim,true); authority = {...this.authority(s,"dispatch",claim.requestId,toolName),arguments:parsed};
      await this.allowed(authority); signal.throwIfAborted();
      const {rows:[prior]} = await db.query<{argument_digest:string;outcome:string;result:unknown;operation_id:string}>(`SELECT * FROM birbcrew_ts.trusted_tool_calls
        WHERE conversation_id=$1 AND request_id=$2 AND native_call_id=$3`,[claim.conversationId,claim.requestId,nativeCallId]);
      if (prior) {
        if (prior.argument_digest !== fingerprint) throw new TrustedContextError("conflict");
        if (prior.outcome !== "completed") throw new TrustedContextError("uncertain");
        return { existing:true,result:prior.result,operationId:prior.operation_id };
      }
      const {rows:[count]} = await db.query<{n:number}>("SELECT count(*)::int AS n FROM birbcrew_ts.trusted_tool_calls WHERE conversation_id=$1 AND request_id=$2",[claim.conversationId,claim.requestId]);
      if (count.n >= 16) throw new TrustedContextError("limit");
      const operationId = randomUUID();
      await db.query(`INSERT INTO birbcrew_ts.trusted_tool_calls (conversation_id,request_id,native_call_id,generation,tool_name,argument_digest,operation_id,kind,scope,context_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[claim.conversationId,claim.requestId,nativeCallId,claim.generation,toolName,fingerprint,operationId,tool.kind,s.scope,s.context_version]);
      return {existing:false,operationId,result:undefined};
    });
    let result = admission.result;
    if (!admission.existing) {
      try {
        const deadline = AbortSignal.any([signal,AbortSignal.timeout(tool.deadlineMs)]);
        // The public deadline is finite. A noncooperative trusted callback retains its
        // shared DB lease in the background until settlement, holding rotation closed.
        // Process death drops the lease but leaves an explicit uncertain receipt.
        const work = this.admitted(claim,deadline,async bounded => {
          bounded.throwIfAborted();
          const value = z.json().parse(await tool.execute({args:parsed,operationId:admission.operationId,signal:bounded,authority}));
          if (Buffer.byteLength(canonical(value)) > tool.maxResultBytes) throw new TrustedContextError("limit");
          // Record an outcome even after revocation; it is NOT released to the SDK.
          await this.transaction(async db => {
            // Lock the conversation before the session, as open() does: the audit row's
            // foreign key needs the conversation, and the opposite order can deadlock.
            const {rows:[owner]} = await db.query<{owner_id:string;member_id:string}>(
              "SELECT owner_id,member_id FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR KEY SHARE",[claim.conversationId]);
            // Unreachable while trusted_sessions references conversations; never commit an effect without its audit row.
            if (!owner) throw new TrustedContextError("stale");
            // Even a callback surviving a dropped DB lease cannot resurrect erased data.
            const {rows:[session]} = await db.query<{phase:string}>("SELECT phase FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1 FOR UPDATE",[claim.conversationId]);
            if (session?.phase === "deleted") throw new TrustedContextError("stale");
            const completed = await db.query(`UPDATE birbcrew_ts.trusted_tool_calls SET outcome='completed',result=$4
              WHERE conversation_id=$1 AND request_id=$2 AND native_call_id=$3 AND outcome IN ('admitted','uncertain')`,
              [claim.conversationId,claim.requestId,nativeCallId,JSON.stringify(value)]);
            if (completed.rowCount && tool.kind === "effect") await appendAudit(db, {type:"trusted_effect.completed",
              ownerId:owner.owner_id,memberId:owner.member_id,conversationId:claim.conversationId,requestId:claim.requestId,
              payload:{operationId:admission.operationId,toolName}});
          });
          return value;
        });
        let abort!: () => void;
        const stopped = new Promise<never>((_,reject) => {
          abort = () => reject(new TrustedContextError("uncertain"));
          deadline.addEventListener("abort",abort,{once:true});
          if (deadline.aborted) abort();
        });
        try { result = await Promise.race([work,stopped]); }
        finally { deadline.removeEventListener("abort",abort); }

      } catch (error) {
        await this.pool.query(`UPDATE birbcrew_ts.trusted_tool_calls SET outcome='uncertain' WHERE conversation_id=$1 AND request_id=$2 AND native_call_id=$3 AND outcome='admitted'`,[claim.conversationId,claim.requestId,nativeCallId]);
        throw error instanceof TrustedContextError ? error : new TrustedContextError("uncertain");
      }
    }
    return this.transaction(async db => {
      const s = await this.current(db,claim,true);
      await this.allowed({...this.authority(s,"release",claim.requestId,toolName),arguments:parsed}); signal.throwIfAborted();
      await db.query("UPDATE birbcrew_ts.trusted_tool_calls SET released=true WHERE conversation_id=$1 AND request_id=$2 AND native_call_id=$3",[claim.conversationId,claim.requestId,nativeCallId]);
      return {text:canonical(result),isError:false};
    });
  }
  async acknowledge(claim: TrustedClaim, nativeCallId: string, toolName: string) {
    await this.transaction(async db => {
      await this.current(db,claim,true);
      const changed = await db.query(`UPDATE birbcrew_ts.trusted_tool_calls SET acknowledged=true WHERE conversation_id=$1
        AND request_id=$2 AND native_call_id=$3 AND tool_name=$4 AND released AND outcome='completed'`,[claim.conversationId,claim.requestId,nativeCallId,toolName]);
      if (!changed.rowCount) throw new TrustedContextError("conflict");
    });
  }
  async commit(claim: TrustedClaim, reply: string, checkpoint: unknown) {
    text(65_536).parse(reply); z.json().parse(checkpoint);
    if (Buffer.byteLength(canonical(checkpoint)) > 4*1024*1024) throw new TrustedContextError("limit");
    await this.transaction(async db => {
      const s = await this.current(db,claim,true); await this.allowed(this.authority(s,"output",claim.requestId));
      await db.query("UPDATE birbcrew_ts.trusted_sessions SET checkpoint=$2 WHERE conversation_id=$1",[claim.conversationId,JSON.stringify(checkpoint)]);
      await db.query("UPDATE birbcrew_ts.trusted_requests SET phase='completed',reply=$3,prompt=NULL WHERE conversation_id=$1 AND request_id=$2",[claim.conversationId,claim.requestId,reply]);
    });
  }
  async result(input: TrustedKey, requestId: string) {
    return this.transaction(async db => {
      const s = await this.session(db,input,true);
      await this.allowed(this.authority(s,"output",requestId));
      const {rows:[r]} = await db.query<{phase:string;reply:string|null;generation:number}>("SELECT phase,reply,generation FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1 AND request_id=$2",[input.conversationId,requestId]);
      if (!r) throw new TrustedContextError("not_found");
      // Prior-generation output is never newly disclosed through this API.
      return {phase:r.phase,reply:r.generation === s.generation && s.phase === "active" ? r.reply : null};
    });
  }
  /** After a worker dies, classify rather than replay an unfinished native turn.
   * An active worker/effect lease makes this busy. Retained receipt IDs are safe to
   * reconcile with the application; no callback is invoked by recovery.
   */
  async recover(input: TrustedKey, requestId?: string) {
    if (requestId !== undefined) z.uuid().parse(requestId);
    return this.transaction(async db => {
      const lease = await db.query<{ok:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,71)) AS ok",[input.conversationId]);
      if (!lease.rows[0].ok) throw new TrustedContextError("busy");
      const s = await this.session(db,input,true);
      const {rows:[r]} = await db.query<{request_id:string;phase:string}>(`SELECT request_id,phase FROM birbcrew_ts.trusted_requests
        WHERE conversation_id=$1 AND phase IN ('running','uncertain','cancelled') AND ($2::uuid IS NULL OR request_id=$2)
        ORDER BY (phase='running') DESC,position DESC LIMIT 1`,[input.conversationId,requestId ?? null]);
      if (!r) return null;
      await this.allowed(this.authority(s,"output",r.request_id));
      if (r.phase === "running" && s.phase !== "active") throw new TrustedContextError("busy");
      await db.query("UPDATE birbcrew_ts.trusted_tool_calls SET outcome='uncertain' WHERE conversation_id=$1 AND request_id=$2 AND outcome='admitted'",[input.conversationId,r.request_id]);
      const {rows:calls} = await db.query<{operationId:string;toolName:string;outcome:string;released:boolean;acknowledged:boolean;scope:string|null;version:string|null}>(`SELECT operation_id AS "operationId",tool_name AS "toolName",outcome,released,acknowledged,scope,context_version AS version
        FROM birbcrew_ts.trusted_tool_calls WHERE conversation_id=$1 AND request_id=$2 ORDER BY native_call_id`,[input.conversationId,r.request_id]);
      // Reconciliation authority is checked against each original operation, never
      // inferred from access to the replacement scope. No arguments/results escape.
      for (const call of calls) {
        if (call.scope === null || call.version === null) throw new TrustedContextError("denied");
        await this.allowed({...this.authority(s,"receipt",r.request_id,call.toolName),
          scope:call.scope,version:call.version,operationId:call.operationId});
      }
      const receipts = calls.map(({scope:_,version:__,...receipt}) => receipt);
      if (r.phase !== "running") return {requestId:r.request_id,outcome:"uncertain" as const,receipts};
      await db.query("UPDATE birbcrew_ts.trusted_requests SET phase='uncertain',prompt=NULL WHERE conversation_id=$1 AND request_id=$2",[input.conversationId,r.request_id]);
      await db.query("UPDATE birbcrew_ts.trusted_requests SET phase='held' WHERE conversation_id=$1 AND phase='queued'",[input.conversationId]);
      await db.query("UPDATE birbcrew_ts.trusted_sessions SET generation=generation+1,phase='draining',checkpoint=NULL,native_thread_id=gen_random_uuid() WHERE conversation_id=$1",[input.conversationId]);
      return {requestId:r.request_id,outcome:"uncertain" as const,receipts};
    });
  }
  /** Enumerate exact generation directories for operator-owned private-volume erasure.
   * Does not delete files itself; caller must stop/drain native work first.
   */
  async nativeStateForDeletion(input: TrustedKey) {
    return this.transaction(async db => {
      const s = await this.session(db,input,true);
      if (s.phase !== "draining") throw new TrustedContextError("conflict");
      const {rows} = await db.query<{generation:number;threadId:string}>(`SELECT generation,native_thread_id AS "threadId"
        FROM birbcrew_ts.trusted_generations WHERE conversation_id=$1 ORDER BY generation`,[input.conversationId]);
      return {engine:s.engine,memberId:s.member_id,ownerId:s.owner_id,generations:rows};
    });
  }
  /** Destructive content erasure after the durable drain barrier. Keep minimal replay tombstones. */
  async erase(input: TrustedKey) {
    await this.transaction(async db => {
      const lease = await db.query<{ok:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,71)) AS ok",[input.conversationId]);
      if (!lease.rows[0].ok) throw new TrustedContextError("busy");
      const s = await this.session(db,input,true);
      if (s.phase !== "draining") throw new TrustedContextError("conflict");
      await db.query("UPDATE birbcrew_ts.trusted_sessions SET phase='deleted',context_text=NULL,checkpoint=NULL WHERE conversation_id=$1",[input.conversationId]);
      await db.query("UPDATE birbcrew_ts.trusted_requests SET prompt=NULL,reply=NULL,phase='cancelled' WHERE conversation_id=$1",[input.conversationId]);
      await db.query("DELETE FROM birbcrew_ts.conversation_notes WHERE conversation_id=$1",[input.conversationId]);
      await db.query("UPDATE birbcrew_ts.trusted_tool_calls SET result=NULL,outcome='uncertain',scope=NULL,context_version=NULL WHERE conversation_id=$1",[input.conversationId]);
    });
  }
}
