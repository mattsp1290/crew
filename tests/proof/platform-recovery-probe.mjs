import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const startedUTC = new Date().toISOString();
const deadline = performance.now() + 28_000;
const root = process.env.BIRBCREW_PROOF_ARTIFACTS;
assert(root && isAbsolute(root), 'Missing absolute artifact root');
const report = {
  kind: 'platform-cancellation-probe', startedUTC, contractsConclusion: process.env.CONTRACTS_CONCLUSION ?? 'missing',
  qualified: false, ownerStopped: false, workerStopped: false, failures: [], attempts: [],
  resources: { processes: 'unknown', container: 'unknown', directory: 'unknown' },
  limitation: 'Service environments omit RUNNER_TRACKING_ID. This probe uses exact recorded identities and does not attest global process absence or runner finalization.',
};
function persist() {
  report.finishedUTC = new Date().toISOString();
  writeFileSync(join(root, 'platform-recovery.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
const watchdog = setTimeout(() => {
  report.failures.push('Internal 29-second recovery bound exceeded; qualification unknown');
  try { persist(); } finally { process.exit(1); }
}, 29_000);
function remaining(cap = 1_500) {
  const value = Math.floor(Math.min(cap, deadline - performance.now()));
  assert(value > 0, 'Recovery deadline exceeded');
  return value;
}
function missing(error) { return error && ['ENOENT', 'ESRCH'].includes(error.code); }
function regular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { assert(fstatSync(fd).isFile(), 'Evidence must be a regular file'); return readFileSync(fd, 'utf8'); }
  finally { closeSync(fd); }
}
const procSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(),
  group: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), state: z.string().length(1) });
