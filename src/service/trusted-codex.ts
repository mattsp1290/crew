/** Pinned official app-server dynamic tools; deliberately no MCP server. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdir,readdir,realpath } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { codexExecutable } from "./codex-executable.ts";
import { nativeHistory,type CodexProfile } from "./codex.ts";
import { codexSubscriptionEndpoint } from "./accounts.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";
import { codexRolloutModel, codexRolloutTotal, codexUsage } from "./usage-capture.ts";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const saved=z.strictObject({version:z.literal(1),engine:z.literal("codex-app-server"),threadId:z.uuid(),nativeId:z.uuid(),
  memberId:z.uuid(),ownerDigest:z.hash("sha256"),model:z.string(),requestId:z.uuid(),rollout:z.string(),bytes:z.int().positive(),sha256:z.hash("sha256")});
const callSchema=z.object({threadId:z.uuid(),turnId:z.uuid(),callId:z.string().min(1).max(256),namespace:z.literal("application"),tool:z.string(),arguments:z.unknown()});

export async function runTrustedCodex(input:TrustedNativeInput,profile:CodexProfile) {
  input={...input,signal:AbortSignal.any([input.signal,AbortSignal.timeout(170_000)])};
  if (profile.proxyTransport) {
    if (profile.subscription) throw new Error("Proxy and subscription transports cannot be combined");
    const transport = await profile.proxyTransport(input.signal);
    try {
      return await executeTrustedCodex(input,{...profile,proxyTransport:undefined,
        baseUrl:transport.baseUrl,apiKey:transport.apiKey,authorize:profile.authorize ?? (async()=>{})});
    } finally {await transport.close();}
  }
  return executeTrustedCodex(input,profile);
}

async function executeTrustedCodex(input:TrustedNativeInput,profile:CodexProfile) {
  const prior=input.checkpoint===null?null:saved.parse(input.checkpoint);
  const threadId=z.uuid().parse(input.threadId),memberId=z.uuid().parse(profile.memberId),ownerDigest=hash(profile.ownerId);
  if(!isAbsolute(profile.stateDir) || !profile.model)throw new Error("Invalid trusted Codex profile");
  if(prior && (prior.threadId!==threadId || prior.memberId!==memberId || prior.ownerDigest!==ownerDigest || prior.model!==profile.model || prior.requestId===input.runId))throw new Error("Trusted Codex checkpoint identity mismatch");
  const provider=profile.baseUrl?new URL(profile.baseUrl):undefined;
  if(provider && (provider.protocol!=="http:" || provider.hostname!=="127.0.0.1" || !provider.port || provider.username || provider.password || provider.search || provider.hash))throw new Error("Expected scoped loopback Codex provider");
  const approved=profile.authorize!==undefined;
  if(Number(profile.apiKey!==undefined)+Number(profile.subscription!==undefined)!==Number(approved) || profile.apiKey==="" || (!approved&&!provider))throw new Error("Approved Codex account required");
  if(!prior)await mkdir(profile.stateDir,{recursive:true,mode:0o700});
  let parent=await realpath(profile.stateDir);
  for(const part of ["codex",ownerDigest,memberId]) {
    parent=join(parent,part);if(!prior)await mkdir(parent,{recursive:true,mode:0o700});
    if(await realpath(parent)!==parent)throw new Error("Invalid native storage");
  }
  const root=join(parent,threadId),home=join(root,"home"),scratch=join(root,"workspace");
  if(!prior){await mkdir(root,{mode:0o700});await mkdir(home,{mode:0o700});await mkdir(scratch,{mode:0o700});}
  if(await realpath(home)!==home || await realpath(scratch)!==scratch)throw new Error("Invalid native storage");
  // The app-server reports no per-turn usage; the rollout's running total does, as on the member lane.
  let priorTotal:ReturnType<typeof codexRolloutTotal>=null;
  if(prior){const actual=await nativeHistory(home,scratch,prior.nativeId,prior.rollout,lines=>{priorTotal=codexRolloutTotal(lines);});if(actual.bytes!==prior.bytes || actual.sha256!==prior.sha256)throw new Error("Trusted native history changed");}
  const ambient=["auth.json","config.toml","mcp.json","hooks.json","AGENTS.md","AGENTS.override.md","plugins","rules","agents",".codex",".agents"];
  if((await readdir(home)).some(n=>ambient.includes(n)) || (await readdir(scratch)).some(n=>ambient.includes(n)))throw new Error("Unexpected Codex configuration");
  await profile.authorize?.();const subscription=await profile.subscription?.();
  if(profile.subscription && (!subscription?.accessToken || !subscription.accountId))throw new Error("Missing Codex subscription identity");
  input.signal.throwIfAborted();
  const config:Record<string,string|number|boolean>={
    model_provider:"trusted", "model_providers.trusted.name":"Trusted application provider",
    "model_providers.trusted.base_url":provider?.href.replace(/\/$/,"") ?? (subscription?codexSubscriptionEndpoint:"https://api.openai.com/v1"),
    "model_providers.trusted.wire_api":"responses","model_providers.trusted.requires_openai_auth":false,
    "model_providers.trusted.supports_websockets":false,"model_providers.trusted.request_max_retries":0,"model_providers.trusted.stream_max_retries":0,
    "analytics.enabled":false,"feedback.enabled":false,"tools.experimental_request_user_input.enabled":false,"tools.update_plan.enabled":false,
    web_search:"disabled",
  };
  if(profile.apiKey || subscription)config["model_providers.trusted.env_key"]="BIRBCREW_TRUSTED_KEY";
  if(subscription)config["model_providers.trusted.env_http_headers.ChatGPT-Account-Id"]="BIRBCREW_CODEX_ACCOUNT";
  for(const name of ["plugins","apps","shell_tool","unified_exec","shell_snapshot","multi_agent","multi_agent_v2","code_mode","goals","image_generation","view_image","default_mode_request_user_input","request_permissions_tool","sleep_tool","tool_suggest"])config["features."+name]=false;
  const args=["app-server","--stdio",...Object.entries(config).flatMap(([key,value])=>["-c",key+"="+JSON.stringify(value)])];
  const child=spawn(fileURLToPath(new URL("../../.proof/bin/member-launch",import.meta.url)),args,{cwd:scratch,detached:true,stdio:["pipe","pipe","ignore"],env:{
    HOME:home,CODEX_HOME:home,PATH:"",TMPDIR:home,BIRBCREW_NATIVE_BINARY:codexExecutable(),BIRBCREW_NATIVE_PARENT:String(process.pid),
    BIRBCREW_NATIVE_WORKSPACE:scratch,BIRBCREW_NATIVE_PROVIDER_PORT:provider?.port??"443",
    ...(profile.apiKey && {BIRBCREW_TRUSTED_KEY:profile.apiKey}),...(subscription && {BIRBCREW_TRUSTED_KEY:subscription.accessToken,BIRBCREW_CODEX_ACCOUNT:subscription.accountId}),
  }});
  const decoder=new StringDecoder("utf8");
  let finished=false;
  let sequence=0,buffer="",bytes=0,failure:unknown,nativeId:string|undefined,turnId:string|undefined,text="";
  const pending=new Map<number,{method:string;resolve:(value:any)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
  const completion=Promise.withResolvers<void>();completion.promise.catch(()=>{});
  const turnReady=Promise.withResolvers<string>();turnReady.promise.catch(()=>{});
  const results=new Map<string,{toolName:string;text:string;success:boolean}>();
  let handling=Promise.resolve();
  const stop=()=>{if(child.pid && child.exitCode===null && child.signalCode===null){try{process.kill(-child.pid,"SIGKILL");}catch{}}};
  const fail=(error:unknown)=>{failure??=error;completion.reject(error);turnReady.reject(error);for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();stop();};
  const send=(value:unknown)=>{input.signal.throwIfAborted();if(!child.stdin.writable)throw new Error("Native transport closed");child.stdin.write(JSON.stringify(value)+"\n");};
  const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);const error=new Error("Native protocol deadline");reject(error);fail(error);},15000);
    pending.set(id,{method,resolve,reject,timer});try{send({id,method,params});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
  const closed=new Promise<void>(resolve=>child.once("close",()=>{resolve();if(!failure && !finished)fail(new Error("Native app-server exited"));}));
  child.once("error",fail);child.stdin.on("error",fail);
  const abort=()=>fail(new Error("Trusted Codex cancelled"));input.signal.addEventListener("abort",abort,{once:true});
  async function event(message:any) {
    if(failure)throw failure;
    input.signal.throwIfAborted();
    if(message.id!==undefined) {
      if(message.method!=="item/tool/call")throw new Error("Unregistered native host request");
      const call=callSchema.parse(message.params);
      const current=await turnReady.promise;
      if(call.threadId!==nativeId || call.turnId!==current || results.has(call.callId) || !input.tools.some(t=>t.name===call.tool))throw new Error("Native call binding mismatch");
      const result=await input.dispatch({nativeCallId:call.callId,toolName:call.tool,args:call.arguments,signal:input.signal});
      results.set(call.callId,{toolName:call.tool,text:result.text,success:!result.isError});
      send({id:message.id,result:{contentItems:[{type:"inputText",text:result.text}],success:!result.isError}});return;
    }
    if(message.method==="item/completed") {
      const {item,threadId:thread,turnId:turn}=message.params;
      if(thread!==nativeId || turn!==await turnReady.promise)throw new Error("Native item identity mismatch");
      if(item.type==="dynamicToolCall") {
        const result=results.get(item.id);
        if(!result || item.namespace!=="application" || item.tool!==result.toolName || item.success!==result.success ||
            JSON.stringify(item.contentItems)!==JSON.stringify([{type:"inputText",text:result.text}]))throw new Error("Native result correlation mismatch");
        await input.onToolDelivered?.({nativeCallId:item.id,toolName:item.tool});results.delete(item.id);
      } else if(item.type==="agentMessage") {
        text+=z.string().parse(item.text);if(Buffer.byteLength(text)>65536)throw new Error("Native output bound");await input.onText?.(item.text);
      } else if(!["userMessage","reasoning"].includes(item.type))throw new Error("Unregistered native item");
    }
    if(message.method==="turn/completed") {
      if(message.params.threadId!==nativeId || message.params.turn.id!==await turnReady.promise || message.params.turn.status!=="completed" || message.params.turn.error || results.size)throw new Error("Native turn did not complete");
      finished=true;completion.resolve();
    }
    if(message.method==="error")throw new Error("Native app-server error");
  }
  child.stdout.on("data",chunk=>{
    bytes+=chunk.length;buffer+=decoder.write(chunk);
    if(bytes>16*1024*1024 || Buffer.byteLength(buffer)>4*1024*1024){fail(new Error("Native protocol limit"));return;}
    let at:number;
    while((at=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;
      try {const message=JSON.parse(line);if(message.method===undefined && typeof message.id==="number") {
        const p=pending.get(message.id);if(!p)throw new Error("Unexpected native RPC response");pending.delete(message.id);clearTimeout(p.timer);
        if(message.error)p.reject(new Error("Native RPC rejected "+p.method+" "+String(message.error.code)));else p.resolve(message.result);
      }else handling=handling.then(()=>event(message)).catch(fail);
      }catch(error){fail(error);}
    }
  });
  try {
    await request("initialize",{clientInfo:{name:"birbcrew-trusted",version:"1"},capabilities:{experimentalApi:true,requestAttestation:false}});send({method:"initialized"});
    const options={model:profile.model,modelProvider:"trusted",cwd:scratch,approvalPolicy:"never",sandbox:"read-only",developerInstructions:"You are a BirbCrew coworker.\n"+input.context};
    const thread=await request(prior?"thread/resume":"thread/start",prior?{...options,threadId:prior.nativeId}:{...options,environments:[],dynamicTools:[{type:"namespace",name:"application",description:"Only registered application tools",tools:input.tools.map(t=>({type:"function",name:t.name,description:t.description,inputSchema:t.inputSchema,deferLoading:false}))}]});
    nativeId=z.uuid().parse(thread.thread.id);if(prior && nativeId!==prior.nativeId)throw new Error("Native thread changed");
    const turn=await request("turn/start",{threadId:nativeId,environments:[],input:[{type:"text",text:input.text,text_elements:[]}]});
    turnId=z.uuid().parse(turn.turn.id);turnReady.resolve(turnId);
    await completion.promise;await handling;if(failure)throw failure;
    if(!text)throw new Error("Empty native response");
    child.stdin.end();await Promise.race([closed,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>{stop();reject(new Error("Native close deadline"));},5000);timer.unref();})]);
    await handling;
    if(failure)throw failure;
    if(results.size || buffer.trim() || decoder.end())throw new Error("Incomplete final native protocol state");
    input.signal.throwIfAborted();
    let total:unknown,model:string|null=null;
    const history=await nativeHistory(home,scratch,nativeId,undefined,lines=>{total=codexRolloutTotal(lines);model=codexRolloutModel(lines);});
    return {text,checkpoint:saved.parse({version:1,engine:"codex-app-server",threadId,nativeId,memberId,ownerDigest,model:profile.model,requestId:input.runId,...history}),
      usage:codexUsage(total,priorTotal,model)};
  } finally {input.signal.removeEventListener("abort",abort);stop();await closed;for(const p of pending.values())clearTimeout(p.timer);}
}
