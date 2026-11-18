import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const child = fileURLToPath(new URL("./telemetry-agent-child.ts", import.meta.url));
const ids = () => [randomUUID(), randomUUID(), randomUUID()];
const attribute = z.object({ key: z.string(), value: z.union([z.object({ stringValue: z.string() }),
  z.object({ intValue: z.union([z.string(), z.number()]) }), z.object({ boolValue: z.boolean() })]) });
const otlp = z.object({ resourceSpans: z.array(z.object({ resource: z.object({ attributes: z.array(attribute) }),
  scopeSpans: z.array(z.object({ scope: z.object({ name: z.string(), version: z.string().optional() }),
    spans: z.array(z.object({ name: z.string(), traceId: z.string(), spanId: z.string(), parentSpanId: z.string().optional(),
      status: z.object({ code: z.number().optional() }), attributes: z.array(attribute) })) })) })) });
const row = z.object({ name: z.string(), traceId: z.string(), spanId: z.string(), parent: z.string().optional(),
  status: z.number(), attributes: z.record(z.string(), z.union([z.string(), z.number()])) });
const operational = new Set(["workflow.segment", "model.invoke", "native.restore", "tool.settle"]);
const attributes = (values: z.infer<typeof attribute>[]) => Object.fromEntries(values.map(({ key, value }) =>
  [key, "stringValue" in value ? value.stringValue : "intValue" in value ? Number(value.intValue) : value.boolValue]));
