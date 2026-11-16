import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Client, type Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { fenceEpochLimit, RecoveryRefusedError, type RecoveryFence } from './recovery-fence.ts';
import { appendAudit } from './audit.ts';
import { changeDelegationControl } from './delegation-control.ts';
import { settleRestoredWebhooks } from './webhooks.ts';
export { RecoveryRefusedError } from './recovery-fence.ts';

const id=z.uuid();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema=z.strictObject({kind:z.enum(['application-postgres','temporal-persistence','native-volumes','configuration','consumer-state']),file:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),bytes:z.number().int().nonnegative(),sha256:digest});
export const recoveryManifest=z.strictObject({
 format:z.literal('birbcrew-recovery-v1'),generation:id,installation:id,sourceInstance:id,
 createdAt:z.iso.datetime(),applicationCommit:z.string().regex(/^[a-f0-9]{40}$/),lockfileSha256:digest,
 schemaVersions:z.array(z.number().int().positive()).min(1),
 temporal:z.strictObject({serverVersion:z.string().min(1).max(128),persistenceFormat:z.string().min(1).max(128),mode:z.enum(['persistent','development-fixture'])}),
 logicalNativeRoot:z.string().startsWith('/').max(4096),
 artifacts:z.array(artifactSchema).min(4).max(5),
 // Aggregate counts only. Never native contents, prompts, endpoints or credentials.
 inventory:z.record(z.string().regex(/^[a-z_]+$/),z.number().int().nonnegative()),
 pendingPolicy:z.literal('hold-until-reconciled'),
});
export type RecoveryManifest=z.infer<typeof recoveryManifest>;
export type RecoveryPins=Pick<RecoveryManifest,'applicationCommit'|'lockfileSha256'|'temporal'|'logicalNativeRoot'>;
type Control={installation:string;instance:string;phase:'active'|'frozen'|'restored';generation:string|null};
// A restored timeline's audit IDs are [epoch<<44, (epoch+1)<<44). Epochs below fenceEpochLimit keep the last one within 2^63-1.
const auditEpochBits=44n;
// The highest audit ID the identity has drawn. Committed rows count because the identity's
// last value is null when nothing was drawn since a setval(...,false), as after an earlier
// acceptance. Its last value counts IDs whose transactions rolled back: no consumer saw them,
// but they place the dump's timeline in its epoch, and it may have committed more there after
// the capture. Either raises the epoch only when the fence lost its epoch or a timeline
// overran its range.
const restoredAuditId=`greatest(coalesce(pg_sequence_last_value(pg_get_serial_sequence('birbcrew_ts.audit_events','event_id')::regclass),0),
  (SELECT coalesce(max(event_id),0) FROM birbcrew_ts.audit_events))`;
/** A restore can bring back grants revoked after its recovery point, and member memories deleted
 * after it, text and all. So a restored installation revokes every standing grant and suspends
 * every active memory as it resumes. It runs in the activation's transaction: the write barrier
 * admits it only once `activate` has made the installation active there, and a crash leaves
 * neither. Conversations are locked first, before the activation, as every revocation locks a
 * conversation before its grant (grants.ts). Memories need no such order: until this transaction
 * commits, any other write meets the barrier and fails, so a delete holding an entry's row lock
 * rolls back and releases it. */
