import { beginContentErasure } from "../../src/service/content-erasure-store.ts";
import { enrollErasureInventory } from "../../src/service/erasure-inventory.ts";
import { eraseConversationContent } from "../../src/service/content-erasure.ts";
import { serverRequestReceiptSchema } from "@birbcrew/client/contract";
import { textTurnRootPath, rootAbsent } from "../../src/service/text-state-location.ts";
import { ownerInitiator } from "../../src/service/domain.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import sizingFixture from "../fixtures/request-text-sizing.json" with { type: "json" };
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MessagesSnapshotEventSchema } from "@ag-ui/core/schemas";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { defaultPayloadConverter } from "@temporalio/common";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import temporalProtos from "@temporalio/proto";
const { temporal: temporalProto } = temporalProtos;
import { Pool } from "pg";
import { MemberClient } from "../../src/service/client.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { MemberStore } from "../../src/service/store.ts";
import { temporalSettings } from "../../src/service/temporal-config.ts";

const database = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!database) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");

function encodedPayloadSizes(value: unknown): number[] {
  if (value === null || typeof value !== "object") return [];
  if ("data" in value && value.data instanceof Uint8Array && "metadata" in value) {
    return [temporalProto.api.common.v1.Payload.encode(temporalProto.api.common.v1.Payload.fromObject(value)).finish().length];
  }
  return Object.values(value).flatMap(encodedPayloadSizes);
}

const reply = "cedar remembered";

function profileModule(log: string, cwd: string, writerGroup: number) {
  return `import { appendFileSync, existsSync } from "node:fs";
const log = ${JSON.stringify(log)};
const cwd = ${JSON.stringify(cwd)};
const executable = ${JSON.stringify(join(cwd, "opencode"))};
const writerGroup = ${JSON.stringify(writerGroup)};
function send(sink, value) { sink(Buffer.from(JSON.stringify(value) + "\\n")); }
function acp() {
  let sink;
  let resolveExit = () => {};
  const processExit = new Promise((resolve) => { resolveExit = resolve; });
  function respond(message) {
    if (message.method === "initialize") send(sink, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    else if (message.method === "session/new") { if (existsSync(cwd+"/hold-opencode")) { setTimeout(()=>{ send(sink, { jsonrpc:"2.0",id:message.id,result:{sessionId:"session-1",configOptions:[{id:"model",type:"select",currentValue:"default",options:[]}]}}); },500); return; } send(sink, { jsonrpc: "2.0", id: message.id, result: {
      sessionId: "session-1", configOptions: [{ id: "model", type: "select", currentValue: "default", options: [] }] } }); }
    else if (message.method === "session/set_config_option") send(sink, { jsonrpc: "2.0", id: message.id, result: {
      configOptions: [{ id: "model", currentValue: message.params.value }] } });
    else if (message.method === "session/prompt") {
      send(sink, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
        sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: message.params.prompt[0].text.startsWith("ESCAPED_REPLY") ? ${JSON.stringify("\u0001")}.repeat(65_536) : message.params.prompt[0].text.startsWith("MAX_REPLY") ? "r".repeat(65_536) : message.params.prompt[0].text.startsWith("OVERFLOW") ? "r".repeat(65_537) : "cedar remembered" } } } });
      send(sink, { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: {} } });
    } else if (message.method === "session/close") send(sink, { jsonrpc: "2.0", id: message.id, result: {} });
  }
  return { processExit, writerGroups:()=>[], channel: {
    listen(next) { sink = next; return () => {}; },
    write(frame) {
      for (const line of Buffer.from(frame).toString("utf8").split("\\n")) if (line) respond(JSON.parse(line));
      return Promise.resolve();
    },
    endInput() { sink.ended(); resolveExit(); },
  } };
}
export const profiles = new Map([
  [${JSON.stringify("text-cursor.v1")}, {
    accountId: "text fixture",
    cursor: { model: "composer-2", apiKey: "cursor-secret", cwd, runtime(options) {
      let stubborn=false;
      appendFileSync(log, "start\\n");
      return { async start({ text, onEvent }) {
        if(text==="volume-swap-fixture") {
          const fs=await import("node:fs/promises");
          await fs.writeFile(${JSON.stringify(join(cwd,"swap-ready"))},options.sessionDirectory);
          while(true){try{await fs.access(${JSON.stringify(join(cwd,"swap-go"))});break;}catch{await new Promise(r=>setTimeout(r,10));}}
          await fs.writeFile(options.sessionDirectory+"/private-swap-marker","synthetic-private-volume-swap");
          await fs.writeFile(${JSON.stringify(join(cwd,"swap-written"))},"written");
          while(true){try{await fs.access(${JSON.stringify(join(cwd,"swap-restored"))});break;}catch{await new Promise(r=>setTimeout(r,10));}}
        }
        stubborn=text==="unconfirmed-writer-fixture";
        if(stubborn) appendFileSync(${JSON.stringify(join(cwd,"writer-target"))},options.sessionDirectory);
        onEvent({ kind: "text", text: text.startsWith("ESCAPED_REPLY") ? ${JSON.stringify("\u0001")} : text.startsWith("MAX_REPLY") || text.startsWith("OVERFLOW") ? "r" : "cedar " });
        onEvent({ kind: "text", text: text.startsWith("ESCAPED_REPLY") ? ${JSON.stringify("\u0001")}.repeat(65_536) : text.startsWith("MAX_REPLY") ? "r".repeat(65_536) : text.startsWith("OVERFLOW") ? "r".repeat(65_537) : ${JSON.stringify(reply)} });
        onEvent({ kind: "ended", outcome: "completed" });
        return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
      }, async close() {}, writerGroups:()=>stubborn?[writerGroup]:[] };
    } },
  }],
  [${JSON.stringify("text-opencode.v1")}, {
    accountId: "text fixture",
    opencode: { model: "provider/model", executable, cwd, account: "ACCOUNT LABEL", env: { OPENCODE_TOKEN: "kept" },
      spawn(request) {
        appendFileSync(log, "spawn\\n");
        if (JSON.stringify(request.env) !== JSON.stringify({ OPENCODE_TOKEN: "kept" })) throw new Error("environment");
        if (JSON.stringify(request.args) !== JSON.stringify([executable, "acp"])) throw new Error("argv");
        return acp();
      } },
  }],
]);
for (const engine of ["cursor", "opencode"]) {
  for (const requestTextBytes of [32_768, 65_536]) {
    profiles.set("text-" + engine + "-" + requestTextBytes + ".v1", { ...profiles.get("text-" + engine + ".v1"), requestTextBytes });
  }
}
export function close() {}
`;
}

