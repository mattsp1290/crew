import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { sameJsonValue } from '../../src/service/json-values.ts';
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
const echoSchemas = new Ajv2020({ strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false });
for (const [name, format] of Object.entries(fullFormats)) echoSchemas.addFormat(name, format);
for (const directory of ['', 'tools/', 'wire/']) {
  const schemaDirectory = join(examples, '..', directory);
  for (const entry of readdirSync(schemaDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const schema: unknown = JSON.parse(readFileSync(join(schemaDirectory, entry.name), 'utf8'));
      assert(schema !== null && typeof schema === 'object' && !Array.isArray(schema));
      echoSchemas.addSchema(schema);
    }
  }
}
function canonicalEchoReply(tool: string, wire: Record<string, unknown>) {
  const raw = wrap(tool, wire);
  for (const [path, value] of [
    ['wire/jsonrpc-response.json', raw], ['wire/tools-call-result.json', raw.result], [`tools/${tool}.output.json`, wire],
  ] satisfies ReadonlyArray<readonly [string, unknown]>) {
    const validate = echoSchemas.getSchema(`https://deskhand.invalid/schemas/${path}`);
    assert(validate);
    assert.equal(validate(value), true, `${tool} canonical acceptance ${path}`);
  }
  const text = object(raw.result.content.at(-1)).text;
  assert(typeof text === 'string');
  assert.deepEqual(JSON.parse(text), wire);
  return raw;
}
function observe({ tool, expectationSeed: wire, receivedReply: raw = wrap(tool, wire), requestId = 17, owner = boundary, expectedAction }: {
  tool: string;
  expectationSeed: Record<string, unknown>;
  receivedReply?: unknown;
  requestId?: string | number;
  owner?: ResultBoundary;
  expectedAction?: ExpectedPointer['action'];
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
      const result = owner.pointer(raw, { ...expected, ...expectedInput(wire), action: expectedAction ?? (wire.measured && Object.hasOwn(object(wire.measured), 'drag_end') ? 'drag' : 'target') });
      return { result, reconstructed: result.kind === 'ok' ? wireCompletion(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    case 'keyboard': {
      const result = owner.keyboard(raw, { ...expected, ...expectedInput(wire) });
      return { result, reconstructed: result.kind === 'ok' ? wireCompletion(result.value) : result.kind === 'tool-error' ? wireError(result.error) : undefined };
    }
    default: throw new Error('unknown-test-tool');
  }
}

for (const action of ['target', 'drag'] satisfies ReadonlyArray<ExpectedPointer['action']>) {
  for (const admission of ['preadmission', 'first-admission', 'replay']) {
    const original = fixture('pointer.output.error-denied-app.json');
    const input = expectedInput(original);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action } satisfies ExpectedReply & ExpectedPointer);
    const seed: Readonly<Record<string, unknown>> = Object.freeze({ ...original, ...(admission === 'preadmission' ? {} : {
      operation: { status: 'aborted', events_posted: 0 }, replayed: admission === 'replay',
      ...(admission === 'replay' ? { current_state: 'locked' } : {}),
    }) });
    test(`${action} ${admission} indexed denial requires its measured target (defs.json:259, §6.7:888, §6.9:998-1002)`, () => {
      const control = boundary.pointer(canonicalEchoReply('pointer', seed), expected);
      assert.equal(control.kind, 'tool-error');
      assert(control.kind === 'tool-error');
      assert.deepEqual(wireError(control.error), seed);
      const measured = object(seed.measured);
      assert.notEqual(measured.global_point, null);
      assert.equal(object(seed.details).point_index, 0);
      const received = { ...seed, measured: { ...measured, target_app: null } };
      const result = boundary.pointer(canonicalEchoReply('pointer', received), expected);
      assert.deepEqual(result, { kind: 'rejected', failure: { kind: 'contract', reason: 'schema', stage: 'relationship' } });
    });
    for (const { name, target, details, globalPoint } of [
      { name: 'identified target', target: object(original.measured).target_app, details: original.details, globalPoint: object(original.measured).global_point },
      { name: 'unknown app object', target: { bundle_id: null, team_id: null, name: '' }, details: { denied_by: 'policy', point_index: 0 }, globalPoint: object(original.measured).global_point },
      { name: 'known process without bundle', target: { bundle_id: null, team_id: 'KNOWNTEAM1', name: 'Known process' }, details: { denied_by: 'policy', point_index: 0 }, globalPoint: object(original.measured).global_point },
      { name: 'frontmost denial without point', target: null, details: { denied_by: 'permitted_apps' }, globalPoint: null },
    ]) {
      test(`${action} ${admission} denial retains ${name} (§6.9:937-948, §6.9:998-1002)`, () => {
        const received = { ...seed, details, measured: { ...object(seed.measured), target_app: target, global_point: globalPoint } };
        const result = boundary.pointer(canonicalEchoReply('pointer', received), expected);
        assert.equal(result.kind, 'tool-error');
        assert(result.kind === 'tool-error');
        assert.deepEqual(wireError(result.error), received);
      });
    }
  }
}