async function settleRestoredState(db:PoolClient,activate:()=>Promise<boolean>) {
 await db.query(`SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id IN
  (SELECT conversation_id FROM birbcrew_ts.tool_grants WHERE revoked_at IS NULL) ORDER BY conversation_id FOR UPDATE`);
 if(!await activate()) return;
 const {rows:[control]}=await db.query<{revision:string}>('SELECT revision::text FROM birbcrew_ts.delegation_control WHERE singleton');
 await changeDelegationControl(db,{commandId:randomUUID(),expectedRevision:control.revision,scope:{kind:'global'},
  enabled:false,actor:'recovery',reason:'restored installation activation'});
 await db.query("UPDATE birbcrew_ts.profiles SET child_target_active='{}' WHERE child_target_seal->>'mode'='named'");
 const {rows}=await db.query<{grant_id:string;owner_id:string;member_id:string;conversation_id:string|null}>(`WITH revoked AS
  (UPDATE birbcrew_ts.tool_grants SET revoked_at=clock_timestamp(),revocation_reason='recovery_restore' WHERE revoked_at IS NULL
   RETURNING grant_id,owner_id,member_id,conversation_id,created_at)
  SELECT grant_id,owner_id,member_id,conversation_id FROM revoked ORDER BY created_at,grant_id`);
 for(const grant of rows) await appendAudit(db,{type:'grant.revoked',ownerId:grant.owner_id,memberId:grant.member_id,
  conversationId:grant.conversation_id??undefined,payload:{grantId:grant.grant_id,reason:'recovery_restore'}});
 // Suspended, not deleted: the owner can read what came back, then delete it and create again.
 const {rows:memories}=await db.query<{memory_id:string;owner_id:string;member_id:string}>(`WITH suspended AS
  (UPDATE birbcrew_ts.member_memories SET state='suspended',changed_at=clock_timestamp() WHERE state='active'
   RETURNING memory_id,owner_id,member_id,created_at)
  SELECT memory_id,owner_id,member_id FROM suspended ORDER BY created_at,memory_id`);
 for(const memory of memories) await appendAudit(db,{type:'memory.suspended',ownerId:memory.owner_id,memberId:memory.member_id,
  payload:{memoryId:memory.memory_id,reason:'recovery_restore'}});
 // Webhook endpoints are disabled and undelivered rows cancelled: nothing from before the restore is sent.
 await settleRestoredWebhooks(db);
}
export type SnapshotArtifact={kind:RecoveryManifest['artifacts'][number]['kind'];file:string};
/** Hooks are trusted operator code, not user/AG-UI input. They must stop ALL
 * consumers/workers/native descendants and await teardown, and stop/fence the
 * Temporal server before snapshotting its supported persistence. No process
 * evidence can be inferred from a database flag alone. Throw if uncertain. */
