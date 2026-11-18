import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { CrewClient, CrewHttpError, CrewProtocolError, CrewTransportError, CrewUnknownOutcomeError } from "@birbcrew/client";
import { capabilitiesSchema, createHandoffBodySchema, createHandoffSchema, handoffRecordSchema, createHandoffResponseSchema, conversationHandoffSchema, handoffsCapabilityV1Schema, handoffsCapabilitySchema } from "@birbcrew/client/contract";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const memberId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const intent = { conversationId, requestId, memberId };
const input = { conversationId: conversationId.toUpperCase(), requestId: requestId.toUpperCase(), memberId: memberId.toUpperCase() };
const record = {
  handoffId: "ffffffff-ffff-4fff-8fff-ffffffffffff", requestId,
  source: { conversationId, memberId, engine: "claude" },
  target: { conversationId: targetId, memberId, engine: "claude" },
  firstRequestId: requestId, firstRequestAdmitted: false,
  carriedTurns: 1, omittedTurns: 0, uncertainTurns: 0,
  transcriptBytes: 1, transcriptDigest: "ab".repeat(32), createdAt: "2026-11-16T12:00:00.123456Z",
};
const created = { apiVersion: "1", ...record };
const chain = { apiVersion: "1", conversationId, incoming: null, outgoing: record };
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};
function barrier() {
  let release = () => {};
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}
async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>) {
  const seen: { method: string; path: string; body: string; auth: string | undefined; contentType: string | undefined }[] = [];
  const server = createServer((request, response) => { void (async () => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.ok(request.method && request.url);
    seen.push({ method: request.method, path: request.url, body, auth: request.headers.authorization, contentType: request.headers["content-type"] });
    await handler(request, response, body);
  })().catch(error => response.destroy(error)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new CrewClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "handoff-fixture-token" });
  return { client, seen, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
function unknownHandoff(error: unknown): error is CrewUnknownOutcomeError {
  assert.ok(error instanceof CrewUnknownOutcomeError);
  assert.deepEqual(error.command, { kind: "handoff", ...intent });
  assert.equal(Object.isFrozen(error.command), true);
  assert.ok(!String(error).includes("handoff-fixture-token"));
  return true;
}

test("handoff methods normalize exact wire identities and preserve pending or admitted 201 truth", async () => {
  let admitted = false;
  const s = await serve((request, response) => json(response, request.method === "POST"
    ? { ...created, firstRequestAdmitted: admitted, additive: true }
    : { ...chain, additive: true }, request.method === "POST" ? 201 : 200));
  try {
    assert.deepEqual(await s.client.createHandoff(input), created);
    admitted = true;
    assert.deepEqual(await s.client.createHandoff(input), { ...created, firstRequestAdmitted: true });
    assert.deepEqual(await s.client.handoff({ conversationId: input.conversationId }), chain);
    assert.deepEqual(s.seen, [
      { method: "POST", path: `/v1/conversations/${conversationId}/handoffs`, body: JSON.stringify({ requestId, memberId }), auth: "Bearer handoff-fixture-token", contentType: "application/json" },
      { method: "POST", path: `/v1/conversations/${conversationId}/handoffs`, body: JSON.stringify({ requestId, memberId }), auth: "Bearer handoff-fixture-token", contentType: "application/json" },
      { method: "GET", path: `/v1/conversations/${conversationId}/handoff`, body: "", auth: "Bearer handoff-fixture-token", contentType: undefined },
    ]);
  } finally { await s.close(); }
});

test("strict inputs and pre-aborted handoff calls dispatch nothing", async () => {
  const s = await serve((_, response) => json(response, created, 201));
  try {
    for (const field of ["conversationId", "requestId", "memberId"] as const) {
      await assert.rejects(s.client.createHandoff({ ...intent, [field]: "invalid" }));
      const { [field]: omitted, ...missing } = intent;
      assert.ok(omitted);
      assert.equal(createHandoffSchema.safeParse(missing).success, false);
    }
    for (const extra of [{ ownerId: "other" }, { text: "prompt" }, { extra: true }]) {
      await assert.rejects(s.client.createHandoff({ ...intent, ...extra }));
    }
    await assert.rejects(s.client.handoff({ conversationId: "../other" }));
    const reason = new Error("left conversation");
    for (const call of [() => s.client.createHandoff(intent, { signal: AbortSignal.abort(reason) }),
      () => s.client.handoff({ conversationId }, { signal: AbortSignal.abort(reason) })]) {
      await assert.rejects(call(), error => error === reason);
    }
    assert.equal(s.seen.length, 0);
    assert.deepEqual(createHandoffSchema.parse(input), intent);
    assert.deepEqual(createHandoffBodySchema.parse({ requestId: input.requestId, memberId: input.memberId }), { requestId, memberId });
    assert.equal(createHandoffBodySchema.safeParse(intent).success, false);
  } finally { await s.close(); }
});

test("each mismatched POST identity preserves the complete frozen normalized command", async () => {
  let reply: unknown = created;
  const s = await serve((_, response) => json(response, reply, 201));
  try {
    for (reply of [{ ...created, requestId: otherId },
      { ...created, source: { ...record.source, conversationId: otherId } },
      { ...created, target: { ...record.target, memberId: otherId } }]) {
      await assert.rejects(s.client.createHandoff(input), unknownHandoff);
    }
    assert.equal(s.seen.length, 3);
  } finally { await s.close(); }
});

test("handoff reads accept all directions and unrelated commands but reject inconsistent envelopes", async () => {
  const incoming = { ...record, source: { ...record.source, conversationId: otherId }, target: { ...record.target, conversationId } };
  const unrelated = { ...record, requestId: otherId, target: { ...record.target, memberId: otherId } };
  let reply: unknown = chain;
  const s = await serve((_, response) => json(response, reply));
  try {
    for (const value of [chain, { ...chain, incoming, outgoing: null }, { ...chain, incoming }, { ...chain, outgoing: unrelated }]) {
      reply = value;
      assert.deepEqual(await s.client.handoff({ conversationId }), value);
    }
    for (reply of [{ ...chain, conversationId: targetId, incoming: record, outgoing: null },
      { ...chain, incoming: record, outgoing: null },
      { ...chain, outgoing: incoming }, { ...chain, outgoing: null }]) {
      await assert.rejects(s.client.handoff({ conversationId }), CrewProtocolError);
    }
    assert.equal(s.seen.length, 8);
    assert.ok(s.seen.every(request => request.method === "GET"));
  } finally { await s.close(); }
});

test("a read 404 before a controlled POST commit leaves the original call pending", async () => {
  const dispatched = barrier(), commit = barrier();
  let committed = false, settled = false;
  const s = await serve(async (request, response) => {
    if (request.method === "POST") {
      dispatched.release();
      await commit.reached;
      committed = true;
      return json(response, created, 201);
    }
    return committed ? json(response, chain) : json(response, { error: "not_found" }, 404);
  });
  const pending = s.client.createHandoff(intent).finally(() => { settled = true; });
  try {
    await dispatched.reached;
    await assert.rejects(s.client.handoff({ conversationId }), error => error instanceof CrewHttpError && error.status === 404);
    assert.equal(settled, false);
    assert.deepEqual(s.seen.map(request => request.method), ["POST", "GET"]);
    commit.release();
    assert.deepEqual(await pending, created);
    assert.deepEqual(await s.client.handoff({ conversationId }), chain);
    assert.deepEqual(s.seen.map(request => request.method), ["POST", "GET", "GET"]);
  } finally { commit.release(); await pending.catch(() => {}); await s.close(); }
});

test("incoming-only and another outgoing command remain reads after a lost acknowledgement", async () => {
  let reply: unknown = { ...chain, incoming: { ...record,
    source: { ...record.source, conversationId: otherId }, target: { ...record.target, conversationId } }, outgoing: null };
  let saved: CrewUnknownOutcomeError | undefined;
  const s = await serve((request, response) => request.method === "POST" ? request.socket.destroy() : json(response, reply));
  try {
    await assert.rejects(s.client.createHandoff(input), error => {
      unknownHandoff(error);
      if (error instanceof CrewUnknownOutcomeError) saved = error;
      return true;
    });
    assert.deepEqual(await s.client.handoff({ conversationId }), reply);
    reply = { ...chain, outgoing: { ...record, requestId: otherId } };
    assert.deepEqual(await s.client.handoff({ conversationId }), reply);
    assert.ok(saved);
    unknownHandoff(saved);
    assert.deepEqual(s.seen.map(request => request.method), ["POST", "GET", "GET"]);
  } finally { await s.close(); }
});

test("only handoff POST treats exact 409 update_rejected as unknown", async () => {
  const s = await serve((_, response) => json(response, { error: "update_rejected" }, 409));
  try {
    await assert.rejects(s.client.createHandoff(input), error => {
      unknownHandoff(error);
      assert.ok(error instanceof CrewUnknownOutcomeError && error.cause instanceof CrewHttpError);
      assert.equal(error.cause.status, 409);
      assert.equal(error.cause.code, "update_rejected");
      return true;
    });
    for (const call of [() => s.client.handoff({ conversationId }),
      () => s.client.submit({ conversationId, requestId, text: "x" }),
      () => s.client.revokeGrant({ memberId, grantId: otherId }),
      () => s.client.decide({ ...intent, invocationId: otherId, approvalId: targetId, version: 1, choice: "deny" })]) {
      await assert.rejects(call(), error => error instanceof CrewHttpError && error.status === 409 && error.code === "update_rejected");
    }
    assert.equal(s.seen.length, 5);
  } finally { await s.close(); }
});

test("valid refusals remain HTTP errors and uncertain errors remain bounded without retries", async () => {
  let status = 400, code = "invalid_request";
  const s = await serve((_, response) => json(response, { error: code }, status));
  try {
    const refusals = [[400, "invalid_request"], [401, "authentication_required"], [404, "not_found"],
      [409, "busy"], [409, "conflict"], [409, "handed_off"], [409, "future_error"], [400, "update_rejected"]] as const;
    for (const pair of refusals) {
      [status, code] = pair;
      await assert.rejects(s.client.createHandoff(intent), error => error instanceof CrewHttpError && error.status === status && error.code === code);
    }
    for (const pair of [[503, "unavailable"], [409, "retry_same_request"], [503, "handoff-fixture-token\n".repeat(20_000)]] as const) {
      [status, code] = pair;
      await assert.rejects(s.client.createHandoff(input), error => {
        unknownHandoff(error);
        assert.ok(error instanceof CrewUnknownOutcomeError && error.cause instanceof CrewHttpError);
        assert.ok(!String(error.cause).includes("handoff-fixture-token"));
        return true;
      });
    }
    assert.equal(s.seen.length, refusals.length + 3);
    assert.ok(s.seen.every(request => request.method === "POST"));
  } finally { await s.close(); }
});

test("socket loss and post-dispatch abort preserve handoff identity while read failures stay reads", async () => {
  const s = await serve(request => request.socket.destroy());
  try {
    await assert.rejects(s.client.createHandoff(input), unknownHandoff);
    await assert.rejects(s.client.handoff({ conversationId }), CrewTransportError);
    assert.deepEqual(s.seen.map(request => request.method), ["POST", "GET"]);
  } finally { await s.close(); }
  for (const duringBody of [false, true]) {
    const abort = new AbortController(), reached = barrier(), reason = new Error("navigation");
    const a = await serve((_, response) => {
      if (duringBody) { response.writeHead(200); response.write('{"apiVersion":'); }
      reached.release();
    });
    try {
      const read = a.client.handoff({ conversationId }, { signal: abort.signal });
      await reached.reached;
      abort.abort(reason);
      await assert.rejects(read, error => error === reason);
      assert.equal(a.seen.length, 1);
    } finally { await a.close(); }
  }
  for (const duringBody of [false, true]) {
    const abort = new AbortController(), reached = barrier();
    const a = await serve((_, response) => {
      if (duringBody) { response.writeHead(201); response.write('{"apiVersion":'); }
      reached.release();
    });
    try {
      const post = a.client.createHandoff(input, { signal: abort.signal });
      await reached.reached;
      abort.abort(new Error("navigation"));
      await assert.rejects(post, unknownHandoff);
      assert.equal(a.seen.length, 1);
    } finally { await a.close(); }
  }
});

test("malformed, oversized, wrong-status and wrong-version successes never acknowledge a handoff", async () => {
  let body: unknown = "not json", postStatus = 201, readStatus = 200;
  const s = await serve((request, response) => {
    response.statusCode = request.method === "POST" ? postStatus : readStatus;
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  try {
    for (body of ["not json", "x".repeat(8 * 1024 * 1024 + 1), { ...created, apiVersion: "2" }]) {
      await assert.rejects(s.client.createHandoff(input), unknownHandoff);
    }
    for (body of ["not json", "x".repeat(8 * 1024 * 1024 + 1), { ...chain, apiVersion: "2" }]) {
      await assert.rejects(s.client.handoff({ conversationId }), CrewProtocolError);
    }
    body = created; postStatus = 202;
    await assert.rejects(s.client.createHandoff(input), unknownHandoff);
    body = chain; readStatus = 201;
    await assert.rejects(s.client.handoff({ conversationId }), CrewProtocolError);
    body = "not json"; postStatus = 409; readStatus = 409;
    await assert.rejects(s.client.createHandoff(input), unknownHandoff);
    await assert.rejects(s.client.handoff({ conversationId }), error => error instanceof CrewHttpError && error.status === 409 && error.code === "invalid_error_response");
    assert.equal(s.seen.length, 10);
  } finally { await s.close(); }
});

test("a broken response stream cannot acknowledge POST or turn GET into a command", async () => {
  let calls = 0;
  const client = new CrewClient({ baseUrl: "https://crew.example", token: "handoff-fixture-token", fetch: async (_, init) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"apiVersion":'));
      controller.error(new Error("stream failed"));
    } }), { status: init?.method === "POST" ? 201 : 200 });
  } });
  await assert.rejects(client.createHandoff(input), unknownHandoff);
  await assert.rejects(client.handoff({ conversationId }), CrewProtocolError);
  assert.equal(calls, 2);
});

