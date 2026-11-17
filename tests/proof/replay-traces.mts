import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client, Connection } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/proto-utils";
import { Pool } from "pg";
import { z } from "zod";
import { type Approval } from "../../src/service/approvals.ts";
import { MemberClient } from "../../src/service/client.ts";
import { MemberStore } from "../../src/service/store.ts";
import { attributable, evidenceOutputs, sourceFingerprint } from "./member-report.mts";

const { replay: evidence } = await evidenceOutputs();
const directory = await mkdtemp(join(tmpdir(), "birb-replay-"));
const traces = join(directory, "traces.jsonl"), requests = join(directory, "requests.jsonl");
const credential = "fixture-token-" + randomUUID(), secretNote = "private-note-" + randomUUID();
const config = join(directory, "profile.mjs"), profile = "replay-" + randomUUID();
const pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL });
const connection = await Connection.connect({ address: process.env.BIRBCREW_TEMPORAL_ADDRESS });
const temporal = new Client({ connection });
const store = new MemberStore(pool);
const members = new MemberClient(store, temporal);
const run = promisify(execFile);

async function until<T>(check: () => Promise<T | undefined>, label: string) {
  for (let i = 0; i < 240; i++) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(250);
  }
  throw new Error(label);
}

function startWorker() {
  const proc = spawn(process.execPath, ["src/service/cli.ts", "worker", config], {
    env: {
      PATH: process.env.PATH, HOME: directory, BIRBCREW_STATE_DIR: join(directory, "native"),
      BIRBCREW_DATABASE_URL: process.env.BIRBCREW_DATABASE_URL, BIRBCREW_TEMPORAL_ADDRESS: process.env.BIRBCREW_TEMPORAL_ADDRESS,
      BIRBCREW_PROOF_REQUESTS: requests, BIRBCREW_PROOF_CODEX_REQUESTS: requests, BIRBCREW_TRACE_FILE: traces,
    }, stdio: "ignore",
  });
  const exit = once(proc, "exit");
  return async () => { proc.kill("SIGKILL"); await exit; };
}

const timestamp = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);
const span = z.strictObject({
  name: z.enum(["workflow.segment", "model.invoke", "tool.settle", "native.restore"]),
  traceId: z.string().regex(/^[0-9a-f]{32}$/), spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parent: z.string().regex(/^[0-9a-f]{16}$/).optional(), start: timestamp, duration: timestamp,
  status: z.literal(1), attributes: z.strictObject({
    conversationId: z.uuid(), requestId: z.uuid(), workflowRunId: z.uuid(), engine: z.enum(["pi", "claude", "codex"]), childId: z.uuid().optional(),
  }),
});

