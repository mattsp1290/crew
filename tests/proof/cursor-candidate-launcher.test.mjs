import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

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
  assert.equal(invalid.stderr, 'invalid_arguments\n');
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

// These fixtures test orchestration failures only. They cannot qualify the SDK.
async function dockerFixture(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-candidate-orchestration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'repo');
  for (const path of ['scripts', 'packaging', 'tests/proof', 'tests/fixtures/cursor-candidate', 'bin']) {
    await mkdir(join(workspace, path), { recursive: true });
  }
  for (const path of ['scripts/qualify-cursor-restricted-text.mjs', 'packaging/cursor-candidate.Dockerfile',
    'tests/proof/cursor-candidate.mjs', 'tests/fixtures/cursor-candidate/package.json',
    'tests/fixtures/cursor-candidate/package-lock.json', 'tests/fixtures/cursor-candidate/contract.json']) {
    await copyFile(join(root, path), join(workspace, path));
  }
  await writeFile(join(directory, 'candidate.tgz'), 'synthetic-orchestration-fixture');
  await writeFile(join(workspace, 'tests/fixtures/cursor-candidate/candidate.json'), JSON.stringify({
    sha256: createHash('sha256').update('synthetic-orchestration-fixture').digest('hex'),
  }));
  const wrapper = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const root = process.env.FAKE_ROOT;
const mode = process.env.FAKE_MODE;
appendFileSync(root + '/commands.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'build') {
  writeFileSync(root + '/context.txt', args.at(-1));
  console.log('synthetic-build-started');
  if (mode === 'signal') await new Promise(resolve => setTimeout(resolve, 30000));
} else if (args[0] === 'image' && args[1] === 'inspect') {
  console.log(JSON.stringify({Id:'sha256:synthetic',Os:'linux',Architecture:'arm64'}));
} else if (args[0] === 'inspect') {
  console.log(JSON.stringify(mode === 'proxy' ? ['HTTP_PROXY=http://synthetic-secret@127.0.0.1:9'] : []));
} else if (args[0] === 'start') {
  const report = JSON.parse(readFileSync(root + '/repo/tests/fixtures/cursor-candidate/contract.json'));
  if (mode === 'supported') report.supported = true;
  console.log(JSON.stringify(mode === 'empty' ? {} : report));
} else if (args[0] === 'image' && args[1] === 'rm' && mode === 'cleanup') {
  process.stderr.write('synthetic-daemon-unavailable');
  process.exitCode = 1;
}
`;
  await writeFile(join(workspace, 'bin/docker'), wrapper, { mode: 0o700 });
  const child = spawn(process.execPath, [join(workspace, 'scripts/qualify-cursor-restricted-text.mjs'),
    '--candidate', join(directory, 'candidate.tgz'), '--node-image', image, '--out', join(directory, 'evidence')], {
    env: { PATH: join(workspace, 'bin'), FAKE_ROOT: directory, FAKE_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = once(child, 'close').then(([status]) => ({ status, stdout, stderr }));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { directory, child, done };
}

for (const mode of ['empty', 'supported']) {
  test(`unproven Docker output (${mode}) cannot become passing evidence`, { timeout: 10_000 }, async (t) => {
    const { directory, done } = await dockerFixture(t, mode);
    const result = await done;
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'contract_mismatch\n');
    assert.doesNotMatch(result.stdout, /checks passed/);
    await assert.rejects(readFile(join(directory, 'evidence/evidence.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(directory, 'evidence/cleanup.json'), 'utf8')).complete, true);
  });
}

test('cleanup failures prevent success and remain recorded', { timeout: 10_000 }, async (t) => {
  const { directory, done } = await dockerFixture(t, 'cleanup');
  const result = await done;
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'cleanup_failed\n');
  assert.doesNotMatch(result.stdout, /checks passed/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'evidence/cleanup.json'), 'utf8')),
    { complete: false, failedOperations: ['image'] });
});

test('unexpected container credentials are rejected before startup and excluded from logs', { timeout: 10_000 }, async (t) => {
  const { directory, done } = await dockerFixture(t, 'proxy');
  const result = await done;
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'environment_mismatch\n');
  assert.doesNotMatch(result.stderr + result.stdout, /synthetic-secret/);
  await assert.rejects(readFile(join(directory, 'evidence/environment.stdout')), { code: 'ENOENT' });
  const commands = (await readFile(join(directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(commands.some((args) => args[0] === 'start'), false);
});

test('SIGTERM preserves partial logs and cleans the build context and resources', { timeout: 10_000 }, async (t) => {
  const { directory, child, done } = await dockerFixture(t, 'signal');
  let context;
  for (let attempt = 0; attempt < 100; attempt++) {
    context = await readFile(join(directory, 'context.txt'), 'utf8').catch(() => undefined);
    if (context) break;
    await setTimeout(25);
  }
  assert.ok(context);
  child.kill('SIGTERM');
  const result = await done;
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'interrupted\n');
  assert.match(await readFile(join(directory, 'evidence/build.stdout'), 'utf8'), /synthetic-build-started/);
  await assert.rejects(readFile(join(context, 'candidate.tgz')), { code: 'ENOENT' });
  const commands = (await readFile(join(directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(commands.some((args) => args[0] === 'rm'));
  assert.ok(commands.some((args) => args[0] === 'image' && args[1] === 'rm'));
});
