import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

assert.equal(process.platform, 'linux');
assert.equal(process.version, 'v24.22.3');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.OTLP_PROBE_ONLY, 'NEVER_MERGE');
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.match(process.env.GITHUB_REF_NAME ?? '', /^probe\/otlp-worker-/);
const workspace = realpathSync(process.env.GITHUB_WORKSPACE);
assert.equal(realpathSync(process.cwd()), workspace);
const variant = process.env.OTLP_INSTALL_VARIANT;
assert.ok(['enabled', 'disabled'].includes(variant));
const root = variant === 'enabled' ? workspace : join(realpathSync(process.env.RUNNER_TEMP), 'otlp-final-disabled');
const proofPath = 'tests/proof/otlp-worker-qualification';
const manifestPath = proofPath + '/source-manifest.json';
const artifacts = join(workspace, '.proof/artifacts/otlp-worker');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const read = path => readFileSync(path);
const json = path => JSON.parse(read(path));
const manifest = json(join(workspace, manifestPath));
assert.equal(manifest.format, 2);
assert.equal(manifest.status, 'ready-for-hosted-execution');
assert.equal(manifest.baseRevision, '60bc8f1f88661837e5e82f77b71779a463f63226');
assert.equal(manifest.archive.path, 'vendor/opentelemetry/opentelemetry-otlp-exporter-base-0.208.0-crew.1.tgz');
assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/);
assert.ok(Object.keys(manifest.repositoryFiles).length >= 754);
assert.equal(Object.keys(manifest.baseFiles).length, 754);
const mode = process.argv[2];
assert.ok(['--prepare', '--installed', '--verify', '--final'].includes(mode));
function write(name, value) {
  const content = JSON.stringify(value, null, 2) + '\n';
  assert.ok(Buffer.byteLength(content) <= 8 * 1024 * 1024, 'Evidence file size bound');
  writeFileSync(join(artifacts, name), content, { mode: 0o600, flag: 'wx' });
}
function safeRelative(name) {
  assert.ok(typeof name === 'string' && name.length > 0 && !name.includes('\0'));
  assert.equal(resolve(workspace, name), workspace + '/' + name, `Unsafe relative path ${name}`);
  assert.ok(!name.split('/').some(part => part === '.' || part === '..'));
  return name;
}
function ownedFile(path) {
  assert.equal(realpathSync(path), path, `Unexpected file link ${path}`);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1, `Expected exclusively owned file ${path}`);
  return stat;
}
function git(args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
}
function tree(revision) {
  const entries = git(['ls-tree', '-rz', '--full-tree', revision]).split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    assert.ok(match, `Unsupported tracked object ${row}`);
    return [safeRelative(match[3]), { mode: match[1], gitBlob: match[2] }];
  });
  return Object.fromEntries(entries);
}
const head = tree('HEAD');
assert.equal(git(['rev-parse', 'HEAD']).trim(), process.env.GITHUB_SHA, 'Actual checkout matches dispatched commit');
assert.deepEqual(tree(manifest.baseRevision), manifest.baseFiles, 'Exact pinned production base Git tree');
const expectedNames = [...Object.keys(manifest.repositoryFiles), manifestPath].sort();
assert.equal(new Set(expectedNames).size, expectedNames.length);
assert.deepEqual(Object.keys(head).sort(), expectedNames, 'Complete expected probe HEAD inventory');
const changes = [...new Set([...Object.keys(manifest.baseFiles), ...expectedNames])].filter(name =>
  head[name]?.gitBlob !== manifest.baseFiles[name]?.gitBlob || head[name]?.mode !== manifest.baseFiles[name]?.mode).sort();