const ids = { codex: randomUUID(), pi: randomUUID(), claude: randomUUID() };
const decisionIds = { codex: randomUUID(), pi: randomUUID(), claude: randomUUID() };
const ownerId = "private-owner-" + randomUUID();
let stop: (() => Promise<void>) | undefined;
try {
  const initialSource = evidence ? await sourceFingerprint() : undefined;
  if (initialSource && !attributable(initialSource)) throw new Error("Replay evidence requires attributable source");
  await store.migrate();
  const fixture = new URL("./fixture-profiles.mts", import.meta.url).href;
  await writeFile(config, `import {profiles as original, close} from ${JSON.stringify(fixture)};
    export {close};
    const chat = original.get("fixture.approval.v1");
    export const profiles = new Map([[${JSON.stringify(profile)}, {...chat, delegateTask: true,
      claude: {...chat.claude, apiKey: ${JSON.stringify(credential)}}}]]);`, { mode: 0o600 });
  stop = startWorker();
  await until(async () => (await pool.query("SELECT 1 FROM birbcrew_ts.profiles WHERE name=$1", [profile])).rowCount === 3 || undefined,
    "Trace fixture registration");
  const cases = await Promise.all((["pi", "claude", "codex"] as const).map(async (engine) => {
    const member = await store.spawn({ ownerId, engine, profile, requestId: randomUUID() });
    const key = { ownerId, conversationId: ids[engine] };
    await members.open({ ...key, memberId: member.memberId });
    if (engine === "codex") {
      const fact = "private-codex-" + randomUUID();
      assert.equal(await members.submit({...key, requestId:randomUUID(),text:"remember " + fact}), "stored " + fact);
    }
    const requestId = randomUUID();
    const text = engine === "pi" ? "delegate " + JSON.stringify([{ role: "recorder", task: "record assigned " + secretNote }]) : "record " + requestId;
    const pending = members.submit({ ...key, requestId, text });
    // Observe the promise immediately even if the readiness check fails.
    void pending.catch(() => {});
    const approval = await until(async () => (await members.pending(key))[0], "Native tool did not pause");
    return { key, member, requestId, approval, pending };
  }));
  // Codex's original MCP request must receive its answer before replacing the worker.
  const codex = cases.find(c => c.member.engine === "codex")!;
  const a = codex.approval;
  await members.decide({ownerId, memberId:a.memberId,conversationId:a.conversationId,requestId:a.requestId,
    nativeCallId:a.nativeCallId,invocationId:a.invocationId,approvalId:a.approvalId,version:a.version,argumentDigest:a.argumentDigest,choice:"approve",
    decisionId:decisionIds.codex});
  await codex.pending;
  await stop();
  stop = startWorker();
  const workflowIds: string[] = [];
  for (const { key, member, requestId, approval, pending } of cases) {
    const { ownerId, memberId, conversationId, nativeCallId, invocationId, approvalId, version, argumentDigest }: Approval = approval;
    const decision = { ownerId, memberId, conversationId, requestId, nativeCallId, invocationId, approvalId, version, argumentDigest,
      choice: "approve" as const, decisionId: decisionIds[member.engine] };
    assert.equal(await members.decide(decision), "approve");
    assert.equal(await members.decide(decision), "approve");
    const result = await pending;
    const receipt = (await pool.query("SELECT receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=$1 AND request_id=$2", [conversationId, requestId])).rows[0]?.receipt_id;
    assert.ok(receipt && result.includes(receipt));
    const workflowId = "birbcrew-ts/member/" + memberId + "/conversation/" + conversationId;
    workflowIds.push(workflowId);
    if (member.engine === "pi") workflowIds.push("birbcrew-ts/child/" + invocationId);
    for (let i = member.engine === "codex" ? 1 : 0; i < 3; i++) {
      const text = "remember " + secretNote;
      assert.equal(await members.submit({ ...key, requestId: randomUUID(), text }), "stored " + secretNote);
    }
    await temporal.workflow.getHandle(workflowId).result();
  }
  await stop();
  stop = undefined;
  const histories = new Map<string, string>();
  const exported = [];
  for (const [index, workflowId] of workflowIds.entries()) {
    const handle = temporal.workflow.getHandle(workflowId);
    const { runId, status } = await handle.describe();
    assert.equal(status.name, "COMPLETED");
    histories.set(workflowId, runId);
    const bytes = historyToJSON(await handle.fetchHistory());
    await writeFile(join(directory, index + ".json"), bytes, { mode: 0o600 });
    exported.push({ workflowId, runId, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(workflowIds), { mode: 0o600 });

  const raw = await readFile(traces, "utf8");
  for (const privateValue of [credential, secretNote, ownerId, "private fixture note", "authorization", "x-api-key", "remember ", "message_start"]) {
    assert.ok(!raw.toLowerCase().includes(privateValue.toLowerCase()), "Private data in trace");
  }
  const rows = raw.trim().split("\n").map((line) => span.parse(JSON.parse(line)));
  for (const { member, requestId, approval } of cases) {
    const correlated = rows.filter((r) => r.attributes.requestId === requestId && r.attributes.engine === member.engine);
    assert.deepEqual(new Set(correlated.map((r) => r.name)), new Set(span.shape.name.options));
    assert.equal(new Set(correlated.map((r) => r.traceId)).size, 1);
    const calls = correlated.filter((r) => r.name === "tool.settle");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].attributes.childId, member.engine === "pi" ? approval.invocationId : undefined);
    for (const row of correlated) {
      assert.equal(row.attributes.conversationId, ids[member.engine]);
      const child = row.attributes.childId;
      const workflowId = child ? "birbcrew-ts/child/" + child : "birbcrew-ts/member/" + member.memberId + "/conversation/" + ids[member.engine];
      assert.equal(row.attributes.workflowRunId, histories.get(workflowId));
      if (child) assert.equal(child, approval.invocationId);
      if (row.name === "model.invoke" || row.name === "native.restore") assert.ok(correlated.some((r) => r.spanId === row.parent));
    }
  }
  const callsBefore = await readFile(requests, "utf8");
  assert.ok(callsBefore.includes(secretNote));
  const ledger = async () => (await pool.query(
    "SELECT approval_id,receipt_id FROM birbcrew_ts.work_items WHERE conversation_id=ANY($1::uuid[]) ORDER BY approval_id",
    [Object.values(ids)])).rows;
  const receiptsBefore = await ledger();
  assert.equal(receiptsBefore.length, 3);
  // Named decisions travel through the decide update as opaque arguments; the replay below must not see them.
  const named = await pool.query("SELECT decision_id FROM birbcrew_ts.deferred_calls WHERE approval_id=ANY($1::uuid[]) ORDER BY decision_id",
    [cases.map(c => c.approval.approvalId)]);
  assert.deepEqual(named.rows.map(r => r.decision_id), Object.values(decisionIds).sort());
  const replay = await run("unshare", ["--user", "--net", process.execPath, "tests/proof/offline-replay.mts", directory], {
    env: { PATH: process.env.PATH, HOME: directory }, timeout: 120_000,
  });
  assert.deepEqual(JSON.parse(replay.stdout), { replayed: 4, activityLoads: 0 });
  assert.equal(await readFile(requests, "utf8"), callsBefore);
  assert.equal(await readFile(traces, "utf8"), raw);
  assert.deepEqual(await ledger(), receiptsBefore);
  const summary = { replayed: { codex: 1, claude: 1, pi: 1, piChild: 1 }, replayProviderCalls: 0,
    replayToolCalls: 0, replayEffects: 0, correlatedSpans: rows.length, redaction: "VERIFIED" };
  if (evidence) {
    const source = await sourceFingerprint();
    assert.deepEqual(source, initialSource, "Source changed during replay verification");
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    const packages = ["@openai/codex-sdk","@openai/codex","@temporalio/worker", "@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-coding-agent",
      "@ag-ui/claude-agent-sdk", "@ag-ui/pi", "@opentelemetry/sdk-trace-base"].map((name) => {
      const { version, integrity } = z.object({ version: z.string(), integrity: z.string().startsWith("sha512-") })
        .parse(lock.packages["node_modules/" + name]);
      return { name, version, integrity };
    });
    const path = evidence + "." + randomUUID() + ".tmp";
    try {
      const publicReport = JSON.stringify({ ...summary, mode: "fixture", sourceRevision: source.revision, source, packages,
        node: process.version, histories: exported, spans: rows }, null, 2) + "\n";
      for (const privateValue of [credential, secretNote, ownerId]) assert.ok(!publicReport.includes(privateValue), "Private data in replay evidence");
      await writeFile(path, publicReport, { flag: "wx", mode: 0o600 });
      await rename(path, evidence);
    } finally {
      await rm(path, { force: true });
    }
  }
  console.log(JSON.stringify(summary));
} finally {
  await stop?.();
  await connection.close();
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