for (const tool of ['pointer', 'keyboard']) {
  const denied = fixture(tool === 'pointer' ? 'pointer.output.error-denied-app.json' : 'keyboard.output.error-denied-app-focus.json');
  const common = [
    { code: 'busy', fields: {} },
    { code: 'cleanup_pending', fields: {} },
    { code: 'lease_held_by_other', fields: { details: { expires_in_ms: 100 } } },
    { code: 'lease_expired', fields: {} },
    { code: 'lease_not_held', fields: {} },
    { code: 'rate_limited', fields: { retry_after_ms: 100 } },
    { code: 'operation_capacity', fields: {} },
    { code: 'stale_frame', fields: { details: { reason: 'too_old' } } },
    { code: 'user_active', fields: { details: { idle_ms: 0 } } },
    { code: 'denied_app', fields: { measured: denied.measured, details: denied.details } },
    { code: 'log_unavailable', fields: { measured: fixture(`${tool}.output.completed.json`).measured } },
  ];
  const applicable = tool === 'pointer'
    ? [...common, { code: 'out_of_frame', fields: { details: { point_index: 0, output_pixel_size: { width: 100, height: 100 } } } }]
    : [...common, { code: 'denied_shortcut', fields: { details: { shortcut: 'command+space' } } }];
  for (const { code, fields } of applicable) {
    const seed = Object.freeze({ code, message: 'Refused before admission', state: 'ok', operation_id: fallback.operation_id, ...fields });
    const input = expectedInput(seed);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
    for (const echo of ['valid', 'missing', 'mismatched']) {
      test(`${tool} ${code} ${echo} parsed operation ID (§9.2:1256, §9.5:1407-1426)`, () => {
        const received: Record<string, unknown> = { ...seed };
        assert(!Object.hasOwn(received, 'operation') && !Object.hasOwn(received, 'replayed'));
        if (echo === 'missing') delete received.operation_id;
        if (echo === 'mismatched') received.operation_id = 'other-operation';
        const raw = canonicalEchoReply(tool, received);
        const result = tool === 'pointer' ? boundary.pointer(raw, expected) : boundary.keyboard(raw, expected);
        if (echo === 'valid') {
          assert.equal(result.kind, 'tool-error');
          assert(result.kind === 'tool-error');
          assert.deepEqual(wireError(result.error), received);
          assert.deepEqual(result.error.reportedOperationId, { kind: 'present', value: expected.operationId });
        } else {
          assert.deepEqual(result, { kind: 'rejected', failure: { kind: 'contract', reason: echo === 'missing' ? 'schema' : 'correlation', stage: 'relationship' } });
        }
      });
    }
  }
  for (const code of ['gated', 'paused', 'disarmed', 'not_console', 'locked', 'display_asleep', 'permission_missing', 'permission_stale', 'secure_input', 'invalid_argument', 'internal_error']) {
    const seed = Object.freeze({ code, message: 'Refused before complete argument parsing',
      state: code === 'invalid_argument' || code === 'internal_error' ? 'ok' : code,
      ...(code === 'invalid_argument' ? { details: { argument: '/operation_id' } } : {}),
    });
    const input = expectedInput(fallback);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
    for (const echo of ['absent', 'correct']) {
      test(`${tool} early ${code} keeps ${echo} operation ID valid (§9.2:1256, §9.5:1407-1426)`, () => {
        const received = { ...seed, ...(echo === 'correct' ? { operation_id: expected.operationId } : {}) };
        const raw = canonicalEchoReply(tool, received);
        const result = tool === 'pointer' ? boundary.pointer(raw, expected) : boundary.keyboard(raw, expected);
        assert.equal(result.kind, 'tool-error');
        assert(result.kind === 'tool-error');
        assert.deepEqual(wireError(result.error), received);
        assert.deepEqual(result.error.reportedOperationId, echo === 'correct' ? { kind: 'present', value: expected.operationId } : { kind: 'absent' });
      });
    }
  }
}

for (const tool of ['status', 'displays', 'screenshot', 'lease']) {
  test(`${tool} early error remains without an operation ID (§9.2:1256)`, () => {
    const seed = fixture('status.output.error-invalid-argument.json');
    assert(!Object.hasOwn(seed, 'operation_id'));
    const result = observe({ tool, expectationSeed: seed, receivedReply: canonicalEchoReply(tool, seed) }).result;
    assert.equal(result.kind, 'tool-error');
    assert(result.kind === 'tool-error');
    assert.deepEqual(result.error.reportedOperationId, { kind: 'absent' });
    assert.deepEqual(wireError(result.error), seed);
  });
}

