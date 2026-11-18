import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadLiveProfiles } from "../../src/service/live-profiles.ts";
import { runPiTurn } from "../../src/service/pi.ts";

const model = "glm-5.3-flash";
const base = "https://opencode.ai/inference/go/openai/v1";
const live = (accounts: object) => ({ BIRBCREW_LIVE_PROFILES: JSON.stringify(accounts) });
const go = { provider: "opencode-go", account: "fixture owner" };
const claude = { provider: "anthropic-api", account: "fixture owner", model: "claude-sonnet-4-6" };
// The statement the removed gate used to read, always dated past its 12-hour limit. Tests write it only to show
// that nothing reads it now. No test writes a statement the removed gate would have accepted.
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
const formerAttestation = (extra: object = {}) => ({ provider: "opencode-go", account_path: "fixture owner", evidence: "local fixture",
  checked_at: hoursAgo(13), extra_usage_disabled: true, eligible_coding_use: true, ...extra });

async function privateFile(t: TestContext, data: object) {
  const dir = await mkdtemp(join(tmpdir(), "birb-account-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "account.json");
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
  return path;
}

async function localhost(t: TestContext) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const policy: { models: string[]; echo: string | null; redirect: boolean; modelsStatus: number } = { models: [model], echo: model, redirect: false, modelsStatus: 200 };
  let leaked = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/elsewhere") { leaked = true; return res.end(); }
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    calls.push({ url: base + req.url, headers, body: await text(req) });
    if (req.url === "/models") {
      res.writeHead(policy.modelsStatus, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(policy.modelsStatus === 200 ? { data: policy.models.map((id) => ({ id })) } : { error: { code: "api_key_expired" } }));
    }
    if (policy.redirect) return res.writeHead(307, { Location: "/elsewhere" }).end();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = {
      id: "fixture", object: "chat.completion.chunk", created: 1,
      ...(policy.echo && { model: policy.echo }),
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    };
    res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.ok(request.url === base + "/models" || request.url === base + "/chat/completions");
    assert.equal(request.redirect, "error");
    return fetch(`http://127.0.0.1:${addr.port}` + request.url.slice(base.length), init);
  };
  return { calls, policy, transport, leaked: () => leaked };
}

test("Codex subscription members bind the configured ChatGPT account and reread the sign-in across turns", async () => {
  const id = randomUUID();
  const env = { ...live({ codex: { provider: "chatgpt-subscription", model: "gpt-5.4", account_id: id } }),
    BIRBCREW_CODEX_AUTH_HOME: "/trusted/codex", BIRBCREW_CODEX_API_KEY: "unused-api-key" };
  let accesses = 0;
  const members = await loadLiveProfiles(env, fetch, async (home, expected) => {
    assert.equal(home, "/trusted/codex");
    assert.equal(expected, id);
    return { accountId: id, accessToken: "synthetic-" + ++accesses };
  });
  const name = "chatgpt-gpt-5.4";
  assert.deepEqual([...members.keys()].sort(), [name + ".approval.v1", name + ".next-step.v1", name + ".v1"]);
  const member = members.get(name + ".approval.v1");
  assert.equal(member?.accountId, id);
  const profile = member?.codex;
  assert.ok(profile?.authorize && profile.subscription);
  assert.equal(profile.apiKey, undefined);
  assert.equal(accesses, 0);
  for (const n of [1, 2]) {
    await profile.authorize();
    assert.equal((await profile.subscription()).accessToken, "synthetic-" + n);
  }
});

