import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { goEndpoint, goModel } from "../../src/service/accounts.ts";
import { authorizeLive } from "./live-account.ts";
import { verifyLive } from "./live-members.ts";
import { openRelay } from "./live-relay.ts";

async function approval(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "birb-live-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "owner.json");
  const value = { approval_id: randomUUID(), provider: "opencode-go", account: "test",
    approved_live_proof: true, endpoint: goEndpoint, model: goModel, max_requests: 16 };
  const write = (extra: object = {}) => writeFile(path, JSON.stringify({ ...value, ...extra }), { mode: 0o600 });
  await write();
  const args = ["--engine", "pi", "--approval", path];
  const env = { OPENCODE_GO_API_KEY: "synthetic" };
  return { path, args, env, write, claims: join(dir, "claims") };
}

test("live preflight requires a private owner decision for exactly one provider, model, origin and request budget", async (t) => {
  const gate = await approval(t);
  await assert.rejects(authorizeLive([], gate.env));
  await assert.rejects(authorizeLive([...gate.args, "--engine", "pi"], gate.env));
  await assert.rejects(authorizeLive(["--engine", "claude", "--approval", gate.path], { BIRBCREW_CLAUDE_API_KEY: "synthetic" }));
  await assert.rejects(authorizeLive(gate.args, { OPENAI_API_KEY: "ignored" }));
  // A dated account statement is not a proof approval: its fields are unknown here, whatever they say.
  for (const invalid of [{ approved_live_proof: false }, { endpoint: "https://example.invalid" }, { max_requests: 25 },
    { model: "other" }, { account: " " }, { checked_at: "2020-01-01T00:00:00Z" }, { evidence: "console check" },
    { extra_usage_disabled: true }, { eligible_coding_use: true }]) {
    await gate.write(invalid);
    await assert.rejects(authorizeLive(gate.args, gate.env, gate.claims));
  }
  await gate.write();
  const account = await authorizeLive(gate.args, gate.env, gate.claims);
  assert.deepEqual(JSON.parse(account.liveProfiles), { pi: { provider: "opencode-go", account: "test" } });
  await chmod(gate.path, 0o644);
  await assert.rejects(authorizeLive(gate.args, gate.env, gate.claims));
});

test("the command redacts the account and credentials on a declined opt-in", async (t) => {
  const gate = await approval(t);
  await gate.write({ approved_live_proof: false, account: "private account marker" });
  const result = spawnSync(process.execPath, ["tests/proof/live-members.ts", ...gate.args], {
    env: { PATH: process.env.PATH, OPENCODE_GO_API_KEY: "private selected key", OPENAI_API_KEY: "private foreign key" },
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "NOT VERIFIED", stage: "account preflight", verifiedGates: [], attemptedRequests: 0 });
});

test("the relay counts before upstream submission and fails closed on revocation", async (t) => {
  const gate = await approval(t);
  for (const revoked of [true, false]) {
    await gate.write({ max_requests: 1 });
    const account = await authorizeLive(gate.args, gate.env, gate.claims);
    let upstream = 0;
    const relay = await openRelay(account, AbortSignal.timeout(5000), async (url, init) => {
      assert.equal(url, goEndpoint + "/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic");
      assert.equal(init?.redirect, "error");
      upstream++;
      return Response.json({ data: [] });
    });
    try {
      if (revoked) await gate.write({ approved_live_proof: false });
      const get = () => fetch(relay.url + "/models", { headers: { "User-Agent": "birbcrew-coding-proof/0.1.0", Authorization: "Bearer " + relay.workerKey } });
      const responses = await Promise.all([get(), get()]);
      assert.deepEqual(responses.map(r => r.status).sort(), revoked ? [403, 403] : [200, 403]);
      assert.equal(upstream, revoked ? 0 : 1);
    } finally { await relay.close(); }
  }
});

