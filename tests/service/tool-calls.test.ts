import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { ApprovalStore } from "../../src/service/approvals.ts";
import { ownerInitiator } from "../../src/service/domain.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import { InstallationRecovery, readRecoveryManifest, type RecoveryHooks, type RecoveryPins } from "../../src/service/recovery.ts";
import { FileRecoveryFence } from "../../src/service/recovery-fence.ts";
import { MemberStore } from "../../src/service/store.ts";
import { argumentDigest, catalogLimits, classify, type Classified } from "../../src/service/tool-catalog.ts";
import { toolCallKey, toolCallLimits, ToolCallStore, verifyStored, type ToolCallKey, type Verdict } from "../../src/service/tool-calls.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const shared = new Pool({ connectionString: url });
before(() => new MemberStore(shared).migrate());
after(() => shared.end());

const allowed: Verdict = { verdict: "allow", by: "default" }, asked: Verdict = { verdict: "ask", by: "default" };
const reading = classify({ tool: "fs_read", arguments: { path: "src/a.ts" } });
const writing = classify({ tool: "fs_write", arguments: { path: "src/a.ts", content: "new" } });
const running = classify({ tool: "shell_run", arguments: { command: "npm test" } });

/** The stores of one database, and what the tests need to reach a ledger row. */
function fixture(pool: Pool) {
  const store = new MemberStore(pool), approvals = new ApprovalStore(pool), ledger = new ToolCallStore(pool);
  /** A started turn in a new conversation, of a new member unless one is given. */
  async function turn(ownerId = "owner-" + randomUUID(), member?: string) {
    const memberId = member ?? (await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "tool-calls-fixture" })).memberId;
    const conversationId = randomUUID(), requestId = randomUUID(), text = "use tools " + requestId;
    await store.openConversation({ ownerId, memberId, conversationId });
    await store.recordAcceptance({ ownerId, conversationId, requestId, text }, ownerInitiator);
    const start = await store.beginTurn({ ownerId, conversationId, requestId, text });
    assert.equal(start.kind, "start"); if (start.kind !== "start") throw new Error("unreachable");
    let calls = 0;
    const scope = { ownerId, memberId, conversationId, requestId };
    return { ...scope, token: start.token, key: (): ToolCallKey => ({ ...scope, invocationId: requestId, nativeCallId: "call-" + calls++ }) };
  }
  /** A member-wide standing grant, made the only way one can be: by answering a real card. */
  async function grant(ownerId: string, memberId: string): Promise<string> {
    const card = await turn(ownerId, memberId);
    const ids = { ownerId, memberId, conversationId: card.conversationId, requestId: card.requestId, invocationId: card.requestId, nativeCallId: "card" };
    const approval = await approvals.propose({ ...ids, token: card.token, toolName: "record_work_item", arguments: { operation_id: card.requestId } });
    await approvals.decide({ ...ids, approvalId: approval.approvalId, argumentDigest: approval.argumentDigest, version: approval.version, choice: "allow_always" });
    return (await pool.query("SELECT grant_id FROM birbcrew_ts.tool_grants WHERE approval_id=$1", [approval.approvalId])).rows[0].grant_id;
  }
  const row = async (key: ToolCallKey) => (await pool.query(`SELECT * FROM birbcrew_ts.tool_calls WHERE conversation_id=$1 AND request_id=$2
    AND invocation_id=$3 AND native_call_id=$4`, [key.conversationId, key.requestId, key.invocationId, key.nativeCallId])).rows[0];
  return { pool, store, ledger, turn, grant, row };
}
const { pool, ledger, turn, grant, row } = fixture(shared);
const phases = async (keys: ToolCallKey[]) => Promise.all(keys.map(async key => { const call = await ledger.get(key); return call.phase + (call.delivered ? "+delivered" : ""); }));

