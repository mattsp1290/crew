import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexPinnedConfigArgs, runCodexTurn } from "../../src/service/codex.ts";

test("Codex launcher config keeps plugins, apps, goals, and image generation off", () => {
  assert.deepEqual([...codexPinnedConfigArgs], [
    "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "features.goals=false",
    "-c", "features.image_generation=false", "-c", "features.code_mode=false",
    "-c", "analytics.enabled=false", "-c", "feedback.enabled=false",
    "-c", "web_search=\"disabled\"",
  ]);
});

test("a pre-switch Codex checkpoint closes before the host adapter opens", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "birb-codex-checkpoint-"));
  try {
    const checkpoint = { version: 1, engine: "codex", state: {
      rollout: "sessions/2026/11/19/rollout-2026-11-19T00-00-00-" + randomUUID() + ".jsonl",
      nativeId: randomUUID(), bytes: 128, sha256: "a".repeat(64), requestId: randomUUID(),
    } };
    await assert.rejects(runCodexTurn({
      threadId: randomUUID(), runId: randomUUID(), text: "hello", checkpoint, signal: AbortSignal.timeout(1000),
    }, {
      ownerId: "owner", memberId: randomUUID(), stateDir, model: "gpt-5.4", baseUrl: "http://127.0.0.1:9/",
    }), (error) => {
      assert.equal(error instanceof Error && error.message, "Codex checkpoint predates the host adapter");
      return true;
    });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
