import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./telemetry-child.ts", import.meta.url));
type Run = { code: number | null; stdout: string; stderr: string };
type Received = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
type Attribute = { key: string; value: unknown };
type Span = { name: string; traceId: string; spanId: string; parentSpanId?: string; status: { code: number };
  attributes: Attribute[] };

// The module reads its configuration at import time, so each case runs in a fresh process.
function run(env: Record<string, string>, ids: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [child, ...ids], { env: { PATH: process.env.PATH, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
        stdout, stderr }));
  });
}

async function listen(t: TestContext, server: Server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function collector(t: TestContext, host?: string) {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    received.push({ method: request.method, url: request.url, headers: request.headers, body: await text(request) });
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  return { port: await listen(t, server, host), received };
}

const ids = () => [randomUUID(), randomUUID(), randomUUID()];
const string = (value: string) => ({ stringValue: value });
const sorted = (attributes: Attribute[]) => attributes.toSorted((a, b) => a.key.localeCompare(b.key));
const resources = (received: Received[]) =>
  received.flatMap((request) => JSON.parse(request.body).resourceSpans.map((batch: { resource: { attributes: Attribute[] } }) =>
    sorted(batch.resource.attributes)));
const spansOf = (received: Received[]): Span[] => received.flatMap((request) => JSON.parse(request.body).resourceSpans)
  .flatMap((batch) => batch.scopeSpans.flatMap((scope: { spans: Span[] }) => scope.spans));

function assertCorrelationOnly(span: Span, conversationId: string, requestId: string, workflowRunId: string) {
  assert.deepEqual(sorted(span.attributes), [
    { key: "conversationId", value: string(conversationId) }, { key: "engine", value: string("claude") },
    { key: "requestId", value: string(requestId) }, { key: "workflowRunId", value: string(workflowRunId) },
  ]);
}

// Startup failures must name the variable and never repeat what was in it.
function assertRefused(result: Run, message: RegExp, ...hidden: string[]) {
  assert.notEqual(result.code, 0, hidden[0]);
  assert.equal(result.stdout, "", hidden[0]);
  assert.match(result.stderr, message, hidden[0]);
  for (const value of hidden) assert.ok(!result.stderr.includes(value), value);
}

test("exports validated spans to an OTLP/HTTP collector beside the JSONL file", async (t) => {
  const { port, received } = await collector(t);
  const directory = await mkdtemp(join(tmpdir(), "birb-otlp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [conversationId, requestId, workflowRunId] = ids();
  const secret = "private-" + randomUUID(), token = "collector-" + randomUUID();
  const result = await run({
    BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
    BIRBCREW_TRACE_FILE: join(directory, "traces.jsonl"),
    OTEL_EXPORTER_OTLP_HEADERS: "x-collector-token=" + token,
  }, [conversationId, requestId, workflowRunId, secret]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const { value, exporterLoaded } = JSON.parse(result.stdout);
  assert.equal(value, true);
  assert.equal(exporterLoaded, true);
  assert.ok(!result.stdout.includes(token) && !result.stdout.includes(secret));

  assert.ok(received.length >= 1);
  for (const request of received) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/traces");
    assert.match(String(request.headers["content-type"]), /^application\/json/);
    assert.equal(request.headers["x-collector-token"], token);
    assert.ok(!request.body.includes(secret) && !request.body.includes("prompt") && !request.body.includes("apiKey"));
  }
  for (const attributes of resources(received)) assert.deepEqual(attributes, [{ key: "service.name", value: string("birbcrew") }]);
  const spans = spansOf(received);
  assert.deepEqual(spans.map((span) => span.name).sort(), ["model.invoke", "workflow.segment"]);
  const traceId = createHash("sha256").update(conversationId + "/" + requestId).digest("hex").slice(0, 32);
  const segment = spans.find((span) => span.name === "workflow.segment")!, invoke = spans.find((span) => span.name === "model.invoke")!;
  assert.ok(!segment.parentSpanId);
  assert.equal(invoke.parentSpanId, segment.spanId);
  for (const span of spans) {
    assert.equal(span.traceId, traceId);
    assert.equal(span.status.code, 1);
    assertCorrelationOnly(span, conversationId, requestId, workflowRunId);
  }

  const lines = (await readFile(join(directory, "traces.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.name, line.traceId, line.spanId]).sort(),
    spans.map((span) => [span.name, span.traceId, span.spanId]).sort());
});

test("plain http beyond 127.0.0.1 needs BIRBCREW_OTLP_TRACES_ALLOW_HTTP and carries the resource attributes", async (t) => {
  // A non-loopback interface address stands in for an in-cluster agent's service address. Without one, 127.0.0.2
  // (reachable on Linux, the only supported platform) still needs the opt-in, which allows only 127.0.0.1 without it.
  const host = Object.values(networkInterfaces()).flat()
    .find((address) => address && address.family === "IPv4" && !address.internal)?.address ?? "127.0.0.2";
  const { port, received } = await collector(t, host);
  const endpoint = `http://${host}:${port}/v1/traces`;
  const resource = {
    OTEL_SERVICE_NAME: "crew-worker",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production,service.version=1.2.3%2Bbuild.7",
  };

  for (const allow of [undefined, "false", "FALSE", ""]) {
    const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: endpoint, ...resource,
      ...(allow !== undefined && { BIRBCREW_OTLP_TRACES_ALLOW_HTTP: allow }) }, [...ids(), "private"]);
    assertRefused(result, /BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL/, endpoint, host);
  }
  assert.equal(received.length, 0);

  const [conversationId, requestId, workflowRunId] = ids();
  const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: endpoint, BIRBCREW_OTLP_TRACES_ALLOW_HTTP: "true", ...resource },
    [conversationId, requestId, workflowRunId, "private-" + randomUUID()]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).value, true);
  assert.ok(received.length >= 1);
  for (const request of received) {
    assert.equal(request.url, "/v1/traces");
    assert.match(String(request.headers["content-type"]), /^application\/json/);
  }
  for (const attributes of resources(received)) {
    assert.deepEqual(attributes, [
      { key: "deployment.environment.name", value: string("production") },
      { key: "service.name", value: string("crew-worker") },
      { key: "service.version", value: string("1.2.3+build.7") },
    ]);
  }
  for (const span of spansOf(received)) assertCorrelationOnly(span, conversationId, requestId, workflowRunId);

  // Any host name passes the check with the opt-in; this one cannot resolve, so the export fails and warns. Three
  // flushed rounds keep the process up past the export timeout, in case resolution hangs instead of failing.
  const named = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: "http://datadog-agent.default.svc.invalid:4318/v1/traces",
    BIRBCREW_OTLP_TRACES_ALLOW_HTTP: "True" }, [...ids(), "private", "exit", "3"]);
  assert.equal(named.code, 0, named.stderr);
  assert.match(named.stderr, /^birbcrew: OTLP trace export failed \([A-Za-z0-9_ ]+\) and its spans were dropped;[^\n]*\n$/);
  assert.ok(!named.stderr.includes("datadog-agent"));
});

