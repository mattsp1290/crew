import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.BIRBCREW_PROOF_ARTIFACTS;
assert(root);
const checks = [];
let passed = false;
try {
  const owners = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name, 'ownership.json'));
  assert(owners.length > 0 && owners.length <= 16);
  const processes = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const text = readFileSync(`/proc/${name}/stat`, 'utf8');
      const [state, , group] = text.slice(text.lastIndexOf(')') + 2).split(' ');
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return state === 'Z' || state === 'X' ? [] : [{ pid: Number(name), group: Number(group), args }];
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
  });
  for (const path of owners) {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    assert.match(owner.container, /^birb-proof-[a-f0-9-]+$/);
    const container = execFileSync('docker', ['ps', '-aq', '--filter', `name=^/${owner.container}$`],
      { encoding: 'utf8', timeout: 3000 }).trim();
    const collector = JSON.parse(readFileSync(join(dirname(path), 'collector.json'), 'utf8'));
    assert(Number.isSafeInteger(collector.pid) && collector.pid > 0, 'Missing collector process identity');
    const liveGroups = processes.filter(proc => proc.group === collector.pid || owner.processes.some(owned => owned.pid === proc.group));
    const lingeringCommands = processes.filter(proc => proc.args.some(arg => arg === owner.container || arg.startsWith(owner.directory) || arg.startsWith(dirname(path))));
    assert.deepEqual(lingeringCommands, []);
    const cleanup = JSON.parse(readFileSync(join(dirname(path), 'cleanup.json'), 'utf8'));
    assert.equal(cleanup.resources.container, 'absent'); assert.equal(cleanup.resources.directory, 'absent');
    assert(cleanup.resources.processes.every(proc => proc.status === 'absent'));
    let directoryAbsent = false;
    try { lstatSync(owner.directory); } catch (error) { if (error.code !== 'ENOENT') throw error; directoryAbsent = true; }
    checks.push({ container: owner.container, containerAbsent: container === '', liveGroups, directory: owner.directory, directoryAbsent });
    assert.equal(container, ''); assert.deepEqual(liveGroups, []); assert.equal(directoryAbsent, true);
  }
  const commands = readdirSync(root).filter(name => name.endsWith('.stdout.log.result.json'));
  assert(commands.includes('tls.stdout.log.result.json'), 'Missing exact retained TLS command receipt');
  for (const name of commands) {
    const command = JSON.parse(readFileSync(join(root, name), 'utf8'));
    assert(Number.isSafeInteger(command.pid) && command.pid > 0, 'Missing command process identity');
    assert.notEqual(command.outcome.kind, 'unknown');
    const liveGroups = processes.filter(proc => proc.group === command.pid);
    checks.push({ command: name, group: command.pid, liveGroups });
    assert.deepEqual(liveGroups, []);
  }
  passed = true;
} finally {
  writeFileSync(join(root, 'independent-resource-check.json'), JSON.stringify({ independent: true, passed, checks }, null, 2));
}
