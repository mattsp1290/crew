import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,readlinkSync,readdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const revisions={baseline:'17684dd5a6867c73aa17ea6ceea609d3f8511b11',head:'7c919782b77f9b290a296c01e406a8cbf5f3f69c'};
const archives={baseline:{sha256:'bd4e8d39d143b1a1ea7bf2d11735343526b0f74080dbe11b9f9f0c196c3e5641',js:'5517e1f119b8d01d01bab86c32ca25d41540064bc7656d935cc2e81735746eba',dts:'0773df4c98d6d4b255e3e2902809b834b36e4568e51fb7b007302647e0ceda68'},head:{sha256:'8a245e1a190336c32ee37326e716672c061b933f391de5cb9db4eaf2eadade30',js:'3418560b91e43fe4e955f2a3672e48924a2b1bb1339dba4a135f3f8c604359f3',dts:'b8979b5b0c81ed19e926bb0a157386dc5a50291bf18defa220082ea3ef5b70db'}};
const source=process.cwd(), controller=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const label=process.env.PR76_LABEL,revision=process.env.PR76_REVISION;
assert.ok(label in revisions); assert.equal(revision,revisions[label]);
const output=resolve(source,'../artifacts',label); mkdirSync(output,{recursive:true});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(join(output,name+'.json'),JSON.stringify(value,null,2)+'\n');
function git(args,cwd=source) {
  const result=spawnSync('git',args,{cwd,maxBuffer:64*1024*1024});
  assert.equal(result.status,0,result.stderr?.toString()); return result.stdout;
}
function manifest() {
  return git(['ls-files','--stage','-z']).toString().split('\0').filter(Boolean).map(entry=>{
    const [,mode,blob,path]=entry.match(/^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/);
    const bytes=mode==='120000'?Buffer.from(readlinkSync(join(source,path))):readFileSync(join(source,path));
    assert.equal(sha256(bytes),sha256(git(['cat-file','blob',blob])),'tracked source differs from raw Git blob '+path);
    return {path,mode,blob,bytes:bytes.length,sha256:sha256(bytes)};
  });
}
let captureCommand,CommandFailure,admin,before,Pool;
const commands=[],databases=[];
async function must(name,program,args,env={}) {
  const log=join(output,name+'.log'),previous=new Map(Object.keys(env).map(key=>[key,process.env[key]]));
  const metadata={name,program,args,startedAt:new Date().toISOString()}; let failure;
  try {
    Object.assign(process.env,env);
    try { await captureCommand(log,program,args); }
    catch(error) { if(!(error instanceof CommandFailure)) throw error; failure=error; }
  } finally {
    for(const [key,value] of previous) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
  }
  const receipt=JSON.parse(readFileSync(log+'.result.json','utf8'));
  commands.push({...metadata,finishedAt:new Date().toISOString(),receipt:name+'.log.result.json'}); save('commands',commands);
  assert.deepEqual(receipt.failures,[],name+' capture or cleanup failed'); assert.equal(receipt.deadlineExceeded,false);
  assert.equal(receipt.truncated,false); assert.equal(receipt.interrupted,undefined); assert.equal(receipt.outcome.kind,'exited');
  if(failure) assert.deepEqual(failure.result,receipt.outcome);
  assert.equal(receipt.outcome.code,0,name+' failed; inspect raw log and receipt');
}
async function database(suite) {
  const name=`pr76_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}_${label}_${suite}`;
  assert.match(name,/^[a-z0-9_]{1,63}$/); await admin.query(`CREATE DATABASE "${name}"`);
  const url=new URL(process.env.PR76_DATABASE_URL); url.pathname='/'+name;
  databases.push({suite,name}); save('databases',databases); return url.toString();
}
async function query(url,sql) {
  const pool=new Pool({connectionString:url});
  try { return (await pool.query(sql)).rows; } finally { await pool.end(); }
}
async function childState(url) {
  return query(url,`SELECT c.child_id,c.conversation_id,c.request_id,c.phase,c.generation,c.workflow_run_id,
    c.role_profile->>'role' AS role,c.role_profile->>'model' AS model,c.role_profile->'tools' AS tools,c.role_profile->'target' AS target,
    c.outcome->>'kind' AS outcome,c.outcome->>'code' AS code,
    (SELECT count(*)::int FROM birbcrew_ts.native_launches n WHERE n.child_id=c.child_id) AS launches,
    (SELECT count(*)::int FROM birbcrew_ts.native_launches n WHERE n.child_id=c.child_id AND NOT n.stopped) AS live_launches,
    (SELECT count(*)::int FROM birbcrew_ts.audit_events a WHERE a.payload->>'childId'=c.child_id::text AND a.event_type='delegation.started') AS starts,
    (SELECT count(*)::int FROM birbcrew_ts.audit_events a WHERE a.payload->>'childId'=c.child_id::text AND a.event_type='delegation.finished') AS finishes
    FROM birbcrew_ts.pi_children c ORDER BY c.child_id`);
}
function assertTap(name,expected,filtered=false) {
  const raw=readFileSync(join(output,name+'.log'),'utf8');
  assert.match(raw,new RegExp('^# pass '+expected+'$','m')); assert.match(raw,/^# fail 0$/m);
  if(!filtered) assert.match(raw,/^# skipped 0$/m); assert.match(raw,/^# cancelled 0$/m);
}
try {
  assert.equal(process.version,'v24.22.3'); assert.equal(git(['rev-parse','HEAD']).toString().trim(),revision);
  assert.equal(git(['rev-parse','HEAD'],controller).toString().trim(),process.env.PR76_PROBE_SHA);
  assert.equal(git(['status','--porcelain','--untracked-files=all']).length,0);
  before=manifest(); save('source-before',before);
  save('identity',{label,revision,tree:git(['rev-parse','HEAD^{tree}']).toString().trim(),probeSha:process.env.PR76_PROBE_SHA,node:process.version,nodeExecutableSha256:sha256(readFileSync(process.execPath)),runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,isolation:'Fresh GitHub-hosted VM and PostgreSQL17 per matrix job. Canonical owned-command bounds apply. Generic descendant absence is unproven.'});
  ({captureCommand,CommandFailure}=await import(pathToFileURL(join(source,'tests/proof/member-service-diagnostics.mts')).href));
  save('controller-source',['tests/proof/pr76-current-qualification.mjs','tests/proof/pr76-current-public.mjs'].map(path=>{
    const bytes=readFileSync(join(controller,path)),blob=git(['rev-parse','HEAD:'+path],controller).toString().trim();
    assert.ok(bytes.equals(git(['cat-file','blob',blob],controller))); return {path,blob,sha256:sha256(bytes)};
  }));
  await must('npm-ci','npm',['ci']); await must('build','npm',['run','build']); await must('npm-graph','npm',['ls','--all','--json']);
  const archivePath='packages/pi-subagents/birbcrew-pi-subagents-0.1.0.tgz',archive=readFileSync(join(source,archivePath));
  const lock=JSON.parse(readFileSync(join(source,'package-lock.json'),'utf8'));
  const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');
  assert.equal(sha256(archive),archives[label].sha256); assert.equal(lock.packages['node_modules/@birbcrew/pi-subagents'].integrity,integrity);
  assert.equal(JSON.parse(readFileSync(join(source,'node_modules/typescript/package.json'),'utf8')).version,'5.9.3');
  const privateRoot=join(source,'.proof/pr76-package'); mkdirSync(privateRoot,{recursive:true});
  await must('pi-archive-list','tar',['-tzf',archivePath]);
  await must('pi-archive-unpack','tar',['-xzf',archivePath,'-C',privateRoot]);
  const fresh=join(privateRoot,'fresh');
  await must('pi-source-compile',process.execPath,['node_modules/typescript/bin/tsc','-p','packages/pi-subagents/tsconfig.json','--outDir',fresh]);
  const compiled=[['index.js','js'],['index.d.ts','dts']].map(([name,key])=>{
    for(const path of [join(privateRoot,'package/dist',name),join(source,'node_modules/@birbcrew/pi-subagents/dist',name),join(fresh,name)]) {
      const stat=lstatSync(path); assert.ok(stat.isFile()); assert.equal(stat.nlink,1,'package evidence must use separate regular files');
    }
    const packed=readFileSync(join(privateRoot,'package/dist',name)),installed=readFileSync(join(source,'node_modules/@birbcrew/pi-subagents/dist',name)),rebuilt=readFileSync(join(fresh,name));
    assert.ok(packed.equals(installed),name+' installed differs from committed archive'); assert.ok(rebuilt.equals(packed),name+' fresh source compile differs from archive');
    assert.equal(sha256(packed),archives[label][key]); return {name,archive:sha256(packed),installed:sha256(installed),fresh:sha256(rebuilt)};
  });
  save('pi-package',{archivePath,sha256:sha256(archive),integrity,typescript:'5.9.3',compiled,comparison:'Old approved receipt constants establish continuity; fresh compile and installed comparisons establish current execution identity.'});
  const artifactPaths=['package.json','package-lock.json','node_modules/.package-lock.json','.proof/bin/member-launch'];
  function collect(directory) { for(const entry of readdirSync(join(source,directory),{withFileTypes:true})) { const path=join(directory,entry.name); if(entry.isDirectory()) collect(path); else artifactPaths.push(path); } }
  collect('packages/client/dist');
  save('installed-artifacts',artifactPaths.map(path=>({path,bytes:lstatSync(join(source,path)).size,sha256:sha256(readFileSync(join(source,path)))})));
  ({Pool}=createRequire(join(source,'package.json'))('pg')); admin=new Pool({connectionString:process.env.PR76_DATABASE_URL});
  const postgresVersion=await admin.query('SHOW server_version_num'); save('postgres-version',postgresVersion.rows); assert.match(postgresVersion.rows[0].server_version_num,/^17\d{4}$/);
  save('database-before',(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows);
  await must('public',process.execPath,[join(controller,'tests/proof/pr76-current-public.mjs'),source,label,output],{BIRBCREW_TEST_DATABASE_URL:await database('public')});
  if(label==='head') {
    const suites=[['sql','tests/service/child-targets.test.ts',12],['races','tests/service/child-target-races.test.ts',2],['budget','tests/service/child-budget.test.ts',15],['workflow','tests/service/child-target-workflow.test.ts',8],['approvals','tests/service/approvals.test.ts',31]];
    assert.ok(process.env.TEMPORAL_CLI); await must('temporal-version',process.env.TEMPORAL_CLI,['--version']);
    assert.match(readFileSync(join(output,'temporal-version.log'),'utf8'),/1\.10\.0\b/); save('temporal-binary',{sha256:sha256(readFileSync(process.env.TEMPORAL_CLI))});
    for(const [suite,path,count] of suites) {
      const url=await database(suite);
      await must(suite,process.execPath,['--test','--test-reporter=tap',path],{BIRBCREW_TEST_DATABASE_URL:url,BIRBCREW_TEST_DATABASE_PREFIX:'pr76_nested_'});
      assertTap(suite,count);
      const rows=await childState(url); save(suite+'-state',rows);
      if(suite==='workflow') {
        const exhausted=rows.filter(row=>row.code==='budget_exhausted'); assert.equal(exhausted.length,1);
        assert.deepEqual([exhausted[0].phase,exhausted[0].generation,exhausted[0].launches,exhausted[0].starts,exhausted[0].finishes],['failed',null,0,0,1]);
        const recorders=rows.filter(row=>row.role==='recorder'); assert.equal(recorders.length,2);
        for(const row of recorders) assert.deepEqual([row.phase,row.outcome,row.launches,row.starts,row.finishes],['complete','completed',2,1,1]);
        const named=rows.filter(row=>row.target?.version===1);
        assert.ok(named.length>0); assert.ok(named.some(row=>row.phase==='cancelled' && row.live_launches===0));
        assert.ok(named.some(row=>row.code==='child_failed' && row.launches===0));
        for(const row of named) { assert.equal(row.target.engine,'pi'); assert.equal(row.model,'fixture-child-model'); assert.deepEqual(row.tools,row.role==='analyst'?[]:['record_work_item']); }
        const authority=await query(url,"SELECT name,child_target_seal,child_target_active FROM birbcrew_ts.profiles WHERE name IN ('fixture.ready.v1','fixture.named.v1') ORDER BY name");
        save('workflow-authority',authority); assert.equal(authority.length,2); for(const row of authority) assert.deepEqual(row.child_target_active,[]);
      }
    }
    const restore='restoring an older snapshot retires named roles atomically after reconciliation and preserves recorded child identity';
    const container=process.env.BIRBCREW_RECOVERY_POSTGRES_CONTAINER;
    assert.match(container??'',/^[a-f0-9]{64}$/,'recovery must use this job\'s exact owned PostgreSQL17 service');
    const clients=[];
    for(const tool of ['pg_dump','pg_restore']) {
      await must(tool+'-version','docker',['exec',container,tool,'--version']);
      const raw=readFileSync(join(output,tool+'-version.log'),'utf8'),match=raw.match(/PostgreSQL\) (\d+)\./);
      assert.ok(match,'PostgreSQL client version missing for '+tool);
      const major=Number(match[1]); assert.equal(major,17,tool+' must match PostgreSQL17'); clients.push({tool,major});
    }
    save('postgres-clients',{container,clients});
    await must('recovery',process.execPath,['--test','--test-reporter=tap','--test-name-pattern=^'+restore+'$','tests/service/recovery.test.ts'],{BIRBCREW_TEST_DATABASE_URL:await database('recovery'),BIRBCREW_TEST_DATABASE_PREFIX:'pr76_restore_'});
    assertTap('recovery',1,true);
    save('evidence-scope',{provider:'Unchanged SQL and workflow suites assert captured proxy model, target driver requests, fixed tools, parent isolation, and zero requests on refused paths before fixture cleanup. Their temporary provider logs are not independently retained.',restore:'Unchanged selected recovery case asserts real pg_dump/pg_restore, atomic retirement after reconciliation, preserved recorded identity, and recorded child admission. Its private nested databases are cleaned by the case.',policy:'Pi only. Migration037 requires drained native calls. Historical unsealed target rows cannot launch.'});
  }
} catch(error) { save('failure',{name:error.name,message:error.message,stack:error.stack}); process.exitCode=1; }
finally {
  if(admin) {
    try {
      save('database-pre-cleanup',(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows);
      for(const {name} of databases) await admin.query(`DROP DATABASE "${name}"`);
      const remaining=(await admin.query("SELECT datname FROM pg_database WHERE starts_with(datname,'pr76_') OR starts_with(datname,'crew_targets_upgrade_') ORDER BY datname")).rows;
      save('database-after',remaining); assert.deepEqual(remaining,[],'owned or migration nested database leaked');
      const sessions=(await admin.query("SELECT datname,state,count(*)::int AS sessions FROM pg_stat_activity WHERE starts_with(datname,'pr76_') OR starts_with(datname,'crew_targets_upgrade_') GROUP BY datname,state ORDER BY datname,state")).rows;
      save('database-sessions',sessions); assert.deepEqual(sessions,[]);
    } catch(error) { save('cleanup-failure',{message:error.message}); process.exitCode=1; }
    finally { await admin.end(); }
  }
  if(before) {
    try { const after=manifest(); save('source-after',after); assert.deepEqual(after,before); const porcelain=git(['status','--porcelain','--untracked-files=all']).toString(); save('source-status',{porcelain,trackedUnchanged:true}); assert.equal(porcelain,''); }
    catch(error) { save('source-integrity-failure',{message:error.message}); process.exitCode=1; }
  }
  save('result',{status:process.exitCode?'FAIL':'PASS',label,revision});
  save('artifact-checksums',readdirSync(output).filter(name=>name!=='artifact-checksums.json').sort().map(path=>({path,sha256:sha256(readFileSync(join(output,path)))})));
}