test("handoff records enforce SQL count and byte bounds without inventing UUID or member inequality", () => {
  assert.deepEqual(handoffRecordSchema.parse(record), record);
  assert.deepEqual(createHandoffResponseSchema.parse({ ...created, future: true }), created);
  assert.deepEqual(conversationHandoffSchema.parse(chain), chain);
  for (const value of [{ ...record, carriedTurns: 128, transcriptBytes: 65_536 },
    { ...record, omittedTurns: 127 }, { ...record, uncertainTurns: 127 }]) {
    assert.equal(handoffRecordSchema.safeParse(value).success, true);
  }
  for (const value of [
    { ...record, carriedTurns: 0 }, { ...record, carriedTurns: 129 }, { ...record, carriedTurns: 1.5 },
    { ...record, omittedTurns: -1 }, { ...record, omittedTurns: 128 }, { ...record, uncertainTurns: -1 },
    { ...record, uncertainTurns: 129 }, { ...record, uncertainTurns: 128 }, { ...record, carriedTurns: 2, omittedTurns: 127 },
    { ...record, transcriptBytes: 0 }, { ...record, transcriptBytes: 65_537 }, { ...record, transcriptBytes: 1.5 },
    { ...record, transcriptDigest: "ab".repeat(31) }, { ...record, transcriptDigest: "gg".repeat(32) },
    { ...record, transcriptDigest: "AB".repeat(32) },
    { ...record, createdAt: "yesterday" }, { ...record, firstRequestAdmitted: "false" },
    { ...record, source: { ...record.source, engine: "future" } },
    { ...record, target: { ...record.target, conversationId } },
  ]) assert.equal(handoffRecordSchema.safeParse(value).success, false);
  assert.equal("apiVersion" in handoffRecordSchema.parse({ ...record, apiVersion: "1" }), false);
});

