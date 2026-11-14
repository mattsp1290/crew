import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CrewClient, CrewHttpError } from "@birbcrew/client";
import { createCrewObserver } from "@birbcrew/client/agui";
import { commands, pendingSchema } from "./member-commands.mts";
import { services, until, type Engine } from "./member-services.mts";
import { startRestartFixtures } from "./proxy-restart-fixtures.mts";

// Public HTTP boundary + real Temporal/SQL/native worker fixtures. No live inference.
assert.equal(process.version, "v24.22.3");
const s = await services();
const ownerId = randomUUID(), token = randomUUID(), stranger = randomUUID();
const config = join(s.directory, "gateway.json");
await writeFile(config, JSON.stringify({ port: 0, tokenHashes: {
  [createHash("sha256").update(token).digest("hex")]: ownerId,
  [createHash("sha256").update(stranger).digest("hex")]: randomUUID(),
} }), { mode: 0o600 });
// The operator's price table, which the worker's supervisor reads at startup and applies to each
// reported segment as it writes the segment's ledger row.
const prices = join(s.directory, "prices.json");
await writeFile(prices, JSON.stringify({ version: 1, unit: "usd-per-million-tokens", models: {
  "claude-sonnet-4-6": { input: "3", output: "15" }, "gpt-5.4": { input: "1.25", cachedInput: "0.125", output: "10" },
} }), { mode: 0o600 });
s.env.BIRBCREW_USAGE_PRICES_PATH = prices;
let endpoint = "";
let client = new CrewClient({ baseUrl: "http://127.0.0.1", token });
let stopGateway: (() => Promise<void>) | undefined;
async function gateway() {
  const child = spawn(process.execPath, ["src/service/gateway.ts", config], { env: s.env, stdio: ["ignore", "pipe", "inherit"] });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const url = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line).url as string),
    exit.then(() => { throw new Error("Gateway exited before listening"); }),
  ]).finally(() => lines.close());
  endpoint = url;
  client = new CrewClient({ baseUrl: endpoint, token });
  stopGateway = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  };
}
async function rawRequest(path: string, body?: unknown, auth = token) {
  return fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + auth, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function observe(conversationId: string) {
  const agent = createCrewObserver({ baseUrl: endpoint, token, conversationId });
  const seen: string[] = [];
  const done = agent.runAgent({}, { onEvent({ event }) { seen.push(event.type); } }).catch(() => undefined);
  return { agent, seen, stop: async () => { agent.abortRun(); await agent.detachActiveRun(); await done; } };
}
try {
  const fixtures = await startRestartFixtures({ codexUsage: () => ({ input_tokens: 1000, input_tokens_details: { cached_tokens: 400 },
    output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1050 }) });
  try {
    s.env.BIRBCREW_PROXY_FIXTURE_ENDPOINTS = JSON.stringify(fixtures.endpoints);
    const stopTemporal = await s.startTemporal();
    let stopWorker = await s.child(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/proxy-restart-profiles.mts"]);
    try {
      await until(async () => {
        try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='proxy.fixture.v1'") === "3" || undefined; }
        catch { return undefined; }
      }, "proxy worker registration");
      await gateway();
      const capabilities = await client.capabilities();
      assert.equal(capabilities.apiVersion, "1");
      const health = await client.health();
      assert.equal(health.status, "ready", "real PostgreSQL and Temporal frontend are ready");
      assert.equal(health.dependencies.temporal.status, "ready");
      for (const engine of ["claude", "codex", "pi"] as Engine[]) {
        const member = await client.createMember({ requestId: randomUUID(), engine, profile: "proxy.fixture.v1" });
        assert.ok((await client.listMembers()).members.some(item => item.memberId === member.memberId));
        const conversationId = randomUUID();
        await client.openConversation({ memberId: member.memberId, conversationId });
        const marker = randomUUID(), submissions: { requestId: string; text: string }[] = [];
        let observer = observe(conversationId);
        try {
          await until(async () => observer.seen.includes("STATE_SNAPSHOT") || undefined, "independent official AG-UI snapshot");
          for (let i = 0; i < 6; i++) {
            const payload = { requestId: randomUUID(), text: i === 5 ? "recall" : "remember " + marker };
            submissions.push(payload);
            const receipt = await client.submit({ conversationId, ...payload });
            assert.equal(receipt.requestId, payload.requestId);
            assert.equal(receipt.acceptance.boundary, "sql_admission_and_temporal_queue");
            if (i === 4) {
              // Lost completion connection/recreated HTTP process on the far side
              // of a Temporal generation boundary, not just a new JS client.
              await observer.stop();
              await stopGateway!(); await gateway();
              observer = observe(conversationId);
            }
            const status = await until(async () => {
              const value = await client.requestStatus({ conversationId, requestId: payload.requestId });
              assert.ok(!["failed", "uncertain", "cancelled"].includes(value.status), JSON.stringify(value));
              return value.status === "completed" ? value : undefined;
            }, `${engine} completed turn ${i + 1}`);
            assert.equal(status.result.text, (i === 5 ? "recalled " : "stored ") + marker);
          }
          await until(async () => observer.agent.messages.filter(message => message.role === "assistant").length === 6 || undefined,
            "official observer independently projects all six results");
          assert.equal(fixtures.evidence()[engine].requests, 6);
          const counters = fixtures.evidence()[engine].requests;
          for (const payload of submissions) {
            const original = await client.requestStatus({ conversationId, requestId: payload.requestId });
            assert.deepEqual(await client.submit({ conversationId, ...payload }), original);
            assert.deepEqual(await client.requestStatus({ conversationId, requestId: payload.requestId }), original);
          }
          await assert.rejects(client.submit({ conversationId, ...submissions[0], text: "changed" }), error => error instanceof CrewHttpError && error.status === 409);
          await assert.rejects(new CrewClient({ baseUrl: endpoint, token: stranger }).requestStatus({ conversationId, requestId: submissions[0].requestId }), error => error instanceof CrewHttpError && error.status === 404);
          assert.equal(fixtures.evidence()[engine].requests, counters, "reconciliation cannot invoke provider");
          assert.ok(Number(await s.sql(`SELECT count(DISTINCT workflow_run_id) FROM birbcrew_ts.turns WHERE conversation_id='${conversationId}'`)) >= 2);
          const snapshot = await client.conversation({ conversationId });
          const runInput = { threadId: conversationId, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
          assert.ok(snapshot.cursor > 0);
          assert.equal((await rawRequest(`/v1/conversations/${conversationId}/events?after=0`, runInput)).status, 410);
          await observer.stop();
          assert.equal(fixtures.evidence()[engine].requests, counters, "observer disconnect does not execute work");
          // Every turn's segment has one ledger row, priced when written where the engine named a
          // priced model: Claude's fixture reports 10 and 10 tokens a call, so (10 × $3 + 10 × $15) per
          // million; Codex's 1000 input of which 400 cached and 50 output, with the model from its
          // rollout, so (600 × $1.25 + 400 × $0.125 + 50 × $10); Pi's provider reports nothing.
          const usage = await (await rawRequest(`/v1/usage/records?conversationId=${conversationId}`)).json();
          const metered = { claude: { state: "reported", model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 10, estimatedCostUsd: "0.00018" },
            codex: { state: "reported", model: "gpt-5.4", inputTokens: 1000, outputTokens: 50, estimatedCostUsd: "0.0013" },
            pi: { state: "unknown", model: "fixture-chat", inputTokens: null, outputTokens: null, estimatedCostUsd: null } }[engine];
          assert.deepEqual(usage.records.map((r: Record<string, unknown>) => ({ lane: r.lane, state: r.state, model: r.model,
            inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, estimatedCostUsd: r.estimatedCostUsd })),
          Array.from({ length: 6 }, () => ({ lane: "member", costUsd: null, ...metered })));
          console.log(`${engine}: v1 HTTP acceptance, six turns across rollover, gateway SIGKILL/restart, original results, official AG-UI observation, no-inference duplicate reconciliation and metered usage passed`);
        } finally { await observer.stop(); }
      }
      // Billed and estimated cost stay apart in the owner's totals: no provider billed these turns.
      const { total } = await (await rawRequest("/v1/usage")).json();
      assert.deepEqual([total.segments, total.costUsd, total.costReportedSegments, total.estimatedCostUsd, total.costEstimatedSegments],
        [18, null, 0, "0.00888", 12]);
      await stopWorker();
      stopWorker = await s.worker();
      await until(async () => {
        try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "3" || undefined; }
        catch { return undefined; }
      }, "approval worker registration");
      const { command } = commands(s);
      for (const engine of ["claude", "codex", "pi"] as Engine[]) {
        const member = await client.createMember({ requestId: randomUUID(), engine, profile: "fixture.approval.v1" });
        assert.ok((await client.listMembers()).members.some(item => item.memberId === member.memberId));
        const conversationId = randomUUID();
        await client.openConversation({ memberId: member.memberId, conversationId });
        const predecessor = randomUUID(), successor = randomUUID();
        await client.submit({ conversationId, requestId: predecessor, text: "record " + predecessor });
        await until(async () => pendingSchema.parse(await command("pending", { ownerId, conversationId }))[0], "pending protected request");
        // Reading and disconnecting the official observer cannot cancel the waiting operation.
        const observer = observe(conversationId);
        await until(async () => observer.seen.includes("STATE_SNAPSHOT") || undefined, "pending observation");
        await observer.stop();
        assert.equal(pendingSchema.parse(await command("pending", { ownerId, conversationId })).length, 1);
        await client.submit({ conversationId, requestId: successor, text: "remember never-run" });
        const receipt = await client.cancel({ conversationId, requestId: predecessor });
        assert.ok(receipt.cancellation!.receiptId);
        // Restart before delivery acknowledgement is relied on by the consumer.
        await stopGateway!(); await gateway();
        const repeated = await client.cancel({ conversationId, requestId: predecessor });
        assert.equal(repeated.cancellation!.receiptId, receipt.cancellation!.receiptId);
        await until(async () => {
          const value = await client.requestStatus({ conversationId, requestId: predecessor });
          return value.cancellation?.delivery === "delivered" ? value : undefined;
        }, "durable cancellation intent delivery after gateway restart");
        const rejected = await until(async () => {
          const value = await client.requestStatus({ conversationId, requestId: successor });
          return value.status === "cancelled" ? value : undefined;
        }, "queued request terminal cancellation receipt");
        assert.equal(rejected.reason, "predecessor_cancelled");
        assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${conversationId}'`), "0");
        assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id='${conversationId}' AND request_id='${successor}'`), "0");
        console.log(`${engine}: durable cancellation receipt, gateway restart/retry, queued successor terminal status and no effect passed`);
        const approvalConversation = randomUUID(), approvalRequest = randomUUID();
        await client.openConversation({ memberId: member.memberId, conversationId: approvalConversation });
        await client.submit({ conversationId: approvalConversation, requestId: approvalRequest, text: "record " + approvalRequest });
        const pending = await until(async () => pendingSchema.parse(await command("pending", { ownerId, conversationId: approvalConversation }))[0], "public decision card");
        const decision = { conversationId: approvalConversation, requestId: approvalRequest, memberId: member.memberId,
          invocationId: pending.invocationId, approvalId: pending.approvalId, version: pending.version, choice: "deny" as const };
        assert.deepEqual(await client.decide(decision), { approvalId: pending.approvalId, decision: "deny" });
        assert.deepEqual(await client.decide(decision), { approvalId: pending.approvalId, decision: "deny" });
        await until(async () => (await client.requestStatus({ conversationId: approvalConversation, requestId: approvalRequest })).status === "completed" || undefined,
          "public decision completion");
        assert.equal(await s.sql(`SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='${approvalConversation}'`), "0");
        console.log(`${engine}: installed client approval decision, duplicate receipt and denied effect passed`);
      }
    } finally { await stopGateway?.(); await stopWorker(); await stopTemporal(); }
  } finally { await fixtures.close(); }
} finally { await s.close(); }
console.log("Versioned integration API proof passed with actual service fixtures; no live inference.");
