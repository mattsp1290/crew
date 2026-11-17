import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { routes } from "@birbcrew/client/contract";
import { ApprovalStore } from "../../src/service/approvals.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { ownerInitiator, type TurnRequest } from "../../src/service/domain.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { MemberStore } from "../../src/service/store.ts";

export const openApi = JSON.parse(readFileSync(new URL("../../packages/client/openapi.json", import.meta.url), "utf8"));
export const ajv = new Ajv2020({ strict: false, allErrors: true, formats: fullFormats });
export function responseValidator(operation: keyof typeof routes, status: number) {
  const route = routes[operation];
  const response = openApi.paths[route.path][route.method.toLowerCase()].responses[status];
  assert.ok(response?.content, `${operation} documents HTTP ${status}`);
  return ajv.compile({ ...response.content["application/json"].schema, components: openApi.components });
}
export async function validateResponse(operation: keyof typeof routes, response: Response) {
  const validate = responseValidator(operation, response.status);
  const body = await response.json();
  assert.equal(validate(body), true, `${operation} HTTP ${response.status}: ${ajv.errorsText(validate.errors)}`);
  return body;
}

export async function gatewayFixture(store: MemberStore, automaticallyComplete = false) {
  const ownerId = randomUUID(), token = randomUUID(), stranger = randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture-v1" });
  const key = { ownerId, conversationId: randomUUID() };
  await store.openConversation({ ...key, memberId: member.memberId });
  let accepts = 0, cancels = 0, effects = 0;
  async function finish(input: TurnRequest) {
    if (await store.committedReply(input) !== undefined) return;
    const turn = await store.beginTurn(input, { workflowRunId: randomUUID(), activityId: "fixture", attempt: 1 });
    if (turn.kind === "start") {
      effects++;
      await store.commitTurn({ ...key, requestId: input.requestId, token: turn.token,
        reply: "original result: " + input.text, checkpoint: { version: 1, engine: "pi", state: {} } });
    }
  }
  const members = {
    async open(input: Parameters<MemberStore["openConversation"]>[0]) { return store.openConversation(input); },
    async decide(input: Parameters<ApprovalStore["decide"]>[0]) { return new ApprovalStore(store.pool).decide(input); },
    async accept(input: TurnRequest) {
      accepts++;
      await store.recordAcceptance(input, ownerInitiator);
      if (automaticallyComplete) await finish(input);
      return { requestId: input.requestId };
    },
    async requestStatus(input: Parameters<MemberStore["requestStatus"]>[0]) { return store.requestStatus(input); },
    async cancelPending() { cancels++; },
  } as unknown as MemberClient;
  const auth = { [createHash("sha256").update(token).digest("hex")]: ownerId,
    [createHash("sha256").update(stranger).digest("hex")]: randomUUID() };
  let server = createGateway(store, members, auth);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let endpoint = `http://127.0.0.1:${address.port}`;
  async function api(path: string, body?: unknown, credential: string = token) {
    return fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const stop = async () => {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections(); await closed;
  };
  return { ...key, token, stranger, api, members, finish, get endpoint() { return endpoint; },
    counts: () => ({ accepts, cancels, effects }), stop,
    async restart() {
      await stop();
      server = createGateway(new MemberStore(store.pool), members, auth);
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      endpoint = `http://127.0.0.1:${address.port}`;
    },
  };
}
