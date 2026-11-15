import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import {
  createResultBoundary, endpointIdentity, holderId, operationId, frameId, displayId,
  type AppIdentity, type CallerLease, type DesktopStatus, type DisplayCatalog, type ScreenshotObservation,
  type PointerCompletion, type KeyboardCompletion, type PointerErrorMeasurement, type KeyboardErrorMeasurement,
  type ExpectedPointer, type OperationRecord, type ToolError, type ToolName, type KnownDiagnostics, type LeaseOutcome, type ResultBoundary,
} from '../../../src/service/deskhand/contract.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const examples = join(root, 'vendor/deskhand/contract-v0.11-draft/docs/schemas/examples');
const context = { endpoint: endpointIdentity('https://fixture.invalid/mcp'), holderId: holderId('crew-fixture'), expectedMac: 'lunus-macbook-pro' };
export const boundary = createResultBoundary(context);
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
export function fixture(name: string): Record<string, unknown> { return object(JSON.parse(readFileSync(join(examples, name), 'utf8'))); }
export function wrap(tool: string, wire: Record<string, unknown>, id: string | number = 17) {
  const isError = Object.hasOwn(wire, 'code');
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', isError, structuredContent: wire,
    content: [...(tool === 'screenshot' && !isError ? [{ type: 'image', data: 'corpus-placeholder', mimeType: wire.mime_type }] : []), { type: 'text', text: JSON.stringify(wire) }] } };
}
export const fallback = fixture('pointer.output.completed.json');
export function expectedInput(wire: Record<string, unknown>) {
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
export function wireStatus(status: DesktopStatus) {
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
export function wireDisplays(catalog: DisplayCatalog) {
  return { display_config_generation: catalog.generation, displays: catalog.displays.map((display) => ({
    display_id: display.id, uuid: display.uuid, name: display.name, is_main: display.isMain, is_builtin: display.isBuiltin,
    asleep: display.asleep, bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
    pixel_size: display.pixels, point_pixel_scale: display.pointPixelScale,
  })) };
}
export function wireScreenshot(observation: ScreenshotObservation) {
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
export function wireError(error: ToolError<ToolName>) {
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
export function canonicalEchoReply(tool: string, wire: Record<string, unknown>) {
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
export function observe({ tool, expectationSeed: wire, receivedReply: raw = wrap(tool, wire), requestId = 17, owner = boundary, expectedAction }: {
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