test("a connection attempt that is never answered still warns once the export times out", async () => {
  // 192.0.2.1 (TEST-NET-1) is never routed: the connection attempt is dropped, or refused at once where there is
  // no route. node:http starts its request timeout only after connecting, so the first case needs Crew's own timer.
  const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: "http://192.0.2.1:4318/v1/traces", BIRBCREW_OTLP_TRACES_ALLOW_HTTP: "true" },
    [...ids(), "private", "exit", "3"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, true);
  const lines = result.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, result.stderr);
  assert.match(lines[0], /^birbcrew: OTLP trace export failed \((timeout|E[A-Z]+)\)/);
  assert.ok(!result.stderr.includes("192.0.2.1"));
});

test("the plain-http opt-in refuses collector headers and keeps every other endpoint rule", async (t) => {
  const { port, received } = await collector(t);
  const token = "collector-" + randomUUID();
  const host = "otel-agent.monitoring.svc", cleartext = `http://${host}:${port}/v1/traces`;
  const cases: [Record<string, string>, RegExp, string][] = [
    // A header usually carries an ingest key, which would cross the network unencrypted.
    [{ BIRBCREW_OTLP_TRACES_ENDPOINT: cleartext, OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=" + token },
      /OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS must be unset/, token],
    [{ BIRBCREW_OTLP_TRACES_ENDPOINT: cleartext, OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-api-key=" + token },
      /OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS must be unset/, token],
    // Only true or false; a typo must not silently mean either.
    ...["yes", "1", "on", "true " + token].map((allow): [Record<string, string>, RegExp, string] =>
      [{ BIRBCREW_OTLP_TRACES_ENDPOINT: cleartext, BIRBCREW_OTLP_TRACES_ALLOW_HTTP: allow },
        /BIRBCREW_OTLP_TRACES_ALLOW_HTTP must be true or false/, token]),
    ...[`ftp://${host}/v1/traces`, `http://operator:hunter2@${host}/v1/traces`,
      `http://${host}:${port}`, `http://[2001:db8::1]:${port}/v1/traces`,
      `http://${host}:${port}/v1/traces?api_key=hunter2`, `http://${host}:${port}/v1/traces#hunter2`]
      .map((endpoint): [Record<string, string>, RegExp, string] => [{ BIRBCREW_OTLP_TRACES_ENDPOINT: endpoint },
        /BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL/, endpoint]),
  ];
  const results = await Promise.all(cases.map(([env]) =>
    run({ BIRBCREW_OTLP_TRACES_ALLOW_HTTP: "true", ...env }, [...ids(), "private"])));
  results.forEach((result, index) => {
    const [, message, hidden] = cases[index];
    assertRefused(result, message, hidden, "hunter2", host);
  });
  assert.equal(received.length, 0);
});

test("resource attributes follow OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES", async (t) => {
  const { port, received } = await collector(t);
  const endpoint = `http://127.0.0.1:${port}/v1/traces`;
  const cases: [Record<string, string>, Record<string, string>][] = [
    // Spaces and tabs around keys, values and commas are ignored, empty entries are skipped, and values are
    // percent-decoded, including an encoded comma; a raw "=" belongs to the value.
    [{ OTEL_RESOURCE_ATTRIBUTES: " deployment.environment.name = staging ,\tservice.version=2.0%2C1 ,, k8s.pod.name=a=b," },
      { "deployment.environment.name": "staging", "k8s.pod.name": "a=b", "service.name": "birbcrew", "service.version": "2.0,1" }],
    // service.name may come from the attributes, but OTEL_SERVICE_NAME wins.
    [{ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attributes" }, { "service.name": "from-attributes" }],
    [{ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attributes", OTEL_SERVICE_NAME: "crew-gateway" }, { "service.name": "crew-gateway" }],
    [{ OTEL_RESOURCE_ATTRIBUTES: "team=birb%20crew%20%E2%9C%93", OTEL_SERVICE_NAME: "" }, { "service.name": "birbcrew", team: "birb crew ✓" }],
    // The bounds themselves are accepted.
    [{ OTEL_RESOURCE_ATTRIBUTES: Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(",") },
      { ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, "v"])), "service.name": "birbcrew" }],
    [{ OTEL_RESOURCE_ATTRIBUTES: "long=" + "%41".repeat(255), OTEL_SERVICE_NAME: "s".repeat(255) },
      { long: "A".repeat(255), "service.name": "s".repeat(255) }],
    // Lengths count code points: 255 birds are 510 UTF-16 units.
    [{ OTEL_RESOURCE_ATTRIBUTES: "birds=" + "%F0%9F%90%A6".repeat(255), OTEL_SERVICE_NAME: "🐦".repeat(255) },
      { birds: "🐦".repeat(255), "service.name": "🐦".repeat(255) }],
    // Whitespace around the whole value, such as a YAML block's final newline, is ignored.
    [{ OTEL_RESOURCE_ATTRIBUTES: "service.version=1.2.3\n", OTEL_SERVICE_NAME: " crew-worker\n" },
      { "service.name": "crew-worker", "service.version": "1.2.3" }],
  ];
  for (const [env, expected] of cases) {
    received.length = 0;
    const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: endpoint, ...env }, [...ids(), "private"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(received.length >= 1);
    const wanted = sorted(Object.entries(expected).map(([key, value]) => ({ key, value: string(value) })));
    for (const attributes of resources(received)) assert.deepEqual(attributes, wanted);
  }
});

test("malformed resource attributes stop startup without echoing them", async (t) => {
  const { port, received } = await collector(t);
  const marker = "hunter2";
  const entries = [
    marker, `=${marker}`, `${marker}=`, `bad key=${marker}`, `k="${marker}"`, `k=${marker};x`, `k=${marker}\\x`,
    `k=${marker} x`, `k=${marker}é`, `k=${marker}%zz`, `k=${marker}%E0%A4`, `k=${marker}%0A`, `k=${marker}%E2%80%AE`,
    `service.version=${marker}`, "k=" + marker + "x".repeat(256 - marker.length), "k".repeat(256) + "=" + marker,
    // Line and paragraph separators, blank values, and keys the SDK would drop because objects inherit them.
    `k=${marker}%E2%80%A8`, `k=${marker}%E2%80%A9`, "k=%20%20", `service.name=%20`, `toString=${marker}`,
    `constructor=${marker}`, `__proto__=${marker}`,
  ];
  const cases: [Record<string, string>, RegExp][] = [
    ...entries.map((value): [Record<string, string>, RegExp] =>
      [{ OTEL_RESOURCE_ATTRIBUTES: "service.version=1," + value }, /OTEL_RESOURCE_ATTRIBUTES entry \d is invalid/]),
    [{ OTEL_RESOURCE_ATTRIBUTES: Array.from({ length: 33 }, (_, i) => `k${i}=${marker}`).join(",") },
      /OTEL_RESOURCE_ATTRIBUTES must have at most 32 entries and 4096 characters/],
    [{ OTEL_RESOURCE_ATTRIBUTES: "k=" + marker + "x".repeat(4_096) },
      /OTEL_RESOURCE_ATTRIBUTES must have at most 32 entries and 4096 characters/],
    [{ OTEL_SERVICE_NAME: `crew\n${marker}` }, /OTEL_SERVICE_NAME must be at most 255 characters/],
    [{ OTEL_SERVICE_NAME: marker + "s".repeat(256) }, /OTEL_SERVICE_NAME must be at most 255 characters/],
  ];
  const results = await Promise.all(cases.map(([env]) =>
    run({ BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`, ...env }, [...ids(), "private"])));
  results.forEach((result, index) => assertRefused(result, cases[index][1], marker));
  // The second entry is the malformed one.
  for (const result of results.slice(0, entries.length)) assert.match(result.stderr, /entry 2 is invalid/);
  // Positions count every comma-separated part, empty ones included.
  const skipped = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
    OTEL_RESOURCE_ATTRIBUTES: `a=1,,${marker}` }, [...ids(), "private"]);
  assertRefused(skipped, /OTEL_RESOURCE_ATTRIBUTES entry 3 is invalid/, marker);
  assert.equal(received.length, 0);
});

test("an unreachable or silent collector cannot hold a flush past its budget", async (t) => {
  // Bound and released so connections are refused; nothing in this test binds it again.
  const refused = createServer().listen(0, "127.0.0.1");
  await once(refused, "listening");
  const closedPort = (refused.address() as AddressInfo).port;
  refused.close();
  await once(refused, "close");
  // Accepts connections and never answers.
  const silent = createServer(() => {});
  const silentPort = await listen(t, silent);
  const token = "collector-" + randomUUID();
  // Upper bounds sit well above each budget, for slow runners, and below the two-second export timeout that an
  // unbounded flush would wait for.
  for (const [flush, limit] of [["turn", 750], ["exit", 1_750]] as const) {
    for (const port of [closedPort, silentPort]) {
      const result = await run({
        BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`, OTEL_EXPORTER_OTLP_HEADERS: "x-collector-token=" + token,
      }, [...ids(), "private-" + randomUUID(), flush]);
      assert.equal(result.code, 0, result.stderr);
      const { value, flushed } = JSON.parse(result.stdout);
      assert.equal(value, true);
      assert.ok(flushed < limit, `${flush} flush to port ${port} took ${flushed} ms`);
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    }
  }
});

test("failed exports produce one warning line that names no address, status text or body", async (t) => {
  const planted = "planted-" + randomUUID();
  let requests = 0;
  const failing = createServer(async (request, response) => {
    requests++;
    await text(request);
    response.writeHead(500, planted, { "Content-Type": "application/json" }).end(JSON.stringify({ message: planted }));
  });
  const port = await listen(t, failing);
  const token = "collector-" + randomUUID(), secret = "private-" + randomUUID();
  // Three rounds, each flushed, so three exports fail inside one warning interval.
  const result = await run({
    BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`, OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-collector-token=" + token,
  }, [...ids(), secret, "exit", "3"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, true);
  assert.equal(requests, 3);
  const lines = result.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, result.stderr);
  assert.match(lines[0], /^birbcrew: OTLP trace export failed \(HTTP 500\) and its spans were dropped; the next warning/);
  for (const hidden of [planted, token, secret, "127.0.0.1", String(port)]) assert.ok(!result.stderr.includes(hidden), hidden);
});

test("a closed stderr cannot turn the export warning into a crash", async () => {
  const refused = createServer().listen(0, "127.0.0.1");
  await once(refused, "listening");
  const port = (refused.address() as AddressInfo).port;
  refused.close();
  await once(refused, "close");
  const runner = spawn(process.execPath, [child, ...ids(), "private", "exit", "2"], {
    env: { PATH: process.env.PATH, BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Closing the read end makes every later write to the child's stderr fail with EPIPE.
  runner.stderr.destroy();
  const stdout = text(runner.stdout);
  const [code] = await once(runner, "exit");
  assert.equal(code, 0);
  assert.equal(JSON.parse(await stdout).value, true);
});

test("the export warning is rate limited and reduces each error to a status or code", async () => {
  // The warning module reads no configuration, so it can load in this process whatever its environment holds.
  const { exportWarning } = await import("../../src/service/telemetry-warning.ts");
  let now = 0;
  const lines: string[] = [];
  const warn = exportWarning((line) => lines.push(line), () => now);
  const status = Object.assign(new Error("planted status text"), { code: 400, data: "planted body" });
  warn(status);
  now += 60_000;
  warn(Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:4318"), { code: "ECONNREFUSED" }));
  now += 239_999;
  warn(new Error("Request Timeout"));
  assert.equal(lines.length, 1);
  now += 1;
  warn(Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:4318"), { code: "ECONNREFUSED" }));
  now += 300_000;
  warn(new Error("Request Timeout"));
  now += 300_000;
  warn(new Error("Export failed with retryable status"));
  now += 300_000;
  warn(Object.assign(new Error("planted"), { code: "not a code 10.0.0.7" }));
  now += 300_000;
  warn(undefined);
  now += 300_000;
  warn(Object.assign(new Error("self-signed certificate planted.example"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
  assert.deepEqual(lines.map((line) => line.match(/failed \((.*?)\)/)?.[1]), ["HTTP 400", "ECONNREFUSED", "timeout",
    "HTTP 429, 502, 503 or 504", "unknown error", "unknown error", "DEPTH_ZERO_SELF_SIGNED_CERT"]);
  assert.match(lines[1], /; 2 more failed since the last warning;/);
  assert.ok(!lines[2].includes("more failed"));
  for (const line of lines) {
    assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
    assert.ok(!line.includes("planted") && !line.includes("10.0.0.7"));
  }
});

test("with no endpoint, OTLP settings are ignored and the exporter is never loaded", async (t) => {
  const { port, received } = await collector(t);
  const directory = await mkdtemp(join(tmpdir(), "birb-otlp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ignored = {
    BIRBCREW_OTLP_TRACES_ALLOW_HTTP: "maybe", OTEL_RESOURCE_ATTRIBUTES: "not valid", OTEL_SERVICE_NAME: "bad\nname",
  };
  for (const env of [{}, ignored, { ...ignored, BIRBCREW_TRACE_FILE: join(directory, "traces.jsonl") }]) {
    const result = await run(env, [...ids(), "private"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const { value, exporterLoaded } = JSON.parse(result.stdout);
    assert.equal(value, true);
    assert.equal(exporterLoaded, false);
  }
  assert.equal((await readFile(join(directory, "traces.jsonl"), "utf8")).trim().split("\n").length, 2);
  assert.equal(received.length, 0);
});

test("a malformed endpoint fails at startup without echoing it", async (t) => {
  const { port, received } = await collector(t);
  for (const value of ["collector:4318/v1/traces", "not a url", `ftp://127.0.0.1:${port}/v1/traces`,
    `http://operator:hunter2@127.0.0.1:${port}/v1/traces`, `http://127.0.0.1:${port}`, `https://127.0.0.1:${port}/`,
    // Plain http beyond numeric loopback needs the explicit opt-in.
    `http://collector.example:${port}/v1/traces`, `http://localhost:${port}/v1/traces`,
    // The exporter cannot resolve a bracketed IPv6 host, so these would export nothing.
    `http://[::1]:${port}/v1/traces`, "https://[2001:db8::1]/v1/traces",
    // The exporter would drop these silently.
    `https://127.0.0.1:${port}/v1/traces?api_key=hunter2`, `https://127.0.0.1:${port}/v1/traces#hunter2`]) {
    const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: value }, [...ids(), "private"]);
    assertRefused(result, /BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL/, value, "hunter2");
  }
  assert.equal(received.length, 0);
});

test("an https endpoint on any host is accepted", async () => {
  const result = await run({ BIRBCREW_OTLP_TRACES_ENDPOINT: "https://collector.invalid/v1/traces" }, [...ids(), "private", "turn"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, true);
});
