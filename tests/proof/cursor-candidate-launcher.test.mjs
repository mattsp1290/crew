import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = join(root, 'scripts/qualify-cursor-restricted-text.mjs');
const image = `node@sha256:${'0'.repeat(64)}`;
function run(args) {
  // An empty PATH proves that rejected inputs and help never reach Docker.
  return spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', env: { PATH: '' } });
}

test('candidate launcher documents incomplete qualification and rejects unknown arguments', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /2: offline checks passed, live gates pending/);
  const invalid = run(['--credential', 'synthetic-secret-never-log']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'candidate_audit_failed\n');
});

test('candidate bytes must match the reviewed artifact before Docker or output writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crew-candidate-test-'));
  try {
    const archive = join(directory, 'invalid.tgz');
    await writeFile(archive, 'unreviewed-candidate');
    const result = run(['--candidate', archive, '--node-image', image, '--out', join(directory, 'evidence')]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'candidate_hash_mismatch\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('evidence paths inside the repository are refused, including through symlink parents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crew-candidate-test-'));
  try {
    await symlink(root, join(directory, 'repo'));
    for (const out of [join(root, 'candidate-evidence'), join(directory, 'repo', 'candidate-evidence')]) {
      const result = run(['--candidate', '/does-not-exist.tgz', '--node-image', image, '--out', out]);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, 'evidence_must_be_outside_repository\n');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mutable image references are refused before any subprocess', () => {
  const result = run(['--candidate', '/does-not-exist.tgz', '--node-image', 'node:24', '--out', '/tmp/new-evidence']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'invalid_arguments\n');
});
