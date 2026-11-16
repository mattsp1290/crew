import { testDatabaseName } from "./database-fixtures.ts";
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test,type TestContext} from 'node:test';
import {Pool} from 'pg';
import {MemberStore} from '../../src/service/store.ts';
import {InstallationRecovery,readRecoveryManifest,RecoveryRefusedError,type RecoveryPins,type RecoveryHooks} from '../../src/service/recovery.ts';
import {FileRecoveryFence,fenceEpochLimit} from '../../src/service/recovery-fence.ts';
import {auditQuerySchema,readAudit} from '../../src/service/audit.ts';
import type {MemberClient} from '../../src/service/client.ts';
import {ownerInitiator,type TurnRequest} from '../../src/service/domain.ts';
import {IntegrationApi} from '../../src/service/integration-api.ts';
import {RoutineApi,RoutineDispatcher} from '../../src/service/routines.ts';
import {ApprovalStore} from '../../src/service/approvals.ts';
import {revokeGrant} from '../../src/service/grants.ts';
import {conversationContext,MemoryApi} from '../../src/service/memories.ts';
import {HandoffApi} from '../../src/service/handoffs.ts';
import {PackApi} from '../../src/service/instruction-packs.ts';
import {recordSegmentUsage,UsageApi} from '../../src/service/usage.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const url=process.env.BIRBCREW_TEST_DATABASE_URL;
if(!url) throw new Error('Set BIRBCREW_TEST_DATABASE_URL to disposable PostgreSQL17');
const admin=new Pool({connectionString:url});
after(()=>admin.end());
const pins:RecoveryPins={applicationCommit:'a'.repeat(40),lockfileSha256:'b'.repeat(64),temporal:{mode:'development-fixture',serverVersion:'1.10.0',persistenceFormat:'dev-sqlite-fixture'},logicalNativeRoot:'/var/lib/birbcrew/native'};
const teardowns=new WeakMap<TestContext,(()=>Promise<unknown>)[]>();
/** Registers a cleanup step to run, last registered first, after the test. An after hook never
 * replaces the test's own failure, as a throw from finally would; a failed assertion can leave
 * a session open, so DROP DATABASE can fail too. Every step runs even when one fails. */
function deferrer(context:TestContext) {
 let steps=teardowns.get(context);
 if(!steps) {
  const registered:(()=>Promise<unknown>)[]=[];teardowns.set(context,steps=registered);
  context.after(async()=>{
   const errors:unknown[]=[];
   for(const step of registered.reverse()) try{await step();}catch(error){errors.push(error);}
   if(errors.length) throw new AggregateError(errors,'Teardown failed');
  });
 }
 return (step:()=>Promise<unknown>)=>{steps.push(step);};
}
async function database(defer:ReturnType<typeof deferrer>) {
 const name=testDatabaseName('recovery_');
 await admin.query(`CREATE DATABASE ${name}`);
 // Not FORCE: end() resolves before its connections close, and terminating one then is an unhandled pool
 // error. A plain DROP waits up to 5 s for those sessions to exit, and fails loudly on a real leak.
 defer(()=>admin.query(`DROP DATABASE ${name}`));
 const u=new URL(url!);u.pathname='/'+name;
 const pool=new Pool({connectionString:u.toString()});defer(()=>pool.end());
 return {name,url:u.toString(),pool};
}
async function setup(context:TestContext) {
 const defer=deferrer(context);
 const {name,pool}=await database(defer);const store=new MemberStore(pool);await store.migrate();
 const directory=await mkdtemp(join(tmpdir(),'birbcrew-recovery-'));defer(()=>rm(directory,{recursive:true,force:true}));
 const fence=new FileRecoveryFence(join(directory,'external-fence'));
 const recovery=new InstallationRecovery(pool,fence);await recovery.initializeFence();
 const bundle=join(directory,'bundle');await mkdir(bundle);
 const hooks:RecoveryHooks={quiesce:async()=>{},snapshot:async dir=>{const artifacts=[];for(const kind of ['application-postgres','temporal-persistence','native-volumes','configuration'] as const){const file=kind+'.fixture';await writeFile(join(dir,file),'private fixture '+kind);artifacts.push({kind,file});}return artifacts;},reconcile:async()=>{}};
 return {name,pool,store,directory,fence,recovery,bundle,hooks,defer};
}
type Fixture=Awaited<ReturnType<typeof setup>>;