for (const name of readdirSync(examples).filter((name) => /^[a-z]+\.output\./.test(name))) {
  test(`preserves every known fact in ${name}`, () => {
    const wire = fixture(name);
    const observed = observe({ tool: name.split('.')[0], expectationSeed: wire, expectedAction: name.includes('drag') ? 'drag' : undefined });
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
  const details = { reason: 'too_old', argument: '/action', point_index: 0, output_pixel_size: { width: 77, height: 88 }, image_bytes: 91,
    max_image_bytes: 99, idle_ms: 31, denied_by: 'policy', shortcut: 'command+a', expires_in_ms: 42 };
  wire.details = details;
  wire.retry_after_ms = 67;
  wire.message = 'valid audit text must survive';
  const observed = observe({ tool: 'pointer', expectationSeed: wire });
  assert.deepEqual(observed.reconstructed, wire);
  const extended = { ...wire, future_field: 'ignored extension', details: { ...details, future_field: { arbitrary: true } } };
  assert.deepEqual(observe({ tool: 'pointer', expectationSeed: extended }).reconstructed, wire);
});

for (const lookup of [false, true]) {
  const original = fixture(lookup ? 'status.output.operation-found.json' : 'status.output.ok-holder-holds.json');
  const armed = original.armed_until;
  const unheld = { held_by_caller: false };
  const ordered = { state: 'gated', active_states: ['gated', 'paused', 'disarmed', 'locked'], armed_until: null, lease: unheld };
  for (const { name, source, valid, invalid } of [
    { name: 'highest state follows precedence', source: '§6.1:693-694, §10:1485-1508', valid: ordered,
      invalid: { ...ordered, state: 'paused', active_states: ['paused', 'gated', 'disarmed', 'locked'] } },
    { name: 'the whole active-state tail follows precedence', source: '§6.1:694, §10:1485-1508', valid: ordered,
      invalid: { ...ordered, active_states: ['gated', 'disarmed', 'paused', 'locked'] } },
    { name: 'paused includes disarmed', source: '§10:1496, §10.4:1577',
      valid: { state: 'paused', active_states: ['paused', 'disarmed'], armed_until: null, lease: unheld },
      invalid: { state: 'paused', active_states: ['paused'], armed_until: armed, lease: unheld } },
    { name: 'paused includes disarmed below gated', source: '§10:1496, §10.4:1577',
      valid: { state: 'gated', active_states: ['gated', 'paused', 'disarmed'], armed_until: null, lease: unheld },
      invalid: { state: 'gated', active_states: ['gated', 'paused'], armed_until: armed, lease: unheld } },
    { name: 'active disarmed requires null arming', source: '§10:1496, §6.1:696',
      valid: { state: 'disarmed', active_states: ['disarmed'], armed_until: null, lease: unheld },
      invalid: { state: 'disarmed', active_states: ['disarmed'], armed_until: armed, lease: unheld } },
    { name: 'null arming requires active disarmed', source: '§10:1496, §6.1:696',
      valid: { state: 'ok', active_states: [], armed_until: armed, lease: unheld },
      invalid: { state: 'ok', active_states: [], armed_until: null, lease: unheld } },
    { name: 'active gated drops a caller lease', source: '§5.2:595, §10:1494, §10.4:1568',
      valid: { state: 'gated', active_states: ['gated'], armed_until: armed, lease: unheld },
      invalid: { state: 'gated', active_states: ['gated'], armed_until: armed, lease: original.lease } },
    { name: 'active paused drops a caller lease', source: '§10:1495, §10.4:1568',
      valid: { state: 'paused', active_states: ['paused', 'disarmed'], armed_until: null, lease: unheld },
      invalid: { state: 'paused', active_states: ['paused', 'disarmed'], armed_until: null, lease: original.lease } },
    { name: 'active disarmed drops a caller lease', source: '§10:1496, §10.4:1568',
      valid: { state: 'disarmed', active_states: ['disarmed'], armed_until: null, lease: unheld },
      invalid: { state: 'disarmed', active_states: ['disarmed'], armed_until: null, lease: original.lease } },
    { name: 'login_window includes not_console below a higher state', source: '§11:1637, §11.4:1735',
      valid: { state: 'gated', active_states: ['gated', 'not_console'], conditions: ['login_window'], armed_until: armed, lease: unheld },
      invalid: { state: 'gated', active_states: ['gated'], conditions: ['login_window'], armed_until: armed, lease: unheld } },
  ]) {
    test(`${lookup ? 'lookup' : 'status'} metadata ${name} (${source})`, () => {
      const expectedStatus = Object.freeze({ requestId: 17, holder: 'configured-holder' } satisfies Parameters<ResultBoundary['status']>[1]);
      const expectedLookup = Object.freeze({ requestId: 17, operationId: operationId(fallback.operation_id) });
      const read = (wire: Record<string, unknown>) => lookup
        ? boundary.lookup(wrap('status', wire), expectedLookup)
        : boundary.status(wrap('status', wire), expectedStatus);
      const control = read({ ...original, ...valid });
      assert.equal(control.kind, 'ok');
      const result = read({ ...original, ...invalid });
      assert.equal(result.kind, 'rejected');
      assert(result.kind === 'rejected');
      assert.equal(result.failure.stage, 'relationship');
    });
  }
  for (const { name, facts } of [
    { name: 'empty ok remains armed', facts: { state: 'ok', active_states: [], armed_until: armed, lease: unheld } },
    { name: 'sparse ordered states', facts: { state: 'gated', active_states: ['gated', 'not_console', 'permission_stale'], armed_until: armed, lease: unheld } },
    { name: 'gated remains armed without a lease', facts: { state: 'gated', active_states: ['gated'], armed_until: armed, lease: unheld } },
    { name: 'locked retains a held lease', facts: { state: 'locked', active_states: ['locked'], armed_until: armed, lease: original.lease } },
    { name: 'paused is disarmed without a lease', facts: { state: 'paused', active_states: ['paused', 'disarmed'], armed_until: null, lease: unheld } },
    { name: 'disarmed has null arming without a lease', facts: { state: 'disarmed', active_states: ['disarmed'], armed_until: null, lease: unheld } },
    { name: 'login_window reports not_console', facts: { state: 'not_console', active_states: ['not_console'], conditions: ['login_window'], armed_until: armed, lease: unheld } },
    { name: 'not_console does not require login_window', facts: { state: 'not_console', active_states: ['not_console'], conditions: [], armed_until: armed, lease: unheld } },
  ]) {
    test(`${lookup ? 'lookup' : 'status'} metadata retains ${name} (§6.1, §10, §11)`, () => {
      const expectedStatus = Object.freeze({ requestId: 17, holder: 'configured-holder' } satisfies Parameters<ResultBoundary['status']>[1]);
      const expectedLookup = Object.freeze({ requestId: 17, operationId: operationId(fallback.operation_id) });
      const wire = { ...original, ...facts };
      const result = lookup ? boundary.lookup(wrap('status', wire), expectedLookup) : boundary.status(wrap('status', wire), expectedStatus);
      assert.equal(result.kind, 'ok');
      assert(result.kind === 'ok');
      const status = 'status' in result.value ? result.value.status : result.value;
      assert.deepEqual(wireStatus(status), Object.fromEntries(Object.entries(wire).filter(([key]) => key !== 'operation')));
    });
  }
}

test('display IDs are unique within the reported generation (§6.2:707-713)', () => {
  const original = fixture('displays.output.two-displays.json');
  assert(Array.isArray(original.displays));
  const [first, second] = original.displays.map(object);
  const expected = Object.freeze({ requestId: 17 });
  const control = boundary.displays(wrap('displays', original), expected);
  assert.equal(control.kind, 'ok');
  assert(control.kind === 'ok');
  assert.deepEqual(wireDisplays(control.value), original);
  const received = { ...original, displays: [first, { ...second, display_id: first.display_id }] };
  const result = boundary.displays(wrap('displays', received), expected);
  assert.equal(result.kind, 'rejected');
  assert(result.kind === 'rejected');
  assert.equal(result.failure.stage, 'relationship');
});

for (const entry of [0, 1]) {
  test(`successful displays rejects asleep entry ${entry} (Appendix A:25)`, () => {
    const seed = fixture('displays.output.two-displays.json');
    assert(Array.isArray(seed.displays));
    const expected = Object.freeze({ requestId: 17 });
    const control = boundary.displays(wrap('displays', seed), expected);
    assert.equal(control.kind, 'ok');
    assert(control.kind === 'ok');
    assert.deepEqual(wireDisplays(control.value), seed);
    const received = { ...seed, displays: seed.displays.map((display, index) => index === entry ? { ...object(display), asleep: true } : display) };
    const result = boundary.displays(wrap('displays', received), expected);
    assert.equal(result.kind, 'rejected');
    assert(result.kind === 'rejected');
    assert.equal(result.failure.stage, 'relationship');
  });
}

test('display_asleep remains a valid displays refusal (Appendix A:25)', () => {
  const wire = { code: 'display_asleep', state: 'display_asleep', message: 'The display is asleep.' };
  const result = boundary.displays(wrap('displays', wire), { requestId: 17 });
  assert.equal(result.kind, 'tool-error');
  assert(result.kind === 'tool-error');
  assert.deepEqual(wireError(result.error), wire);
});

test('different display IDs do not require different UUIDs (§6.2:707-713)', () => {
  const original = fixture('displays.output.two-displays.json');
  assert(Array.isArray(original.displays));
  const [first, second] = original.displays.map(object);
  const wire = { ...original, displays: [first, { ...second, uuid: first.uuid }] };
  const expected = Object.freeze({ requestId: 17 });
  const result = boundary.displays(wrap('displays', wire), expected);
  assert.equal(result.kind, 'ok');
  assert(result.kind === 'ok');
  assert.deepEqual(wireDisplays(result.value), wire);
});

for (const edge of ['negative-x', 'negative-y', 'upper-x', 'upper-y']) {
  test(`screenshot pointer rejects ${edge} with matched text (§6.3:750, §8.2:1140-1144)`, () => {
    const seed = fixture('screenshot.output.jpeg.json');
    const size = object(seed.output_pixel_size);
    const expected = Object.freeze({ requestId: 17, displayId: Object.freeze({ kind: 'absent' }) } satisfies Parameters<ResultBoundary['screenshot']>[1]);
    const control = boundary.screenshot(wrap('screenshot', seed), expected);
    assert.equal(control.kind, 'ok');
    assert(control.kind === 'ok');
    assert.deepEqual(wireScreenshot(control.value), seed);
    const pointer_position = edge === 'negative-x' ? { x: -1, y: 0 } : edge === 'negative-y' ? { x: 0, y: -1 }
      : edge === 'upper-x' ? { x: size.width, y: 0 } : { x: 0, y: size.height };
    const result = boundary.screenshot(wrap('screenshot', { ...seed, pointer_position }), expected);
    assert.equal(result.kind, 'rejected');
    assert(result.kind === 'rejected');
    assert.equal(result.failure.stage, 'relationship');
  });
}
for (const axis of ['width', 'height']) {
  for (const scaleOne of [false, true]) {
    test(`screenshot ${scaleOne ? 'scale one preserves' : 'never upscales'} ${axis} (§7:1069-1082)`, () => {
      const original = fixture('screenshot.output.jpeg.json');
      const output = object(original.output_pixel_size);
      assert(typeof output[axis] === 'number');
      const seed = scaleOne ? { ...original, downscale: 1, source_pixel_size: { ...output } } : original;
      const expected = Object.freeze({ requestId: 17, displayId: Object.freeze({ kind: 'absent' }) } satisfies Parameters<ResultBoundary['screenshot']>[1]);
      const control = boundary.screenshot(wrap('screenshot', seed), expected);
      assert.equal(control.kind, 'ok');
      assert(control.kind === 'ok');
      assert.deepEqual(wireScreenshot(control.value), seed);
      const received = { ...seed, source_pixel_size: { ...object(seed.source_pixel_size), [axis]: output[axis] + (scaleOne ? 1 : -1) } };
      const result = boundary.screenshot(wrap('screenshot', received), expected);
      assert.equal(result.kind, 'rejected');
      assert(result.kind === 'rejected');
      assert.equal(result.failure.stage, 'relationship');
    });
  }
}
for (const position of ['null', 'origin', 'last-pixel']) {
  test(`screenshot retains pointer ${position} (§6.3:750, §8.2:1140-1144)`, () => {
    const original = fixture('screenshot.output.jpeg.json');
    const size = object(original.output_pixel_size);
    assert(typeof size.width === 'number' && typeof size.height === 'number');
    const pointer_position = position === 'null' ? null : position === 'origin' ? { x: 0, y: 0 } : { x: size.width - 1, y: size.height - 1 };
    const wire = { ...original, pointer_position };
    const expected = Object.freeze({ requestId: 17, displayId: Object.freeze({ kind: 'absent' }) } satisfies Parameters<ResultBoundary['screenshot']>[1]);
    const result = boundary.screenshot(wrap('screenshot', wire), expected);
    assert.equal(result.kind, 'ok');
    assert(result.kind === 'ok');
    assert.deepEqual(wireScreenshot(result.value), wire);
  });
}
for (const equal of [false, true]) {
  test(`screenshot permits output ${equal ? 'equal to' : 'smaller than'} source (§7:1069-1082)`, () => {
    const original = fixture('screenshot.output.jpeg.json');
    const wire = equal ? { ...original, downscale: 1, source_pixel_size: { ...object(original.output_pixel_size) } } : original;
    const expected = Object.freeze({ requestId: 17, displayId: Object.freeze({ kind: 'absent' }) } satisfies Parameters<ResultBoundary['screenshot']>[1]);
    const result = boundary.screenshot(wrap('screenshot', wire), expected);
    assert.equal(result.kind, 'ok');
    assert(result.kind === 'ok');
    assert.deepEqual(wireScreenshot(result.value), wire);
  });
}

for (const { name, details } of [
  { name: 'attempted bytes at the cap', details: { image_bytes: 3750000, max_image_bytes: 3750000 } },
  { name: 'attempted bytes below the cap', details: { image_bytes: 3749999, max_image_bytes: 3750000 } },
  { name: 'a false reported maximum', details: { image_bytes: 3750002, max_image_bytes: 3750001 } },
]) {
  test(`image_too_large rejects ${name} (§7:1098-1105, §16 MAX_IMAGE_BYTES)`, () => {
    const original = fixture('screenshot.output.error-image-too-large.json');
    const seed = { ...original, details: { image_bytes: 3750001, max_image_bytes: 3750000 } };
    const expected = Object.freeze({ requestId: 17, displayId: Object.freeze({ kind: 'absent' }) } satisfies Parameters<ResultBoundary['screenshot']>[1]);
    const control = boundary.screenshot(wrap('screenshot', seed), expected);
    assert.equal(control.kind, 'tool-error');
    assert(control.kind === 'tool-error');
    assert.deepEqual(wireError(control.error), seed);
    const result = boundary.screenshot(wrap('screenshot', { ...seed, details }), expected);
    assert.equal(result.kind, 'rejected');
    assert(result.kind === 'rejected');
    assert.equal(result.failure.stage, 'relationship');
  });
}

for (const { name, valid, invalid } of [
  { name: 'width', valid: { width: 2576, height: 1 }, invalid: { width: 2577, height: 1 } },
  { name: 'height', valid: { width: 1, height: 2576 }, invalid: { width: 1, height: 2577 } },
  { name: 'area', valid: { width: 2000, height: 1794 }, invalid: { width: 2000, height: 1795 } },
]) {
  test(`out_of_frame diagnostic rejects excessive ${name} with matched text (§6.3:745, §7:1069-1082, §8.2:1140-1144)`, () => {
    const original = fixture('pointer.output.error-out-of-frame.json');
    const input = expectedInput(original);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
    const seed = { ...original, details: { ...object(original.details), output_pixel_size: valid } };
    const control = boundary.pointer(wrap('pointer', seed), expected);
    assert.equal(control.kind, 'tool-error');
    assert(control.kind === 'tool-error');
    assert.deepEqual(wireError(control.error), seed);
    const received = { ...seed, details: { ...seed.details, output_pixel_size: invalid } };
    const result = boundary.pointer(wrap('pointer', received), expected);
    assert.equal(result.kind, 'rejected');
    assert(result.kind === 'rejected');
    assert.equal(result.failure.stage, 'relationship');
  });
}

for (const action of ['target', 'drag'] satisfies ReadonlyArray<ExpectedPointer['action']>) {
  test(`${action} indexed denied_app needs its measured global point (§6.7:888, §6.9:998-1002)`, () => {
    const original = fixture('pointer.output.error-denied-app.json');
    const input = expectedInput(original);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action } satisfies ExpectedReply & ExpectedPointer);
    const control = boundary.pointer(wrap('pointer', original), expected);
    assert.equal(control.kind, 'tool-error');
    assert(control.kind === 'tool-error');
    assert.deepEqual(wireError(control.error), original);
    const received = { ...original, measured: { ...object(original.measured), global_point: null } };
    const result = boundary.pointer(wrap('pointer', received), expected);
    assert.equal(result.kind, 'rejected');
    assert(result.kind === 'rejected');
    assert.equal(result.failure.stage, 'relationship');
  });

  test(`${action} point denial retains an unknown app and nonnull point (§6.9:937-948, §6.9:998-1002)`, () => {
    const original = fixture('pointer.output.error-denied-app.json');
    const wire = { ...original, measured: { ...object(original.measured), target_app: { bundle_id: null, team_id: null, name: '' } },
      details: { ...object(original.details), denied_by: 'policy' } };
    const input = expectedInput(original);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action } satisfies ExpectedReply & ExpectedPointer);
    const result = boundary.pointer(wrap('pointer', wire), expected);
    assert.equal(result.kind, 'tool-error');
    assert(result.kind === 'tool-error');
    assert.deepEqual(wireError(result.error), wire);
  });
}

