import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointIdentity, holderId, operationId, frameId, displayId, type ExpectedPointer, type ExpectedReply } from '../../../src/service/deskhand/contract.ts';
import { boundary, object, fixture, wrap, fallback, expectedInput, wireError, canonicalEchoReply, observe } from './support.ts';

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
