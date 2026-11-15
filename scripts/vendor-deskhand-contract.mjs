import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const commit = 'b8f17ae931f0eaab3d6237720de5ae4f60d8c957';
export const tag = 'contract-v0.11-draft';
export const contractSha256 = '8f4f3c1c325a780fb4b5c019331bd3a7e5ad56c24cff7ea6829e24c9d91f0c91';
export const root = fileURLToPath(new URL('../vendor/deskhand/', import.meta.url));
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert(entry.isFile() || entry.isDirectory(), `Unexpected file kind: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [checkout, mode] = process.argv.slice(2);
  assert(checkout && (mode === undefined || mode === '--check'), 'Usage: node scripts/vendor-deskhand-contract.mjs <local-upstream-checkout> [--check]');
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(git('rev-parse', `${commit}^{commit}`).toString().trim(), commit);
  const extra = ['LICENSE', 'README.md', 'docs/contract.md', 'scripts/check-contract.py', 'scripts/requirements-contract.txt'];
  const paths = git('ls-tree', '-r', '--name-only', commit).toString().trim().split('\n')
    .filter((path) => path.startsWith('docs/schemas/') || extra.includes(path)).sort();
  for (const path of extra) assert(paths.includes(path), `Missing upstream source ${path}`);
  const sources = paths.map((path) => {
    const bytes = git('show', `${commit}:${path}`);
    const destination = join(root, tag, path);
    if (mode === '--check') assert.deepEqual(readFileSync(destination), bytes, path);
    else {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    return { path, bytes: bytes.length, sha256: digest(bytes), gitBlob: git('rev-parse', `${commit}:${path}`).toString().trim() };
  });
  assert.equal(sources.find((source) => source.path === 'docs/contract.md').sha256, contractSha256);
  assert.deepEqual(files(join(root, tag)).map((path) => relative(join(root, tag), path)).sort(), paths);
  const manifest = `${JSON.stringify({ repository: 'https://github.com/mattsp1290/deskhand', tag, commit, contractSha256, sourcesSha256: digest(JSON.stringify(sources)), sources }, null, 2)}\n`;
  if (mode === '--check') assert.equal(readFileSync(join(root, 'pin.json'), 'utf8'), manifest);
  else writeFileSync(join(root, 'pin.json'), manifest);
  console.log(`Deskhand ${mode === '--check' ? 'verified' : 'vendored'} ${sources.length} exact source files at ${commit}`);
}
