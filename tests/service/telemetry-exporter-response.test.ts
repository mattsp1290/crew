import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

type Result = Parameters<Parameters<OTLPTraceExporter["export"]>[1]>[0];
type Reply = (request: IncomingMessage, response: ServerResponse, attempt: number) => void;

async function collector(t: TestContext, reply: Reply) {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    request.resume();
    reply(request, response, ++requests);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/v1/traces`, requests: () => requests };
}

function exporter(t: TestContext, url: string, timeoutMillis = 2_000) {
  const value = new OTLPTraceExporter({ url, timeoutMillis, concurrencyLimit: 1 });
  t.after(() => value.shutdown());
  return value;
}

async function send(t: TestContext, value: OTLPTraceExporter) {
  const callbacks: Result[] = [];
  let guard: NodeJS.Timeout | undefined;
  const started = performance.now();
  try {
    const completed = new Promise<Result>((resolve) => {
      value.export([], (result) => { callbacks.push(result); resolve(result); });
    });
    const result = await Promise.race([
      completed.then(async (result) => { await value.forceFlush(); return result; }),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error("export and forceFlush did not settle")), 5_000);
      }),
    ]);
    t.after(() => assert.equal(callbacks.length, 1, "one callback per export"));
    return { result, elapsed: performance.now() - started };
  } finally { clearTimeout(guard); }
}

function healthy(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
}

test("admits exactly 4 MiB, rejects the next byte, and exports again after either response", { timeout: 15_000 }, async (t) => {
  const limit = 4 * 1_024 * 1_024;
  const endpoint = await collector(t, (_request, response, attempt) => {
    if (attempt === 2 || attempt === 4) return healthy(response);
    const bytes = attempt === 1 ? limit : limit + 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    response.write("{}" + " ".repeat(bytes - 2));
    response.end();
  });
  const value = exporter(t, endpoint.url);
  assert.equal((await send(t, value)).result.code, 0, "exactly 4 MiB remains valid JSON");
  assert.equal((await send(t, value)).result.code, 0);
  assert.equal((await send(t, value)).result.code, 1, "4 MiB plus one byte must fail");
  assert.equal((await send(t, value)).result.code, 0, "oversize response releases the export slot");
  assert.equal(endpoint.requests(), 4);
});

test("a continuously dripping response cannot renew the configured export deadline", { timeout: 15_000 }, async (t) => {
  for (const timeout of [200, 2_000]) {
    await t.test(`${timeout} ms total deadline`, async (t) => {
      let chunks = 0, closed = false;
      const endpoint = await collector(t, (_request, response, attempt) => {
        if (attempt > 1) return healthy(response);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
        response.write(" ");
        const timer = setInterval(() => { chunks++; response.write(" "); }, 20);
        response.once("close", () => { closed = true; clearInterval(timer); });
        t.after(() => clearInterval(timer));
      });
      const value = exporter(t, endpoint.url, timeout);
      const failed = await send(t, value);
      assert.equal(failed.result.code, 1);
      assert.ok(chunks >= 2, "the collector kept supplying body data");
      assert.ok(failed.elapsed >= timeout * 0.75, `deadline fired early after ${failed.elapsed} ms`);
      assert.ok(failed.elapsed < timeout + 1_500, `deadline took ${failed.elapsed} ms`);
      assert.equal((await send(t, value)).result.code, 0);
      await delay(50);
      assert.equal(closed, true, "the expired response connection closes");
      assert.equal(endpoint.requests(), 2);
    });
  }
});

const brokenResponses = [
  { name: "truncated content-length body", reply(response: ServerResponse) {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "32", Connection: "close" }).end("{}");
  } },
  { name: "response stream reset", reply(response: ServerResponse) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    response.write(" ", () => response.destroy());
  } },
  { name: "HTTP upgrade", reply(response: ServerResponse) {
    response.writeHead(101, { Connection: "Upgrade", Upgrade: "collector-probe" }).end();
  } },
];

for (const broken of brokenResponses) {
  test(`${broken.name} settles once and permits the next export`, { timeout: 10_000 }, async (t) => {
    const endpoint = await collector(t, (_request, response, attempt) => {
      if (attempt > 1) return healthy(response);
      broken.reply(response);
    });
    const value = exporter(t, endpoint.url);
    const failed = await send(t, value);
    assert.equal(failed.result.code, 1);
    assert.ok(failed.elapsed < 1_500, `body failure waited ${failed.elapsed} ms`);
    assert.equal((await send(t, value)).result.code, 0);
    assert.equal(endpoint.requests(), 2);
  });
}

test("retryable responses stop after the initial attempt and five retries", { timeout: 10_000 }, async (t) => {
  const endpoint = await collector(t, (_request, response, attempt) => {
    if (attempt > 6) return healthy(response);
    response.writeHead(429, { "Retry-After": "0" }).end("{}");
  });
  const value = exporter(t, endpoint.url);
  assert.equal((await send(t, value)).result.code, 1);
  assert.equal(endpoint.requests(), 6);
  assert.equal((await send(t, value)).result.code, 0);
  assert.equal(endpoint.requests(), 7);
});

test("Retry-After delays the retry before a successful response", { timeout: 10_000 }, async (t) => {
  const attempts: number[] = [];
  const endpoint = await collector(t, (_request, response, attempt) => {
    attempts.push(performance.now());
    if (attempt > 1) return healthy(response);
    response.writeHead(503, { "Retry-After": "1" }).end("{}");
  });
  const value = exporter(t, endpoint.url, 4_000);
  assert.equal((await send(t, value)).result.code, 0);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1] - attempts[0] >= 950, "the retry preserves the collector's one-second delay");
  assert.equal((await send(t, value)).result.code, 0);
  assert.equal(endpoint.requests(), 3);
});

test("a Retry-After beyond the deadline leaves no delayed request behind", { timeout: 10_000 }, async (t) => {
  const endpoint = await collector(t, (_request, response, attempt) => {
    if (attempt > 1) return healthy(response);
    response.writeHead(503, { "Retry-After": "1" }).end("{}");
  });
  const value = exporter(t, endpoint.url, 200);
  const failed = await send(t, value);
  assert.equal(failed.result.code, 1);
  assert.ok(failed.elapsed < 1_500, `retry cancellation took ${failed.elapsed} ms`);
  assert.equal(endpoint.requests(), 1);
  assert.equal((await send(t, value)).result.code, 0);
  await delay(1_100);
  assert.equal(endpoint.requests(), 2, "an expired retry must not reach the collector later");
});