test('drag frontmost denial can omit its point index and global point (§6.9:998-1002)', () => {
  const original = fixture('pointer.output.error-denied-app.json');
  const wire = { ...original, measured: { ...object(original.measured), target_app: null, global_point: null }, details: { denied_by: 'permitted_apps' } };
  const input = expectedInput(original);
  const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'drag' } satisfies ExpectedReply & ExpectedPointer);
  const result = boundary.pointer(wrap('pointer', wire), expected);
  assert.equal(result.kind, 'tool-error');
  assert(result.kind === 'tool-error');
  assert.deepEqual(wireError(result.error), wire);
});

for (const tool of ['pointer', 'keyboard']) {
  test(`${tool} retains optional diagnostic dimensions outside out_of_frame (schemas/defs.json tool_error.details)`, () => {
    const original = fixture(tool === 'pointer' ? 'pointer.output.error-denied-app.json' : 'keyboard.output.error-denied-shortcut.json');
    const wire = { ...original, details: { ...object(original.details), output_pixel_size: { width: 2577, height: 2577 } } };
    const input = expectedInput(original);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
    const result = tool === 'pointer' ? boundary.pointer(wrap(tool, wire), expected) : boundary.keyboard(wrap(tool, wire), expected);
    assert.equal(result.kind, 'tool-error');
    assert(result.kind === 'tool-error');
    assert.deepEqual(wireError(result.error), wire);
  });
}