test("a decided call is recorded once, in the phase its verdict gives it; a retry reads it back", async () => {
  const t = await turn();
  const grantId = await grant(t.ownerId, t.memberId);
  const cases: [Classified, Verdict, string][] = [
    [reading, allowed, "ready"], [writing, asked, "waiting"], [reading, asked, "waiting"], [running, { verdict: "allow", by: "grant", grantId }, "ready"],
    [reading, { verdict: "allow", by: "grant", grantId }, "ready"],
    [writing, { verdict: "deny", by: "capability" }, "refused"], [running, { verdict: "deny", by: "budget" }, "refused"],
    [reading, { verdict: "deny", by: "credential_scan" }, "refused"],
  ];
  const laterVerdicts: Verdict[] = [allowed, asked, { verdict: "deny", by: "budget" }];
  for (const [call, verdict, phase] of cases) {
    const key = t.key();
    const first = await ledger.record(key, call, verdict);
    assert.deepEqual(first, { ...key, callId: first.callId, toolName: call.tool, catalogVersion: 1, kind: call.kind, scope: call.scope,
      arguments: call.arguments, argumentDigest: call.argumentDigest, verdict, phase, delivered: false });
    assert.deepEqual(await ledger.record(key, call, verdict), first, "a retry returns the stored call");
    assert.deepEqual(await ledger.get(key), first);
    // The first verdict stands: a retry that would now decide otherwise still reads it back.
    for (const later of laterVerdicts) {
      if (later.verdict === "allow" && call.kind === "effect") continue;
      assert.deepEqual(await ledger.record(key, call, later), first);
    }
    // The same identity cannot name another call.
    const different = call.tool === "fs_read" ? classify({ tool: "fs_read", arguments: { path: "src/b.ts" } }) : reading;
    await assert.rejects(ledger.record(key, different, verdict.verdict === "allow" && verdict.by === "default" ? verdict : asked), { code: "conflict" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM birbcrew_ts.tool_calls WHERE call_id=$1", [first.callId])).rows[0].n, 1);
  }
  const edit = classify({ tool: "fs_edit", arguments: { path: "src/a.ts", oldText: "a", newText: "b" }, priorSha256: "c".repeat(64) });
  assert.equal((await ledger.record(t.key(), edit, asked)).priorSha256, "c".repeat(64));

  // Nothing allows an effect by default, in the store or in the table.
  for (const effect of [writing, running]) await assert.rejects(ledger.record(t.key(), effect, allowed), { code: "conflict" });
  const direct = (columns: Record<string, unknown>) => {
    const values = { owner_id: t.ownerId, member_id: t.memberId, conversation_id: t.conversationId, request_id: t.requestId, invocation_id: t.requestId,
      native_call_id: randomUUID(), tool_name: "fs_write", catalog_version: 1, kind: "effect", scope: "{}", arguments: "{}", argument_digest: "0".repeat(64),
      verdict: "ask", decided_by: "default", phase: "waiting", ...columns };
    const names = Object.keys(values);
    return pool.query(`INSERT INTO birbcrew_ts.tool_calls (${names.join(",")}) VALUES (${names.map((_, i) => "$" + (i + 1)).join(",")})`, Object.values(values));
  };
  await direct({});
  for (const illegal of [
    { verdict: "allow", decided_by: "default", phase: "ready" }, { verdict: "allow", decided_by: "owner", phase: "ready" },
    { verdict: "allow", decided_by: "grant", phase: "ready" }, { verdict: "ask", decided_by: "grant", grant_id: grantId },
    { verdict: "deny", decided_by: "default", phase: "refused" }, { verdict: "deny", decided_by: "policy", phase: "refused" },
    { verdict: "ask", decided_by: "capability" }, { verdict: "maybe" }, { kind: "write" }, { tool_name: "Fs_Write" }, { tool_name: "" },
    { argument_digest: "xyz" }, { prior_sha256: "xyz" }, { scope: "[]" }, { arguments: "[]" }, { arguments: "null" }, { native_call_id: "" },
    { native_call_id: "x".repeat(257) }, { catalog_version: 0 },
    // A call starts where its verdict puts it, never further on.
    { phase: "ready" }, { phase: "admitted", execution_id: randomUUID(), admitted_at: new Date() }, { phase: "refused" },
    { verdict: "allow", decided_by: "grant", grant_id: grantId, phase: "admitted", execution_id: randomUUID(), admitted_at: new Date() },
    { verdict: "allow", decided_by: "grant", grant_id: grantId, phase: "completed", execution_id: randomUUID(), admitted_at: new Date(), finished_at: new Date(), result: "{}" },
    { verdict: "allow", decided_by: "grant", grant_id: grantId, phase: "waiting" }, { verdict: "deny", decided_by: "budget", phase: "waiting" },
    { delivered: true, delivered_at: new Date() }, { verdict: "deny", decided_by: "budget", phase: "refused", delivered: true, delivered_at: new Date() },
  ]) await assert.rejects(direct(illegal), { code: "23514" }, JSON.stringify(illegal));

  // A call that is not the one its digest pins, or belongs to no turn, is not recorded.
  await assert.rejects(ledger.record(t.key(), { ...writing, arguments: { ...writing.arguments, content: "other" } }, asked), { code: "conflict" });
  await assert.rejects(ledger.record(t.key(), { ...reading, argumentDigest: writing.argumentDigest }, allowed), { code: "conflict" });
  // The digest does not cover the kind or the scope, so the ledger classifies the call itself: a
  // write that claims to be a read, or to touch another path, is refused whatever its verdict.
  const granted: Verdict = { verdict: "allow", by: "grant", grantId };
  for (const claimed of [{ ...writing, kind: "read" }, { ...running, kind: "read" }, { ...writing, scope: { kind: "path", path: "docs/allowed" } },
    { ...running, scope: { kind: "command", cwd: "", argv: ["ls"] } }, { ...reading, kind: "effect" }, { ...writing, catalogVersion: 2 },
    { ...writing, tool: "fs_read" }, { ...writing, tool: "fs_delete" }, { ...edit, priorSha256: "d".repeat(64) }, { ...edit, priorSha256: undefined },
  ] as unknown as Classified[]) {
    for (const verdict of [allowed, asked, granted, { verdict: "deny", by: "budget" }] as Verdict[]) {
      await assert.rejects(ledger.record(t.key(), claimed, verdict), { code: "conflict" }, JSON.stringify([claimed.tool, claimed.kind, verdict]));
    }
  }
  // What is stored is the catalog's reading, and extra fields on the caller's object go nowhere.
  const extra = t.key();
  await ledger.record(extra, { ...writing, preview: { summary: "Read a file", text: "harmless", truncated: false }, selector: { kind: "tool" } }, asked);
  assert.deepEqual([(await row(extra)).kind, (await row(extra)).scope, verifyStored(await ledger.get(extra))], ["effect", writing.scope, writing]);
  await assert.rejects(ledger.record({ ...t.key(), requestId: randomUUID() }, reading, allowed), { code: "not_found" });
  for (const invalid of [{ ...t.key(), nativeCallId: "" }, { ...t.key(), nativeCallId: "x".repeat(257) }, { ...t.key(), invocationId: "not-a-uuid" }, { ...t.key(), extra: 1 }]) {
    await assert.rejects(ledger.record(invalid as ToolCallKey, reading, allowed), z.ZodError);
  }
  for (const invalid of [{ verdict: "allow" }, { verdict: "allow", by: "owner" }, { verdict: "allow", by: "grant" }, { verdict: "ask", by: "grant", grantId },
    { verdict: "deny", by: "default" }, { verdict: "deny", by: "policy" }, "allow", null]) {
    await assert.rejects(ledger.record(t.key(), reading, invalid as Verdict), z.ZodError, JSON.stringify(invalid));
  }
});

test("a ready call is admitted by one execution, finished by it alone, then delivered; each step repeats harmlessly", async () => {
  const t = await turn();
  const grantId = await grant(t.ownerId, t.memberId);
  const granted: Verdict = { verdict: "allow", by: "grant", grantId };
  const key = t.key(), execution = randomUUID(), other = randomUUID();
  const ready = await ledger.record(key, running, granted);
  // Nothing finishes or delivers a call that has not started.
  await assert.rejects(ledger.complete(key, execution, { exitCode: 0 }), { code: "stale" });
  await assert.rejects(ledger.fail(key, execution, "timeout"), { code: "stale" });
  await assert.rejects(ledger.deliver(key), { code: "conflict" });

  const admitted = await ledger.admit(key, execution);
  assert.deepEqual(admitted, { run: true, call: { ...ready, phase: "admitted", executionId: execution } });
  assert.deepEqual(await ledger.admit(key, execution), admitted, "the same execution asking again may still run");
  // Another execution may not run an effect that is already held: it may have happened.
  assert.deepEqual(await ledger.admit(key, other), { run: false, call: admitted.call });
  await assert.rejects(ledger.complete(key, other, { exitCode: 0 }), { code: "stale" });
  await assert.rejects(ledger.fail(key, other, "timeout"), { code: "stale" });
  await assert.rejects(ledger.deliver(key), { code: "conflict" });

  const result = { exitCode: 0, stdout: "ok\n", truncated: false };
  const completed = await ledger.complete(key, execution, result);
  assert.deepEqual(completed, { ...ready, phase: "completed", result, delivered: false });
  assert.deepEqual(await ledger.complete(key, execution, { truncated: false, stdout: "ok\n", exitCode: 0 }), completed, "the same result again reads it back");
  await assert.rejects(ledger.complete(key, execution, { exitCode: 1 }), { code: "conflict" });
  await assert.rejects(ledger.fail(key, execution, "timeout"), { code: "conflict" });
  await assert.rejects(ledger.complete(key, other, result), { code: "stale" });
  assert.deepEqual(await ledger.admit(key, execution), { run: false, call: completed }, "a finished call is not run again");

  const delivered = await ledger.deliver(key);
  assert.deepEqual(delivered, { ...completed, delivered: true });
  assert.deepEqual(await ledger.deliver(key), delivered);
  assert.deepEqual(await ledger.complete(key, execution, result), delivered);
  const stamps = await row(key);
  assert.ok(stamps.decided_at <= stamps.admitted_at && stamps.admitted_at <= stamps.finished_at && stamps.finished_at <= stamps.delivered_at);

  // A call that did not complete: the same code again reads back, another does not.
  const failing = t.key();
  await ledger.record(failing, reading, allowed);
  await ledger.admit(failing, execution);
  const failed = await ledger.fail(failing, execution, "timeout");
  assert.deepEqual([failed.phase, failed.phase === "failed" && failed.failure, failed.delivered], ["failed", "timeout", false]);
  assert.deepEqual(await ledger.fail(failing, execution, "timeout"), failed);
  await assert.rejects(ledger.fail(failing, execution, "not_found"), { code: "conflict" });
  await assert.rejects(ledger.complete(failing, execution, {}), { code: "conflict" });
  assert.equal((await ledger.deliver(failing)).delivered, true);

  // An ask and a refusal never run. The refusal is an outcome and is delivered; the ask is not.
  const waiting = t.key(), refused = t.key();
  await ledger.record(waiting, writing, asked);
  await ledger.record(refused, writing, { verdict: "deny", by: "capability" });
  for (const stuck of [waiting, refused]) {
    assert.equal((await ledger.admit(stuck, execution)).run, false);
    await assert.rejects(ledger.complete(stuck, execution, {}), { code: "stale" });
  }
  await assert.rejects(ledger.deliver(waiting), { code: "conflict" });
  assert.deepEqual(await phases([waiting, refused]), ["waiting", "refused"]);
  assert.equal((await ledger.deliver(refused)).delivered, true);

  // A result is a bounded JSON object and a failure a short code.
  const bounded = t.key();
  await ledger.record(bounded, reading, allowed);
  await ledger.admit(bounded, execution);
  await assert.rejects(ledger.complete(bounded, execution, { content: "x".repeat(toolCallLimits.resultBytes) }), { code: "input_limit" });
  for (const invalid of [null, "text", 7, [1], undefined, { at: new Date() }, { n: Number.NaN }]) await assert.rejects(ledger.complete(bounded, execution, invalid), z.ZodError);
  // Text PostgreSQL cannot store is refused before it is sent, in a value or a key at any depth.
  for (const unstorable of [{ content: "before \0 after" }, { content: "lone \ud800 surrogate" }, { lines: ["ok", "bad\0"] }, { nested: { "key\0": 1 } },
    { nested: [{ deep: "\udc00" }] }]) await assert.rejects(ledger.complete(bounded, execution, unstorable), z.ZodError);
  // A result that is small as canonical JSON and large as PostgreSQL prints it is over the limit
  // too, and the refusal carries nothing of the row: no result text, no arguments.
  const secret = "PRIVATE-" + randomUUID();
  await assert.rejects(ledger.complete(bounded, execution, { secret, numbers: Array.from({ length: 600 }, () => 1e300) }), (error: unknown) => {
    assert.deepEqual([(error as { code: string }).code, (error as Error).name], ["input_limit", "MemberStoreError"]);
    assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error as object)).includes(secret), false);
    return true;
  });
  // A result nested too deep, or one that holds itself, is over the limit: nothing recurses into it.
  const nested = (depth: number) => { let value: Record<string, unknown> = {}; for (let level = 0; level < depth; level++) value = { inner: value }; return value; };
  const loop: Record<string, unknown> = { name: "loop" }, twice: Record<string, unknown> = {};
  loop.self = loop; twice.left = twice; twice.right = twice;
  for (const endless of [nested(toolCallLimits.resultDepth + 1), nested(20_000), loop, twice, { rows: Array.from({ length: toolCallLimits.resultBytes }, () => 1) }]) {
    await assert.rejects(ledger.complete(bounded, execution, endless), { code: "input_limit", name: "MemberStoreError" });
  }
  // A sparse array is as long as it says, whatever it holds: its empty slots count toward the
  // limit, so one of fifty million is refused at once and nothing loops over them.
  const began = performance.now();
  for (const sparse of [{ rows: new Array(toolCallLimits.resultBytes) }, { rows: new Array(50_000_000) }, { deep: [[new Array(toolCallLimits.resultBytes)]] }]) {
    await assert.rejects(ledger.complete(bounded, execution, sparse), { code: "input_limit", name: "MemberStoreError" });
  }
  assert.ok(performance.now() - began < 2_000, "refused without visiting the slots");
  // A short one is within the limit and is still not JSON: a slot that holds nothing is not a value.
  await assert.rejects(ledger.complete(bounded, execution, { rows: new Array(3) }), z.ZodError);
  assert.deepEqual(await phases([bounded]), ["admitted"], "a refused result leaves the call where it was");
  const deepest = t.key();
  await ledger.record(deepest, reading, allowed);
  await ledger.admit(deepest, execution);
  const atDepth = await ledger.complete(deepest, execution, nested(toolCallLimits.resultDepth));
  assert.deepEqual([atDepth.phase, atDepth.phase === "completed" && atDepth.result], ["completed", nested(toolCallLimits.resultDepth)], "a result nested exactly to the limit is stored");
  for (const invalid of ["", "Timeout", "not found", "x".repeat(65), "rm -rf /"]) await assert.rejects(ledger.fail(bounded, execution, invalid), z.ZodError);
  await assert.rejects(ledger.admit(bounded, "not-a-uuid"), z.ZodError);
  const largest = { content: "x".repeat(toolCallLimits.resultBytes - 14) };
  const kept = await ledger.complete(bounded, execution, largest);
  assert.deepEqual([kept.phase, kept.phase === "completed" && kept.result], ["completed", largest], "a result of exactly the limit is stored");
});

