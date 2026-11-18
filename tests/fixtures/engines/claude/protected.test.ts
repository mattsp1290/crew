import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverClaudeProposal, runClaudeSegment } from "../../../../src/service/claude.ts";
import { startClaudeFixtureProvider } from "./index.mts";

for (const choice of ["recorded", "denied"] as const) {
  test(`Claude resumes a ${choice} host tool result in the original SDK session`, { timeout: 30_000 }, async (t) => {
    const requests: { tools: string[]; result?: { id?: string; error?: boolean; content: unknown } }[] = [];
    const provider = await startClaudeFixtureProvider(undefined, (request) => requests.push(request));
    t.after(() => provider.close());
    const stateDir = await mkdtemp(join(tmpdir(), "birb-protected-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const profile = { ownerId: "owner", memberId: randomUUID(), stateDir, model: "claude-sonnet-4-6",
      apiKey: "synthetic", baseUrl: provider.url };
    const request = randomUUID();
    const input = { threadId: randomUUID(), runId: request, text: "record " + request, checkpoint: null, signal: t.signal };
    await assert.rejects(recoverClaudeProposal(input, profile));
    const pending = await runClaudeSegment(input, profile);
    assert.equal(pending.kind, "pending");
    assert.equal(pending.proposal.name, "record_work_item");
    assert.deepEqual(pending.proposal.arguments, { operation_id: request, note: "private fixture note" });
    assert.equal(requests.length, 1);
    // Recovery rebuilds the same proposal without a model call, so it reports no usage.
    const { usage, ...proposal } = pending;
    assert.equal(usage?.state, "reported");
    assert.deepEqual(await recoverClaudeProposal(input, profile), proposal);
    await assert.rejects(recoverClaudeProposal({ ...input, runId: randomUUID() }, profile), /intent mismatch/);
    await assert.rejects(recoverClaudeProposal({ ...input, text: "other text" }, profile), /intent mismatch/);
    assert.equal(requests.length, 1);
    const nativeCallId = pending.proposal.nativeCallId;
    const receipt = { receiptId: randomUUID(), operationId: request };
    const result = choice === "recorded" ? { kind: choice, nativeCallId, receipt } : { kind: choice, nativeCallId };
    const resume = { ...input, checkpoint: pending.checkpoint, continuation: { nativeCallId, result } };
    await assert.rejects(runClaudeSegment({ ...resume, continuation: { nativeCallId: "other", result } }, profile));
    const changed = structuredClone(pending.checkpoint);
    if (!changed.state.binding.pending) assert.fail("Missing private pending binding");
    changed.state.binding.pending.input.note = "changed";
    await assert.rejects(runClaudeSegment({ ...resume, checkpoint: changed }, profile), /recovery failed/);
    assert.equal(requests.length, 1);
    const answer = await runClaudeSegment(resume, profile);
    assert.equal(answer.kind, "complete");
    assert.equal(answer.text, choice === "recorded" ? "recorded " + receipt.receiptId : choice);
    assert.equal(answer.checkpoint.state.binding.sessionId, pending.checkpoint.state.binding.sessionId);
    assert.equal(answer.checkpoint.state.binding.pending, undefined);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((r) => r.tools), Array(2).fill(["mcp__ag_ui__record_work_item"]));
    assert.equal(requests[1].result?.id, nativeCallId);
    assert.equal(Boolean(requests[1].result?.error), choice !== "recorded");
    await assert.rejects(runClaudeSegment(resume, profile));
    await assert.rejects(recoverClaudeProposal(input, profile));
    assert.equal(requests.length, 2);
  });
}

test("Claude rejects a native proposal naming a different input", async (t) => {
  const provider = await startClaudeFixtureProvider();
  t.after(() => provider.close());
  const stateDir = await mkdtemp(join(tmpdir(), "birb-wrong-op-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const profile = { ownerId: "owner", memberId: randomUUID(), stateDir, model: "claude-sonnet-4-6",
    apiKey: "synthetic", baseUrl: provider.url };
  await assert.rejects(runClaudeSegment({
    threadId: randomUUID(), runId: randomUUID(), text: "record " + randomUUID(), checkpoint: null, signal: t.signal,
  }, profile), /operation mismatch/);
});
