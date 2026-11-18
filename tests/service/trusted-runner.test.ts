import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import test from "node:test";
import { Pool } from "pg";
import { MemberStore } from "../../src/service/store.ts";
import { TrustedContextStore,type TrustedApplication } from "../../src/service/trusted-context.ts";
import { runTrustedRequest } from "../../src/service/trusted-runner.ts";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";
import type { TrustedNativeProfile } from "../../src/service/trusted-native.ts";
import { startProvider } from "../fixtures/engines/codex/provider.mts";
import type { PriceTable } from "../../src/service/usage-prices.ts";

const database=process.env.BIRBCREW_TEST_DATABASE_URL;
if(!database)throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");

async function providerFixture(engine:"pi"|"claude"|"codex") {
  const seen:string[]=[];
  if(engine === "codex") {
    const fixture=await startProvider(()=>{},(_prompt,system,messages)=>{seen.push(system+messages);},"application",
      ()=>({input_tokens:100,input_tokens_details:{cached_tokens:40},output_tokens:9,output_tokens_details:{reasoning_tokens:2},total_tokens:109}));
    return {...fixture,seen};
  }
  const server=createServer(async(req,res)=>{
    try {
      const body=await json(req) as any;seen.push(JSON.stringify(body));
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      if(engine === "pi") {
        const messages=body.messages.map((m:any)=>({...m,content:typeof m.content === "string"?m.content:(m.content??[]).map((p:any)=>p.text??"").join("")}));
        const last=messages.findLastIndex((m:any)=>m.role === "user");
        const prompt=messages[last].content,result=messages.slice(last+1).findLast((m:any)=>m.role === "tool");
        const call=!result && (prompt === "choose" || prompt.startsWith("record "));
        const content=result?"received "+result.content:"recalled none";
        const frame=(delta:object,finish_reason:string|null=null)=>res.write("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+"\n\n");
        frame({role:"assistant",...(call?{tool_calls:[{index:0,id:"call_"+randomUUID(),type:"function",function:{name:prompt === "choose"?"choose_next_step":"record_work_item",arguments:JSON.stringify(prompt === "choose"?{}:{operation_id:prompt.slice(7)})}}]}:{content})});
        frame({},call?"tool_calls":"stop");
        res.write("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:body.model,choices:[],
          usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:40},completion_tokens:9,total_tokens:109}})+"\n\n");
        res.end("data: [DONE]\n\n");return;
      }
      const prompts=body.messages.filter((m:any)=>m.role === "user").flatMap((m:any)=>typeof m.content === "string"?[m.content]:m.content.filter((p:any)=>p.type === "text").map((p:any)=>p.text));
      const prompt=prompts.at(-1);const last=body.messages.at(-1)?.content;
      const result=Array.isArray(last)?last.find((p:any)=>p.type === "tool_result"):undefined;
      const call=!result && (prompt === "choose" || prompt?.startsWith("record "));
      const toolName=prompt === "choose"?"choose_next_step":"record_work_item";
      const output=result?"received "+JSON.stringify(result.content):"recalled none";
      const send=(type:string,value:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
      send("message_start",{message:{id:"msg_"+randomUUID(),type:"message",role:"assistant",model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
      send("content_block_start",{index:0,content_block:call?{type:"tool_use",id:"toolu_"+randomUUID(),name:"mcp__ag_ui__"+toolName,input:{}}:{type:"text",text:""}});
      send("content_block_delta",{index:0,delta:call?{type:"input_json_delta",partial_json:JSON.stringify(prompt === "choose"?{}:{operation_id:prompt.slice(7)})}:{type:"text_delta",text:output}});
      send("content_block_stop",{index:0});send("message_delta",{delta:{stop_reason:call?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:10}});send("message_stop",{});res.end();
    }catch(error){res.destroy(error as Error);}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");
  return {seen,url:`http://127.0.0.1:${address.port}`,async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}

for(const engine of ["pi","claude","codex"] as const) {
  test(`${engine}: real SDK and PostgreSQL runner preserve receipts, queue and conversation through context rotation`,{timeout:150000},async t=>{
    const scopeA="PRIVATE-A-"+randomUUID(),scopeB="CHANNEL-B-"+randomUUID();
    const pool=new Pool({connectionString:database,max:12});t.after(()=>pool.end());
    const members=new MemberStore(pool);await members.migrate();
    await pool.query("CREATE TABLE IF NOT EXISTS birbcrew_ts.test_runner_effects (operation_id uuid PRIMARY KEY,scope text NOT NULL)");
    const ownerId=randomUUID(),member=await members.spawn({ownerId,requestId:randomUUID(),engine,profile:"trusted-runner-fixture"});
    const key={ownerId,conversationId:randomUUID()};await members.openConversation({...key,memberId:member.memberId});
    const app:TrustedApplication={id:"runner-fixture-v1",authorize:async authority=>authority.ownerId===ownerId && [scopeA,scopeB].includes(authority.scope),tools:[
      {name:"choose_next_step",description:"Read the application context scope.",kind:"read",inputSchema:{type:"object",additionalProperties:false,properties:{}},
        maxArgumentBytes:1024,maxResultBytes:4096,deadlineMs:5000,execute:async({authority})=>({scope:authority.scope,version:authority.version})},
      {name:"record_work_item",description:"Write one fixture effect with a durable receipt.",kind:"effect",inputSchema:{type:"object",additionalProperties:false,required:["operation_id"],properties:{operation_id:{type:"string",maxLength:36},note:{type:"string",maxLength:128}}},
        maxArgumentBytes:4096,maxResultBytes:4096,deadlineMs:5000,execute:async({operationId,authority})=>{
          await pool.query("INSERT INTO birbcrew_ts.test_runner_effects(operation_id,scope) VALUES ($1,$2) ON CONFLICT DO NOTHING",[operationId,authority.scope]);
          return {receipt:operationId,scope:authority.scope};}},
    ]};
    const store=new TrustedContextStore(pool,app);await store.open(key,{scope:scopeA,version:"v1",text:"Authorized context "+scopeA});
    const native=await providerFixture(engine);t.after(native.close);
    const model=engine === "pi"?"fixture-chat":engine === "claude"?"claude-sonnet-4-6":"gpt-5.4";
    const prices:PriceTable=new Map([[model,{input:"1",cachedInput:"0.5",cacheWrite:"1",output:"2"}]]);
    const proxy=await createProxyProfile({engine,model,protocol:engine === "pi"?"openai-chat-completions":engine === "claude"?"anthropic-messages":"openai-responses",
      accountId:"fixture",endpoint:native.url+(engine === "pi"?"/chat/completions":engine === "claude"?"/v1/messages":"/responses"),allowHttpLoopback:true,
      resolveCredential:async()=>({headers:{Authorization:"Bearer fixture-only"},expiresAt:Date.now()+60000})});t.after(proxy.close);
    const stateDir=await mkdtemp(join(tmpdir(),"trusted-runner-"));t.after(()=>rm(stateDir,{recursive:true,force:true}));
    const identity={stateDir,ownerId,memberId:member.memberId};
    const profile:TrustedNativeProfile=engine === "pi"?{engine,profile:proxy.profile.pi!}:engine === "claude"?{engine,profile:{...proxy.profile.claude!,...identity}}:{engine,profile:{...proxy.profile.codex!,...identity}};
    const read=randomUUID(),effect=randomUUID(),afterRotation=randomUUID();
    assert.equal(await store.submit(key,read,"choose"),1);assert.equal(await store.submit(key,effect,"record "+effect),2);
    assert.deepEqual(await runTrustedRequest(store,key,profile,t.signal,prices),{requestId:read});
    assert.equal((await store.result(key,read)).phase,"completed");
    assert.ok((await store.result(key,read)).reply?.includes(scopeA));
    assert.deepEqual(await runTrustedRequest(new TrustedContextStore(pool,app),key,profile,t.signal,prices),{requestId:effect});
    assert.ok((await store.result(key,effect)).reply?.includes("receipt"));
    const calls=(await pool.query("SELECT tool_name,kind,outcome,released,acknowledged FROM birbcrew_ts.trusted_tool_calls WHERE conversation_id=$1",[key.conversationId])).rows;
    assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.tool_name).sort(),["choose_next_step","record_work_item"]);
    for(const call of calls)assert.deepEqual({outcome:call.outcome,released:call.released,acknowledged:call.acknowledged},{outcome:"completed",released:true,acknowledged:true});
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.test_runner_effects WHERE scope=$1",[scopeA])).rowCount,1);
    const old=(await pool.query("SELECT native_thread_id FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rows[0];
    assert.equal(await store.submit(key,afterRotation,"recall"),3);
    await store.invalidate(key,1,{scope:scopeB,version:"v2",text:"Authorized context "+scopeB});await store.finishRotation(key);
    assert.deepEqual(await store.result(key,afterRotation),{phase:"held",reply:null});
    await store.releaseHeld(key,afterRotation,"run");
    const before=native.seen.length;
    assert.deepEqual(await runTrustedRequest(store,key,profile,t.signal,prices),{requestId:afterRotation});
    const requests=native.seen.slice(before);assert.ok(requests.length);assert.ok(requests.some(r=>r.includes(scopeB)));assert.ok(requests.every(r=>!r.includes(scopeA)));
    const current=(await pool.query("SELECT conversation_id,generation,native_thread_id FROM birbcrew_ts.trusted_sessions WHERE conversation_id=$1",[key.conversationId])).rows[0];
    assert.equal(current.conversation_id,key.conversationId);assert.equal(current.generation,2);assert.notEqual(current.native_thread_id,old.native_thread_id);
    const order=(await pool.query("SELECT request_id,phase FROM birbcrew_ts.trusted_requests WHERE conversation_id=$1 ORDER BY position",[key.conversationId])).rows;
    assert.deepEqual(order,[read,effect,afterRotation].map(request_id=>({request_id,phase:"completed"})));
    assert.equal(await runTrustedRequest(store,key,profile,t.signal,prices),null);

    // One ledger row per trusted request, in its own lane: no launch token, bound to the request. The
    // read and the effect each took two model calls (the tool call, then the answer), the recall one.
    // Claude's fixture reports 10 and 10 per call; the others 100 input (40 cached) and 9 output.
    const {rows:usage}=await pool.query(`SELECT request_id,token,trusted_request_id=request_id AS bound,engine,state,model,input_tokens AS input,
      output_tokens AS output,cached_input_tokens AS cached,estimated_cost_usd::text AS estimate FROM birbcrew_ts.usage_ledger
      WHERE conversation_id=$1 ORDER BY usage_id`,[key.conversationId]);
    const call=engine === "claude"?{input:10,output:10,cached:0,picodollars:30_000_000}:{input:100,output:9,cached:40,picodollars:98_000_000};
    const row=(request_id:string,calls:number)=>({request_id,token:null,bound:true,engine,state:"reported",model,input:call.input*calls,
      output:call.output*calls,cached:call.cached*calls,estimate:(call.picodollars*calls/1e12).toFixed(12)});
    assert.deepEqual(usage,[row(read,2),row(effect,2),row(afterRotation,1)]);
  });
}