for (const code of ['out-of-frame', 'stale-frame', 'denied-app']) {
  for (const action of ['target', 'drag'] satisfies ReadonlyArray<ExpectedPointer['action']>) {
    test(`${action} ${code} names an applicable point index (§6.9:998-1002, §8.2:1140, §8.4:1213-1216, §16 DRAG_MAX_POINTS)`, () => {
      const original = fixture(`pointer.output.error-${code}.json`);
      const input = expectedInput(original);
      const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action } satisfies ExpectedReply & ExpectedPointer);
      const seed = { ...original, details: { ...object(original.details), point_index: action === 'target' ? 0 : 31 } };
      const control = boundary.pointer(wrap('pointer', seed), expected);
      assert.equal(control.kind, 'tool-error');
      assert(control.kind === 'tool-error');
      assert.deepEqual(wireError(control.error), seed);
      const received = { ...seed, details: { ...seed.details, point_index: action === 'target' ? 1 : 32 } };
      const result = boundary.pointer(wrap('pointer', received), expected);
      assert.equal(result.kind, 'rejected');
      assert(result.kind === 'rejected');
      assert.equal(result.failure.stage, 'relationship');
    });
  }
}

test('keyboard denied_app has no pointer point index (§6.9:998-1002)', () => {
  const seed = fixture('keyboard.output.error-denied-app-focus.json');
  const input = expectedInput(seed);
  const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame) });
  const control = boundary.keyboard(wrap('keyboard', seed), expected);
  assert.equal(control.kind, 'tool-error');
  assert(control.kind === 'tool-error');
  assert.deepEqual(wireError(control.error), seed);
  const received = { ...seed, details: { ...object(seed.details), point_index: 0 } };
  const result = boundary.keyboard(wrap('keyboard', received), expected);
  assert.equal(result.kind, 'rejected');
  assert(result.kind === 'rejected');
  assert.equal(result.failure.stage, 'relationship');
});

