import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readlinkSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const source=process.cwd(),controller=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const revision=process.env.CONTROL_SQL_SOURCE,probe=process.env.CONTROL_SQL_CONTROLLER;
const output=resolve(source,'../artifacts');
mkdirSync(output,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(join(output,name+'.json'),JSON.stringify(value,null,2)+'\n');
function git(args,cwd=source) {
  const result=spawnSync('git',args,{cwd,maxBuffer:64*1024*1024});
  assert.equal(result.status,0,result.stderr?.toString());return result.stdout;
}
function manifest() {
  return git(['ls-files','--stage','-z']).toString().split('\0').filter(Boolean).map(entry=>{
    const match=entry.match(/^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/);assert.ok(match);
    const [,mode,blob,path]=match;
    const bytes=mode==='120000'?Buffer.from(readlinkSync(join(source,path))):readFileSync(join(source,path));
    assert.equal(hash(bytes),hash(git(['cat-file','blob',blob])),'tracked source differs from Git '+path);
    return {path,mode,blob,bytes:bytes.length,sha256:hash(bytes)};
  });
}
const expectedCases=[
  "historical unreadable target joins a conservative disable cohort without inventing authority",
  "native SHARE lease plus pinned waiting UPDATE permits disable stop publication, then refuses the stale writer",
  "pinned proposal INSERT waits for child before control, so native lease cannot prevent disable",
  "pinned proposal INSERT and waiting UPDATE commit before a blocked disable and retain the unanswered card",
  "pinned decision UPDATE commits before a blocked disable and preserves the owner choice",
  "pinned successful terminal UPDATE commits before a blocked disable and preserves success without retirement",
  "old admission SELECT begun behind a rolling-back writer keeps stale stop visibility; separate post-lease read refuses",
  "generation guard takes a fresh policy snapshot after waiting for disable; reverse order captures the committed generation",
  "actual work-item INSERT independently fences a stale approved read in both commit orders and preserves committed receipts",
  "independent old-write guards refuse insert, generation, waiting, proposal, decision, effect, success and reservation after disable",
  "command retry is immutable, revisions compare-and-swap, global and target state compose, and recovery fences all three tables",
  "fixed cohort retains completed-child pending-parent and late-native windows but excludes fully completed history",
  "target-only cohort leaves an unaffected sibling eligible; later global disable retires it permanently",
  "native reservation and child insert gates serialize both commit orders without granting after disable",
  "restore-style activation reuses the canonical mutation atomically, and rollback leaves no control receipt or stop intent",
  "retirement stops every reserved child generation, preserves parent reservation, and refuses non-READ-COMMITTED commands",
  "an enable command from an old recovery instance cannot return a current enable receipt after restored disable"
];
const commands=[],cleanupFailures=[];
let captureCommand,CommandFailure,before,admin,database,databaseInventory,Pool,failure;
async function must(name,program,args,env={}) {
  const previous=new Map(Object.keys(env).map(key=>[key,process.env[key]]));
  let capturedFailure;
  try {
    Object.assign(process.env,env);
    try {await captureCommand(join(output,name+'.log'),program,args);}
    catch(error) {if(!(error instanceof CommandFailure))throw error;capturedFailure=error;}
  } finally {
    for(const [key,value] of previous) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
  const receiptName=name+'.log.result.json',receipt=JSON.parse(readFileSync(join(output,receiptName),'utf8'));
  commands.push({name,program,args,receipt:receiptName});save('commands',commands);
  assert.deepEqual(receipt.failures,[]);assert.equal(receipt.deadlineExceeded,false);
  assert.equal(receipt.truncated,false);assert.equal(receipt.interrupted,undefined);
  assert.equal(receipt.received,receipt.retained);assert.ok(receipt.received<=8*1024*1024);
  assert.equal(receipt.outcome.kind,'exited');assert.equal(receipt.outcome.code,0,name+' failed');
  if(capturedFailure)assert.deepEqual(capturedFailure.result,receipt.outcome);
}
try {
  assert.match(revision,/^[a-f0-9]{40}$/);assert.match(probe,/^[a-f0-9]{40}$/);
  assert.equal(process.version,'v24.22.3');assert.equal(git(['rev-parse','HEAD']).toString().trim(),revision);
  assert.equal(git(['rev-parse','HEAD'],controller).toString().trim(),probe);
  assert.equal(git(['status','--porcelain','--untracked-files=all']).length,0);
  before=manifest();save('source-before',before);
  const helper='tests/proof/member-service-diagnostics.mts';
  assert.equal(hash(readFileSync(join(source,helper))),'40249b71a0d489b4f9a211507bee66264a346de09cb8e3e8ebe7bfabb99a3c85');
  save('identity',{revision,tree:git(['rev-parse','HEAD^{tree}']).toString().trim(),probe,node:process.version,
    nodeExecutableSha256:hash(readFileSync(process.execPath)),runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,
    isolation:'Fresh hosted VM and owned PostgreSQL17 service. Canonical command capture. Generic descendant absence is unproven.'});
  const path='tests/proof/control-sql-boundaries.mjs',bytes=readFileSync(join(controller,path));
  const blob=git(['rev-parse','HEAD:'+path],controller).toString().trim();assert.ok(bytes.equals(git(['cat-file','blob',blob],controller)));
  save('controller-source',{path,blob,sha256:hash(bytes)});
  ({captureCommand,CommandFailure}=await import(pathToFileURL(join(source,helper)).href));
  await must('npm-ci','npm',['ci']);await must('build','npm',['run','build']);await must('dependency-graph','npm',['ls','--all','--json']);
  const require=createRequire(join(source,'package.json'));({Pool}=require('pg'));
  admin=new Pool({connectionString:process.env.CONTROL_SQL_DATABASE_URL});
  const {rows:[version]}=await admin.query('SHOW server_version_num');assert.equal(Math.floor(Number(version.server_version_num)/10000),17);save('postgres',version);
  databaseInventory=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;save('database-inventory-before',databaseInventory);
  const proposedDatabase=`control_sql_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}`;
  assert.match(proposedDatabase,/^[a-z0-9_]{1,63}$/);await admin.query(`CREATE DATABASE "${proposedDatabase}"`);
  database=proposedDatabase;save('owned-database',{database});
  const url=new URL(process.env.CONTROL_SQL_DATABASE_URL);url.pathname='/'+database;
  const caseOutput=join(output,'cases');mkdirSync(caseOutput,{recursive:true});
  await must('sql-races',process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','tests/service/delegation-control-races.test.ts'],
    {BIRBCREW_TEST_DATABASE_URL:url.toString(),BIRBCREW_CONTROL_PROOF_DIR:caseOutput});
  const tap=readFileSync(join(output,'sql-races.log'),'utf8');
  assert.match(tap,/^# pass 17$/m);
  assert.deepEqual([...tap.matchAll(/^ok [0-9]+ - (.+)$/gm)].map(match=>match[1]),expectedCases);assert.match(tap,/^# fail 0$/m);assert.match(tap,/^# cancelled 0$/m);assert.match(tap,/^# skipped 0$/m);assert.match(tap,/^# todo 0$/m);
  save('tap',{pass:Number(tap.match(/^# pass ([0-9]+)$/m)[1]),fail:0,cancelled:0,skipped:0});
  const state=new Pool({connectionString:url.toString()});
  try {
    save('migrations',(await state.query('SELECT * FROM birbcrew_ts.schema_versions ORDER BY version')).rows);
    save('control',(await state.query('SELECT * FROM birbcrew_ts.delegation_control')).rows);
  } finally {await state.end();}
} catch(error) {
  failure=error;save('failure',{name:error.name,message:error.message});
} finally {
  if(admin) {
    if(database) {
      try {
        const sessions=(await admin.query('SELECT pid,state FROM pg_stat_activity WHERE datname=$1',[database])).rows;
        save('sessions-before-cleanup',sessions);assert.deepEqual(sessions,[]);
        await admin.query(`DROP DATABASE "${database}"`);
        const remaining=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
        save('owned-database-after',remaining);assert.deepEqual(remaining,[]);
      } catch(error) {cleanupFailures.push(error.message);}
    }
    try {
      const inventory=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
      save('database-inventory-after',inventory);assert.deepEqual(inventory,databaseInventory);
    } catch(error) {cleanupFailures.push(error.message);}
    try {await admin.end();}
    catch(error) {cleanupFailures.push(error.message);}
  }
  try {
    const after=manifest();save('source-after',after);assert.deepEqual(after,before);
    const porcelain=git(['status','--porcelain','--untracked-files=all']).toString();save('source-status',{porcelain,trackedUnchanged:true});assert.equal(porcelain,'');
  } catch(error) {cleanupFailures.push(error.message);}
  save('cleanup',{failures:cleanupFailures});
  save('result',{status:failure||cleanupFailures.length?'FAIL':'PASS',revision});
  const checksums=[];
  function collect(directory) {
    for(const name of readdirSync(directory)) {
      const file=join(directory,name);
      const entry=lstatSync(file);assert.ok(!entry.isSymbolicLink(),'artifact symlink');
      if(entry.isDirectory())collect(file);
      else {
        assert.ok(entry.isFile()&&entry.nlink===1,'artifact must be a separate regular file');
        if(file!==join(output,'artifact-checksums.json'))checksums.push({path:file.slice(output.length+1),sha256:hash(readFileSync(file))});
      }
    }
  }
  collect(output);save('artifact-checksums',checksums);
}
if(failure||cleanupFailures.length)process.exitCode=1;
