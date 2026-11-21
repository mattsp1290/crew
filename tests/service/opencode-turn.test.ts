import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { DriverInput } from "../../src/service/activities.ts";
import { runOpenCodeTurn } from "../../src/service/opencode-turn.ts";
import type { Conversation } from "../../src/service/domain.ts";
import type { OpenCodeProfile, OpenCodeSpawnRequest, OpenCodeSpawned } from "../../src/service/profiles.ts";

const model = "provider/model-id";
const peer = fileURLToPath(new URL("./opencode-acp-peer.mjs", import.meta.url));
const secretDatabase = "postgres://text-engine-secret";

function conversation(): Conversation {
  return { ownerId: randomUUID(), memberId: randomUUID(), conversationId: randomUUID(), engine: "opencode", profile: "opencode.v1" };
}
function input(conversationId: string, extra: Partial<DriverInput> = {}): DriverInput {
  return { threadId: conversationId, runId: randomUUID(), text: "remember cedar", checkpoint: null, signal: AbortSignal.timeout(20_000), ...extra };
}

function session(deltas = ["cedar ", "remembered"], onClose?: () => void) {
  const requests: OpenCodeSpawnRequest[] = [];
  const state = { requests: [] as { method?: string; id?: number; params?: { value?: string } }[] };
  let sink: { (chunk: Uint8Array): void; ended(): void } | undefined;
  let resolveExit: (value: unknown) => void = () => undefined;
  const processExit = new Promise((resolve) => { resolveExit = resolve; });
  function push(value: unknown) {
    sink?.(Buffer.from(JSON.stringify(value) + "\n"));
  }
  function respond(message: { method?: string; id?: number; params?: { value?: string } }) {
    state.requests.push(message);
    if (message.method === "initialize") push({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    else if (message.method === "session/new") {
      push({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1", configOptions: [
        { id: "model", type: "select", currentValue: "default", options: [] }] } });
    } else if (message.method === "session/set_config_option") {
      push({ jsonrpc: "2.0", id: message.id, result: { configOptions: [{ id: "model", currentValue: message.params?.value }] } });
    } else if (message.method === "session/prompt") {
      for (const text of deltas) {
        push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
          sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text },
        } } });
      }
      push({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: {} } });
    } else if (message.method === "session/close") {
      onClose?.();
      push({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
  const spawned: OpenCodeSpawned = {
    processExit,
    channel: {
      listen(next) { sink = next; return () => {}; },
      write(frame) {
        const text = Buffer.from(frame).toString("utf8");
        for (const line of text.split("\n")) if (line) respond(JSON.parse(line));
        return Promise.resolve();
      },
      endInput() { sink?.ended(); resolveExit(undefined); },
    },
  };
  return { requests, spawned, spawn(request: OpenCodeSpawnRequest): OpenCodeSpawned { requests.push(request); return spawned; } };
}

test("an injected opencode spawn commits both text deltas and receives only the profile environment", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "opencode-turn-")));
  const executable = join(cwd, "opencode");
  const previous = process.env.BIRBCREW_DATABASE_URL;
  process.env.BIRBCREW_DATABASE_URL = secretDatabase;
  const agent = session();
  const published: string[] = [];
  const profile: OpenCodeProfile = {
    model, executable, cwd, account: "ACCOUNT LABEL", env: { OPENCODE_TOKEN: "kept" }, spawn: (request) => agent.spawn(request),
  };
  const member = conversation();
  try {
    const result = await runOpenCodeTurn({ ...input(member.conversationId), onText(delta) { published.push(delta); } }, member, profile, cwd);
    assert.equal(result.kind, "complete");
    if (result.kind !== "complete") return;
    assert.equal(result.text, "cedar remembered");
    assert.deepEqual(published, ["cedar ", "remembered"]);
    assert.equal("usage" in result, false);
    assert.equal("pending" in result, false);
    assert.deepEqual(agent.requests.map((request) => request.args), [[executable, "acp"]]);
    assert.equal(agent.requests[0].cwd, cwd);
    assert.deepEqual(agent.requests[0].env, { OPENCODE_TOKEN: "kept" });
    assert.equal(Object.hasOwn(agent.requests[0].env, "BIRBCREW_DATABASE_URL"), false);
    assert.equal(JSON.stringify(result.checkpoint).includes("kept"), false);
    assert.equal(JSON.stringify(result.checkpoint).includes(secretDatabase), false);
    const state = (result.checkpoint as { state: { session: { kind: string; opaque: string; binding: { account: string } } } }).state;
    assert.equal(state.session.kind, "session");
    assert.equal(state.session.opaque, "session-1");
    assert.equal(state.session.binding.account, "ACCOUNT LABEL");
  } finally {
    if (previous === undefined) delete process.env.BIRBCREW_DATABASE_URL;
    else process.env.BIRBCREW_DATABASE_URL = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("abort during opencode close does not return the completed turn", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "opencode-turn-")));
  const controller = new AbortController();
  const agent = session(["cedar ", "remembered"], () => controller.abort());
  const executable = join(cwd, "opencode");
  const profile: OpenCodeProfile = {
    model, executable, cwd, account: "ACCOUNT LABEL", env: { OPENCODE_TOKEN: "kept" }, spawn: (request) => agent.spawn(request),
  };
  const member = conversation();
  await assert.rejects(runOpenCodeTurn(input(member.conversationId, { signal: controller.signal }), member, profile, cwd), { message: "Text engine turn failed" });
  const root = join(cwd, "opencode", createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
  await assert.rejects(access(root));
  await rm(cwd, { recursive: true, force: true });
});

