import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('the real import fence resolves every supported literal edge and preserves trusted computed loaders', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-imports-'));
  const write = (path: string, contents: string) => { const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents); };
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/check-deskhand-boundary-imports.mjs'), '--root', temporary], { encoding: 'utf8' });
  try {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@private/*': ['src/service/deskhand/*'] } }, include: ['src/**/*.ts', 'tests/**/*.ts'] }));
    write('src/service/deskhand/contract.ts', 'export const hidden = 1; export type Hidden = string;');
    write('src/service/deskhand/vocabulary.generated.ts', 'export const value = 1;');
    write('src/service/deskhand/new-leaf.ts', "import { value } from './vocabulary.generated.js'; export const hidden = value;");
    write('src/service/ordinary.ts', 'export const ordinary = 1;');
    write('tests/service/deskhand-results/support.ts', "import { hidden } from '../../../src/service/deskhand/contract.ts'; export const oracle = hidden;");
    for (const name of ['corpus', 'metadata', 'effects']) {
      write(`tests/service/deskhand-results/${name}.test.ts`, "import { hidden } from '../../../src/service/deskhand/contract.ts'; import { oracle } from './support.ts'; void hidden; void oracle;");
    }
    write('tests/service/deskhand-results/tooling.test.ts', '');
    write('tests/service/deskhand-results.types.ts', "import type { Hidden } from '../../src/service/deskhand/contract.ts';");
    write('src/service/consumer.ts', "import { ordinary } from './ordinary.js'; void ordinary; import(configPath); import(pathToFileURL(resolve(configPath)).href);");
    assert.equal(run().status, 0);
    const forbidden = [
      "import { hidden } from './deskhand/contract.ts';", "import * as hidden from './deskhand/contract.ts';", "import './deskhand/contract.ts';",
      "import type { Hidden } from './deskhand/contract.ts';", "type Hidden = typeof import('./deskhand/contract.ts');",
      "export type { Hidden } from './deskhand/contract.ts';", "export { hidden } from './deskhand/contract.ts';", "export * from './deskhand/contract.ts';",
      "import('./deskhand/contract.ts');", "require('./deskhand/contract.ts');", "import hidden = require('./deskhand/contract.ts');",
      "import { hidden } from '@private/contract';", "import { hidden } from './deskhand/contract.js';",
      "import { hidden } from './deskhand/../deskhand/new-leaf.ts';",
    ];
    for (const source of forbidden) {
      write('src/service/consumer.ts', source);
      const result = run();
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, /private-edge/, source);
    }
    write('src/service/consumer.ts', "import { hidden } from './barrel.js';");
    write('src/service/barrel.ts', "export { hidden } from './deskhand/contract.ts';");
    assert.match(run().stderr, /private-edge/);
    write('src/service/barrel.ts', 'export const hidden = 1;');
    for (const entry of ['deskhand-results/corpus.test.ts', 'deskhand-results/metadata.test.ts', 'deskhand-results/effects.test.ts', 'deskhand-results/tooling.test.ts', 'deskhand-results.types.ts']) {
      const path = `tests/service/${entry}`;
      const specifier = relative(dirname(path), 'src/service/deskhand/contract.ts');
      for (const source of [`export * from '${specifier}';`, `import { hidden } from '${specifier}'; export { hidden };`]) {
        write(path, source);
        assert.match(run().stderr, /private-test-export/);
      }
      write(path, '');
    }
    write('tests/service/deskhand-results/corpus.test.ts', '');
    for (const name of ['cli.ts', 'recovery-cli.ts', 'supervisor-runner.ts']) {
      const source = readFileSync(join(root, 'src/service', name), 'utf8');
      assert.match(source, /import\(pathToFileURL\(/);
      write(`src/service/${name}`, source);
    }
    assert.equal(run().status, 0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('the shared oracle grants only exact behavior-suite edges and closes every outside escape', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-support-imports-'));
  const support = 'tests/service/deskhand-results/support.ts';
  const write = (path: string, contents: string) => {
    const target = join(temporary, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/check-deskhand-boundary-imports.mjs'), '--root', temporary], { encoding: 'utf8' });
  try {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@oracle': [support] } } }));
    write('src/service/deskhand/contract.ts', 'export const hidden = 1;');
    write(support, "import { hidden } from '../../../src/service/deskhand/contract.ts'; export const oracle = hidden; export type Oracle = string;");
    for (const name of ['corpus', 'metadata', 'effects']) {
      write(`tests/service/deskhand-results/${name}.test.ts`, "import { oracle } from './support.ts'; void oracle;");
    }
    assert.equal(run().status, 0);
    for (const importer of [
      'src/service/consumer.ts', 'clients/example/consumer.ts', 'packages/example/consumer.ts',
      'scripts/consumer.ts', 'tests/service/unrelated.test.ts', 'tests/service/deskhand-results/unlisted.test.ts',
      'tests/service/deskhand-results/tooling.test.ts', 'tests/service/deskhand-results.types.ts',
      'src/service/deskhand/consumer.ts',
    ]) {
      const specifier = relative(dirname(importer), support);
      const path = specifier.startsWith('.') ? specifier : `./${specifier}`;
      for (const source of [`import { oracle } from '${path}';`, `export { oracle } from '${path}';`]) {
        write(importer, source);
        const result = run();
        assert.equal(result.status, 1, importer);
        assert.match(result.stderr, /private-support-edge/, importer);
      }
      write(importer, '');
    }
    const specifier = '../../tests/service/deskhand-results/support.ts';
    for (const source of [
      `import * as oracle from '${specifier}';`, `import '${specifier}';`,
      `import type { Oracle } from '${specifier}';`, `type Oracle = typeof import('${specifier}');`,
      `export type { Oracle } from '${specifier}';`, `export * from '${specifier}';`,
      `import('${specifier}');`, `import('${specifier}', {});`, `require('${specifier}');`,
      `import oracle = require('${specifier}');`, "import { oracle } from '@oracle';",
      "import { oracle } from '../../tests/service/deskhand-results/support.js';",
      "import { oracle } from '../../tests/service/deskhand-results/../deskhand-results/support.ts';",
    ]) {
      write('src/service/consumer.ts', source);
      const result = run();
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, /private-support-edge/, source);
    }
    write('src/service/consumer.ts', "import { oracle } from './barrel.js';");
    write('src/service/barrel.ts', `export { oracle } from '${specifier}';`);
    assert.match(run().stderr, /private-support-edge/);
    write('src/service/barrel.ts', 'export const oracle = 1;');
    symlinkSync(join(temporary, support), join(temporary, 'src/service/oracle-link.ts'));
    write('src/service/consumer.ts', "import { oracle } from './oracle-link.ts';");
    assert.match(run().stderr, /private-support-edge/);
    write('src/service/consumer.ts', '');
    for (const entry of ['deskhand-results/corpus.test.ts', 'deskhand-results/metadata.test.ts', 'deskhand-results/effects.test.ts', 'deskhand-results/tooling.test.ts', 'deskhand-results.types.ts']) {
      for (const source of [`import '../../tests/service/${entry}';`, `export * from '../../tests/service/${entry}';`]) {
        write('src/service/consumer.ts', source);
        assert.match(run().stderr, /private-test-edge/);
      }
    }
    write('src/service/consumer.ts', '');
    write('tests/service/deskhand-results/tooling.test.ts', "import '../../../src/service/deskhand/contract.ts';");
    assert.match(run().stderr, /private-edge/);
    write('tests/service/deskhand-results/tooling.test.ts', '');
    assert.equal(run().status, 0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

for (const { name, source, reason } of [
  { name: 'private owner', source: "import('./deskhand/contract.ts', {});", reason: 'private-edge' },
  { name: 'exact private test', source: "import('../../tests/service/deskhand-results/corpus.test.ts', {});", reason: 'private-test-edge' },
  { name: 'computed configuration', source: "const configPath = './deskhand/contract.ts'; import(configPath, {});", reason: null },
]) {
  test(`the real import fence inspects two-argument dynamic imports of ${name}`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'deskhand-import-options-'));
    const write = (path: string, contents: string) => { const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents); };
    try {
      write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }));
      write('src/service/deskhand/contract.ts', 'export const hidden = 1;');
      write('tests/service/deskhand-results/corpus.test.ts', '');
      write('src/service/consumer.ts', source);
      const result = spawnSync(process.execPath, [join(root, 'scripts/check-deskhand-boundary-imports.mjs'), '--root', temporary], { encoding: 'utf8' });
      assert.equal(result.status, reason === null ? 0 : 1, result.stdout + result.stderr);
      if (reason !== null) {
        const reported: unknown = JSON.parse(result.stderr);
        assert(reported !== null && typeof reported === 'object' && 'violations' in reported);
        assert.deepEqual(reported.violations, [{ file: 'src/service/consumer.ts', reason }]);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}

test('separately compiled negative callers reject each forbidden type use', () => {
  const filename = join(root, 'tests/service/deskhand-results.types.ts');
  const prelude = `import type { FramePoint, GlobalPoint, OperationId, FrameId, KeyboardCompletion, ToolError, OperationRecord, ScreenshotObservation, ResultBoundary, Display } from '../../src/service/deskhand/contract.ts';
declare const global: GlobalPoint;
declare const operation: OperationId;
declare const keyboard: KeyboardCompletion;
declare const screenshotError: ToolError<'screenshot'>;
declare const record: Extract<OperationRecord, {kind:'ended-by-restart'}>;
declare const metadata: ScreenshotObservation;
declare const boundary: ResultBoundary;
`;
  const failures = [
    "const sleeping: Display['asleep'] = true;",
    'const point: FramePoint = global;',
    'const frame: FrameId = operation;',
    'const point: GlobalPoint = keyboard.measured.globalPoint;',
    'const end: GlobalPoint = keyboard.measured.end.globalPoint;',
    "if (screenshotError.code === 'out_of_frame') {}",
    "const exact: 'exact' = record.events.kind;",
    "if (metadata.metadata.encoding.kind === 'png') { metadata.metadata.encoding.quality; }",
    'metadata.reference;',
    'metadata.encoded;',
    "boundary.lease(undefined, {requestId:1, operation:'release', ttlMs:1});",
    "boundary.lease(undefined, {requestId:1, operation:'release', operationId:operation});",
    "import type { Frame, FrameReference } from '../../src/service/deskhand/contract.ts';",
    'boundary.pointer(undefined, {requestId:1, operationId:operation, frame:metadata, action:"target"});',
  ];
  const source = prelude + failures.map((line) => line.startsWith('import ') ? line : `{ ${line} }`).join('\n');
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
  const host = ts.createCompilerHost(parsed.options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (path) => path === filename ? source : originalRead(path);
  const program = ts.createProgram([filename], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === filename);
  const lineOffset = prelude.split('\n').length - 1;
  for (let index = 0; index < failures.length; index++) {
    const matching = diagnostics.filter((diagnostic) => diagnostic.file && diagnostic.start !== undefined && diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line === lineOffset + index);
    assert(matching.length > 0, failures[index]);
    assert(matching.some((diagnostic) => [2322, 2339, 2367, 2353, 2305, 2739, 18048, 2561].includes(diagnostic.code)), failures[index]);
  }
});

test('actual known-path and dropped-optional source mutations fail preservation', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-mutations-'));
  try {
    for (const path of ['src/service/deskhand', 'src/service/json-values.ts', 'vendor/deskhand', 'tests/service/deskhand-results/support.ts', 'tests/service/deskhand-results/corpus.test.ts', 'package.json', 'tsconfig.json']) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'));
    const path = join(temporary, 'src/service/deskhand/contract.ts');
    const original = readFileSync(path, 'utf8');
    const mutations = [
      { before: 'measuredAt: string(wire.measured_at)', after: 'measuredAt: string(wire.measured_at_typo)', test: 'preserves every known fact in pointer.output.completed.json' },
      { before: "...(wire.shortcut === undefined ? {} : { shortcut: string(wire.shortcut) }),", after: '', test: 'preserves populated diagnostics' },
    ];
    for (const mutation of mutations) {
      assert(original.includes(mutation.before));
      writeFileSync(path, original.replace(mutation.before, mutation.after));
      const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: temporary, encoding: 'utf8' });
      assert.equal(compile.status, 0, compile.stdout + compile.stderr);
      const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mutation.test}`, 'tests/service/deskhand-results/corpus.test.ts'], { cwd: temporary, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout + run.stderr, /ERR_ASSERTION/);
      assert.match(run.stdout + run.stderr, /fail 1|# fail 1/);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

for (const mode of ['unreviewed generation', 'conflicting check and record']) {
  test(`generator ${mode} rejects without changing artifacts`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'deskhand-generator-state-'));
    const outputs = ['src/service/deskhand/vocabulary.generated.ts', 'tests/fixtures/deskhand-results/vocabulary-provenance.json',
      'tests/fixtures/deskhand-results/schema-inventory.json', 'tests/fixtures/deskhand-results/reviewed-sources.json'];
    try {
      for (const path of ['scripts/generate-deskhand-vocabulary.mjs', 'vendor/deskhand', ...outputs]) {
        const target = join(temporary, path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, path), target, { recursive: true });
      }
      const snapshot = () => outputs.map(path => readFileSync(join(temporary, path), 'utf8'));
      const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/generate-deskhand-vocabulary.mjs', ...args], { cwd: temporary, encoding: 'utf8' });
      const original = snapshot();
      assert.equal(run('--check').status, 0);
      assert.equal(run().status, 0);
      assert.deepEqual(snapshot(), original);
      const path = join(temporary, 'vendor/deskhand/contract-v0.11-draft/docs/schemas/defs.json');
      const schema = JSON.parse(readFileSync(path, 'utf8'));
      schema.$defs.state.enum.push('new_state');
      writeFileSync(path, JSON.stringify(schema));
      if (mode === 'conflicting check and record') {
        assert.equal(run('--record-reviewed-pin').status, 0);
        assert.equal(run('--check').status, 0);
        writeFileSync(join(temporary, outputs[3]), original[3]);
      }
      const before = snapshot();
      const rejected = mode === 'unreviewed generation' ? run() : run('--check', '--record-reviewed-pin');
      assert.equal(rejected.status, 1);
      assert.deepEqual(snapshot(), before, 'Rejected generation must preserve generated and review bytes');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}

test('literal, property, required-member, reference and conditional-only drift require review', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-drift-'));
  try {
    for (const path of ['scripts/generate-deskhand-vocabulary.mjs', 'vendor/deskhand', 'src/service/deskhand/vocabulary.generated.ts', 'tests/fixtures/deskhand-results']) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/generate-deskhand-vocabulary.mjs', ...args], { cwd: temporary, encoding: 'utf8' });
    const outputs = ['src/service/deskhand/vocabulary.generated.ts', 'tests/fixtures/deskhand-results/vocabulary-provenance.json',
      'tests/fixtures/deskhand-results/schema-inventory.json', 'tests/fixtures/deskhand-results/reviewed-sources.json'];
    const snapshot = () => outputs.map(path => readFileSync(join(temporary, path)));
    const initial = snapshot();
    assert.equal(run('--check').status, 0);
    assert.deepEqual(snapshot(), initial);
    const path = join(temporary, 'vendor/deskhand/contract-v0.11-draft/docs/schemas/defs.json');
    const original = readFileSync(path, 'utf8');
    const enumEdit = JSON.parse(original);
    enumEdit.$defs.state.enum.push('new_state');
    const requiredEdit = JSON.parse(original);
    requiredEdit.$defs.measured.required.pop();
    const referenceEdit = JSON.parse(original);
    referenceEdit.$defs.measured.properties.frontmost_app.$ref = '#/$defs/identified_app';
    const propertyEdit = JSON.parse(original);
    propertyEdit.$defs.measured.properties.future = { type: 'string' };
    const conditionalEdit = JSON.parse(original);
    conditionalEdit.$defs.tool_error.allOf[0].then.required = [];
    for (const value of [enumEdit, requiredEdit, referenceEdit, propertyEdit, conditionalEdit]) {
      writeFileSync(path, JSON.stringify(value));
      const before = snapshot();
      assert.equal(run('--check').status, 1);
      assert.deepEqual(snapshot(), before);
      assert.equal(run().status, 1);
      assert.deepEqual(snapshot(), before);
      writeFileSync(path, original);
      assert.equal(run().status, 0);
      assert.deepEqual(snapshot(), initial);
    }
    writeFileSync(path, JSON.stringify(conditionalEdit));
    assert.equal(run('--record-reviewed-pin').status, 0);
    const recorded = snapshot();
    assert.notDeepEqual(recorded[3], initial[3]);
    const review: unknown = JSON.parse(recorded[3].toString('utf8'));
    assert(review !== null && typeof review === 'object' && 'sources' in review && Array.isArray(review.sources));
    assert(review.sources.some(source => source.file === 'docs/schemas/defs.json' && source.sha256 === createHash('sha256').update(readFileSync(path)).digest('hex')));
    assert.equal(run('--check').status, 0);
    assert.deepEqual(snapshot(), recorded);
    assert.equal(run().status, 0);
    assert.deepEqual(snapshot(), recorded);
    const emptyLiteral = JSON.parse(original);
    emptyLiteral.$defs.state.enum = [];
    writeFileSync(path, JSON.stringify(emptyLiteral));
    for (const args of [[], ['--check'], ['--record-reviewed-pin']]) {
      assert.equal(run(...args).status, 1);
      assert.deepEqual(snapshot(), recorded);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('both conflicting generator flag orders reject before source reads without changing bytes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'deskhand-generator-flags-'));
  const outputs = ['src/service/deskhand/vocabulary.generated.ts', 'tests/fixtures/deskhand-results/vocabulary-provenance.json',
    'tests/fixtures/deskhand-results/schema-inventory.json', 'tests/fixtures/deskhand-results/reviewed-sources.json'];
  try {
    for (const path of ['scripts/generate-deskhand-vocabulary.mjs', 'vendor/deskhand', ...outputs]) {
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    const snapshot = () => outputs.map(path => readFileSync(join(temporary, path)));
    const before = snapshot();
    for (const sourceState of ['valid', 'unreadable']) {
      if (sourceState === 'unreadable') rmSync(join(temporary, 'vendor/deskhand/contract-v0.11-draft/docs/contract.md'));
      for (const args of [['--check', '--record-reviewed-pin'], ['--record-reviewed-pin', '--check']]) {
        const rejected = spawnSync(process.execPath, ['scripts/generate-deskhand-vocabulary.mjs', ...args], { cwd: temporary, encoding: 'utf8' });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /--check cannot record a reviewed pin/);
        assert.deepEqual(snapshot(), before);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
