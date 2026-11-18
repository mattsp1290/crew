import { createHash } from "node:crypto";
import { z } from "zod";
import { runTrustedPi } from "./trusted-pi.ts";
import { runTrustedClaude } from "./trusted-claude.ts";
import { runTrustedCodex } from "./trusted-codex.ts";
import type { TrustedNativeInput, TrustedNativeProfile, TrustedNativeResult } from "./trusted-native-types.ts";
export type { TrustedNativeInput, TrustedNativeTool, TrustedNativeProfile } from "./trusted-native-types.ts";

const envelope = z.strictObject({version:z.literal(1),engine:z.enum(["pi","claude","codex"]),
  threadId:z.uuid(),binding:z.string(),capabilities:z.hash("sha256"),state:z.json()});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Host-only seam. Never construct this input from AG-UI tools/context or client labels. */
export async function runTrustedNativeTurn(input: TrustedNativeInput, profile: TrustedNativeProfile) {
  input = {...input,signal:AbortSignal.any([input.signal,AbortSignal.timeout(170_000)])};
  input.signal.throwIfAborted();
  z.uuid().parse(input.threadId); z.uuid().parse(input.runId);
  if (profile.engine !== input.engine || !input.binding || Buffer.byteLength(input.binding) > 4096 ||
      !input.text || Buffer.byteLength(input.text) > 16384 || Buffer.byteLength(input.context) > 262144 ||
      input.tools.length > 16 || new Set(input.tools.map(t => t.name)).size !== input.tools.length) throw new Error("Invalid trusted native input");
  for (const tool of input.tools) {
    if (["read","bash","edit","write","grep","find","ls","delegate_task"].includes(tool.name) || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || !tool.description || Buffer.byteLength(tool.description)>4096 ||
        tool.inputSchema.type !== "object" || Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 16384 ||
        !Number.isSafeInteger(tool.maxArgumentBytes) || tool.maxArgumentBytes < 1 || tool.maxArgumentBytes > 65536 ||
        !Number.isSafeInteger(tool.maxResultBytes) || tool.maxResultBytes < 1 || tool.maxResultBytes > 65536 ||
        !Number.isSafeInteger(tool.deadlineMs) || tool.deadlineMs < 1 || tool.deadlineMs > 120000) throw new Error("Invalid trusted tool definition");
  }
  const capabilities = hash({context:input.context,tools:input.tools});
  const previous = input.checkpoint === null ? null : envelope.parse(input.checkpoint);
  if (previous && (previous.engine !== input.engine || previous.threadId !== input.threadId ||
      previous.binding !== input.binding || previous.capabilities !== capabilities)) throw new Error("Trusted checkpoint scope or capabilities changed");
  let calls = 0;
  const delivered = new Map<string,string>();
  const bounded: TrustedNativeInput = {...input,checkpoint:previous?.state ?? null,
    async dispatch(call) {
      const tool = input.tools.find(t => t.name === call.toolName);
      if (!tool || ++calls > 16 || !call.nativeCallId || call.nativeCallId.length > 256 ||
          Buffer.byteLength(JSON.stringify(call.args)) > tool.maxArgumentBytes) throw new Error("Unregistered or excessive native tool call");
      if (delivered.has(call.nativeCallId)) throw new Error("Repeated native tool identity");
      const signal = AbortSignal.any([input.signal,call.signal,AbortSignal.timeout(tool.deadlineMs)]);
      signal.throwIfAborted();
      let abort: (() => void) | undefined;
      let result: {text:string;isError:boolean};
      try {
        result = await Promise.race([input.dispatch({...call,signal}).catch(() => { throw new Error("Trusted application tool failed"); }),new Promise<never>((_,reject) => {
          abort=()=>reject(new Error("Trusted tool deadline or cancellation"));
          signal.addEventListener("abort",abort,{once:true});
          if(signal.aborted)abort();
        })]);
      } finally { if(abort)signal.removeEventListener("abort",abort); }
      signal.throwIfAborted();
      if (typeof result.text !== "string" || typeof result.isError !== "boolean" || Buffer.byteLength(result.text) > tool.maxResultBytes) throw new Error("Trusted tool result exceeds bound");
      delivered.set(call.nativeCallId,call.toolName);
      return result;
    },
    async onToolDelivered(call) {
      input.signal.throwIfAborted();
      if (delivered.get(call.nativeCallId) !== call.toolName) throw new Error("Unpaired native tool result");
      await input.onToolDelivered?.(call);
    },
  };
  const result: TrustedNativeResult = profile.engine === "pi" ? await runTrustedPi(bounded,profile.profile) :
    profile.engine === "claude" ? await runTrustedClaude(bounded,profile.profile) : await runTrustedCodex(bounded,profile.profile);
  input.signal.throwIfAborted();
  const checkpoint = envelope.parse({version:1,engine:input.engine,threadId:input.threadId,binding:input.binding,capabilities,state:result.checkpoint});
  if (Buffer.byteLength(JSON.stringify(checkpoint)) > 4 * 1024 * 1024) throw new Error("Trusted checkpoint exceeds 4 MiB");
  return {text:result.text,checkpoint,usage:result.usage};
}