test('freeze blocks every domain writer including TRUNCATE, survives reconnect, and interrupted capture stays held',async context=>{
 const t=await setup(context);
 const c=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
 const generation=await t.recovery.freeze();
 await assert.rejects(t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'}),{code:'55000'});
 await assert.rejects(t.pool.query('TRUNCATE birbcrew_ts.public_events'),{code:'55000'});
 assert.equal(await new InstallationRecovery(t.pool,t.fence).freeze(),generation);
 await assert.rejects(t.recovery.capture(t.bundle,pins,{...t.hooks,quiesce:async()=>{throw new Error('native teardown failed');}}),/teardown failed/);
 assert.equal((await t.recovery.status()).control.phase,'frozen');
 assert.equal((await t.recovery.status()).latest,null);
 assert.equal((await t.pool.query('SELECT member_id FROM birbcrew_ts.members')).rows[0].member_id,c.memberId);
 await t.recovery.resume(t.hooks);
 await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
});

test('freeze waits for an already admitted writer before claiming a stable boundary',async context=>{
 const t=await setup(context);const writer=await t.pool.connect();t.defer(async()=>writer.release());
 await writer.query('BEGIN');await writer.query("INSERT INTO birbcrew_ts.members(owner_id,spawn_request_id,engine,profile) VALUES('owner',$1,'pi','fixture')",[randomUUID()]);
 let completed=false;const frozen=t.recovery.freeze().then(()=>{completed=true;});
 await new Promise(r=>setTimeout(r,75));assert.equal(completed,false);
 await writer.query('COMMIT');await frozen;assert.equal(completed,true);
});

test('capture produces checksummed generation and rejects tampering or an unfenced new table',async context=>{
 const t=await setup(context);
 const receipt=await t.recovery.capture(t.bundle,pins,t.hooks);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.equal(manifest.generation,receipt.generation);assert.equal((await t.recovery.status()).latest?.sha256,receipt.sha256);
 assert.equal(JSON.stringify(manifest).includes('private fixture'),false);
 await writeFile(join(t.bundle,manifest.artifacts[0].file),'tampered');
 await assert.rejects(readRecoveryManifest(t.bundle),/mismatch/);
 await t.pool.query('CREATE TABLE birbcrew_ts.unfenced_test(id int)');
 await assert.rejects(t.recovery.capture(t.bundle,pins,t.hooks),/already captured/);
 await t.recovery.resume(t.hooks);
 await assert.rejects(t.recovery.capture(t.bundle,pins,t.hooks),/Unfenced/);
});

test('source cannot resume after authority transfers; arbitrary second clone is rejected',async context=>{
 const t=await setup(context);
 const {generation}=await t.recovery.capture(t.bundle,pins,t.hooks);
 const {control:c}=await t.recovery.status();const target=randomUUID();
 await t.fence.transfer(c.installation,c.instance,target,generation);
 await assert.rejects(t.recovery.resume(t.hooks),/fenced/);
 await assert.rejects(t.fence.transfer(c.installation,c.instance,randomUUID(),generation),/overlap/);
 await assert.rejects(t.fence.hold(c.installation,c.instance,generation),/fenced/);
 assert.equal((await t.recovery.status()).control.phase,'frozen');
});

test('restore rejects version mismatch and leaves matching restore held until explicit reconciliation',async context=>{
 const t=await setup(context);
 await t.recovery.capture(t.bundle,pins,t.hooks);const target=randomUUID();
 await assert.rejects(t.recovery.acceptRestore(t.bundle,{...pins,applicationCommit:'c'.repeat(40)},target),/version/);
 await t.recovery.acceptRestore(t.bundle,pins,target);
 assert.equal((await t.recovery.status()).control.phase,'restored');
 await assert.rejects(t.recovery.resume(t.hooks),/manifest/);
 const manifest=await readRecoveryManifest(t.bundle);
 await assert.rejects(t.recovery.resume({reconcile:async()=>{throw new Error('possible post-RPO effect');}},manifest),/post-RPO/);
 assert.equal((await t.recovery.status()).control.phase,'restored');
 await t.recovery.resume(t.hooks,manifest);
 assert.equal((await t.recovery.status()).control.phase,'active');
});

async function postgresTool(tool:string,args:string[],input?:Buffer) {
 const container=process.env.BIRBCREW_RECOVERY_POSTGRES_CONTAINER;
 const command=container?'docker':join(process.env.BIRBCREW_PG_BIN??'/usr/bin',tool);
 const callArgs=container?['exec','-i',container,tool,...args]:args;
 return new Promise<Buffer>((resolve,reject)=>{
  const child=import('node:child_process').then(({spawn})=>{
   const proc=spawn(command,callArgs,{stdio:['pipe','pipe','pipe']});const chunks:Buffer[]=[];let error='';
   proc.stdout.on('data',chunk=>chunks.push(chunk));proc.stderr.on('data',chunk=>{error+=chunk.toString();});proc.once('error',reject);
   proc.once('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`${tool} failed (${code})`)));
   proc.stdin.on('error',()=>{});proc.stdin.end(input);
  });child.catch(reject);
 });
}
async function restoreBundle(t:Fixture,bundle=t.bundle) {
 const restored=await database(t.defer);
 await postgresTool('pg_restore',['--dbname',restored.url,'--no-owner'],await readFile(join(bundle,'application-postgres.fixture')));
 return restored.pool;
}

test('real PostgreSQL archive restores mappings, checkpoint, committed replay and observation to isolated database; pending remains held',async context=>{
 const t=await setup(context);
 const member=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
 const key={ownerId:'owner',conversationId:randomUUID()};await t.store.openConversation({...key,memberId:member.memberId});
 const request={...key,requestId:randomUUID(),text:'remember fixture'};
 const turn=await t.store.beginTurn(request);assert.equal(turn.kind,'start');
 await t.store.commitTurn({...key,requestId:request.requestId,token:turn.token,reply:'recorded',checkpoint:{version:1,engine:'pi',state:{fixture:'retained'}}});
 const pending={...key,requestId:randomUUID(),text:'pending fixture'};await t.store.beginTurn(pending);
 const sourceUrl=new URL(url!);sourceUrl.pathname='/'+t.name;
 await t.recovery.capture(t.bundle,pins,{...t.hooks,snapshot:async dir=>{
  const artifacts=await t.hooks.snapshot(dir);
  const dump=await postgresTool('pg_dump',['--dbname',sourceUrl.toString(),'--format=custom','--no-owner']);
  await writeFile(join(dir,'application-postgres.fixture'),dump);return artifacts;
 }});
 const relocated=join(t.directory,'other-host-bundle');await cp(t.bundle,relocated,{recursive:true});
 const restored=await restoreBundle(t,relocated);
 const recovery=new InstallationRecovery(restored,t.fence);const store=new MemberStore(restored);
 await recovery.acceptRestore(relocated,pins,randomUUID());
 assert.deepEqual(await store.getConversation(key),await t.store.getConversation(key));
 assert.deepEqual((await restored.query('SELECT * FROM birbcrew_ts.turns ORDER BY position')).rows,(await t.pool.query('SELECT * FROM birbcrew_ts.turns ORDER BY position')).rows);
 assert.deepEqual(await store.beginTurn(request),{kind:'replay',reply:'recorded'}); // read-only replay remains safe while held
 await assert.rejects(store.beginTurn({...request,requestId:randomUUID()}));
 assert.deepEqual((await restored.query('SELECT * FROM birbcrew_ts.public_events ORDER BY cursor')).rows,(await t.pool.query('SELECT * FROM birbcrew_ts.public_events ORDER BY cursor')).rows);
 assert.ok((await restored.query('SELECT * FROM birbcrew_ts.public_events')).rowCount!>0);
 // The append-only trigger is created after pg_restore loads rows, and still guards the copy.
 const audit=(await t.pool.query('SELECT * FROM birbcrew_ts.audit_events ORDER BY event_id')).rows;
 assert.deepEqual(audit.map(row=>row.event_type),['member.spawned','conversation.opened','request.finished']);
 assert.deepEqual((await restored.query('SELECT * FROM birbcrew_ts.audit_events ORDER BY event_id')).rows,audit);
 assert.deepEqual((await readAudit(restored,'owner',auditQuerySchema.parse({}))).events.map(event=>event.eventId),audit.map(row=>row.event_id));
 // Filtered reads return the same rows from the restored copy, which pg_restore gives the same indexes.
 const filtered=auditQuerySchema.parse({memberId:member.memberId.toUpperCase(),eventType:'conversation.opened,request.finished',from:'2000-01-01T00:00:00Z'});
 assert.deepEqual((await readAudit(restored,'owner',filtered)).events.map(event=>event.eventId),audit.filter(row=>row.event_type!=='member.spawned').map(row=>row.event_id));
 const indexes="SELECT indexdef FROM pg_indexes WHERE schemaname='birbcrew_ts' AND tablename='audit_events' ORDER BY indexname";
 assert.deepEqual((await restored.query(indexes)).rows,(await t.pool.query(indexes)).rows);
 await assert.rejects(restored.query('DELETE FROM birbcrew_ts.audit_events'),{code:'23514'});
 await assert.rejects(t.recovery.resume(t.hooks),/fenced/);
 const manifest=await readRecoveryManifest(relocated);
 assert.equal(manifest.inventory.audit_events,audit.length);
 await recovery.resume(t.hooks,manifest);
 await store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
 const {rows:[next]}=await restored.query("SELECT max(event_id)::text AS id FROM birbcrew_ts.audit_events WHERE event_type='member.spawned'");
 assert.ok(BigInt(next.id)>BigInt(audit.at(-1)!.event_id),'restored identity continues after the restored rows');
 assert.deepEqual(await store.beginTurn(request),{kind:'replay',reply:'recorded'});
 assert.equal((await restored.query('SELECT phase FROM birbcrew_ts.turns WHERE request_id=$1',[pending.requestId])).rows[0].phase,'started');
});

test('capture accepts the routine tables, and a firing claimed at capture is re-driven after restore with its stored identity',async context=>{
 const t=await setup(context);
 const ownerId='owner-'+randomUUID();const member=await t.store.spawn({ownerId,requestId:randomUUID(),engine:'pi',profile:'fixture'});
 let now=new Date('2031-01-06T10:00:00Z');const clock=()=>new Date(now);
 await new RoutineApi(t.store,clock).create(ownerId,{requestId:randomUUID(),memberId:member.memberId,schedule:'*/15 * * * *',prompt:'scheduled',approvalPolicy:'wait'});
 const accepted:TurnRequest[]=[];
 const dispatcher=(store:MemberStore,admits:boolean)=>{
  const members={async open(input:Parameters<MemberStore['openConversation']>[0]){return store.openConversation(input);},
   async accept(input:TurnRequest){accepted.push(input);if(!admits) throw new Error('gateway stopped before admission');await store.recordAcceptance(input,ownerInitiator);return {requestId:input.requestId};},
   async requestStatus(input:Parameters<MemberStore['requestStatus']>[0]){return store.requestStatus(input);},async cancelPending(){}} as unknown as MemberClient;
  return new RoutineDispatcher({store,members,integration:new IntegrationApi(store,members),owners:[ownerId],clock});
 };
 const source=dispatcher(t.store,false);await source.tick();now=new Date('2031-01-06T10:15:00Z');await source.tick();
 const firing=(await t.pool.query('SELECT routine_id,scheduled_for,status,conversation_id,request_id FROM birbcrew_ts.routine_firings')).rows;
 assert.deepEqual(firing.map(row=>row.status),['claimed']);
 const sourceUrl=new URL(url!);sourceUrl.pathname='/'+t.name;
 await t.recovery.capture(t.bundle,pins,{...t.hooks,snapshot:async dir=>{
  const artifacts=await t.hooks.snapshot(dir);
  await writeFile(join(dir,'application-postgres.fixture'),await postgresTool('pg_dump',['--dbname',sourceUrl.toString(),'--format=custom','--no-owner']));
  return artifacts;
 }});
 const manifest=await readRecoveryManifest(t.bundle);
 assert.deepEqual([manifest.inventory.routines,manifest.inventory.routine_firings],[1,1]);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);const store=new MemberStore(restored);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 await recovery.resume(t.hooks,manifest);
 now=new Date('2031-01-06T10:20:00Z');
 await dispatcher(store,true).tick();
 const after=(await restored.query('SELECT routine_id,scheduled_for,status,conversation_id,request_id FROM birbcrew_ts.routine_firings')).rows;
 assert.deepEqual(after,[{...firing[0],status:'admitted'}]);
 assert.deepEqual(accepted.map(({conversationId,requestId})=>[conversationId,requestId]),
  [[firing[0].conversation_id,firing[0].request_id],[firing[0].conversation_id,firing[0].request_id]]);
 assert.equal((await restored.query('SELECT count(*)::integer AS n FROM birbcrew_ts.request_admissions')).rows[0].n,1);
});

test('SIGKILL after external activation before database activation is safely retryable on restored instance',async context=>{
 const t=await setup(context);
 await t.recovery.capture(t.bundle,pins,t.hooks);
 await t.recovery.acceptRestore(t.bundle,pins,randomUUID());
 const u=new URL(url!);u.pathname='/'+t.name;
 await assert.rejects(exec(process.execPath,[new URL('./recovery-crash-child.ts',import.meta.url).pathname,u.toString(),join(t.directory,'external-fence'),t.bundle]),e=>{assert.equal((e as {signal?:string}).signal,'SIGKILL');return true;});
 assert.equal((await t.recovery.status()).control.phase,'restored');
 const fresh=new InstallationRecovery(t.pool,new FileRecoveryFence(join(t.directory,'external-fence')));
 await fresh.resume(t.hooks,await readRecoveryManifest(t.bundle));
 assert.equal((await fresh.status()).control.phase,'active');
});

test('native lifetime barrier waits for surviving lease and held state rejects new native admission',async context=>{
 const {acquireRecoveryNativeLease}=await import('../../src/service/recovery-admission.ts');
 const t=await setup(context);const native=await t.pool.connect();t.defer(async()=>native.release());
 await native.query('BEGIN');await acquireRecoveryNativeLease(native);
 let captured=false;
 const capture=t.recovery.capture(t.bundle,pins,t.hooks).then(()=>{captured=true;});
 while((await t.recovery.status()).control.phase!=='frozen') await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,50));assert.equal(captured,false);
 await native.query('ROLLBACK');await capture;
 await native.query('BEGIN');await assert.rejects(acquireRecoveryNativeLease(native),/held/);await native.query('ROLLBACK');
});

