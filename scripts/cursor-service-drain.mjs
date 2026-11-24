// Trusted fixture operator. This runs separately from the credentialed model worker.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { promisify } from "node:util";
import { Pool } from "pg";
import { z } from "zod";

const run = promisify(execFile);
const input = z.strictObject({
  ownerId: z.string().min(1),
  requests: z.array(z.object({ conversationId: z.uuid(), requestId: z.uuid(), bytes: z.int() })).min(1),
  worker: z.string().regex(/^crew-cursor-[a-f0-9]+-worker$/),
  coordinator: z.string().regex(/^crew-cursor-[a-f0-9]+-coordinator$/),
  gateway: z.string().regex(/^crew-cursor-[a-f0-9]+-gateway$/),
  temporal: z.string().regex(/^crew-cursor-[a-f0-9]+-temporal$/),
}).parse(await json(process.stdin));
const directory = await mkdtemp(join(tmpdir(), "cursor-trusted-drain-"));
const pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL });
try {
  const conversations = [];
  for (const request of input.requests) {
    const result = await pool.query(`SELECT l.location_id AS "locationId",m.profile FROM birbcrew_ts.text_conversation_locations l
      JOIN birbcrew_ts.conversations c USING(conversation_id) JOIN birbcrew_ts.members m USING(member_id)
      WHERE l.conversation_id=$1`, [request.conversationId]);
    const locations = z.array(z.object({ locationId: z.uuid(), profile: z.string() })).min(1).parse(result.rows);
    conversations.push({ ownerId: input.ownerId, conversationId: request.conversationId,
      inventory: { kind: "locations", locations: locations.map(location => ({ ...location, engine: "cursor" })) } });
  }
  const manifest = join(directory, "manifest.json"), hook = join(directory, "quiesce.mjs");
  await writeFile(manifest, JSON.stringify({ version: 1, conversations }), { mode: 0o600 });
  await writeFile(hook, `import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {setTimeout as delay} from 'node:timers/promises';
const run=promisify(execFile),ids=${JSON.stringify(input)};
async function docker(args){return (await run('docker',args,{timeout:30000,maxBuffer:1048576})).stdout;}
export async function quiesce(){
 for(const name of [ids.worker,ids.coordinator,ids.gateway]){
  await docker(['stop','-t','0',name]);
  const info=JSON.parse(await docker(['inspect',name]))[0];
  assert.equal(info.State.Running,false);assert.equal(info.State.Pid,0);assert.equal(info.HostConfig.PidMode,'');
 }
 // No old sender or helper survives the stopped private PID namespaces.
 // Fence in-flight Temporal RPCs with a full service stop; preserve the SQLite state.
 await docker(['stop','-t','0',ids.temporal]);
 const stopped=JSON.parse(await docker(['inspect',ids.temporal]))[0];
 assert.equal(stopped.State.Running,false);assert.equal(stopped.State.Pid,0);
 await docker(['start',ids.temporal]);
 const end=Date.now()+60000;
 while(true){try{await docker(['exec',ids.temporal,'/app/.proof/bin/temporal','operator','cluster','health','--address','127.0.0.1:7233','--command-timeout','1s']);break;}
 catch{if(Date.now()>end)throw new Error('temporal_fence_failed');await delay(200);}}
 for(const name of [ids.worker,ids.coordinator,ids.gateway])assert.equal(JSON.parse(await docker(['inspect',name]))[0].State.Running,false);
}
`, { mode: 0o600 });
  await run(process.execPath, ["src/service/cli.ts", "erasure-inventory", "--manifest", manifest, "--quiesce-module", hook, "--confirm-complete"], {
    timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(JSON.stringify({ passed: true, conversations: conversations.length, method: "stopped-private-pid-namespaces-and-temporal-fence" }) + "\n");
} finally {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