assert.deepEqual(changes, manifest.allowedChanges.toSorted(), 'Exact allowed changes against pinned production base');
function sourceSnapshot(directory) {
  const files = {};
  for (const name of expectedNames) {
    const path = join(directory, name);
    const stat = ownedFile(path);
    const bytes = read(path);
    assert.equal(blob(bytes), head[name].gitBlob, `Actual Git blob ${name}`);
    assert.equal((stat.mode & 0o111) !== 0, head[name].mode === '100755', `Git executable mode ${name}`);
    files[name] = { sha256: sha(bytes), gitBlob: blob(bytes), mode: head[name].mode };
    if (name !== manifestPath) assert.deepEqual(files[name], manifest.repositoryFiles[name], `Pinned source ${name}`);
  }
  return { revision: git(['rev-parse', 'HEAD']).trim(), root: directory, files };
}
function archiveIdentity(directory) {
  const archivePath = join(directory, manifest.archive.path);
  ownedFile(archivePath);
  const bytes = read(archivePath);
  assert.equal(sha(bytes), manifest.archive.sha256, 'Selected local archive SHA-256');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(integrity, manifest.archive.integrity, 'Selected local archive SHA-512');
  const receipt = json(join(directory, proofPath, 'archive-receipt.json'));
  assert.equal(receipt.archiveSHA256, manifest.archive.sha256);
  assert.equal(receipt.archiveBytes, bytes.length);
  assert.equal(receipt.files.length, 327);
  assert.equal(receipt.files.filter(item => item.path.startsWith('build/')).length, 324);
  assert.equal(receipt.changedFiles, 45);
  assert.equal(receipt.files.filter(item => item.changed).length, receipt.changedFiles);
  const metadata = receipt.files.filter(item => ['package.json', 'LICENSE', 'README.md'].includes(item.path));
  assert.equal(metadata.length, 3);
  for (const item of metadata) {
    assert.equal(item.changed, false);
    assert.equal(item.finalSHA256, item.originalSHA256);
  }
  const pkg = json(join(directory, 'package.json'));
  const name = '@opentelemetry/otlp-exporter-base';
  const fileSpecifier = 'file:' + manifest.archive.path;
  assert.equal(pkg.dependencies[name], fileSpecifier);
  assert.equal(pkg.overrides[name], '$' + name);
  const lock = json(join(directory, 'package-lock.json'));
  assert.equal(lock.packages[''].dependencies[name], fileSpecifier);
  const keys = Object.keys(lock.packages).filter(key => key.endsWith('node_modules/' + name));
  assert.deepEqual(keys, ['node_modules/' + name], 'One base package in authentic candidate lock');
  const entry = lock.packages[keys[0]];
  assert.equal(entry.version, '0.208.0');
  assert.equal(entry.resolved, fileSpecifier);
  assert.equal(entry.integrity, integrity, 'Lock integrity matches actual selected archive');
  assert.equal(entry.link, undefined);
  return { archive: { path: manifest.archive.path, bytes: bytes.length, sha256: sha(bytes), integrity }, receipt, lockEntry: entry };
}
function installedSnapshot() {
  const identity = archiveIdentity(root);
  const require = createRequire(join(root, 'package.json'));
  const base = join(root, 'node_modules/@opentelemetry/otlp-exporter-base');
  const direct = realpathSync(require.resolve('@opentelemetry/otlp-exporter-base'));
  const trace = createRequire(require.resolve('@opentelemetry/exporter-trace-otlp-http'));
  assert.equal(direct, join(base, 'build/src/index.js'));
  assert.equal(realpathSync(trace.resolve('@opentelemetry/otlp-exporter-base')), direct, 'Trace exporter selects the same physical base');
  const matches = [];
  let examined = 0;
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++examined <= 250_000, 'Dependency inventory bound');
      const path = join(directory, entry.name);
      if (entry.name === 'otlp-exporter-base' && directory.endsWith('/@opentelemetry')) {
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), `Expected physical base ${path}`);
        matches.push(realpathSync(path));
      }
      if (entry.isSymbolicLink()) {
        assert.ok(realpathSync(path).startsWith(root + '/'), `External dependency link ${path}`);
      } else if (entry.isDirectory()) scan(path);
    }
  }
  scan(join(root, 'node_modules'));
  assert.deepEqual(matches.sort(), [base], 'No nested or alternate base installation');
  const files = {};
  function inventory(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Installed package link ${name}`);
      if (entry.isDirectory()) inventory(path, name + '/');
      else { ownedFile(path); files[name] = sha(read(path)); }
    }
  }
  inventory(base);
  const expected = Object.fromEntries(identity.receipt.files.map(item => [safeRelative(item.path), item.finalSHA256]));
  assert.equal(Object.keys(expected).length, 327);
  assert.deepEqual(files, expected, 'All 327 installed files equal the selected final archive receipt');
  const pkg = json(join(base, 'package.json'));
  assert.equal(pkg.name, '@opentelemetry/otlp-exporter-base');
  assert.equal(pkg.version, '0.208.0');
  const temporalRoot = dirname(require.resolve('@temporalio/worker/package.json'));
  const temporal = {};
  for (const [name, expected] of Object.entries(manifest.temporalWorker.files)) {
    const path = join(temporalRoot, safeRelative(name));
    ownedFile(path);
    temporal[name] = sha(read(path));
    assert.equal(temporal[name], expected.sha256, `Actual Temporal shutdown source ${name}`);
  }
  return { root, direct, traceBase: realpathSync(trace.resolve('@opentelemetry/otlp-exporter-base')), archive: identity.archive,
    lockEntry: identity.lockEntry, packageMetadata: pkg, files, temporal };
}
function completeCommand(name) {
  const result = json(join(artifacts, name + '.result.json'));
  assert.deepEqual(result.outcome, { kind: 'exited', code: 0 }, `Successful captured ${name}`);
  assert.equal(result.received, result.retained, `Complete captured ${name}`);
  assert.equal(result.truncated, false);
  assert.equal(result.deadlineExceeded, false);
  assert.equal(result.interrupted, undefined);
  assert.deepEqual(result.failures, []);
  return result;
}
try {
  if (mode === '--prepare') {
    assert.ok(!existsSync(join(workspace, 'node_modules')), 'Fresh enabled checkout has no dependency installation');
    write('workspace-source-before.json', sourceSnapshot(workspace));
    const identity = archiveIdentity(workspace);
    if (variant === 'disabled') {
      assert.ok(!existsSync(root), 'Disabled installation must begin in a new physical repository copy');
      mkdirSync(root, { mode: 0o700 });
      for (const name of expectedNames) {
        const destination = join(root, name);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(join(workspace, name), destination);
        chmodSync(destination, head[name].mode === '100755' ? 0o755 : 0o644);
        const copied = lstatSync(destination), original = lstatSync(join(workspace, name));
        assert.ok(copied.dev !== original.dev || copied.ino !== original.ino, 'Copy must not share source inodes');
      }
    }
    assert.ok(!existsSync(join(root, 'node_modules')), 'Active clean install has no dependency installation');
    write('source-before.json', sourceSnapshot(root));
    write('archive-before.json', { archive: identity.archive, lockEntry: identity.lockEntry });
    const npmIgnoreScripts = execFileSync('npm', ['config', 'get', 'ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim();
    assert.equal(npmIgnoreScripts, 'false', 'Default npm configuration enables install scripts before the explicit disabled CLI flag');
    write('runtime.json', { variant, platform: process.platform, arch: process.arch, node: process.version,
      nodeBinary: realpathSync(process.execPath), nodeBinarySha256: sha(read(realpathSync(process.execPath))),
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(),
      npmIgnoreScripts,
      runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, root, workspace });
    assert.ok(!root.includes('\n') && !root.includes('\r'));
    appendFileSync(process.env.GITHUB_ENV, 'OTLP_INSTALL_ROOT=' + root + '\n');
  }
  if (mode === '--installed') {
    completeCommand('install.log');
    assert.deepEqual(sourceSnapshot(root).files, json(join(artifacts, 'source-before.json')).files);
    write('installed-before.json', installedSnapshot());
  }
  if (mode === '--verify') {
    const current = sourceSnapshot(root);
    const originalWorkspace = sourceSnapshot(workspace);
    write('source-after.json', current);
    write('workspace-source-after.json', originalWorkspace);
    assert.deepEqual(current.files, json(join(artifacts, 'source-before.json')).files, 'Active source and lock unchanged');
    assert.deepEqual(originalWorkspace.files, json(join(artifacts, 'workspace-source-before.json')).files, 'Checkout source and lock unchanged');
    const installed = installedSnapshot();
    write('installed-after.json', installed);
    assert.deepEqual(installed, json(join(artifacts, 'installed-before.json')), 'Installed package unchanged by telemetry or worker qualification');
  }
  if (mode === '--final') {
    const runtime = json(join(artifacts, 'runtime.json'));
    assert.equal(sha(read(realpathSync(process.execPath))), runtime.nodeBinarySha256, 'Node binary unchanged');
    const telemetry = completeCommand('telemetry.tap');
    completeCommand('exporter-regressions.tap');
    const tap = read(join(artifacts, 'telemetry.tap')).toString('utf8');
    for (const line of ['1..13', '# tests 13', '# pass 13', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0']) {
      assert.ok(tap.split(/\r?\n/).includes(line), `Unchanged telemetry TAP ${line}`);
    }
    assert.deepEqual(json(join(artifacts, 'source-after.json')).files, json(join(artifacts, 'source-before.json')).files);
    assert.deepEqual(json(join(artifacts, 'installed-after.json')), json(join(artifacts, 'installed-before.json')));
    if (variant === 'enabled') {
      completeCommand('setup.log');
      completeCommand('command.log');
      assert.equal(json(join(artifacts, 'probe-outcome.json')).status, 'passed');
      assert.equal(json(join(artifacts, 'qualification.json')).status, 'passed');
      const workerLog = json(join(artifacts, 'worker-log-metadata.json'));
      assert.equal(workerLog.received, workerLog.retained, 'Complete captured actual worker log');
      assert.equal(workerLog.truncated, false);
    }
    assert.deepEqual(json(join(artifacts, 'collector.json')).failures, []);
    write('final-install-qualification.json', { status: 'passed', variant, telemetryTests: 13, telemetryCapture: telemetry,
      all327FilesMatchSelectedArchive: true, onePhysicalBase: true, sourceAndLockUnchanged: true,
      actualWorker: variant === 'enabled' ? 'See unchanged probe qualification and complete worker logs' : 'Not run in scripts-disabled copy',
      provisionalUntilArtifactUploadAndWholeJobPass: true,
      unresolvedFollowup: 'crew-xubc retains native admission and late pool shutdown warnings; no general warning-free claim' });
  }
} catch (error) {
  try { write('inspector-' + mode.slice(2) + '-failure.json', { mode, error: String(error), stack: error instanceof Error ? error.stack : undefined }); } catch {}
  throw error;
}
