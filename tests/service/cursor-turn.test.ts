import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { DriverInput } from "../../src/service/activities.ts";
import { runCursorTurn } from "../../src/service/cursor-turn.ts";
import type { Conversation } from "../../src/service/domain.ts";
import type { CursorProfile, CursorRuntimeHandle } from "../../src/service/profiles.ts";

const apiKey = "cursor-test-key";
const model = "composer-2";
const toolArguments = { command: "rm -rf SECRET_TOOL" };
const toolResult = "SECRET_TOOL_RESULT";

function member(state: { cwd: string }): { member: Conversation; input: (extra?: Partial<DriverInput>) => DriverInput; directory: (ownerId: string, memberId: string, conversationId: string) => string } {
  const conversation: Conversation = {
    ownerId: randomUUID(), memberId: randomUUID(), conversationId: randomUUID(), engine: "cursor", profile: "cursor.v1",
  };
  return {
    member: conversation,
    input: (extra = {}) => ({
      threadId: conversation.conversationId, runId: randomUUID(), text: "remember cedar", checkpoint: null,
      signal: new AbortController().signal, ...extra,
    }),
    directory: (ownerId, memberId, conversationId) => join(state.cwd, "cursor", createHash("sha256").update(ownerId).digest("hex"), memberId, conversationId),
  };
}

test("a cursor turn commits the last snapshot and publishes only the new suffix", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const published: string[] = [];
  let tools = 0;
  let closed = 0;
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime() {
      const handle: CursorRuntimeHandle = {
        async start({ onEvent }) {
          onEvent({ kind: "text", text: "cedar " });
          onEvent({ kind: "text", text: "cedar remembered" });
          onEvent({ kind: "ended", outcome: "completed" });
          return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
        },
        async close() { closed += 1; },
      };
      return handle;
    },
  };
  const result = await runCursorTurn({
    ...place.input(), onText: (delta) => { published.push(delta); }, onToolArgs: () => { tools += 1; },
  }, place.member, profile, stateDir);
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  assert.equal(result.text, "cedar remembered");
  assert.deepEqual(published, ["cedar ", "remembered"]);
  assert.equal(tools, 0);
  assert.equal("usage" in result, false);
  assert.equal("pending" in result, false);
  assert.deepEqual(result.checkpoint, {
    version: 1, engine: "cursor",
    state: { model, cwd: stateDir, agentId: "agent-1" },
  });
  await assert.rejects(access(place.directory(place.member.ownerId, place.member.memberId, place.member.conversationId)));
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(apiKey), false);
  assert.equal(encoded.includes("SECRET_TOOL"), false);
  assert.equal(encoded.includes(JSON.stringify(toolArguments)), false);
  assert.equal(encoded.includes(toolResult), false);
  assert.equal(closed, 1);
  await rm(stateDir, { recursive: true, force: true });
});

test("a cursor tool event or a snapshot that does not extend the previous one fails the turn", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const tool: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      async start({ onEvent }) {
        onEvent({ kind: "text", text: "cedar " });
        onEvent({ kind: "tool", callId: "call-1", name: "shell", status: "running" });
        onEvent({ kind: "ended", outcome: "completed" });
        return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
      },
      async close() {},
    }),
  };
  const toolError = await runCursorTurn(place.input(), place.member, tool, stateDir).then(() => undefined, (caught: unknown) => caught);
  assert.ok(toolError instanceof Error);
  assert.equal(toolError.message, "Text engine turn failed");
  assert.equal(String(toolError).includes("SECRET_TOOL"), false);
  await assert.rejects(access(place.directory(place.member.ownerId, place.member.memberId, place.member.conversationId)));
  const replaced: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      async start({ onEvent }) {
        onEvent({ kind: "text", text: "cedar " });
        onEvent({ kind: "text", text: "replaced" });
        onEvent({ kind: "ended", outcome: "completed" });
        return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
      },
      async close() {},
    }),
  };
  await assert.rejects(runCursorTurn(place.input(), place.member, replaced, stateDir), { message: "Text engine turn failed" });
  await rm(stateDir, { recursive: true, force: true });
});

test("a failed cursor outcome or an oversized snapshot is a failed turn", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const failed: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      async start({ onEvent }) {
        onEvent({ kind: "text", text: "no" });
        onEvent({ kind: "ended", outcome: "failed" });
        return { agentId: "agent-1", finished: Promise.resolve("failed"), async abort() {} };
      },
      async close() {},
    }),
  };
  await assert.rejects(runCursorTurn(place.input(), place.member, failed, stateDir), { message: "Text engine turn failed" });
  const huge: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      async start({ onEvent }) {
        onEvent({ kind: "text", text: "x".repeat(65_537) });
        onEvent({ kind: "ended", outcome: "completed" });
        return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
      },
      async close() {},
    }),
  };
  await assert.rejects(runCursorTurn(place.input(), place.member, huge, stateDir), { message: "Text engine turn failed" });
  await rm(stateDir, { recursive: true, force: true });
});