export interface RecoveryHooks {
 quiesce():Promise<void>;
 snapshot(directory:string):Promise<SnapshotArtifact[]>;
 /** Explicit operator reconciliation including effects committed after RPO,
  * external delivery acknowledgements, and process-bound decisions. A successful
  * callback must not blindly replay pending/uncertain effects. */
 reconcile(manifest:RecoveryManifest|null):Promise<void>;
}
async function sha(path:string) {const hash=createHash('sha256');for await(const chunk of createReadStream(path)) hash.update(chunk);return hash.digest('hex');}
export async function readRecoveryManifest(directory:string) {
 const raw=await readFile(join(directory,'manifest.json'));
 const expected=(await readFile(join(directory,'manifest.sha256'),'utf8')).trim();
 if(createHash('sha256').update(raw).digest('hex')!==digest.parse(expected)) throw new Error('Manifest checksum mismatch');
 const manifest=recoveryManifest.parse(JSON.parse(raw.toString()));
 const kinds=new Set<string>();const names=new Set<string>();
 for(const artifact of manifest.artifacts) {
  if(kinds.has(artifact.kind)||names.has(artifact.file)) throw new Error('Duplicate snapshot artifact');
  kinds.add(artifact.kind);names.add(artifact.file);
  const path=join(directory,artifact.file);const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==artifact.bytes||await sha(path)!==artifact.sha256) throw new Error('Snapshot artifact mismatch');
 }
 for(const kind of ['application-postgres','temporal-persistence','native-volumes','configuration']) if(!kinds.has(kind)) throw new Error('Incomplete recovery generation');
 return manifest;
}
export class InstallationRecovery {
 readonly pool:Pool; readonly fence:RecoveryFence;
 constructor(pool:Pool,fence:RecoveryFence) {this.pool=pool;this.fence=fence;}
 private async operation<T>(run:()=>Promise<T>):Promise<T> {
  const db=new Client({...this.pool.options,application_name:'birbcrew-recovery-controller'});await db.connect();
  try {await db.query("SET lock_timeout='10s'");await db.query("SELECT pg_advisory_lock(hashtextextended('birbcrew.recovery.controller',0))");return await run();}
  finally {await db.end();}
 }
 async initializeFence() {return this.operation(()=>this.initializeFenceImpl());}
 async freeze(generation?:string) {return this.operation(()=>this.freezeImpl(generation));}
 async capture(directory:string,pins:RecoveryPins,hooks:RecoveryHooks) {return this.operation(()=>this.captureImpl(directory,pins,hooks));}
 async acceptRestore(directory:string,pins:RecoveryPins,targetInstance:string,currentSourceInstance?:string) {return this.operation(()=>this.acceptRestoreImpl(directory,pins,targetInstance,currentSourceInstance));}
 async resume(hooks:Pick<RecoveryHooks,'reconcile'>,manifest:RecoveryManifest|null=null) {return this.operation(()=>this.resumeImpl(hooks,manifest));}
 private async quiesce(hooks:Pick<RecoveryHooks,'quiesce'>) {
  await hooks.quiesce();
  // Independently await all instrumented native admissions, even if an operator
  // hook accidentally returns before a surviving SDK tears down.
  const barrier=await this.pool.connect();
  try {await barrier.query("BEGIN");await barrier.query("SET LOCAL lock_timeout='10s'");await barrier.query("SELECT pg_advisory_xact_lock(hashtextextended('birbcrew.recovery.native',0))");await barrier.query("COMMIT");}
  catch(e){await barrier.query("ROLLBACK");throw e;}finally{barrier.release();}
 }
 async holdForRestore(generation:string,hooks:Pick<RecoveryHooks,'quiesce'>) {
  return this.operation(async()=>{const actual=await this.freezeImpl(generation);if(actual!==generation) throw new Error('Another generation is held');await this.quiesce(hooks);const {control:c}=await this.status();await this.fence.seal(c.installation,c.instance,actual);return {generation:actual};});
 }
 async status() {
  const control=(await this.pool.query<Control>(`SELECT installation_id AS installation,instance_id AS instance,phase,generation FROM birbcrew_ts.recovery_control WHERE singleton`)).rows[0];
  if(!control) throw new Error('Recovery schema missing');
  const latest=(await this.pool.query<{generation:string;completedAt:Date;sha256:string}>(`SELECT generation,completed_at AS "completedAt",manifest_sha256 AS sha256 FROM birbcrew_ts.recovery_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1`)).rows[0]??null;
  return {control,latest};
 }
 private async initializeFenceImpl() {const {control:c}=await this.status();if(c.phase!=='active') throw new Error('Initialize only an active installation');await this.fence.initialize(c.installation,c.instance);}
 /** Durable write barrier is established BEFORE teardown. Running requests cannot
  * write completion after it. Their unchanged started/pending/uncertain records
  * are held for operator reconciliation, not asserted to be cancelled. */
 private async freezeImpl(generation:string=randomUUID()) {
  id.parse(generation);
  const {control:c}=await this.status();
  if(c.phase==='restored') throw new Error('Restored installation requires reconciliation');
  const actual=c.generation??generation;
  const db=await this.pool.connect();
  try {
   await db.query('BEGIN');
   await db.query("SET LOCAL lock_timeout='10s'");
   const changed=await db.query(`UPDATE birbcrew_ts.recovery_control SET phase='frozen',generation=$1 WHERE singleton AND instance_id=$2 AND (phase='active' OR (phase='frozen' AND generation=$1)) RETURNING 1`,[actual,c.instance]);
   if(!changed.rowCount) throw new Error('Recovery state changed');
   await db.query('INSERT INTO birbcrew_ts.recovery_runs(generation) VALUES($1) ON CONFLICT DO NOTHING',[actual]);
   await db.query('COMMIT');
  } catch(e) {await db.query('ROLLBACK');throw e;} finally {db.release();}
  await this.fence.hold(c.installation,c.instance,actual);
  return actual;
 }
 private async inventory() {
  const tables=(await this.pool.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname='birbcrew_ts' AND tablename NOT IN ('recovery_control','recovery_runs') ORDER BY tablename`)).rows;
  const counts:Record<string,number>={};
  for(const {tablename} of tables) {
   if(!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table identifier');
   const trigger=await this.pool.query(`SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='recovery_write_barrier' AND tgenabled='O'`,[`birbcrew_ts.${tablename}`]);
   if(!trigger.rowCount) throw new Error('Unfenced schema table; recovery upgrade required');
   counts[tablename]=Number((await this.pool.query(`SELECT count(*)::text AS n FROM birbcrew_ts."${tablename}"`)).rows[0].n);
  }
  return counts;
 }
 private async captureImpl(directory:string,pins:RecoveryPins,hooks:RecoveryHooks) {
  const generation=await this.freezeImpl();
  const {control:c}=await this.status();
  if((await this.pool.query("SELECT 1 FROM birbcrew_ts.recovery_runs WHERE generation=$1 AND completed_at IS NOT NULL",[generation])).rowCount) throw new Error("Generation already captured; resume then begin a new generation");
  await this.quiesce(hooks);
  await this.fence.verify(c.installation,c.instance,generation);
  const inventory=await this.inventory();
  const schemaVersions=(await this.pool.query<{version:number}>('SELECT version FROM birbcrew_ts.schema_versions ORDER BY version')).rows.map(x=>x.version);
  const assets=await hooks.snapshot(directory);
  const artifacts=[];
  for(const asset of assets) {
   if(asset.file!==basename(asset.file)||asset.file==='manifest.json'||asset.file==='manifest.sha256') throw new Error('Invalid artifact name');
   const path=join(directory,asset.file);const stat=await lstat(path);
   if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Snapshot must be a regular file');
   const file=await open(path,'r');try{await file.sync();}finally{await file.close();}
   artifacts.push({...asset,bytes:stat.size,sha256:await sha(path)});
  }
  const manifest=recoveryManifest.parse({format:'birbcrew-recovery-v1',generation,installation:c.installation,sourceInstance:c.instance,createdAt:new Date().toISOString(),...pins,schemaVersions,artifacts,inventory,pendingPolicy:'hold-until-reconciled'});
  await this.fence.verify(c.installation,c.instance,generation);
  const {control:after}=await this.status();
  if(after.phase!=='frozen'||after.generation!==generation) throw new Error('Snapshot boundary changed');
  const raw=JSON.stringify(manifest,null,2)+'\n';const checksum=createHash('sha256').update(raw).digest('hex');
  // Exclusive files: retries use a fresh destination, never replace a prior bundle.
  await writeFile(join(directory,'manifest.json'),raw,{flag:'wx',mode:0o600,flush:true});
  await writeFile(join(directory,'manifest.sha256'),checksum+'\n',{flag:'wx',mode:0o600,flush:true});
  await readRecoveryManifest(directory);
  // File flush alone does not persist newly created directory entries. Do not
  // authorize transfer or record success until manifest and artifacts are durable.
  for(const path of [directory,dirname(directory)]) {const bundle=await open(path,'r');try{await bundle.sync();}finally{await bundle.close();}}
  await this.fence.seal(c.installation,c.instance,generation);
  await this.pool.query(`UPDATE birbcrew_ts.recovery_runs SET completed_at=now(),manifest_sha256=$2 WHERE generation=$1`,[generation,checksum]);
  return {generation,sha256:checksum};
 }
 /** Call ONLY after operator restores all verified artifacts into an isolated,
  * stopped target. No native path/index rewrite: same logical container mount. */
 private async acceptRestoreImpl(directory:string,pins:RecoveryPins,targetInstance:string,currentSourceInstance?:string) {
  id.parse(targetInstance);
  const manifest=await readRecoveryManifest(directory);
  // Artifact provenance is not necessarily the current live owner. A retained A
  // backup may be restored after A→B only after B has been held for this generation.
  const sourceInstance=id.parse(currentSourceInstance??manifest.sourceInstance);
  if(sourceInstance===targetInstance) throw new Error("Restore needs a new instance identity");
  if(pins.applicationCommit!==manifest.applicationCommit||pins.lockfileSha256!==manifest.lockfileSha256||pins.logicalNativeRoot!==manifest.logicalNativeRoot||pins.temporal.mode!==manifest.temporal.mode||pins.temporal.serverVersion!==manifest.temporal.serverVersion||pins.temporal.persistenceFormat!==manifest.temporal.persistenceFormat) throw new Error('Recovery version/configuration mismatch');
  const {control:c}=await this.status();
  const schemas=(await this.pool.query<{version:number}>('SELECT version FROM birbcrew_ts.schema_versions ORDER BY version')).rows.map(x=>x.version);
  if(JSON.stringify(schemas)!==JSON.stringify(manifest.schemaVersions)||c.installation!==manifest.installation||c.generation!==manifest.generation||c.phase==='active'||targetInstance===manifest.sourceInstance||!(c.instance===manifest.sourceInstance||c.instance===targetInstance)) throw new Error('Restored database does not match generation');
  // Checksums cannot authenticate a bundle. Its source/manifest must be trusted;
  // preserve the manifest digest in the operator's independent backup catalog.
  const restoredInventory=await this.inventory();
  if(JSON.stringify(restoredInventory)!==JSON.stringify(manifest.inventory)) throw new Error("Restored inventory does not match generation");
  // Every refusal that can be decided from the restored database comes before the transfer,
  // which fences out the source for good.
  const {restored,minimumEpoch}=await this.restoredAuditIdentity();
  if(minimumEpoch>=fenceEpochLimit) throw new RecoveryRefusedError(`The restored audit identity has drawn event ID ${restored}, so this restore needs audit identity epoch ${minimumEpoch}, past the last, ${fenceEpochLimit-1}. Nothing was transferred: authority stays with the held source, which can resume.`);
  const epoch=await this.fence.transfer(c.installation,sourceInstance,targetInstance,manifest.generation,minimumEpoch);
  await this.advanceAuditIdentity(epoch,minimumEpoch,targetInstance);
  await this.pool.query(`UPDATE birbcrew_ts.recovery_control SET instance_id=$1,phase='restored' WHERE singleton`,[targetInstance]);
  return {generation:manifest.generation,instance:targetInstance,phase:'restored' as const};
 }
 /** The lowest epoch whose range lies above every audit ID the restored identity drew. The
  * held database draws none (its write barrier refuses an audit insert before the identity
  * is evaluated), and an acceptance's own setval leaves nothing drawn, so a retried
  * acceptance never needs a higher epoch than its first attempt. */
 private async restoredAuditIdentity() {
  const {rows:[row]}=await this.pool.query<{restored:string}>(`SELECT ${restoredAuditId}::text AS restored`);
  return {restored:row.restored,minimumEpoch:Number((BigInt(row.restored)>>auditEpochBits)+1n)};
 }
 /** The dump resumes the audit identity at the recovery point, so it would reissue IDs a
  * later timeline already gave consumers, who would then skip the new events. Each restored
  * timeline starts at its fence epoch times 2^44 instead. The fence is never restored and
  * every transfer raises its epoch, so a later restore, even of the same generation, starts
  * above every ID an earlier timeline drew, whatever the database clocks say. setval is not
  * a table write, so the held installation allows it. is_called=false leaves no drawn ID,
  * so a retry in the same epoch sets the same value again. */
 private async advanceAuditIdentity(epoch:number,minimumEpoch:number,target:string) {
  // Only a fence that ignores minimumEpoch or fenceEpochLimit gets here, and authority has already moved.
  if(!Number.isSafeInteger(epoch)||epoch<minimumEpoch) throw new RecoveryRefusedError(`The recovery fence returned ${Number.isSafeInteger(epoch)?`epoch ${epoch}`:'no epoch'} for this transfer, but this restore needs at least epoch ${minimumEpoch}. Authority has moved to target ${target}, whose database stays held, so the source cannot resume. Upgrade the fence so that RecoveryFence.transfer honours minimumEpoch and returns the epoch (see docs/coordinated-recovery.md), then retry accept-restore with the same target instance, ${target}.`);
  if(epoch>=fenceEpochLimit) throw new RecoveryRefusedError(`The recovery fence moved authority to target ${target} at epoch ${epoch}, past the last audit identity epoch, ${fenceEpochLimit-1}, instead of refusing the transfer. No epoch is left for new audit IDs, so no restore of this installation can be accepted without reissuing IDs consumers may hold.`);
  const floor=(BigInt(epoch)<<auditEpochBits).toString();
  const {rows:[identity]}=await this.pool.query<{moved:string|null}>(`SELECT CASE WHEN ${restoredAuditId}<$1::bigint
    THEN setval(pg_get_serial_sequence('birbcrew_ts.audit_events','event_id'),$1::bigint,false) END::text AS moved`,[floor]);
  // The write barrier refuses audit inserts before they draw, so only something outside Crew,
  // such as a direct nextval or setval, gets here. A retry recomputes the minimum past it.
  if(identity.moved===null) throw new RecoveryRefusedError(`The restored audit identity drew an ID in or past epoch ${epoch}'s range after acceptance checked it, while the installation was held, so acceptance left it unchanged. Authority has moved to target ${target}, whose database stays held, so the source cannot resume. Stop whatever is drawing from the audit identity outside Crew, then retry accept-restore with the same target instance, ${target}.`);
 }
 private async resumeImpl(hooks:Pick<RecoveryHooks,'reconcile'>,manifest:RecoveryManifest|null=null) {
  const {control:c}=await this.status();
  if(c.phase==='active'||!c.generation) throw new Error('Not held');
  if(c.phase==='restored'&&(!manifest||manifest.generation!==c.generation||manifest.installation!==c.installation)) throw new Error('Restored instance requires its manifest');
  await this.fence.verifyActivation(c.installation,c.instance,c.generation);
  await hooks.reconcile(manifest);
  await this.fence.activate(c.installation,c.instance,c.generation);
  const db=await this.pool.connect();
  try {
   await db.query('BEGIN');
   await db.query("SET LOCAL lock_timeout='10s'");
   const activate=async()=>Boolean((await db.query(`UPDATE birbcrew_ts.recovery_control SET phase='active',generation=NULL WHERE singleton AND instance_id=$1 AND generation=$2`,[c.instance,c.generation])).rowCount);
   if(c.phase==='restored') await settleRestoredState(db,activate); else await activate();
   await db.query('COMMIT');
  } catch(e) {await db.query('ROLLBACK');throw e;} finally {db.release();}
 }
}
