import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.versions.node, '24.22.3', 'Build the upstream source with Node 24.22.3');
const source = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass the Switchboard checkout path');
const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Switchboard source must be clean');
const revision = run('git', ['rev-parse', 'HEAD']);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'vendor/switchboard');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]).sort();
run('npm', ['run', 'build']);
assert.equal(run('git', ['rev-parse', 'HEAD']), revision, 'Source revision changed during build');
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Build changed tracked source');
const temporary = mkdtempSync(join(tmpdir(), 'crew-observability-'));
try {
  cpSync(join(source, 'dist/observability'), join(temporary, 'dist/observability'), { recursive: true });
  mkdirSync(join(temporary, 'dist/core'));
  cpSync(join(source, 'dist/core/contracts.d.ts'), join(temporary, 'dist/core/contracts.d.ts'));
  cpSync(join(source, 'LICENSE'), join(temporary, 'LICENSE'));
  const built = files(join(temporary, 'dist'));
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
  for (const path of built.filter((path) => path.endsWith('.js'))) {
    for (const match of readFileSync(path, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(path), specifier);
        assert.ok(target.startsWith(join(temporary, 'dist/observability/')) && existsSync(target), `Unpackaged runtime import ${specifier}`);
      } else {
        assert.ok(specifier === '@opentelemetry/api' || specifier.startsWith('node:') && builtins.has(specifier.slice(5)),
          `Undeclared runtime import ${specifier}`);
      }
    }
    assert.ok(!/\brequire\s*\(|\beval\s*\(|\bimport\s*\(\s*[^'"]/.test(readFileSync(path, 'utf8')), 'Uninspectable runtime dependency');
  }
  const sourcePaths = [...files(join(source, 'src/observability')), join(source, 'src/core/contracts.ts'),
    join(source, 'scripts/support/datadog-exporter.mjs'), join(source, 'package.json'), join(source, 'package-lock.json'),
    join(source, 'tsconfig.json'), join(source, 'LICENSE')].sort();
  writeFileSync(join(temporary, 'provenance.json'), JSON.stringify({
    upstream: 'https://github.com/operatorworks/switchboard', revision, node: process.version,
    sourceSha256: Object.fromEntries(sourcePaths.map((path) => [relative(source, path), hash(path)])),
    extractedSha256: Object.fromEntries(built.map((path) => [relative(temporary, path), hash(path)])),
  }, null, 2) + '\n');
  writeFileSync(join(temporary, 'README.md'), `# Crew Switchboard observability extraction\n\nByte-identical upstream dist/observability from Switchboard ${revision}.\nOnly the observability entry and its type-only core contract are packaged.\nThe original instrumentation scope is retained. Crew qualifies this entry on Node 22.23.3.\nRebuild from a clean upstream checkout with Node 24 using scripts/vendor-switchboard-observability.mjs <source-path>.\nSee provenance.json for source and extracted SHA-256 hashes. MIT licensed.\n`);
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({
    name: '@birbcrew/switchboard-observability', version: `0.0.0-${revision.slice(0, 7)}`, type: 'module', license: 'MIT',
    exports: { '.': { types: './dist/observability/index.d.ts', import: './dist/observability/index.js' } },
    files: ['dist', 'LICENSE', 'README.md', 'provenance.json'], engines: { node: '>=22.23.3' },
    peerDependencies: { '@opentelemetry/api': '1.9.0' },
  }, null, 2) + '\n');
  mkdirSync(destination, { recursive: true });
  const [packed] = JSON.parse(run('npm', ['pack', '--json'], temporary));
  const archive = join(destination, packed.filename);
  const packedArchive = join(temporary, packed.filename);
  if (existsSync(archive)) assert.equal(hash(archive), hash(packedArchive), 'An immutable archive already exists with different bytes');
  else cpSync(packedArchive, archive);
  console.log(JSON.stringify({ archive: relative(root, join(destination, packed.filename)), integrity: packed.integrity, revision }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