test('pointer frontmost denial can omit its point index (§6.9:998-1002)', () => {
  const original = fixture('pointer.output.error-denied-app.json');
  const measured = object(original.measured);
  const wire = { ...original, measured: { ...measured, target_app: null, global_point: null }, details: { denied_by: 'permitted_apps' } };
  const input = expectedInput(original);
  const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
  const result = boundary.pointer(wrap('pointer', wire), expected);
  assert.equal(result.kind, 'tool-error');
  assert(result.kind === 'tool-error');
  assert.deepEqual(wireError(result.error), wire);
});

test('other keyboard codes retain optional known diagnostic fields (§9.2:1264, schemas/defs.json tool_error.details)', () => {
  const original = fixture('keyboard.output.error-denied-shortcut.json');
  const wire = { ...original, details: { ...object(original.details), point_index: 32, reason: 'pixels_changed', image_bytes: 1, max_image_bytes: 2 } };
  const input = expectedInput(original);
  const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame) });
  const result = boundary.keyboard(wrap('keyboard', wire), expected);
  assert.equal(result.kind, 'tool-error');
  assert(result.kind === 'tool-error');
  assert.deepEqual(wireError(result.error), wire);
});

for (const tool of ['pointer', 'keyboard']) {
  test(`${tool} replay current_state remains an arbitrary state (§12.5:1966-1977)`, () => {
    const original = fixture('pointer.output.error-paused-aborted.json');
    const input = expectedInput(original);
    const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
    for (const current_state of ['gated', 'paused', 'disarmed', 'not_console', 'locked', 'display_asleep', 'permission_missing', 'permission_stale', 'secure_input', 'ok']) {
      const wire = { ...original, replayed: true, current_state, ...(tool === 'keyboard' ? { measured: { ...object(original.measured), global_point: null } } : {}) };
      const result = tool === 'pointer' ? boundary.pointer(wrap(tool, wire), expected) : boundary.keyboard(wrap(tool, wire), expected);
      assert.equal(result.kind, 'tool-error');
      assert(result.kind === 'tool-error');
      assert.deepEqual(wireError(result.error), wire);
    }
  });
}

