import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import test from "node:test";
import { z } from "zod";
import { codexPinnedConfigArgs, codexToolContinuation, runCodexTurn, type CodexToolCall } from "../../../../src/service/codex.ts";
import { startProvider } from "./provider.mts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");

async function rolloutFile(home: string, nativeId: string) {
  const found: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 6) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`-${nativeId}.jsonl`)) found.push(path);
    }
  }
  await walk(join(home, "sessions"), 0);
  assert.equal(found.length, 1);
  return found[0]!;
}

test("Codex resumes the pinned rollout, rejects damaged or untrusted native storage before inference", { timeout: 40_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-ready-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prompts: string[] = [];
  const provider = await startProvider(undefined, (prompt) => { prompts.push(prompt); });
  t.after(provider.close);
  const profile = { ownerId: randomUUID(), memberId: randomUUID(), model: "gpt-5.4", baseUrl: provider.url, stateDir };
  const threadId = randomUUID(), fact = randomUUID();
  const seen: string[] = [], text: string[] = [];
  const input = { threadId, runId: randomUUID(), text: "remember " + fact, signal: t.signal, checkpoint: null,
    projectContext: "Fixture project context " + randomUUID(), onThreadStarted: (id: string) => { seen.push(id); }, onText: (s: string) => { text.push(s); } };
  const hold = { tool: "record_work_item" as const, answer() { throw new Error("remember or recall became a tool call"); } };
  const first = await runCodexTurn({ ...input, hold }, profile);
  const second = await runCodexTurn({ ...input, hold, runId: randomUUID(), text: "recall", checkpoint: first.checkpoint }, profile);
  assert.deepEqual(prompts, [input.text, "recall"]);
  assert.deepEqual(seen, [first.checkpoint.state.nativeId, first.checkpoint.state.nativeId]);
  assert.deepEqual(text, ["stored " + fact, "recalled " + fact]);
  assert.deepEqual([first.text, second.text], ["stored " + fact, "recalled " + fact]);
  for (const req of provider.requests) assert.ok(JSON.stringify(req).includes(input.projectContext));
  const home = join(stateDir, "codex", first.checkpoint.state.ownerDigest, profile.memberId, threadId, "home");
  const again = { ...input, runId: randomUUID(), text: "recall", checkpoint: second.checkpoint };
  await assert.rejects(runCodexTurn(input, profile));
  await assert.rejects(runCodexTurn({ ...again, threadId: randomUUID() }, profile));
  await writeFile(join(home, "config.toml"), '[mcp_servers.ambient]\nurl="http://127.0.0.1:1"\n');
  await assert.rejects(runCodexTurn(again, profile), /configuration/);
  await rm(join(home, "config.toml"));
  const history = await rolloutFile(home, second.checkpoint.state.nativeId);
  await truncate(history, 31);
  await assert.rejects(runCodexTurn(again, profile));
  await rm(home, { recursive: true });
  await assert.rejects(runCodexTurn(again, profile));
  assert.equal(provider.requests.length, 2);
});

const request = z.object({ tools: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })).default([]),
  input: z.array(z.looseObject({ type: z.string(), call_id: z.string().optional(), output: z.unknown().optional() })) });
function assistantText(res: ServerResponse, text: string) {
  const id = "msg_" + randomUUID();
  const item = { type: "message", id, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] };
  send(res, "response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
  send(res, "response.output_text.delta", { output_index: 0, item_id: id, content_index: 0, delta: text });
  send(res, "response.output_item.done", { output_index: 0, item });
}

function declinedAnswers(value: unknown): unknown {
  if (typeof value === "string") {
    try { return declinedAnswers(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== "object") return undefined;
  if ("answers" in value && value.answers && typeof value.answers === "object" && "q1" in value.answers) return value.answers;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = declinedAnswers(item);
    if (found) return found;
  }
  return undefined;
}

function send(res: ServerResponse, type: string, value: object) {
  res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...value }) + "\n\n");
}

