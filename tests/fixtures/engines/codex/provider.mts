import { appendFile } from "node:fs/promises";
import { handoffAcknowledgement } from "../handoff.mts";
import { streamGate, waitForGate } from "../stream-gate.mts";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { json } from "node:stream/consumers";
import { z } from "zod";

const nativeTools = z.array(z.looseObject({type:z.string(),name:z.string().optional()}));
const providerInput = z.object({ tools: nativeTools.default([]), input: z.array(z.looseObject({
  role: z.string().optional(), type: z.string(), call_id: z.string().optional(), output: z.unknown().optional(),
  content: z.unknown().optional(),
})) });
const textParts = z.array(z.object({ type: z.literal("input_text"), text: z.string() }));
type InputItem = z.infer<typeof providerInput>["input"][number];

function send(response: ServerResponse, type: string, value: Record<string, unknown>) {
  response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...value }) + "\n\n");
}

export async function startProvider(onFailure = () => {},
  onRequest?: (prompt:string, instructions:string, messages:string, continuation:boolean) => void,
  dynamicNamespace?: string, usage?: (request: number) => Record<string, unknown>) {
  const toolSurfaces: z.infer<typeof providerInput>["tools"][] = [];
  const requests: InputItem[][] = [];
  let cancelled = 0;
  const server = createServer(async (request, response) => {
    response.once("close", () => { if (!response.writableEnded) cancelled++; });
    try {
      if (request.method !== "POST" || request.url !== "/responses") {
        response.writeHead(404).end(); return;
      }
      const body = await json(request);
      const {input,tools} = providerInput.parse(body);
      const additional = input.filter(i => i.type === "additional_tools").flatMap(i => nativeTools.parse(i.tools));
      toolSurfaces.push([...tools, ...additional]);
      requests.push(input);
      const prompts = input.filter(i => i.role === "user").flatMap(i => {
        const parts = textParts.safeParse(i.content);
        return parts.success ? parts.data.map(p => p.text) : [];
      });
      const prompt = prompts.at(-1);
      const memory = prompts.findLast(text => text.startsWith("remember "))?.slice(9);
      if (prompt && onRequest) {
        const trusted = input.filter(i => i.role === "developer" || i.role === "system");
        const others = input.filter(i => i.role !== "developer" && i.role !== "system");
        const instructions = z.object({instructions:z.string().optional()}).parse(body).instructions ?? "";
        onRequest(prompt, instructions + JSON.stringify(trusted), JSON.stringify(others), input.some(i => i.type === "function_call_output"));
      }
      const id = "resp_" + randomUUID();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      send(response, "response.created", { response: { id } });
      if (prompt === "fail") {
        onFailure();
        send(response, "response.failed", { response: { id, error: { code: "invalid_request_error", message: "Fixture failure" } } });
        response.end(); return;
      }
      const lastUser = input.findLastIndex(i => i.role === "user");
      const output = input.slice(lastUser + 1).findLast(i => i.type === "function_call_output") ??
        (prompt === "continue" ? input.findLast(i => i.type === "function_call_output") : undefined);
      if (output && process.env.BIRBCREW_PROOF_CODEX_REQUESTS) {
        // Record only fixture UUIDs and fixed outcome markers, never provider requests.
        const serialized = JSON.stringify(output.output);
        const ids = serialized.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi) ?? [];
        const outcomes = ["denied","aborted","inspect","test"].filter(kind => serialized.includes(kind));
        await appendFile(process.env.BIRBCREW_PROOF_CODEX_REQUESTS,JSON.stringify({callId:output.call_id,ids,outcomes}) + "\n",{mode:0o600});
      }
      const gate = streamGate(prompt);
      const echoCall = prompt?.startsWith("review ") === true;
      const commentary = (text: string, phase: "commentary" | "final_answer") =>
        send(response,"response.output_item.done",{item:{type:"message",id:"msg_" + randomUUID(),role:"assistant",
          phase,content:[{type:"output_text",text}]}});
      if (gate) {
        for (const [index,text] of ["first"," second"].entries()) {
          const item = {type:"message",id:"msg_" + randomUUID(),role:"assistant",
            phase:index ? "final_answer" : "commentary",content:[{type:"output_text",text}]};
          send(response,"response.output_item.added",{output_index:index,item:{...item,content:[]}});
          send(response,"response.output_text.delta",{output_index:index,item_id:item.id,content_index:0,delta:text});
          await waitForGate(gate + (index ? ".second" : ".first"));
          send(response,"response.output_item.done",{output_index:index,item});
        }
      } else if (echoCall && output) {
        commentary("After private.", "commentary");
        commentary(prompt!.slice(7) + " finished.", "final_answer");
      } else if ((prompt?.startsWith("record ") || prompt === "choose" || echoCall) && !output) {
        const ordinary = prompt === "choose";
        const operation = ordinary ? randomUUID() : prompt!.slice(7);
        const callId = (echoCall ? "private." : "call_") + operation;
        if (echoCall) commentary("Before " + callId, "commentary");
        const catalog = input.filter(i => i.role === "developer" && i.type === "message").flatMap(i => {
          const parts = textParts.safeParse(i.content);
          return parts.success ? parts.data.map(p => p.text) : [];
        }).join("\n");
        const namespace = [...tools,...additional].find(tool => (dynamicNamespace !== undefined && tool.name === dynamicNamespace) || tool.name === "mcp__birbcrew" || tool.name === "mcp__fixture")?.name ??
          (dynamicNamespace && catalog.includes("- "+dynamicNamespace) ? dynamicNamespace : /^- (mcp__(?:birbcrew|fixture))\s*$/m.exec(catalog)?.[1]);
        if (!namespace) throw new Error("Fixture MCP namespace missing");
        send(response, "response.output_item.done", { item: {
          type:"function_call", call_id:callId, namespace,
          name:ordinary ? "choose_next_step" : "record_work_item", arguments:JSON.stringify(ordinary ? {} : {operation_id:operation, note:"private fixture note"})
        } });
      } else {
        let text: string;
        if (output) text = "settled " + JSON.stringify(output.output);
        else if (handoffAcknowledgement(prompt)) text = handoffAcknowledgement(prompt)!;
        else if (prompt?.startsWith("remember ")) text = "stored " + memory;
        else if (prompt === "recall") text = "recalled " + (memory ?? "none");
        else if (prompt === "wait") text = "waiting";
        else throw new Error("Unexpected Codex fixture input");
        send(response, "response.output_item.done", { item: { type:"message", id:"msg_" + randomUUID(),
          role:"assistant", phase:prompt === "wait" ? "commentary" : "final_answer", content:[{type:"output_text", text}] } });
        if (prompt === "wait") return;
      }
      send(response, "response.completed", { response: { id,
        usage: usage?.(requests.length) ?? { input_tokens:0, output_tokens:0, total_tokens:0 } } });
      response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider failed to bind");
  return {url:"http://127.0.0.1:" + address.port, requests, toolSurfaces, cancelled:()=>cancelled, async close() {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  }};
}