test("after a worker is lost: an outcome is delivered, a read is run again, and an admitted effect is uncertain and never run again", async () => {
  const t = await turn();
  const granted: Verdict = { verdict: "allow", by: "grant", grantId: await grant(t.ownerId, t.memberId) };
  const lost = randomUUID(), next = randomUUID();

  // Completed and not delivered: deliver what is stored.
  const finished = t.key();
  await ledger.record(finished, writing, granted);
  await ledger.admit(finished, lost);
  const stored = await ledger.complete(finished, lost, { bytes: 3 });
  assert.deepEqual(await ledger.classifyLost(finished), { action: "deliver", call: stored });
  assert.deepEqual(await ledger.classifyLost(finished), { action: "deliver", call: stored }, "asking again changes nothing");
  await ledger.deliver(finished);
  assert.deepEqual(await ledger.classifyLost(finished), { action: "done", call: { ...stored, delivered: true } });
  // A record names its own call: the next operation takes its key, and a whole record is not a key.
  assert.deepEqual(toolCallKey(stored), finished);
  assert.deepEqual(await ledger.deliver(toolCallKey(stored)), { ...stored, delivered: true });
  await assert.rejects(ledger.deliver(stored as unknown as ToolCallKey), z.ZodError);

  // An admitted read: run it again. The lost execution can no longer finish it.
  const read = t.key();
  await ledger.record(read, reading, allowed);
  const held = (await ledger.admit(read, lost)).call;
  for (let i = 0; i < 2; i++) assert.deepEqual(await ledger.classifyLost(read), { action: "rerun", call: held });
  const firstAdmitted = (await row(read)).admitted_at;
  const again = await ledger.admit(read, next);
  assert.deepEqual(again, { run: true, call: { ...held, executionId: next } });
  assert.deepEqual((await row(read)).admitted_at, firstAdmitted, "a call keeps the time it was first admitted");
  await assert.rejects(ledger.complete(read, lost, { content: "stale" }), { code: "stale" });
  await assert.rejects(ledger.fail(read, lost, "timeout"), { code: "stale" });
  const reread = await ledger.complete(read, next, { content: "fresh" });
  assert.deepEqual(await ledger.classifyLost(read), { action: "deliver", call: reread });

  // An admitted effect: uncertain, delivered as such, and nothing can run or finish it.
  for (const effect of [writing, running]) {
    const key = t.key();
    const ready = await ledger.record(key, effect, granted);
    await ledger.admit(key, lost);
    const uncertain = { ...ready, phase: "uncertain" as const, reason: "worker_lost" as const };
    assert.deepEqual(await ledger.classifyLost(key), { action: "deliver", call: uncertain });
    assert.deepEqual(await ledger.classifyLost(key), { action: "deliver", call: uncertain });
    for (const execution of [lost, next]) {
      assert.deepEqual(await ledger.admit(key, execution), { run: false, call: uncertain });
      // Even the execution that held it: if it was still running, its outcome is not recorded.
      await assert.rejects(ledger.complete(key, execution, { exitCode: 0 }), { code: "stale" });
      await assert.rejects(ledger.fail(key, execution, "timeout"), { code: "stale" });
    }
    assert.deepEqual(await ledger.get(key), uncertain);
    await ledger.deliver(key);
    assert.deepEqual(await ledger.classifyLost(key), { action: "done", call: { ...uncertain, delivered: true } });
  }

  // Not started, waiting for an answer, refused and failed.
  const [ready, waiting, refused, failed] = [t.key(), t.key(), t.key(), t.key()];
  await ledger.record(ready, running, granted);
  await ledger.record(waiting, running, asked);
  await ledger.record(refused, running, { verdict: "deny", by: "budget" });
  await ledger.record(failed, reading, allowed);
  await ledger.admit(failed, lost);
  await ledger.fail(failed, lost, "timeout");
  assert.deepEqual((await Promise.all([ready, waiting, refused, failed].map(key => ledger.classifyLost(key)))).map(found => [found.action, found.call.phase]),
    [["start", "ready"], ["wait", "waiting"], ["deliver", "refused"], ["deliver", "failed"]]);
  // An effect that was only ready was never run, so it may start.
  assert.equal((await ledger.admit(ready, next)).run, true);
});

