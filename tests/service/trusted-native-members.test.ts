import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { json } from "node:stream/consumers";
import test from "node:test";
import { runTrustedNativeTurn,type TrustedNativeInput,type TrustedNativeProfile,type TrustedNativeTool } from "../../src/service/trusted-native.ts";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";
import { startProvider } from "../fixtures/engines/codex/provider.mts";

const tools:TrustedNativeTool[]=[
  {name:"choose_next_step",description:"Read the current application next step.",inputSchema:{type:"object",additionalProperties:false,properties:{}},maxArgumentBytes:1024,maxResultBytes:4096,deadlineMs:5000},
  {name:"record_work_item",description:"Record an application fixture effect.",inputSchema:{type:"object",additionalProperties:false,required:["operation_id"],properties:{operation_id:{type:"string"},note:{type:"string"}}},maxArgumentBytes:4096,maxResultBytes:4096,deadlineMs:5000},
];
async function piProvider() {
  const catalogs:string[][]=[];
  const server=createServer(async(req,res)=>{
    try {
      const body=await json(req) as any;catalogs.push(body.tools.map((t:any)=>t.function.name));
      body.messages=body.messages.map((m:any)=>({...m,content:typeof m.content === "string" ? m.content : (m.content ?? []).map((p:any)=>p.text ?? "").join("")}));
      const lastUser=body.messages.findLastIndex((m:any)=>m.role==="user");
      const prompt=body.messages[lastUser].content;
      const result=body.messages.slice(lastUser+1).findLast((m:any)=>m.role==="tool");
      const call=!result && (prompt === "choose" || prompt.startsWith("record "));
      const remembered=body.messages.find((m:any)=>m.role==="user" && m.content.startsWith("remember "))?.content.slice(9);
      const content=result ? "received "+result.content : prompt==="recall" ? "recalled "+(remembered ?? "none") : "stored "+remembered;
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const frame=(delta:object,finish_reason:string|null=null)=>res.write("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+"\n\n");
      frame({role:"assistant",...(call?{tool_calls:[{index:0,id:"call_"+randomUUID(),type:"function",function:{name:prompt==="choose"?"choose_next_step":"record_work_item",arguments:JSON.stringify(prompt==="choose"?{}:{operation_id:prompt.slice(7)})}}]}:{content})});
      frame({},call?"tool_calls":"stop");res.end("data: [DONE]\n\n");
    }catch(error){res.destroy(error as Error);}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");
  return {url:`http://127.0.0.1:${address.port}`,catalogs,async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
for(const engine of ["pi","claude","codex"] as const) {
  test(`${engine}: trusted registered read/effect, native result correlation, restore and scope rotation`,{timeout:120000},async t=>{
    const observed:string[][]=[];
    const provider=engine==="pi"?await piProvider():engine==="claude"?await startClaudeFixtureProvider(()=>{},value=>{observed.push(value.tools);}):await startProvider(undefined,undefined,"application");
    t.after(provider.close);
    const model=engine==="pi"?"fixture-chat":engine==="claude"?"claude-sonnet-4-6":"gpt-5.4";
    const profile=await createProxyProfile({engine,model,protocol:engine==="pi"?"openai-chat-completions":engine==="claude"?"anthropic-messages":"openai-responses",
      accountId:"trusted-fixture",endpoint:provider.url+(engine==="pi"?"/chat/completions":engine==="claude"?"/v1/messages":"/responses"),
      allowHttpLoopback:true,resolveCredential:async()=>({headers:{Authorization:"Bearer fixture-only"},expiresAt:Date.now()+60000})});
    t.after(profile.close);
    const stateDir=await mkdtemp(join(tmpdir(),"trusted-native-"));t.after(()=>rm(stateDir,{recursive:true,force:true}));
    const identity={ownerId:"fixture-owner",memberId:randomUUID(),stateDir};
    const selected:TrustedNativeProfile=engine==="pi"?{engine,profile:profile.profile.pi!}:engine==="claude"?{engine,profile:{...profile.profile.claude!,...identity}}:{engine,profile:{...profile.profile.codex!,...identity}};
    const calls:{nativeCallId:string;toolName:string}[]=[];const acks:{nativeCallId:string;toolName:string}[]=[];
    const input:TrustedNativeInput={engine,threadId:randomUUID(),runId:randomUUID(),text:"remember private-A",context:"Scope A private authorized context",binding:"owner/A/v1/g1",checkpoint:null,signal:t.signal,tools,
      async dispatch(call){calls.push({nativeCallId:call.nativeCallId,toolName:call.toolName});
        return {text:call.toolName==="choose_next_step"?"inspect":JSON.stringify({kind:"recorded",nativeCallId:call.nativeCallId,receipt:{receiptId:"receipt-fixture",operationId:(call.args as any).operation_id}}),isError:false};},
      onToolDelivered(call){acks.push(call);}};
    if (engine === "codex") {
      await assert.rejects(runTrustedNativeTurn(input, selected), /Codex trusted lane was removed/);
      return;
    }
    const first=await runTrustedNativeTurn(input,selected);assert.ok(first.text.includes("private-A"));
    const restored=await runTrustedNativeTurn({...input,runId:randomUUID(),text:"recall",checkpoint:first.checkpoint},selected);assert.ok(restored.text.includes("private-A"));
    await assert.rejects(runTrustedNativeTurn({...input,runId:randomUUID(),binding:"owner/B/v1/g1",checkpoint:restored.checkpoint},selected),/scope or capabilities/);
    const rotated=await runTrustedNativeTurn({...input,threadId:randomUUID(),runId:randomUUID(),text:"recall",context:"Scope B",binding:"owner/B/v1/g2"},selected);assert.ok(rotated.text.includes("none"));
    const read=await runTrustedNativeTurn({...input,threadId:randomUUID(),runId:randomUUID(),text:engine==="claude"?"next step":"choose"},selected);assert.ok(read.text.includes("inspect"));
    const operation=randomUUID();const effect=await runTrustedNativeTurn({...input,threadId:randomUUID(),runId:operation,text:"record "+operation},selected);assert.ok(effect.text.includes("receipt-fixture"));
    assert.equal(calls.length,2);assert.deepEqual(acks,calls);
    if(engine==="pi" && "catalogs" in provider)for(const names of provider.catalogs as string[][])assert.deepEqual([...names].sort(),tools.map(t=>t.name).sort());
    if(engine==="claude")for(const names of observed)assert.deepEqual([...names].sort(),tools.map(t=>"mcp__ag_ui__"+t.name).sort());
  });
}
