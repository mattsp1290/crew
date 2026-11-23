import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  CrewClient,
  CrewHttpError,
  CrewUnknownOutcomeError,
} from "@birbcrew/client";
import {
  requestReceiptResponseSchema,
  capabilitiesSchema,
  contentErasureCapabilityV1Schema,
  conversationContentTombstoneSchema,
  conversationClosureSchema,
  snapshotWireSchema,
  routes,
} from "@birbcrew/client/contract";

test("erased receipts forbid results; portable erasure and close calls preserve identity", async () => {
  const conversationId = randomUUID(),
    requestId = randomUUID();
  const receipt = {
    apiVersion: "1",
    conversationId,
    requestId,
    status: "completed",
    erased: true,
    acceptance: { boundary: "sql_admission_and_temporal_queue" },
  };
  assert.equal(requestReceiptResponseSchema.safeParse(receipt).success, true);
  assert.equal(
    requestReceiptResponseSchema.safeParse({
      ...receipt,
      result: { text: "leak" },
    }).success,
    false,
  );
  const seen: { path: string; method: string | undefined; body: unknown }[] =
    [];
  const tombstone = {
    apiVersion: "1",
    conversationId,
    memberId: randomUUID(),
    engine: "cursor",
    erasureId: randomUUID(),
    erased: true,
    erasedAt: new Date().toISOString(),
  };
  const client = new CrewClient({
    baseUrl: "http://127.0.0.1:34567",
    token: "fixture",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      seen.push({ path, method: init?.method, body: init?.body });
      const data = path.endsWith("/content")
        ? tombstone
        : path.endsWith("/close")
          ? { apiVersion: "1", conversationId, closure: "requested" }
          : { error: "conversation_erased" };
      return new Response(JSON.stringify(data), {
        status: path.endsWith("/requests")
          ? 410
          : path.endsWith("/close")
            ? 202
            : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(
    await client.eraseConversationContent({ conversationId }),
    tombstone,
  );
  assert.equal(
    (await client.closeConversation({ conversationId })).closure,
    "requested",
  );
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[1].body, "{}");
  await assert.rejects(
    client.submit({ conversationId, requestId, text: "replay" }),
    (error) => error instanceof CrewHttpError && error.status === 410,
  );
  assert.equal(seen.length, 3);
});

test("erasure metadata and command responses preserve forward compatibility", () => {
  const capability = {
    version: 1,
    route: "/v1/conversations/{conversationId}/content",
    closeRoute: "/v1/conversations/{conversationId}/close",
    engines: ["cursor", "opencode"],
    preconditions:
      "closed-workflow; terminal-requests; stopped-writers; complete-location-inventory",
    retry: "same-conversation-until-200",
    residuals: [
      "Temporal-history-until-retention",
      "WAL-backups-provider-copies-and-logs",
    ],
    extra: true,
  };
  const base = {
    apiVersion: "1",
    requestContract: "sql-admission-temporal-queue-v1",
    observation: { protocol: "AG-UI", mode: "snapshot-and-bounded-tail" },
    initiatorKinds: [],
  };
  assert.equal(
    capabilitiesSchema.safeParse({ ...base, contentErasure: capability })
      .success,
    true,
  );
  assert.equal(
    capabilitiesSchema.safeParse({
      ...base,
      contentErasure: { version: 2, new: true },
    }).success,
    true,
  );
  assert.equal(
    capabilitiesSchema.safeParse({
      ...base,
      contentErasure: {
        ...capability,
        engines: [...capability.engines, "future"],
        residuals: [...capability.residuals, "future"],
      },
    }).success,
    true,
  );
  assert.equal(
    contentErasureCapabilityV1Schema.safeParse({ ...capability, residuals: [] })
      .success,
    false,
  );
  assert.equal(
    conversationContentTombstoneSchema.safeParse({
      apiVersion: "1",
      conversationId: randomUUID(),
      memberId: randomUUID(),
      engine: "future",
      erasureId: randomUUID(),
      erased: true,
      erasedAt: new Date().toISOString(),
      extra: true,
    }).success,
    true,
  );
  assert.equal(
    conversationClosureSchema.safeParse({
      apiVersion: "1",
      conversationId: randomUUID(),
      closure: "closed",
      extra: true,
    }).success,
    true,
  );
  const snapshot = {
    erased: true,
    cursor: 0,
    state: {
      conversationId: randomUUID(),
      memberId: randomUUID(),
      engine: "cursor",
      profile: "fixture",
      phase: "complete",
      erased: true,
    },
    messages: [],
    openText: null,
    openTools: {},
    childText: {},
  };
  assert.equal(snapshotWireSchema.safeParse(snapshot).success, true);
  for (const patch of [
    { messages: ["leak"] },
    { openText: "leak" },
    { openTools: { x: "leak" } },
    { childText: { x: "leak" } },
    { state: { ...snapshot.state, erased: undefined } },
  ])
    assert.equal(
      snapshotWireSchema.safeParse({ ...snapshot, ...patch }).success,
      false,
    );
});

test("ambiguous open, close and erasure outcomes retain distinct retry commands", async () => {
  const conversationId = randomUUID(),
    client = new CrewClient({
      baseUrl: "http://127.0.0.1:34567",
      token: "fixture",
      fetch: async () => {
        throw Error("lost response");
      },
    });
  for (const [kind, action] of [
    [
      "content_erasure",
      () => client.eraseConversationContent({ conversationId }),
    ],
    ["conversation_close", () => client.closeConversation({ conversationId })],
    [
      "conversation",
      () => client.openConversation({ conversationId, memberId: randomUUID() }),
    ],
  ] as const) {
    await assert.rejects(
      action(),
      (error) =>
        error instanceof CrewUnknownOutcomeError &&
        error.command.kind === kind &&
        "conversationId" in error.command &&
        error.command.conversationId === conversationId,
    );
  }
});

test("erased receipts are read results and cannot acknowledge submit or cancel", () => {
  const receipt = {
    apiVersion: "1",
    conversationId: randomUUID(),
    requestId: randomUUID(),
    status: "completed",
    erased: true,
    acceptance: { boundary: "sql_admission_and_temporal_queue" },
  };
  assert.equal(routes.requestStatus.response.safeParse(receipt).success, true);
  assert.equal(routes.submit.response.safeParse(receipt).success, false);
  assert.equal(routes.cancel.response.safeParse(receipt).success, false);
});

test("close rejects a successful status paired with the wrong closure acknowledgement", async () => {
  const conversationId = randomUUID();
  for (const [status, closure] of [[200, "requested"], [202, "closed"]] as const) {
    const client = new CrewClient({ baseUrl: "http://127.0.0.1:34567", token: "fixture",
      fetch: async () => new Response(JSON.stringify({ apiVersion: "1", conversationId, closure }), { status }) });
    await assert.rejects(client.closeConversation({ conversationId }), error => error instanceof CrewUnknownOutcomeError && error.command.kind === "conversation_close");
  }
});

 test("open cannot acknowledge an erased read snapshot as a new conversation", async () => {
  const conversationId = randomUUID(), memberId = randomUUID();
  const client = new CrewClient({ baseUrl: "http://127.0.0.1:34567", token: "fixture", fetch: async () => new Response(JSON.stringify({
    apiVersion: "1", conversationId, erased: true, cursor: 0,
    state: { conversationId, memberId, engine: "cursor", profile: "fixture", phase: "complete", erased: true },
    messages: [], openText: null, openTools: {}, childText: {},
  }), { status: 201, headers: { "Content-Type": "application/json" } }) });
  await assert.rejects(client.openConversation({conversationId, memberId}), error => error instanceof CrewUnknownOutcomeError);
});
