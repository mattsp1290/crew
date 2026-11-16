import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readlinkSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const suites={
  "sql": {
    "file": "tests/service/delegation-control-races.test.ts",
    "sourceCases": [
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
      "an enable command from an old recovery instance cannot return a current enable receipt after restored disable",
      "fresh native admission refuses unsupported transaction isolation instead of trusting a retained snapshot"
    ],
    "count": 18
  },
  "store": {
    "file": "tests/service/delegation-control.test.ts",
    "sourceCases": [
      "strict operator input rejects malformed commands without changing durable permission",
      "change and status persist refusal with a workflow adapter that throws on every operation",
      "same command retries preserve the original receipt while changed payloads and stale CAS refuse",
      "ready retirement settles through ChildStore without creating a native launch and never resurrects",
      "unanswered recorder retirement atomically closes its visible card without inventing an owner choice",
      "resuming recorder retirement preserves the committed effect and replays the same receipt",
      "failed wakes remain retryable across enable and a new manager instance",
      "global and target permission compose without enabling one overriding the other",
      "drain reports ready SQL work, not-started execution and undelivered parent independently",
      "drain requires independently closed child execution and observed parent result after SQL settles",
      "completed selected child remains in the cohort until parent and all retained native attempts are accounted for",
      "revision change during workflow observation invalidates the snapshot while retaining cohort diagnostics",
      "previous-instance commands refuse and cross-observation instance changes invalidate rather than erase the cohort",
      "target drain names an unaffected waiting sibling and global retirement closes it without a human answer",
      "enable receipts and superseded disabled receipts never report admission closed",
      "actual CLI change and status work with unreachable Temporal and unreadable TLS files",
      "actual CLI rejects extra fields, malformed JSON and unknown operations without disclosing private input",
      "unconfirmed native stop stays pending until an authoritative stopped fact permits retry",
      "reconciliation retries incomplete parent and native facts after enable but excludes fully settled history"
    ],
    "count": 19
  },
  "workflow": {
    "file": "tests/service/delegation-control-workflow.test.ts",
    "sourceCases": [
      "ready retirement reaches actual child closure without a target runner or provider invocation",
      "disabling a running Pi child closes its actual provider socket and known runner before drain completes",
      "unanswered recorder cards close without owner answers and ordered failures wait separately for parent follow-up and confirmed native stop",
      "an approved resumed recorder keeps its committed receipt while control retires its native continuation",
      "target disable names the unaffected waiting recorder and global disable later retires it",
      "a real restarted worker reconciles a pre-target waiting history after missed wake and re-enable"
    ],
    "count": 6
  },
  "restore": {
    "file": "tests/service/recovery.test.ts",
    "sourceCases": [
      "freeze blocks every domain writer including TRUNCATE, survives reconnect, and interrupted capture stays held",
      "freeze waits for an already admitted writer before claiming a stable boundary",
      "capture produces checksummed generation and rejects tampering or an unfenced new table",
      "source cannot resume after authority transfers; arbitrary second clone is rejected",
      "restore rejects version mismatch and leaves matching restore held until explicit reconciliation",
      "real PostgreSQL archive restores mappings, checkpoint, committed replay and observation to isolated database; pending remains held",
      "capture accepts the routine tables, and a firing claimed at capture is re-driven after restore with its stored identity",
      "SIGKILL after external activation before database activation is safely retryable on restored instance",
      "native lifetime barrier waits for surviving lease and held state rejects new native admission",
      "external preparation before DB freeze cannot authorize restore overlap",
      "retained A backup restores to C after A\u2192B, but only after current owner B is quiesced",
      "a restored audit trail never reissues an event ID, even when one generation is restored twice, whatever the clocks",
      "a restored installation revokes every standing grant as it resumes; a held source keeps its own",
      "a card keeps its absolute deadline across a restore, and past it only the restored installation settles it, once",
      "capture accepts the memory tables, and a held installation refuses every memory write",
      "capture accepts the handoff table, and a held installation refuses every handoff write",
      "a restored installation suspends every active memory as it resumes; a held source keeps its own",
      "capture accepts the usage tables; a restore rewinds the ledger and budgets and resume leaves both as restored",
      "capture counts member instructions, a held installation refuses them, and a restore keeps them as they were",
      "capture counts instruction packs, a held installation refuses every pack write, and a restore keeps them as they were",
      "a restore past the fence epoch, its epoch file missing or behind, starts above every ID the restored identity drew",
      "an audit epoch past the last is refused before authority moves, and the source can resume",
      "a fence that returns no epoch is refused, and a retry with an upgraded fence and the same target succeeds",
      "a transfer interrupted between its epoch and state writes leaves the epoch higher, never lower",
      "an unreadable fence epoch file fails every fence operation instead of reading as 0",
      "a fence epoch below the minimum, or an identity drawn during the transfer, is refused with the retry instruction",
      "bundle directory fsync failure cannot record a successful or transferable backup",
      "restoring an older snapshot atomically retires named roles and delegation while preserving recorded child identity"
    ],
    "count": 1,
    "pattern": "restoring an older snapshot atomically retires named roles and delegation while preserving recorded child identity"
  }
};
const source=process.cwd(),controller=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const revision=process.env.CONTROL_SQL_SOURCE,probe=process.env.CONTROL_SQL_CONTROLLER,suiteName=process.env.CONTROL_SQL_SUITE;
const output=resolve(source,'../artifacts');
mkdirSync(output,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(join(output,name+'.json'),JSON.stringify(value,null,2)+'\n');
function git(args,cwd=source) {
  const result=spawnSync('git',args,{cwd,maxBuffer:64*1024*1024});
  assert.equal(result.status,0,result.stderr?.toString());return result.stdout;
}
function manifest(label) {
  const stage=git(['ls-files','--stage','-z']);
  writeFileSync(join(output,label+'.git-stage'),stage);
  writeFileSync(join(output,label+'.git-status'),git(['status','--porcelain','--untracked-files=all','-z']));
  writeFileSync(join(output,label+'.git-diff'),git(['diff','HEAD','--binary','--no-ext-diff']));
  return stage.toString().split('\0').filter(Boolean).map(entry=>{
    const match=entry.match(/^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/);assert.ok(match);
    const [,mode,blob,path]=match;
    const bytes=mode==='120000'?Buffer.from(readlinkSync(join(source,path))):readFileSync(join(source,path));
    assert.equal(hash(bytes),hash(git(['cat-file','blob',blob])),'tracked source differs from Git '+path);
    return {path,mode,blob,bytes:bytes.length,sha256:hash(bytes)};
  });
}
const commands=[],cleanupFailures=[];
let captureCommand,before,admin,database,databaseInventory,Pool,failure;
async function must(name,program,args,env={}) {
  const previous=new Map(Object.keys(env).map(key=>[key,process.env[key]]));
  let capturedFailure;
  try {
    Object.assign(process.env,env);
    try {await captureCommand(join(output,name+'.log'),program,args);}
    catch(error) {capturedFailure=error;}
  } finally {
    for(const [key,value] of previous) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
  const receiptName=name+'.log.result.json';
  commands.push({name,program,args,receipt:receiptName});save('commands',commands);
  const receipt=JSON.parse(readFileSync(join(output,receiptName),'utf8'));
  assert.deepEqual(receipt.failures,[]);assert.equal(receipt.deadlineExceeded,false);
  assert.equal(receipt.truncated,false);assert.equal(receipt.interrupted,undefined);
  assert.equal(receipt.received,receipt.retained);assert.ok(receipt.received<=8*1024*1024);
  assert.equal(lstatSync(join(output,name+'.log')).size,receipt.retained);
  assert.equal(receipt.outcome.kind,'exited');assert.equal(receipt.outcome.code,0,name+' failed');
  if(capturedFailure)throw capturedFailure;
}
try {
  assert.match(revision,/^[a-f0-9]{40}$/);assert.match(probe,/^[a-f0-9]{40}$/);
  assert.ok(Object.hasOwn(suites,suiteName),'Unknown suite');
  const suite=suites[suiteName];
  assert.equal(process.version,'v24.22.3');assert.equal(process.platform,'linux');
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(git(['rev-parse','HEAD']).toString().trim(),revision);
  assert.equal(git(['rev-parse','HEAD'],controller).toString().trim(),probe);
  assert.equal(git(['status','--porcelain','--untracked-files=all']).length,0);
  before=manifest('source-before');save('source-before',before);
  const helper='tests/proof/member-service-diagnostics.mts';
  assert.equal(hash(readFileSync(join(source,helper))),'40249b71a0d489b4f9a211507bee66264a346de09cb8e3e8ebe7bfabb99a3c85');
  save('identity',{revision,tree:git(['rev-parse','HEAD^{tree}']).toString().trim(),probe,suite:suiteName,node:process.version,
    nodeExecutableSha256:hash(readFileSync(process.execPath)),runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,
    isolation:'Independent fresh hosted VM and owned PostgreSQL17 service per suite. Canonical command capture. Generic descendant absence is unproven.'});
  const path='tests/proof/control-sql-boundaries.mjs',bytes=readFileSync(join(controller,path));
  const blob=git(['rev-parse','HEAD:'+path],controller).toString().trim();assert.ok(bytes.equals(git(['cat-file','blob',blob],controller)));
  save('controller-source',{path,blob,sha256:hash(bytes)});
  const sourceCases=[...readFileSync(join(source,suite.file),'utf8').matchAll(/^test\((["'])(.*?)\1,/gm)].map(match=>match[2]);
  assert.deepEqual(sourceCases,suite.sourceCases,'Frozen suite definitions differ');
  const expectedCases=suite.pattern?[suite.pattern]:suite.sourceCases;
  assert.equal(expectedCases.length,suite.count);save('expected-suite',{suite:suiteName,...suite,expectedCases});
  ({captureCommand}=await import(pathToFileURL(join(source,helper)).href));
  await must('npm-ci','npm',['ci']);await must('build','npm',['run','build']);await must('dependency-graph','npm',['ls','--all','--json']);
  const environment={BIRBCREW_PROOF_WORKING_STATE:'github-hosted-vm'};
  if(suiteName==='workflow') {
    const tools=join(source,'.proof/control-tools');mkdirSync(tools,{recursive:true});
    const archive='temporal_cli_1.10.0_linux_amd64.tar.gz',archivePath=join(tools,archive),checksums=join(output,'temporal-checksums.txt');
    const release='https://github.com/temporalio/cli/releases/download/v1.10.0/';
    await must('temporal-download','curl',['--fail','--silent','--show-error','--location',release+archive,'--output',archivePath]);
    await must('temporal-checksums-download','curl',['--fail','--silent','--show-error','--location',release+'checksums.txt','--output',checksums]);
    const entries=readFileSync(checksums,'utf8').trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>parts[1]===archive);
    assert.equal(entries.length,1);assert.match(entries[0][0],/^[a-f0-9]{64}$/);
    const check=join(output,'temporal-selected-checksum.txt');writeFileSync(check,entries[0][0]+'  '+archivePath+'\n');
    await must('temporal-checksum','sha256sum',['--check',check]);
    await must('temporal-extract','tar',['-xzf',archivePath,'-C',tools,'temporal']);
    environment.TEMPORAL_CLI=join(tools,'temporal');
    await must('temporal-version',environment.TEMPORAL_CLI,['--version']);
    assert.match(readFileSync(join(output,'temporal-version.log'),'utf8'),/\b1\.10\.0\b/);
    const launcher=join(source,'.proof/bin/member-launch');assert.ok(lstatSync(launcher).isFile());
    save('native-tools',{temporal:{release,archiveSha256:entries[0][0],binarySha256:hash(readFileSync(environment.TEMPORAL_CLI))},
      confinementLauncher:{path:'.proof/bin/member-launch',sha256:hash(readFileSync(launcher))}});
  }
  const require=createRequire(join(source,'package.json'));({Pool}=require('pg'));
  admin=new Pool({connectionString:process.env.CONTROL_SQL_DATABASE_URL,statement_timeout:15_000,connectionTimeoutMillis:10_000});
  const {rows:[version]}=await admin.query('SHOW server_version_num');assert.equal(Math.floor(Number(version.server_version_num)/10000),17);save('postgres',version);
  databaseInventory=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;save('database-inventory-before',databaseInventory);
  const identity=hash([revision,probe,suiteName,process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT].join(':')).slice(0,16);
  const proposedDatabase=`control_${suiteName}_${identity}`;
  assert.match(proposedDatabase,/^[a-z0-9_]{1,63}$/);await admin.query(`CREATE DATABASE "${proposedDatabase}"`);
  database=proposedDatabase;save('owned-database',{database,created:true});
  const createdInventory=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
  save('database-inventory-created',createdInventory);
  assert.deepEqual(createdInventory,[...databaseInventory,{datname:database}].sort((a,b)=>a.datname<b.datname?-1:a.datname>b.datname?1:0));
  const url=new URL(process.env.CONTROL_SQL_DATABASE_URL);url.pathname='/'+database;
  const fresh=new Pool({connectionString:url.toString(),statement_timeout:15_000,connectionTimeoutMillis:10_000});
  try {
    const {rows:[identity]}=await fresh.query("SELECT current_database() AS database,to_regnamespace('birbcrew_ts') IS NULL AS empty");
    save('owned-database-freshness',identity);assert.equal(identity.database,database);assert.equal(identity.empty,true);
  } finally {await fresh.end();}
  const caseOutput=join(output,'cases');mkdirSync(caseOutput,{recursive:true});
  Object.assign(environment,{BIRBCREW_TEST_DATABASE_URL:url.toString(),BIRBCREW_CONTROL_PROOF_DIR:caseOutput,
    BIRBCREW_TEST_DATABASE_PREFIX:`ctl_${suiteName}_${identity}_`});
  if(suiteName==='restore') {
    assert.match(process.env.CONTROL_SQL_POSTGRES_CONTAINER,/^[a-f0-9]{12,64}$/);
    environment.BIRBCREW_RECOVERY_POSTGRES_CONTAINER=process.env.CONTROL_SQL_POSTGRES_CONTAINER;
    save('restore-environment',{postgresContainer:environment.BIRBCREW_RECOVERY_POSTGRES_CONTAINER,
      databaseVariable:'BIRBCREW_TEST_DATABASE_URL',childDatabasePrefix:environment.BIRBCREW_TEST_DATABASE_PREFIX});
    await must('postgres-container','docker',['inspect','--format','{{.Config.Image}}',environment.BIRBCREW_RECOVERY_POSTGRES_CONTAINER]);
    assert.equal(readFileSync(join(output,'postgres-container.log'),'utf8').trim(),'postgres:17');
  }
  const args=['--test','--test-reporter=tap','--test-concurrency=1'];
  if(suite.pattern)args.push('--test-name-pattern',suite.pattern);
  args.push(suite.file);
  await must(suiteName+'-tests',process.execPath,args,environment);
  const tap=readFileSync(join(output,suiteName+'-tests.log'),'utf8');
  const actualCases=[...tap.matchAll(/^ok [0-9]+ - (.+)$/gm)].map(match=>match[1]);
  assert.deepEqual(actualCases,expectedCases);assert.ok(tap.split('\n').includes('1..'+suite.count),'Unexpected TAP plan');
  const totals={};
  for(const [name,expected] of Object.entries({tests:suite.count,suites:0,pass:suite.count,fail:0,cancelled:0,skipped:0,todo:0})) {
    const match=tap.match(new RegExp('^# '+name+' ([0-9]+)$','m'));assert.ok(match,'Missing TAP total '+name);
    totals[name]=Number(match[1]);assert.equal(totals[name],expected,'Unexpected TAP total '+name);
  }
  save('tap',{suite:suiteName,actualCases,...totals});
  const caseFiles=readdirSync(caseOutput);save('case-artifacts',caseFiles);
  if(suiteName==='sql')assert.ok(caseFiles.includes('sql-first-observations.json'));
  if(suiteName==='store')assert.ok(caseFiles.includes('control-store-observations.json'));
  if(suiteName==='workflow') {
    for(const name of ['cleanup.json','diagnostic-retention.json','captured-provider-requests.json'])assert.ok(caseFiles.includes(name),'Missing actual workflow evidence '+name);
    const cleanup=JSON.parse(readFileSync(join(caseOutput,'cleanup.json'),'utf8')).value;
    assert.deepEqual(cleanup.failures,[]);assert.equal(cleanup.workingState,'hosted-vm');
    assert.equal(cleanup.diagnosticRetention,'completed');
    assert.ok(cleanup.knownProcesses.length>0);assert.ok(cleanup.knownProcesses.every(row=>row.stopped));
    assert.ok(cleanup.runnerObservations.length>0);assert.ok(cleanup.runnerObservations.every(row=>row.absent));
    const retention=JSON.parse(readFileSync(join(caseOutput,'diagnostic-retention.json'),'utf8')).value;
    assert.equal(retention.complete,true);assert.ok(retention.observations.every(row=>row.captureClosed));
  }
  if(suiteName!=='restore') {
    const state=new Pool({connectionString:url.toString(),statement_timeout:15_000,connectionTimeoutMillis:10_000});
    try {
      save('migrations',(await state.query('SELECT * FROM birbcrew_ts.schema_versions ORDER BY version')).rows);
      save('control',(await state.query('SELECT * FROM birbcrew_ts.delegation_control')).rows);
    } finally {await state.end();}
  }
} catch(error) {
  failure=error;save('failure',{name:error.name,message:error.message,stack:error.stack});
} finally {
  if(admin) {
    if(database) {
      try {
        const sessions=(await admin.query('SELECT datname,pid,state FROM pg_stat_activity WHERE datname=$1 OR datname LIKE $2 ORDER BY datname,pid',
          [database,`ctl_${suiteName}_%`])).rows;
        save('sessions-before-cleanup',sessions);assert.deepEqual(sessions,[]);
        await admin.query(`DROP DATABASE "${database}"`);
        const remaining=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows;
        save('owned-database-after',remaining);assert.deepEqual(remaining,[]);
      } catch(error) {cleanupFailures.push(error.message);}
    }
    if(databaseInventory)try {
      const inventory=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
      save('database-inventory-after',inventory);assert.deepEqual(inventory,databaseInventory);
    } catch(error) {cleanupFailures.push(error.message);}
    try {await admin.end();}catch(error) {cleanupFailures.push(error.message);}
  }
  try {
    const after=manifest('source-after');save('source-after',after);assert.deepEqual(after,before);
    const porcelain=git(['status','--porcelain','--untracked-files=all']).toString();assert.equal(porcelain,'');
    save('source-status',{porcelain,trackedUnchanged:true});
  } catch(error) {cleanupFailures.push(error.message);}
  save('cleanup',{failures:cleanupFailures});
  save('result',{status:failure||cleanupFailures.length?'FAIL':'PASS',revision,suite:suiteName});
  const checksums=[];
  function collect(directory) {
    for(const name of readdirSync(directory).sort()) {
      const file=join(directory,name),entry=lstatSync(file);assert.ok(!entry.isSymbolicLink(),'artifact symlink');
      if(entry.isDirectory())collect(file);
      else {
        assert.ok(entry.isFile()&&entry.nlink===1,'artifact must be a separate regular file');
        if(file!==join(output,'artifact-checksums.json'))checksums.push({path:file.slice(output.length+1),bytes:entry.size,sha256:hash(readFileSync(file))});
      }
    }
  }
  try {collect(output);save('artifact-checksums',checksums);}
  catch(error) {
    cleanupFailures.push(error.message);save('cleanup',{failures:cleanupFailures});
    save('result',{status:'FAIL',revision,suite:suiteName});
  }
}
if(failure||cleanupFailures.length)process.exitCode=1;
