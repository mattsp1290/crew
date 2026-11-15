import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { run, until, type Engine, type Services } from "./member-services.mts";

async function optionalFile(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export async function verifyObserverProcesses(s: Services, engines: Engine[]) {
  const script = await realpath("clients/observe.mjs");
  const installed = await realpath(createRequire(script).resolve("@ag-ui/client"));
  assert.ok(installed.startsWith(resolve("clients/node_modules") + sep), "Run scripts/setup --mode fixture to install the independent client");
  const token = randomUUID(), owner = randomUUID();
  const configuration = join(s.directory, "observer-gateway.json"), clientConfig = join(s.directory, "observer-clients.json");
  await writeFile(configuration, JSON.stringify({ port: 0, tokenHashes: { [createHash("sha256").update(token).digest("hex")]: owner } }), { mode: 0o600 });
  const gateway = await s.gateway(configuration);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, s.signal]);
  const clients: { close: Promise<void>; abort: () => void }[] = [];
  let outcome: { kind: "passed" } | { kind: "failed"; error: unknown } = { kind: "passed" };
  try {
    const url = gateway.url;
    await writeFile(clientConfig, JSON.stringify({ url, tokens: { owner: token } }), { mode: 0o600 });
    async function api(path: string, body?: object) {
      const response = await fetch(url + path, { method: body ? "POST" : "GET", signal, headers: { authorization: "Bearer " + token,
        ...(body && { "content-type": "application/json" }) }, ...(body && { body: JSON.stringify(body) }) });
      assert.ok(response.ok, "Observer action returned " + response.status);
      return response.json();
    }
    async function attach(engine: Engine, id: string, label: string) {
      const output = join(s.directory, engine + "-observer-" + label + ".jsonl");
      const exit = run(process.execPath, [script, clientConfig, id, output], { env: { PATH: s.env.PATH, HOME: s.directory }, signal, timeout: 120_000 });
      void exit.catch(() => {});
      const close = new Promise<void>(resolve => exit.child.once("close", () => resolve()));
      clients.push({ close, abort: () => { exit.child.kill("SIGKILL"); } });
      await until(async () => {
        signal.throwIfAborted();
        return (await optionalFile(output)).includes('"type":"STATE_SNAPSHOT"') || undefined;
      }, "independent observer snapshot");
      return { output, exit };
    }
    for (const engine of engines) {
      const { memberId } = await api("/members", { engine, profile: "fixture.approval.v1", requestId: randomUUID() });
      const id = randomUUID(), path = "/conversations/" + id;
      await api("/conversations", { memberId, conversationId: id });
      // Each observe.mjs exits on RUN_FINISHED, which the gateway sends only when the conversation ends:
      // it is cancelled, or the input that uses its last turn completes. A new conversation has 128 turns
      // (docs/bounded-conversations.md), so pin this one to the four-turn budget migration 16 keeps for
      // older conversations; the fourth input below is then its last.
      assert.equal(await s.sql("WITH pinned AS (UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id='" + id +
        "' AND turn_limit=128 RETURNING 1) SELECT count(*) FROM pinned"), "1");
      const a = await attach(engine, id, "a");
      const prompts = ["remember " + randomUUID(), "recall", "remember " + randomUUID()];
      for (const [i, text] of prompts.entries()) {
        await api(path + "/inputs", { requestId: randomUUID(), text });
        await until(async () => Number(await s.sql("SELECT count(*) FROM birbcrew_ts.turns WHERE conversation_id='" + id + "' AND phase='committed'")) === i + 1 || undefined, "committed native input");
      }
      const requestId = randomUUID();
      await api(path + "/inputs", { requestId, text: "record " + requestId });
      const pending = await until(async () => (await api(path)).state.pendingApprovals[0], "owner decision to become actionable");
      const b = await attach(engine, id, "b");
      assert.equal(await s.sql("SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='" + id + "'"), "0");
      await api(path + "/human", { memberId, invocationId: pending.invocationId, approvalId: pending.approvalId,
        version: pending.version, requestId, choice: "approve" });
      await Promise.all([a.exit, b.exit]);
      const canonical = JSON.parse(await s.sql("SELECT messages FROM birbcrew_ts.public_snapshots WHERE conversation_id='" + id + "'"));
      assert.deepEqual((await api(path)).messages, canonical);
      assert.deepEqual(canonical.filter((message: { role: string }) => message.role === "user").map((m: { content: string }) => m.content), [...prompts, "record " + requestId]);
      for (const client of [a, b]) {
        const messages = JSON.parse(await readFile(client.output + ".messages.json", "utf8"));
        assert.deepEqual(messages, canonical);
        const raw = await readFile(client.output, "utf8");
        const frames = raw.trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(frames[0].type, "RUN_STARTED");
        assert.equal(frames.at(-1).type, "RUN_FINISHED");
        assert.equal(frames.filter((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === pending.approvalId).length, 1);
        assert.ok(!raw.includes("private fixture note") && !raw.includes(token));
      }
      const receipts = await s.sql("SELECT count(*) FROM birbcrew_ts.work_items WHERE conversation_id='" + id + "'");
      assert.equal(receipts, "1");
      console.log(engine + " independent CLI observer processes converged on the canonical SQL and gateway messages.");
    }
  } catch (error) { outcome = { kind: "failed", error }; }
  stop.abort();
  for (const client of clients) client.abort();
  let timer: NodeJS.Timeout | undefined;
  const closed = Promise.all(clients.map(client => client.close));
  const clientsStopped = Promise.race([closed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Independent observer clients did not exit after abort")), 3_000);
  })]).finally(() => clearTimeout(timer));
  const cleanup = await Promise.allSettled([gateway.stop(), clientsStopped]);
  const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
  if (outcome.kind === "failed") {
    for (const error of failures) console.error("Observer cleanup also failed", error);
    throw outcome.error;
  }
  if (failures.length) throw new AggregateError(failures, "Observer cleanup failed");
}
