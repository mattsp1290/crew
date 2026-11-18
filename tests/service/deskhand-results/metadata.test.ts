import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationId, type ResultBoundary } from '../../../src/service/deskhand/contract.ts';
import { boundary, object, fixture, wrap, fallback, wireStatus, wireDisplays, wireScreenshot, wireError } from './support.ts';

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