test("live profiles come only from the explicit setting and each engine's own credential", async (t) => {
  const keys = { OPENCODE_GO_API_KEY: "synthetic-go", BIRBCREW_CLAUDE_API_KEY: "synthetic-claude", BIRBCREW_CODEX_API_KEY: "synthetic-codex" };
  // Without the setting there are no live profiles to infer, whatever else is set.
  await assert.rejects(loadLiveProfiles({}), /Set BIRBCREW_LIVE_PROFILES/);
  await assert.rejects(loadLiveProfiles({ ...keys, OPENCODE_API_KEY: "alternate", ANTHROPIC_API_KEY: "other" }), /Set BIRBCREW_LIVE_PROFILES/);
  const statement = await privateFile(t, formerAttestation());
  const former = { BIRBCREW_PI_ATTESTATION: statement, BIRBCREW_CLAUDE_ATTESTATION: statement, BIRBCREW_CODEX_ATTESTATION: statement };
  await assert.rejects(loadLiveProfiles({ ...keys, ...former }), /BIRBCREW_\*_ATTESTATION variables are no longer read/);
  for (const invalid of ["", " ", "live", "true", "[]", "{}", JSON.stringify({ pi: null }), JSON.stringify({ gemini: go }),
    JSON.stringify({ pi: { provider: "opencode-go" } }), JSON.stringify({ pi: { ...go, account: " " } }),
    JSON.stringify({ pi: claude }), JSON.stringify({ pi: formerAttestation() }), JSON.stringify(formerAttestation()),
    JSON.stringify({ pi: { ...go, extra_usage_disabled: true } }), JSON.stringify({ pi: { ...go, checked_at: hoursAgo(13) } }),
    JSON.stringify({ claude: { ...claude, model: "gpt-5.4" } }), JSON.stringify({ codex: { provider: "chatgpt-subscription", model: "gpt-5.4" } }),
    JSON.stringify({ codex: { provider: "chatgpt-subscription", model: "gpt-5.4", account_id: "not an id" } })]) {
    await assert.rejects(loadLiveProfiles({ ...keys, BIRBCREW_LIVE_PROFILES: invalid }), /BIRBCREW_LIVE_PROFILES/, invalid);
  }
  await assert.rejects(loadLiveProfiles({ ...keys, BIRBCREW_LIVE_PROFILES: "{}" }), /Configure at least one engine/);
  // A rejected setting is described by field, never by value.
  const secretive = loadLiveProfiles({ ...keys, ...live({ pi: { ...go, account: "private-account-marker", evidence: "private-evidence-marker" } }) });
  await assert.rejects(secretive, (error: Error) => /pi: unknown evidence/.test(error.message) && !/private-/.test(error.message));

  // The real credential is still required, and only the engine's own variable satisfies it.
  await assert.rejects(loadLiveProfiles({ ...live({ pi: go }), OPENCODE_API_KEY: "alternate" }), /OPENCODE_GO_API_KEY/);
  await assert.rejects(loadLiveProfiles({ ...live({ pi: go }), OPENCODE_GO_API_KEY: " " }), /OPENCODE_GO_API_KEY/);
  await assert.rejects(loadLiveProfiles({ ...live({ claude }), ANTHROPIC_API_KEY: "other" }), /BIRBCREW_CLAUDE_API_KEY/);
  await assert.rejects(loadLiveProfiles({ ...live({ codex: { provider: "openai-api", account: "fixture owner", model: "gpt-5.4" } }), OPENAI_API_KEY: "other" }), /BIRBCREW_CODEX_API_KEY/);
  await assert.rejects(loadLiveProfiles({ ...live({ pi: go, claude }), OPENCODE_GO_API_KEY: "synthetic-go" }), /BIRBCREW_CLAUDE_API_KEY/);

  const profiles = await loadLiveProfiles({ ...keys, ...live({ pi: go, claude, codex: { provider: "openai-api", account: "api owner", model: "gpt-5.4" } }) });
  assert.deepEqual([...profiles.keys()].filter((name) => name.endsWith("4.v1") || name.endsWith("6.v1") || name.endsWith("flash.v1")).sort(),
    ["anthropic-claude-sonnet-4-6.v1", "openai-gpt-5.4.v1", "pi-go-glm-5.3-flash.v1"]);
  assert.equal(profiles.get("pi-go-glm-5.3-flash.v1")?.accountId, "fixture owner");
  const config = profiles.get("anthropic-claude-sonnet-4-6.v1")?.claude;
  assert.equal(config?.baseUrl, "https://api.anthropic.com");
  assert.equal(config?.apiKey, "synthetic-claude");
  const codex = profiles.get("openai-gpt-5.4.v1");
  assert.equal(codex?.accountId, "api owner");
  assert.equal(codex?.codex?.apiKey, "synthetic-codex");
  assert.ok(codex?.codex?.authorize && !codex.codex.subscription);
});

