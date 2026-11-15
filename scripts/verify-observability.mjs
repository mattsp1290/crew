import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);

if (process.argv[2] === 'produce') {
  const { observedAgent, traced, flushTelemetry } = await import('../src/service/telemetry.ts');
  const secret = `private-observability-fixture-${randomUUID()}`;
  let invocations = 0;
  for (const [engine, provider] of [['claude', 'anthropic'], ['codex', 'openai'], ['pi', 'openai']]) {
    for (const fails of [false, true]) {
      const scope = { engine, provider, conversationId: randomUUID(), requestId: randomUUID(), workflowRunId: randomUUID() };
      const failure = new Error(secret);
      const result = { text: secret };
      try {
        const actual = await traced('workflow.segment', scope, () => traced('model.invoke', scope,
          () => observedAgent(scope, async () => {
            invocations++;
            await delay(10);
            if (fails) throw failure;
            return result;
          })));
        assert.equal(fails, false);
        assert.equal(actual, result);
      } catch (error) {
        assert.equal(fails, true);
        assert.equal(error, failure);
      }
    }
  }
  assert.equal(invocations, 6);
  await flushTelemetry();
  process.stdout.write(JSON.stringify({ invocations }));
  process.exit(0);
}

async function command(program, args) {
  const result = await execute(program, args, {
    cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DD_SITE: process.env.DD_SITE ?? 'us3.datadoghq.com' },
  });
  return result.stdout;
}

async function pup(args) {
  const result = JSON.parse(await command(process.env.PUP_BIN ?? 'pup', ['llm-obs', 'spans', ...args, '--output=json']));
  assert.equal(result.status, 'success', 'Datadog query succeeds');
  return result.data;
}

async function apm(service) {
  const result = JSON.parse(await command(process.env.PUP_BIN ?? 'pup',
    ['traces', 'search', `--query=service:${service}`, '--from=1h', '--limit=100', '--output=json']));
  assert.equal(result.status, 'success', 'APM query succeeds');
  assert(Array.isArray(result.data));
  return result.data.map(item => item.attributes);
}

function sameId(backend, otel) {
  return typeof backend === 'string' &&
    (backend.toLowerCase() === otel.toLowerCase() || backend === BigInt(`0x${otel}`).toString());
}

function assertPrivate(value) {
  assert(!JSON.stringify(value).includes('private-observability-fixture-'), 'fixture content is absent');
}

const lotel = process.env.LOTEL_BIN;
const lotelEndpoint = process.env.LOTEL_ENDPOINT;
const datadogEndpoint = process.env.DATADOG_OTLP_ENDPOINT;
assert(lotel && lotelEndpoint && datadogEndpoint,
  'Set LOTEL_BIN, LOTEL_ENDPOINT and DATADOG_OTLP_ENDPOINT for two required live destinations');
for (const endpoint of [lotelEndpoint, datadogEndpoint]) {
  const url = new URL(endpoint);
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !url.search && !url.hash,
    'Qualification destinations must be local HTTP receivers without credentials');
}

const directory = resolve(root, process.env.OBSERVABILITY_REPORT_DIR ?? '.proof/genai-observability');
await mkdir(directory, { recursive: true });
const service = `crew-observability-${randomUUID()}`;
const traceFile = resolve(directory, `${service}.jsonl`);
const report = { status: 'failed', fixture: 'synthetic host invocation boundaries', service,
  stage: 'produce', startedAt: new Date().toISOString(), node: process.version,
  lotelVersion: (await command(lotel, ['--version'])).trim() };