test("handoffs capability is optional, validates v1 and preserves opaque future metadata", async () => {
  const base = { apiVersion: "1", requestContract: "sql-admission-temporal-queue-v1",
    observation: { protocol: "AG-UI", mode: "snapshot-and-bounded-tail" }, initiatorKinds: ["owner"] };
  const v1 = { version: 1, route: "/v1/conversations/{conversationId}/handoffs", readRoute: "/v1/conversations/{conversationId}/handoff",
    delivery: "reserved-first-request", initiatorKind: "handoff", transcriptBytes: 65_536, promptBytes: 16_384,
    carried: "newest-whole-committed-turns", source: "sealed-readable" };
  const future = { version: 2, differentRoute: "/future", metadata: { opaque: true } };
  let reply: unknown = base;
  const s = await serve((_, response) => json(response, reply));
  try {
    assert.equal((await s.client.capabilities()).handoffs, undefined);
    for (const handoffs of [v1, { ...v1, additive: true }, future]) {
      reply = { ...base, handoffs };
      assert.deepEqual((await s.client.capabilities()).handoffs, handoffs);
      assert.deepEqual(handoffsCapabilitySchema.parse(handoffs), handoffs);
    }
    assert.equal(handoffsCapabilityV1Schema.safeParse(future).success, false);
    for (const handoffs of [{ version: 1 }, { ...v1, route: "/wrong" }, { ...v1, transcriptBytes: 1 }, { ...v1, version: 0 }]) {
      reply = { ...base, handoffs };
      assert.equal(capabilitiesSchema.safeParse(reply).success, false);
      await assert.rejects(s.client.capabilities(), CrewProtocolError);
    }
    assert.equal(s.seen.length, 8);
  } finally { await s.close(); }
});
