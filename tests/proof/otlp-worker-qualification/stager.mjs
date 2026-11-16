import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, openSync, closeSync, constants } from 'node:fs';

assert.equal(process.platform, 'linux');
assert.equal(process.version, 'v24.22.3');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.OTLP_PROBE_ONLY, 'NEVER_MERGE');
const root = realpathSync(process.env.GITHUB_WORKSPACE);
assert.equal(realpathSync(process.cwd()), root);
const here = dirname(fileURLToPath(import.meta.url));
assert.equal(here, join(root, 'tests/proof/otlp-worker-qualification'));
const artifacts = join(root, '.proof/artifacts/otlp-worker');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(path);
const manifest = JSON.parse(read(join(here, 'source-manifest.json')));
const mode = process.argv[2];
assert.ok(['--before', '--stage', '--verify'].includes(mode));
function write(name, value) {
  writeFileSync(join(artifacts, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (manifest.repositoryExclusions.includes(entry.name)) continue;
    assert.ok(!entry.isSymbolicLink(), `Unexpected source symlink ${name}`);
    if (entry.isDirectory()) files.push(...filesUnder(join(directory, entry.name), name + '/'));
    else if (entry.isFile()) files.push(name);
    else throw Error(`Unexpected source object ${name}`);
  }
  return files.sort();
}
function sourceSnapshot() {
  const observed = {};
  const authored = {
    'stager.mjs': 'tests/proof/otlp-worker-qualification/stager.mjs',
    'worker-probe.mts': 'tests/proof/otlp-worker-probe.mts',
    'workflow.yml': '.github/workflows/integration-api.yml',
    'plan.md': 'tests/proof/otlp-worker-qualification/plan.md',
    'clean-bytes.json': 'tests/proof/otlp-worker-qualification/clean-bytes.json',
  };
  for (const [name, path] of Object.entries(authored)) assert.equal(sha(read(join(root, path))), manifest.authoredSources[name].sha256, `Reviewed probe artifact ${name}`);
  const exceptions = new Set(manifest.probeOnlyExceptions);
  const names = filesUnder(root);
  for (const name of names) {
    const digest = sha(read(join(root, name)));
    observed[name] = digest;
    if (!exceptions.has(name)) assert.equal(digest, manifest.repositoryFiles[name], `Source drift ${name}`);
  }
  for (const name of Object.keys(manifest.repositoryFiles)) {
    assert.ok(name in observed, `Missing source ${name}`);
    if (!exceptions.has(name)) assert.equal(observed[name], manifest.repositoryFiles[name], `Source drift ${name}`);
  }
  assert.equal(sha(read(join(root, 'package-lock.json'))), manifest.lockSha256);
  const changed = execFileSync('git', ['diff', '--name-only', manifest.baseRevision, '--'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const name of changed) assert.ok(exceptions.has(name), `Non-probe change from pinned main ${name}`);
  return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: observed,
    manifestSha256: sha(read(join(here, 'source-manifest.json'))), exceptions: [...exceptions] };
}
function ownedFile(path) {
  assert.equal(realpathSync(path), path, `Symlink or external file ${relative(root, path)}`);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1, `Not an exclusively owned workspace file ${path}`);
}
function packageIdentity() {
  const require = createRequire(join(root, 'package.json'));
  const packageEntry = realpathSync(require.resolve('@opentelemetry/otlp-exporter-base'));
  const trace = createRequire(require.resolve('@opentelemetry/exporter-trace-otlp-http'));
  assert.equal(realpathSync(trace.resolve('@opentelemetry/otlp-exporter-base')), packageEntry);
  const base = join(root, 'node_modules/@opentelemetry/otlp-exporter-base');
  assert.equal(packageEntry, join(base, 'build/src/index.js'));
  const direct = join(base, 'package.json');
  const matches = [];
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        assert.ok(!(entry.name === 'otlp-exporter-base' && directory.endsWith('/@opentelemetry')), `Nested base link ${path}`);
        assert.ok(realpathSync(path).startsWith(root + '/'), `External dependency link ${path}`);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name === 'otlp-exporter-base' && directory.endsWith('/@opentelemetry')) matches.push(realpathSync(path));
      scan(path);
    }
  }
  scan(join(root, 'node_modules'));
  assert.deepEqual(matches, [base], 'Exactly one installed base identity');
  const packageJson = JSON.parse(read(direct));
  assert.equal(packageJson.version, '0.208.0');
  const lock = JSON.parse(read(join(root, 'package-lock.json')));
  assert.deepEqual(Object.keys(lock.packages).filter(name => name.endsWith('node_modules/@opentelemetry/otlp-exporter-base')), ['node_modules/@opentelemetry/otlp-exporter-base']);
  const entry = lock.packages['node_modules/@opentelemetry/otlp-exporter-base'];
  assert.equal(entry.version, '0.208.0');
  assert.equal(entry.resolved, 'https://registry.npmjs.org/@opentelemetry/otlp-exporter-base/-/otlp-exporter-base-0.208.0.tgz');
  assert.match(entry.integrity, /^sha512-/);
  const metadata = {};
  for (const name of ['package.json', 'LICENSE', 'README.md']) {
    ownedFile(join(base, name));
    metadata[name] = sha(read(join(base, name)));
    if (manifest.metadata[name]) assert.equal(metadata[name], manifest.metadata[name], `Registry metadata ${name}`);
  }
  const workerRoot = dirname(require.resolve('@temporalio/worker/package.json'));
  for (const [name, expected] of Object.entries(manifest.temporalWorker.files)) {
    const path = join(workerRoot, name);
    ownedFile(path);
    assert.equal(sha(read(path)), expected.sha256, `Temporal shutdown source ${name}`);
  }
  const outputs = [];
  function outputFiles(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) outputFiles(join(directory, entry.name), name + '/');
      else { assert.ok(entry.isFile()); outputs.push(name); }
    }
  }
  outputFiles(join(base, 'build'), 'build/');
  assert.deepEqual(outputs.sort(), Object.keys(manifest.outputs).sort(), 'Published output inventory, no declaration maps or buildinfo');
  return { base, metadata, lockEntry: entry, temporalWorker: manifest.temporalWorker };
}
function outputSnapshot(base, variant) {
  const outputs = {};
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    const path = join(base, name);
    ownedFile(path);
    outputs[name] = sha(read(path));
    assert.equal(outputs[name], expected[variant], `${variant} output ${name}`);
  }
  assert.equal(Object.keys(outputs).length, 324);
  return outputs;
}
try {
  if (mode === '--before') write('source-before.json', sourceSnapshot());
  if (mode === '--stage') {
    const source = sourceSnapshot();
    const identity = packageIdentity();
    const original = outputSnapshot(identity.base, 'original');
    const bytes = read(join(here, 'clean-bytes.json'));
    assert.equal(sha(bytes), manifest.payloadSha256);
    assert.ok(bytes.length < 512 * 1024);
    const payload = JSON.parse(bytes);
    assert.equal(payload.format, 1);
    const changed = Object.keys(manifest.outputs).filter(name => manifest.outputs[name].original !== manifest.outputs[name].candidate).sort();
    assert.deepEqual(Object.keys(payload.files).sort(), changed);
    assert.equal(changed.length, manifest.changedCount);
    const replacements = changed.map(name => {
      assert.match(name, /^build\/(src|esm|esnext)\/[a-z0-9/.-]+$/);
      const data = Buffer.from(payload.files[name], 'base64');
      assert.equal(sha(data), manifest.outputs[name].candidate);
      assert.equal(data.length, manifest.outputs[name].bytes);
      return { name, data };
    });
    write('staging-preimages.json', { identity, source, outputs: original, payloadSha256: manifest.payloadSha256 });
    for (const { name, data } of replacements) {
      const fd = openSync(join(identity.base, name), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try { writeFileSync(fd, data); } finally { closeSync(fd); }
    }
    const candidate = outputSnapshot(identity.base, 'candidate');
    assert.deepEqual(packageIdentity().metadata, identity.metadata);
    write('staging-candidate.json', { identity, outputs: candidate, changed });
  }
  if (mode === '--verify') {
    const before = JSON.parse(read(join(artifacts, 'source-before.json')));
    const after = sourceSnapshot();
    assert.deepEqual(after.files, before.files, 'Complete source bytes unchanged');
    const staged = JSON.parse(read(join(artifacts, 'staging-candidate.json')));
    const identity = packageIdentity();
    assert.deepEqual(identity, staged.identity);
    write('source-after.json', after);
    write('outputs-after.json', outputSnapshot(identity.base, 'candidate'));
  }
} catch (error) {
  try { write('stager-first-failure.txt', { mode, error: String(error) }); } catch {}
  throw error;
}
