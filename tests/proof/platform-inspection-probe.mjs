import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const root = process.env.BIRBCREW_PROOF_ARTIFACTS;
assert(root && isAbsolute(root), 'Missing absolute artifact root');
const deadline = performance.now() + 28_000;
const result = { independent: true, readOnlyResources: true, startedUTC: new Date().toISOString(), qualified: false, failures: [], observations: [] };
const procSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(),
  group: z.number().int().nonnegative(), startTime: z.string().regex(/^\d+$/), state: z.string().length(1) });
const positiveGroupProcSchema = procSchema.extend({ group: z.number().int().positive() });
const ownershipSchema = z.object({ label: z.literal('contract'), directory: z.string(),
  container: z.string().regex(/^birb-proof-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  allocation: z.object({ kind: z.literal('settled'), container: z.string().regex(/^[0-9a-f]{64}$/) }),
  processes: z.array(z.object({ pid: z.number().int().positive(), log: z.string(),
    identity: z.object({ kind: z.literal('known'), group: z.number().int().positive(), startTime: z.string().regex(/^\d+$/) }) })).min(2),
});
const readySchema = ownershipSchema.extend({ probe: z.object({ kind: z.literal('platform-cancellation-probe'),
  mode: z.enum(['catchable', 'forced']), readyUTC: z.iso.datetime(), fixtureOwner: positiveGroupProcSchema, contractWorker: positiveGroupProcSchema }) });
const recoverySchema = z.object({ qualified: z.boolean(), ownerStopped: z.boolean(), workerStopped: z.boolean(),
  contractsConclusion: z.string(), startedUTC: z.iso.datetime(), ownerStoppedUTC: z.iso.datetime(),
  observedOwnedProcesses: z.array(positiveGroupProcSchema).min(3) });
function persist() {
  result.finishedUTC = new Date().toISOString();
  writeFileSync(join(root, 'platform-post-observations.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
}
const watchdog = setTimeout(() => {
  result.failures.push('Internal 29-second inspection bound exceeded; qualification unknown');
  try { persist(); } finally { process.exit(1); }
}, 29_000);
function missing(error) { return error && ['ENOENT', 'ESRCH'].includes(error.code); }
function remaining() {
  const value = Math.floor(Math.min(1_500, deadline - performance.now()));
  assert(value > 0, 'Inspection deadline exceeded');
  return value;
}
function regular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { assert(fstatSync(fd).isFile(), 'Evidence must be a regular file'); return readFileSync(fd, 'utf8'); }
  finally { closeSync(fd); }
}
function identity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return procSchema.parse({ pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), startTime: fields[19] });
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
const live = proc => proc && proc.state !== 'Z' && proc.state !== 'X';
function table() {
  remaining();
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => identity(Number(name))).filter(live);
}
function docker(args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`Docker read-only inspection unavailable, status ${error.status ?? 'unknown'}, code ${error.code ?? 'unknown'}`); }
}
function inspectPid(expected) {
  expected = positiveGroupProcSchema.parse(expected);
  const actual = identity(expected.pid);
  if (!live(actual)) return { expected, status: 'absent', actual: actual ?? null };
  assert.equal(actual.startTime, expected.startTime, 'PID was reused; original process absence is unqualified');
  assert.equal(actual.group, expected.group, 'Known PID changed its process group');
  return { expected, status: 'present', actual };
}
function inspectDirectory(path, container) {
  const temporary = realpathSync(tmpdir());
  assert(isAbsolute(path) && /^birb-members-[a-zA-Z0-9]+$/.test(basename(path)), 'Unexpected private fixture directory');
  assert.equal(realpathSync(dirname(path)), temporary, 'Fixture directory is outside actual temporary root');
  assert.notEqual(resolve(path), temporary, 'Refusing temporary root');
  assert.notEqual(resolve(path), resolve(root), 'Refusing artifact root');
  let metadata;
  try { metadata = lstatSync(path); }
  catch (error) { if (missing(error)) return { status: 'absent', path }; throw error; }
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Fixture directory is not a real directory');
  assert.equal(dirname(realpathSync(path)), temporary, 'Fixture directory escaped actual temporary root');
  assert.equal(regular(join(path, '.fixture-owner')), container, 'Private fixture marker is missing or changed');
  return { status: 'present', path };
}
function inspectContainer(ready) {
  const byName = docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${ready.container}$`]);
  const byId = docker(['ps', '-aq', '--no-trunc', '--filter', `id=${ready.allocation.container}`]);
  if (!byName && !byId) return { status: 'absent', name: ready.container, id: ready.allocation.container, byName, byId };
  assert.equal(byName, ready.allocation.container, 'Exact name no longer matches allocated ID');
  assert.equal(byId, ready.allocation.container, 'Allocated ID no longer matches exact name');
  const inspected = docker(['inspect', '--format', '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', ready.allocation.container]);
  assert.equal(inspected, `${ready.allocation.container} /${ready.container} ${ready.container}`, 'Container ID/name/label mismatch');
  return { status: 'present', name: ready.container, id: ready.allocation.container, label: ready.container };
}
function check(observation, name, operation) {
  try {
    const value = operation();
    observation[name] = value;
    assert.equal(value.status, 'absent', `${name} remains present`);
  } catch (error) {
    observation.failures.push(`${name}: ${error.message}`);
    observation[name] ??= { status: 'unknown' };
  }
}
try {
  assert(lstatSync(root).isDirectory(), 'Artifact root is not a real directory');
  const roots = readdirSync(root, { withFileTypes: true }).filter(entry => entry.name.startsWith('crew-contract-'));
  assert.equal(roots.length, 1, 'Expected exactly one known contract root; empty enumeration is unknown');
  assert(roots[0].isDirectory() && /^crew-contract-[a-zA-Z0-9]+$/.test(roots[0].name), 'Unexpected contract root');
  const contractRoot = join(root, roots[0].name);
  assert.equal(dirname(realpathSync(contractRoot)), realpathSync(root), 'Contract root escaped artifact root');
  const entries = readdirSync(contractRoot).filter(name => name !== 'recovery.json');
  assert.equal(entries.length, 1, 'Expected exactly one fixture entry');
  assert(/^contract-[a-zA-Z0-9]+$/.test(entries[0]), 'Unexpected fixture entry');
  const artifacts = join(contractRoot, entries[0]);
  assert(lstatSync(artifacts).isDirectory(), 'Fixture artifacts are not a real directory');
  assert.equal(dirname(realpathSync(artifacts)), realpathSync(contractRoot), 'Fixture artifacts escaped contract root');
  const ready = readySchema.parse(JSON.parse(regular(join(artifacts, 'timeout-ready.json'))));
  assert.deepEqual(ownershipSchema.parse(JSON.parse(regular(join(artifacts, 'ownership.json')))), ownershipSchema.parse(ready), 'Ownership changed after settled readiness');
  const recovery = recoverySchema.parse(JSON.parse(regular(join(root, 'platform-recovery.json'))));
  assert.equal(ready.probe.fixtureOwner.pid, ready.probe.fixtureOwner.group, 'Fixture owner is not isolated group leader');
  assert.equal(ready.probe.fixtureOwner.parent, ready.probe.contractWorker.pid, 'Fixture owner parent mismatch');
  for (const proc of ready.processes) assert.equal(proc.pid, proc.identity.group, 'Recorded service group mismatch');
  result.readinessUTC = ready.probe.readyUTC;
  result.contractsConclusion = recovery.contractsConclusion;
  if (recovery.contractsConclusion !== 'cancelled') result.failures.push('Contract step was not cancelled; trial is inconclusive');
  if (!recovery.qualified || !recovery.ownerStopped || !recovery.workerStopped) result.failures.push('Recovery did not qualify stopped owners and exact resource absence');
  assert(Date.parse(ready.probe.readyUTC) <= Date.parse(recovery.startedUTC), 'Readiness did not precede recovery');
  assert(Date.parse(recovery.ownerStoppedUTC) <= Date.parse(result.startedUTC), 'Owner termination did not precede independent inspection');
  const known = [ready.probe.fixtureOwner, ...ready.processes.map(proc => ({ pid: proc.pid, ...proc.identity, parent: 0, state: 'R' })), ...recovery.observedOwnedProcesses];
  const groups = [...new Set(known.map(proc => proc.group))];
  for (let index = 0; index < 2; index++) {
    if (index) await delay(500);
    const observation = { index: index + 1, observedUTC: new Date().toISOString(), failures: [] };
    result.observations.push(observation);
    check(observation, 'fixtureOwner', () => inspectPid(ready.probe.fixtureOwner));
    check(observation, 'contractWorker', () => inspectPid(ready.probe.contractWorker));
    check(observation, 'processes', () => {
      const identities = known.map(inspectPid);
      const members = table().filter(proc => groups.includes(proc.group));
      return { status: members.length === 0 && identities.every(proc => proc.status === 'absent') ? 'absent' : 'present', groups, identities, members };
    });
    check(observation, 'container', () => inspectContainer(ready));
    check(observation, 'directory', () => inspectDirectory(ready.directory, ready.container));
    result.failures.push(...observation.failures.map(failure => `Observation ${index + 1}: ${failure}`));
    persist();
  }
  result.qualified = result.failures.length === 0 && result.observations.length === 2;
} catch (error) { result.failures.push(error.message); }
finally { clearTimeout(watchdog); persist(); }
process.exitCode = result.qualified ? 0 : 1;
