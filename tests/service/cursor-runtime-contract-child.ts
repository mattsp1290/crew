import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import type { Conversation } from "../../src/service/domain.ts";

const mode = z.enum(["valid", "missing"]).parse(process.argv[2]);
const root = z.string().parse(process.argv[3]);
const sdkEntry = import.meta.resolve("@cursor/sdk");

// Node's synchronous loader hook observes the real production import boundary.
registerHooks({
  load(url, context, nextLoad) {
    if (url !== sdkEntry) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: `
const importedEnvironment={...process.env};
const creations=[],messages=[],stores=[];
let resumes=0,disposed=0,tree;
export class JsonlLocalAgentStore {constructor(dir){this.dir=dir;stores.push(dir);}}
export const emptyFs=${mode === "missing" ? "undefined" : "()=>{tree={read(){},list(){},write(){},delete(){}};return tree;}"};
export const Cursor={models:{list(){throw new Error('catalog must not run in this boundary test')}}};
export const Agent={
 async create(options){creations.push(options);return {
  agentId:'synthetic-agent',
  async send(...args){messages.push(args);return {
    supports:()=>true,async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'synthetic-output'}]}}},
    async wait(){return {status:'finished'}},async cancel(){}
  }},
  async [Symbol.asyncDispose](){disposed++}
 }},
 async resume(){resumes++;throw new Error('Crew must never resume this lane')}
};
export function audit(){return JSON.stringify({importedEnvironment,messages,stores,resumes,disposed,
 creations:creations.map(o=>({keys:Object.keys(o).sort(),tools:o.tools,mcpServers:o.mcpServers,agents:o.agents,
  local:{keys:Object.keys(o.local).sort(),cwd:o.local.cwd,store:o.local.store.dir,settingSources:o.local.settingSources,
   sandboxOptions:o.local.sandboxOptions,enableAgentRetries:o.local.enableAgentRetries,fsMatches:o.local.fs===tree,
   reportedWorkspacePath:o.local.reportedWorkspacePath,customTools:o.local.customTools,hostMcpBridgeUrls:o.local.hostMcpBridgeUrls,
   dirs:o.local.dirs,autoReview:o.local.autoReview}}))});}
` };
  },
});

const { runCursorTurn } = await import("../../src/service/cursor-turn.ts");
const legacy = join(root, "legacy");
await mkdir(legacy);
await writeFile(join(legacy, "sentinel"), "untouched");
const member = { engine: "cursor", profile: "cursor.v1", ownerId: randomUUID(), memberId: randomUUID(), conversationId: randomUUID() } satisfies Conversation;
const profile = { apiKey: "synthetic-sdk-key", model: "grok-4.7", cwd: legacy };
const input = { threadId: member.conversationId, runId: randomUUID(), text: "synthetic input", checkpoint: null, signal: new AbortController().signal };
const inventoryMessages: unknown[] = [];
process.send = (message) => { inventoryMessages.push(message); return true; };
const work = runCursorTurn(input, member, profile, join(root, "state"));
if (mode === "missing") await assert.rejects(work, { message: "Text engine turn failed" });
else {
  const result = await work;
  assert.equal(result.kind, "complete");
  if (result.kind === "complete") assert.deepEqual(result.checkpoint, {
    version: 1, engine: "cursor", state: { cwd: legacy, model: profile.model, agentId: "synthetic-agent" },
  });
}
const inspect: unknown = (await import(sdkEntry)).audit;
assert.equal(typeof inspect, "function");
if (typeof inspect !== "function") throw new Error("missing audit function");
const audit = z.object({
  importedEnvironment: z.record(z.string(), z.string()), messages: z.array(z.array(z.unknown())), stores: z.array(z.string()),
  resumes: z.number(), disposed: z.number(), creations: z.array(z.object({
    keys: z.array(z.string()), tools: z.array(z.string()), mcpServers: z.record(z.string(), z.unknown()), agents: z.record(z.string(), z.unknown()),
    local: z.object({ keys: z.array(z.string()), cwd: z.string(), store: z.string(), settingSources: z.array(z.string()),
      sandboxOptions: z.object({ enabled: z.boolean() }), enableAgentRetries: z.boolean(), fsMatches: z.boolean(),
      reportedWorkspacePath: z.string(), customTools: z.record(z.string(), z.unknown()), hostMcpBridgeUrls: z.array(z.string()),
      dirs: z.array(z.string()), autoReview: z.boolean() }),
  })),
}).parse(JSON.parse(z.string().parse(inspect())));
assert.equal(audit.resumes, 0);
for (const name of ["DATABASE_URL", "CURSOR_API_KEY", "CURSOR_BACKEND_URL", "CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON", "CURSOR_RIPGREP_PATH"]) {
  assert.equal(audit.importedEnvironment[name], undefined, name);
}
assert.notEqual(audit.importedEnvironment.HOME, legacy);
assert.equal(audit.importedEnvironment.TMPDIR, audit.importedEnvironment.HOME);
assert.equal(audit.importedEnvironment.CURSOR_DATA_DIR, audit.importedEnvironment.HOME);
assert.equal(process.env.HOME, undefined);
assert.equal(process.env.TMPDIR, undefined);
assert.equal(process.env.CURSOR_DATA_DIR, undefined);
assert.deepEqual(inventoryMessages, []);
await assert.rejects(access(audit.importedEnvironment.HOME));
assert.equal(await readFile(join(legacy, "sentinel"), "utf8"), "untouched");
assert.deepEqual(await readdir(legacy), ["sentinel"]);
if (mode === "missing") assert.deepEqual(audit.creations, []);
else {
  assert.equal(audit.creations.length, 1);
  const launch = audit.creations[0];
  assert.deepEqual(launch.keys, ["agents", "apiKey", "local", "mcpServers", "model", "tools"]);
  assert.deepEqual(launch.tools, []);
  assert.deepEqual(launch.agents, {});
  assert.deepEqual(launch.mcpServers, {});
  assert.deepEqual(launch.local, {
    keys: ["autoReview", "customTools", "cwd", "dirs", "enableAgentRetries", "fs", "hostMcpBridgeUrls", "reportedWorkspacePath", "sandboxOptions", "settingSources", "store"],
    cwd: join(audit.importedEnvironment.HOME, "workspace"), store: audit.importedEnvironment.HOME,
    settingSources: [], sandboxOptions: { enabled: false }, enableAgentRetries: false, fsMatches: true,
    reportedWorkspacePath: "/", customTools: {}, hostMcpBridgeUrls: [], dirs: [], autoReview: false,
  });
  assert.deepEqual(audit.messages, [[input.text]]);
  assert.deepEqual(audit.stores, [audit.importedEnvironment.HOME]);
  assert.equal(audit.disposed, 1);
  await assert.rejects(access(launch.local.cwd));
}
process.stdout.write("production-cursor-boundary-verified\n");