report.sourceSha256 = Object.fromEntries(await Promise.all([
  'src/service/telemetry.ts', 'src/service/telemetry-datadog.ts', 'src/service/supervisor-runner.ts',
  'package-lock.json', 'scripts/verify-observability.mjs',
].map(async path => [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])));
if (process.env.LOTEL_BUILD_BINARY) {
  const build = await command('go', ['version', '-m', process.env.LOTEL_BUILD_BINARY]);
  assert(build.includes('vcs.modified=false'), 'lotel binary comes from clean source');
  report.lotelRevision = /vcs.revision=([0-9a-f]{40})/.exec(build)?.[1];
  assert(report.lotelRevision, 'lotel binary identifies its source revision');
}
const forwarded = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/traces');
    const body = await text(request);
    assertPrivate(body);
    const statuses = await Promise.all([lotelEndpoint, datadogEndpoint].map(async endpoint => {
      const result = await fetch(endpoint, { method: 'POST', body,
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000) });
      await result.arrayBuffer();
      assert.equal(result.status, 200, 'OTLP destination accepts the batch');
      return result.status;
    }));
    forwarded.push(statuses);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  } catch {
    response.writeHead(503).end();
  }
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const result = await execute(process.execPath, [script, 'produce'], {
    cwd: root, timeout: 20_000,
    env: { PATH: process.env.PATH, BIRBCREW_TRACE_FILE: traceFile, OTEL_SERVICE_NAME: service,
      BIRBCREW_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`, BIRBCREW_DATADOG_LLMOBS: 'true' },
  });
  assert.equal(result.stderr, '', 'producer exports without warnings');
  assert.equal(JSON.parse(result.stdout).invocations, 6);
  assert(forwarded.length > 0, 'both destinations received actual exporter output');
  report.endedAt = new Date().toISOString();
  const spans = (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(spans.length, 18, 'six invocations retain both operational parents');
  assertPrivate(spans);
  const agents = spans.filter(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent');
  assert.equal(agents.length, 6, 'one agent span per observed invocation');
  assert.equal(agents.filter(span => span.attributes['switchboard.outcome'] === 'success').length, 3,
    'the three successful fixture callbacks are recorded as successes');
  assert.equal(agents.filter(span => span.attributes['switchboard.outcome'] === 'error').length, 3,
    'the three throwing fixture callbacks are recorded as errors');
  for (const engine of ['claude', 'codex', 'pi']) {
    const outcomes = agents.filter(span => span.attributes['gen_ai.agent.name'] === engine)
      .map(span => span.attributes['switchboard.outcome']).sort();
    assert.deepEqual(outcomes, ['error', 'success'], 'each engine preserves one success and one thrown failure');
  }
  for (const agent of agents) {
    const parent = spans.find(span => span.spanId === agent.parent);
    assert(parent && parent.name === 'model.invoke' && parent.traceId === agent.traceId, 'operational parent retained');
    const failed = parent.status === 2;
    assert.equal(agent.attributes['switchboard.outcome'], failed ? 'error' : 'success',
      'agent outcomes match the independently recorded native promise outcome');
    assert.equal(agent.status, failed ? 2 : 0);
    assert.equal(agent.attributes['gen_ai.usage.input_tokens'], undefined);
    assert.equal(agent.attributes['gen_ai.usage.output_tokens'], undefined);
  }

  report.stage = 'lotel';
  let calls = [], raw = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    await command(lotel, ['ingest']);
    calls = JSON.parse(await command(lotel, ['query', 'genai', 'calls', '--service', service, '--since', '1h', '--limit', '100', '--content']));
    raw = JSON.parse(await command(lotel, ['query', 'traces', '--service', service, '--since', '1h', '--limit', '100']));
    if (calls.length === agents.length && raw.length === spans.length) break;
    await delay(1_000);
  }
  assert.equal(raw.length, 18, 'lotel stores every original span');
  assert.equal(calls.length, 6, 'lotel recognizes each agent observation');
  assertPrivate({ calls, raw });
  for (const expected of agents) {
    const call = calls.find(item => item.span_id === expected.spanId);
    const stored = raw.find(item => item.span_id === expected.spanId);
    assert(call && stored, 'lotel retains original span identity');
    assert.equal(call.trace_id, expected.traceId);
    assert.equal(call.parent_span_id, expected.parent);
    assert.equal(call.operation, 'invoke_agent');
    assert.equal(call.provider, expected.attributes['gen_ai.provider.name']);
    assert.equal(call.input_tokens, null);
    assert.equal(call.output_tokens, null);
    assert.equal(stored.attributes['switchboard.outcome'], expected.attributes['switchboard.outcome']);
  }
  report.lotel = { status: 'passed', spans: raw.length, agents: calls.length,
    usage: JSON.parse(await command(lotel, ['query', 'genai', 'usage', '--service', service, '--since', '1h'])) };
  const services = JSON.parse(await command(lotel, ['query', 'services', '--since', '1h']));
  assert(services.some(item => item.service_name === service), 'lotel discovers the emitted service');
  const operations = JSON.parse(await command(lotel, ['query', 'operations', '--service', service, '--since', '1h']));
  for (const expected of agents) assert(operations.some(item => item.name === expected.name), 'lotel discovers agent operations');
  process.stdout.write('lotel preserved all 18 spans and recognized six agent invocations.\n');

  report.stage = 'datadog';
  let indexed = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const data = await pup(['search', `--ml-app=${service}`, '--from=1h', '--limit=100']);
    assert(Array.isArray(data.spans));
    indexed = data.spans;
    if (agents.every(expected => indexed.some(item => sameId(item.span_id, expected.spanId)))) break;
    if (attempt % 6 === 0) process.stdout.write('Waiting for Datadog LLM Observability indexing.\n');
    await delay(5_000);
  }
  assert.equal(indexed.length, agents.length, 'Datadog converts exactly the observed agent spans');
  const associations = [];
  const originalSpans = await apm(service);
  let indexedParents = 0;
  for (const expected of agents) {
    const stored = indexed.find(item => sameId(item.span_id, expected.spanId));
    assert(stored, 'Datadog converted each original agent span');
    assert(sameId(stored.apm_trace_id, expected.traceId), 'Datadog links the converted trace to the original OTel trace');
    assert.equal(stored.span_kind, 'agent');
    assert.equal(stored.name, expected.attributes['gen_ai.agent.name']);
    assert.equal(stored.session_id, expected.attributes['gen_ai.conversation.id']);
    assert.equal(stored.status === 'error', expected.attributes['switchboard.outcome'] === 'error');
    assert(stored.llm_info?.input_tokens == null && stored.llm_info?.output_tokens == null,
      'Datadog agent spans do not invent model-request token usage');
    const original = originalSpans.find(item => sameId(item.span_id, expected.spanId));
    if (original) {
      assert(sameId(original.trace_id, expected.traceId), 'Indexed APM spans retain original agent identity');
      assert(sameId(original.parent_id, expected.parent), 'Indexed APM spans retain original operational parent');
      indexedParents++;
    }
    const data = await pup(['get-content', `--trace-id=${stored.trace_id}`, `--span-id=${stored.span_id}`,
      '--field=metadata', '--max-tokens=4096', '--from=1h']);
    assert.equal(data.is_truncated, false);
    assert.equal(data.content?.switchboard?.outcome, expected.attributes['switchboard.outcome']);
    assert.equal(data.content?.switchboard?.run_id, expected.attributes['switchboard.run_id']);
    assert.equal(data.content?.switchboard?.request_id, expected.attributes['switchboard.request_id']);
    const content = await Promise.all(['input', 'output'].map(field => pup(['get-content',
      `--trace-id=${stored.trace_id}`, `--span-id=${stored.span_id}`, `--field=${field}`, '--max-tokens=4096', '--from=1h'])));
    for (const value of content) assert.equal(value.is_truncated, false);
    assertPrivate({ stored, data, content });
    associations.push({ traceId: expected.traceId, spanId: expected.spanId,
      llmTraceId: stored.trace_id, apmIndexed: Boolean(original), outcome: data.content.switchboard.outcome });
  }
  assert(indexedParents > 0, 'At least one original APM parent relationship is independently queryable');
  report.datadog = { status: 'passed', agents: associations.length,
    indexedApmParents: indexedParents, unindexedApmAgents: agents.length - indexedParents, associations };
  report.status = 'passed';
  report.stage = 'complete';
  process.stdout.write('Datadog converted all six agent spans and retained their outcomes and correlation.\n');
} catch (error) {
  report.failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'External command or export failed';
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  await writeFile(resolve(directory, 'backends.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
