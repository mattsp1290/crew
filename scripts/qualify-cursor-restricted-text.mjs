import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'tests/fixtures/cursor-candidate');
const execute = promisify(execFile);
class AuditError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const help = `Usage: node scripts/qualify-cursor-restricted-text.mjs
  --candidate /absolute/candidate.tgz
  --node-image node:24.22.3-bookworm@sha256:<digest>
  --out /absolute/new-evidence-directory

Audit the exact Switchboard 55e04a1 candidate without changing Crew's pin.
Docker is required. No credentials are accepted or forwarded to the container.
Exit 0: help; 1: failed check; 2: offline checks passed, live gates pending.
This command cannot qualify a supported deployment or run paid inference.
`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: {
      help: { type: 'boolean', short: 'h' },
      candidate: { type: 'string' }, 'node-image': { type: 'string' }, out: { type: 'string' },
    } });
  } catch { throw new AuditError('invalid_arguments'); }
  const { values } = parsed;
  if (values.help) { process.stdout.write(help); return 0; }
  const candidate = values.candidate;
  const image = values['node-image'];
  const out = values.out;
  if (!candidate || !image || !out || !isAbsolute(candidate) || !isAbsolute(out)
    || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new AuditError('invalid_arguments');
  // Evidence must not become repository drift or collide with a prior invocation.
  const actualOut = join(await realpath(dirname(out)), basename(out));
  const fromRoot = relative(await realpath(root), actualOut);
  if (fromRoot === '' || (!fromRoot.startsWith(`..` + '/') && fromRoot !== '..' && !isAbsolute(fromRoot))) {
    throw new AuditError('evidence_must_be_outside_repository');
  }
  const identity = JSON.parse(await readFile(join(fixture, 'candidate.json'), 'utf8'));
  const bytes = await readFile(candidate);
  if (createHash('sha256').update(bytes).digest('hex') !== identity.sha256) throw new AuditError('candidate_hash_mismatch');
  await mkdir(out, { mode: 0o700 });
  const context = await mkdtemp(join(tmpdir(), 'crew-cursor-candidate-'));
  const tag = `crew-cursor-candidate:${createHash('sha256').update(context).digest('hex').slice(0, 16)}`;
  const container = tag.replace(':', '-');
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'];
  let failure;
  let created = false;
  let built = false;
  try {
    const sources = {
      'package.json': join(fixture, 'package.json'),
      'package-lock.json': join(fixture, 'package-lock.json'),
      'Dockerfile': join(root, 'packaging/cursor-candidate.Dockerfile'),
      'candidate.mjs': join(root, 'tests/proof/cursor-candidate.mjs'),
      'contract.json': join(fixture, 'contract.json'),
    };
    const hashes = {};
    for (const [name, path] of Object.entries(sources)) {
      await copyFile(path, join(context, name));
      hashes[name] = createHash('sha256').update(await readFile(join(context, name))).digest('hex');
    }
    await writeFile(join(context, 'candidate.tgz'), bytes, { mode: 0o600 });
    await copyFile(join(context, 'package-lock.json'), join(out, 'package-lock.json'));
    await writeFile(join(out, 'intent.json'), JSON.stringify({ identity, image, sourceHashes: hashes }, null, 2));
    const contract = JSON.parse(await readFile(join(context, 'contract.json'), 'utf8'));
    const environment = contract.environment;
    async function docker(phase, args, timeout, saveStdout = true) {
      try {
        if (abort.signal.aborted) throw new AuditError('interrupted');
        const result = await execute('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024, signal: abort.signal });
        if (saveStdout) await writeFile(join(out, `${phase}.stdout`), result.stdout);
        await writeFile(join(out, `${phase}.stderr`), result.stderr);
        return result.stdout;
      } catch (error) {
        if (saveStdout) await writeFile(join(out, `${phase}.stdout`), error.stdout ?? '');
        await writeFile(join(out, `${phase}.stderr`), error.stderr ?? '');
        throw new AuditError(abort.signal.aborted ? 'interrupted' : `${phase}_failed`);
      }
    }
    // Explicit empty values override Docker client proxy defaults, including credentials.
    await docker('build', ['build', '--build-arg', `NODE_IMAGE=${image}`,
      ...proxyNames.flatMap((name) => ['--build-arg', `${name}=`]), '-t', tag, context], 300_000);
    built = true;
    const inspection = JSON.parse(await docker('image', ['image', 'inspect', '--format',
      '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}}}', tag], 30_000));
    const runArgs = [
      'create', '--name', container, '--init', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '10001:10001', '--pids-limit', '128', '--memory', '1g',
      '--tmpfs', '/state:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001',
      ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      ...proxyNames.flatMap((name) => ['--env', `${name}=`]),
      '--entrypoint', '/usr/bin/env', inspection.Id,
      '-i', ...Object.entries(environment).map(([name, value]) => `${name}=${value}`), 'node', 'candidate.mjs',
    ];
    await docker('create', runArgs, 30_000);
    created = true;
    // Inspect before startup. Never save potentially credential-bearing Config.Env.
    const rawEnvironment = await docker('environment', ['inspect', '--format', '{{json .Config.Env}}', container], 30_000, false);
    let environmentKeys;
    try {
      const configured = JSON.parse(rawEnvironment);
      assert.ok(Array.isArray(configured));
      const expected = { ...environment, ...Object.fromEntries(proxyNames.map((name) => [name, ''])), NODE_VERSION: '24.22.3' };
      for (const entry of configured) {
        assert.equal(typeof entry, 'string');
        const split = entry.indexOf('=');
        const key = entry.slice(0, split);
        const value = entry.slice(split + 1);
        if (key === 'YARN_VERSION') assert.match(value, /^\d+\.\d+\.\d+$/);
        else assert.ok(Object.hasOwn(expected, key) && expected[key] === value);
      }
      environmentKeys = configured.map((entry) => entry.split('=')[0]);
    } catch { throw new AuditError('environment_mismatch'); }
    await writeFile(join(out, 'environment-keys.json'), JSON.stringify(environmentKeys));
    const rawAudit = await docker('audit', ['start', '--attach', container], 60_000);
    let audit;
    try {
      audit = JSON.parse(rawAudit);
      for (const [key, value] of Object.entries(contract)) assert.deepEqual(audit[key], value);
    } catch { throw new AuditError('contract_mismatch'); }
    await writeFile(join(out, 'evidence.json'), JSON.stringify({
      ...audit, candidate: identity,
      image: { id: inspection.Id, os: inspection.Os, architecture: inspection.Architecture, base: image },
      sourceHashes: hashes, containerArgs: runArgs,
    }, null, 2));
  } catch (error) {
    failure = error;
  } finally {
    // A timed-out or interrupted Docker CLI may have already created resources.
    const cleanupErrors = [];
    // Keep container removal before image removal, and attempt every step.
    for (const step of [
      { name: 'context', allowMissing: false, run: () => rm(context, { recursive: true, force: true }) },
      { name: 'container', allowMissing: !created, run: () => execute('docker', ['rm', '-f', container], { timeout: 30_000 }) },
      { name: 'image', allowMissing: !built, run: () => execute('docker', ['image', 'rm', tag], { timeout: 30_000 }) },
    ]) {
      try { await step.run(); }
      catch (error) {
        if (step.allowMissing && /No such (container|image)/i.test(error.stderr ?? '')) continue;
        cleanupErrors.push(step.name);
      }
    }
    await writeFile(join(out, 'cleanup.json'), JSON.stringify({ complete: cleanupErrors.length === 0, failedOperations: cleanupErrors }));
    if (cleanupErrors.length && !failure) failure = new AuditError('cleanup_failed');
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (failure) throw failure;
  if (abort.signal.aborted) throw new AuditError('interrupted');
  process.stdout.write(`Offline candidate checks passed; live qualification remains blocked. Evidence: ${out}\n`);
  return 2;
}

try { process.exitCode = await main(); }
catch (error) {
  // Never print subprocess errors, environment values, or candidate source text.
  const code = error instanceof AuditError ? error.code : 'candidate_audit_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
