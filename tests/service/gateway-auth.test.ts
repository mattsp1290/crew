import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import test, { type TestContext } from "node:test";
import type { MemberClient } from "../../src/service/client.ts";
import { createGateway } from "../../src/service/gateway.ts";
import type { MemberStore } from "../../src/service/store.ts";

// No database or Temporal: authentication must reject before either is touched. The gateway's background loops
// (cancellation outbox, routine and webhook dispatchers) read the store on their own timers. Those reads are the only calls
// allowed, and only outside a request's async context; the empty result means nothing to flush and recovery not
// active, so the loops stop there. Anything else is recorded, with the request that caused it when one is known
// (request and socket event listeners run outside that context).
const background = ["FROM birbcrew_ts.integration_cancellations x JOIN", "FROM birbcrew_ts.recovery_control WHERE singleton"];
const cause = new AsyncLocalStorage<string>();
const reached: string[] = [];
const record = (target: string, sql = "") => {
  const request = cause.getStore();
  if (request || !background.some((read) => sql.includes(read))) reached.push(`${request ?? "no request"} -> ${target}`);
};
const store = { pool: {
  async query(sql: string) { record("store", sql); return { rows: [], rowCount: 0 }; },
  // The /v1/health database probe opens its own connection from these options and swallows the failure.
  get options() { record("store.pool.options"); return { host: "127.0.0.1", port: 1 }; },
} } as unknown as MemberStore;
const members = new Proxy({}, { get: (_, name) => () => { record("members." + String(name)); throw new Error("unreachable"); } }) as MemberClient;

const token = randomUUID();
const conversation = randomUUID(), request = randomUUID(), member = randomUUID(), grant = randomUUID();
const routine = randomUUID(), memory = randomUUID(), webhook = randomUUID(), pack = randomUUID();
// Every route and method main serves, versioned and unversioned, plus health-like paths that must not exist.
const routes: [string, string][] = [
  ["GET", "/v1/capabilities"], ["GET", "/v1/health"], ["GET", "/v1/members"], ["GET", "/v1/conversations"],
  ["GET", "/v1/audit"], ["GET", "/v1/audit?format=csv"], ["POST", "/v1/audit"],
  ["POST", "/v1/routines"], ["GET", "/v1/routines"], ["GET", `/v1/routines/${routine}`], ["DELETE", `/v1/routines/${routine}`],
  ["POST", `/v1/routines/${routine}/enable`], ["POST", `/v1/routines/${routine}/disable`], ["GET", `/v1/routines/${routine}/firings`],
  ["POST", "/v1/memories"], ["GET", "/v1/memories"], ["GET", `/v1/memories/${memory}`], ["DELETE", `/v1/memories/${memory}`],
  ["POST", "/v1/webhooks"], ["GET", "/v1/webhooks"], ["GET", `/v1/webhooks/${webhook}`], ["DELETE", `/v1/webhooks/${webhook}`],
  ["POST", `/v1/webhooks/${webhook}/enable`], ["POST", `/v1/webhooks/${webhook}/disable`], ["GET", `/v1/webhooks/${webhook}/deliveries`],
  ["GET", `/v1/members/${member}/grants`], ["POST", `/v1/members/${member}/grants/${grant}/revoke`],
  ["GET", `/v1/members/${member}/instructions`],
  ["POST", "/v1/instruction-packs"], ["GET", "/v1/instruction-packs"], ["GET", `/v1/instruction-packs/${pack}`],
  ["DELETE", `/v1/instruction-packs/${pack}`],
  ["GET", "/v1/usage"], ["GET", "/v1/usage/members"], ["GET", "/v1/usage/conversations"], ["GET", "/v1/usage/records"],
  ["GET", `/v1/usage/budgets/${member}`], ["PUT", `/v1/usage/budgets/${member}`], ["DELETE", `/v1/usage/budgets/${member}`],
  ["POST", "/v1/members"], ["POST", "/v1/conversations"],
  ["GET", `/v1/conversations/${conversation}`], ["POST", `/v1/conversations/${conversation}/requests`],
  ["GET", `/v1/conversations/${conversation}/requests/${request}/approvals/${grant}?memberId=${member}&invocationId=${request}&version=1`],
  ["GET", `/v1/conversations/${conversation}/requests/${request}`], ["POST", `/v1/conversations/${conversation}/requests/${request}/cancel`],
  ["POST", `/v1/conversations/${conversation}/events`], ["POST", `/v1/conversations/${conversation}/human`],
  ["POST", `/v1/conversations/${conversation}/inputs`], ["POST", `/v1/conversations/${conversation}/cancel`],
  ["POST", `/v1/conversations/${conversation}/handoffs`], ["GET", `/v1/conversations/${conversation}/handoff`],
  ["POST", "/members"], ["POST", "/conversations"], ["GET", `/conversations/${conversation}`],
  ["GET", `/conversations/${conversation}/requests/${request}`], ["POST", `/conversations/${conversation}/inputs`],
  ["POST", `/conversations/${conversation}/human`], ["POST", `/conversations/${conversation}/cancel`],
  ["POST", `/conversations/${conversation}/events`],
  ["GET", "/"], ["GET", "/health"], ["GET", "/healthz"], ["GET", "/v1/healthz"], ["GET", "/healthz/"], ["GET", "/healthz?probe=1"],
  ["GET", "/v1/health?probe=1"], ["POST", "/healthz"], ["PUT", "/healthz"], ["DELETE", "/healthz"],
];

