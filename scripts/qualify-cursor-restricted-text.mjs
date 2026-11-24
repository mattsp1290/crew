import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'tests/fixtures/cursor-candidate');
const execute = promisify(execFile);
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
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' },
    candidate: { type: 'string' }, 'node-image': { type: 'string' }, out: { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return 0; }
  const candidate = values.candidate;
  const image = values['node-image'];
  const out = values.out;
  if (!candidate || !image || !out || !isAbsolute(candidate) || !isAbsolute(out)
    || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('invalid_arguments');
  // Evidence must not become repository drift or collide with a prior invocation.
  const actualOut = join(await realpath(dirname(out)), basename(out));
  const fromRoot = relative(await realpath(root), actualOut);
  if (fromRoot === '' || (!fromRoot.startsWith(`..` + '/') && fromRoot !== '..' && !isAbsolute(fromRoot))) {
    throw new Error('evidence_must_be_outside_repository');
  }
  const identity = JSON.parse(await readFile(join(fixture, 'candidate.json'), 'utf8'));
  const bytes = await readFile(candidate);
  if (createHash('sha256').update(bytes).digest('hex') !== identity.sha256) throw new Error('candidate_hash_mismatch');
  await mkdir(out, { mode: 0o700 });
  const context = await mkdtemp(join(tmpdir(), 'crew-cursor-candidate-'));
  const tag = `crew-cursor-candidate:${createHash('sha256').update(context).digest('hex').slice(0, 16)}`;
  const container = tag.replace(':', '-');
  try {
    const sources = {
      'package.json': join(fixture, 'package.json'),
      'package-lock.json': join(fixture, 'package-lock.json'),
      'Dockerfile': join(root, 'packaging/cursor-candidate.Dockerfile'),
      'candidate.mjs': join(root, 'tests/proof/cursor-candidate.mjs'),
    };
    const hashes = {};
    for (const [name, path] of Object.entries(sources)) {
      await copyFile(path, join(context, name));
      hashes[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
    await writeFile(join(context, 'candidate.tgz'), bytes, { mode: 0o600 });
    await copyFile(join(fixture, 'package-lock.json'), join(out, 'package-lock.json'));
    await writeFile(join(out, 'intent.json'), JSON.stringify({ identity, image, sourceHashes: hashes }, null, 2));
    async function docker(phase, args, timeout) {
      try {
        const result = await execute('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024 });
        await writeFile(join(out, `${phase}.stdout`), result.stdout);
        await writeFile(join(out, `${phase}.stderr`), result.stderr);
        return result.stdout;
      } catch (error) {
        await writeFile(join(out, `${phase}.stdout`), error.stdout ?? '');
        await writeFile(join(out, `${phase}.stderr`), error.stderr ?? '');
        throw new Error(`${phase}_failed`);
      }
    }
    await docker('build', ['build', '--build-arg', `NODE_IMAGE=${image}`, '-t', tag, context], 300_000);
    const inspection = JSON.parse(await docker('image', ['image', 'inspect', tag], 30_000))[0];
    const runArgs = [
      'run', '--name', container, '--rm', '--init', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '10001:10001', '--pids-limit', '128', '--memory', '1g',
      '--tmpfs', '/state:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001',
      '--env', 'HOME=/state/home', '--env', 'TMPDIR=/state/tmp', '--env', 'CURSOR_DATA_DIR=/state/home',
      '--env', 'LANG=C.UTF-8', '--env', 'TZ=UTC', inspection.Id,
      '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
      'HOME=/state/home', 'TMPDIR=/state/tmp', 'CURSOR_DATA_DIR=/state/home',
      'LANG=C.UTF-8', 'TZ=UTC', 'node', 'candidate.mjs',
    ];
    const audit = JSON.parse(await docker('audit', runArgs, 60_000));
    await writeFile(join(out, 'evidence.json'), JSON.stringify({
      ...audit, candidate: identity,
      image: { id: inspection.Id, os: inspection.Os, architecture: inspection.Architecture, base: image },
      sourceHashes: hashes, containerArgs: runArgs,
    }, null, 2));
    process.stdout.write(`Offline candidate checks passed; live qualification remains blocked. Evidence: ${out}\n`);
    return 2;
  } finally {
    await rm(context, { recursive: true, force: true });
    await execute('docker', ['rm', '-f', container], { timeout: 30_000 }).catch(() => undefined);
    await execute('docker', ['image', 'rm', tag], { timeout: 30_000 }).catch(() => undefined);
  }
}

try { process.exitCode = await main(); }
catch (error) {
  // Never print subprocess errors, environment values, or candidate source text.
  const known = new Set(['invalid_arguments', 'evidence_must_be_outside_repository', 'candidate_hash_mismatch', 'build_failed', 'image_failed', 'audit_failed']);
  const code = known.has(error.message) ? error.message : 'candidate_audit_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