test("one owner never reads or changes another owner's calls", async () => {
  const mine = await turn(), theirs = await turn();
  const key = mine.key(), execution = randomUUID();
  await ledger.record(key, reading, allowed);
  const sibling = await turn(mine.ownerId);
  for (const stranger of [
    { ...key, ownerId: theirs.ownerId }, { ...key, ownerId: theirs.ownerId, memberId: theirs.memberId }, { ...key, memberId: theirs.memberId },
    // Another member of the same owner is not the conversation's member either.
    { ...key, memberId: sibling.memberId },
  ]) {
    for (const attempt of [() => ledger.get(stranger), () => ledger.record(stranger, reading, allowed), () => ledger.record({ ...stranger, nativeCallId: "new" }, reading, allowed),
      () => ledger.admit(stranger, execution), () => ledger.complete(stranger, execution, {}), () => ledger.fail(stranger, execution, "timeout"),
      () => ledger.classifyLost(stranger), () => ledger.deliver(stranger)]) {
      await assert.rejects(attempt(), { code: "not_found" });
    }
  }
  // Their own conversation does not hold my call either.
  await assert.rejects(ledger.get({ ...theirs.key(), nativeCallId: key.nativeCallId }), { code: "not_found" });
  assert.deepEqual(await phases([key]), ["ready"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM birbcrew_ts.tool_calls WHERE owner_id=$1", [theirs.ownerId])).rows[0].n, 0);

  // The table refuses a row bound to another owner's conversation, or to a grant that is not this member's.
  const insert = (ownerId: string, memberId: string, conversationId: string, requestId: string, grantId: string | null = null) => pool.query(
    `INSERT INTO birbcrew_ts.tool_calls (owner_id,member_id,conversation_id,request_id,invocation_id,native_call_id,tool_name,catalog_version,kind,scope,
       arguments,argument_digest,verdict,decided_by,grant_id,phase) VALUES ($1,$2,$3,$4,$4,$5,'shell_run',1,'effect','{}','{}',$6,$7,$8,$9,$10)`,
    [ownerId, memberId, conversationId, requestId, randomUUID(), "0".repeat(64), grantId ? "allow" : "ask", grantId ? "grant" : "default", grantId, grantId ? "ready" : "waiting"]);
  await assert.rejects(insert(theirs.ownerId, theirs.memberId, mine.conversationId, mine.requestId), { code: "23503", message: /another owner or member/ });
  await assert.rejects(insert(mine.ownerId, sibling.memberId, mine.conversationId, mine.requestId), { code: "23503" });
  await assert.rejects(insert(mine.ownerId, mine.memberId, mine.conversationId, randomUUID()), { code: "23503" }, "no such turn");
  const theirGrant = await grant(theirs.ownerId, theirs.memberId), siblingGrant = await grant(mine.ownerId, sibling.memberId);
  for (const foreign of [theirGrant, siblingGrant]) {
    await assert.rejects(insert(mine.ownerId, mine.memberId, mine.conversationId, mine.requestId, foreign), { code: "23503", message: /grant/ });
    await assert.rejects(ledger.record(mine.key(), running, { verdict: "allow", by: "grant", grantId: foreign }), { code: "conflict" });
  }
  await insert(mine.ownerId, mine.memberId, mine.conversationId, mine.requestId, await grant(mine.ownerId, mine.memberId));
});

test("the database refuses every change that is not a legal step, whoever makes it", async () => {
  const t = await turn();
  const granted: Verdict = { verdict: "allow", by: "grant", grantId: await grant(t.ownerId, t.memberId) };
  const execution = randomUUID();
  const at = async (phase: string, call: Classified = running) => {
    const key = t.key();
    await ledger.record(key, call, phase === "waiting" ? asked : phase === "refused" ? { verdict: "deny", by: "capability" } : call.kind === "read" ? allowed : granted);
    if (["admitted", "completed", "failed", "uncertain", "delivered"].includes(phase)) await ledger.admit(key, execution);
    if (phase === "completed" || phase === "delivered") await ledger.complete(key, execution, { ok: true });
    if (phase === "failed") await ledger.fail(key, execution, "timeout");
    if (phase === "uncertain") await ledger.classifyLost(key);
    if (phase === "delivered") await ledger.deliver(key);
    return (await row(key)).call_id as string;
  };
  const update = (callId: string, set: string, ...values: unknown[]) => pool.query(`UPDATE birbcrew_ts.tool_calls SET ${set} WHERE call_id=$1`, [callId, ...values]);
  const admit = "phase='admitted', execution_id=gen_random_uuid(), admitted_at=clock_timestamp()";
  const complete = "phase='completed', result='{}', finished_at=clock_timestamp()", fail = "phase='failed', failure='timeout', finished_at=clock_timestamp()";
  const lose = "phase='uncertain', uncertain_reason='worker_lost', finished_at=clock_timestamp()";
  const deliver = "delivered=true, delivered_at=clock_timestamp()";
  for (const [from, set] of [
    // Skipping admission, going back, or leaving an outcome.
    ["ready", complete], ["ready", fail], ["ready", lose], ["ready", "phase='waiting'"], ["ready", "phase='refused'"], ["ready", deliver],
    ["ready", complete + ", execution_id=gen_random_uuid(), admitted_at=clock_timestamp()"],
    ["waiting", "phase='ready'"], ["waiting", admit], ["waiting", complete], ["waiting", "phase='refused'"], ["waiting", deliver],
    ["refused", "phase='ready'"], ["refused", admit], ["refused", "phase='waiting'"],
    ["admitted", "phase='ready', execution_id=NULL, admitted_at=NULL"], ["admitted", "phase='waiting'"], ["admitted", "phase='refused'"], ["admitted", deliver],
    ["admitted", complete + ", " + deliver], ["admitted", complete + ", execution_id=gen_random_uuid()"], ["admitted", complete + ", admitted_at=clock_timestamp()"],
    ["admitted", "execution_id=gen_random_uuid()"], ["admitted", "admitted_at=clock_timestamp()"],
    ["completed", admit], ["completed", fail + ", result=NULL"], ["completed", lose + ", result=NULL"], ["completed", "phase='ready', result=NULL, finished_at=NULL, execution_id=NULL, admitted_at=NULL"],
    ["completed", "result='{\"other\":1}'"], ["completed", "finished_at=clock_timestamp()"], ["completed", deliver + ", result='{\"other\":1}'"],
    ["failed", complete + ", failure=NULL"], ["failed", "failure='other'"], ["failed", admit + ", failure=NULL, finished_at=NULL"],
    ["uncertain", complete + ", uncertain_reason=NULL"], ["uncertain", admit + ", uncertain_reason=NULL, finished_at=NULL"],
    ["uncertain", "phase='ready', uncertain_reason=NULL, finished_at=NULL, execution_id=NULL, admitted_at=NULL"], ["uncertain", "uncertain_reason='recovery_restore'"],
    // A delivered call is closed.
    ["delivered", "delivered=false, delivered_at=NULL"], ["delivered", "delivered_at=clock_timestamp()"], ["delivered", "result='{\"other\":1}'"],
    ["delivered", fail + ", result=NULL"],
    // What was asked and what was decided never change.
    ...["ready", "waiting", "admitted", "completed"].flatMap(from => ["arguments='{\"command\":\"rm -rf /\"}'", "argument_digest=repeat('0',64)", "scope='{}'",
      "tool_name='fs_read'", "kind='read'", "catalog_version=2", "verdict='deny', decided_by='budget'", "decided_by='budget'", "grant_id=gen_random_uuid()",
      "native_call_id='other'", "invocation_id=gen_random_uuid()", "owner_id='someone else'", "decided_at=clock_timestamp()", "call_id=gen_random_uuid()",
      "prior_sha256=repeat('a',64)"].map(set => [from, set])),
  ]) await assert.rejects(update(await at(from), set), { code: "23514" }, `${from}: ${set}`);

  // A read is never uncertain, and only a read can be taken over.
  const read = await at("admitted", reading);
  await assert.rejects(update(read, lose), { code: "23514", constraint: "tool_calls_uncertain_check" });
  await update(read, "execution_id=gen_random_uuid()");
  await assert.rejects(update(await at("ready", reading), "phase='uncertain', uncertain_reason='recovery_restore', finished_at=clock_timestamp()"), { code: "23514" });
  // Only a restore settles an effect that never started.
  await assert.rejects(update(await at("ready"), lose), { code: "23514", message: /cannot move from ready to uncertain/ });
  await update(await at("ready"), "phase='uncertain', uncertain_reason='recovery_restore', finished_at=clock_timestamp()");
  await assert.rejects(update(await at("ready"), "phase='uncertain', uncertain_reason='recovery_restore', finished_at=clock_timestamp(), execution_id=gen_random_uuid(), admitted_at=clock_timestamp()"),
    { code: "23514" });
  // The legal steps, written directly, are accepted.
  const legal = await at("ready");
  await update(legal, admit);
  await update(legal, complete);
  await update(legal, deliver);

  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.tool_calls WHERE call_id=$1", [legal]), { code: "23514", message: /kept/ });
  await assert.rejects(pool.query("TRUNCATE birbcrew_ts.tool_calls"), { code: "23514", message: /kept/ });
  assert.equal((await pool.query("SELECT 1 FROM pg_trigger WHERE tgrelid='birbcrew_ts.tool_calls'::regclass AND tgname='recovery_write_barrier' AND tgenabled='O'")).rowCount, 1);
});

test("a request records at most 256 calls, and arguments at the catalog's limits are stored and verified", async () => {
  const t = await turn(), other = await turn(t.ownerId, t.memberId);
  const keys = Array.from({ length: toolCallLimits.perRequest }, () => t.key());
  for (const key of keys) await ledger.record(key, reading, allowed);
  await assert.rejects(ledger.record(t.key(), reading, allowed), { code: "input_limit" });
  assert.deepEqual(await ledger.record(keys[0], reading, allowed), await ledger.get(keys[0]), "a retry of a recorded call is not a new call");
  assert.equal((await ledger.record(other.key(), reading, allowed)).phase, "ready", "another request has its own count");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM birbcrew_ts.tool_calls WHERE request_id=$1", [t.requestId])).rows[0].n, 256);
  // Two calls racing for the last place: the count is serialized, so one of them is refused.
  const racing = await turn(t.ownerId, t.memberId);
  await pool.query(`INSERT INTO birbcrew_ts.tool_calls (owner_id,member_id,conversation_id,request_id,invocation_id,native_call_id,tool_name,catalog_version,kind,scope,
      arguments,argument_digest,verdict,decided_by,phase) SELECT $1,$2,$3,$4,$4,'seed-'||n,'fs_read',1,'read','{}','{}',$5,'allow','default','ready' FROM generate_series(1,255) n`,
    [racing.ownerId, racing.memberId, racing.conversationId, racing.requestId, "0".repeat(64)]);
  const last = (name: string) => pool.query(`INSERT INTO birbcrew_ts.tool_calls (owner_id,member_id,conversation_id,request_id,invocation_id,native_call_id,tool_name,
      catalog_version,kind,scope,arguments,argument_digest,verdict,decided_by,phase) VALUES ($1,$2,$3,$4,$4,$5,'fs_read',1,'read','{}','{}',$6,'allow','default','ready')`,
    [racing.ownerId, racing.memberId, racing.conversationId, racing.requestId, name, "0".repeat(64)]);
  const outcomes = await Promise.allSettled([last("a"), last("b")]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult).reason.constraint, "tool_calls_request_limit");

  // The largest call the catalog accepts, with the content that takes the most room as JSON.
  const big = classify({ tool: "fs_write", arguments: { path: "big.bin", content: "\u0001".repeat(catalogLimits.contentBytes) } });
  const stored = await ledger.record(other.key(), big, asked);
  assert.equal(stored.argumentDigest, big.argumentDigest);
  assert.deepEqual(verifyStored(stored).arguments, big.arguments);
  // A call the catalog would not accept is not recorded, however consistent its digest is.
  const oversized = { ...big, arguments: { path: "big.bin", content: "x".repeat(catalogLimits.contentBytes + 1) } } as unknown as Classified;
  await assert.rejects(ledger.record(other.key(), { ...oversized, argumentDigest: argumentDigest(oversized) }, asked), { code: "conflict" });
  // The table has its own bound on what a row may hold.
  await assert.rejects(pool.query(`INSERT INTO birbcrew_ts.tool_calls (owner_id,member_id,conversation_id,request_id,invocation_id,native_call_id,tool_name,
      catalog_version,kind,scope,arguments,argument_digest,verdict,decided_by,phase) VALUES ($1,$2,$3,$4,$4,'huge','fs_write',1,'effect','{}',$5,$6,'ask','default','waiting')`,
    [other.ownerId, other.memberId, other.conversationId, other.requestId, JSON.stringify({ content: "x".repeat(4_200_000) }), "0".repeat(64)]),
    { code: "23514", constraint: "tool_calls_arguments_check" });
});

test("a stored call verifies only as the call that was decided", async () => {
  const t = await turn();
  for (const call of [reading, writing, running, classify({ tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" }, priorSha256: "d".repeat(64) }),
    classify({ tool: "web_fetch", arguments: { url: "HTTPS://Example.com:443/a?b#c", method: "POST", body: "x" } }), classify({ tool: "fs_list", arguments: {} }),
    classify({ tool: "web_search", arguments: { query: "x" } }), classify({ tool: "shell_run", arguments: { command: "a | b", cwd: "./x/" } })]) {
    const key = t.key();
    const stored = await ledger.record(key, call, asked);
    const verified = verifyStored(await ledger.get(key));
    assert.deepEqual(verified, call, "what comes out of the ledger classifies to exactly what went in");
    // Anything that would make it another call does not verify.
    await assert.rejects(async () => verifyStored({ ...stored, argumentDigest: "0".repeat(64) }), { code: "conflict" });
    await assert.rejects(async () => verifyStored({ ...stored, catalogVersion: 2 }), { code: "conflict" });
    await assert.rejects(async () => verifyStored({ ...stored, kind: stored.kind === "read" ? "effect" : "read" }), { code: "conflict" });
    await assert.rejects(async () => verifyStored({ ...stored, toolName: "fs_delete" }), { name: "ToolArgumentError" });
  }
  const written = await ledger.record(t.key(), writing, asked);
  await assert.rejects(async () => verifyStored({ ...written, arguments: { path: "src/a.ts", content: "tampered" } }), { code: "conflict" });
  await assert.rejects(async () => verifyStored({ ...written, toolName: "fs_read" }), { name: "ToolArgumentError" });
  const edited = await ledger.record(t.key(), classify({ tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" }, priorSha256: "d".repeat(64) }), asked);
  await assert.rejects(async () => verifyStored({ ...edited, priorSha256: "e".repeat(64) }), { code: "conflict" }, "the file changed since the edit was decided");
});

const sql = new URL("../../src/service/sql/", import.meta.url);
/** A separate database migrated only up to `version`; dropped after the test. */
async function databaseAt(t: TestContext, version: number) {
  const source = new URL(url!);
  const admin = new Pool({ connectionString: source.href });
  const database = "tool_calls_" + randomUUID().replaceAll("-", "");
  await admin.query("CREATE DATABASE " + database);
  source.pathname = "/" + database;
  const separate = new Pool({ connectionString: source.href });
  t.after(async () => {
    try {
      await separate.end();
      await admin.query(`DROP DATABASE ${database}`);
    } finally { await admin.end(); }
  });
  await separate.query("CREATE SCHEMA birbcrew_ts");
  await separate.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version) continue;
    await separate.query(await readFile(new URL(file, sql), "utf8"));
    await separate.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return separate;
}

test("migration 41 adds the ledger to a v40 database without touching a table or waiting for a native turn", async (t) => {
  const upgraded = await databaseAt(t, 40);
  const current = new MemberStore(upgraded);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  const { memberId } = await current.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "tool-calls-fixture" });
  await current.openConversation({ ownerId, memberId, conversationId });
  const request = { ownerId, conversationId, requestId: randomUUID(), text: "running at upgrade" };
  await current.recordAcceptance(request, ownerInitiator);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn(request, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, request.requestId, start.token, execution.workflowRunId, execution.activityId]);

  // Only the three referenced tables are locked, and in a mode a native turn's reads allow.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    await db.query(await readFile(new URL("041-tool-calls.sql", sql), "utf8"));
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace AND c.relname<>'tool_calls' ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "members", mode: "AccessShareLock" }, { relation: "members", mode: "ShareRowExclusiveLock" },
      { relation: "tool_grants", mode: "AccessShareLock" }, { relation: "tool_grants", mode: "ShareRowExclusiveLock" },
      { relation: "turns", mode: "AccessShareLock" }, { relation: "turns", mode: "ShareRowExclusiveLock" },
    ]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  await withNativeAdmission(upgraded, { ...request, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([current.migrate().then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 41 must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId: request.requestId, token: start.token }, request.requestId + "/assistant", 0, "still running");
  });
  // The turn that was running at the upgrade can record a call.
  const key = { ownerId, memberId, conversationId, requestId: request.requestId, invocationId: request.requestId, nativeCallId: "after-upgrade" };
  assert.equal((await new ToolCallStore(upgraded).record(key, reading, allowed)).phase, "ready");
  assert.deepEqual((await upgraded.query("SELECT event_type FROM birbcrew_ts.audit_events WHERE owner_id=$1 ORDER BY event_id", [ownerId])).rows.map(event => event.event_type),
    ["member.spawned", "conversation.opened", "request.accepted"], "the ledger writes no audit row in this slice");
});