test("cursor refuses a checkpoint or project context before start", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  let starts = 0;
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      async start() { starts += 1; return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} }; },
      async close() {},
    }),
  };
  const checkpoint = { version: 1 as const, engine: "cursor" as const, state: {} };
  await assert.rejects(runCursorTurn(place.input({ checkpoint }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  await assert.rejects(runCursorTurn(place.input({ projectContext: "notes" }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  await assert.rejects(runCursorTurn(place.input({ childResults: [] }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  assert.equal(starts, 0);
  await rm(stateDir, { recursive: true, force: true });
});

test("a rejecting cursor close still removes the session directory and keeps a completed reply", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime() {
      return {
        async start({ onEvent }) {
          onEvent({ kind: "text", text: "cedar remembered" });
          onEvent({ kind: "ended", outcome: "completed" });
          return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
        },
        async close() { throw new Error("close failed"); },
      };
    },
  };
  const result = await runCursorTurn(place.input(), place.member, profile, stateDir);
  assert.equal(result.kind, "complete");
  if (result.kind === "complete") assert.equal(result.text, "cedar remembered");
  await assert.rejects(access(place.directory(place.member.ownerId, place.member.memberId, place.member.conversationId)));
  await rm(stateDir, { recursive: true, force: true });
});

test("abort during cursor close does not return the completed turn", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const controller = new AbortController();
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime() {
      return {
        async start({ onEvent }) {
          onEvent({ kind: "text", text: "cedar remembered" });
          onEvent({ kind: "ended", outcome: "completed" });
          return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
        },
        async close() { controller.abort(); },
      };
    },
  };
  await assert.rejects(runCursorTurn(place.input({ signal: controller.signal }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  await assert.rejects(access(place.directory(place.member.ownerId, place.member.memberId, place.member.conversationId)));
  await rm(stateDir, { recursive: true, force: true });
});

test("abort during a hanging cursor close removes the session directory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const controller = new AbortController();
  let releaseClose: () => void = () => undefined;
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime() {
      return {
        async start({ onEvent }) {
          onEvent({ kind: "text", text: "cedar remembered" });
          onEvent({ kind: "ended", outcome: "completed" });
          return { agentId: "agent-1", finished: Promise.resolve("completed"), async abort() {} };
        },
        close() {
          controller.abort();
          return new Promise<void>((resolve) => { releaseClose = resolve; });
        },
      };
    },
  };
  await assert.rejects(runCursorTurn(place.input({ signal: controller.signal }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  await assert.rejects(access(place.directory(place.member.ownerId, place.member.memberId, place.member.conversationId)));
  releaseClose();
  await rm(stateDir, { recursive: true, force: true });
});

test("abort before cursor start resolves closes the runtime and aborts a late start", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const controller = new AbortController();
  let closed = 0;
  let aborted = 0;
  let release: (value: Awaited<ReturnType<CursorRuntimeHandle["start"]>>) => void = () => undefined;
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      start() {
        controller.abort();
        return new Promise((resolve) => { release = resolve; });
      },
      async close() { closed += 1; },
    }),
  };
  await assert.rejects(runCursorTurn(place.input({ signal: controller.signal }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  assert.equal(closed, 1);
  assert.equal(aborted, 0);
  release({ agentId: "agent-1", finished: Promise.resolve("completed"), async abort() { aborted += 1; } });
  await delay(0);
  assert.equal(aborted, 1);
  await rm(stateDir, { recursive: true, force: true });
});

test("abort after cursor start resolves aborts the turn", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cursor-turn-"));
  const place = member({ cwd: stateDir });
  const controller = new AbortController();
  let aborted = 0;
  const profile: CursorProfile = {
    model, apiKey, cwd: stateDir,
    runtime: () => ({
      async start() {
        let finish: (value: string) => void = () => undefined;
        const finished = new Promise<string>((resolve) => { finish = resolve; });
        queueMicrotask(() => controller.abort());
        return {
          agentId: "agent-1", finished,
          async abort() { aborted += 1; finish("interrupted"); },
        };
      },
      async close() {},
    }),
  };
  await assert.rejects(runCursorTurn(place.input({ signal: controller.signal }), place.member, profile, stateDir), { message: "Text engine turn failed" });
  assert.equal(aborted, 1);
  await rm(stateDir, { recursive: true, force: true });
});