test("an absent, expired or contradicting attestation file changes nothing", async (t) => {
  const local = await localhost(t);
  const statement = await privateFile(t, formerAttestation());
  const states: [string, () => Promise<unknown>][] = [
    ["never written", () => rm(statement)],
    ["one minute past the former limit", () => writeFile(statement, JSON.stringify(formerAttestation({ checked_at: hoursAgo(12.02) })))],
    ["a month old", () => writeFile(statement, JSON.stringify(formerAttestation({ checked_at: hoursAgo(24 * 30) })))],
    ["expired and stating Extra Usage is on", () => writeFile(statement, JSON.stringify(formerAttestation({ extra_usage_disabled: false })))],
    ["expired and naming another account", () => writeFile(statement, JSON.stringify(formerAttestation({ account_path: "someone else" })))],
    ["not JSON", () => writeFile(statement, "renew me")],
  ];
  for (const [state, arrange] of states) {
    await arrange();
    const env = { ...live({ pi: go }), OPENCODE_GO_API_KEY: "synthetic-go", BIRBCREW_PI_ATTESTATION: statement };
    const profile = (await loadLiveProfiles(env, local.transport)).get("pi-go-glm-5.3-flash.v1");
    assert.equal(profile?.accountId, "fixture owner", state);
    const before = local.calls.length;
    const turn = await runPiTurn({ threadId: randomUUID(), runId: randomUUID(), text: "hello", signal: AbortSignal.timeout(15_000), checkpoint: null }, profile!.pi!);
    assert.equal(turn.text, "ok", state);
    assert.deepEqual(local.calls.slice(before).map((x) => x.url.slice(base.length)), ["/models", "/chat/completions"], state);
  }
});

test("the Pi coding SDK sends the approved model and stable BirbCrew session headers to the Go transport", async (t) => {
  const local = await localhost(t);
  const config = (await loadLiveProfiles({ ...live({ pi: go }), OPENCODE_GO_API_KEY: "synthetic-go" }, local.transport))
    .get("pi-go-glm-5.3-flash.v1")?.pi;
  assert.ok(config);
  const run = (threadId: string, checkpoint: Parameters<typeof runPiTurn>[0]["checkpoint"] = null) =>
    runPiTurn({ threadId, runId: randomUUID(), text: "hello", signal: AbortSignal.timeout(15_000), checkpoint }, config);
  const thread = randomUUID();
  const first = await run(thread);
  assert.equal(first.text, "ok");
  await run(thread, first.checkpoint);
  await run(randomUUID());
  assert.deepEqual(local.calls.map((x) => x.url.slice(base.length)), [
    "/models", "/chat/completions", "/models", "/chat/completions", "/models", "/chat/completions",
  ]);
  const sends = local.calls.filter((x) => x.body.length > 0);
  for (const call of sends) {
    assert.equal(JSON.parse(call.body).model, model);
    assert.equal(JSON.parse(call.body).max_tokens, 1200);
    assert.equal(call.headers.get("authorization"), "Bearer synthetic-go");
    assert.equal(call.headers.get("user-agent"), "birbcrew-coding-proof/0.1.0");
    assert.equal(call.headers.get("x-opencode-client"), null);
  }
  const ids = sends.map((x) => x.headers.get("x-opencode-session"));
  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);

  for (const echo of [null, "different-model"]) {
    local.policy.echo = echo;
    await assert.rejects(run(randomUUID()), /did not confirm the approved response model/);
  }
  local.policy.redirect = true;
  await assert.rejects(run(randomUUID()));
  assert.equal(local.leaked(), false);
  local.policy.models = ["another-model"];
  let count = local.calls.length;
  await assert.rejects(run(randomUUID()), /preflight/);
  assert.equal(local.calls.length, count + 1);
  // A key the provider refuses stops the turn at the model list, before any inference request.
  local.policy.models = [model];
  local.policy.modelsStatus = 401;
  count = local.calls.length;
  await assert.rejects(run(randomUUID()), /Go preflight did not confirm the approved model/);
  assert.deepEqual(local.calls.slice(count).map((x) => x.url.slice(base.length)), ["/models"]);
});
