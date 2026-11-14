import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { CrewClient, CrewHttpError, CrewProtocolError, CrewTransportError, CrewUnknownOutcomeError } from "@birbcrew/client";
import { requestInitiator, serverRequestReceiptSchema, requestReceiptResponseSchema } from "@birbcrew/client/contract";

const conversationId = randomUUID(), requestId = randomUUID(), memberId = randomUUID();
const key = { conversationId, requestId };
const receipt = { apiVersion: "1", ...key, acceptance: { boundary: "sql_admission_and_temporal_queue" }, status: "accepted" };
const member = { memberId, engine: "claude", profile: "test" };
const snapshot = { cursor: 0, state: { ...member, conversationId, phase: "idle" }, messages: [], openTools: {}, openText: null, childText: {} };
const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>) {
  const seen: { path: string; method: string; auth: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => { void (async () => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ path: request.url!, method: request.method!, auth: request.headers.authorization, body });
    await handler(request, response, body);
  })(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { seen, baseUrl, client: new CrewClient({ baseUrl, token: "secret-token" }), close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("all domain methods send one authenticated request with exact text", async () => {
  const approvalId = randomUUID();
  const s = await serve((request, response) => {
    const path = request.url!;
    if (path.includes("/human")) return json(response, { approvalId, decision: "deny" });
    if (path.includes("/requests")) return json(response, receipt, request.method === "POST" ? 202 : 200);
    if (path === "/v1/members" && request.method === "POST") return json(response, { ...member, ownerId: "private-owner" }, 201);
    if (path.startsWith("/v1/members")) return json(response, { apiVersion: "1", members: [member], next: null });
    if (path === "/v1/health") return json(response, { apiVersion: "1", status: "not_ready", dependencies: { database: { status: "ready", schemaVersion: 29 }, temporal: { status: "unavailable" } } }, 503);
    if (path === "/v1/capabilities") return json(response, { apiVersion: "1", requestContract: "sql-admission-temporal-queue-v1", observation: { protocol: "AG-UI", mode: "snapshot-and-bounded-tail" }, initiatorKinds: ["owner"] });
    return json(response, snapshot, request.method === "POST" ? 201 : 200);
  });
  try {
    await s.client.capabilities(); assert.equal((await s.client.health()).status, "not_ready");
    assert.equal((await s.client.listMembers({ limit: 2, after: "opaque+/=" })).members.length, 1);
    assert.equal("ownerId" in await s.client.createMember({ requestId, engine: "claude", profile: "test" }), false);
    await s.client.openConversation({ conversationId, memberId });
    assert.equal((await s.client.conversation({ conversationId })).phase, "idle");
    const text = "  Exact\n\té and e\u0301 🪶  ";
    await s.client.submit({ ...key, text }); const saved = { ...key, text }; await s.client.requestStatus(saved); await s.client.cancel(key);
    await s.client.decide({ ...key, memberId, invocationId: randomUUID(), approvalId, version: 1, choice: "deny" });
    assert.equal(s.seen.length, 10);
    assert.ok(s.seen.every(request => request.auth === "Bearer secret-token"));
    assert.equal(s.seen[2].path, "/v1/members?limit=2&after=opaque%2B%2F%3D");
    assert.equal(s.seen[6].body, JSON.stringify({ requestId, text }));
    assert.equal(s.seen[7].method, "GET"); assert.equal(s.seen[8].body, "{}");
  } finally { await s.close(); }
});

test("invalid UUID, text, byte bounds and pre-aborted calls dispatch nothing", async () => {
  const s = await serve((_, response) => json(response, receipt));
  try {
    for (const text of ["", "\0", "\ud800", "é".repeat(8193)]) await assert.rejects(s.client.submit({ ...key, text }));
    await assert.rejects(s.client.submit({ ...key, conversationId: "../evil", text: "x" }));
    await assert.rejects(s.client.createMember({ requestId, engine: "pi", profile: "p", instructions: "\r" }));
    await assert.rejects(s.client.submit({ ...key, text: "x" }, { signal: AbortSignal.abort("stopped") }), error => error === "stopped");
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
});

test("lost acknowledgement preserves original identity and status never resubmits", async () => {
  const s = await serve((request, response) => request.method === "POST" ? request.socket.destroy() : json(response, { error: "not_found" }, 404));
  try {
    await assert.rejects(s.client.submit({ ...key, text: "accepted before socket close" }), error => error instanceof CrewUnknownOutcomeError && error.command.kind === "request" && error.command.requestId === requestId);
    await assert.rejects(s.client.requestStatus(key), error => error instanceof CrewHttpError && error.status === 404);
    assert.deepEqual(s.seen.map(request => request.method), ["POST", "GET"]);
  } finally { await s.close(); }
});

test("abort after acceptance means unknown outcome", async () => {
  const abort = new AbortController();
  const s = await serve(() => abort.abort());
  try {
    await assert.rejects(s.client.submit({ ...key, text: "accepted" }, { signal: abort.signal }), CrewUnknownOutcomeError);
    assert.equal(s.seen.length, 1);
  } finally { await s.close(); }
});

for (const [status, error] of [[409, "conflict"], [404, "not_found"], [401, "authentication_required"], [503, "retry_same_request"], [409, "future_error"]] as const) {
  test(`HTTP ${status} ${error} remains bounded and never retries`, async () => {
    const s = await serve((_, response) => json(response, { error }, status));
    try {
      await assert.rejects(s.client.submit({ ...key, text: "sensitive prompt" }), failure => {
        assert.ok(!String(failure).includes("secret-token") && !String(failure).includes("sensitive prompt"));
        return status === 503 ? failure instanceof CrewUnknownOutcomeError : failure instanceof CrewHttpError && failure.code === error && failure.status === status;
      });
      assert.equal(s.seen.length, 1);
    } finally { await s.close(); }
  });
}

for (const malformed of ["not json", { ...receipt, apiVersion: "2" }, { ...receipt, requestId: randomUUID() }, { ...receipt, status: "completed" }]) {
  test(`malformed or wrong-identity reply does not imply completion: ${JSON.stringify(malformed)}`, async () => {
    const s = await serve((request, response) => {
      response.statusCode = request.method === "POST" ? 202 : 200;
      response.end(typeof malformed === "string" ? malformed : JSON.stringify(malformed));
    });
    try {
      await assert.rejects(s.client.submit({ ...key, text: "x" }), CrewUnknownOutcomeError);
      await assert.rejects(s.client.requestStatus(key), CrewProtocolError);
      assert.equal(s.seen.length, 2);
    } finally { await s.close(); }
  });
}

test("oversized and malicious response bodies are bounded", async () => {
  const s = await serve((request, response) => {
    response.statusCode = request.method === "POST" ? 202 : 200;
    response.end("x".repeat(8 * 1024 * 1024 + 1));
  });
  try {
    await assert.rejects(s.client.submit({ ...key, text: "x" }), CrewUnknownOutcomeError);
    await assert.rejects(s.client.requestStatus(key), CrewProtocolError);
  } finally { await s.close(); }
  const e = await serve((_, response) => json(response, { error: "secret-token\n".repeat(20_000) }, 503));
  try { await assert.rejects(e.client.cancel(key), failure => failure instanceof CrewUnknownOutcomeError && !String(failure).includes("secret-token")); }
  finally { await e.close(); }
});

test("redirects cannot forward bearer credentials or replay writes", async () => {
  const s = await serve((_, response) => { response.writeHead(307, { Location: "/second" }); response.end(); });
  try { await assert.rejects(s.client.submit({ ...key, text: "x" }), CrewUnknownOutcomeError); assert.equal(s.seen.length, 1); }
  finally { await s.close(); }
});

test("receipt validation preserves independent cancellation facts and historical nonterminal results", () => {
  for (const status of ["accepted", "uncertain", "completed", "cancelled"] as const) {
    const value = { ...receipt, status, result: { text: "historical result" }, initiator: { kind: "handoff", id: randomUUID() },
      cancellation: { receiptId: randomUUID(), delivery: "pending", nativeTermination: "confirmed", effects: "not_assessed" } };
    assert.deepEqual(serverRequestReceiptSchema.parse(value), value);
  }
});

test("instruction packs preserve server ordering and reject duplicate normalized UUIDs before dispatch", async () => {
  const instructionPacks = [randomUUID(), randomUUID()];
  const s = await serve((request, response) => request.method === "POST"
    ? json(response, { ...member, instructionPacks }, 201)
    : json(response, { apiVersion: "1", members: [{ ...member, instructionPacks }], next: null }));
  try {
    assert.deepEqual((await s.client.createMember({ requestId, engine: "claude", profile: "test", instructionPacks })).instructionPacks, instructionPacks);
    assert.deepEqual(JSON.parse(s.seen[0].body).instructionPacks, instructionPacks);
    assert.deepEqual((await s.client.listMembers()).members[0].instructionPacks, instructionPacks);
    for (const invalid of [[], [instructionPacks[0], instructionPacks[0].toUpperCase()], Array.from({ length: 9 }, () => randomUUID())]) {
      await assert.rejects(s.client.createMember({ requestId, engine: "claude", profile: "test", instructionPacks: invalid }));
    }
    assert.equal(s.seen.length, 2);
  } finally { await s.close(); }
});


test("response initiators accept future kinds without widening accepted authoring", async () => {
  const future = { kind: "future", id: "future-id", version: 2 };
  const s = await serve((request, response) => request.url === "/v1/capabilities"
    ? json(response, { apiVersion: "1", requestContract: "sql-admission-temporal-queue-v1", observation: { protocol: "AG-UI", mode: "snapshot-and-bounded-tail" }, initiatorKinds: ["owner", "future"] })
    : json(response, { ...receipt, initiator: future }, request.method === "POST" ? 202 : 200));
  try {
    assert.deepEqual((await s.client.capabilities()).initiatorKinds, ["owner", "future"]);
    assert.deepEqual((await s.client.submit({ ...key, text: "exact" })).initiator, future);
    assert.deepEqual((await s.client.requestStatus(key)).initiator, future);
    assert.deepEqual((await s.client.cancel(key)).initiator, future);
    assert.equal(requestInitiator.safeParse(future).success, false);
    assert.equal(serverRequestReceiptSchema.safeParse({ ...receipt, initiator: future }).success, false);
    for (const kind of ["routine", "handoff"]) {
      assert.equal(requestReceiptResponseSchema.safeParse({ ...receipt, initiator: { kind, id: "invalid" } }).success, false);
      assert.equal(requestReceiptResponseSchema.safeParse({ ...receipt, initiator: { kind } }).success, false);
    }
    assert.equal(requestReceiptResponseSchema.safeParse({ ...receipt, initiator: { kind: "owner", futureField: true } }).success, true);
  } finally { await s.close(); }
});

test("reads preserve status on malformed errors and classify health faults", async () => {
  for (const body of ["not JSON", "x".repeat(16_385)]) {
    const s = await serve((_, response) => { response.statusCode = 502; response.end(body); });
    try { await assert.rejects(s.client.requestStatus(key), error => error instanceof CrewHttpError && error.status === 502 && error.code === "invalid_error_response"); }
    finally { await s.close(); }
  }
  const s = await serve((_, response) => json(response, { error: "retry_same_request" }, 503));
  try { await assert.rejects(s.client.health(), error => error instanceof CrewHttpError && error.status === 503 && error.code === "retry_same_request"); }
  finally { await s.close(); }
});

test("read aborts preserve the reason during fetch and body consumption", async () => {
  for (const duringBody of [false, true]) {
    const abort = new AbortController(), reason = new Error("navigation");
    const s = await serve((_, response) => {
      if (duringBody) { response.writeHead(200); response.write('{"apiVersion":'); }
      setTimeout(() => abort.abort(reason), 10);
    });
    try { await assert.rejects(s.client.requestStatus(key, { signal: abort.signal }), error => error === reason); }
    finally { await s.close(); }
  }
  const s = await serve(request => request.socket.destroy());
  try { await assert.rejects(s.client.requestStatus(key), CrewTransportError); }
  finally { await s.close(); }
});

test("bodyless reads omit JSON content type and unexpected successes release the body", async () => {
  let cancelled = false, contentType: string | null = "unseen";
  const client = new CrewClient({ baseUrl: "https://crew.example", token: "fixture", fetch: async (_, init) => {
    contentType = new Headers(init?.headers).get("Content-Type");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 201 });
  } });
  await assert.rejects(client.requestStatus(key), CrewProtocolError);
  assert.equal(contentType, null);
  assert.equal(cancelled, true);
});