test("the same approval can admit provider traffic from just one process, including after its exit", async (t) => {
  const gate = await approval(t);
  await gate.write({ max_requests: 1 });
  const script = `
    import { authorizeLive } from "./tests/proof/live-account.ts";
    import { openRelay } from "./tests/proof/live-relay.ts";
    const account = await authorizeLive(["--engine","pi","--approval",process.argv[1]], process.env, process.argv[2]);
    let sent = 0;
    const relay = await openRelay(account, AbortSignal.timeout(3000), async () => { sent++; return Response.json({}); });
    try {
      const res = await fetch(relay.url + "/models", { headers: { Authorization: "Bearer " + relay.workerKey, "User-Agent":"birbcrew-coding-proof/0.1.0" } });
      console.log(JSON.stringify([res.status,sent]));
    } finally { await relay.close(); }`;
  const launch = async () => JSON.parse((await promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", script, gate.path, gate.claims], { env: gate.env, timeout: 8000 })).stdout);
  assert.deepEqual((await Promise.all([launch(), launch()])).sort(), [[200,1], [403,0]]);
  assert.deepEqual(await launch(), [403,0]);
});

test("aborting stops the admitted request immediately and refuses new provider submissions", async (t) => {
  const gate = await approval(t), account = await authorizeLive(gate.args, gate.env, gate.claims);
  const controller = new AbortController();
  const entered = Promise.withResolvers<AbortSignal>();
  let submissions = 0;
  const relay = await openRelay(account, controller.signal, async (_url, init) => {
    submissions++;
    const active = init!.signal!;
    entered.resolve(active);
    await once(active, "abort");
    throw new Error("cancelled by the proof");
  });
  try {
    const get = () => fetch(relay.url + "/models", { headers: { Authorization: "Bearer " + relay.workerKey, "User-Agent": "birbcrew-coding-proof/0.1.0" } });
    const pending = get();
    const admitted = await entered.promise;
    controller.abort();
    assert.equal(admitted.aborted, true);
    assert.equal((await pending).status, 403);
    assert.equal((await get()).status, 403);
    assert.equal(submissions, 1);
  } finally { await relay.close(); }
});

test("a loopback request without the disposable SDK credential cannot use the provider account", async (t) => {
  const gate = await approval(t), account = await authorizeLive(gate.args, gate.env, gate.claims);
  let submissions = 0;
  const relay = await openRelay(account, AbortSignal.timeout(5000), async () => { submissions++; return Response.json({}); });
  try {
    const response = await fetch(relay.url + "/models", { headers: { "User-Agent": "birbcrew-coding-proof/0.1.0" } });
    assert.equal(response.status, 403);
    assert.equal(submissions, 0);
  } finally { await relay.close(); }
});

test("the live Pi entry exercises native tool results, cold recall, delegation and cleanup with a controlled upstream", { timeout: 150_000 }, async (t) => {
  const gate = await approval(t);
  const account = await authorizeLive(gate.args, gate.env, gate.claims);
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === goEndpoint + "/models") return Response.json({ data: [{ id: goModel }] });
    assert.equal(request.url, goEndpoint + "/chat/completions");
    const { messages } = await request.json() as { messages: { role: string; content: unknown }[] };
    const user = JSON.stringify(messages.findLast(m => m.role === "user")?.content);
    const last = messages.at(-1);
    const body = JSON.stringify(messages);
    let call: { name: string; arguments: string } | undefined;
    let text = "";
    if (last?.role === "tool") {
      const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      text = content.match(/"receiptId":"([a-f0-9-]+)"/)?.[1] ?? content.match(/CHILD-[a-f0-9-]+/)?.[0] ?? "";
    } else if (user.includes("record_work_item once")) {
      call = { name: "record_work_item", arguments: JSON.stringify({ operation_id: user.match(/operation_id ([a-f0-9-]+)/)![1], note: "synthetic regression test" }) };
    } else if (user.includes("Test delegation")) {
      call = { name: "delegate_task", arguments: JSON.stringify({ role: "analyst", task: "Reply exactly " + user.match(/CHILD-[a-f0-9-]+/)![0] }) };
    } else text = body.match(/(?:BIRB|CHILD)-[a-f0-9-]+/)?.[0] ?? "";
    assert.ok(call || text);
    const delta = call ? { role: "assistant", tool_calls: [{ type: "function", index: 0, id: "call_" + randomUUID(), function: call }] } : { content: text };
    const frame = { id: "message", object: "chat.completion.chunk", model: goModel, created: 1,
      choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] };
    return new Response("data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  const report = await verifyLive(account, AbortSignal.timeout(120_000), transport);
  assert.equal(report.delegatedChild, true);
  assert.equal(report.committedWorkItems, 1);
  assert.equal(report.workerContainerReplaced, true);
  assert.equal(report.cleanup, "verified");
});