test('external preparation before DB freeze cannot authorize restore overlap',async context=>{
 const t=await setup(context);
 const {control:c}=await t.recovery.status();const generation=randomUUID();
 await t.fence.hold(c.installation,c.instance,generation); // controller dies before freezing database
 assert.equal((await t.recovery.status()).control.phase,'active');
 await assert.rejects(t.fence.transfer(c.installation,c.instance,randomUUID(),generation),/overlap/);
 await t.recovery.holdForRestore(generation,t.hooks);
 assert.equal((await t.recovery.status()).control.phase,'frozen');
 await t.fence.transfer(c.installation,c.instance,randomUUID(),generation);
});

async function dumpToBundle(t:Fixture) {
 const sourceUrl=new URL(url!);sourceUrl.pathname='/'+t.name;
 return t.recovery.capture(t.bundle,pins,{...t.hooks,snapshot:async directory=>{
  const artifacts=await t.hooks.snapshot(directory);
  await writeFile(join(directory,'application-postgres.fixture'),await postgresTool('pg_dump',['--dbname',sourceUrl.toString(),'--format=custom','--no-owner']));
  return artifacts;
 }});
}

test('retained A backup restores to C after A→B, but only after current owner B is quiesced',async context=>{
 const t=await setup(context);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);const instanceB=randomUUID();const instanceC=randomUUID();
 await t.recovery.acceptRestore(t.bundle,pins,instanceB);
 await t.recovery.resume(t.hooks,manifest);
 // Restore the retained A bytes, not a new B backup, into a third isolated DB.
 const poolC=await restoreBundle(t);const c=new InstallationRecovery(poolC,t.fence);
 await assert.rejects(c.acceptRestore(t.bundle,pins,instanceC,instanceB),/overlap/); // B is still active
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 await assert.rejects(c.acceptRestore(t.bundle,pins,instanceC),/overlap/); // provenance A isn't current B
 await c.acceptRestore(t.bundle,pins,instanceC,instanceB);
 await c.acceptRestore(t.bundle,pins,instanceC,instanceB); // transfer/update acknowledgement retry
 await assert.rejects(t.recovery.resume(t.hooks),/fenced/);
 await assert.rejects(t.fence.transfer(manifest.installation,instanceB,randomUUID(),manifest.generation),/overlap/);
 await c.resume(t.hooks,manifest);assert.equal((await c.status()).control.phase,'active');
});

const lastId=async(pool:Pool)=>(await pool.query<{id:string}>('SELECT max(event_id)::text AS id FROM birbcrew_ts.audit_events')).rows[0].id;
const spawn=(store:MemberStore)=>store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
const sequence=`pg_get_serial_sequence('birbcrew_ts.audit_events','event_id')`;
const setSequence=(pool:Pool,id:bigint)=>pool.query(`SELECT setval(${sequence},$1::bigint,false)`,[id.toString()]);
const epochIn=async(fence:string)=>JSON.parse(await readFile(join(fence,'epoch.json'),'utf8')).epoch as number;
const fenceState=async(t:Fixture)=>{
 const read=(file:string)=>readFile(join(t.directory,'external-fence',file),'utf8').catch((error:{code?:string})=>{if(error.code==='ENOENT')return null;throw error;});
 return {state:await read('state.json'),epoch:await read('epoch.json')};
};

test('a restored audit trail never reissues an event ID, even when one generation is restored twice, whatever the clocks',async context=>{
 const t=await setup(context);
 const page=async(pool:Pool,after:string)=>(await readAudit(pool,'owner',auditQuerySchema.parse({after}))).events.map(event=>event.eventId);
 await spawn(t.store);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);const recoveryPoint=await lastId(t.pool);
 // The source runs on past the recovery point, and a consumer pages past what the restore keeps.
 await t.recovery.resume(t.hooks);await spawn(t.store);const seenOnSource=await lastId(t.pool);
 async function restore(currentSourceInstance?:string) {
  const pool=await restoreBundle(t);
  const recovery=new InstallationRecovery(pool,t.fence);const instance=randomUUID();
  await recovery.acceptRestore(t.bundle,pins,instance,currentSourceInstance);
  await recovery.acceptRestore(t.bundle,pins,instance,currentSourceInstance); // acknowledgement retry
  assert.equal(await lastId(pool),recoveryPoint,'events after the recovery point are gone');
  await recovery.resume(t.hooks,manifest);
  return {pool,recovery,store:new MemberStore(pool),instance};
 }
 const epoch=()=>epochIn(join(t.directory,'external-fence'));
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const b=await restore();const epochB=await epoch();
 await spawn(b.store);const firstOnB=await lastId(b.pool);
 assert.deepEqual(await page(b.pool,seenOnSource),[firstOnB],'a saved cursor never skips a new event');
 // B draws 2^44 IDs. With a clock-based jump, C's clock would now have to be ahead of B's
 // by 2^44 µs (about 203 days) to pass them. The fence epoch reads no clock.
 await b.pool.query(`SELECT setval(${sequence},$1::bigint)`,[(BigInt(firstOnB)+(1n<<44n)-2n).toString()]);
 await spawn(b.store);const onB=await lastId(b.pool);
 // The retained bundle is restored again after B has run: C must pass all of B's IDs.
 await b.recovery.holdForRestore(manifest.generation,t.hooks);
 const c=await restore(b.instance);
 await spawn(c.store);const onC=await lastId(c.pool);
 assert.ok(BigInt(onC)>BigInt(onB),'a second restore of one generation never reissues the first one\'s IDs');
 assert.deepEqual(await page(c.pool,onB),[onC]);
 assert.deepEqual([epochB,await epoch()],[1,2],'every transfer advances the epoch once; an acknowledgement retry does not');
 assert.deepEqual([firstOnB,onB,onC],[1n<<44n,(2n<<44n)-1n,2n<<44n].map(String),'each timeline starts at its epoch times 2^44');
 // The previous release parses state.json strictly, so after a rollback it must still read it.
 assert.deepEqual(Object.keys(JSON.parse((await fenceState(t)).state!)).sort(),['generation','installation','instance','phase']);
});