const ownershipSchema = z.object({ label: z.literal('contract'), directory: z.string(),
  container: z.string().regex(/^birb-proof-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  allocation: z.object({ kind: z.literal('settled'), container: z.string().regex(/^[0-9a-f]{64}$/) }),
  processes: z.array(z.object({ pid: z.number().int().positive(), log: z.string(),
    identity: z.object({ kind: z.literal('known'), group: z.number().int().positive(), startTime: z.string().regex(/^\d+$/) }) })).min(2),
});
const readySchema = ownershipSchema.extend({ probe: z.object({ kind: z.literal('platform-cancellation-probe'),
  mode: z.literal('catchable'), readyUTC: z.iso.datetime(), fixtureOwner: procSchema, contractWorker: procSchema }) });
function identity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return procSchema.parse({ pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), startTime: fields[19] });
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
const live = proc => proc && proc.state !== 'Z' && proc.state !== 'X';
const key = proc => `${proc.pid}:${proc.startTime}`;
function table() {
  remaining();
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => identity(Number(name))).filter(live);
}
function same(actual, expected) {
  assert.equal(actual.startTime, expected.startTime, 'PID start identity changed; refusing a guessed signal');
  assert.equal(actual.group, expected.group, 'Process group identity changed');
}
function command(program, args, cap = 1_500) {
  try { return execFileSync(program, args, { encoding: 'utf8', timeout: remaining(cap), killSignal: 'SIGKILL', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`${program} exact operation unavailable, status ${error.status ?? 'unknown'}, code ${error.code ?? 'unknown'}`); }
}
async function attempt(name, operation) {
  const attemptStartedUTC = new Date().toISOString();
  try { await operation(); report.attempts.push({ name, startedUTC: attemptStartedUTC, status: 'passed' }); }
  catch (error) {
    report.failures.push(`${name}: ${error.message}`);
    report.attempts.push({ name, startedUTC: attemptStartedUTC, status: 'unknown', error: error.message });
  }
}
function receiptAvailability(artifacts) {
  return Object.fromEntries(['cleanup.json', 'first-failure.txt', 'collector.json'].map(name => {
    try { const text = regular(join(artifacts, name)); return [name, { kind: 'available', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }]; }
    catch (error) { return [name, { kind: missing(error) ? 'missing' : 'unavailable' }]; }
  }));
}
let evidence, artifacts;
const owned = new Map();
function census() {
  const current = table();
  const anchors = current.filter(proc => owned.has(key(proc)));
  for (const proc of anchors) same(proc, owned.get(key(proc)));
  const related = new Set(anchors.map(proc => proc.pid));
  const groups = new Set(anchors.map(proc => proc.group));
  for (let size = -1; size !== related.size;) {
    size = related.size;
    for (const proc of current) if (related.has(proc.parent) || groups.has(proc.group)) {
      related.add(proc.pid);
      if (proc.pid === proc.group) groups.add(proc.group);
    }
  }
  for (const proc of current) if (related.has(proc.pid)) {
    assert(groups.has(proc.group), 'Descendant has no verified owned group');
    owned.set(key(proc), proc);
  }
  return current;
}
function validateDirectory(path) {
  const temporary = realpathSync(tmpdir());
  assert(isAbsolute(path) && /^birb-members-[a-zA-Z0-9]+$/.test(basename(path)), 'Unexpected private fixture directory');
  assert.equal(realpathSync(dirname(path)), temporary, 'Fixture directory is outside actual temporary root');
  assert.notEqual(resolve(path), temporary, 'Refusing temporary root');
  assert.notEqual(resolve(path), resolve(root), 'Refusing artifact root');
  let metadata;
  try { metadata = lstatSync(path); }
  catch (error) { if (missing(error)) return 'absent'; throw error; }
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Fixture directory is not a real directory');
  assert.equal(dirname(realpathSync(path)), temporary, 'Fixture directory escaped actual temporary root');
  assert.equal(regular(join(path, '.fixture-owner')), evidence.container, 'Fixture directory marker mismatch');
  return 'present';
}
function containerObservation() {
  const byName = command('docker', ['ps', '-aq', '--no-trunc', '--filter', `name=^/${evidence.container}$`]);
  const byId = command('docker', ['ps', '-aq', '--no-trunc', '--filter', `id=${evidence.allocation.container}`]);
  if (!byName && !byId) return { status: 'absent', byName, byId };
  assert.equal(byName, evidence.allocation.container, 'Exact container name has a different allocation');
  assert.equal(byId, evidence.allocation.container, 'Exact allocated container is unavailable or renamed');
  const inspected = command('docker', ['inspect', '--format', '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', evidence.allocation.container]);
  assert.equal(inspected, `${evidence.allocation.container} /${evidence.container} ${evidence.container}`, 'Container ID/name/label mismatch');
  return { status: 'present', id: byId, name: evidence.container, label: evidence.container };
}
async function stopPid(expected, grace, observe = false) {
  let current = identity(expected.pid);
  if (!live(current)) return;
  same(current, expected);
  assert.notEqual(current.pid, process.pid, 'Refusing to signal recovery process');
  try { process.kill(expected.pid, 'SIGTERM'); } catch (error) { if (!missing(error)) throw error; }
  const until = Math.min(deadline - 2_000, performance.now() + grace);
  while (performance.now() < until) {
    if (observe) census();
    current = identity(expected.pid);
    if (!live(current)) return;
    same(current, expected);
    await delay(Math.min(100, remaining()));
  }
  current = identity(expected.pid);
  if (live(current)) {
    same(current, expected);
    try { process.kill(expected.pid, 'SIGKILL'); } catch (error) { if (!missing(error)) throw error; }
  }
  const forceEnd = Math.min(deadline - 500, performance.now() + 1_000);
  while (live(identity(expected.pid)) && performance.now() < forceEnd) await delay(50);
  current = identity(expected.pid);
  if (live(current)) { same(current, expected); throw new Error('Known owner remains alive after force'); }
}
try {
  await attempt('strict readiness and ownership', async () => {
    assert(lstatSync(root).isDirectory(), 'Artifact root is not a real directory');
    const roots = readdirSync(root, { withFileTypes: true }).filter(entry => entry.name.startsWith('crew-contract-'));
    assert.equal(roots.length, 1, 'Expected exactly one known contract root; empty enumeration is unknown');
    const entry = roots[0];
    assert(entry.isDirectory() && /^crew-contract-[a-zA-Z0-9]+$/.test(entry.name), 'Unexpected contract root');
    const contractRoot = join(root, entry.name);
    assert.equal(dirname(realpathSync(contractRoot)), realpathSync(root), 'Contract root escaped artifact root');
    const entries = readdirSync(contractRoot).filter(name => name !== 'recovery.json');
    assert.equal(entries.length, 1, 'Expected exactly one fixture entry');
    assert(/^contract-[a-zA-Z0-9]+$/.test(entries[0]), 'Unexpected fixture entry');
    artifacts = join(contractRoot, entries[0]);
    assert(lstatSync(artifacts).isDirectory(), 'Fixture artifacts are not a real directory');
    assert.equal(dirname(realpathSync(artifacts)), realpathSync(contractRoot), 'Fixture artifacts escaped contract root');
    const ready = readySchema.parse(JSON.parse(regular(join(artifacts, 'timeout-ready.json'))));
    const ownership = ownershipSchema.parse(JSON.parse(regular(join(artifacts, 'ownership.json'))));
    assert.deepEqual(ownership, ownershipSchema.parse(ready), 'Current ownership differs from settled readiness');
    assert(Date.parse(ready.probe.readyUTC) <= Date.parse(startedUTC), 'Readiness does not precede recovery');
    assert.equal(ready.probe.fixtureOwner.pid, ready.probe.fixtureOwner.group, 'Fixture owner is not its isolated group leader');
    assert.equal(ready.probe.fixtureOwner.parent, ready.probe.contractWorker.pid, 'Fixture owner parent is not recorded contract worker');
    assert.notEqual(ready.probe.fixtureOwner.pid, ready.probe.contractWorker.pid, 'Owner identities overlap');
    for (const proc of ready.processes) {
      assert.equal(proc.pid, proc.identity.group, 'Service is not its isolated group leader');
      assert.notEqual(proc.pid, ready.probe.fixtureOwner.pid, 'Service identity overlaps fixture owner');
    }
    evidence = ready;
    report.evidence = { artifacts, ready };
    report.originalReceiptsBefore = receiptAvailability(artifacts);
    owned.set(key(ready.probe.fixtureOwner), ready.probe.fixtureOwner);
    for (const proc of ready.processes) {
      const known = { pid: proc.pid, ...proc.identity, parent: 0, state: 'R' };
      owned.set(key(known), known);
    }
    census();
  });
  if (evidence) {
    await attempt('pre-recovery observations', async () => {
      const pre = { observedUTC: new Date().toISOString(), failures: [] };
      for (const [name, observe] of [
        ['processes', () => census().filter(proc => owned.has(key(proc)) || [...owned.values()].some(known => known.group === proc.group))],
        ['owner', () => identity(evidence.probe.fixtureOwner.pid) ?? null],
        ['worker', () => identity(evidence.probe.contractWorker.pid) ?? null],
        ['container', containerObservation], ['directory', () => validateDirectory(evidence.directory)],
      ]) {
        try { pre[name] = observe(); }
        catch (error) { pre[name] = { status: 'unknown' }; pre.failures.push(`${name}: ${error.message}`); }
      }
      writeFileSync(join(root, 'platform-pre-observations.json'), JSON.stringify(pre, null, 2), { mode: 0o600 });
      assert.deepEqual(pre.failures, [], 'Pre-recovery inspection was unavailable; qualification unknown');
    });
    await attempt('stop exact contract worker before fixture fallback', async () => {
      await stopPid(evidence.probe.contractWorker, 1_000);
      assert(!live(identity(evidence.probe.contractWorker.pid)), 'Contract worker can still run normal recovery');
      report.workerStopped = true;
    });
    await attempt('stop exact fixture owner before resource fallback', async () => {
      assert(report.workerStopped, 'Normal disposer may still race recovery');
      await stopPid(evidence.probe.fixtureOwner, 7_500, true);
      assert(!live(identity(evidence.probe.fixtureOwner.pid)), 'Fixture owner can still acquire resources');
      report.ownerStopped = true;
      report.ownerStoppedUTC = new Date().toISOString();
    });
    if (report.workerStopped && report.ownerStopped) {
      await attempt('verified service and observed child groups', async () => {
        const current = census();
        const groups = [...new Set([...owned.values()].map(proc => proc.group))];
        for (const group of groups) {
          const members = current.filter(proc => proc.group === group);
          if (!members.length) continue;
          const anchor = members.find(proc => owned.has(key(proc)));
          assert(anchor, 'Live group has no surviving known start identity');
          const verified = identity(anchor.pid);
          assert(live(verified), 'Group identity vanished before signal; retry needed');
          same(verified, anchor);
          assert.notEqual(group, identity(process.pid)?.group, 'Refusing recovery process group');
          try { process.kill(-group, 'SIGKILL'); } catch (error) { if (!missing(error)) throw error; }
        }
        const end = Math.min(deadline - 1_000, performance.now() + 2_000);
        while (performance.now() < end && table().some(proc => groups.includes(proc.group))) await delay(50);
        assert(!table().some(proc => groups.includes(proc.group)), 'Owned process group remains');
        report.resources.processes = 'absent';
      });
      await attempt('exact settled container fallback', async () => {
        if (containerObservation().status === 'present') command('docker', ['rm', '-f', evidence.allocation.container], 2_000);
        assert.equal(containerObservation().status, 'absent', 'Exact allocated container remains');
        report.resources.container = 'absent';
      });
      await attempt('marked private directory fallback', async () => {
        assert.equal(report.resources.processes, 'absent', 'Known service processes may still write private directory');
        if (validateDirectory(evidence.directory) === 'present') {
          command('chmod', ['-R', 'u+rwX', '--', evidence.directory]);
          assert.equal(validateDirectory(evidence.directory), 'present', 'Directory changed before deletion');
          command('rm', ['-rf', '--', evidence.directory], 2_000);
        }
        assert.equal(validateDirectory(evidence.directory), 'absent', 'Private fixture directory remains');
        report.resources.directory = 'absent';
      });
    }
    report.observedOwnedProcesses = [...owned.values()];
    report.originalReceiptsAfter = receiptAvailability(artifacts);
  }
  if (report.contractsConclusion !== 'cancelled') report.failures.push('Contract step conclusion was not cancelled; trial is inconclusive');
  report.qualified = Boolean(evidence) && report.contractsConclusion === 'cancelled' && report.workerStopped && report.ownerStopped && report.failures.length === 0 && Object.values(report.resources).every(value => value === 'absent');
} catch (error) { report.failures.push(error.message); }
finally { clearTimeout(watchdog); persist(); }
process.exitCode = report.qualified ? 0 : 1;
