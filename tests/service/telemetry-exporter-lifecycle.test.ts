import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

type Result = Parameters<Parameters<OTLPTraceExporter["export"]>[1]>[0];

async function within<T>(work: Promise<T>) {
  let guard: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error("export lifecycle did not settle")), 5_000);
    })]);
  } finally { clearTimeout(guard); }
}

async function collector(t: TestContext, reply: (response: ServerResponse, attempt: number) => void) {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => { request.resume(); reply(response, ++requests); });
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

function send(t: TestContext, exporter: OTLPTraceExporter) {
  const callbacks: Result[] = [];
  t.after(() => assert.equal(callbacks.length, 1, "one callback per export"));
  return within(new Promise<Result>((resolve) => {
    exporter.export([], (result) => { callbacks.push(result); resolve(result); });
  }));
}

test("shutdown settles an active response and rejects later exports without a request", { timeout: 10_000 }, async (t) => {
  const received = Promise.withResolvers<void>();
  const endpoint = await collector(t, (response) => {
    response.writeHead(200).flushHeaders();
    received.resolve();
  });
  const exporter = new OTLPTraceExporter({ url: endpoint.url, timeoutMillis: 4_000, concurrencyLimit: 1 });
  t.after(() => within(exporter.shutdown()));
  const active = send(t, exporter);
  await within(received.promise);
  const started = performance.now();
  await within(exporter.shutdown());
  assert.equal((await active).code, 1);
  assert.ok(performance.now() - started < 1_500, "shutdown cancels instead of waiting for the export deadline");
  await within(exporter.forceFlush());
  assert.equal((await send(t, exporter)).code, 1);
  await within(exporter.shutdown());
  await delay(50);
  assert.equal(endpoint.requests(), 1);
});

test("shutdown cancels an already-scheduled Retry-After delay", { timeout: 10_000 }, async (t) => {
  const endpoint = await collector(t, (response) => response.writeHead(503, { "Retry-After": "2" }).end("{}"));
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true });
  const consumed = Promise.withResolvers<void>();
  agent.once("free", () => consumed.resolve());
  const exporter = new OTLPTraceExporter({
    url: endpoint.url, timeoutMillis: 5_000, concurrencyLimit: 1, httpAgentOptions: () => agent,
  });
  t.after(() => agent.destroy());
  t.after(() => within(exporter.shutdown()));
  const active = send(t, exporter);
  await within(consumed.promise);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const started = performance.now();
  await within(exporter.shutdown());
  assert.equal((await active).code, 1);
  assert.ok(performance.now() - started < 1_500, "shutdown clears the pending retry timer");
  await within(exporter.forceFlush());
  await delay(2_100);
  assert.equal(endpoint.requests(), 1, "the canceled retry never reaches the collector");
});

test("an expired export cannot send after its async agent factory resolves", { timeout: 10_000 }, async (t) => {
  const endpoint = await collector(t, (response) => response.writeHead(200).end("{}"));
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: false });
  const initialized = Promise.withResolvers<InstanceType<typeof Agent>>();
  const started = Promise.withResolvers<void>();
  const exporter = new OTLPTraceExporter({
    url: endpoint.url, timeoutMillis: 200, concurrencyLimit: 1,
    httpAgentOptions: () => { started.resolve(); return initialized.promise; },
  });
  t.after(() => { initialized.resolve(agent); agent.destroy(); });
  t.after(() => within(exporter.shutdown()));
  const expired = send(t, exporter);
  await within(started.promise);
  assert.equal((await expired).code, 1);
  await within(exporter.forceFlush());
  assert.equal(endpoint.requests(), 0);
  initialized.resolve(agent);
  await delay(50);
  assert.equal(endpoint.requests(), 0, "resolving initialization cannot revive an expired export");
  assert.equal((await send(t, exporter)).code, 0);
  await within(exporter.forceFlush());
  await delay(50);
  assert.equal(endpoint.requests(), 1, "only the healthy follow-up reaches the collector");
});

test("Crew returns its work and exits naturally after a dripping collector deadline", { timeout: 12_000 }, async (t) => {
  const marker = "collector-private-" + randomUUID();
  const token = "token-" + randomUUID();
  const secret = "work-private-" + randomUUID();
  let chunks = 0, closed = false;
  const endpoint = await collector(t, (response) => {
    response.writeHead(200, marker, { "Content-Type": "application/json", "X-Private-Collector": marker });
    response.flushHeaders();
    response.write(" " + JSON.stringify({ message: marker }));
    const timer = setInterval(() => { chunks++; response.write(" "); }, 20);
    response.once("close", () => { closed = true; clearInterval(timer); });
    t.after(() => clearInterval(timer));
  });
  const child = fileURLToPath(new URL("./telemetry-exporter-natural-child.ts", import.meta.url));
  const runner = spawn(process.execPath, [child, randomUUID(), randomUUID(), randomUUID(), secret], {
    env: {
      PATH: process.env.PATH,
      BIRBCREW_OTLP_TRACES_ENDPOINT: endpoint.url,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-collector-token=" + token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completed = once(runner, "close");
  const stdout = text(runner.stdout), stderr = text(runner.stderr);
  let forced = false;
  const guard = setTimeout(() => { forced = true; runner.kill("SIGKILL"); }, 7_000);
  t.after(() => {
    clearTimeout(guard);
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
  });
  const [code, signal] = await completed;
  clearTimeout(guard);
  const output = await stdout, warnings = await stderr;
  assert.equal(forced, false, "the child must exit without the emergency kill");
  assert.equal(code, 0, warnings);
  assert.equal(signal, null);
  const result = JSON.parse(output);
  assert.equal(result.value, true);
  assert.ok(result.flushed < 1_500, `turn flush took ${result.flushed} ms`);
  assert.equal(endpoint.requests(), 1);
  assert.ok(chunks >= 2, "body data continued while the export was pending");
  await delay(50);
  assert.equal(closed, true, "deadline disposal closes the collector connection");
  const lines = warnings.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, warnings);
  assert.match(lines[0], /^birbcrew: OTLP trace export failed \(timeout\) and its spans were dropped;/);
  for (const hidden of [marker, token, secret, endpoint.url, "127.0.0.1"]) {
    assert.ok(!output.includes(hidden) && !warnings.includes(hidden), hidden);
  }
});