function collectDeclared(value: unknown, found: unknown[]) {
  if (typeof value === "string") {
    try { collectDeclared(JSON.parse(value), found); } catch { return; }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDeclared(item, found);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "function_call" || record.type === "function_call_output") return;
  if (record.name === "record_work_item" || record.name === "application") found.push(record);
  for (const item of Object.values(record)) collectDeclared(item, found);
}

test("Codex uses per-turn subscription credentials for the same native thread without storing them", { timeout: 40_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-subscription-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const account = randomUUID(), tokens = [randomUUID(), randomUUID()], marker = randomUUID();
  const sessions: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/scoped/responses");
      assert.equal(req.headers.authorization, "Bearer " + tokens[sessions.length]);
      assert.equal(req.headers["chatgpt-account-id"], account);
      const session = req.headers["session-id"];
      assert.ok(typeof session === "string");
      assert.equal(req.headers["thread-id"], session);
      assert.equal(req.headers.originator, "switchboard-codex-host");
      assert.match(req.headers["user-agent"] ?? "", /^switchboard-codex-host\//);
      sessions.push(session);
      const children = (await readFile(`/proc/self/task/${process.pid}/children`, "utf8")).trim().split(/\s+/);
      assert.ok(children.length && children[0]);
      for (const child of children) {
        const args = await readFile(`/proc/${child}/cmdline`);
        assert.ok(tokens.every(token => !args.includes(token)), "Subscription credential exposed in native argv");
        for (let i = 0; i < codexPinnedConfigArgs.length; i += 2) {
          assert.ok(args.includes(codexPinnedConfigArgs[i + 1]), "Pinned Codex config missing from native argv");
        }
        assert.ok(tokens.every(token => !codexPinnedConfigArgs.some(arg => arg.includes(token))));
      }
      const body = z.object({
        store: z.literal(false), stream: z.literal(true), model: z.literal("gpt-5.4"), input: z.array(z.unknown()).min(1),
      }).parse(await json(req));
      assert.ok(JSON.stringify(body.input).includes(marker));
      assert.ok(JSON.stringify(body.input).includes("You are a BirbCrew coworker."));
      const id = "resp_" + randomUUID();
      res.writeHead(200, { "content-type": "text/event-stream" });
      send(res, "response.created", { response: { id } });
      assistantText(res, marker);
      send(res, "response.completed", { response: { id, usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2} } });
      res.end();
    } catch (error) { res.destroy(); t.diagnostic(error instanceof Error ? error.message : "Bad subscription request"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let tokenIndex = 0;
  const profile = { ownerId: randomUUID(), memberId: randomUUID(), stateDir, model: "gpt-5.4",
    baseUrl: "http://127.0.0.1:" + address.port + "/scoped", authorize: async () => {},
    subscription: async () => ({ accessToken: tokens[tokenIndex++], accountId: account }) };
  const input = { threadId: randomUUID(), runId: randomUUID(), text: "Remember " + marker, checkpoint: null, signal: t.signal };
  await assert.rejects(runCodexTurn(input, { ...profile, apiKey: "unrelated-key" }), /approved.*required/i);
  const first = await runCodexTurn(input, profile);
  const second = await runCodexTurn({ ...input, runId: randomUUID(), text: "Recall the marker", checkpoint: first.checkpoint }, profile);
  assert.equal(second.text, marker);
  assert.equal(first.checkpoint.state.nativeId, second.checkpoint.state.nativeId);
  assert.deepEqual(sessions, [first.checkpoint.state.nativeId, second.checkpoint.state.nativeId]);
  assert.equal(tokenIndex, 2);
  for (const file of await readdir(stateDir, {recursive: true, withFileTypes: true})) {
    if (!file.isFile()) continue;
    assert.notEqual(file.name, "auth.json");
    const contents = await readFile(join(file.parentPath, file.name));
    assert.ok(tokens.every(token => !contents.includes(token)), "Subscription credential persisted in " + file.name);
  }
});

test("actual Codex image reads are confined to the conversation on first invocation and resume", { timeout: 55_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-isolation-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const ownerId = randomUUID(), memberId = randomUUID(), threadId = randomUUID();
  const root = join(stateDir, "codex", createHash("sha256").update(ownerId).digest("hex"), memberId, threadId);
  const local = join(root, "workspace", "authorized.png");
  const sibling = join(stateDir, "codex", createHash("sha256").update(randomUUID()).digest("hex"), randomUUID(), randomUUID(), "workspace");
  await mkdir(sibling, { recursive: true });
  const foreign = join(sibling, "private.png");
  await writeFile(foreign, png);
  const ambient = "DO_NOT_FORWARD_" + randomUUID();
  const outputs: unknown[] = [];
  const surfaces: string[][] = [];
  const auth: (string | undefined)[] = [];
  let target = foreign, call = "call_" + randomUUID();
  const server = createServer(async (req, res) => {
    try {
      const parsed = request.parse(await json(req));
      auth.push(req.headers.authorization);
      assert.ok(!JSON.stringify(parsed).includes(ambient));
      const names = [...parsed.tools, ...parsed.input.filter((i) => i.type === "additional_tools").flatMap((i) =>
        z.array(z.looseObject({ name: z.string().optional(), type: z.string() })).parse(i.tools))].map((tool) => tool.name ?? tool.type).sort();
      surfaces.push(names);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = "resp_" + randomUUID();
      send(res, "response.created", { response: { id } });
      const result = parsed.input.find((item) => item.type === "function_call_output" && item.call_id === call);
      if (!result) {
        send(res, "response.output_item.done", { item: { type: "function_call", call_id: call, name: "view_image",
          arguments: JSON.stringify({ path: target }) } });
      } else {
        outputs.push(result.output);
        assistantText(res, "inspected");
      }
      send(res, "response.completed", { response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch { res.destroy(); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const profile = { ownerId, memberId, stateDir, model: "gpt-5.4", baseUrl: "http://127.0.0.1:" + addr.port };
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = ambient;
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  let checkpoint = null;
  for (const path of [foreign, local, foreign]) {
    target = path;
    call = "call_" + randomUUID();
    const response = await runCodexTurn({ threadId, runId: randomUUID(), text: "Inspect the assigned fixture image.",
      checkpoint, signal: t.signal, onThreadStarted: async () => { await writeFile(local, png); } }, profile);
    assert.equal(response.text, "inspected");
    checkpoint = response.checkpoint;
  }
  assert.ok(outputs.length === 3);
  assert.match(JSON.stringify(outputs[1]), /data:image\/png/);
  for (const output of [outputs[0], outputs[2]]) {
    assert.match(JSON.stringify(output), /denied/i);
    assert.doesNotMatch(JSON.stringify(output), /data:image/);
  }
  for (const names of surfaces) assert.deepEqual(names, ["request_user_input", "view_image"]);
  assert.ok(auth.every((header) => header === undefined));
});

for (const model of ["gpt-5.4", "gpt-6.1-sol"]) test(`${model} receives each host tool response on its original live call`, { timeout: 45_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-host-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const receipt = randomUUID(), denied = "denied-" + randomUUID();
  const calls: { id: string; thread: string }[] = [];
  let operation = randomUUID(), outcome: string = receipt, tool = "record_work_item";
  const captured: string[] = [], shapes: string[][] = [], schemas: string[] = [];
  let namespaces = 0, emitted = 0;
  const provider = createServer(async (req, res) => {
    try {
      const body = await json(req);
      const parsed = request.parse(body);
      const surface = JSON.stringify([parsed.tools, ...parsed.input.filter((row) => row.type === "additional_tools")]);
      assert.ok(!surface.includes("undeclared_private_tool"));
      const tools = [...parsed.tools, ...parsed.input.filter((row) => row.type === "additional_tools")
        .flatMap((row) => request.shape.tools.parse(row.tools))];
      const names = tools.map((item) => item.name ?? item.type);
      const application = tools.find((item) => item.name === "application");
      if (application) {
        namespaces++;
        const declared = z.object({ name: z.literal("application"), tools: z.array(z.looseObject({ name: z.string() })) }).parse(application);
        assert.deepEqual(declared.tools.map((item) => item.name), ["record_work_item"]);
      }
      const found: unknown[] = [];
      collectDeclared(body, found);
      if (found.length > 0) {
        const encoded = JSON.stringify(found);
        assert.equal(encoded.includes('"const"'), false);
        schemas.push(encoded);
      }
      shapes.push(names);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = "resp_" + randomUUID(), call_id = "call_" + operation;
      send(res, "response.created", { response: { id } });
      const result = parsed.input.find((item) => item.type === "function_call_output" && item.call_id === call_id);
      if (!result) {
        if (tool !== "record_work_item") emitted += 1;
        send(res, "response.output_item.done", { item: { type: "function_call", namespace: "application",
          name: tool, call_id, arguments: JSON.stringify({ operation_id: operation }) } });
      } else if (tool !== "record_work_item") {
        const encoded = JSON.stringify(result.output);
        assert.equal(encoded.includes(receipt), false);
        assert.equal(encoded.includes(denied), false);
        captured.push(encoded);
        assistantText(res, "undeclared-follow-up");
      } else {
        captured.push(JSON.stringify(result.output));
        assistantText(res, "settled");
      }
      send(res, "response.completed", { response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch (error) { res.destroy(); t.diagnostic(error instanceof Error ? error.message : "Bad host tool request"); }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => { provider.closeAllConnections(); return new Promise<void>((done) => provider.close(() => done())); });
  const addr = provider.address();
  assert.ok(addr && typeof addr === "object");
  const profile = { ownerId: randomUUID(), memberId: randomUUID(), stateDir, model, baseUrl: "http://127.0.0.1:" + addr.port };
  const threadId = randomUUID(), confirmation: string[] = [];
  let checkpoint = null;
  const hold = { tool: "record_work_item" as const, async answer(call: CodexToolCall) {
    calls.push({ id: call.pending.target.nativeToolCallId, thread: call.pending.target.session.opaque });
    assert.deepEqual(call.arguments, { operation_id: operation });
    return codexToolContinuation(call.pending.target, outcome, outcome === denied);
  } };
  for (const value of [receipt, denied]) {
    operation = randomUUID();
    outcome = value;
    const runId = value === receipt ? operation : randomUUID();
    if (value === denied) assert.notEqual(runId, operation);
    const r = await runCodexTurn({ threadId, runId, text: "record " + operation, checkpoint, signal: t.signal,
      hold, onToolDelivered: (_id, text) => { confirmation.push(text); } }, profile);
    checkpoint = r.checkpoint;
    assert.equal(r.text, "settled");
    assert.equal(calls.at(-1)?.thread, r.checkpoint.state.nativeId);
    assert.ok(captured.at(-1)?.includes(value));
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.thread, calls[1]!.thread);
  assert.deepEqual(confirmation, [receipt, denied]);
  assert.equal(shapes.length, 4);
  // gpt-5.4 puts the host namespace on the Responses tools list. gpt-6.1-sol keeps the
  // same declaration at thread start and omits that namespace from the model call.
  if (model === "gpt-5.4") {
    assert.ok(namespaces >= 1);
    assert.equal(schemas.length, namespaces);
  }
  assert.ok(schemas.length === 0 || new Set(schemas).size === 1);
  operation = randomUUID();
  tool = "undeclared_private_tool";
  const refused = await runCodexTurn({ threadId, runId: operation, text: "exercise the unlisted fixture tool",
    checkpoint, signal: t.signal, hold, onToolDelivered: (_id, text) => { confirmation.push(text); } }, profile);
  assert.equal(refused.text, "undeclared-follow-up");
  assert.equal(calls.length, 2);
  assert.deepEqual(confirmation, [receipt, denied]);
  assert.match(captured.at(-1) ?? "", /unsupported|unknown|not found|error|refused/i);
  assert.equal(emitted, 1);
});

test("request_user_input is declined when no person is attached", { timeout: 40_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-question-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const provider = createServer(async (req, res) => {
    try {
      const parsed = request.parse(await json(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = "resp_" + randomUUID();
      send(res, "response.created", { response: { id } });
      const answered = parsed.input.find((item) => item.type === "function_call_output");
      if (!answered) {
        send(res, "response.output_item.done", { item: { type: "function_call", id: "fc_question", call_id: "call_question",
          name: "request_user_input", status: "completed", arguments: JSON.stringify({ questions: [{ id: "q1", header: "Confirm",
            question: "Continue?", options: [{ label: "Yes", description: "Continue." }, { label: "No", description: "Stop." }] }] }) } });
      } else {
        assert.deepEqual(declinedAnswers(answered.output), { q1: { answers: ["No person is attached."] } });
        assistantText(res, "declined");
      }
      send(res, "response.completed", { response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch (error) { res.destroy(); t.diagnostic(error instanceof Error ? error.message : "Bad question request"); }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => { provider.closeAllConnections(); return new Promise<void>((done) => provider.close(() => done())); });
  const addr = provider.address();
  assert.ok(addr && typeof addr === "object");
  const result = await runCodexTurn({
    threadId: randomUUID(), runId: randomUUID(), text: "ask a person", checkpoint: null, signal: t.signal,
  }, { ownerId: randomUUID(), memberId: randomUUID(), stateDir, model: "gpt-5.4", baseUrl: "http://127.0.0.1:" + addr.port });
  assert.equal(result.text, "declined");
});

test("hard killing the host stops its Codex CLI and preserves unrelated conversations", { timeout: 30_000 }, async t => {
  const { spawn } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-death-"));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const provider = await startProvider();
  t.after(provider.close);
  const profile = { ownerId: randomUUID(), memberId: randomUUID(), model: "gpt-5.4", baseUrl: provider.url, stateDir };
  const threadId = randomUUID(), runId = randomUUID();
  const module = new URL("../../../../src/service/codex.ts", import.meta.url).href;
  const host = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runCodexTurn } from ${JSON.stringify(module)};
    const [threadId,runId,profile] = process.argv.slice(1);
    await runCodexTurn({threadId,runId,text:"wait",checkpoint:null,signal:new AbortController().signal}, JSON.parse(profile));
  `, threadId, runId, JSON.stringify(profile)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exit = once(host, "exit");
  t.after(async () => { if (host.exitCode === null && !host.signalCode) host.kill("SIGKILL"); await exit; });
  for (let i = 0; i < 100 && !provider.requests.length; i++) await delay(30);
  assert.equal(provider.requests.length, 1);
  const children = (await readFile(`/proc/${host.pid}/task/${host.pid}/children`, "utf8")).trim().split(/\s+/);
  assert.equal(children.length, 1);
  const cli = Number(children[0]);
  assert.ok(cli > 1);
  host.kill("SIGKILL");
  await exit;
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    try { gone = /\) [ZX] /.test(await readFile(`/proc/${cli}/stat`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; gone = true; }
    if (!gone) await delay(25);
  }
  assert.ok(gone);
  await assert.rejects(runCodexTurn({ threadId, runId, text: "wait", checkpoint: null, signal: t.signal }, profile));
  assert.equal(provider.requests.length, 1);
  const unrelated = await runCodexTurn({ threadId: randomUUID(), runId: randomUUID(), text: "remember safe",
    checkpoint: null, signal: t.signal }, { ...profile, memberId: randomUUID() });
  assert.equal(unrelated.text, "stored safe");
  assert.equal(provider.requests.length, 2);
});