test('null bundle identity retains a known process name and team (schemas/defs.json:235-239)', () => {
  const original = fixture('pointer.output.error-denied-app.json');
  const wire = { ...original, measured: { ...object(original.measured), target_app: { bundle_id: null, team_id: 'TEAM123456', name: 'Unbundled process' } } };
  const input = expectedInput(original);
  const expected = Object.freeze({ requestId: 17, ...input, frame: Object.freeze(input.frame), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
  const result = boundary.pointer(wrap('pointer', wire), expected);
  assert.equal(result.kind, 'tool-error');
  assert(result.kind === 'tool-error');
  assert.deepEqual(wireError(result.error), wire);
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

for (const direction of ['structured-negative', 'text-negative']) {
  test(`equivalent signed-zero JSON retains the structured coordinate ${direction}`, () => {
    const seed = fixture('pointer.output.completed.json');
    const measured = object(seed.measured);
    seed.measured = { ...measured, global_point: { ...object(measured.global_point), x: 0 } };
    const expected = Object.freeze({ requestId: 17, ...expectedInput(seed), action: 'target' } satisfies ExpectedReply & ExpectedPointer);
    const raw = wrap('pointer', seed);
    const serialized = JSON.stringify(raw);
    const received = object(JSON.parse(direction === 'structured-negative' ? serialized.replace('"x":0', '"x":-0') : serialized));
    if (direction === 'text-negative') {
      const result = object(received.result);
      received.result = { ...result, content: [{ type: 'text', text: JSON.stringify(seed).replace('"x":0', '"x":-0') }] };
    }
    const result = boundary.pointer(received, expected);
    assert.equal(result.kind, 'ok');
    assert(result.kind === 'ok');
    assert(Object.is(result.value.measured.globalPoint.x, direction === 'structured-negative' ? -0 : 0));
  });
}

test('JSON content equality rejects unequal numbers, types, own members and array order', () => {
  const seed = fixture('pointer.output.completed.json');
  const raw = wrap('pointer', seed);
  const measured = object(seed.measured);
  const changedNumber = { ...seed, measured: { ...measured, global_point: { ...object(measured.global_point), x: 999 } } };
  assert.equal(observe({ tool: 'pointer', expectationSeed: seed, receivedReply: { ...raw, result: { ...raw.result, content: [{ type: 'text', text: JSON.stringify(changedNumber) }] } } }).result.kind, 'rejected');
  const extended = { ...seed, future_field: { value: 1, order: [1, 2], nullable: null } };
  const extendedRaw = wrap('pointer', extended);
  assert.equal(observe({ tool: 'pointer', expectationSeed: seed, receivedReply: extendedRaw }).result.kind, 'ok');
  for (const future_field of [
    { value: '1', order: [1, 2], nullable: null },
    { order: [1, 2], nullable: null },
    { value: 1, order: [1, 2], nullable: null, added: true },
    { value: 1, order: [2, 1], nullable: null },
    { value: 1, order: [1, 2], nullable: {} },
  ]) {
    const receivedReply = { ...extendedRaw, result: { ...extendedRaw.result, content: [{ type: 'text', text: JSON.stringify({ ...extended, future_field }) }] } };
    assert.equal(observe({ tool: 'pointer', expectationSeed: seed, receivedReply }).result.kind, 'rejected');
  }
});

test('JSON equality rejects non-JSON leaves directly and in containers', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'), () => undefined]) {
    assert.equal(sameJsonValue(value, value), false);
    assert.equal(sameJsonValue({ value }, { value }), false);
    assert.equal(sameJsonValue([value], [value]), false);
  }
});

for (const status of ['accepted', 'failed_before_execution']) {
  for (const tool of ['status', 'pointer', 'keyboard']) {
    test(`zero-input operation status ${status} requires zero events in ${tool}`, () => {
      const original = fixture(tool === 'status' ? 'status.output.operation-found.json' : 'keyboard.output.error-operation-id-conflict.json');
      const seed = Object.freeze({ ...original, operation: { status, events_posted: 0 } });
      const unchanged = observe({ tool, expectationSeed: seed });
      assert.equal(unchanged.result.kind, tool === 'status' ? 'ok' : 'tool-error');
      assert.deepEqual(unchanged.reconstructed, seed);
      const received = { ...seed, operation: { status, events_posted: 7 } };
      assert.equal(observe({ tool, expectationSeed: seed, receivedReply: wrap(tool, received) }).result.kind, 'rejected');
    });
  }
}

test('executing counts and restart lower bounds retain zero and positive evidence', () => {
  for (const events_posted of [0, 7]) {
    for (const status of ['executing', 'aborted_by_restart']) {
      const seed = fixture('status.output.operation-found.json');
      const received = { ...seed, operation: { status, events_posted } };
      const lookup = boundary.lookup(wrap('status', received), { requestId: 17, operationId: operationId(fallback.operation_id) });
      assert.equal(lookup.kind, 'ok');
      assert(lookup.kind === 'ok' && lookup.value.record.kind !== 'not-recorded-now');
      assert.deepEqual(lookup.value.record.events, { kind: status === 'executing' ? 'exact' : 'lower-bound', value: events_posted });
      for (const tool of ['pointer', 'keyboard']) {
        const error = fixture(status === 'executing' ? 'keyboard.output.error-operation-in-progress.json' : 'keyboard.output.error-interrupted.json');
        const observed = observe({ tool, expectationSeed: error, receivedReply: wrap(tool, { ...error, operation: { status, events_posted } }) }).result;
        assert.equal(observed.kind, 'tool-error');
        assert(observed.kind === 'tool-error' && observed.error.operation.kind === 'present');
        assert.deepEqual(observed.error.operation.value.events, { kind: status === 'executing' ? 'exact' : 'lower-bound', value: events_posted });
      }
    }
  }
});

for (const { tool, code, seedName } of [
  { tool: 'pointer', code: 'cleanup_pending', seedName: null },
  { tool: 'pointer', code: 'lease_held_by_other', seedName: 'pointer.output.error-lease-held-by-other.json' },
  { tool: 'pointer', code: 'lease_expired', seedName: null },
  { tool: 'pointer', code: 'lease_not_held', seedName: null },
  { tool: 'keyboard', code: 'rate_limited', seedName: 'keyboard.output.error-rate-limited.json' },
  { tool: 'pointer', code: 'operation_capacity', seedName: null },
  { tool: 'pointer', code: 'stale_frame', seedName: 'pointer.output.error-stale-frame.json' },
  { tool: 'pointer', code: 'out_of_frame', seedName: 'pointer.output.error-out-of-frame.json' },
  { tool: 'pointer', code: 'user_active', seedName: null },
  { tool: 'keyboard', code: 'denied_shortcut', seedName: 'keyboard.output.error-denied-shortcut.json' },
  { tool: 'pointer', code: 'denied_app', seedName: 'pointer.output.error-denied-app.json' },
  { tool: 'keyboard', code: 'log_unavailable', seedName: 'keyboard.output.error-log-unavailable.json' },
] satisfies ReadonlyArray<{ tool: 'pointer' | 'keyboard'; code: string; seedName: string | null }>) {
  test(`late nonadmitted refusal ${code} cannot carry an existing operation record`, () => {
    const seed = Object.freeze(seedName === null ? {
      code, message: 'Refusal before admission', state: 'ok', operation_id: fallback.operation_id,
      ...(code === 'user_active' ? { details: { idle_ms: 1 } } : {}),
    } : fixture(seedName));
    const unchanged = observe({ tool, expectationSeed: seed });
    assert.equal(unchanged.result.kind, 'tool-error');
    assert.deepEqual(unchanged.reconstructed, seed);
    const received = { ...seed, operation_id: seed.operation_id ?? fallback.operation_id, operation: { status: 'completed', events_posted: 2 } };
    assert.equal(observe({ tool, expectationSeed: seed, receivedReply: wrap(tool, received) }).result.kind, 'rejected');
  });
}

test('early refusals retain prior records while admitted and replayed aborts retain their own records', () => {
  const state = fixture('pointer.output.error-paused-aborted.json');
  delete state.replayed;
  delete state.measured;
  const invalid = fixture('status.output.error-invalid-argument.json');
  const internal: Record<string, unknown> = { code: 'internal_error', message: 'Internal failure before admission', state: 'ok' };
  for (const seed of [state, invalid, fixture('keyboard.output.error-busy.json'), fixture('keyboard.output.error-operation-in-progress.json'), fixture('keyboard.output.error-operation-id-conflict.json'), internal]) {
    const wire = { ...seed, operation_id: seed.operation_id ?? fallback.operation_id, operation: seed.operation ?? { status: 'completed', events_posted: 2 } };
    assert.deepEqual(observe({ tool: 'pointer', expectationSeed: wire }).reconstructed, wire);
  }
  const lease = fixture('pointer.output.error-paused-aborted.json');
  lease.code = 'lease_expired';
  lease.state = 'ok';
  for (const { seed, expectedAction } of [
    { seed: fixture('pointer.output.error-denied-app-drag-aborted.json'), expectedAction: 'drag' },
    { seed: fixture('pointer.output.error-user-active-aborted.json'), expectedAction: 'drag' },
    { seed: lease, expectedAction: 'target' },
  ] satisfies ReadonlyArray<{ seed: Record<string, unknown>; expectedAction: ExpectedPointer['action'] }>) {
    for (const replayed of [false, true]) {
      const wire = { ...seed, replayed, ...(replayed ? { current_state: 'ok' } : {}) };
      const observed = observe({ tool: 'pointer', expectationSeed: wire, expectedAction });
      assert.equal(observed.result.kind, 'tool-error');
      assert.deepEqual(observed.reconstructed, wire);
    }
  }
});

for (const tool of ['pointer', 'keyboard']) {
  test(`stale-frame reason belongs to the selected ${tool} tool before admission`, () => {
    const original = fixture('pointer.output.error-stale-frame.json');
    const seed = Object.freeze({ ...original, details: { reason: tool === 'pointer' ? 'pixels_changed' : 'frontmost_changed', point_index: 0 } });
    assert.equal(observe({ tool, expectationSeed: seed }).result.kind, 'tool-error');
    const received = { ...seed, details: { ...seed.details, reason: tool === 'pointer' ? 'frontmost_changed' : 'pixels_changed' } };
    assert.equal(observe({ tool, expectationSeed: seed, receivedReply: wrap(tool, received) }).result.kind, 'rejected');
  });
}

test('admitted stale-frame abort identifies the first point only', () => {
  const seed = Object.freeze(fixture('pointer.output.error-stale-frame-before-first-event.json'));
  assert.deepEqual(observe({ tool: 'pointer', expectationSeed: seed }).reconstructed, seed);
  const received = { ...seed, details: { ...object(seed.details), point_index: 1 } };
  assert.equal(observe({ tool: 'pointer', expectationSeed: seed, receivedReply: wrap('pointer', received) }).result.kind, 'rejected');
});

test('preadmission drag final-point indices and unrelated diagnostic reasons remain valid', () => {
  const original = fixture('pointer.output.error-stale-frame.json');
  const drag = { ...original, details: { ...object(original.details), point_index: 3 } };
  const expected = Object.freeze({ requestId: 17, ...expectedInput(original), action: 'drag' } satisfies ExpectedReply & ExpectedPointer);
  const result = boundary.pointer(wrap('pointer', drag), expected);
  assert.equal(result.kind, 'tool-error');
  assert(result.kind === 'tool-error');
  assert.deepEqual(wireError(result.error), drag);
  const unrelated = fixture('pointer.output.error-out-of-frame.json');
  unrelated.details = { ...object(unrelated.details), reason: 'frontmost_changed' };
  assert.deepEqual(observe({ tool: 'pointer', expectationSeed: unrelated }).reconstructed, unrelated);
});

for (const tool of ['pointer', 'keyboard']) {
  test(`${tool} tool errors correlate the received operation ID against the unchanged expectation`, () => {
    const seed = Object.freeze(fixture('keyboard.output.error-operation-in-progress.json'));
    const expected = Object.freeze({ requestId: 17, ...expectedInput(seed) });
    const read = (wire: Record<string, unknown>) => tool === 'pointer'
      ? boundary.pointer(wrap(tool, wire), { ...expected, action: 'target' })
      : boundary.keyboard(wrap(tool, wire), expected);
    assert.equal(read(seed).kind, 'tool-error');
    const result = read({ ...seed, operation_id: 'other-operation' });
    assert.deepEqual(result, { kind: 'rejected', failure: { kind: 'contract', reason: 'correlation', stage: 'relationship' } });
  });
}

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

for (const { name, source, reason } of [
  { name: 'private owner', source: "import('./deskhand/contract.ts', {});", reason: 'private-edge' },
  { name: 'exact private test', source: "import('../../tests/service/deskhand-results.test.ts', {});", reason: 'private-test-edge' },
  { name: 'computed configuration', source: "const configPath = './deskhand/contract.ts'; import(configPath, {});", reason: null },
]) {
  test(`the real import fence inspects two-argument dynamic imports of ${name}`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'deskhand-import-options-'));
    const write = (path: string, contents: string) => { const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents); };
    try {
      write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }));
      write('src/service/deskhand/contract.ts', 'export const hidden = 1;');
      write('tests/service/deskhand-results.test.ts', '');
      write('src/service/consumer.ts', source);
      const result = spawnSync(process.execPath, [join(root, 'scripts/check-deskhand-boundary-imports.mjs'), '--root', temporary], { encoding: 'utf8' });
      assert.equal(result.status, reason === null ? 0 : 1, result.stdout + result.stderr);
      if (reason !== null) {
        const reported = object(JSON.parse(result.stderr));
        assert.deepEqual(reported.violations, [{ file: 'src/service/consumer.ts', reason }]);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}

