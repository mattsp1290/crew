import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ClaudeAgentAdapter, type SessionBinding } from "@ag-ui/claude-agent-sdk";
import { getSessionMessages, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeCheckpoint } from "./claude.ts";
import { trustedClaudeCommand } from "./trusted-claude.ts";
import { claudeUsage } from "./usage-capture.ts";

type Command=z.infer<typeof trustedClaudeCommand>;
type Binding=z.infer<typeof claudeCheckpoint>["state"]["binding"];
const controller=new AbortController();
const cwd=process.cwd();

async function transcriptDigest(sessionId:string,pending?:SessionBinding["pending"]) {
  const messages=await getSessionMessages(sessionId,{dir:cwd});
  if (messages.at(-1)?.type!=="assistant") throw new Error("Missing completed Claude transcript");
  if (pending) {
    const blocks=z.object({content:z.array(z.object({type:z.string(),id:z.string().optional(),name:z.string().optional(),input:z.unknown().optional(),tool_use_id:z.string().optional()}))});
    const latest=blocks.parse(messages.at(-1)?.message).content.filter(block=>block.type==="tool_use");
    if (latest.length!==1 || latest[0].id!==pending.id || latest[0].name!==pending.name || !isDeepStrictEqual(latest[0].input,pending.input)) throw new Error("Claude pending transcript mismatch");
    const history=messages.flatMap(message=>blocks.safeParse(message.message).data?.content ?? []);
    if (history.some(block=>block.type==="tool_result" && block.tool_use_id===pending.id) || history.filter(block=>block.type==="tool_use" && block.id===pending.id).length!==1) throw new Error("Claude pending tool is consumed or ambiguous");
  }
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}
async function checkpoint(command:Command,binding:Binding) {
  return claudeCheckpoint.parse({version:1,engine:"claude",state:{threadId:command.threadId,model:command.model,binding,
    transcriptDigest:await transcriptDigest(binding.sessionId,binding.pending)}});
}

