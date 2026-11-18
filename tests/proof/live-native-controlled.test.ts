import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { accountKey, authorizeLive } from "./live-account.ts";
import { verifyLive } from "./live-members.ts";
import { codexSubscriptionEndpoint } from "../../src/service/accounts.ts";

const entries = z.array(z.looseObject({ role: z.string().optional(), content: z.unknown().optional(),
  type: z.string().optional(), output: z.unknown().optional() }));
function stream(frames: [string, object][], onReaderClosed?: () => void) {
  const data = frames.map(([type, event]) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...event }) + "\n\n").join("");
  const body = onReaderClosed ? new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(data)); },
    cancel: onReaderClosed,
  }) : data;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
for (const provider of ["anthropic-api", "openai-api", "chatgpt-subscription"] as const) {
  const engine = provider === "anthropic-api" ? "claude" : "codex";
  test("controlled " + (provider === "chatgpt-subscription" ? "codex subscription" : engine) + " upstream receives a native tool result and cold follow-up from the live proof entry", { timeout: 170_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "birb-proof-native-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, engine + ".json");
    const claude = engine === "claude";
    const subscription = provider === "chatgpt-subscription";
    const accountId = randomUUID();
    const turnState = randomUUID();
    const endpoint = subscription ? codexSubscriptionEndpoint : claude ? "https://api.anthropic.com" : "https://api.openai.com/v1";
    const model = claude ? "claude-sonnet-4-6" : "gpt-5.4";
    await writeFile(path, JSON.stringify({ approval_id: randomUUID(), provider, ...(subscription ? {account_id:accountId} : {account: "controlled"}),
      approved_live_proof: true, max_requests: 12, endpoint, model }), { mode: 0o600 });
    const args = ["--engine", engine, "--approval", path];
    const claims = join(dir, "claims");
    const signIn = async (_home: string, expected?: string) => {
      assert.equal(expected, accountId);
      return { accountId, accessToken: "synthetic-subscription-token" };
    };
    if (subscription) {
      await assert.rejects(authorizeLive(args, { BIRBCREW_CODEX_API_KEY: "ambient" }, claims,
        async () => ({accessToken:"wrong-account-token",accountId:randomUUID()})));
    } else await assert.rejects(authorizeLive(args, { OPENAI_API_KEY: "ambient", ANTHROPIC_API_KEY: "ambient" }));
    const account = await authorizeLive(args, subscription ? {} : { [accountKey[engine]]: "synthetic" }, claims, signIn);
    let toolResults = 0;
    let proposalReaderClosed = false;
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(request.headers.get(claude ? "x-api-key" : "authorization"),
        subscription ? "Bearer synthetic-subscription-token" : claude ? "synthetic" : "Bearer synthetic");
      assert.equal(request.headers.get("chatgpt-account-id"), subscription ? accountId : null);
      if (subscription) {
        assert.equal(request.headers.get("originator"), "codex_sdk_ts");
        assert.match(request.headers.get("user-agent") ?? "", /^codex_sdk_ts\//);
        assert.equal(z.uuid().parse(request.headers.get("session-id")), request.headers.get("thread-id"));
      }
      if (claude && url.pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: 16 });
      assert.equal(url.origin + url.pathname, endpoint + (claude ? "/v1/messages" : "/responses"));
      const body = await request.json();
      const history = entries.parse(claude ? body.messages : body.input);
      const first = history.find(entry => entry.role === "user" && JSON.stringify(entry.content).includes("record_work_item once"));
      const prompt = JSON.stringify(first?.content);
      assert.ok(prompt);
      const operation = prompt.match(/operation_id ([a-f0-9-]+)/)![1];
      const marker = prompt.match(/BIRB-[a-f0-9-]+/)![0];
      const recall = history.some(entry => entry.role === "user" && JSON.stringify(entry.content).includes("Reply with the exact test marker"));
      const result = claude ? history.filter(entry => entry.role === "user").flatMap(entry => Array.isArray(entry.content) ? entry.content : [])
        .findLast(part => part.type === "tool_result")?.content : history.findLast(entry => entry.type === "function_call_output")?.output;
      const receipt = result && JSON.stringify(result).replaceAll("\\", "").match(/"receiptId"\s*:\s*"([a-f0-9-]+)"/)?.[1];
      if (result && !recall) {
        assert.ok(receipt);
        if (subscription) assert.equal(request.headers.get("x-codex-turn-state"), turnState);
        toolResults++;
      }
      const answer = recall ? marker : receipt;
      const args = { operation_id: operation, note: "synthetic regression test" };
      if (claude) return stream([
        ["message_start", { message: { type: "message", id: "msg_" + randomUUID(), role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ["content_block_start", { index: 0, content_block: answer ? { type: "text", text: "" } :
          { type: "tool_use", id: "toolu_" + randomUUID(), name: "mcp__ag_ui__record_work_item", input: {} } }],
        ["content_block_delta", { index: 0, delta: answer ? { type: "text_delta", text: answer } :
          { type: "input_json_delta", partial_json: JSON.stringify(args) } }],
        ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: answer ? "end_turn" : "tool_use" }, usage: { output_tokens: 10 } }], ["message_stop", {}],
      ]);
      const id = "resp_" + randomUUID();
      const response = stream([["response.created", { response: { id } }], ["response.output_item.done", { item: answer ?
        { type: "message", id: "msg_" + randomUUID(), role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] } :
        { type: "function_call", call_id: "call_" + operation, namespace: "mcp__birbcrew", name: "record_work_item", arguments: JSON.stringify(args) } }],
        ["response.completed", { response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }]], answer ? undefined : () => { proposalReaderClosed = true; });
      if (subscription && !answer) response.headers.set("x-codex-turn-state", turnState);
      return response;
    };
    const report = await verifyLive(account, AbortSignal.timeout(115_000), transport);
    assert.equal(toolResults, 1);
    assert.equal(report.liveProviderVerified, false);
    assert.equal(report.cleanup, "verified");
    assert.equal(report.auth, provider);
    assert.equal(report.origin, endpoint);
    for (const privateValue of [accountId, turnState]) assert.ok(!JSON.stringify(report).includes(privateValue));
    if (!claude) {
      assert.equal(proposalReaderClosed, true);
      assert.equal(report.nativeUserTurnsVerified, 2);
    }
  });
}
