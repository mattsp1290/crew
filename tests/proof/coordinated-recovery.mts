/** Full development-persistence recovery proof. No real credentials or inference.
 * Two isolated PostgreSQL servers and physically different native host roots;
 * actual stopped Temporal SQLite persistence is restored with the same generation.
 * This does not certify a production Temporal SQL/Cassandra deployment. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {Client,Connection} from '@temporalio/client';
import {Pool} from 'pg';
import {MemberStore} from '../../src/service/store.ts';
import {MemberClient} from '../../src/service/client.ts';
import {decisionSchema} from '../../src/service/approvals.ts';
import {answerLive} from '../../src/service/codex-calls.ts';
import {InstallationRecovery,readRecoveryManifest,type RecoveryPins} from '../../src/service/recovery.ts';
import {FileRecoveryFence} from '../../src/service/recovery-fence.ts';
import {commands,pendingSchema,decision} from './member-commands.mts';
import {services,run,until,type Services,type ServiceHandle,type Engine} from './member-services.mts';
import {prepareRecoveryNativeRuntime} from './recovery-native-runtime.mts';

assert.equal(process.version,'v24.22.3');
const postgresImage='postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';
async function pg(tool:'pg_dump'|'pg_restore',url:string,input?:Buffer) {
 const parsed=new URL(url);
 const args=['run','--rm','-i','--network','host','-e','PGPASSWORD',postgresImage,tool,'-h',parsed.hostname,'-p',parsed.port,'-U',decodeURIComponent(parsed.username),'-d',parsed.pathname.slice(1),'--no-owner',...(tool==='pg_dump'?['--format=custom']:[])];
 return new Promise<Buffer>((resolve,reject)=>{
  const child=spawn('docker',args,{env:{...process.env,PGPASSWORD:decodeURIComponent(parsed.password)},stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let stderr='';
  child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>{stderr+=chunk.toString();});child.stdin.on('error',()=>{});
  child.once('error',reject);child.once('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`Fixture ${tool} failed (${code}); private server diagnostics withheld`)));
  child.stdin.end(input);
 });
}
const source=await services();
let target:ServiceHandle|undefined;
let runtime:Awaited<ReturnType<typeof prepareRecoveryNativeRuntime>>|undefined;
let sourcePool:Pool|undefined,targetPool:Pool|undefined,sourceConnection:Connection|undefined;
let stopSourceWorker:(()=>Promise<void>)|undefined,stopSourceTemporal:(()=>Promise<void>)|undefined;
let stopTargetWorker:(()=>Promise<void>)|undefined,stopTargetTemporal:(()=>Promise<void>)|undefined;
const engines:Engine[]=['claude','codex','pi'];
try {
 runtime=await prepareRecoveryNativeRuntime();
 const sourceNative=join(source.directory,'source-native');await mkdir(sourceNative,{mode:0o700});
 async function startWorker(s:Services,root:string) {
  const args=runtime!.args(root,['node','src/service/cli.ts','worker','tests/proof/fixture-profiles.mts'],['BIRBCREW_DATABASE_URL','BIRBCREW_TEMPORAL_ADDRESS','BIRBCREW_STATE_DIR','BIRBCREW_PROOF_REQUESTS']);
  const name=args[args.indexOf('--name')+1];
  const stop=await s.child('docker',args,{...s.env,BIRBCREW_STATE_DIR:'/native/state',BIRBCREW_PROOF_REQUESTS:'/native/provider-requests.jsonl'},'coordinated-worker.log');
  return async()=>{try{await run('docker',['rm','-f',name],{timeout:30_000});}catch(error){if(!String((error as {stderr?:string}).stderr).includes('No such container'))throw error;}await stop();};
 }
 const {command,create}=commands(source);
 stopSourceTemporal=await source.startTemporal();stopSourceWorker=await startWorker(source,sourceNative);
 await until(async()=>{try{return await source.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'")==='3'||undefined;}catch{return undefined;}},'three source worker profiles');
 sourcePool=new Pool({connectionString:source.env.BIRBCREW_DATABASE_URL});
 const sourceStore=new MemberStore(sourcePool);
 sourceConnection=await Connection.connect({address:source.env.BIRBCREW_TEMPORAL_ADDRESS});
 const sourceMembers=new MemberClient(sourceStore,new Client({connection:sourceConnection}));
 const completed=[];const pending=[];
 for(const engine of engines) {
  const member=await create(engine);const key=await member.open();const marker=randomUUID();
  const request={...key,requestId:randomUUID(),text:'remember '+marker};
  assert.deepEqual(await command('turn',request),{text:'stored '+marker});
  completed.push({engine,key,marker,request});
  const protectedMember=await create(engine,'fixture.approval.v1');const pendingKey=await protectedMember.open();
  const pendingRequest={...pendingKey,requestId:randomUUID(),text:''};pendingRequest.text='record '+pendingRequest.requestId;
  await sourceMembers.accept(pendingRequest);
  const card=await until(async()=>pendingSchema.parse(await sourceMembers.pending(pendingKey))[0],'source '+engine+' pending decision');
  assert.equal(card.requestId,pendingRequest.requestId);
  pending.push({engine,key:pendingKey,request:pendingRequest,approvalId:card.approvalId,card});
 }
 await sourceConnection.close();sourceConnection=undefined;
 assert.equal(await source.sql('SELECT count(*) FROM birbcrew_ts.work_items'),'0');
 const fence=new FileRecoveryFence(join(source.directory,'external-authority'));
 const recovery=new InstallationRecovery(sourcePool,fence);await recovery.initializeFence();
 const bundle=join(source.directory,'generation');await mkdir(bundle,{mode:0o700});
 const pins:RecoveryPins={applicationCommit:(await run('git',['rev-parse','HEAD'])).stdout.trim(),lockfileSha256:createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),temporal:{serverVersion:'temporal-cli-1.10.0',persistenceFormat:'stopped-development-sqlite',mode:'development-fixture'},logicalNativeRoot:'/native/state'};
 await recovery.capture(bundle,pins,{
  quiesce:async()=>{await stopSourceWorker!();stopSourceWorker=undefined;await stopSourceTemporal!();stopSourceTemporal=undefined;},
  snapshot:async directory=>{
   await writeFile(join(directory,'application.dump'),await pg('pg_dump',source.env.BIRBCREW_DATABASE_URL!),{mode:0o600});
   const persistence=(await readdir(source.directory)).filter(name=>/^temporal\.db(?:-(?:wal|shm))?$/.test(name));assert.ok(persistence.includes('temporal.db'));
   await run('tar',['-C',source.directory,'-cf',join(directory,'temporal.tar'),...persistence]);
   await run('tar',['-C',sourceNative,'-cf',join(directory,'native.tar'),'.']);
   await writeFile(join(directory,'configuration.json'),JSON.stringify({pins,profiles:'synthetic fixture-v1 only'}),{mode:0o600});
   return[{kind:'application-postgres',file:'application.dump'},{kind:'temporal-persistence',file:'temporal.tar'},{kind:'native-volumes',file:'native.tar'},{kind:'configuration',file:'configuration.json'}];
  },
  reconcile:async()=>{throw new Error('Source relocation stays held');},
 });
 const manifest=await readRecoveryManifest(bundle);
 assert.equal((await recovery.status()).control.phase,'frozen');
 const snapshot=async(pool:Pool)=>({
  turns:(await pool.query('SELECT * FROM birbcrew_ts.turns ORDER BY conversation_id,request_id')).rows,
  calls:(await pool.query('SELECT * FROM birbcrew_ts.deferred_calls ORDER BY approval_id')).rows,
  snapshots:(await pool.query('SELECT * FROM birbcrew_ts.public_snapshots ORDER BY conversation_id')).rows,
  events:(await pool.query('SELECT * FROM birbcrew_ts.public_events ORDER BY conversation_id,cursor')).rows,
 });
 const preserved=await snapshot(sourcePool);assert.ok(preserved.events.length>0);
 for(const p of pending) assert.ok(preserved.calls.some(call=>call.approval_id===p.approvalId&&call.decision===null));
 // Separate target server, filesystem root and Temporal process; source remains frozen.
 target=await services();
 const targetNative=join(target.directory,'restored-native');await mkdir(targetNative,{mode:0o700});
 assert.notEqual(sourceNative,targetNative);
 const relocatedBundle=join(target.directory,'generation');await cp(bundle,relocatedBundle,{recursive:true});
 await readRecoveryManifest(relocatedBundle);
 await pg('pg_restore',target.env.BIRBCREW_DATABASE_URL!,await readFile(join(relocatedBundle,'application.dump')));
 await run('tar',['-C',targetNative,'-xf',join(relocatedBundle,'native.tar')]);
 await run('tar',['-C',target.directory,'-xf',join(relocatedBundle,'temporal.tar')]);
 targetPool=new Pool({connectionString:target.env.BIRBCREW_DATABASE_URL});
 const restored=new InstallationRecovery(targetPool,fence);await restored.acceptRestore(relocatedBundle,pins,randomUUID());
 assert.deepEqual(await snapshot(targetPool),preserved);
 await assert.rejects(recovery.resume({reconcile:async()=>{}}),/fenced|mismatch/);
 await assert.rejects(new MemberStore(targetPool).spawn({ownerId:'held-fixture',requestId:randomUUID(),engine:'pi',profile:'fixture.v1'}),{code:'55000'});
 // This fixture owns its effect destination (work_items) and never authorized any
 // pending call. Reconciliation proves zero effects, not a production assumption.
 await restored.resume({reconcile:async restoredManifest=>{
  assert.equal(restoredManifest?.generation,manifest.generation);
  assert.equal((await targetPool!.query('SELECT count(*)::int AS n FROM birbcrew_ts.work_items')).rows[0].n,0);
  assert.equal((await targetPool!.query('SELECT count(*)::int AS n FROM birbcrew_ts.deferred_calls WHERE decision IS NOT NULL')).rows[0].n,0);
 }},manifest);
 // Consumer ingress stays disabled while restored workers recover their native
 // process-bound state. The explicit test client is the only caller.
 stopTargetTemporal=await target.startTemporal();stopTargetWorker=await startWorker(target,targetNative);
 // Use a ready query on the actual server and wait for restored worker to poll.
 await until(async()=>{try{return await target!.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'")==='3'||undefined;}catch{return undefined;}},'restored worker profiles');
 const targetCommands=commands(target);
 const evidence=()=>readFile(join(targetNative,'provider-requests.jsonl'),'utf8');
 for(const item of completed) {
  const before=await evidence();
  assert.deepEqual(await targetCommands.command('turn',item.request),{text:'stored '+item.marker});
  assert.equal(await evidence(),before,'completed replay must not invoke a native engine');
  assert.deepEqual(await targetCommands.command('turn',{...item.key,requestId:randomUUID(),text:'recall'}),{text:'recalled '+item.marker});
  console.log(`${item.engine}: coordinated restored history replay=0 inference; engine-native recall after relocation passed`);
 }
 for(const item of pending) {
  // A live Codex callback belongs to the destroyed source process. Its safe
  // restored outcome is interruption/uncertainty, not a resumable cancellation
  // update. Verify that specific state and reject the original approval through
  // the production authorization path rather than accepting any failed command.
  if(item.engine==='codex') {
   await until(async()=>{
    const {rows:[state]}=await targetPool!.query<{live_phase:string;turn_phase:string}>(`SELECT l.phase AS live_phase,t.phase AS turn_phase
      FROM birbcrew_ts.codex_live_calls l JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
      WHERE l.approval_id=$1`,[item.approvalId]);
    return state?.live_phase==='interrupted'&&state.turn_phase==='uncertain'?state:undefined;
   },'restored Codex callback interruption and uncertain turn',120_000);
   const beforeRejectedApproval=await evidence();
   const restoredConnection=await Connection.connect({address:target.env.BIRBCREW_TEMPORAL_ADDRESS});
   try {
    const restoredMembers:MemberClient=new MemberClient(new MemberStore(targetPool),new Client({connection:restoredConnection}));
    assert.deepEqual(await restoredMembers.pending(item.key),[]);
    await assert.rejects(restoredMembers.decide(decision(item.card,'approve')),{name:'MemberStoreError',code:'conflict'});
   }finally{await restoredConnection.close();}
   await assert.rejects(answerLive(targetPool,decisionSchema.parse(decision(item.card,'approve'))),{name:'MemberStoreError',code:'conflict'});
   assert.equal(await evidence(),beforeRejectedApproval,'stale approval cannot invoke a provider');
   const stateAfter:{live_phase:string;turn_phase:string;decision:string|null}=(await targetPool.query<{live_phase:string;turn_phase:string;decision:string|null}>(`SELECT l.phase AS live_phase,t.phase AS turn_phase,d.decision
     FROM birbcrew_ts.codex_live_calls l JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
     JOIN birbcrew_ts.deferred_calls d USING(approval_id) WHERE l.approval_id=$1`,[item.approvalId])).rows[0];
   assert.deepEqual(stateAfter,{live_phase:'interrupted',turn_phase:'uncertain',decision:null});
   assert.equal(await target.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${item.key.conversationId}'`),'0');
   console.log('codex: restored process-bound callback interrupted; turn uncertain; pending unavailable; stale approval rejected; effects=0');
   continue;
  }
  // Claude/Pi have durable paused segments, so use their normal cancellation
  // path. No old approval is ever granted or automatically replayed.
  assert.deepEqual(await targetCommands.command('cancel-pending',{...item.key,requestId:item.request.requestId}),{cancelled:true});
  assert.deepEqual(await targetCommands.command('cancel-pending',{...item.key,requestId:item.request.requestId}),{cancelled:true});
  await until(async()=>Number(await target!.sql(`SELECT count(*) FROM birbcrew_ts.tool_cancellations WHERE conversation_id='${item.key.conversationId}' AND request_id='${item.request.requestId}'`))===1||undefined,'restored pending cancellation');
  assert.equal(await target.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${item.key.conversationId}'`),'0');
  console.log(`${item.engine}: restored unapproved decision explicitly cancelled; effects=0`);
 }
 assert.equal(await target.sql('SELECT count(*) FROM birbcrew_ts.work_items'),'0');
 console.log('Coordinated recovery passed: one-generation PostgreSQL dump, stopped Temporal development persistence and native archive restored into isolated target; source fenced, observations preserved. Production backing-store qualification remains separate.');
} finally {
 const stopped=await Promise.allSettled([sourceConnection?.close(),stopSourceWorker?.(),stopTargetWorker?.(),stopSourceTemporal?.(),stopTargetTemporal?.()]);
 const cleaned=await Promise.allSettled([sourcePool?.end(),targetPool?.end(),runtime?.close(),target?.close(),source.close()]);
 const failures=[...stopped,...cleaned].filter((result):result is PromiseRejectedResult=>result.status==='rejected');
 if(failures.length) throw new AggregateError(failures.map(result=>result.reason),'Coordinated recovery cleanup failed');
}