async function run(command:Command) {
  const tools=command.tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.inputSchema}));
  const profile="trusted-claude-"+createHash("sha256").update(JSON.stringify({binding:command.binding,context:command.context,tools:command.tools})).digest("hex");
  let binding:Binding|undefined=command.checkpoint?.state.binding;
  if (binding) {
    const saved=JSON.parse(await readFile("binding.json","utf8"));
    if (!isDeepStrictEqual(saved,binding) || binding.profile!==profile || await transcriptDigest(binding.sessionId,binding.pending)!==command.checkpoint?.state.transcriptDigest) throw new Error("Claude checkpoint is stale or mismatched");
  }
  let exited:Promise<void>|undefined;
  const options:Options={cwd,
    spawnClaudeCodeProcess({command,args,env,signal}) {
      const launcher=fileURLToPath(new URL("../../.proof/bin/member-launch",import.meta.url));
      const cli=spawn(launcher,[String(process.pid),command,...args],{cwd,env,signal,stdio:["pipe","pipe","ignore"]});
      exited=new Promise<void>(resolve=>cli.once("close",()=>resolve()));
      return cli;
    },
    model:command.model,systemPrompt:"You are a BirbCrew coworker.\n"+command.context,env:process.env,
    tools:[],allowedTools:[],mcpServers:{},strictMcpConfig:true,plugins:[],settingSources:[],permissionMode:"dontAsk",maxTurns:3,
  };
  const adapter=new ClaudeAgentAdapter({abortController:controller,sessionRecovery:{profile,resolveProfile:async()=>options,
    store:{load:async()=>binding,async save(_,value) {
      const confirmed=claudeCheckpoint.shape.state.shape.binding.parse(value);
      if (confirmed.profile!==profile || (binding && binding.sessionId!==confirmed.sessionId)) throw new Error("Claude session identity changed");
      await writeFile("binding.tmp",JSON.stringify(confirmed),{mode:0o600,flush:true});
      await rename("binding.tmp","binding.json");binding=confirmed;
    }}}});
  let text="",finished=false,pendingIds:string[]|undefined,resultCount=0,initModel:unknown,queryResult:unknown;
  let callId:string|undefined,toolName:string|undefined,argsBytes=0;
  const terminal=z.object({outcome:z.object({type:z.literal("success"),pendingToolCallIds:z.array(z.string()).max(1).optional()}).optional(),result:z.unknown()});
  await adapter.run({threadId:command.threadId,runId:command.runId,
    messages:command.continuation ? [{role:"tool",id:command.runId+":result:"+command.continuation.nativeCallId,
      toolCallId:command.continuation.nativeCallId,content:command.continuation.text,...(command.continuation.isError ? {error:"application_tool_error"}: {})}]:
      [{role:"user",id:command.runId,content:command.text}],tools,state:null,forwardedProps:{},context:[],
  }).forEach(event=>{
    if (finished) throw new Error("Claude event after terminal");
    if (event.type==="RUN_ERROR") throw new Error("Claude SDK failed");
    if (event.type==="TEXT_MESSAGE_CONTENT") {
      const {delta}=z.object({delta:z.string()}).parse(event);
      text+=delta;if (Buffer.byteLength(text)>65_536) throw new Error("Claude output exceeds limit");
      process.send?.({delta});
    }
    if (event.type==="TOOL_CALL_START") {
      const call=z.object({toolCallName:z.string(),toolCallId:z.string()}).parse(event);
      if (callId || !command.tools.some(tool=>tool.name===call.toolCallName)) throw new Error("Unsupported parallel or unregistered Claude call");
      callId=call.toolCallId;toolName=call.toolCallName;
    }
    if (event.type==="TOOL_CALL_ARGS") {
      const args=z.object({toolCallId:z.string(),delta:z.string()}).parse(event);
      const tool=command.tools.find(tool=>tool.name===toolName);
      argsBytes+=Buffer.byteLength(args.delta);
      if (args.toolCallId!==callId || !tool || argsBytes>tool.maxArgumentBytes) throw new Error("Claude tool argument limit");
    }
    if (event.type==="TOOL_CALL_RESULT") {
      if (!command.continuation || z.object({toolCallId:z.string()}).parse(event).toolCallId!==command.continuation.nativeCallId || resultCount++) throw new Error("Unexpected Claude result pairing");
      // This event confirms the adapter submitted the paired native result. It is
      // not proof that the remote provider durably committed or acted on it.
      process.send?.({delivered:{nativeCallId:command.continuation.nativeCallId,toolName:command.continuation.toolName}});
    }
    if (event.type==="CUSTOM") {
      const init=z.object({name:z.literal("system:init"),value:z.object({model:z.unknown()})}).safeParse(event);
      if (init.success) initModel=init.data.value.model;
    }
    if (event.type==="RUN_FINISHED") {const done=terminal.parse(event);pendingIds=done.outcome?.pendingToolCallIds;queryResult=done.result;finished=true;}
  });
  // As on the member lane (claude-worker.ts): this one query's main-loop usage, and the model its CLI started with.
  const usage=claudeUsage(queryResult,initModel);
  await exited;
  if (!finished || !binding || binding.unsupportedPendingTools?.length || resultCount!==Number(!!command.continuation)) throw new Error("Claude run did not settle");
  if (binding.pending) {
    const call=binding.pending;
    const tool=command.tools.find(tool=>call.name==="mcp__ag_ui__"+tool.name);
    if (!tool || call.id!==callId || !isDeepStrictEqual(binding.frontendTools,tools) || !isDeepStrictEqual(pendingIds,[call.id]) || Buffer.byteLength(JSON.stringify(call.input))>tool.maxArgumentBytes) throw new Error("Claude pending call did not match registered tool");
    return {kind:"pending",text,proposal:{nativeCallId:call.id,toolName:tool.name,args:call.input},checkpoint:await checkpoint(command,binding),usage};
  }
  if (pendingIds?.length || !text) throw new Error("Claude turn did not complete");
  return {kind:"complete",text,checkpoint:await checkpoint(command,binding),usage};
}

const invocationGroup=Number(process.env.BIRBCREW_INVOCATION_GROUP ?? process.pid);
delete process.env.BIRBCREW_INVOCATION_GROUP;
const hostLost=()=>process.kill(-invocationGroup,"SIGKILL");
process.once("disconnect",hostLost);
process.once("message",async payload=>{
  let reply;
  try {reply=await run(trustedClaudeCommand.parse(payload));} catch {
    controller.abort();reply={error:"Trusted Claude turn or native session recovery failed"};
  }
  if (process.connected) process.send?.(reply,()=>{process.removeListener("disconnect",hostLost);process.disconnect();});
});
