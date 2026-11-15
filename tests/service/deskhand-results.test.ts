import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import {
  createResultBoundary, endpointIdentity, holderId, operationId, frameId, displayId,
  type AppIdentity, type CallerLease, type DesktopStatus, type DisplayCatalog, type ScreenshotObservation,
  type PointerCompletion, type KeyboardCompletion, type PointerErrorMeasurement, type KeyboardErrorMeasurement,
  type ExpectedPointer, type ExpectedReply, type OperationRecord, type ToolError, type ToolName, type KnownDiagnostics, type LeaseOutcome, type ResultBoundary,
} from '../../src/service/deskhand/contract.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const examples = join(root, 'vendor/deskhand/contract-v0.11-draft/docs/schemas/examples');
const context = { endpoint: endpointIdentity('https://fixture.invalid/mcp'), holderId: holderId('crew-fixture'), expectedMac: 'lunus-macbook-pro' };
const boundary = createResultBoundary(context);
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function fixture(name: string): Record<string, unknown> { return object(JSON.parse(readFileSync(join(examples, name), 'utf8'))); }
function wrap(tool: string, wire: Record<string, unknown>, id: string | number = 17) {
  const isError = Object.hasOwn(wire, 'code');
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', isError, structuredContent: wire,
    content: [...(tool === 'screenshot' && !isError ? [{ type: 'image', data: 'corpus-placeholder', mimeType: wire.mime_type }] : []), { type: 'text', text: JSON.stringify(wire) }] } };
}
const fallback = fixture('pointer.output.completed.json');
function expectedInput(wire: Record<string, unknown>) {
  return { operationId: operationId(wire.operation_id ?? fallback.operation_id), frame: {
    ...context, frameId: frameId(wire.frame_id ?? fallback.frame_id), displayId: displayId(1),
  } };
}
function wireApp(app: AppIdentity) { return { bundle_id: app.bundleId, team_id: app.teamId, name: app.name }; }
function wirePoint(point: { readonly x: number; readonly y: number } | null) { return point === null ? null : { x: point.x, y: point.y }; }
function wireLease(lease: CallerLease) {
  return lease.kind === 'not-held-by-caller' ? { held_by_caller: false } : {
    held_by_caller: true, acquired_at: lease.acquiredAt, expires_at: lease.expiresAt, expires_in_ms: lease.expiresInMs,
  };
}
function wireOperation(record: OperationRecord) { return { status: record.status, events_posted: record.events.value }; }
function wireStatus(status: DesktopStatus) {
  const limits = status.limits;
  return { contract_version: status.contractVersion, mcp_protocol_version: status.mcpProtocolVersion, server_version: status.serverVersion,
    mac: status.mac, time: status.time, started_at: status.startedAt, state: status.state, active_states: status.activeStates,
    conditions: status.conditions, armed_until: status.armedUntil, lease: status.lease.kind === 'unscoped' ? null : wireLease(status.lease.lease),
    display_config_generation: status.displayGeneration, limits: {
      max_long_edge: limits.maxLongEdge, min_long_edge: limits.minLongEdge, max_pixels: limits.maxPixels, max_image_bytes: limits.maxImageBytes,
      frame_max_age_ms: limits.frameMaxAgeMs, user_activity_lookback_ms: limits.userActivityLookbackMs, actions_per_minute: limits.actionsPerMinute,
      lease_ttl_min_ms: limits.leaseTtlMinMs, lease_ttl_max_ms: limits.leaseTtlMaxMs, keyboard_max_text_length: limits.keyboardMaxTextLength,
      operation_retention_ms: limits.operationRetentionMs, operation_max_records: limits.operationMaxRecords,
    } };
}
function wireDisplays(catalog: DisplayCatalog) {
  return { display_config_generation: catalog.generation, displays: catalog.displays.map((display) => ({
    display_id: display.id, uuid: display.uuid, name: display.name, is_main: display.isMain, is_builtin: display.isBuiltin,
    asleep: display.asleep, bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
    pixel_size: display.pixels, point_pixel_scale: display.pointPixelScale,
  })) };
}
function wireScreenshot(observation: ScreenshotObservation) {
  const metadata = observation.metadata;
  return { frame_id: metadata.frameId, sha256: metadata.sha256, display_id: metadata.displayId, display_config_generation: metadata.displayGeneration,
    capture_rect: { x: metadata.capture.x, y: metadata.capture.y, width: metadata.capture.width, height: metadata.capture.height },
    source_pixel_size: metadata.sourcePixels, output_pixel_size: metadata.outputPixels, point_pixel_scale: metadata.pointPixelScale,
    downscale: metadata.downscale, format: metadata.encoding.kind, mime_type: metadata.encoding.mime,
    ...(metadata.encoding.kind === 'jpeg' ? { jpeg_quality: metadata.encoding.quality } : {}), image_bytes: metadata.encoding.bytes,
    captured_at: metadata.capturedAt, max_age_ms: metadata.maxAgeMs, pointer_position: wirePoint(metadata.pointer), frontmost_app: wireApp(metadata.frontmost) };
}
function wireMeasurement(measured: PointerErrorMeasurement | KeyboardErrorMeasurement | PointerCompletion['measured'] | KeyboardCompletion['measured']) {
  const end = 'end' in measured ? measured.end : undefined;
  const drag = end && 'kind' in end ? end.kind === 'present' ? end.value : undefined : end;
  return { frontmost_app: wireApp(measured.frontmost), target_app: measured.target === null ? null : wireApp(measured.target),
    window_title: measured.windowTitle, global_point: wirePoint(measured.globalPoint), measured_at: measured.measuredAt,
    ...(drag ? { drag_end: { target_app: wireApp(drag.target), window_title: drag.windowTitle, global_point: wirePoint(drag.globalPoint) } } : {}) };
}
function wireCompletion(completion: PointerCompletion | KeyboardCompletion) {
  return { operation_id: completion.operationId, frame_id: completion.frameId, status: completion.status, events_posted: completion.events.value,
    replayed: completion.replayed, completed_at: completion.completedAt, measured: wireMeasurement(completion.measured) };
}
function wireDiagnostics(details: KnownDiagnostics) {
  return { ...(details.reason === undefined ? {} : { reason: details.reason }), ...(details.argument === undefined ? {} : { argument: details.argument }),
    ...(details.pointIndex === undefined ? {} : { point_index: details.pointIndex }), ...(details.outputPixels === undefined ? {} : { output_pixel_size: details.outputPixels }),
    ...(details.imageBytes === undefined ? {} : { image_bytes: details.imageBytes }), ...(details.maxImageBytes === undefined ? {} : { max_image_bytes: details.maxImageBytes }),
    ...(details.idleMs === undefined ? {} : { idle_ms: details.idleMs }), ...(details.deniedBy === undefined ? {} : { denied_by: details.deniedBy }),
    ...(details.shortcut === undefined ? {} : { shortcut: details.shortcut }), ...(details.otherLeaseExpiresInMs === undefined ? {} : { expires_in_ms: details.otherLeaseExpiresInMs }) };
}
function wireError(error: ToolError<ToolName>) {
  const evidence = error.evidence;
  const retry = error.retryAfterMs;
  return { code: error.code, message: error.message, state: evidence.kind === 'replay' ? evidence.originalState : evidence.state,
    ...(evidence.kind === 'not-admitted' ? {} : { replayed: evidence.kind === 'replay' }),
    ...(evidence.kind === 'replay' ? { current_state: evidence.currentState } : {}),
    ...(error.reportedOperationId.kind === 'present' ? { operation_id: error.reportedOperationId.value } : {}),
    ...(error.operation.kind === 'present' ? { operation: wireOperation(error.operation.value) } : {}),
    ...(error.measured.kind === 'present' ? { measured: wireMeasurement(error.measured.value) } : {}),
    ...(typeof retry === 'number' ? { retry_after_ms: retry } : retry.kind === 'present' ? { retry_after_ms: retry.value } : {}),
    ...(error.details ? { details: wireDiagnostics(error.details) } : {}) };
}
function wireLeaseOutcome(outcome: LeaseOutcome) {
  return { lease: wireLease(outcome.lease), lease_result: { op: outcome.operation,
    outcome: outcome.kind === 'held' ? outcome.outcome : outcome.kind === 'not-held' ? 'not_held' : outcome.kind,
    ...(outcome.kind === 'refused' ? { code: outcome.refusal.code, ...(outcome.refusal.code === 'lease_held_by_other' ? { expires_in_ms: outcome.refusal.otherExpiresInMs } : {}) } : {}) } };
}
function observe({ tool, expectationSeed: wire, receivedReply: raw = wrap(tool, wire), requestId = 17, owner = boundary }: {
  tool: string;
  expectationSeed: Record<string, unknown>;
  receivedReply?: unknown;
  requestId?: string | number;
  owner?: ResultBoundary;
}) {
  const expected = { requestId };
  switch (tool) {
    case 'status': {
      if (Object.hasOwn(wire, 'operation')) {
        const result = owner.lookup(raw, { ...expected, operationId: operationId(fallback.operation_id) });
        return { result, reconstructed: result.kind === 'ok' ? { ...wireStatus(result.value.status), operation: result.value.record.kind === 'not-recorded-now' ? null : wireOperation(result.value.record) } : result.kind === 'tool-error' ? wireError(result.error) : undefined };
      }
      const result = owner.status(raw, { ...expected, holder: wire.lease === null ? 'no-holder' : 'configured-holder' });
      return { result, reconstructed: result.kind === 'ok' ? wireStatus(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    case 'displays': {
      const result = owner.displays(raw, expected);
      return { result, reconstructed: result.kind === 'ok' ? wireDisplays(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    case 'screenshot': {
      const result = owner.screenshot(raw, { ...expected, displayId: { kind: 'absent' } });
      return { result, reconstructed: result.kind === 'ok' ? wireScreenshot(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    case 'lease': {
      const operation = wire.lease_result ? object(wire.lease_result).op : 'acquire';
      assert(operation === 'acquire' || operation === 'renew' || operation === 'release');
      const result = owner.lease(raw, { ...expected, operation });
      return { result, reconstructed: result.kind === 'ok' ? wireLeaseOutcome(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    case 'pointer': {
      const result = owner.pointer(raw, { ...expected, ...expectedInput(wire), action: wire.measured && Object.hasOwn(object(wire.measured), 'drag_end') ? 'drag' : 'target' });
      return { result, reconstructed: result.kind === 'ok' ? wireCompletion(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    case 'keyboard': {
      const result = owner.keyboard(raw, { ...expected, ...expectedInput(wire) });
      return { result, reconstructed: result.kind === 'ok' ? wireCompletion(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    default: throw new Error('unknown-test-tool');
  }
}

for (const name of readdirSync(examples).filter((name) => /^[a-z]+\.output\./.test(name))) {
  test(`preserves every known fact in ${name}`, () => {
    const wire = fixture(name);
    const observed = observe({ tool: name.split('.')[0], expectationSeed: wire });
    assert.notEqual(observed.result.kind, 'rejected');
    assert.deepEqual(observed.reconstructed, wire);
  });
}
for (const name of readdirSync(join(examples, 'wire')).filter((name) => /^tools-call\.[a-z]+\..*\.response\.json$/.test(name))) {
  test(`accepts pinned wire relationship ${name}`, () => {
    const raw = fixture(`wire/${name}`);
    const wire = object(object(raw.result).structuredContent);
    assert(typeof raw.id === 'number' || typeof raw.id === 'string');
    const observed = observe({ tool: name.split('.')[1], expectationSeed: wire, receivedReply: raw, requestId: raw.id });
    assert.notEqual(observed.result.kind, 'rejected');
    assert.deepEqual(observed.reconstructed, wire);
  });
}
for (const name of readdirSync(join(examples, 'invalid')).filter((name) => /^[a-z]+\.output\./.test(name))) {
  test(`rejects pinned invalid output ${name}`, () => {
    const wire = fixture(`invalid/${name}`);
    const tool = name.split('.')[0];
    const raw = wrap(tool, wire);
    const seed = fixture(`${tool}.output.${tool === 'status' ? 'ok-no-holder' : tool === 'displays' ? 'two-displays' : tool === 'screenshot' ? 'jpeg' : tool === 'lease' ? 'acquire-renewed' : 'completed'}.json`);
    assert.equal(observe({ tool: tool, expectationSeed: seed, receivedReply: raw }).result.kind, 'rejected');
  });
}

test('preserves populated diagnostics, optional retry, audit text and accepted extensions', () => {
  const wire = fixture('pointer.output.error-out-of-frame.json');
  const details = { reason: 'too_old', argument: '/action', point_index: 3, output_pixel_size: { width: 77, height: 88 }, image_bytes: 91,
    max_image_bytes: 99, idle_ms: 31, denied_by: 'policy', shortcut: 'command+a', expires_in_ms: 42 };
  wire.details = details;
  wire.retry_after_ms = 67;
  wire.message = 'valid audit text must survive';
  const observed = observe({ tool: 'pointer', expectationSeed: wire });
  assert.deepEqual(observed.reconstructed, wire);
  const extended = { ...wire, future_field: 'ignored extension', details: { ...details, future_field: { arbitrary: true } } };
  assert.deepEqual(observe({ tool: 'pointer', expectationSeed: extended }).reconstructed, wire);
});

test('exact RPC, selected tool, content and screenshot relationships', () => {
  const wire = fixture('pointer.output.completed.json');
  const raw = wrap('pointer', wire);
  assert.equal(observe({ tool: 'pointer', expectationSeed: wire, receivedReply: { ...raw, id: '17' } }).result.kind, 'rejected');
  assert.equal(observe({ tool: 'pointer', expectationSeed: wire, receivedReply: { ...raw, id: null } }).result.kind, 'rejected');
  assert.equal(observe({ tool: 'keyboard', expectationSeed: fixture('keyboard.output.completed.json'), receivedReply: raw }).result.kind, 'rejected');
  assert.equal(observe({ tool: 'pointer', expectationSeed: wire, receivedReply: { ...raw, result: { ...raw.result, isError: true } } }).result.kind, 'rejected');
  assert.equal(observe({ tool: 'pointer', expectationSeed: wire, receivedReply: { ...raw, result: { ...raw.result, content: [{ type: 'text', text: '{}' }] } } }).result.kind, 'rejected');
  const screenshot = fixture('screenshot.output.jpeg.json');
  const image = wrap('screenshot', screenshot);
  for (const content of [image.result.content.slice(1), [...image.result.content].reverse(), [...image.result.content, image.result.content[0]],
    [{ type: 'image', data: 'placeholder', mimeType: 'image/png' }, image.result.content[1]]]) {
    assert.equal(observe({ tool: 'screenshot', expectationSeed: screenshot, receivedReply: { ...image, result: { ...image.result, content } } }).result.kind, 'rejected');
  }
  assert.equal(observe({ tool: 'pointer', expectationSeed: wire, receivedReply: { ...raw, result: { ...raw.result, content: image.result.content } } }).result.kind, 'rejected');
});

test('strict nested JSON rejects duplicate decoded keys, depth and malformed syntax', () => {
  const wire = fixture('status.output.ok-no-holder.json');
  const raw = wrap('status', wire);
  const texts = [
    JSON.stringify(wire).replace('"mac":', '"mac":"bad","mac":'),
    JSON.stringify(wire).replace('"mac":', '"m\\u0061c":"bad","mac":'),
    JSON.stringify(wire).replace('"max_pixels":', '"max_pixels":1,"max_pixels":'),
    '{"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}',
    JSON.stringify(wire) + ' trailing', '{"a":1,}', '{"a":"unterminated}', '{"a":01}',
  ];
  for (const text of texts) {
    const result = observe({ tool: 'status', expectationSeed: wire, receivedReply: { ...raw, result: { ...raw.result, content: [{ type: 'text', text }] } } }).result;
    assert.equal(result.kind, 'rejected');
  }
  const reordered = Object.fromEntries(Object.entries(wire).reverse());
  assert.equal(observe({ tool: 'status', expectationSeed: wire, receivedReply: { ...raw, result: { ...raw.result, content: [{ type: 'text', text: JSON.stringify(reordered) }] } } }).result.kind, 'ok');
});

test('local holder, endpoint, frame, operation, display, Mac and lookup correlation', () => {
  const wire = fixture('pointer.output.completed.json');
  const expected: ExpectedReply & ExpectedPointer = { requestId: 17, ...expectedInput(wire), action: 'target' };
  const raw = wrap('pointer', wire);
  assert.equal(boundary.pointer(raw, { ...expected, operationId: operationId('other-operation') }).kind, 'rejected');
  for (const frame of [
    { ...expected.frame, endpoint: endpointIdentity('https://other.invalid/mcp') },
    { ...expected.frame, holderId: holderId('other-holder') },
    { ...expected.frame, frameId: frameId('frm_aaaaaaaaaaaaaaaaaaaaaa') },
  ]) assert.equal(boundary.pointer(raw, { ...expected, frame }).kind, 'rejected');
  const status = fixture('status.output.ok-no-holder.json');
  assert.equal(boundary.status(wrap('status', status), { requestId: 17, holder: 'configured-holder' }).kind, 'rejected');
  assert.equal(boundary.lookup(wrap('status', status), { requestId: 17, operationId: expected.operationId }).kind, 'rejected');
  const lookup = fixture('status.output.operation-found.json');
  assert.equal(boundary.status(wrap('status', lookup), { requestId: 17, holder: 'configured-holder' }).kind, 'rejected');
  assert.equal(observe({ tool: 'status', expectationSeed: { ...status, mac: 'different-mac' } }).result.kind, 'rejected');
  const screenshot = fixture('screenshot.output.jpeg.json');
  assert.equal(boundary.screenshot(wrap('screenshot', screenshot), { requestId: 17, displayId: { kind: 'present', value: displayId(42) } }).kind, 'rejected');
  const lease = fixture('lease.output.acquired.json');
  assert.equal(boundary.lease(wrap('lease', lease), { requestId: 17, operation: 'release' }).kind, 'rejected');
});

test('measurement presence and action semantics are stronger than canonical schema', () => {
  const keyboard = fixture('keyboard.output.completed.json');
  const pointer = fixture('pointer.output.completed.json');
  const drag = fixture('pointer.output.completed-drag.json');
  const expected = { requestId: 17, ...expectedInput(pointer) };
  assert.equal(boundary.pointer(wrap('pointer', pointer), { ...expected, action: 'drag' }).kind, 'rejected');
  assert.equal(boundary.pointer(wrap('pointer', drag), { ...expected, action: 'target' }).kind, 'rejected');
  assert.equal(observe({ tool: 'keyboard', expectationSeed: { ...keyboard, measured: { ...object(keyboard.measured), drag_end: object(drag.measured).drag_end } } }).result.kind, 'rejected');
  const admitted = fixture('pointer.output.error-paused-aborted.json');
  const noMeasurement = { ...admitted };
  delete noMeasurement.measured;
  assert.equal(observe({ tool: 'pointer', expectationSeed: noMeasurement }).result.kind, 'rejected');
  const notAdmitted = fixture('pointer.output.error-out-of-frame.json');
  assert.equal(observe({ tool: 'pointer', expectationSeed: { ...notAdmitted, measured: pointer.measured } }).result.kind, 'rejected');
  const interrupted = fixture('keyboard.output.error-interrupted.json');
  assert.equal(observe({ tool: 'keyboard', expectationSeed: { ...interrupted, measured: keyboard.measured } }).result.kind, 'rejected');
  const readError = fixture('status.output.error-invalid-argument.json');
  assert.equal(observe({ tool: 'status', expectationSeed: { ...readError, measured: keyboard.measured } }).result.kind, 'rejected');
  assert.equal(observe({ tool: 'pointer', expectationSeed: { ...admitted, operation: { status: 'completed', events_posted: 1 } } }).result.kind, 'rejected');
});

test('admission, original/current state, other-call record and restart lower bounds stay independent', () => {
  const wire = fixture('keyboard.output.error-secure-input-aborted.json');
  wire.replayed = true;
  wire.current_state = 'ok';
  const replay = observe({ tool: 'keyboard', expectationSeed: wire });
  assert.deepEqual(replay.reconstructed, wire);
  const prior = fixture('pointer.output.error-paused-aborted.json');
  delete prior.replayed;
  delete prior.measured;
  const result = observe({ tool: 'pointer', expectationSeed: prior }).result;
  assert.equal(result.kind, 'tool-error');
  if (result.kind === 'tool-error') {
    assert.equal(result.error.evidence.kind, 'not-admitted');
    assert.equal(result.error.operation.kind, 'present');
  }
  const interrupted = fixture('keyboard.output.error-interrupted.json');
  interrupted.operation = { status: 'aborted_by_restart', events_posted: 0 };
  const restart = observe({ tool: 'keyboard', expectationSeed: interrupted }).result;
  assert.equal(restart.kind, 'tool-error');
  if (restart.kind === 'tool-error' && restart.error.operation.kind === 'present') {
    assert.deepEqual(restart.error.operation.value.events, { kind: 'lower-bound', value: 0 });
  }
  const missing = observe({ tool: 'status', expectationSeed: fixture('status.output.operation-unknown.json') }).result;
  assert.equal(missing.kind, 'ok');
  assert.deepEqual(observe({ tool: 'keyboard', expectationSeed: fixture('keyboard.output.error-cancelled.json') }).reconstructed, fixture('keyboard.output.error-cancelled.json'));
});

test('rejected faults never serialize received canaries or caught exception messages', () => {
  const canaries = ['Bearer CANARY_BEARER', '-----BEGIN PRIVATE KEY-----CANARY_PEM', 'CANARY_BODY', 'CANARY_TYPED_TEXT', 'CANARY_IMAGE_BASE64'];
  for (const canary of canaries) {
    const wire = fixture('pointer.output.completed.json');
    const raw = wrap('pointer', { ...wire, measured: { ...object(wire.measured), measured_at: canary } });
    const result = observe({ tool: 'pointer', expectationSeed: wire, receivedReply: raw }).result;
    assert.equal(result.kind, 'rejected');
    assert(!JSON.stringify(result).includes(canary));
    const hostile = { get jsonrpc() { throw new Error(canary); } };
    const failed = observe({ tool: 'pointer', expectationSeed: wire, receivedReply: hostile }).result;
    assert.equal(failed.kind, 'rejected');
    assert(!JSON.stringify(failed).includes(canary));
  }
  const refusal = fixture('pointer.output.error-out-of-frame.json');
  refusal.message = canaries.join(' ');
  assert.deepEqual(observe({ tool: 'pointer', expectationSeed: refusal }).reconstructed, refusal);
});

test('the real import fence resolves every supported literal edge and preserves trusted computed loaders', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-imports-'));
  const write = (path: string, contents: string) => { const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents); };
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/check-deskhand-boundary-imports.mjs'), '--root', temporary], { encoding: 'utf8' });
  try {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@private/*': ['src/service/deskhand/*'] } }, include: ['src/**/*.ts', 'tests/**/*.ts'] }));
    write('src/service/deskhand/contract.ts', 'export const hidden = 1; export type Hidden = string;');
    write('src/service/deskhand/vocabulary.generated.ts', 'export const value = 1;');
    write('src/service/deskhand/new-leaf.ts', "import { value } from './vocabulary.generated.js'; export const hidden = value;");
    write('src/service/ordinary.ts', 'export const ordinary = 1;');
    write('tests/service/deskhand-results.test.ts', "import { hidden } from '../../src/service/deskhand/contract.ts'; void hidden;");
    write('tests/service/deskhand-results.types.ts', "import type { Hidden } from '../../src/service/deskhand/contract.ts';");
    write('src/service/consumer.ts', "import { ordinary } from './ordinary.js'; void ordinary; import(configPath); import(pathToFileURL(resolve(configPath)).href);");
    assert.equal(run().status, 0);
    const forbidden = [
      "import { hidden } from './deskhand/contract.ts';", "import * as hidden from './deskhand/contract.ts';", "import './deskhand/contract.ts';",
      "import type { Hidden } from './deskhand/contract.ts';", "type Hidden = typeof import('./deskhand/contract.ts');",
      "export type { Hidden } from './deskhand/contract.ts';", "export { hidden } from './deskhand/contract.ts';", "export * from './deskhand/contract.ts';",
      "import('./deskhand/contract.ts');", "require('./deskhand/contract.ts');", "import hidden = require('./deskhand/contract.ts');",
      "import { hidden } from '@private/contract';", "import { hidden } from './deskhand/contract.js';",
      "import { hidden } from './deskhand/../deskhand/new-leaf.ts';",
    ];
    for (const source of forbidden) {
      write('src/service/consumer.ts', source);
      const result = run();
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, /private-edge/, source);
    }
    write('src/service/consumer.ts', "import { hidden } from './barrel.js';");
    write('src/service/barrel.ts', "export { hidden } from './deskhand/contract.ts';");
    assert.match(run().stderr, /private-edge/);
    write('src/service/barrel.ts', 'export const hidden = 1;');
    for (const source of ["export * from '../../src/service/deskhand/contract.ts';", "import { hidden } from '../../src/service/deskhand/contract.ts'; export { hidden };"]) {
      write('tests/service/deskhand-results.test.ts', source);
      assert.match(run().stderr, /private-test-export/);
    }
    write('tests/service/deskhand-results.test.ts', '');
    for (const name of ['cli.ts', 'recovery-cli.ts', 'supervisor-runner.ts']) {
      const source = readFileSync(join(root, 'src/service', name), 'utf8');
      assert.match(source, /import\(pathToFileURL\(/);
      write(`src/service/${name}`, source);
    }
    assert.equal(run().status, 0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('separately compiled negative callers reject each forbidden type use', () => {
  const filename = join(root, 'tests/service/deskhand-results.types.ts');
  const prelude = `import type { FramePoint, GlobalPoint, OperationId, FrameId, KeyboardCompletion, ToolError, OperationRecord, ScreenshotObservation, ResultBoundary } from '../../src/service/deskhand/contract.ts';
declare const global: GlobalPoint;
declare const operation: OperationId;
declare const keyboard: KeyboardCompletion;
declare const screenshotError: ToolError<'screenshot'>;
declare const record: Extract<OperationRecord, {kind:'ended-by-restart'}>;
declare const metadata: ScreenshotObservation;
declare const boundary: ResultBoundary;
`;
  const failures = [
    'const point: FramePoint = global;',
    'const frame: FrameId = operation;',
    'const point: GlobalPoint = keyboard.measured.globalPoint;',
    'const end: GlobalPoint = keyboard.measured.end.globalPoint;',
    "if (screenshotError.code === 'out_of_frame') {}",
    "const exact: 'exact' = record.events.kind;",
    "if (metadata.metadata.encoding.kind === 'png') { metadata.metadata.encoding.quality; }",
    'metadata.reference;',
    'metadata.encoded;',
    "boundary.lease(undefined, {requestId:1, operation:'release', ttlMs:1});",
    "boundary.lease(undefined, {requestId:1, operation:'release', operationId:operation});",
    "import type { Frame, FrameReference } from '../../src/service/deskhand/contract.ts';",
    'boundary.pointer(undefined, {requestId:1, operationId:operation, frame:metadata, action:"target"});',
  ];
  const source = prelude + failures.map((line) => line.startsWith('import ') ? line : `{ ${line} }`).join('\n');
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
  const host = ts.createCompilerHost(parsed.options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (path) => path === filename ? source : originalRead(path);
  const program = ts.createProgram([filename], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === filename);
  const lineOffset = prelude.split('\n').length - 1;
  for (let index = 0; index < failures.length; index++) {
    const matching = diagnostics.filter((diagnostic) => diagnostic.file && diagnostic.start !== undefined && diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line === lineOffset + index);
    assert(matching.length > 0, failures[index]);
    assert(matching.some((diagnostic) => [2322, 2339, 2367, 2353, 2305, 2739, 18048, 2561].includes(diagnostic.code)), failures[index]);
  }
});

test('actual known-path and dropped-optional source mutations fail preservation', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-mutations-'));
  try {
    for (const path of ['src/service/deskhand', 'vendor/deskhand', 'tests/service/deskhand-results.test.ts', 'package.json', 'tsconfig.json']) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'));
    const path = join(temporary, 'src/service/deskhand/contract.ts');
    const original = readFileSync(path, 'utf8');
    const mutations = [
      { before: 'measuredAt: string(wire.measured_at)', after: 'measuredAt: string(wire.measured_at_typo)', test: 'preserves every known fact in pointer.output.completed.json' },
      { before: "...(wire.shortcut === undefined ? {} : { shortcut: string(wire.shortcut) }),", after: '', test: 'preserves populated diagnostics' },
    ];
    for (const mutation of mutations) {
      assert(original.includes(mutation.before));
      writeFileSync(path, original.replace(mutation.before, mutation.after));
      const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: temporary, encoding: 'utf8' });
      assert.equal(compile.status, 0, compile.stdout + compile.stderr);
      const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mutation.test}`, 'tests/service/deskhand-results.test.ts'], { cwd: temporary, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout + run.stderr, /ERR_ASSERTION/);
      assert.match(run.stdout + run.stderr, /fail 1|# fail 1/);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('literal, property, required-member, reference and conditional-only drift require review', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-drift-'));
  try {
    for (const path of ['scripts/generate-deskhand-vocabulary.mjs', 'vendor/deskhand', 'src/service/deskhand/vocabulary.generated.ts', 'tests/fixtures/deskhand-results']) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/generate-deskhand-vocabulary.mjs', ...args], { cwd: temporary, encoding: 'utf8' });
    assert.equal(run('--check').status, 0);
    const path = join(temporary, 'vendor/deskhand/contract-v0.11-draft/docs/schemas/defs.json');
    const original = readFileSync(path, 'utf8');
    const enumEdit = JSON.parse(original);
    enumEdit.$defs.state.enum.push('new_state');
    const requiredEdit = JSON.parse(original);
    requiredEdit.$defs.measured.required.pop();
    const referenceEdit = JSON.parse(original);
    referenceEdit.$defs.measured.properties.frontmost_app.$ref = '#/$defs/identified_app';
    const propertyEdit = JSON.parse(original);
    propertyEdit.$defs.measured.properties.future = { type: 'string' };
    const conditionalEdit = JSON.parse(original);
    conditionalEdit.$defs.tool_error.allOf[0].then.required = [];
    for (const value of [enumEdit, requiredEdit, referenceEdit, propertyEdit, conditionalEdit]) {
      writeFileSync(path, JSON.stringify(value));
      assert.equal(run('--check').status, 1);
      assert.equal(run().status, 1);
      writeFileSync(path, original);
      assert.equal(run().status, 0);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

for (const name of readdirSync(join(examples, 'wire')).filter((name) => /^error\..*\.response\.json$/.test(name))) {
  test(`bounded RPC error handling ${name}`, () => {
    const raw = fixture(`wire/${name}`);
    const expectedId = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : 17;
    const result = boundary.displays(raw, { requestId: expectedId });
    if (raw.id === null) assert.equal(result.kind, 'rejected');
    else assert.deepEqual(result, { kind: 'rpc-error', code: object(raw.error).code });
    assert.equal(boundary.displays(raw, { requestId: 'wrong-request' }).kind, 'rejected');
  });
}

test('all six constructors preserve populated facts while accepting unrelated nested extensions', () => {
  const cases = ['status.output.ok-holder-holds.json', 'displays.output.two-displays.json', 'screenshot.output.jpeg.json',
    'lease.output.acquired.json', 'pointer.output.completed-drag.json', 'keyboard.output.completed.json'];
  function extend(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(extend);
    if (value !== null && typeof value === 'object') {
      if ('x' in value || 'width' in value) return value;
      return { ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, extend(child)])), future_field: 'ignored' };
    }
    return value;
  }
  for (const name of cases) {
    const wire = fixture(name);
    const tool = name.split('.')[0];
    assert.deepEqual(observe({ tool: tool, expectationSeed: object(extend(wire)) }).reconstructed, wire);
  }
  const pointer = fixture('pointer.output.completed-drag.json');
  const measured = object(pointer.measured);
  pointer.measured = { ...measured, frontmost_app: { bundle_id: 'com.example.Editor', team_id: 'TEAM123456', name: 'Example Editor' },
    target_app: { bundle_id: 'com.example.Target', team_id: 'OTHER12345', name: 'Example Target' }, window_title: 'nondefault title',
    global_point: { x: -40.5, y: 22.25 }, measured_at: '2026-11-14T15:02:15.987Z',
    drag_end: { target_app: { bundle_id: 'com.example.End', team_id: 'ENDTEAM123', name: 'End' }, window_title: null, global_point: { x: 18.75, y: -4.5 } } };
  assert.deepEqual(observe({ tool: 'pointer', expectationSeed: pointer }).reconstructed, pointer);
});

test('read errors cannot acquire effect audit facts and admitted codes retain terminal meaning', () => {
  const read = fixture('status.output.error-invalid-argument.json');
  for (const extra of [{ operation_id: fallback.operation_id }, { operation: { status: 'completed', events_posted: 2 } }, { replayed: false }]) {
    assert.equal(observe({ tool: 'status', expectationSeed: { ...read, ...extra } }).result.kind, 'rejected');
  }
  const admitted = fixture('pointer.output.error-paused-aborted.json');
  const invalid = { ...admitted, code: 'rate_limited', state: 'ok', retry_after_ms: 12 };
  assert.equal(observe({ tool: 'pointer', expectationSeed: invalid }).result.kind, 'rejected');
  const stale = fixture('pointer.output.error-stale-frame-before-first-event.json');
  assert.equal(observe({ tool: 'pointer', expectationSeed: { ...stale, operation: { status: 'aborted', events_posted: 1 } } }).result.kind, 'rejected');
  const progress = fixture('keyboard.output.error-operation-in-progress.json');
  assert.equal(observe({ tool: 'keyboard', expectationSeed: { ...progress, operation: { status: 'completed', events_posted: 2 } } }).result.kind, 'rejected');
});