test('a restored installation revokes every standing grant as it resumes; a held source keeps its own',async context=>{
 const t=await setup(context);
 const {memberId}=await spawn(t.store);
 async function call(store:MemberStore,pool:Pool) {
  const conversationId=randomUUID(),requestId=randomUUID(),text='record '+requestId,key={ownerId:'owner',conversationId,requestId};
  await store.openConversation({ownerId:'owner',memberId,conversationId});
  await store.recordAcceptance({...key,text},ownerInitiator);
  const start=await store.beginTurn({...key,text});
  assert.equal(start.kind,'start');if(start.kind!=='start') throw new Error('unreachable');
  return new ApprovalStore(pool).propose({...key,memberId,token:start.token,invocationId:requestId,nativeCallId:'call',
   toolName:'record_work_item',arguments:{operation_id:requestId}});
 }
 async function grant(choice:'allow_always'|'allow_conversation') {
  const {ownerId,conversationId,requestId,invocationId,nativeCallId,approvalId,argumentDigest,version}=await call(t.store,t.pool);
  await new ApprovalStore(t.pool).decide({ownerId,memberId,conversationId,requestId,invocationId,nativeCallId,approvalId,argumentDigest,version,choice});
  return {grant_id:(await t.pool.query('SELECT grant_id FROM birbcrew_ts.tool_grants WHERE approval_id=$1',[approvalId])).rows[0].grant_id as string,
   conversation_id:choice==='allow_always'?null:conversationId};
 }
 // The conversation grant first: once the member-wide grant exists, a later card never appears.
 const scoped=await grant('allow_conversation'),always=await grant('allow_always');
 const grants=async(pool:Pool)=>(await pool.query('SELECT grant_id,conversation_id,revocation_reason FROM birbcrew_ts.tool_grants ORDER BY created_at')).rows;
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.equal(manifest.inventory.tool_grants,2);
 // A held source that resumes without a restore keeps its grants: they are current.
 await t.recovery.resume(t.hooks);
 assert.deepEqual(await grants(t.pool),[{...scoped,revocation_reason:null},{...always,revocation_reason:null}]);
 // The owner revokes one after the recovery point. Restoring the generation brings it back.
 await revokeGrant(t.pool,{ownerId:'owner',memberId,grantId:always.grant_id});
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 assert.deepEqual(await grants(restored),[{...scoped,revocation_reason:null},{...always,revocation_reason:null}]);
 await recovery.resume(t.hooks,manifest);
 assert.deepEqual(await grants(restored),[{...scoped,revocation_reason:'recovery_restore'},{...always,revocation_reason:'recovery_restore'}]);
 const {rows:audit}=await restored.query(`SELECT actor_kind,actor_id,conversation_id,payload FROM birbcrew_ts.audit_events
  WHERE event_type='grant.revoked' ORDER BY event_id`);
 assert.deepEqual(audit,[scoped,always].map(g=>({actor_kind:'system',actor_id:null,conversation_id:g.conversation_id,
  payload:{grantId:g.grant_id,reason:'recovery_restore'}})));
 await assert.rejects(recovery.resume(t.hooks,manifest),/Not held/);
 assert.equal((await restored.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type='grant.revoked'")).rows[0].n,2);
 // The restored installation asks again.
 assert.equal((await call(new MemberStore(restored),restored)).grantId,undefined);
});

test('a card keeps its absolute deadline across a restore, and past it only the restored installation settles it, once',async context=>{
 const t=await setup(context);
 const ownerId='owner';const {memberId}=await t.store.spawn({ownerId,requestId:randomUUID(),engine:'pi',profile:'fixture'});
 const key={ownerId,conversationId:randomUUID(),requestId:randomUUID()};
 await t.store.openConversation({ownerId,memberId,conversationId:key.conversationId});
 const request={...key,text:'record at the recovery point',approvalDeadlineSeconds:60};
 await t.store.recordAcceptance(request,ownerInitiator);
 const start=await t.store.beginTurn(request);assert.equal(start.kind,'start');if(start.kind!=='start') return;
 const card=await new ApprovalStore(t.pool).propose({...key,memberId,token:start.token,invocationId:key.requestId,nativeCallId:'call',
  toolName:'record_work_item',arguments:{operation_id:key.requestId}});
 assert.ok(card.expiresAt);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 await recovery.resume(t.hooks,manifest);
 const {rows:[row]}=await restored.query('SELECT expires_at,expired_at FROM birbcrew_ts.deferred_calls WHERE approval_id=$1',[card.approvalId]);
 assert.deepEqual([row.expires_at.toISOString(),row.expired_at],[card.expiresAt,null],'the deadline is a time, not a duration restarted by the restore');
 // The deadline passed while the installation was held and restored.
 await restored.query('UPDATE birbcrew_ts.deferred_calls SET expires_at=clock_timestamp() WHERE approval_id=$1',[card.approvalId]);
 const ledger=new ApprovalStore(restored);
 await assert.rejects(ledger.decide({...key,memberId,invocationId:key.requestId,nativeCallId:'call',approvalId:card.approvalId,
  argumentDigest:card.argumentDigest,version:card.version,choice:'approve'}),{code:'conflict'});
 assert.deepEqual(await Promise.all([ledger.expireTurn(card),ledger.expireTurn(card)]),[{kind:'expired'},{kind:'expired'}]);
 assert.equal((await restored.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type='approval.expired'")).rows[0].n,1);
 // The held source writes nothing.
 await assert.rejects(new ApprovalStore(t.pool).expireTurn(card),{code:'55000'});
});

test('capture accepts the memory tables, and a held installation refuses every memory write',async context=>{
 const t=await setup(context);
 const {memberId}=await spawn(t.store);const api=new MemoryApi(t.store);
 const kept=await api.create('owner',{requestId:randomUUID(),memberId,text:'kept'});
 await t.store.openConversation({ownerId:'owner',memberId,conversationId:randomUUID()});
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.deepEqual([manifest.inventory.member_memories,manifest.inventory.conversation_memories],[1,1]);
 const conversationId=randomUUID();
 for(const write of [()=>api.create('owner',{requestId:randomUUID(),memberId,text:'held'}),()=>api.delete('owner',kept.memoryId),
  ()=>t.store.openConversation({ownerId:'owner',memberId,conversationId}),
  ()=>t.pool.query(`INSERT INTO birbcrew_ts.member_memories(owner_id,member_id,create_request_id,body) VALUES('owner',$1,$2,'direct')`,[memberId,randomUUID()]),
  ()=>t.pool.query(`INSERT INTO birbcrew_ts.conversation_memories SELECT conversation_id,2,$1 FROM birbcrew_ts.conversations LIMIT 1`,[kept.memoryId])]) {
  await assert.rejects(write(),{code:'55000'});
 }
 assert.deepEqual(await api.get('owner',kept.memoryId),kept,'reads still work');
 await t.recovery.resume(t.hooks);
 assert.equal((await api.delete('owner',kept.memoryId)).state,'deleted');
});

test('capture accepts the handoff table, and a held installation refuses every handoff write',async context=>{
 const t=await setup(context);
 const {memberId}=await spawn(t.store);
 const members={async open(input:Parameters<MemberStore['openConversation']>[0]){return t.store.openConversation(input);},
  async accept(input:TurnRequest){await t.store.recordAcceptance(input,ownerInitiator);return {requestId:input.requestId};}} as unknown as MemberClient;
 const api=new HandoffApi(t.store,members);
 async function committed() {
  const conversationId=randomUUID(),requestId=randomUUID(),text='remember '+requestId;
  await t.store.openConversation({ownerId:'owner',memberId,conversationId});
  await t.store.recordAcceptance({ownerId:'owner',conversationId,requestId,text},ownerInitiator);
  const start=await t.store.beginTurn({ownerId:'owner',conversationId,requestId,text});
  assert.equal(start.kind,'start');if(start.kind!=='start') throw new Error('unreachable');
  await t.store.commitTurn({ownerId:'owner',conversationId,requestId,token:start.token,reply:'stored',checkpoint:{version:1,engine:'pi',state:{}}});
  return conversationId;
 }
 const [handed,held]=[await committed(),await committed()];
 const kept=await api.create('owner',handed,{requestId:randomUUID(),memberId});
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.equal(manifest.inventory.conversation_handoffs,1);
 for(const write of [()=>api.create('owner',held,{requestId:randomUUID(),memberId}),
  ()=>t.pool.query(`INSERT INTO birbcrew_ts.conversation_handoffs (owner_id,request_id,source_conversation_id,source_member_id,
    target_conversation_id,target_member_id,transcript,transcript_digest,carried_turns,omitted_turns,uncertain_turns)
    SELECT owner_id,$1,$2,source_member_id,target_conversation_id,target_member_id,transcript,transcript_digest,1,0,0
    FROM birbcrew_ts.conversation_handoffs`,[randomUUID(),held])]) {
  await assert.rejects(write(),{code:'55000'});
 }
 assert.equal((await api.read('owner',handed)).outgoing?.handoffId,kept.handoffId,'reads still work');
 await t.recovery.resume(t.hooks);
 assert.equal((await api.create('owner',held,{requestId:randomUUID(),memberId})).carriedTurns,1);
});

test('a restored installation suspends every active memory as it resumes; a held source keeps its own',async context=>{
 const t=await setup(context);
 const {memberId}=await spawn(t.store);const api=new MemoryApi(t.store);
 const [alpha,bravo]=[await api.create('owner',{requestId:randomUUID(),memberId,text:'alpha'}),await api.create('owner',{requestId:randomUUID(),memberId,text:'bravo'})];
 const conversation=await t.store.openConversation({ownerId:'owner',memberId,conversationId:randomUUID()});
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 await t.recovery.resume(t.hooks);
 // The owner deletes one after the recovery point; a restore brings it back, text and all.
 await api.delete('owner',alpha.memoryId);
 const states=async(pool:Pool)=>(await pool.query('SELECT memory_id,state,body FROM birbcrew_ts.member_memories ORDER BY created_at')).rows;
 assert.deepEqual(await states(t.pool),[{memory_id:alpha.memoryId,state:'deleted',body:null},{memory_id:bravo.memoryId,state:'active',body:'bravo'}]);
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 assert.deepEqual(await states(restored),[{memory_id:alpha.memoryId,state:'active',body:'alpha'},{memory_id:bravo.memoryId,state:'active',body:'bravo'}]);
 // A delete holding its row when the resume starts cannot deadlock it: the delete's write still sees
 // the hold and fails, and the resume, waiting on that row, goes on.
 const deleter=await restored.connect();t.defer(async()=>deleter.release());
 await deleter.query('BEGIN');
 await deleter.query('SELECT 1 FROM birbcrew_ts.member_memories WHERE memory_id=$1 FOR NO KEY UPDATE',[alpha.memoryId]);
 const resuming=recovery.resume(t.hooks,manifest);
 let waited=false;
 for(let i=0;i<300&&!waited;i++) {
  waited=!!(await restored.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount;
  if(!waited) await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(waited,'the resume waits for the locked memory');
 await assert.rejects(deleter.query("UPDATE birbcrew_ts.member_memories SET state='deleted',body=NULL,changed_at=now() WHERE memory_id=$1",[alpha.memoryId]),{code:'55000'});
 await deleter.query('ROLLBACK');
 await resuming;
 const restoredApi=new MemoryApi(new MemberStore(restored));
 assert.deepEqual((await states(restored)).map(row=>[row.state,row.body]),[['suspended','alpha'],['suspended','bravo']]);
 const {rows:audit}=await restored.query(`SELECT actor_kind,actor_id,conversation_id,request_id,payload FROM birbcrew_ts.audit_events
  WHERE event_type='memory.suspended' ORDER BY event_id`);
 assert.deepEqual(audit,[alpha,bravo].map(m=>({actor_kind:'system',actor_id:null,conversation_id:null,request_id:null,
  payload:{memoryId:m.memoryId,reason:'recovery_restore'}})));
 assert.equal(await conversationContext(restored,conversation),undefined,'a suspended entry reaches no launch');
 await assert.rejects(recovery.resume(t.hooks,manifest),/Not held/);
 assert.equal((await restored.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type='memory.suspended'")).rows[0].n,2);
 // A suspended entry cannot come back; the owner reads it, deletes it and creates it again.
 await assert.rejects(restored.query("UPDATE birbcrew_ts.member_memories SET state='active',changed_at=NULL WHERE memory_id=$1",[bravo.memoryId]),{code:'23514'});
 assert.deepEqual([(await restoredApi.get('owner',bravo.memoryId)).text,(await restoredApi.delete('owner',alpha.memoryId)).text],['bravo',null]);
 const again=await restoredApi.create('owner',{requestId:randomUUID(),memberId,text:'bravo'});
 const later=await new MemberStore(restored).openConversation({ownerId:'owner',memberId,conversationId:randomUUID()});
 assert.match((await conversationContext(restored,later))!,new RegExp(again.memoryId));
 // The source, which resumed without a restore, kept its active entry.
 assert.deepEqual((await states(t.pool)).map(row=>row.state),['deleted','active']);
});

test('capture accepts the usage tables; a restore rewinds the ledger and budgets and resume leaves both as restored',async context=>{
 const t=await setup(context);
 const {memberId}=await spawn(t.store);const usage=new UsageApi(t.store);
 await usage.setBudget('owner',memberId,{tokenLimit:1000});
 async function spend(store:MemberStore,pool:Pool,input:number) {
  const conversationId=randomUUID();await store.openConversation({ownerId:'owner',memberId,conversationId});
  const request={ownerId:'owner',conversationId,requestId:randomUUID(),text:'metered'};
  await store.recordAcceptance(request,ownerInitiator);
  const execution={workflowRunId:randomUUID(),activityId:'turn',attempt:1};
  const turn=await store.beginTurn(request,execution);assert.equal(turn.kind,'start');if(turn.kind!=='start')return;
  await pool.query('INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt) VALUES ($1,$2,$3,$4,$5,1)',
   [conversationId,request.requestId,turn.token,execution.workflowRunId,execution.activityId]);
  await recordSegmentUsage(pool,{...request,token:turn.token,execution},{state:'reported',model:'m',inputTokens:input,outputTokens:0,
   cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null,costUsd:null});
 }
 await spend(t.store,t.pool,600);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.deepEqual([manifest.inventory.usage_ledger,manifest.inventory.usage_budgets],[1,1]);
 await assert.rejects(usage.setBudget('owner',memberId,{tokenLimit:5}),{code:'55000'});
 await t.recovery.resume(t.hooks);
 // After the recovery point the member spends more and the owner tightens its budget: the source refuses.
 await spend(t.store,t.pool,500);
 await usage.setBudget('owner',memberId,{tokenLimit:900});
 const refused={ownerId:'owner',conversationId:randomUUID(),requestId:randomUUID(),text:'refused'};
 await t.store.openConversation({ownerId:'owner',conversationId:refused.conversationId,memberId});
 await assert.rejects(t.store.recordAcceptance(refused,ownerInitiator),{code:'usage_limit'});
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 await recovery.resume(t.hooks,manifest);
 // The restore brought back the earlier limit and forgot the later 500 tokens; resume changed neither.
 const view=await new UsageApi(new MemberStore(restored)).budget('owner',memberId);
 assert.deepEqual([view.budget?.tokenLimit,view.budget?.revision,view.usedTokens,view.admitting],[1000,1,600,true]);
 assert.equal((await restored.query("SELECT count(*)::integer AS n FROM birbcrew_ts.audit_events WHERE event_type LIKE 'usage.%'")).rows[0].n,1);
 const restoredStore=new MemberStore(restored);
 await restoredStore.openConversation({ownerId:'owner',conversationId:refused.conversationId,memberId});
 await restoredStore.recordAcceptance(refused,ownerInitiator);
 await assert.rejects(restored.query('DELETE FROM birbcrew_ts.usage_ledger'),{code:'23514'});
});

test('capture counts member instructions, a held installation refuses them, and a restore keeps them as they were',async context=>{
 const t=await setup(context);
 const role='You review database migrations and never propose schema changes yourself.';
 const member=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture',instructions:role});
 const conversation=await t.store.openConversation({ownerId:'owner',memberId:member.memberId,conversationId:randomUUID()});
 const launched=await conversationContext(t.pool,conversation);
 assert.match(launched!,/never propose schema changes/);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.equal(manifest.inventory.member_instructions,1);
 for(const write of [()=>t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture',instructions:'held'}),
  ()=>t.pool.query(`INSERT INTO birbcrew_ts.member_instructions(owner_id,member_id,body) VALUES('owner',$1,'direct')`,[member.memberId])]) {
  await assert.rejects(write(),{code:'55000'});
 }
 assert.deepEqual((await t.pool.query('SELECT body FROM birbcrew_ts.member_instructions')).rows,[{body:role}],'reads still work');
 await t.recovery.resume(t.hooks);
 // A member spawned after the recovery point is gone after the restore, its instructions with it.
 const later=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture',instructions:'after the recovery point'});
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 await recovery.resume(t.hooks,manifest);
 const rows=async(pool:Pool)=>(await pool.query('SELECT member_id,body FROM birbcrew_ts.member_instructions ORDER BY created_at')).rows;
 assert.deepEqual(await rows(restored),[{member_id:member.memberId,body:role}],'the restore neither suspends nor removes them');
 assert.equal(await conversationContext(restored,conversation),launched,'a restored conversation launches with the text it had');
 assert.deepEqual((await restored.query(`SELECT event_type FROM birbcrew_ts.audit_events WHERE event_type LIKE 'member.instructions%'`)).rows,
  [{event_type:'member.instructions_set'}],'the resume records nothing about instructions');
 assert.deepEqual((await rows(t.pool)).map(row=>row.member_id),[member.memberId,later.memberId]);
 await assert.rejects(restored.query('UPDATE birbcrew_ts.member_instructions SET body=$1',['changed']),{code:'23514'});
});

test('capture counts instruction packs, a held installation refuses every pack write, and a restore keeps them as they were',async context=>{
 const t=await setup(context);
 const packs=new PackApi(t.store);
 const style='Write commit messages in the imperative mood.';
 const used=await packs.create('owner',{requestId:randomUUID(),name:'style',text:style});
 const spare=await packs.create('owner',{requestId:randomUUID(),name:'spare',text:'Spare text the owner deletes after the recovery point.'});
 const member=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture',instructionPacks:[used.packId]});
 const conversation=await t.store.openConversation({ownerId:'owner',memberId:member.memberId,conversationId:randomUUID()});
 const launched=await conversationContext(t.pool,conversation);
 assert.match(launched!,/imperative mood/);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 assert.deepEqual([manifest.inventory.instruction_packs,manifest.inventory.member_instruction_packs],[2,1]);
 for(const write of [()=>packs.create('owner',{requestId:randomUUID(),name:'held',text:'held'}),()=>packs.delete('owner',spare.packId),
  ()=>t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture',instructionPacks:[used.packId]}),
  ()=>t.pool.query(`INSERT INTO birbcrew_ts.instruction_packs(owner_id,create_request_id,name,body) VALUES('owner',$1,'direct','direct')`,[randomUUID()]),
  ()=>t.pool.query(`INSERT INTO birbcrew_ts.member_instruction_packs(member_id,position,owner_id,pack_id) VALUES($1,2,'owner',$2)`,[member.memberId,spare.packId])]) {
  await assert.rejects(write(),{code:'55000'});
 }
 // Deleting an attached pack is refused as in use before the barrier is reached, held or not.
 await assert.rejects(packs.delete('owner',used.packId),{code:'pack_in_use'});
 assert.equal((await packs.get('owner',used.packId)).text,style,'reads still work');
 await t.recovery.resume(t.hooks);
 // After the recovery point: the spare pack is deleted, and a new pack and member appear.
 await packs.delete('owner',spare.packId);
 const later=await packs.create('owner',{requestId:randomUUID(),name:'later',text:'after the recovery point'});
 await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture',instructionPacks:[later.packId]});
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const restored=await restoreBundle(t);const recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 await recovery.resume(t.hooks,manifest);
 // Nothing is suspended or removed: the member launches with the pack it had, and the deleted pack is back, unattached.
 const restoredPacks=new PackApi(new MemberStore(restored));
 assert.deepEqual((await restoredPacks.list('owner',{})).instructionPacks.map(pack=>[pack.packId,pack.state,pack.memberCount]).sort(),
  [[used.packId,'active',1],[spare.packId,'active',0]].sort());
 assert.equal(await conversationContext(restored,conversation),launched,'a restored conversation launches with the packs it had');
 assert.deepEqual((await restored.query(`SELECT event_type FROM birbcrew_ts.audit_events WHERE event_type LIKE '%instruction_pack%' ORDER BY event_id`)).rows
  .map(row=>row.event_type),['instruction_pack.created','instruction_pack.created','member.instruction_packs_attached'],'the resume records nothing about packs');
 // The owner deletes the returned pack again; the restored installation takes pack writes.
 assert.equal((await restoredPacks.delete('owner',spare.packId)).state,'deleted');
 await assert.rejects(restoredPacks.delete('owner',used.packId),{code:'pack_in_use'});
});

test('a restore past the fence epoch, its epoch file missing or behind, starts above every ID the restored identity drew',async context=>{
 for(const {drawn,stale,epoch} of [
  // The identity was last set by an acceptance at epoch 5 and has drawn nothing since: only the committed rows show epoch 3.
  {drawn:false,stale:null,epoch:4},
  // The epoch 5 timeline drew an ID that never committed: only the identity shows it, and that timeline may have committed more after the capture.
  {drawn:true,stale:1,epoch:6},
 ]) {
  const t=await setup(context);
  await setSequence(t.pool,3n<<44n);await spawn(t.store);await setSequence(t.pool,5n<<44n);
  if(drawn) await t.pool.query(`SELECT nextval(${sequence})`);
  await dumpToBundle(t);
  // A replaced fence: the same authority state, with no epoch file or one that transfers by an earlier release left behind.
  const fence=join(t.directory,'replaced-fence');await mkdir(fence);
  await cp(join(t.directory,'external-fence','state.json'),join(fence,'state.json'));
  if(stale!==null) await writeFile(join(fence,'epoch.json'),JSON.stringify({epoch:stale}));
  const pool=await restoreBundle(t);const recovery=new InstallationRecovery(pool,new FileRecoveryFence(fence));const instance=randomUUID();
  await recovery.acceptRestore(t.bundle,pins,instance);
  await recovery.acceptRestore(t.bundle,pins,instance); // acknowledgement retry
  assert.equal(await epochIn(fence),epoch,'the lowest epoch above every ID the restored identity drew');
  await recovery.resume(t.hooks,await readRecoveryManifest(t.bundle));
  await spawn(new MemberStore(pool));
  assert.equal(await lastId(pool),(BigInt(epoch)<<44n).toString(),'new IDs start above every ID the restored identity drew');
 }
});

test('an audit epoch past the last is refused before authority moves, and the source can resume',async context=>{
 // The restored trail already holds an ID in the last epoch's range.
 const t=await setup(context);
 await setSequence(t.pool,BigInt(fenceEpochLimit-1)<<44n);await spawn(t.store);
 await t.recovery.capture(t.bundle,pins,t.hooks);
 const before=await fenceState(t);
 await assert.rejects(t.recovery.acceptRestore(t.bundle,pins,randomUUID()),(error:unknown)=>error instanceof RecoveryRefusedError
  &&/has drawn event ID 9223354444668731392, so this restore needs audit identity epoch 524288, past the last, 524287\. Nothing was transferred/.test(error.message));
 assert.deepEqual(await fenceState(t),before,'the fence is unchanged');
 await t.recovery.resume(t.hooks);
 assert.equal((await t.recovery.status()).control.phase,'active');
 // A fence whose own next epoch is past the last refuses inside transfer, before it writes anything.
 const s=await setup(context);
 await s.recovery.capture(s.bundle,pins,s.hooks);
 await writeFile(join(s.directory,'external-fence','epoch.json'),JSON.stringify({epoch:fenceEpochLimit-1}));
 const held=await fenceState(s);
 await assert.rejects(s.recovery.acceptRestore(s.bundle,pins,randomUUID()),(error:unknown)=>error instanceof RecoveryRefusedError
  &&/needs recovery fence epoch 524288, past the last audit identity epoch, 524287, so the fence refused it and is unchanged\. Authority stays with the held source/.test(error.message));
 assert.deepEqual(await fenceState(s),held,'the fence is unchanged');
 await s.recovery.resume(s.hooks);
 assert.equal((await s.recovery.status()).control.phase,'active');
});

test('a fence that returns no epoch is refused, and a retry with an upgraded fence and the same target succeeds',async context=>{
 const t=await setup(context);
 await spawn(t.store);
 await t.recovery.capture(t.bundle,pins,t.hooks);
 // A fence written before transfer returned an epoch: it moves authority and stores no epoch.
 class LegacyFence extends FileRecoveryFence {
  override async transfer(installation:string,source:string,target:string,generation:string) {
   await super.transfer(installation,source,target,generation);await rm(join(this.directory,'epoch.json'));
   return undefined as unknown as number;
  }
 }
 const target=randomUUID();
 await assert.rejects(new InstallationRecovery(t.pool,new LegacyFence(t.fence.directory)).acceptRestore(t.bundle,pins,target),(error:unknown)=>error instanceof RecoveryRefusedError
  &&error.message.includes(`returned no epoch for this transfer, but this restore needs at least epoch 1. Authority has moved to target ${target}`)
  &&error.message.includes(`retry accept-restore with the same target instance, ${target}.`));
 assert.equal((await t.recovery.status()).control.phase,'frozen');
 await assert.rejects(t.recovery.resume(t.hooks),/fenced/,'authority has moved, so the source cannot resume');
 await t.recovery.acceptRestore(t.bundle,pins,target);
 assert.equal(await epochIn(t.fence.directory),1,'the retry raises the stored epoch to the minimum');
 await t.recovery.resume(t.hooks,await readRecoveryManifest(t.bundle));
 await spawn(t.store);
 assert.equal(await lastId(t.pool),(1n<<44n).toString());
});

test('a transfer interrupted between its epoch and state writes leaves the epoch higher, never lower',async context=>{
 const fs=(await import('node:fs/promises')).default;
 const {syncBuiltinESMExports}=await import('node:module');
 const t=await setup(context);
 const {generation}=await t.recovery.capture(t.bundle,pins,t.hooks);const {control:c}=await t.recovery.status();
 await writeFile(join(t.fence.directory,'epoch.json'),JSON.stringify({epoch:3}));
 const before=await fenceState(t);
 const originalRename=fs.rename;let renames=0;
 const restore=()=>{fs.rename=originalRename;syncBuiltinESMExports();};t.defer(async()=>restore());
 fs.rename=async(...args:Parameters<typeof originalRename>)=>{if(++renames===2) throw new Error('injected crash');return originalRename(...args);};
 syncBuiltinESMExports();
 const target=randomUUID();
 await assert.rejects(t.fence.transfer(c.installation,c.instance,target,generation,1),/injected crash/);
 restore();
 // The second rename is state.json's: the raised epoch landed, and authority did not move.
 assert.deepEqual(await fenceState(t),{state:before.state,epoch:JSON.stringify({epoch:4})});
 // The retry, still a move from the held source, skips epoch 4 and never hands out 3 again.
 assert.equal(await t.fence.transfer(c.installation,c.instance,target,generation,1),5);
});

test('an unreadable fence epoch file fails every fence operation instead of reading as 0',async context=>{
 for(const damaged of ['{"epoch":','{"epoch":"3"}']) {
  const t=await setup(context);
  const {generation}=await t.recovery.capture(t.bundle,pins,t.hooks);const {control:c}=await t.recovery.status();
  await writeFile(join(t.fence.directory,'epoch.json'),damaged);
  const before=await fenceState(t);
  await assert.rejects(t.fence.transfer(c.installation,c.instance,randomUUID(),generation,1));
  await assert.rejects(t.recovery.resume(t.hooks),'even resume, which does not use the epoch, fails closed');
  assert.deepEqual(await fenceState(t),before,'the fence is unchanged');
  // The documented repair: rewrite the file with a chosen epoch. The lock was released.
  await writeFile(join(t.fence.directory,'epoch.json'),JSON.stringify({epoch:3}));
  await t.recovery.resume(t.hooks);
  assert.equal((await t.recovery.status()).control.phase,'active');
 }
});

test('a fence epoch below the minimum, or an identity drawn during the transfer, is refused with the retry instruction',async context=>{
 for(const {fault,expected,refusal} of [
  {fault:'low epoch',expected:4,refusal:'returned epoch 1 for this transfer, but this restore needs at least epoch 4. Authority has moved to target'},
  {fault:'drawn',expected:6,refusal:'drew an ID in or past epoch 4\'s range after acceptance checked it, while the installation was held, so acceptance left it unchanged. Authority has moved to target'},
 ]) {
  const t=await setup(context);
  // The restored identity has drawn an ID in epoch 3, so acceptance needs at least epoch 4.
  await setSequence(t.pool,3n<<44n);await spawn(t.store);
  await t.recovery.capture(t.bundle,pins,t.hooks);
  const pool=t.pool;
  class FaultyFence extends FileRecoveryFence {
   override async transfer(installation:string,source:string,target:string,generation:string,minimumEpoch?:number) {
    // An operator-supplied fence that ignores minimumEpoch and returns a positive epoch below it.
    if(fault==='low epoch') {await super.transfer(installation,source,target,generation);return 1;}
    // Something outside Crew draws from the identity after acceptance computed its minimum.
    const epoch=await super.transfer(installation,source,target,generation,minimumEpoch);
    await pool.query(`SELECT setval(${sequence},$1::bigint)`,[(5n<<44n).toString()]);
    return epoch;
   }
  }
  const target=randomUUID();
  await assert.rejects(new InstallationRecovery(t.pool,new FaultyFence(t.fence.directory)).acceptRestore(t.bundle,pins,target),(error:unknown)=>error instanceof RecoveryRefusedError
   &&error.message.includes(`${refusal} ${target}`)
   &&error.message.includes(`retry accept-restore with the same target instance, ${target}.`));
  await assert.rejects(t.recovery.resume(t.hooks),/fenced/,'authority has moved, so the source cannot resume');
  await t.recovery.acceptRestore(t.bundle,pins,target);
  assert.equal(await epochIn(t.fence.directory),expected,'the retry raises the stored epoch to the recomputed minimum');
  await t.recovery.resume(t.hooks,await readRecoveryManifest(t.bundle));
  await spawn(t.store);
  assert.equal(await lastId(t.pool),(BigInt(expected)<<44n).toString());
 }
});

test('bundle directory fsync failure cannot record a successful or transferable backup',async context=>{
 const fs=(await import('node:fs/promises')).default;
 const {syncBuiltinESMExports}=await import('node:module');
 const t=await setup(context);const originalOpen=fs.open;let bundleSyncAttempted=false;
 t.defer(async()=>{fs.open=originalOpen;syncBuiltinESMExports();});
 fs.open=async(...args:Parameters<typeof originalOpen>)=>{
  const handle=await originalOpen(...args);
  if(args[0]===t.bundle) handle.sync=async()=>{bundleSyncAttempted=true;throw new Error('injected directory sync failure');};
  return handle;
 };
 syncBuiltinESMExports();
 await assert.rejects(t.recovery.capture(t.bundle,pins,t.hooks),/directory sync failure/);
 assert.equal(bundleSyncAttempted,true);
 assert.equal((await t.recovery.status()).latest,null);
 const manifest=await readRecoveryManifest(t.bundle);
 await assert.rejects(t.fence.transfer(manifest.installation,manifest.sourceInstance,randomUUID(),manifest.generation),/overlap/);
});

test('restoring an older snapshot atomically retires named roles and delegation while preserving recorded child identity',async context=>{
 const t=await setup(context);
 const {ChildStore}=await import('../../src/service/children.ts');
 const {withNativeAdmission}=await import('../../src/service/native-admission.ts');
 const {fixedRoles}=await import('@birbcrew/pi-subagents');
 const account='a'.repeat(64),destination={engine:'pi',profile:'target',model:'fixture',providerHost:'fixture.invalid',accountDigest:account};
 await t.pool.query("INSERT INTO birbcrew_ts.profiles(name,engine,account_digest) VALUES('target','pi',decode($1,'hex'))",[account]);
 await t.pool.query(`INSERT INTO birbcrew_ts.profiles(name,engine,account_digest,delegate_task,child_target_seal,child_target_active)
  VALUES('parent','pi',decode($1,'hex'),true,$2,ARRAY['analyst'])`,[account,{mode:'named',roles:{analyst:destination}}]);
 const request={ownerId:'owner',requestId:randomUUID(),engine:'pi' as const,profile:'parent'};
 const member=await t.store.spawn(request),conversationId=randomUUID(),requestId=randomUUID();
 await t.store.openConversation({ownerId:'owner',memberId:member.memberId,conversationId});
 const turn=await t.store.beginTurn({ownerId:'owner',conversationId,requestId,text:'delegate'});
 if(turn.kind!=='start') throw Error('Expected started parent');
 const [child]=await new ChildStore(t.pool).delegate(turn.conversation,requestId,turn.token,[{
  nativeCallId:'restore-call',task:'private child',profile:{role:'analyst',version:1,...fixedRoles.analyst,model:'parent-model'},
 }],{version:1,engine:'pi',state:{}});
 const identity=(await t.pool.query('SELECT role_profile FROM birbcrew_ts.pi_children WHERE child_id=$1',[child.childId])).rows[0].role_profile;
 const controlSql='SELECT birbcrew_ts.change_delegation_control($1,$2,$3,$4,$5,$6) AS receipt';
 const oldCommand=randomUUID(),oldRevision=(await t.pool.query('SELECT revision::text FROM birbcrew_ts.delegation_control')).rows[0].revision;
 const oldArgs=[oldCommand,oldRevision,{kind:'global'},true,'restore-fixture','command before backup'];
 const oldReceipt=(await t.pool.query(controlSql,oldArgs)).rows[0].receipt;
 assert.equal(oldReceipt.enabled,true);
 await dumpToBundle(t);
 const manifest=await readRecoveryManifest(t.bundle);
 await t.recovery.resume(t.hooks);
 await t.pool.query("UPDATE birbcrew_ts.profiles SET child_target_active='{}' WHERE name='parent'");
 await t.pool.query(controlSql,[randomUUID(),oldReceipt.revision,{kind:'global'},false,'restore-fixture','disable after backup']);
 await t.recovery.holdForRestore(manifest.generation,t.hooks);
 const restored=await restoreBundle(t),recovery=new InstallationRecovery(restored,t.fence);
 await recovery.acceptRestore(t.bundle,pins,randomUUID());
 const active=async()=>(await restored.query("SELECT child_target_active FROM birbcrew_ts.profiles WHERE name='parent'")).rows[0].child_target_active;
 assert.deepEqual(await active(),['analyst'],'the backup cannot retain an unknown later removal');
 let admittedCallbacks=0;
 const launch={...child,text:'private child',token:randomUUID(),execution:{workflowRunId:randomUUID(),activityId:'child',attempt:1}};
 await assert.rejects(withNativeAdmission(restored,launch,context.signal,async()=>{admittedCallbacks++;}),/held for recovery/);
 assert.equal(admittedCallbacks,0);
 await assert.rejects(recovery.resume({reconcile:async()=>{throw Error('reconcile first');}},manifest),/reconcile first/);
 assert.deepEqual(await active(),['analyst']);
 assert.equal((await recovery.status()).control.phase,'restored');
 assert.equal((await restored.query('SELECT global_enabled FROM birbcrew_ts.delegation_control')).rows[0].global_enabled,true);
 assert.equal((await restored.query('SELECT 1 FROM birbcrew_ts.delegation_control_children WHERE child_id=$1',[child.childId])).rowCount,0);
 await recovery.resume(t.hooks,manifest);
 assert.deepEqual(await active(),[]);
 const control=(await restored.query('SELECT revision::text,global_enabled FROM birbcrew_ts.delegation_control')).rows[0];
 assert.equal(control.global_enabled,false);
 const cohort=(await restored.query(`SELECT c.retire,h.instance_id,h.receipt FROM birbcrew_ts.delegation_control_children c
  JOIN birbcrew_ts.delegation_control_changes h USING(command_id) WHERE c.child_id=$1`,[child.childId])).rows;
 assert.equal(cohort.length,1);assert.equal(cohort[0].retire,true);
 assert.equal(cohort[0].instance_id,(await recovery.status()).control.instance);
 assert.equal(cohort[0].receipt.revision,control.revision);
 await assert.rejects(restored.query(controlSql,oldArgs),{code:'55000'});
 assert.equal((await restored.query('SELECT global_enabled FROM birbcrew_ts.delegation_control')).rows[0].global_enabled,false);
 assert.deepEqual((await restored.query('SELECT role_profile FROM birbcrew_ts.pi_children WHERE child_id=$1',[child.childId])).rows[0].role_profile,identity);
 const replay=await new MemberStore(restored).spawn(request);
 assert.equal(replay.subagents.targets[0].availability,'removed');
 assert.deepEqual((await new MemberStore(restored).spawn({...request,requestId:randomUUID()})).subagents,{mode:'named',targets:[]});
 const children=new ChildStore(restored);
 await assert.rejects(children.begin(child,{workflowRunId:randomUUID(),activityId:'child',attempt:1}),{code:'55000'});
 await children.closeExitedChild(child,false);
 const failed=await children.begin(child,{workflowRunId:randomUUID(),activityId:'child',attempt:1});
 assert.deepEqual(failed,{kind:'settled',outcome:{kind:'failed',nativeCallId:'restore-call',code:'child_failed'}});
 await restored.query(controlSql,[randomUUID(),control.revision,{kind:'global'},true,'restore-fixture','enable future delegation']);
 assert.deepEqual(await children.begin(child,{workflowRunId:randomUUID(),activityId:'child',attempt:1}),failed);
 assert.deepEqual((await restored.query('SELECT generation,phase,role_profile FROM birbcrew_ts.pi_children WHERE child_id=$1',[child.childId])).rows[0],
  {generation:null,phase:'failed',role_profile:identity});
 assert.equal((await restored.query('SELECT 1 FROM birbcrew_ts.native_launches WHERE child_id=$1',[child.childId])).rowCount,0);
 assert.deepEqual((await restored.query(`SELECT event_type,count(*)::int AS count FROM birbcrew_ts.audit_events
  WHERE payload->>'childId'=$1 AND event_type IN ('delegation.started','delegation.finished') GROUP BY event_type`,[child.childId])).rows,
  [{event_type:'delegation.finished',count:1}]);
 await assert.rejects(restored.query("UPDATE birbcrew_ts.profiles SET child_target_active=ARRAY['analyst'] WHERE name='parent'"),{code:'23514'});
});
