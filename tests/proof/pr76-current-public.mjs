import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [source,label,output]=process.argv.slice(2);
assert.ok(source && output && ['baseline','head'].includes(label));
const root=resolve(source), load=p=>import(pathToFileURL(join(root,p)).href);
const {default:pg}=await load('node_modules/pg/lib/index.js');
const {MemberStore}=await load('src/service/store.ts');
const {ChildStore}=await load('src/service/children.ts');
const {registerProfiles}=await load('src/service/deployment.ts');
const {createGateway}=await load('src/service/gateway.ts');
const {createPiFixtureOptions}=await load('tests/fixtures/engines/pi/index.mts');
const pool=new pg.Pool({connectionString:process.env.BIRBCREW_TEST_DATABASE_URL});
const store=new MemberStore(pool), children=new ChildStore(pool);
const state=await mkdtemp(join(tmpdir(),'crew-current76-public-'));
const save=(name,value)=>writeFile(join(output,name+'.json'),JSON.stringify(value,null,2)+'\n');
let gateway;
try {
  await store.migrate();
  const pi=await createPiFixtureOptions();
  const parentPi={...pi,model:{...pi.model,id:'ship-parent-model',baseUrl:'https://parent.fixture.invalid'}};
  const targetPi={...pi,model:{...pi.model,id:'ship-child-model',baseUrl:'https://child.fixture.invalid:8443/v1'}};
  const route={engine:'pi',profile:'ship-target'};
  const config=new Map([['ship-parent',{accountId:'fixture-parent-account',pi:parentPi,delegateTask:true,childTargets:{pi:{analyst:route}}}],['ship-target',{accountId:'fixture-child-account',pi:targetPi}]]);
  await registerProfiles(pool,config,state);
  const owner='ship-owner', token=randomUUID(), other=randomUUID();
  const digest=text=>createHash('sha256').update(text).digest('hex');
  gateway=createGateway(store,{}, {[digest(token)]:owner,[digest(other)]:'ship-other'});
  gateway.listen(0,'127.0.0.1'); await once(gateway,'listening');
  const endpoint='http://127.0.0.1:'+gateway.address().port;
  const api=async(path,body,bearer=token)=>{
    const response=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  const request={requestId:randomUUID(),engine:'pi',profile:'ship-parent'};
  const spawned=await api('/v1/members',request), listed=await api('/v1/members'), isolated=await api('/v1/members',undefined,other);
  await save('public-wire',{label,spawned,listed,isolated,redaction:'Authorization headers and private request material omitted. All response values are synthetic fixtures.'});
  assert.equal(spawned.status,201); assert.equal(listed.status,200); assert.equal(isolated.status,200);
  assert.deepEqual(isolated.body.members,[]); assert.equal(listed.body.members.length,1);
  assert.equal(listed.body.members[0].memberId,spawned.body.memberId);
  const identity={engine:'pi',profile:'ship-target',model:'ship-child-model',providerHost:'child.fixture.invalid:8443',accountDigest:digest('fixture-child-account')};
  if(label==='head') {
    assert.deepEqual(spawned.body.subagents,{mode:'named',targets:[{...identity,role:'analyst',availability:'executable'}]});
    assert.deepEqual(listed.body.members[0].subagents,spawned.body.subagents);
  } else {
    assert.equal(spawned.body.subagents,undefined); assert.equal(listed.body.members[0].subagents,undefined);
  }
  const conversationId=randomUUID(); await store.openConversation({ownerId:owner,memberId:spawned.body.memberId,conversationId});
  const requestId=randomUUID();
  const turn=await store.beginTurn({ownerId:owner,conversationId,requestId,text:'delegate'},{workflowRunId:randomUUID(),activityId:'fixture',attempt:1});
  assert.equal(turn.kind,'start');
  const [key]=await children.delegate(turn.conversation,requestId,turn.token,[{nativeCallId:'call_'+randomUUID(),task:'remember shared fixture',profile:{role:'analyst',version:1,instructions:'Answer the assigned question using only the supplied task context.',model:'ship-parent-model',tools:[]}}],{version:1,engine:'pi',state:{}});
  const row=(await pool.query(`SELECT child_id,conversation_id,request_id,phase,role_profile->>'role' AS role,
    role_profile->>'model' AS model,role_profile->'tools' AS tools,role_profile->'target' AS target
    FROM birbcrew_ts.pi_children WHERE child_id=$1`,[key.childId])).rows[0];
  await save('public-sql',{label,row});
  assert.equal(row.role,'analyst'); assert.deepEqual(row.tools,[]);
  if(label==='head') {
    assert.equal(row.model,'ship-child-model'); assert.deepEqual(row.target,{version:1,...identity});
    assert.deepEqual(key.target,route);
    const authority=(await pool.query(`SELECT p.child_target_seal,p.child_target_active,m.child_target_consent
      FROM birbcrew_ts.profiles p JOIN birbcrew_ts.members m ON m.profile=p.name AND m.engine=p.engine
      WHERE m.member_id=$1`,[spawned.body.memberId])).rows;
    await save('public-authority',authority);
    assert.equal(authority.length,1); assert.deepEqual(authority[0].child_target_active,['analyst']);
    assert.deepEqual(authority[0].child_target_seal,{mode:'named',roles:{analyst:identity}});
    assert.deepEqual(authority[0].child_target_consent,authority[0].child_target_seal);
  } else { assert.equal(row.model,'ship-parent-model'); assert.equal(row.target,null); }
  await save('public-result',{status:'PASS',label,providerExecution:'Not invoked by this case according to source; no retained provider-request recorder',scope:'Actual HTTP gateway and PostgreSQL delegation.'});
  console.log('COMMON_PUBLIC_PASS',label);
} finally {
  if(gateway) { const closed=once(gateway,'close'); gateway.close(); gateway.closeAllConnections(); await closed; await gateway.stopped(); }
  await pool.end(); await rm(state,{recursive:true,force:true});
}