function run(env: Record<string, string>, mode = "success", engine = "claude", provider = "anthropic", correlation = ids()) {
  const secret = "private-" + randomUUID();
  return new Promise<{ code: number | string | null; stdout: string; stderr: string; secret: string }>(resolve => {
    execFile(process.execPath, [child, mode, engine, provider, ...correlation, secret],
      { env: { PATH: process.env.PATH, ...env }, timeout: 15_000 }, (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, stdout, stderr, secret }));
  });
}
async function fixture(t: TestContext) {
  const received: { path?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer(async (request, response) => {
    received.push({ path: request.url, headers: request.headers, body: await text(request) });
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "crew-agent-trace-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, "trace.jsonl");
  return { received, base: `http://127.0.0.1:${address.port}`, file,
    env: { BIRBCREW_TRACE_FILE: file, BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces` } };
}
const fileRows = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(line => row.parse(JSON.parse(line)));
const network = (received: { body: string }[]) => received.flatMap(({ body }) => otlp.parse(JSON.parse(body)).resourceSpans)
  .flatMap(batch => batch.scopeSpans.flatMap(scope => scope.spans.map(span => ({ ...span, attributes: attributes(span.attributes),
    scope: scope.scope, resource: attributes(batch.resource.attributes) }))));
const expectedTrace = (conversation: string, request: string) => createHash("sha256").update(conversation + "/" + request).digest("hex").slice(0, 32);
function successful(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).preserved, true);
  assert.ok(!result.stdout.includes(result.secret));
}

for (const [engine, provider] of [["codex", "openai"], ["claude", "anthropic"], ["pi", "google"]]) {
  test(`${engine} agent observations preserve all returned variants, native errors, metadata, and operational usage`, async t => {
    const f = await fixture(t), correlation = ids();
    const result = await run(f.env, "success", engine, provider, correlation);
    successful(result);
    const local = await fileRows(f.file), remote = network(f.received);
    assert.equal(local.length, 13);
    assert.deepEqual(remote.map(span => span.spanId).sort(), local.map(span => span.spanId).sort());
    assert.ok(!JSON.stringify(f.received).includes(result.secret));
    assert.ok(!(await readFile(f.file, "utf8")).includes(result.secret));
    const agents = remote.filter(span => span.name === `invoke_agent ${engine}`);
    assert.equal(agents.length, 4);
    assert.ok(remote.every(span => operational.has(span.name) || span.name === `invoke_agent ${engine}`));
    for (const span of agents) {
      const error = span.attributes["switchboard.outcome"] === "error";
      assert.deepEqual(span.scope, { name: "@mattsp1290/switchboard", version: "0.0.0" });
      assert.deepEqual(span.attributes, { "gen_ai.agent.name": engine, "gen_ai.provider.name": provider,
        "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": correlation[0],
        "switchboard.run_id": correlation[2], "switchboard.request_id": correlation[1],
        "switchboard.outcome": error ? "error" : "success", ...(error && { "error.type": "unknown-error" }) });
      assert.equal(span.status.code ?? 0, error ? 2 : 0);
      assert.equal(span.traceId, expectedTrace(correlation[0], correlation[1]));
      assert.equal(span.resource.dd_llmobs_enabled, undefined);
      if (!error) assert.equal(remote.find(parent => parent.spanId === span.parentSpanId)?.name, "model.invoke");
      else assert.ok(!span.parentSpanId);
    }
    for (const span of remote.filter(span => span.name === "model.invoke")) {
      assert.equal(span.attributes["usage.input_tokens"], 31);
      assert.equal(span.attributes["usage.output_tokens"], 7);
      assert.equal(span.attributes["usage.state"], "reported");
    }
    for (const request of f.received) assert.match(String(request.headers["content-type"]), /^application\/json/);
  });
}

test("nested, mismatched, standalone and concurrent scopes keep their own correlation and parent context", async t => {
  const f = await fixture(t);
  successful(await run(f.env, "nested"));
  const rows = await fileRows(f.file);
  const byId = new Map(rows.map(span => [span.spanId, span]));
  const agents = rows.filter(span => span.name === "invoke_agent claude");
  assert.equal(agents.length, 15);
  assert.equal(agents.filter(span => !span.parent).length, 1);
  assert.equal(agents.filter(span => span.parent && byId.get(span.parent)?.name === "invoke_agent claude").length, 1);
  for (const span of rows) {
    if (span.parent) assert.equal(byId.get(span.parent)?.traceId, span.traceId);
    if (span.name === "tool.settle") {
      const parent = byId.get(span.parent ?? "");
      assert.equal(parent?.name, "invoke_agent claude");
      assert.equal(parent?.attributes["switchboard.request_id"], span.attributes.requestId);
      assert.equal(parent?.attributes["switchboard.run_id"], span.attributes.workflowRunId);
    }
  }
  assert.equal(new Set(agents.map(span => span.traceId)).size, 14);
});

test("observer capacity rejection executes every native call once and finishes accepted spans", async t => {
  const f = await fixture(t);
  const result = await run(f.env, "capacity");
  successful(result);
  assert.equal(JSON.parse(result.stdout).calls, 129);
  const rows = await fileRows(f.file);
  assert.equal(rows.length, 128);
  assert.ok(rows.every(span => span.attributes["switchboard.outcome"] === "success"));
});

for (const mode of ["start-failure", "finish-failure"]) {
  test(`${mode} keeps exact native values, thrown identity and entry counts`, async t => {
    const f = await fixture(t);
    const result = await run(f.env, mode);
    successful(result);
    assert.equal(JSON.parse(result.stdout).calls, 4);
    const rows = await fileRows(f.file);
    assert.equal(rows.filter(span => span.name === "model.invoke").length, 3);
    assert.ok(!rows.some(span => span.name.startsWith("invoke_agent")));
  });
}

test("disabled and invalid observations preserve native work without emitting spans", async t => {
  successful(await run({}, "disabled"));
  const f = await fixture(t);
  successful(await run(f.env, "invalid"));
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.equal(f.received.length, 0);
});

test("Datadog conversion adds bounded metadata and a boolean resource only on network views", async t => {
  const f = await fixture(t), correlation = ids();
  successful(await run({ ...f.env, BIRBCREW_DATADOG_LLMOBS: "true", OTEL_RESOURCE_ATTRIBUTES: "dd_llmobs_enabled=false" },
    "success", "claude", "anthropic", correlation));
  const remote = network(f.received), local = await fileRows(f.file);
  for (const span of remote) {
    assert.strictEqual(span.resource.dd_llmobs_enabled, true);
    const own = local.find(row => row.spanId === span.spanId);
    assert.ok(own);
    const { "_dd.ml_obs.metadata": metadata, ...original } = span.attributes;
    assert.deepEqual(original, own.attributes);
    if (span.name.startsWith("invoke_agent")) assert.deepEqual(JSON.parse(String(metadata)), { switchboard: {
      outcome: span.attributes["switchboard.outcome"], run_id: correlation[2], request_id: correlation[1] } });
    else assert.equal(metadata, undefined);
    assert.equal(own.attributes["_dd.ml_obs.metadata"], undefined);
  }
});

test("endpoint precedence and generic path semantics select one destination", async t => {
  const f = await fixture(t);
  for (const [env, expected] of [
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: f.base }, "/v1/traces"],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: f.base + "/otel/" }, "/otel/v1/traces"],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "invalid-secret", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: f.base + "/signal" }, "/signal"],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "invalid-secret", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "invalid-secret",
      BIRBCREW_OTLP_TRACES_ENDPOINT: f.base + "/crew" }, "/crew"],
  ] satisfies [Record<string, string>, string][]) {
    f.received.length = 0;
    successful(await run(env, "error"));
    assert.ok(f.received.length > 0);
    assert.ok(f.received.every(request => request.path === expected));
  }
});

test("selected malformed endpoints, Datadog flags and inherited headers fail without values in diagnostics", async t => {
  const f = await fixture(t), secret = "private-config-" + randomUUID();
  const cases: [Record<string, string>, string][] = [
    ...["BIRBCREW_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"]
      .map((key): [Record<string, string>, string] => [{ [key]: "https://user:" + secret + "@private.invalid" }, key]),
    [{ BIRBCREW_DATADOG_LLMOBS: secret }, "BIRBCREW_DATADOG_LLMOBS must be true or false"],
    [{ BIRBCREW_DATADOG_LLMOBS: "true" }, "BIRBCREW_DATADOG_LLMOBS requires an OTLP traces endpoint"],
    ...["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"].map((key): [Record<string, string>, string] =>
      [{ ...f.env, BIRBCREW_DATADOG_LLMOBS: "true", [key]: "x-token=" + secret }, "BIRBCREW_DATADOG_LLMOBS requires"]),
  ];
  for (const [env, expected] of cases) {
    const result = await run(env);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(expected), result.stderr);
    assert.ok(!result.stderr.includes(secret));
  }
  assert.equal(f.received.length, 0);
});
