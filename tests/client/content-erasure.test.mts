import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CrewClient, CrewHttpError } from "@birbcrew/client";

test("raw OpenAPI rejects a result on erased receipts; portable erasure and close calls preserve identity", async () => {
  const document = JSON.parse(
    await readFile(
      new URL("../../packages/client/openapi.json", import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile({
    ...document.components.schemas.RequestReceipt,
    components: document.components,
  });
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
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...receipt, result: { text: "leak" } }), false);
  assert.ok(
    document.paths["/v1/conversations/{conversationId}/content"].delete,
  );
  assert.ok(
    document.paths["/v1/conversations/{conversationId}/close"].post
      .responses[202],
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
