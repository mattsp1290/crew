import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { boundedCommand, CommandFailure, now } from './member-service-diagnostics.mts';
const root=process.argv[2];assert(root&&isAbsolute(root));
const deadline=now()+20_000, rows=[];
const names=(await readdir(root)).filter(x=>/^container-guard-[a-zA-Z0-9]+$/.test(x));assert.equal(names.length,1);
const report=JSON.parse(await readFile(join(root,names[0],'report.json'),'utf8'));assert(report.completed&&report.failures.length===0&&report.acquisitions.length===3);
for(const acquired of report.acquisitions){
 assert.equal(acquired.allocation.kind,'returned');assert.equal(acquired.cleanup.kind,'absent');
 const id=acquired.allocation.id;assert.match(id,/^[a-f0-9]{64}$/);assert.match(acquired.name,/^birb-proof-[0-9a-f-]{36}$/);
 const before=[];
 for(const selector of ['name=^/'+acquired.name+'$','id='+id]){
  const result=await boundedCommand('docker',['ps','--no-trunc','-aq','--filter',selector],Math.min(deadline,now()+2_000));assert.equal(result.stdout.kind,'complete');assert.equal(result.stdout.text.trim(),'');before.push(result);
 }
 for(const args of [['inspect','--format','{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}',id],['rm','-f',id]]){
  let observed;
  try{observed={kind:'completed',result:await boundedCommand('docker',args,Math.min(deadline,now()+2_000))};}
  catch(error){
   assert(error instanceof AggregateError&&error.errors.length===1&&error.errors[0] instanceof CommandFailure);
   const failure=error.errors[0];assert.equal(failure.result.kind,'exited');assert.equal(failure.result.code,1);assert(Number.isSafeInteger(error.received)&&error.received<=131072);
   observed={kind:'ordinary-exit-one',received:error.received,pid:error.pid,message:failure.message,result:failure.result};
  }
  rows.push({id,name:acquired.name,args,before,observed});
 }
}
await writeFile(join(root,'docker-missing-calibration.json'),JSON.stringify({completed:true,rows},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({completed:true,commands:rows.length}));
