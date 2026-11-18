import { isDeepStrictEqual } from "node:util";
import { contentText, validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { sdkSystemEntries, type PiProfile } from "./pi.ts";
import { runPiWorker } from "./pi-launch.ts";
import { replyBytes,systemEntrySchema,trustedSessionPrefix,trustedStateSchema } from "./pi-state.ts";
import type { TrustedNativeInput } from "./trusted-native-types.ts";
import { piUsage } from "./usage-capture.ts";

const workerTurn=z.strictObject({text:z.string().min(1).refine(text=>Buffer.byteLength(text)<=replyBytes),checkpoint:trustedStateSchema});
const textPart=z.object({type:z.literal("text"),text:z.string()});
// What a trusted turn may append, each role checked as deeply as the comparisons below need.
const appendedMessage=z.discriminatedUnion("role",[systemEntrySchema(z.string(),textPart),
  z.looseObject({role:z.literal("user"),content:z.union([z.string(),z.array(textPart)])}),
  z.looseObject({role:z.literal("assistant"),content:z.unknown(),stopReason:z.unknown()}),
  z.looseObject({role:z.literal("toolResult"),toolCallId:z.unknown(),toolName:z.unknown(),isError:z.unknown(),content:z.array(textPart)})]);

/** The SDK runs in a confined worker; registered tools still run here, through input.dispatch, with the
 * arguments the model sent. What the worker appends to the checkpoint must be this request's prompt, the
 * replies the model sent through this host, the results the host delivered, and the SDK's own system entries. */
export async function runTrustedPi(input:TrustedNativeInput,profile:PiProfile) {
  const {text,context,checkpoint,tools}=input;
  const declared:Tool[]=tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.inputSchema as Tool["parameters"]}));
  // The agent coerces a call's arguments against the tool's schema before running it; so does the host.
  const dispatch=(call:ToolCall,signal:AbortSignal)=>{
    const tool=declared.find(candidate=>candidate.name===call.name);
    if(!tool)throw new Error("Unregistered trusted Pi tool call");
    return input.dispatch({nativeCallId:call.id,toolName:call.name,args:validateToolArguments(tool,call),signal});
  };
  // trusted-native.ts allows 16 tool calls; each result and the final reply need a model request.
  const {result,directory,observed,streamed,delivered}=await runPiWorker({kind:"trusted",instructions:profile.instructions,input:{text,context,checkpoint,tools}},
    {profile,signal:input.signal,modelRequests:17,onText:input.onText,dispatch,onToolDelivered:input.onToolDelivered});
  const turn=workerTurn.parse(result);
  const prior=checkpoint === null ? undefined : trustedStateSchema.parse(checkpoint);
  // Compared as JSON, the form the worker's checkpoint took.
  const relayed=JSON.parse(JSON.stringify(observed)) as typeof observed;
  const outside=()=>new Error("Trusted Pi worker returned a turn outside its request");
  const parsed=z.array(appendedMessage).safeParse(turn.checkpoint.messages.slice(prior?.messages.length ?? 0));
  if(!parsed.success)throw outside();
  const appended=parsed.data;
  const users=appended.filter(message=>message.role==="user"),replies=appended.filter(message=>message.role==="assistant");
  const results=appended.filter(message=>message.role==="toolResult");
  const sdkWritten=sdkSystemEntries({instructions:profile.instructions,context,directory,sessionPrefix:trustedSessionPrefix,tools:declared});
  if(turn.text!==streamed || turn.text!==observed.map(message=>contentText(message.content,"")).join("") ||
     (prior && (turn.checkpoint.sessionId!==prior.sessionId || !isDeepStrictEqual(turn.checkpoint.messages.slice(0,prior.messages.length),prior.messages))) ||
     !appended.filter(message=>message.role==="system").every(sdkWritten) ||
     users.length!==1 || contentText(users[0].content)!==text ||
     !isDeepStrictEqual(replies.map(message=>[message.content,message.stopReason]),relayed.map(message=>[message.content,message.stopReason])) ||
     !isDeepStrictEqual(results.map(message=>[message.toolCallId,message.toolName,message.isError,message.content.map(part=>part.text).join("\n")]),
       delivered.map(result=>[result.toolCallId,result.toolName,result.isError,result.text])))
    throw outside();
  // This request's own model calls, as the host received them from the provider, never the worker's account.
  return {text:turn.text,checkpoint:turn.checkpoint,usage:piUsage(observed)};
}
