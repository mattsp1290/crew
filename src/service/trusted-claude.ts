import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { claudeCheckpoint, runClaudeTurn } from "./claude.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";
import { combinedUsage, segmentUsage, type SegmentUsage } from "./usage-capture.ts";

const text = (max: number) => z.string().refine(v => v.isWellFormed() && !v.includes("\0") && Buffer.byteLength(v) <= max);
export const trustedClaudeTool = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), description: text(4096),
  inputSchema: z.record(z.string(), z.json()), maxArgumentBytes: z.int().min(1).max(65_536),
  maxResultBytes: z.int().min(1).max(65_536), deadlineMs: z.int().min(1).max(120_000),
});
export const trustedClaudeCommand = z.strictObject({
  threadId: z.uuid(), runId: z.uuid(), text: text(16_384), model: z.string().min(1),
  context: text(262_144), binding: text(4096), checkpoint: claudeCheckpoint.nullable(),
  tools: z.array(trustedClaudeTool).max(16),
  continuation: z.strictObject({nativeCallId:text(256),toolName:text(64),text:text(65_536),isError:z.boolean()}).optional(),
});
const pending = z.strictObject({ kind:z.literal("pending"),text:text(65_536),checkpoint:claudeCheckpoint,
  proposal:z.strictObject({nativeCallId:text(256),toolName:text(64),args:z.record(z.string(),z.json())}),usage:segmentUsage });
const response = z.union([pending,z.strictObject({kind:z.literal("complete"),text:text(65_536),checkpoint:claudeCheckpoint,usage:segmentUsage}),
  z.strictObject({error:z.string()})]);
type Profile = Parameters<typeof runClaudeTurn>[1];
type Command = z.infer<typeof trustedClaudeCommand>;

export async function runTrustedClaude(input: TrustedNativeInput, profile: Profile) {
  let checkpoint = input.checkpoint === null ? null : claudeCheckpoint.parse(input.checkpoint);
  let continuation: Command["continuation"];
  let combined = "";
  // One query per tool round trip; the request's usage is all of them.
  const usage: SegmentUsage[] = [];
  for (let count=0; count <= 16; count++) {
    input.signal.throwIfAborted();
    const command = trustedClaudeCommand.parse({threadId:input.threadId,runId:input.runId,text:input.text,
      model:profile.model,context:input.context,binding:input.binding,tools:input.tools,checkpoint,continuation});
    const result = await execute(command,input,profile);
    checkpoint = result.checkpoint;
    combined += result.text;
    usage.push(result.usage);
    if (Buffer.byteLength(combined)>65_536) throw new Error("Claude response exceeds limit");
    if (result.kind === "complete") {
      return {text:combined,checkpoint,usage:combinedUsage(usage)};
    }
    if (count===16) throw new Error("Trusted Claude tool call budget exhausted");
    const call=result.proposal;
    const tool=input.tools.find(tool=>tool.name===call.toolName);
    if (!tool || Buffer.byteLength(JSON.stringify(call.args))>tool.maxArgumentBytes) throw new Error("Unregistered or oversized Claude call");
    const signal=AbortSignal.any([input.signal,AbortSignal.timeout(tool.deadlineMs)]);
    const answer=await input.dispatch({...call,signal});
    signal.throwIfAborted();
    if (Buffer.byteLength(answer.text)>tool.maxResultBytes) throw new Error("Claude tool result exceeds limit");
    continuation={nativeCallId:call.nativeCallId,toolName:call.toolName,text:answer.text,isError:answer.isError};
  }
  throw new Error("Trusted Claude tool call budget exhausted");
}

