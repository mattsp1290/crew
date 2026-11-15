import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sameJsonValue } from '../../../src/service/json-values.ts';
import type { ExpectedPointer, ExpectedReply } from '../../../src/service/deskhand/contract.ts';
import { examples, boundary, object, fixture, wrap, expectedInput, wireError, canonicalEchoReply, observe } from './support.ts';

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
