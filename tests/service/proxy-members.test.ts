import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import test from "node:test";
import { z } from "zod";
import { configuredDestination } from "../../src/service/provider-identity.ts";
import { createProxyProfile, type ProxyProfileOptions } from "../../src/service/proxy-profiles.ts";
import { runClaudeSegment, runClaudeTurn } from "../../src/service/claude.ts";
import { runPiSegment, runPiTurn } from "../../src/service/pi.ts";
import { codexToolContinuation, runCodexTurn } from "../../src/service/codex.ts";
import type { Checkpoint } from "../../src/service/domain.ts";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";
import { startProvider } from "../fixtures/engines/codex/provider.mts";

// Deliberately narrow fixture: Messages, Responses and Chat Completions are
// separate routes. No translation, model discovery or real inference occurs.
async function proxyFixture(engine: "claude" | "codex" | "pi", model: string) {
  const native = engine === "claude" ? await startClaudeFixtureProvider() :
    engine === "codex" ? await startProvider() : undefined;
  const route = engine === "claude" ? "/v1/messages" : engine === "codex" ? "/responses" : "/chat/completions";
  const authorizations: string[] = [];
  let results = 0, failed = false, cancelled = 0, protocolFailure = false;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, route);
      assert.equal(req.headers["x-fixture-route"], engine);
      assert.equal(req.headers.authorization, "Bearer synthetic-" + (authorizations.length + 1));
      authorizations.push(String(req.headers.authorization));
      const body = z.looseObject({ model: z.string(), messages: z.unknown().optional() }).parse(await json(req));
      assert.equal(body.model, model);
      if (protocolFailure) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const payload = engine === "claude" ? { type: "error", error: { type: "api_error", message: "SYNTHETIC-DIAGNOSTIC-CANARY" } } :
          engine === "codex" ? { type: "error", code: "server_error", message: "SYNTHETIC-DIAGNOSTIC-CANARY" } :
            { error: { type: "server_error", message: "SYNTHETIC-DIAGNOSTIC-CANARY" } };
        res.end((engine === "pi" ? "" : "event: error\n") + "data: " + JSON.stringify(payload) + "\n\n");
        return;
      }
      // Each response outlives the credential used to submit it. A continuation
      // must obtain a new credential rather than reusing worker-start state.
      await new Promise(resolve => setTimeout(resolve, 650));
      res.on("close", () => { if (!res.writableEnded) cancelled++; });
      if (native) {
        const stop = new AbortController();
        res.on("close", () => stop.abort());
        const upstream = await fetch(native.url + route, { method: "POST", body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" }, signal: stop.signal });
        const serialized = JSON.stringify(body);
        if (serialized.includes('"tool_result"') || serialized.includes('"function_call_output"')) results++;
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        const reader = upstream.body!.getReader();
        while (true) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); }
        res.end();
        return;
      }
      const messages = z.array(z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))]).nullish() })).parse(body.messages)
        .map(m => ({ ...m, content: typeof m.content === "string" ? m.content : m.content?.map(p => p.text ?? "").join("") }));
      const prompt = messages.findLast(m => m.role === "user")?.content ?? "";
      const tool = messages.findLast(m => m.role === "tool");
      const call = prompt.startsWith("record ") && !tool;
      const remembered = messages.find(m => m.role === "user" && m.content?.startsWith("remember "))?.content?.slice(9);
      let text = prompt === "wait" ? "waiting" : prompt === "recall" ? "recalled " + remembered : "stored " + remembered;
      if (tool) { results++; text = "recorded " + JSON.parse(tool.content!).receipt.receiptId; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (delta: object, finish_reason: string | null = null) => res.write("data: " + JSON.stringify({
        id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + "\n\n");
      frame({ role: "assistant", ...(call ? { tool_calls: [{ index: 0, id: "call_" + prompt.slice(7), type: "function",
        function: { name: "record_work_item", arguments: JSON.stringify({ operation_id: prompt.slice(7), note: "fixture" }) } }] } : { content: text }) });
      if (prompt === "wait") return;
      frame({}, call ? "tool_calls" : "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) {
      if (!res.destroyed) { failed = true; res.destroy(); }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}${route}`, authorizations,
    stats: () => ({ results, failed, cancelled }),
    setProtocolFailure(value: boolean) { protocolFailure = value; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await native?.close(); } };
}

for (const engine of ["claude", "codex", "pi"] as const) {
  test(`${engine}: proxy signs every native request, preserves tools and cold profiles, and cancels streaming`, { timeout: 240_000 }, async t => {
    const model = engine === "claude" ? "claude-sonnet-4-6" : engine === "codex" ? "gpt-5.4" : "fixture-chat";
    const protocol = engine === "claude" ? "anthropic-messages" : engine === "codex" ? "openai-responses" : "openai-chat-completions";
    const fixture = await proxyFixture(engine, model);
    t.after(fixture.close);
    const stateDir = await mkdtemp(join(tmpdir(), "birb-proxy-native-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const identity = { stateDir, ownerId: "fixture-owner", memberId: randomUUID() };
    let credentials = 0;
    const create = async () => {
      const options: ProxyProfileOptions = { engine, model, protocol, endpoint: fixture.endpoint,
      accountId: "fixture-account", allowHttpLoopback: true, protectedTool: "record_work_item",
      headers: { "x-fixture-route": engine }, resolveCredential: async () => ({
        headers: { Authorization: "Bearer synthetic-" + (++credentials) }, expiresAt: Date.now() + 500,
      }) };
      const created = await createProxyProfile(options);
      const destination = configuredDestination(new Map([["proxy", created.profile]]), { engine, profile: "proxy" });
      assert.equal(destination.providerHost, new URL(fixture.endpoint).host);
      assert.equal(destination.model, model);
      options.endpoint = "https://changed.invalid";
      options.model = "changed-model";
      assert.deepEqual(configuredDestination(new Map([["proxy", created.profile]]), { engine, profile: "proxy" }), destination);
      assert.ok(Object.isFrozen(created.profile.upstreamIdentity?.[engine]));
      return created;
    };
    let active = await create();
    t.after(() => active.close());
    const input = { threadId: randomUUID(), runId: randomUUID(), text: "", checkpoint: null as Checkpoint | null, signal: t.signal };
    const streamed: string[] = [];
    const textTurn = (value: typeof input, onText = (delta: string) => { streamed.push(delta); }) => engine === "claude" ?
      runClaudeTurn({ ...value, onText }, { ...active.profile.claude!, ...identity }) : engine === "pi" ?
      runPiTurn({ ...value, onText }, active.profile.pi!) :
      runCodexTurn({ ...value, onText }, { ...active.profile.codex!, ...identity });
    // Fresh native thread remembers a value, then the entire proxy/profile is
    // replaced. The checkpoint is the only application-level continuation.
    const first = await textTurn({ ...input, text: "remember proxy-marker" });
    assert.equal(first.text, "stored proxy-marker");
    await active.close();
    active = await create();
    const second = await textTurn({ ...input, runId: randomUUID(), text: "recall", checkpoint: first.checkpoint as Checkpoint });
    assert.equal(second.text, "recalled proxy-marker");
    assert.ok(streamed.join("").includes("proxy-marker"));
    // A cold native restore on every turn, beyond the original four-turn proof.
    // This qualifies checkpoint continuity, not model context compaction.
    let checkpoint = second.checkpoint as Checkpoint;
    for (let turn = 3; turn <= 12; turn++) {
      const next = await textTurn({ ...input, runId: randomUUID(), text: "recall", checkpoint });
      assert.equal(next.text, "recalled proxy-marker", `${engine} restore turn ${turn}`);
      checkpoint = next.checkpoint as Checkpoint;
    }


    const operation = randomUUID(), receipt = randomUUID();
    const toolInput = { ...input, threadId: randomUUID(), runId: operation, text: "record " + operation };
    if (engine === "codex") {
      let called = 0;
      const result = await runCodexTurn({ ...toolInput, hold: { tool: "record_work_item", async answer(call) {
        assert.equal(z.object({ operation_id: z.string() }).parse(call.arguments).operation_id, operation);
        called++;
        return codexToolContinuation(call.pending.target, receipt, false);
      } } }, { ...active.profile.codex!, ...identity });
      assert.ok(result.text.includes(receipt));
      assert.equal(called, 1);
    } else {
      const proposed = engine === "claude" ? await runClaudeSegment(toolInput, { ...active.profile.claude!, ...identity }) :
        await runPiSegment(toolInput, active.profile.pi!);
      assert.equal(proposed.kind, "pending");
      if (proposed.kind !== "pending") throw new Error("Expected a fixture proposal");
      assert.equal(proposed.proposal.arguments.operation_id, operation);
      const nativeCallId = proposed.proposal.nativeCallId;
      const continuation = { nativeCallId, result: { kind: "recorded" as const, nativeCallId, receipt: { receiptId: receipt, operationId: operation } } };
      const resumed = { ...toolInput, checkpoint: proposed.checkpoint as Checkpoint, continuation };
      const result = engine === "claude" ? await runClaudeSegment(resumed, { ...active.profile.claude!, ...identity }) :
        await runPiSegment(resumed, active.profile.pi!);
      assert.equal(result.kind, "complete");
      if (result.kind === "complete") assert.equal(result.text, "recorded " + receipt);
    }
    assert.equal(fixture.stats().results, 1);
    assert.equal(credentials, fixture.authorizations.length);
    assert.ok(credentials >= 4);
    assert.equal(new Set(fixture.authorizations).size, credentials);
    assert.ok(!JSON.stringify([first.checkpoint, second.checkpoint]).includes("synthetic-"));
    fixture.setProtocolFailure(true);
    const diagnostics: string[] = [];
    await assert.rejects(textTurn({ ...input, threadId: randomUUID(), runId: randomUUID(), text: "fail" }, delta => diagnostics.push(delta)),
      error => { assert.doesNotMatch(String(error), /SYNTHETIC-DIAGNOSTIC-CANARY/); return true; });
    assert.doesNotMatch(JSON.stringify(diagnostics), /SYNTHETIC-DIAGNOSTIC-CANARY/);
    async function inspectNativeFiles(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await inspectNativeFiles(child);
        else if (entry.isFile()) assert.equal((await readFile(child)).includes(Buffer.from("SYNTHETIC-DIAGNOSTIC-CANARY")), false);
      }
    }
    await inspectNativeFiles(stateDir);
    fixture.setProtocolFailure(false);
    const stop = new AbortController();
    const waiting = textTurn({ ...input, threadId: randomUUID(), runId: randomUUID(), text: "wait", signal: stop.signal }, () => stop.abort());
    await assert.rejects(waiting, error => {
      assert.ok(stop.signal.aborted, `stream failed before cancellation: ${String(error)}`);
      return true;
    });
    for (let i = 0; i < 500 && !fixture.stats().cancelled; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fixture.stats().cancelled > 0);
    assert.equal(fixture.stats().failed, false);
  });
}