async function until(label: string, check: () => Promise<boolean>) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > 60_000) throw new Error(label);
    await delay(100);
  }
}

test("cursor and opencode each commit one text turn and refuse a second launch", { timeout: 300_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "text-gateway-")));
  const alias=join(root,"state-alias"), replacement=join(root,"other-state");
  await mkdir(join(root,"state"));await symlink(join(root,"state"),alias,"dir");
  const cwd = root;
  const log = join(root, "launches.log");
  const heartbeat = join(root, "heartbeat");
  const config = join(root, "profiles.mjs");
  await writeFile(log, "");
  const writer=spawn(process.execPath,["-e",`const fs=require("node:fs");setInterval(()=>{try{const root=fs.readFileSync(process.argv[1],"utf8");fs.mkdirSync(root,{recursive:true});fs.writeFileSync(root+"/stubborn-writer","synthetic writer");}catch{}},50);`,join(root,"writer-target")],{detached:true,stdio:"ignore"});
  assert.ok(writer.pid);
  const stopWriter=async()=>{if(writer.exitCode===null&&writer.signalCode===null){const exited=once(writer,"close");process.kill(-writer.pid!,"SIGKILL");await exited;}};
  t.after(stopWriter);
  await writeFile(config, profileModule(log, cwd, writer.pid));
  const pool = new Pool({ connectionString: database });
  const store = new MemberStore(pool);
  await store.migrate();
  const connection = await Connection.connect({ address: temporalSettings(process.env).address });
  const temporal = new Client({ connection, namespace: temporalSettings(process.env).namespace });
  const token = randomUUID();
  const ownerId = randomUUID();
  const lookups = t.mock.method(store, "getConversation");
  const getHandle = t.mock.method(temporal.workflow, "getHandle");
  const startWorkflow = t.mock.method(temporal.workflow, "start");
  function workflowCalls(memberId: string, conversationId: string) {
    const id = `birbcrew-ts/member/${memberId}/conversation/${conversationId}`;
    return getHandle.mock.calls.filter(call => call.arguments[0] === id).length
      + startWorkflow.mock.calls.filter(call => call.arguments[1]?.workflowId === id).length;
  }
  const members = new MemberClient(store, temporal);
  const server = createGateway(store, members, { [createHash("sha256").update(token).digest("hex")]: ownerId });
  const stderr: Buffer[] = [];
  const startWorker = (stateDir: string) => {
    const child = spawn(process.execPath, ["src/service/cli.ts", "worker", config], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, BIRBCREW_DATABASE_URL: database, BIRBCREW_STATE_DIR: stateDir,
        BIRBCREW_TEXT_ENGINE_LOG: log, BIRBCREW_WORKER_HEARTBEAT_FILE: heartbeat },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", chunk => stderr.push(chunk));
    return child;
  };
  let worker = startWorker(alias + "/");
  t.after(async () => {
    if (worker.exitCode === null && !worker.signalCode) worker.kill("SIGKILL");
    await stopWriter();
    if(server.listening)server.close();
    await server.stopped();
    await connection.close();
    await pool.end();
    if (process.env.BIRBCREW_PROOF_LOG_DIR) await writeFile(join(process.env.BIRBCREW_PROOF_LOG_DIR, "text-worker.log"), Buffer.concat(stderr));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  await until("worker heartbeat", async () => {
    try { return (await readFile(heartbeat, "utf8")) !== undefined; }
    catch { return false; }
  }).catch((error: Error) => { throw new Error(`${error.message}\n${Buffer.concat(stderr).toString("utf8")}`); });

  // A live worker keeps the resolved volume even if its configured alias moves.
  await mkdir(replacement);await rm(alias);await symlink(replacement,alias,"dir");
  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }
  async function count(kind: string) {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line === kind).length;
  }

  for (const engine of ["cursor", "opencode"] as const) {
    const kind = engine === "cursor" ? "start" : "spawn";
    const before = await count(kind);
    const profile = engine === "cursor" ? "text-cursor.v1" : "text-opencode.v1";
    const created = await call("POST", "/members", { requestId: randomUUID(), engine, profile });
    assert.equal(created.status, 201);
    const memberId = (created.payload as { memberId: string }).memberId;
    const conversationId = randomUUID();
    const opened = await call("POST", "/conversations", { memberId, conversationId });
    assert.equal(opened.status, 201);
    const { rows: [limit] } = await pool.query<{ turn_limit: number }>("SELECT turn_limit FROM birbcrew_ts.conversations WHERE conversation_id = $1", [conversationId]);
    assert.equal(limit.turn_limit, 1);
    for (const route of [`/conversations/${conversationId}/inputs`, `/v1/conversations/${conversationId}/requests`]) {
      const refusedId = randomUUID();
      const callsBefore = workflowCalls(memberId, conversationId);
      assert.deepEqual(await call("POST", route, { requestId: refusedId, text: "x".repeat(16_385) }),
        { status: 400, payload: { error: "invalid_input" } });
      assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.request_admissions WHERE conversation_id=$1 AND request_id=$2", [conversationId, refusedId])).rowCount, 0);
      assert.equal(await count(kind), before);
      assert.equal(workflowCalls(memberId, conversationId), callsBefore);
    }
    const requestId = randomUUID();
    const submitted = await call("POST", `/conversations/${conversationId}/inputs`, { requestId, text: "remember cedar" });
    assert.equal(submitted.status, 202);
    assert.deepEqual(submitted.payload, { requestId });
    await until(`${engine} committed`, async () => {
      const status = await call("GET", `/conversations/${conversationId}/requests/${requestId}`);
      return status.status === 200 && (status.payload as { phase?: string; reply?: string }).phase === "committed"
        && (status.payload as { reply?: string }).reply === reply;
    });
    assert.equal(await count(kind), before + 1);
    const replay = await call("POST", `/conversations/${conversationId}/inputs`, { requestId, text: "remember cedar" });
    assert.equal(replay.status, 202);
    const again = await call("GET", `/conversations/${conversationId}/requests/${requestId}`);
    assert.equal((again.payload as { reply?: string }).reply, reply);
    assert.equal(await count(kind), before + 1);
    const blocked = randomUUID();
    const rejected = await call("POST", `/conversations/${conversationId}/inputs`, { requestId: blocked, text: "another" });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.payload, { error: "input_limit" });
    assert.equal(await count(kind), before + 1);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.native_launches WHERE conversation_id = $1 AND request_id = $2", [conversationId, blocked])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.usage_ledger WHERE conversation_id = $1", [conversationId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM birbcrew_ts.tool_previews WHERE conversation_id = $1", [conversationId])).rowCount, 0);
    const snapshot = await call("GET", `/conversations/${conversationId}`);
    assert.deepEqual((snapshot.payload as { state: { pendingApprovals: unknown[] } }).state.pendingApprovals, []);

    await until(`${engine} workflow closed`,async()=> (await temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${conversationId}`).describe()).status.name==="COMPLETED");
    const conversation=await store.getConversation({ownerId,conversationId});
    const sessionRoot=textTurnRootPath(join(root,"state"),conversation,engine);
    await mkdir(sessionRoot,{recursive:true});await writeFile(join(sessionRoot,"leftover"),"synthetic-leftover");
    const beforeErasure=await pool.query("SELECT cursor FROM birbcrew_ts.public_events WHERE conversation_id=$1 ORDER BY cursor",[conversationId]);
    const erased=await call("DELETE",`/v1/conversations/${conversationId}/content`);
    assert.equal(erased.status,200,JSON.stringify(erased.payload));
    assert.equal(await rootAbsent(sessionRoot),true);
    assert.deepEqual(await call("DELETE",`/v1/conversations/${conversationId}/content`),erased);
    const receipt=await call("GET",`/v1/conversations/${conversationId}/requests/${requestId}`);
    assert.equal(receipt.status,200);const parsed=serverRequestReceiptSchema.parse(receipt.payload);
    assert.equal(parsed.status,"completed");assert.equal(parsed.erased,true);assert.equal("result" in parsed,false);
    assert.equal(JSON.stringify(receipt.payload).includes(reply),false);
    const legacy=await call("GET",`/conversations/${conversationId}/requests/${requestId}`);
    assert.equal(legacy.status,200);assert.equal("reply" in (legacy.payload as object),false);
    const erasedSnapshot=await call("GET",`/v1/conversations/${conversationId}`);
    assert.deepEqual((erasedSnapshot.payload as {messages:unknown[]}).messages,[]);
    for(const text of ["remember cedar","changed"]){
      assert.deepEqual(await call("POST",`/v1/conversations/${conversationId}/requests`,{requestId,text}),{status:410,payload:{error:"conversation_erased"}});
    }
    assert.equal((await call("POST",`/conversations/${conversationId}/inputs`,{requestId:randomUUID(),text:"new"})).status,410);
    assert.equal((await call("POST",`/conversations/${conversationId}/cancel`,{requestId})).status,410);
    assert.equal((await call("POST","/conversations",{memberId,conversationId})).status,410);
    assert.equal(await count(kind),before+1);
    assert.deepEqual((await pool.query("SELECT cursor FROM birbcrew_ts.public_events WHERE conversation_id=$1 ORDER BY cursor",[conversationId])).rows,beforeErasure.rows);
    const content=await pool.query("SELECT erased,reply,checkpoint FROM birbcrew_ts.turns WHERE conversation_id=$1",[conversationId]);
    assert.deepEqual(content.rows,[{erased:true,reply:null,checkpoint:null}]);
    const events=await pool.query("SELECT DISTINCT event FROM birbcrew_ts.public_events WHERE conversation_id=$1",[conversationId]);
    assert.deepEqual(events.rows,[{event:{type:"CUSTOM",name:"crew.content_erased",value:null}}]);

    // Legitimate no-execution outcomes on existing idle workflows use the separate close command.
    for(const reason of ["predecessor_failed","predecessor_cancelled"] as const){
      const terminalId=randomUUID(),terminalRequest=randomUUID();
      assert.equal((await call("POST","/conversations",{memberId,conversationId:terminalId})).status,201);
      const terminalKey={ownerId,conversationId:terminalId,requestId:terminalRequest,text:"no-execution-fixture"};
      await store.recordAcceptance(terminalKey,ownerInitiator);await store.rejectAccepted(terminalKey,reason);
      assert.equal((await call("DELETE",`/v1/conversations/${terminalId}/content`)).status,409);
      const closed=await call("POST",`/v1/conversations/${terminalId}/close`,{});assert.equal(closed.status,202,JSON.stringify(closed.payload));
      await until("safe close",async()=> (await temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${terminalId}`).describe()).status.name==="COMPLETED");
      assert.equal((await call("POST",`/v1/conversations/${terminalId}/close`,{})).status,200);
      assert.equal((await call("DELETE",`/v1/conversations/${terminalId}/content`)).status,200);
      const terminal=await call("GET",`/v1/conversations/${terminalId}/requests/${terminalRequest}`);
      assert.equal((terminal.payload as {status:string}).status,reason==="predecessor_failed"?"failed":"cancelled");
      assert.equal((terminal.payload as {erased:boolean}).erased,true);
    }

    // Interrupt cleanup after its durable unlink but before its SQL acknowledgement.
    const interruptedId = randomUUID(), interruptedRequest = randomUUID();
    const interruptedKey = { ownerId, conversationId: interruptedId };
    await members.open({ ...interruptedKey, memberId });
    const rejectedRequest = { ...interruptedKey, requestId: interruptedRequest, text: "interrupted-cleanup" };
    await store.recordAcceptance(rejectedRequest, ownerInitiator);
    await store.rejectAccepted(rejectedRequest, "predecessor_failed");
    await members.closeTextConversation(interruptedKey);
    await until("interrupted fixture closed", async () => (await temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${interruptedId}`).describe()).status.name === "COMPLETED");
    await members.describeClosure(interruptedKey);
    const owningLocation = (await pool.query<{location_id:string}>("SELECT location_id FROM birbcrew_ts.text_conversation_locations WHERE conversation_id=$1 LIMIT 1", [conversationId])).rows[0];
    await pool.query("INSERT INTO birbcrew_ts.text_conversation_locations(conversation_id,location_id,profile) VALUES($1,$2,$3)", [interruptedId, owningLocation.location_id, conversation.profile]);
    const interruptedConversation = await store.getConversation(interruptedKey);
    const interruptedRoot = textTurnRootPath(join(root,"state"), interruptedConversation, engine);
    await mkdir(interruptedRoot, {recursive:true}); await writeFile(join(interruptedRoot,"leftover"), "synthetic-leftover");
    const erasureId = await beginContentErasure(store, interruptedKey), assignment = {...interruptedKey, erasureId};
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      const blocker=(await held.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await held.query("SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE", [interruptedId]);
      await members.ensureCleanupWorkflow(assignment);
      const cleanup = temporal.workflow.getHandle(`birbcrew-ts/content-erasure/${interruptedId}`);
      await until("unlink before acknowledgement", () => rootAbsent(interruptedRoot));
      let acknowledgementPid: number | undefined;
      await until("cleanup acknowledgement blocked",async()=> {
        acknowledgementPid=(await pool.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[blocker])).rows[0]?.pid;
        return acknowledgementPid!==undefined;
      });
      const originalExited = once(worker,"close");
      worker.kill("SIGKILL"); await originalExited;
      const firstCleanup = await cleanup.describe();
      assert.equal(firstCleanup.status.name, "RUNNING");
      assert.equal((await pool.query("SELECT cleaned_at FROM birbcrew_ts.conversation_content_cleanup WHERE conversation_id=$1", [interruptedId])).rows[0].cleaned_at, null);
      await cleanup.terminate("synthetic interruption after unlink");
      await members.ensureCleanupWorkflow(assignment);
      await until("replacement cleanup execution", async () => (await cleanup.describe()).runId !== firstCleanup.runId);
    } finally { await held.query("ROLLBACK"); held.release(); }
    await rm(heartbeat,{force:true});
    worker = startWorker(join(root,"state"));
    await until("cleanup replacement worker ready",async()=>{try{await readFile(heartbeat);return true;}catch{return false;}});
    const repaired = await eraseConversationContent({store, lifecycle:members, key:interruptedKey});
    assert.equal(repaired.erasureId, erasureId);
    assert.equal(await rootAbsent(interruptedRoot), true);

    const other = randomUUID();
    const openedOther = await call("POST", "/conversations", { memberId, conversationId: other });
    assert.equal(openedOther.status, 201);
    const left = randomUUID();
    const right = randomUUID();
    const pair = await Promise.all([
      call("POST", `/conversations/${other}/inputs`, { requestId: left, text: "remember cedar" }),
      call("POST", `/conversations/${other}/inputs`, { requestId: right, text: "remember cedar" }),
    ]);
    const statuses = pair.map((entry) => entry.status).sort();
    assert.deepEqual(statuses, [202, 409]);
    const winner = pair.find((entry) => entry.status === 202);
    const loser = pair.find((entry) => entry.status === 409);
    assert.deepEqual(loser?.payload, { error: "input_limit" });
    const winnerId = (winner?.payload as { requestId: string }).requestId;
    await until(`${engine} concurrent committed`, async () => {
      const status = await call("GET", `/conversations/${other}/requests/${winnerId}`);
      return (status.payload as { phase?: string; reply?: string }).phase === "committed"
        && (status.payload as { reply?: string }).reply === reply;
    });
    assert.equal(await count(kind), before + 2);
    const described = await temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${other}`).describe();
    assert.notEqual(described.status.name, "FAILED");
    if (engine === "cursor") {
      const legacyRoot=join(root,"pre-erasure");await mkdir(legacyRoot);
      await cp(fileURLToPath(new URL("../../src/service",import.meta.url)),join(legacyRoot,"service"),{recursive:true});
      await symlink(fileURLToPath(new URL("../../node_modules",import.meta.url)),join(legacyRoot,"node_modules"),"dir");
      const legacyWorkflow=join(legacyRoot,"service","workflow.ts");
      await writeFile(legacyWorkflow,await readFile(new URL("../fixtures/text-workflow-before-erasure.txt",import.meta.url)));
      const native=await NativeConnection.connect({address:temporalSettings(process.env).address});
      const legacyQueue="pre-erasure-"+randomUUID();
      let replayWorker=await Worker.create({connection:native,namespace:temporalSettings(process.env).namespace,taskQueue:legacyQueue,workflowsPath:legacyWorkflow});
      let running=replayWorker.run();
      try{
        const legacyId=randomUUID(),legacyRequest=randomUUID();
        const legacyConversation=await store.openConversation({ownerId,memberId,conversationId:legacyId});
        const handle=await temporal.workflow.start("memberConversation",{taskQueue:legacyQueue,
          workflowId:`birbcrew-ts/member/${memberId}/conversation/${legacyId}`,args:[legacyConversation]});
        await members.accept({ownerId,conversationId:legacyId,requestId:legacyRequest,text:"pre-erasure-history"});
        await until("legacy committed",async()=> (await store.requestStatus({ownerId,conversationId:legacyId,requestId:legacyRequest})).phase==="committed");
        assert.equal((await handle.describe()).status.name,"RUNNING");
        const oldHistory=await handle.fetchHistory();
        replayWorker.shutdown();await running;
        await Worker.runReplayHistory({workflowsPath:fileURLToPath(new URL("../../src/service/workflow.ts",import.meta.url))},oldHistory,handle.workflowId);
        replayWorker=await Worker.create({connection:native,namespace:temporalSettings(process.env).namespace,taskQueue:legacyQueue,
          workflowsPath:fileURLToPath(new URL("../../src/service/workflow.ts",import.meta.url))});
        running=replayWorker.run();
        assert.equal((await call("POST",`/v1/conversations/${legacyId}/close`,{})).status,202);
        await until("legacy safe close",async()=> (await handle.describe()).status.name==="COMPLETED");
        assert.equal((await call("DELETE",`/v1/conversations/${legacyId}/content`)).status,200);
      }finally{
        if(replayWorker.getState()==="RUNNING")replayWorker.shutdown();
        await running;await native.close();
      }
      const submitConversation = randomUUID();
      assert.equal((await call("POST", "/conversations", { memberId, conversationId: submitConversation })).status, 201);
      const left = randomUUID();
      const right = randomUUID();
      const submits = await Promise.allSettled([
        members.submit({ ownerId, conversationId: submitConversation, requestId: left, text: "remember cedar" }),
        members.submit({ ownerId, conversationId: submitConversation, requestId: right, text: "remember cedar" }),
      ]);
      const fulfilled = submits.filter((entry) => entry.status === "fulfilled");
      const rejectedSubmit = submits.find((entry) => entry.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(fulfilled[0].status === "fulfilled" && fulfilled[0].value, reply);
      assert.equal(rejectedSubmit?.status, "rejected");
      assert.equal(rejectedSubmit.reason.code, "input_limit");
      const submitHandle = temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${submitConversation}`);
      const submitWorkflow = await submitHandle.describe();
      assert.notEqual(submitWorkflow.status.name, "FAILED");
      await Worker.runReplayHistory(
        { workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)) },
        await submitHandle.fetchHistory(),
        submitHandle.workflowId,
      );
      assert.notEqual((await submitHandle.describe()).status.name, "FAILED");
    }
  }
  for (const conversationId of [randomUUID(), randomUUID()]) {
    for (const route of [`/conversations/${conversationId}/inputs`, `/v1/conversations/${conversationId}/requests`]) {
      assert.deepEqual(await call("POST", route, { requestId: randomUUID(), text: "\0" }),
        { status: 400, payload: { error: "invalid_input" } });
      assert.equal(lookups.mock.calls.filter(call => call.arguments[0].conversationId === conversationId).length, 0);
    }
  }
  const native = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "native-http-fixture" });
  const nativeConversation = randomUUID();
  await store.openConversation({ ownerId, memberId: native.memberId, conversationId: nativeConversation });
  for (const route of [`/conversations/${nativeConversation}/inputs`, `/v1/conversations/${nativeConversation}/requests`]) {
    const callsBefore = workflowCalls(native.memberId, nativeConversation);
    assert.deepEqual(await call("POST", route, { requestId: randomUUID(), text: "x".repeat(16_385) }),
      { status: 400, payload: { error: "invalid_input" } });
    assert.equal(workflowCalls(native.memberId, nativeConversation), callsBefore);
  }
  const provenance = JSON.parse(await readFile(new URL("../fixtures/text-member-histories/provenance.json", import.meta.url), "utf8"));
  for (const engine of ["cursor", "opencode"]) {
    const retained = await readFile(new URL(`../fixtures/text-member-histories/${engine}.json`, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(retained).digest("hex"), provenance.histories[`${engine}.json`]);
    await Worker.runReplayHistory({ workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)) }, JSON.parse(retained));
  }
  const measurements = [];
  for (const engine of ["cursor", "opencode"] as const) {
    for (const n of [32_768, 65_536]) {
      const profile = `text-${engine}-${n}.v1`;
      const created = await call("POST", "/members", { requestId: randomUUID(), engine, profile });
      assert.equal(created.status, 201);
      const memberId = (created.payload as { memberId: string }).memberId;
      const listing = await call("GET", "/v1/members");
      assert.equal((listing.payload as { members: { memberId: string; requestTextBytes?: number }[] }).members.find(m => m.memberId === memberId)?.requestTextBytes, n);
      if (engine === "cursor" && n === 65_536) {
        const conversationId = randomUUID(), requestId = randomUUID();
        assert.equal((await call("POST", "/v1/conversations", { memberId, conversationId })).status, 201);
        const prefix = 'Extract the synthetic record: {"name":"cedar"}. Padding: ';
        const text = prefix + "x".repeat(13 * 1024 - Buffer.byteLength(prefix));
        assert.equal(Buffer.byteLength(text), 13 * 1024);
        const before = await readFile(log, "utf8");
        assert.equal((await call("POST", `/v1/conversations/${conversationId}/requests`, { requestId, text })).status, 202);
        await until("Cursor 13 KiB committed", async () => (await store.requestStatus({ ownerId, conversationId, requestId })).phase === "committed");
        assert.equal(await members.submit({ ownerId, conversationId, requestId, text }), reply);
        const after = await readFile(log, "utf8");
        assert.equal(after.slice(before.length), "start\n");
        assert.equal((await call("POST", `/v1/conversations/${conversationId}/requests`, { requestId, text })).status, 202);
        assert.equal(await readFile(log, "utf8"), after, "13 KiB replay does not launch again");
      }
      for (const versioned of [false, true]) {
        const conversationId = randomUUID();
        assert.equal((await call("POST", "/conversations", { memberId, conversationId })).status, 201);
        const route = versioned ? `/v1/conversations/${conversationId}/requests` : `/conversations/${conversationId}/inputs`;
        const requestId = randomUUID();
        const callsBefore = workflowCalls(memberId, conversationId);
        const launchesBefore = await readFile(log, "utf8");
        for (const text of ["x".repeat(n + 1), "é".repeat(n / 2) + "x", "\0", "\ud800", ""]) {
          assert.deepEqual(await call("POST", route, { requestId, text }), { status: 400, payload: { error: "invalid_input" } });
        }
        for (const extra of [{ ownerId }, { conversationId }, { conversationId: randomUUID() }]) {
          assert.equal((await call("POST", route, { requestId, text: "okay", ...extra })).status, 400);
        }
        for (const operation of [members.accept.bind(members), members.submit.bind(members)]) {
          await assert.rejects(operation({ ownerId, conversationId, requestId, text: "x".repeat(n + 1) }), { name: "ZodError" });
        }
        assert.equal(workflowCalls(memberId, conversationId), callsBefore, "refusal makes no workflow call");
        assert.equal(await readFile(log, "utf8"), launchesBefore);
        for (const table of ["request_admissions", "turns", "native_launches"]) {
          assert.equal((await pool.query(`SELECT 1 FROM birbcrew_ts.${table} WHERE conversation_id=$1`, [conversationId])).rowCount, 0);
        }
        if (engine === "opencode") {
          assert.deepEqual(await call("POST", route, { requestId, text: "/" + "x".repeat(n - 1) }), { status: 409, payload: { error: "conflict" } });
        }
        // A legal decoded maximum can exceed the independent JSON transport cap.
        if (n === 65_536) assert.deepEqual(await call("POST", route, { requestId, text: '"'.repeat(n) }),
          { status: 413, payload: { error: "request_too_large" } });
        const text = n === 65_536 ? (versioned ? "ESCAPED_REPLY " + '"'.repeat(32_768) + "x".repeat(n - 14 - 32_768) : "MAX_REPLY " + "é".repeat((n - 10) / 2)) : "é".repeat(n / 2);
        assert.equal(Buffer.byteLength(text), n);
        const expectedReply = n === 65_536 ? (versioned ? "\u0001" : "r").repeat(65_536) : reply;
        assert.equal((await call("POST", route, { requestId, text })).status, 202);
        await until(`${engine} ${n} committed`, async () => {
          const status = await call("GET", `/conversations/${conversationId}/requests/${requestId}`);
          return (status.payload as { reply?: string }).reply === expectedReply;
        });
        assert.equal(await members.submit({ ownerId, conversationId, requestId, text }), expectedReply);
        assert.equal((await call("POST", route, { requestId, text })).status, 202);
        for (const changed of [text + "x", "x".repeat(65_537), "different", text.includes("é") ? text.replace("é", "e\u0301") : text + "\r\n"]) {
          assert.deepEqual(await call("POST", route, { requestId, text: changed }), { status: 409, payload: { error: "conflict" } });
        }
        assert.deepEqual(await call("POST", route, { requestId: randomUUID(), text: "next" }),
          { status: 409, payload: { error: "input_limit" } });
        const snapshot = await call("GET", `/conversations/${conversationId}`);
        const messages = (snapshot.payload as { messages: { role: string; content: string }[] }).messages;
        assert.equal(messages.find(m => m.role === "user")?.content, text);
        assert.equal(messages.find(m => m.role === "assistant")?.content, expectedReply);
        const observer = await fetch(base + `/conversations/${conversationId}/events`, {
          method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ threadId: conversationId, runId: randomUUID(), tools: [], messages: [], context: [], state: {}, forwardedProps: {} }),
        });
        assert.equal(observer.status, 200);
        const stream = await observer.text();
        const observed = stream.split("\n").filter(line => line.startsWith("data: "))
          .map(line => MessagesSnapshotEventSchema.safeParse(JSON.parse(line.slice(6))))
          .find(frame => frame.success);
        assert.ok(observed?.success);
        assert.deepEqual(observed.data.messages, messages, "observer preserves the exact input and reply");
        const handle = temporal.workflow.getHandle(`birbcrew-ts/member/${memberId}/conversation/${conversationId}`);
        await until("workflow task and activities settle before sizing", async () => {
          const described = await temporal.connection.workflowService.describeWorkflowExecution({
            namespace: temporalSettings(process.env).namespace, execution: { workflowId: handle.workflowId },
          });
          return !described.pendingWorkflowTask && !described.pendingActivities?.length;
        });
        const history = await handle.fetchHistory();
        assert.ok([temporalProto.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED,temporalProto.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED].includes(history.events?.at(-1)?.eventType ?? 0));
        for (const activity of ["recordAcceptance", "executeTurn"]) {
          const scheduled = history.events?.find(event => event.activityTaskScheduledEventAttributes?.activityType?.name === activity);
          assert.ok(scheduled);
          const input = scheduled.activityTaskScheduledEventAttributes?.input?.payloads?.[0];
          assert.ok(input);
          const decodedInput: unknown = defaultPayloadConverter.fromPayload(input);
          assert.ok(decodedInput && typeof decodedInput === "object" && "text" in decodedInput);
          assert.equal(decodedInput.text, text);
          const completed = history.events?.find(event => event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() === scheduled.eventId?.toString());
          assert.ok(completed, `${activity} completion must be present`);
          if (activity === "executeTurn") {
            const result = completed.activityTaskCompletedEventAttributes?.result?.payloads?.[0];
            assert.ok(result);
            const decoded: unknown = defaultPayloadConverter.fromPayload(result);
            assert.ok(decoded && typeof decoded === "object" && "text" in decoded);
            assert.equal(decoded.text, expectedReply, "history must carry the complete bounded reply");
          }
        }
        await Worker.runReplayHistory({ workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)) }, history, handle.workflowId);
        const encodedHistory = temporalProto.api.history.v1.History.encode(history).finish().length;
        const events = (history.events ?? []).map(event => ({
          type: event.eventType, attributes: Object.keys(event).find(key => key.endsWith("EventAttributes")),
          payloadBytes: encodedPayloadSizes(event), bytes: temporalProto.api.history.v1.HistoryEvent.encode(event).finish().length,
        }));
        const request = { ownerId, conversationId, requestId, text };
        const payload = defaultPayloadConverter.toPayload(request);
        assert.ok(payload);
        const converterBytes = temporalProto.api.common.v1.Payload.encode(payload).finish().length;
        assert.ok(converterBytes < sizingFixture.budgets.singlePayloadBytes);
        assert.ok(events.every(event => event.bytes < sizingFixture.budgets.singleEventBytes && event.payloadBytes.every(bytes => bytes < sizingFixture.budgets.singlePayloadBytes)));
        assert.ok(encodedHistory < sizingFixture.budgets.wholeHistoryBytes, "whole history conservatively bounds each contained transaction");
        const measurement = { engine, n, versioned, promptDigest: createHash("sha256").update(text).digest("hex"),
          replyDigest: createHash("sha256").update(expectedReply).digest("hex"),
          replyBytes: Buffer.byteLength(expectedReply), converterBytes, encodedHistory, finalEvent: events.at(-1)?.attributes, events };
        const sample = sizingFixture.runs.find(run => run.engine === engine && run.n === n && run.versioned === versioned);
        assert.ok(sample);
        for (const key of ["promptDigest", "replyDigest", "replyBytes", "converterBytes"] as const) {
          assert.equal(measurement[key], sample[key], `requalify sizing fixture when ${key} changes`);
        }
        measurements.push(measurement);
        if (process.env.BIRBCREW_TEXT_EVIDENCE_DIR) {
          await mkdir(process.env.BIRBCREW_TEXT_EVIDENCE_DIR, { recursive: true });
          await writeFile(join(process.env.BIRBCREW_TEXT_EVIDENCE_DIR, `${engine}-${n}-${versioned}.json`), historyToJSON(history));
        }
      }
    }
    const overflowMember = await call("POST", "/members", { requestId: randomUUID(), engine, profile: `text-${engine}.v1` });
    const memberId = (overflowMember.payload as { memberId: string }).memberId;
    const conversationId = randomUUID(), requestId = randomUUID();
    assert.equal((await call("POST", "/conversations", { memberId, conversationId })).status, 201);
    assert.equal((await call("POST", `/conversations/${conversationId}/inputs`, { requestId, text: "OVERFLOW" })).status, 202);
    await until("oversized reply settles uncertain", async () => {
      const receipt = await call("GET", `/conversations/${conversationId}/requests/${requestId}`);
      return (receipt.payload as { phase?: string }).phase === "uncertain";
    });
    assert.deepEqual(await call("POST", `/conversations/${conversationId}/inputs`, { requestId, text: "OVERFLOW" }),
      { status: 409, payload: { error: "conflict" } });
  }
  if (process.env.BIRBCREW_TEXT_EVIDENCE_DIR) {
    const declaredLimits = process.env.BIRBCREW_TEXT_SERVER_LIMITS
      ? z.object({ blobSizeLimitError: z.int().positive(), transactionSizeLimit: z.int().positive() })
        .parse(JSON.parse(process.env.BIRBCREW_TEXT_SERVER_LIMITS)) : undefined;
    const server = await temporal.connection.workflowService.getSystemInfo({});
    const postgres = await pool.query<{ server_version: string }>("SHOW server_version");
    const sdk = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL("../../node_modules/@temporalio/worker/package.json", import.meta.url), "utf8")));
    await writeFile(join(process.env.BIRBCREW_TEXT_EVIDENCE_DIR, "sizing.json"), JSON.stringify({
      ...sizingFixture,
      measurementNotes: [...sizingFixture.measurementNotes.filter(note => !note.startsWith("Histories are complete recorded prefixes")),
        "Current captures record each observed finalEvent; settled prefixes and natural terminal completion are distinguished per run."],
      environment: { ...sizingFixture.environment, node: process.versions.node, postgres: postgres.rows[0].server_version,
        temporalSDK: sdk.version, temporalServer: server.serverVersion ?? "unreported",
        temporalCLI: process.env.BIRBCREW_TEXT_TEMPORAL_CLI_VERSION ?? "unverified" },
      effectiveTestLimits: declaredLimits ? { ...declaredLimits, verification: "declared_by_fixture_launcher_not_introspected" }
        : { verification: "unverified", source: "No fixture launcher settings supplied; remote limits are not exposed by the runtime API." },
      runs: measurements, fixtureSource: {
        gatewayTestSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
        capture: "Recorded history after admission and turn completion; each run names its observed finalEvent. Exact inputs and reply checked. Runtime versions queried; CLI and limits labeled separately.",
      },
    }, null, 2) + "\n");
  }

  // A registered volume cannot be rebound while its SDK call and teardown are in flight.
  {
    const member=await store.spawn({ownerId,requestId:randomUUID(),engine:"cursor",profile:"text-cursor.v1"});
    const key={ownerId,conversationId:randomUUID()},requestId=randomUUID();
    await members.open({...key,memberId:member.memberId});
    await members.accept({...key,requestId,text:"volume-swap-fixture"});
    await until("SDK volume barrier",async()=>{try{await readFile(join(root,"swap-ready"));return true;}catch{return false;}});
    const conversation=await store.getConversation(key), state=join(root,"state");
    const original=join(state,"cursor"), parked=join(state,"cursor-parked"), replacement=join(state,"cursor-replacement");
    const relative=textTurnRootPath(state,conversation,"cursor").slice(original.length+1);
    await rename(original,parked);
    await mkdir(join(original,relative),{recursive:true});
    await writeFile(join(original,".birbcrew-text-volume"),randomUUID());
    let wrote=false;
    try {
      await writeFile(join(root,"swap-go"),"go");
      await until("SDK wrote session artifact",async()=>{try{await readFile(join(root,"swap-written"));return true;}catch{return false;}});
      wrote=true;
    } finally {
      await rename(original,replacement); await rename(parked,original);
      await writeFile(join(root,"swap-restored"),"restored");
    }
    assert.equal(wrote,true);
    await until("volume-swap request committed",async()=> (await store.requestStatus({...key,requestId})).phase==="committed");
    await until("volume-swap workflow closed",async()=> (await temporal.workflow.getHandle(`birbcrew-ts/member/${member.memberId}/conversation/${key.conversationId}`).describe()).status.name==="COMPLETED");
    assert.equal((await eraseConversationContent({store,lifecycle:members,key})).erased,true);
    await assert.rejects(readFile(join(replacement,relative,"private-swap-marker")),{code:"ENOENT"});
    assert.equal(await rootAbsent(textTurnRootPath(state,conversation,"cursor")),true);
  }

  const member=await store.spawn({ownerId,requestId:randomUUID(),engine:"cursor",profile:"text-cursor.v1"});
  const key={ownerId,conversationId:randomUUID()},requestId=randomUUID();
  await members.open({...key,memberId:member.memberId});
  await members.accept({...key,requestId,text:"unconfirmed-writer-fixture"});
  await until("detached writer turn committed",async()=> (await store.requestStatus({...key,requestId})).phase==="committed");
  await until("detached writer workflow closed",async()=> (await temporal.workflow.getHandle(`birbcrew-ts/member/${member.memberId}/conversation/${key.conversationId}`).describe()).status.name==="COMPLETED");
  const conversation=await store.getConversation(key),sessionRoot=textTurnRootPath(join(root,"state"),conversation,"cursor");
  await until("detached writer outlives runner",async()=>{try{await readFile(join(sessionRoot,"stubborn-writer"));return true;}catch{return false;}});
  // A published proc-FD path must stay on Cursor while its detached writer lives.
  await writeFile(join(root,"hold-opencode"),"hold");
  const leaked = join(root,"state","opencode",sessionRoot.slice(join(root,"state","cursor").length+1),"stubborn-writer");
  for (let i=0;i<3;i++) {
    const next=await store.spawn({ownerId,requestId:randomUUID(),engine:"opencode",profile:"text-opencode.v1"});
    const nextKey={ownerId,conversationId:randomUUID()}, nextRequest=randomUUID();
    await members.open({...nextKey,memberId:next.memberId});
    await members.accept({...nextKey,requestId:nextRequest,text:"descriptor-reuse-fixture"});
    await until("later OpenCode turn committed",async()=> (await store.requestStatus({...nextKey,requestId:nextRequest})).phase==="committed");
    await assert.rejects(readFile(leaked),{code:"ENOENT"});
  }
  await rm(join(root,"hold-opencode"));
  const before=JSON.stringify((await pool.query("SELECT messages,state FROM birbcrew_ts.public_snapshots WHERE conversation_id=$1",[key.conversationId])).rows);
  const denied=await call("DELETE",`/v1/conversations/${key.conversationId}/content`);
  assert.deepEqual(denied,{status:409,payload:{error:"content_runtime_unconfirmed"}});
  assert.equal(JSON.stringify((await pool.query("SELECT messages,state FROM birbcrew_ts.public_snapshots WHERE conversation_id=$1",[key.conversationId])).rows),before);
  const {rows:[location]}=await pool.query<{location_id:string}>("SELECT location_id FROM birbcrew_ts.text_conversation_locations WHERE conversation_id=$1",[key.conversationId]);
  await members.describeClosure(key);
  assert.equal((await pool.query("SELECT text_lifecycle FROM birbcrew_ts.conversations WHERE conversation_id=$1",[key.conversationId])).rows[0].text_lifecycle,"sealed_closed");
  await enrollErasureInventory(store,temporal,{version:1,conversations:[{...key,inventory:{kind:"locations",locations:[{locationId:location.location_id,engine:"cursor",profile:"text-cursor.v1"}]}}]}, {
    async quiesce(){
      server.close();await server.stopped();
      const stopped=once(worker,"close");worker.kill("SIGKILL");await stopped;
      await stopWriter();
    },
  });
  await rm(heartbeat,{force:true});
  worker=startWorker(join(root,"state"));
  await until("replacement worker",async()=>{try{await readFile(heartbeat);return true;}catch{return false;}});
  assert.equal((await eraseConversationContent({store,lifecycle:members,key})).erased,true);
  assert.equal(await rootAbsent(sessionRoot),true);
  await assert.rejects(readFile(leaked),{code:"ENOENT"});

});