test('separately compiled negative callers reject each forbidden type use', () => {
  const filename = join(root, 'tests/service/deskhand-results.types.ts');
  const prelude = `import type { FramePoint, GlobalPoint, OperationId, FrameId, KeyboardCompletion, ToolError, OperationRecord, ScreenshotObservation, ResultBoundary, Display } from '../../src/service/deskhand/contract.ts';
declare const global: GlobalPoint;
declare const operation: OperationId;
declare const keyboard: KeyboardCompletion;
declare const screenshotError: ToolError<'screenshot'>;
declare const record: Extract<OperationRecord, {kind:'ended-by-restart'}>;
declare const metadata: ScreenshotObservation;
declare const boundary: ResultBoundary;
`;
  const failures = [
    "const sleeping: Display['asleep'] = true;",
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
    for (const path of ['src/service/deskhand', 'src/service/json-values.ts', 'vendor/deskhand', 'tests/service/deskhand-results.test.ts', 'package.json', 'tsconfig.json']) {
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

for (const mode of ['unreviewed generation', 'conflicting check and record']) {
  test(`generator ${mode} rejects without changing artifacts`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'deskhand-generator-state-'));
    const outputs = ['src/service/deskhand/vocabulary.generated.ts', 'tests/fixtures/deskhand-results/vocabulary-provenance.json',
      'tests/fixtures/deskhand-results/schema-inventory.json', 'tests/fixtures/deskhand-results/reviewed-sources.json'];
    try {
      for (const path of ['scripts/generate-deskhand-vocabulary.mjs', 'vendor/deskhand', ...outputs]) {
        const target = join(temporary, path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, path), target, { recursive: true });
      }
      const snapshot = () => outputs.map(path => readFileSync(join(temporary, path), 'utf8'));
      const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/generate-deskhand-vocabulary.mjs', ...args], { cwd: temporary, encoding: 'utf8' });
      const original = snapshot();
      assert.equal(run('--check').status, 0);
      assert.equal(run().status, 0);
      assert.deepEqual(snapshot(), original);
      const path = join(temporary, 'vendor/deskhand/contract-v0.11-draft/docs/schemas/defs.json');
      const schema = JSON.parse(readFileSync(path, 'utf8'));
      schema.$defs.state.enum.push('new_state');
      writeFileSync(path, JSON.stringify(schema));
      if (mode === 'conflicting check and record') {
        assert.equal(run('--record-reviewed-pin').status, 0);
        assert.equal(run('--check').status, 0);
        writeFileSync(join(temporary, outputs[3]), original[3]);
      }
      const before = snapshot();
      const rejected = mode === 'unreviewed generation' ? run() : run('--check', '--record-reviewed-pin');
      assert.equal(rejected.status, 1);
      assert.deepEqual(snapshot(), before, 'Rejected generation must preserve generated and review bytes');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}

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