async function execute(command: Command, input: TrustedNativeInput, profile: Profile) {
  const {signal}=input;
  signal.throwIfAborted();
  await profile.authorize?.();
  signal.throwIfAborted();
  const saved=command.checkpoint?.state.binding.pending;
  if (command.continuation || saved) {
    const answer=command.continuation;
    if (!saved || !answer || saved.id!==answer.nativeCallId || saved.name!=="mcp__ag_ui__"+answer.toolName ||
      !command.tools.some(tool=>tool.name===answer.toolName)) throw new Error("Claude continuation mismatch");
  }
  if (!isAbsolute(profile.stateDir)) throw new Error("Expected absolute Claude state directory");
  const member=z.uuid().parse(profile.memberId),owner=createHash("sha256").update(profile.ownerId).digest("hex");
  if (!command.checkpoint) await mkdir(profile.stateDir,{recursive:true,mode:0o700});
  const parent=join(await realpath(profile.stateDir),"trusted-claude",owner,member);
  const cwd=join(parent,command.threadId);
  if (command.checkpoint) {
    if (command.checkpoint.state.threadId!==command.threadId || command.checkpoint.state.model!==profile.model || await realpath(cwd)!==cwd) throw new Error("Claude checkpoint identity mismatch");
  } else {
    await mkdir(parent,{recursive:true,mode:0o700});
    if (await realpath(parent)!==parent) throw new Error("Unexpected Claude state directory");
    await mkdir(cwd,{mode:0o700});
  }
  const tmp=join(cwd,"tmp");
  await mkdir(tmp,{recursive:true,mode:0o700});
  const child=fork(new URL("./trusted-claude-worker.ts",import.meta.url),[],{
    cwd,execArgv:[],detached:!profile.invocationGroup,stdio:["ignore","ignore","ignore","ipc"],
    env:{PATH:[dirname(process.execPath),"/usr/bin","/bin"].join(delimiter),
      ...(profile.invocationGroup && {BIRBCREW_INVOCATION_GROUP:String(profile.invocationGroup)}),
      HOME:cwd,TMPDIR:tmp,CLAUDE_CONFIG_DIR:join(cwd,"config"),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",
      ANTHROPIC_API_KEY:profile.apiKey,ANTHROPIC_BASE_URL:profile.baseUrl},
  });
  return new Promise<Exclude<z.infer<typeof response>,{error:string}>>((resolve,reject)=>{
    let result:unknown,callbackError:unknown;
    let callbacks=Promise.resolve();
    const stop=()=>{if (child.pid && child.exitCode===null && child.signalCode===null) {
      try {process.kill(profile.invocationGroup ? child.pid : -child.pid,"SIGKILL");} catch (error) {
        if (!(error instanceof Error && "code" in error && error.code==="ESRCH")) reject(error);
      }
    }};
    child.once("error",reject);
    child.on("message",value=>{
      if (value && typeof value==="object" && "delivered" in value) {
        const call=z.strictObject({nativeCallId:z.string(),toolName:z.string()}).safeParse(value.delivered);
        if (!call.success || call.data.nativeCallId!==command.continuation?.nativeCallId || call.data.toolName!==command.continuation.toolName) {
          callbackError=new Error("Unexpected Claude result acknowledgement");stop();return;
        }
        callbacks=callbacks.then(async()=>{signal.throwIfAborted();await input.onToolDelivered?.(call.data);}).catch(error=>{callbackError=error;stop();});
      } else if (value && typeof value==="object" && "delta" in value && typeof value.delta==="string") {
        const delta=value.delta;
        callbacks=callbacks.then(async()=>{signal.throwIfAborted();await input.onText?.(delta);}).catch(error=>{callbackError=error;stop();});
      } else result=value;
    });
    child.once("exit",async code=>{
      signal.removeEventListener("abort",stop);
      await callbacks;
      if (callbackError) return reject(callbackError);
      if (signal.aborted) return reject(new Error("Trusted Claude turn cancelled"));
      const parsed=response.safeParse(result);
      if (code!==0 || !parsed.success) return reject(new Error("Trusted Claude worker exited without a result"));
      if ("error" in parsed.data) return reject(new Error(parsed.data.error));
      resolve(parsed.data);
    });
    signal.addEventListener("abort",stop,{once:true});
    child.send(command);
    if (signal.aborted) stop();
  });
}
