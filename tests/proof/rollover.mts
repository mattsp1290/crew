import { assertOfflineNetwork } from "./offline-network.mts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { historyFromJSON, historyToJSON } from "@temporalio/common/proto-utils";
import { Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { commands, decision, pendingSchema } from "./member-commands.mts";
import { services, run, until, type Engine } from "./member-services.mts";
import { startRestartFixtures } from "./proxy-restart-fixtures.mts";
import { readSnapshot } from "../../src/service/observation.ts";
import { MemberStore } from "../../src/service/store.ts";
import { MemberClient } from "../../src/service/client.ts";

// Replay runs in a separate network namespace, without activities or a provider.
if (process.argv[2] === "offline-replay") {
  await assertOfflineNetwork();
  const directory = process.argv[3];
  const manifest: {workflowId:string;file:string}[] = JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
  assert.ok(manifest.length >= 9, "Capture at least three generations for each engine");
  for (const item of manifest) {
    await Worker.runReplayHistory({ workflowsPath:fileURLToPath(new URL("../../src/service/workflow.ts",import.meta.url)) },
      historyFromJSON(JSON.parse(await readFile(join(directory,item.file),"utf8"))), item.workflowId);
  }
  console.log(`Offline replay passed for ${manifest.length} captured generations; no network or activities.`);
} else {
  assert.equal(process.version,"v24.22.3");
  const s = await services();
  try {
    const fixtures = await startRestartFixtures();
    try {
      s.env.BIRBCREW_PROXY_FIXTURE_ENDPOINTS = JSON.stringify(fixtures.endpoints);
      const worker = () => s.child(process.execPath,["src/service/cli.ts","worker","tests/proof/proxy-restart-profiles.mts"]);
      const temporalStop = await s.startTemporal();
      let stop = await worker();
      await until(async () => {
        try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='proxy.fixture.v1'") === "3" || undefined; }
        catch { return undefined; }
      },"proxy worker registration");
      const connection = await Connection.connect({address:s.env.BIRBCREW_TEMPORAL_ADDRESS});
      const temporal = new Client({connection});
      const pool = new Pool({connectionString:s.env.BIRBCREW_DATABASE_URL});
      const histories: {workflowId:string;file:string}[] = [];
      const historyDir = join(s.directory,"rollover-history");
      await mkdir(historyDir);
      try {
        const {command,create} = commands(s);
        for (const engine of ["claude","codex","pi"] as Engine[]) {
          const member = await create(engine,"proxy.fixture.v1");
          const key = await member.open();
          const workflowId = `birbcrew-ts/member/${member.memberId}/conversation/${key.conversationId}`;
          const logical = temporal.workflow.getHandle(workflowId);
          const firstRun = (await logical.describe()).runId;
          const requests: {ownerId:string;conversationId:string;requestId:string;text:string}[] = [];
          const nonce = randomUUID();
          const next = (recall=false) => {
            const request = {...key,requestId:randomUUID(),text:recall?"recall":"remember "+nonce};
            requests.push(request); return request;
          };
          for(let turn=1;turn<=3;turn++) {
            assert.deepEqual(await command("turn",next()),{text:"stored "+nonce});
          }
          // Kill on the old side of the boundary, after committed turn3 but before turn4.
          await stop(); stop = await worker();
          const fourth = next();
          assert.deepEqual(await command("turn",fourth),{text:"stored "+nonce});
          await until(async () => (await temporal.workflow.getHandle(workflowId,firstRun).describe()).status.name === "CONTINUED_AS_NEW" || undefined,"first rollover");
          // Kill on the new side, after the old run durably Continued-As-New.
          await stop(); stop = await worker();
          assert.notEqual((await logical.describe()).runId,firstRun);
          assert.equal(await s.sql(`SELECT workflow_run_id FROM birbcrew_ts.turns WHERE conversation_id='${key.conversationId}' AND position=1`),firstRun);
          // CLI processes construct fresh clients for every call. This exercises gateway/client restart routing.
          assert.deepEqual(await command("turn",requests[0]),{text:"stored "+nonce});
          const fifth = next(), sixth = next();
          assert.deepEqual(await Promise.all([command("turn",fifth),command("turn",sixth),command("turn",fifth)]),
            [{text:"stored "+nonce},{text:"stored "+nonce},{text:"stored "+nonce}]);
          const accepted = Array.from({length:6},(_,index)=>next(index===5));
          const api = new MemberClient(new MemberStore(pool),temporal);
          await Promise.all([...accepted,accepted[0]].map(request=>api.accept(request)));
          for(const request of accepted) {
            assert.deepEqual(await command("turn",request),{text:(request.text==="recall"?"recalled ":"stored ")+nonce});
          }
          assert.equal(fixtures.evidence()[engine].requests,12,"Exactly one provider request for each committed turn");
          await command("turn",{...requests[0],text:"remember changed"},true);
          for(const request of requests) {
            assert.deepEqual(await command("turn",request),{text:(request.text==="recall"?"recalled ":"stored ")+nonce});
          }
          assert.equal(fixtures.evidence()[engine].requests,12,"Earlier-generation replay must never invoke provider");
          assert.deepEqual(await command("pending",key),[]);
          const {rows:turns} = await pool.query("SELECT position,phase,workflow_run_id FROM birbcrew_ts.turns WHERE conversation_id=$1 ORDER BY position",[key.conversationId]);
          assert.deepEqual(turns.map(t=>t.position),Array.from({length:12},(_,i)=>i+1));
          assert.ok(turns.every(t=>t.phase==="committed"));
          const runIds = [...new Set<string>(turns.map(t=>t.workflow_run_id))];
          assert.ok(runIds.length>=3,"At least two rollover boundaries");
          const snapshot = await readSnapshot(pool,key.ownerId,key.conversationId);
          assert.deepEqual(new Set(snapshot.messages.filter(m=>m.role==="user").map(m=>m.id)),new Set(requests.map(r=>r.requestId)));
          assert.equal(snapshot.messages.filter(m=>m.role==="assistant").length,12);
          assert.equal(snapshot.state.phase,"idle");
          assert.equal(snapshot.openText,null);
          for (const runId of runIds) {
            const handle=temporal.workflow.getHandle(workflowId,runId);
            await until(async () => (await handle.describe()).status.name==="CONTINUED_AS_NEW" || undefined,"generation drain");
            const file=histories.length+".json";
            await writeFile(join(historyDir,file),historyToJSON(await handle.fetchHistory()),{mode:0o600});
            histories.push({workflowId,file});
          }
          console.log(`${engine}:12 committed turns,${runIds.length} generations,duplicates=0 extra inference,worker kills both sides,AG-UI history preserved`);
        }
        await stop();
        await writeFile(join(historyDir,"manifest.json"),JSON.stringify(histories),{mode:0o600});
        await fixtures.close();
        // No credential environment, no connected database or Temporal client in the child.
        const replay=await run("unshare",["--user","--net",process.execPath,"tests/proof/rollover.mts","offline-replay",historyDir],
          {env:{PATH:process.env.PATH,HOME:s.directory,BIRBCREW_REPLAY_PARENT_NETNS:await readlink("/proc/self/ns/net")},timeout:180_000,maxBuffer:4*1024*1024});
        console.log(replay.stdout.trim());
        // Protected calls at the fourth-turn boundary must be drained, not moved or abandoned.
        stop = await s.worker();
        await until(async () => {
          try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'")==="3" || undefined; }
          catch { return undefined; }
        },"approval worker registration");
        for (const engine of ["claude","codex","pi"] as Engine[]) {
          for(const cancel of [false,true]) {
            console.log(`Checking ${engine} fourth-turn ${cancel?"cancellation":"approval"} boundary`);
            const member=await create(engine,"fixture.approval.v1");
            const key=await member.open();
            const workflowId=`birbcrew-ts/member/${member.memberId}/conversation/${key.conversationId}`;
            for(let i=0;i<3;i++) await command("turn",{...key,requestId:randomUUID(),text:"remember boundary"});
            const request={...key,requestId:randomUUID()};
            const result=command("turn",{...request,text:"record "+request.requestId},engine==="codex"&&cancel);
            void result.catch(()=>{});
            const card=await until(async()=>pendingSchema.parse(await command("pending",key))[0],"fourth turn decision");
            const before=(await temporal.workflow.getHandle(workflowId).describe()).runId;
            const queued=command("turn",{...key,requestId:randomUUID(),text:"recall"},cancel);
            void queued.catch(()=>{});
            // Codex live callbacks are not resumable after process loss; their uncertain
            // outcomes are qualified separately. Do not pretend a live approval survives.
            if(engine!=="codex") {
              // The public card precedes the durable native pause. Kill only after
              // the checkpoint exists, as in the existing decision-recovery proof.
              // Killing the in-flight proposal instead is an uncertain-outcome test.
              await until(async()=>await s.sql(`SELECT count(*) FROM birbcrew_ts.paused_segments WHERE conversation_id='${key.conversationId}' AND request_id='${request.requestId}'`)==="1"||undefined,
                "durable fourth-turn native pause before worker replacement");
              await stop(); stop=await s.worker();
            }
            assert.equal((await temporal.workflow.getHandle(workflowId).describe()).runId,before,"Pending fourth turn prevents rollover");
            if(cancel) await command("cancel-pending",request);
            else await command("decide",decision(card,"approve"));
            await result; await queued;
            if(engine==="codex"&&cancel) {
              // Codex owns a live callback: cancellation aborts it rather than
              // fabricating a successful native continuation.
              assert.equal(await s.sql(`SELECT phase FROM birbcrew_ts.turns WHERE conversation_id='${key.conversationId}' AND request_id='${request.requestId}'`),"uncertain");
              assert.equal((await readSnapshot(pool,key.ownerId,key.conversationId)).state.phase,"cancelled");
            }
            assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${key.conversationId}'`),cancel?"0":"1");
            assert.deepEqual(await command("pending",key),[]);
            if(!cancel) assert.notEqual((await temporal.workflow.getHandle(workflowId).describe()).runId,before);
          }
        }
        // An accepted successor in the same generation must receive a durable rejection
        // when its pending predecessor is cancelled, not disappear with the workflow.
        for (const engine of ["claude","codex","pi"] as Engine[]) {
          console.log(`Checking ${engine} accepted-successor cancellation disposition`);
          const member=await create(engine,"fixture.approval.v1");
          const key=await member.open();
          const predecessor={...key,requestId:randomUUID()};
          const result=command("turn",{...predecessor,text:"record "+predecessor.requestId},engine==="codex");
          void result.catch(()=>{});
          await until(async()=>pendingSchema.parse(await command("pending",key))[0],"pending predecessor");
          const queued={...key,requestId:randomUUID(),text:"remember NEVER_INFER_"+randomUUID()};
          const api=new MemberClient(new MemberStore(pool),temporal);
          assert.deepEqual(await api.accept(queued),{requestId:queued.requestId});
          assert.deepEqual(await new MemberStore(pool).requestStatus({ ...key,requestId:queued.requestId }),
            {requestId:queued.requestId,phase:"accepted"});
          await command("cancel-pending",predecessor);
          await result;
          if(engine==="codex") {
            assert.equal(await s.sql(`SELECT phase FROM birbcrew_ts.turns WHERE conversation_id='${key.conversationId}' AND request_id='${predecessor.requestId}'`),"uncertain");
            assert.equal((await readSnapshot(pool,key.ownerId,key.conversationId)).state.phase,"cancelled");
          }
          await until(async()=>{
            const status=await new MemberStore(pool).requestStatus({...key,requestId:queued.requestId});
            return status.phase==="rejected"?status:undefined;
          },"durable successor rejection");
          // A fresh API/store has no in-memory acceptance state to accidentally mask loss.
          const fresh=new MemberClient(new MemberStore(pool),temporal);
          assert.deepEqual(await new MemberStore(pool).requestStatus({...key,requestId:queued.requestId}),
            {requestId:queued.requestId,phase:"rejected",reason:"predecessor_cancelled"});
          for(const retry of [()=>fresh.accept(queued),()=>fresh.submit(queued)]) {
            await assert.rejects(retry,error=>error instanceof Error&&error.message==="request_rejected");
          }
          assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id='${key.conversationId}' AND request_id='${queued.requestId}'`),"0");
          assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${key.conversationId}'`),"0");
          const observations=await readFile(s.env.BIRBCREW_PROOF_REQUESTS!,"utf8");
          assert.ok(!observations.includes(queued.text),"Rejected successor never reached a provider");
        }
        await stop();
        console.log("Approval/cancellation boundary and durable accepted-successor rejection passed for all engines; no duplicate effects.");
      } finally { await pool.end(); await connection.close(); await temporalStop(); }
    } finally { await fixtures.close(); }
  } catch (error) {
    // The harness uses synthetic credentials only. Preserve bounded, redacted logs
    // before disposable services are removed so CI failures remain diagnosable.
    const output = join(process.cwd(), ".proof", "rollover-failure");
    await mkdir(output, {recursive:true});
    for (const name of await readdir(s.directory)) {
      if (!name.endsWith(".log")) continue;
      const raw = (await readFile(join(s.directory,name),"utf8")).slice(-128*1024);
      const safe = raw.replace(/Bearer\s+[^\s"',}]+/gi,"Bearer [REDACTED]")
        .replace(/(authorization["']?\s*[:=]\s*)[^\r\n]+/gi,"$1[REDACTED]");
      await writeFile(join(output,name),safe,{mode:0o600});
      console.error(`${name} (last120 lines):\n${safe.split("\n").slice(-120).join("\n")}`);
    }
    console.error(`Rollover failed; bounded diagnostic logs retained in ${output}`);
    throw error;
  } finally { await s.close(); }
}