async function listen(t: TestContext) {
  const server = createGateway(store, members, { [createHash("sha256").update(token).digest("hex")]: randomUUID() });
  const [handle] = server.listeners("request") as ((request: IncomingMessage, response: ServerResponse) => void)[];
  server.removeListener("request", handle);
  server.on("request", (request: IncomingMessage, response: ServerResponse) =>
    cause.run(`${request.method} ${request.url}`, handle, request, response));
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await server.stopped();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function raw(port: number, method: string, target: string) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.end(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  const reply = Buffer.concat(await socket.toArray()).toString();
  return Number(/^HTTP\/1\.1 (\d{3}) /.exec(reply)?.[1]);
}

test("every route rejects requests without a valid bearer token before reaching the store or Temporal", async (t) => {
  const port = await listen(t), base = `http://127.0.0.1:${port}`;
  for (const [method, path] of routes) {
    for (const authorization of [undefined, "", "Bearer ", "Bearer " + randomUUID(), "Basic " + token, "bearer " + token]) {
      // Invalid JSON, so a body read before authentication would answer 400.
      const response = await fetch(base + path, { method, headers: authorization === undefined ? {} : { Authorization: authorization },
        ...(method === "POST" || method === "PUT" ? { body: "{" } : {}) });
      assert.equal(response.status, 401, `${method} ${path} with ${authorization === undefined ? "no" : JSON.stringify(authorization.split(" ")[0])} credential`);
      assert.deepEqual(await response.json(), { error: "authentication_required" });
    }
  }
  // Request targets that fetch normalizes away, including ones a URL parser rejects or rewrites.
  for (const [method, target] of [["HEAD", "/healthz"], ["OPTIONS", "/healthz"], ["HEAD", "/v1/health"], ["GET", "//"],
    ["GET", "//evil/healthz"], ["GET", "http://x/healthz"], ["GET", "http://x/v1/health"], ["GET", "http://[/healthz"],
    ["GET", "http://x:99999/healthz"], ["GET", "/./healthz"], ["GET", "/v1/../healthz"], ["GET", "/v1/./health"],
    ["GET", "/%2e/healthz"], ["GET", "*"]]) {
    assert.equal(await raw(port, method, target), 401, `${method} ${target}`);
  }
  assert.deepEqual(reached, [], "no unauthenticated request reached the store or Temporal client");

  assert.equal((await fetch(base + "/v1/capabilities", { headers: { Authorization: "Bearer " + token } })).status, 200);
  // Positive controls: requests that do reach the store or the Temporal client are recorded, so the empty list above
  // means something.
  assert.equal((await fetch(base + "/v1/members", { headers: { Authorization: "Bearer " + token } })).status, 200);
  assert.equal((await fetch(base + "/v1/health", { headers: { Authorization: "Bearer " + token } })).status, 503);
  assert.deepEqual(reached, ["GET /v1/members -> store", "GET /v1/health -> store.pool.options", "GET /v1/health -> members.temporalReachable"]);
});