test("opencode refuses a slash prompt, a checkpoint, or project context before spawn", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "opencode-turn-")));
  let spawned = 0;
  const profile: OpenCodeProfile = {
    model, executable: join(cwd, "opencode"), cwd, account: "ACCOUNT LABEL", env: {},
    spawn: () => { spawned += 1; throw new Error("spawned"); },
  };
  const member = conversation();
  await assert.rejects(runOpenCodeTurn(input(member.conversationId, { text: "/remember cedar" }), member, profile, cwd), { message: "Text engine turn failed" });
  await assert.rejects(runOpenCodeTurn(input(member.conversationId, { text: "remember\n/cedar" }), member, profile, cwd), { message: "Text engine turn failed" });
  await assert.rejects(runOpenCodeTurn(input(member.conversationId, { checkpoint: { version: 1, engine: "opencode", state: {} } }), member, profile, cwd),
    { message: "Text engine turn failed" });
  await assert.rejects(runOpenCodeTurn(input(member.conversationId, { projectContext: "notes" }), member, profile, cwd), { message: "Text engine turn failed" });
  await assert.rejects(runOpenCodeTurn(input(member.conversationId, { childResults: [] }), member, profile, cwd), { message: "Text engine turn failed" });
  assert.equal(spawned, 0);
  await rm(cwd, { recursive: true, force: true });
});

test("the default opencode spawn speaks ACP with the profile environment", { timeout: 60_000 }, async (t) => {
  const executable = await realpath(peer);
  await chmod(executable, 0o755);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "opencode-peer-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previous = process.env.BIRBCREW_DATABASE_URL;
  process.env.BIRBCREW_DATABASE_URL = secretDatabase;
  t.after(() => {
    if (previous === undefined) delete process.env.BIRBCREW_DATABASE_URL;
    else process.env.BIRBCREW_DATABASE_URL = previous;
  });
  const member = conversation();
  const pidFile = join(cwd, "pids");
  const profile = (mode: string): OpenCodeProfile => ({
    model, executable, cwd, account: "ACCOUNT LABEL",
    env: { PATH: process.env.PATH ?? "", OPENCODE_PEER_MODE: mode, OPENCODE_TOKEN: "kept", OPENCODE_PEER_PID_FILE: pidFile },
  });
  async function assertLastExited() {
    const pid = Number((await readFile(pidFile, "utf8")).trim().split("\n").at(-1));
    assert.ok(pid > 0);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
        throw error;
      }
      await delay(25);
    }
    assert.fail(`peer ${pid} still running`);
  }
  const completed = await runOpenCodeTurn(input(member.conversationId), member, profile("complete"), cwd);
  assert.equal(completed.kind, "complete");
  if (completed.kind !== "complete") return;
  assert.equal(completed.text, "cedar remembered");
  assert.equal(JSON.stringify(completed).includes(secretDatabase), false);
  assert.equal(JSON.stringify(completed).includes("kept"), false);
  assert.equal(JSON.stringify(completed.checkpoint).includes(executable), true);
  await assertLastExited();
  const home = join(cwd, "opencode", createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
  await assert.rejects(access(home));

  const helper = conversation();
  const helped = await runOpenCodeTurn(input(helper.conversationId), helper, profile("grandchild"), cwd);
  assert.equal(helped.kind, "complete");
  await assertLastExited();
  const helperHome = join(cwd, "opencode", createHash("sha256").update(helper.ownerId).digest("hex"), helper.memberId, helper.conversationId);
  await assert.rejects(access(helperHome));

  const lingering = await runOpenCodeTurn(input(member.conversationId), member, profile("linger"), cwd);
  assert.equal(lingering.kind, "complete");
  if (lingering.kind !== "complete") return;
  assert.equal(lingering.text, "cedar remembered");
  await assertLastExited();

  for (const mode of ["tool", "permission", "fs-read", "fs-write", "terminal"]) {
    const error = await runOpenCodeTurn(input(member.conversationId), member, profile(mode), cwd).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Text engine turn failed");
    const encoded = String(error);
    assert.equal(encoded.includes(executable), false);
    assert.equal(encoded.includes("SECRET_TOOL"), false);
    assert.equal(encoded.includes("/secret/file"), false);
    assert.equal(encoded.includes("secret-command"), false);
    assert.equal("pending" in error, false);
    await assertLastExited();
  }
});