const pins: RecoveryPins = { applicationCommit: "a".repeat(40), lockfileSha256: "b".repeat(64),
  temporal: { mode: "development-fixture", serverVersion: "1.10.0", persistenceFormat: "dev-sqlite-fixture" }, logicalNativeRoot: "/var/lib/birbcrew/native" };

test("a held installation refuses every ledger write; a restored one makes unfinished effects uncertain, and a held source that resumes keeps them", async (t) => {
  const separate = await databaseAt(t, Infinity);
  const local = fixture(separate);
  const directory = await mkdtemp(join(tmpdir(), "birb-tool-calls-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recovery = new InstallationRecovery(separate, new FileRecoveryFence(join(directory, "fence")));
  await recovery.initializeFence();
  const hooks: RecoveryHooks = { quiesce: async () => {}, reconcile: async () => {}, snapshot: async (into) => {
    const artifacts = [];
    for (const kind of ["application-postgres", "temporal-persistence", "native-volumes", "configuration"] as const) {
      await writeFile(join(into, kind + ".fixture"), "fixture " + kind);
      artifacts.push({ kind, file: kind + ".fixture" });
    }
    return artifacts;
  } };
  const capture = async (name: string) => {
    const bundle = join(directory, name);
    await mkdir(bundle);
    await recovery.capture(bundle, pins, hooks);
    return { bundle, manifest: await readRecoveryManifest(bundle) };
  };

  const turnAt = await local.turn();
  const granted: Verdict = { verdict: "allow", by: "grant", grantId: await local.grant(turnAt.ownerId, turnAt.memberId) };
  const execution = randomUUID();
  // One call in every state a recovery point can hold.
  const calls = { readyRead: turnAt.key(), readyEffect: turnAt.key(), admittedRead: turnAt.key(), admittedEffect: turnAt.key(), completed: turnAt.key(),
    failed: turnAt.key(), waiting: turnAt.key(), refused: turnAt.key(), delivered: turnAt.key() };
  await local.ledger.record(calls.readyRead, reading, allowed);
  await local.ledger.record(calls.readyEffect, running, granted);
  await local.ledger.record(calls.admittedRead, reading, allowed);
  await local.ledger.record(calls.admittedEffect, writing, granted);
  await local.ledger.record(calls.completed, writing, granted);
  await local.ledger.record(calls.failed, running, granted);
  await local.ledger.record(calls.waiting, running, asked);
  await local.ledger.record(calls.refused, running, { verdict: "deny", by: "capability" });
  await local.ledger.record(calls.delivered, writing, granted);
  for (const key of [calls.admittedRead, calls.admittedEffect, calls.completed, calls.failed, calls.delivered]) await local.ledger.admit(key, execution);
  for (const key of [calls.completed, calls.delivered]) await local.ledger.complete(key, execution, { bytes: 3 });
  await local.ledger.fail(calls.failed, execution, "timeout");
  await local.ledger.deliver(calls.delivered);
  const state = async () => Object.fromEntries(await Promise.all(Object.entries(calls).map(async ([name, key]) => {
    const call = await local.ledger.get(key);
    return [name, call.phase + (call.phase === "uncertain" ? ":" + call.reason : "") + (call.delivered ? "+delivered" : "")];
  })));
  const atCapture = { readyRead: "ready", readyEffect: "ready", admittedRead: "admitted", admittedEffect: "admitted", completed: "completed", failed: "failed",
    waiting: "waiting", refused: "refused", delivered: "completed+delivered" };
  assert.deepEqual(await state(), atCapture);

  // Held: capture counts the ledger (and so found its write barrier), and every write is refused.
  const first = await capture("first");
  assert.equal(first.manifest.inventory.tool_calls, 9);
  for (const write of [() => local.ledger.record(turnAt.key(), reading, allowed), () => local.ledger.admit(calls.readyRead, execution),
    () => local.ledger.admit(calls.admittedRead, randomUUID()), () => local.ledger.complete(calls.admittedEffect, execution, {}),
    () => local.ledger.fail(calls.admittedRead, execution, "timeout"), () => local.ledger.classifyLost(calls.admittedEffect), () => local.ledger.deliver(calls.completed)]) {
    await assert.rejects(write(), { code: "55000" });
  }
  assert.deepEqual((await local.ledger.classifyLost(calls.completed)).action, "deliver", "reading a held ledger still works");
  assert.deepEqual(await state(), atCapture);

  // A held source that resumes without a restore keeps its calls as they were.
  await recovery.resume(hooks);
  assert.deepEqual(await state(), atCapture);

  // A restored installation: effects that were allowed and unfinished are uncertain, admitted or not.
  const second = await capture("second");
  await recovery.acceptRestore(second.bundle, pins, randomUUID());
  assert.deepEqual(await state(), atCapture, "still held: nothing is settled before the installation resumes");
  await recovery.resume(hooks, second.manifest);
  assert.deepEqual(await state(), { ...atCapture, readyEffect: "uncertain:recovery_restore", admittedEffect: "uncertain:recovery_restore" });
  await assert.rejects(recovery.resume(hooks, second.manifest), /Not held/);

  // Neither effect can run or finish; both wait to be delivered as uncertain.
  for (const key of [calls.readyEffect, calls.admittedEffect]) {
    assert.equal((await local.ledger.admit(key, execution)).run, false);
    assert.equal((await local.ledger.admit(key, randomUUID())).run, false);
    await assert.rejects(local.ledger.complete(key, execution, { bytes: 3 }), { code: "stale" });
    assert.deepEqual((await local.ledger.classifyLost(key)).action, "deliver");
    assert.equal((await local.ledger.deliver(key)).delivered, true);
  }
  // Reads run again, outcomes are delivered, and the ask is still an ask.
  assert.equal((await local.ledger.admit(calls.readyRead, randomUUID())).run, true);
  assert.deepEqual((await local.ledger.classifyLost(calls.admittedRead)).action, "rerun");
  assert.equal((await local.ledger.admit(calls.admittedRead, randomUUID())).run, true);
  assert.deepEqual([(await local.ledger.classifyLost(calls.completed)).action, (await local.ledger.classifyLost(calls.failed)).action,
    (await local.ledger.classifyLost(calls.refused)).action, (await local.ledger.classifyLost(calls.waiting)).action, (await local.ledger.classifyLost(calls.delivered)).action],
    ["deliver", "deliver", "deliver", "wait", "done"]);
  // The grant that allowed the effects was revoked by the same restore; the calls keep naming it.
  assert.equal((await separate.query("SELECT revocation_reason FROM birbcrew_ts.tool_grants WHERE grant_id=$1", [(granted as { grantId: string }).grantId])).rows[0].revocation_reason, "recovery_restore");
});
