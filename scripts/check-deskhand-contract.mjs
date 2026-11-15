import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { commit, tag, contractSha256, root, digest, files } from './vendor-deskhand-contract.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js');
const addFormats = require('ajv-formats');
assert.equal(require('ajv/package.json').version, '8.20.0');
assert.equal(require('ajv-formats/package.json').version, '3.0.1');
const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
  validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats(ajv, { mode: 'full' });
const read = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(read(path));
const sourceRoot = join(root, tag);
const manifest = json(join(root, 'pin.json'));
assert.equal(manifest.commit, commit);
assert.equal(manifest.tag, tag);
assert.equal(manifest.contractSha256, contractSha256);
assert.equal(manifest.repository, 'https://github.com/mattsp1290/deskhand');
assert.deepEqual(files(sourceRoot).map((path) => relative(sourceRoot, path)), manifest.sources.map((entry) => entry.path));
assert.equal(manifest.sources.length, 303);
assert.equal(digest(JSON.stringify(manifest.sources)), manifest.sourcesSha256);
for (const entry of manifest.sources) {
  const bytes = readFileSync(join(sourceRoot, entry.path));
  assert.equal(bytes.length, entry.bytes, `${entry.path} byte count`);
  assert.equal(digest(bytes), entry.sha256, `${entry.path} SHA-256`);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, entry.gitBlob, `${entry.path} Git blob`);
}
assert.equal(digest(readFileSync(join(sourceRoot, 'docs/contract.md'))), contractSha256);
const approval = json(join(root, 'approved-amendments.json'));
assert.equal(approval.source, 'approval-source.json');
assert.equal(digest(readFileSync(join(root, approval.source))), approval.sourceSha256);
const approvalSource = json(join(root, approval.source));
assert.equal(approval.issue, approvalSource.id);
assert.equal(approval.approvedOn, '2026-11-14');
assert.equal(approval.amendments.length, 4);
assert(approvalSource.description.includes('owner approved these amendments'));

const schemaRoot = join(sourceRoot, 'docs/schemas');
const schemas = new Map(files(schemaRoot).filter((path) => path.endsWith('.json') && !path.includes('/examples/'))
  .map((path) => [relative(schemaRoot, path), json(path)]));
const stems = new Map();
const byId = new Map();
const counts = { sources: manifest.sources.length, schemas: schemas.size, refs: 0, formats: new Set(), positive: 0,
  negative: 0, embedded: 0, wire: 0, blocks: 0, illustrativeBlocks: 0, bundled: 0, checks: 0 };
function walk(node, visit, pointer = '') {
  if (!node || typeof node !== 'object') return;
  visit(node, pointer);
  for (const [key, value] of Object.entries(node)) {
    walk(value, visit, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
  }
}
for (const [path, schema] of schemas) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', path);
  assert.equal(schema.$id, `https://deskhand.invalid/schemas/${path}`, path);
  const stem = path.split('/').at(-1).slice(0, -5);
  assert(!stems.has(stem), `Duplicate stem ${stem}`);
  stems.set(stem, path);
  byId.set(schema.$id, schema);
  ajv.addSchema(schema);
}
for (const [path, schema] of schemas) {
  walk(schema, (node) => {
    if (typeof node.format === 'string') {
      counts.formats.add(node.format);
      assert(ajv.formats[node.format] && ajv.formats[node.format] !== true, `Unasserted format ${node.format}`);
    }
    if (node.$ref) {
      counts.refs++;
      const url = new URL(node.$ref, schema.$id);
      const fragment = url.hash;
      url.hash = '';
      let target = byId.get(url.href);
      assert(target, `${path} nonlocal/unresolved ref ${node.$ref}`);
      if (fragment) {
        assert(fragment.startsWith('#/'), `Unsupported fragment ${fragment}`);
        for (const key of decodeURIComponent(fragment.slice(2)).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
          assert(Object.hasOwn(target, key), `${path} unresolved pointer ${node.$ref}`);
          target = target[key];
        }
      }
      assert(typeof target === 'boolean' || (target && typeof target === 'object'), path);
    }
  });
  assert(ajv.getSchema(schema.$id), `Schema compilation ${path}`);
}
const bundled = new Map();
const defs = schemas.get('defs.json').$defs;
for (const [path, schema] of schemas) {
  if (!path.startsWith('tools/')) continue;
  assert(schemas.has(path.replace(/\.(input|output)\.json$/, (_, direction) => `.${direction === 'input' ? 'output' : 'input'}.json`)));
  const copy = structuredClone(schema);
  delete copy.$id;
  copy.$defs ??= {};
  for (const [name, definition] of Object.entries(defs)) {
    assert(!Object.hasOwn(copy.$defs, name), `Bundled definition collision ${path} ${name}`);
    copy.$defs[name] = structuredClone(definition);
  }
  walk(copy, (node) => {
    if (typeof node.$ref === 'string') node.$ref = node.$ref.replace('../defs.json#/$defs/', '#/$defs/');
    if (node.$ref) assert(node.$ref.startsWith('#/'), `External bundled ref ${path}`);
  });
  if (path.endsWith('.input.json')) {
    assert.equal(copy.type, 'object');
    assert.equal(copy.additionalProperties, false);
    for (const key of ['oneOf', 'anyOf', 'allOf', 'if', 'not', 'dependentRequired']) assert(!Object.hasOwn(copy, key), `${path} ${key}`);
  }
  const standalone = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
    validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats(standalone, { mode: 'full' });
  bundled.set(path, { schema: copy, validate: standalone.compile(copy) });
  counts.bundled++;
}
const covered = new Set();
const negatives = new Set();
const cases = [];
function check(path, value, valid, label) {
  assert(schemas.has(path), `Unknown schema ${path}`);
  const validators = [ajv.getSchema(schemas.get(path).$id), bundled.get(path)?.validate].filter(Boolean);
  const before = JSON.stringify(value);
  for (const validate of validators) {
    assert.equal(validate(value), valid, `${label} against ${path}: ${JSON.stringify(validate.errors)}`);
    assert.equal(JSON.stringify(value), before, `Validator mutated ${label}`);
    counts.checks++;
  }
  if (valid) covered.add(path);
  else negatives.add(path);
}
function checkInput(tool, args, label) {
  check(`tools/${tool}.input.json`, args, true, label);
  assert(!(tool === 'lease' && args.op === 'release' && Object.hasOwn(args, 'ttl_ms')), `${label} release must omit ttl_ms`);
}
function checkResult(method, result, tool, label) {
  const paths = { 'server/discover': 'server-discover-result', 'tools/list': 'tools-list-result', 'tools/call': 'tools-call-result' };
  check(`wire/${paths[method]}.json`, result, true, label);
  if (method === 'server/discover') assert.deepEqual(result.supportedVersions, ['2026-07-28']);
  if (method !== 'tools/call') return;
  if (tool) check(`tools/${tool}.output.json`, result.structuredContent, true, `${label} structuredContent`);
  const illustrative = result.content.at(-1).text === '<JSON of structuredContent>';
  if (illustrative) {
    assert.equal(tool, undefined, 'Illustrative result must have no selected tool');
    return;
  }
  assert.deepEqual(JSON.parse(result.content.at(-1).text), result.structuredContent, `${label} text equality`);
  const images = result.content.filter((block) => block.type === 'image');
  if (tool === 'screenshot' && !result.isError) {
    assert.equal(images.length, 1, label);
    assert.equal(result.content[0].type, 'image', label);
    assert.equal(images[0].mimeType, result.structuredContent.mime_type, label);
  } else assert.equal(images.length, 0, label);
}
function checkRequest(doc, method, tool, label, illustrative = false) {
  check('wire/jsonrpc-request.json', doc, true, label);
  assert.equal(doc.method, method, label);
  assert.equal(doc.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28', label);
  if (tool) {
    assert.equal(doc.params.name, tool, label);
    if (!illustrative) checkInput(tool, doc.params.arguments ?? {}, `${label} arguments`);
  }
}
const pairs = new Map();
for (const path of files(join(schemaRoot, 'examples'))) {
  const name = relative(join(schemaRoot, 'examples'), path);
  assert(name.endsWith('.json'), `Unknown example ${name}`);
  const value = json(path);
  if (!name.startsWith('wire/')) {
    const negative = name.startsWith('invalid/');
    const filename = negative ? name.slice(8) : name;
    assert(!filename.includes('/'), `Unknown examples directory ${name}`);
    const stem = [...stems.keys()].sort((a, b) => b.length - a.length)
      .find((key) => filename.startsWith(`${key}.`) && /^[a-z0-9-]+\.json$/.test(filename.slice(key.length + 1)));
    assert(stem, `No longest schema stem for ${name}`);
    const schema = stems.get(stem);
    cases.push({ path: name, schema, valid: !negative });
    check(schema, value, !negative, name);
    counts[negative ? 'negative' : 'positive']++;
    continue;
  }
  counts.wire++;
  const wire = name.slice(5);
  const match = /^(server-discover|tools-list)\.(request|response)\.json$/.exec(wire)
    ?? /^tools-call\.([a-z]+)\.([a-z0-9-]+)\.(request|response)\.json$/.exec(wire);
  const error = /^error\.[a-z0-9-]+\.response\.json$/.test(wire);
  const notification = /^[a-z0-9-]+\.notification\.json$/.test(wire);
  assert(match || error || notification, `Unknown wire convention ${name}`);
  if (error || notification) {
    cases.push({ path: name, schema: `wire/jsonrpc-${error ? 'error' : 'notification'}.json`, valid: true });
    check(`wire/jsonrpc-${error ? 'error' : 'notification'}.json`, value, true, name);
  } else {
    const call = wire.startsWith('tools-call.');
    const tool = call ? match[1] : undefined;
    const method = call ? 'tools/call' : match[1] === 'server-discover' ? 'server/discover' : 'tools/list';
    const kind = match.at(-1);
    const resultSchema = { 'server/discover': 'server-discover-result', 'tools/list': 'tools-list-result', 'tools/call': 'tools-call-result' };
    cases.push({ path: name, schema: `wire/jsonrpc-${kind}.json`, valid: true,
      ...(kind === 'response' ? { resultSchema: `wire/${resultSchema[method]}.json` } : {}),
      ...(tool ? { toolSchema: `tools/${tool}.${kind === 'request' ? 'input' : 'output'}.json` } : {}),
    });
    const key = wire.replace(/\.(request|response)\.json$/, '');
    const pair = pairs.get(key) ?? {};
    pair[kind] = value;
    pairs.set(key, pair);
    if (kind === 'request') checkRequest(value, method, tool, name);
    else {
      check('wire/jsonrpc-response.json', value, true, name);
      checkResult(method, value.result, tool, name);
    }
  }
}
for (const [key, pair] of pairs) if (pair.request && pair.response) assert.equal(pair.request.id, pair.response.id, `${key} ID pairing`);
for (const [path, schema] of schemas) {
  walk(schema, (node, pointer) => {
    if (!Array.isArray(node.examples)) return;
    for (const [index, example] of node.examples.entries()) {
      if (node === schema) check(path, example, true, `${path} examples ${index}`);
      else {
        const validate = ajv.compile({ $schema: schema.$schema, $ref: `${schema.$id}#${pointer}` });
        assert.equal(validate(example), true, `${path}${pointer} embedded example ${index}: ${JSON.stringify(validate.errors)}`);
      }
      counts.embedded++;
    }
  });
}
const contract = read(join(sourceRoot, 'docs/contract.md'));
for (const match of contract.matchAll(/^```json\n(.*?)^```/gms)) {
  counts.blocks++;
  const doc = JSON.parse(match[1]);
  const label = `contract JSON block ${counts.blocks}`;
  if (doc.method) {
    if (!Object.hasOwn(doc, 'id')) check('wire/jsonrpc-notification.json', doc, true, label);
    else {
      const illustrative = Object.hasOwn(doc.params?.arguments ?? {}, '...');
      if (illustrative) counts.illustrativeBlocks++;
      checkRequest(doc, doc.method, doc.params.name, label, illustrative);
    }
  } else if (doc.error) check('wire/jsonrpc-error.json', doc, true, label);
  else if (doc.result) {
    check('wire/jsonrpc-response.json', doc, true, label);
    checkResult(doc.result.structuredContent ? 'tools/call' : doc.result.tools ? 'tools/list' : 'server/discover', doc.result, undefined, label);
  } else if (doc.resultType) {
    if (doc.content?.at(-1)?.text === '<JSON of structuredContent>') counts.illustrativeBlocks++;
    checkResult('tools/call', doc, undefined, label);
  } else check('allowance.json', doc, true, label);
}
const section = contract.split('### 3.2 ')[1].split('### 3.3 ')[0];
const order = [...section.match(/in the order ([\s\S]*?), in one page/)[1].matchAll(/`([a-z]+)`/g)].map((match) => match[1]);
assert.deepEqual(order, ['status', 'displays', 'screenshot', 'pointer', 'keyboard', 'lease']);
const rows = [...section.matchAll(/^\| `([a-z]+)` \| (.*?) \| (read|effect|lease) \| `(true|false)` \| `(true|false)` \| `(true|false)` \| `(true|false)` \|$/gm)];
assert.deepEqual(rows.map((row) => row[1]), order);
assert.equal(bundled.size, order.length * 2);
const listing = { resultType: 'complete', ttlMs: 300000, cacheScope: 'private', tools: rows.map((row) => ({
  name: row[1], title: row[2], description: schemas.get(`tools/${row[1]}.input.json`).description,
  inputSchema: bundled.get(`tools/${row[1]}.input.json`).schema,
  outputSchema: bundled.get(`tools/${row[1]}.output.json`).schema,
  annotations: Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].map((key, index) => [key, row[index + 4] === 'true'])),
})) };
checkResult('tools/list', listing, undefined, 'six ordered bundled tools');
for (const path of schemas.keys()) {
  if (path === 'defs.json') continue;
  assert(covered.has(path), `No valid corpus instance ${path}`);
  assert(negatives.has(path), `No invalid corpus instance ${path}`);
}
const allowance = json(join(schemaRoot, 'examples/allowance.lunus-macbook-pro.json'));
for (const [date, valid] of [['2025-02-29', false], ['2024-02-29', true], ['2100-02-29', false], ['2000-02-29', true]]) {
  check('allowance.json', { ...allowance, not_before: `${date}T12:00:00Z`, expires_at: `${date}T12:01:00Z` }, valid, `real date ${date}`);
}
const gated = json(join(schemaRoot, 'examples/status.output.gated-and-disarmed.json'));
check('tools/status.output.json', gated, true, 'conditional state with matching prefixItems');
check('tools/status.output.json', { ...gated, active_states: [...gated.active_states].reverse() }, false,
  'conditional gated state requires first tuple member gated');
check('tools/status.output.json', { ...gated, active_states: [] }, false, 'conditional gated state requires nonempty tuple');
const keyboard = json(join(schemaRoot, 'examples/keyboard.input.type.json'));
check('tools/keyboard.input.json', { ...keyboard, action: { ...keyboard.action, key: 'return' } }, false, 'conditional type forbids key');
const release = json(join(schemaRoot, 'examples/lease.input.release.json'));
checkInput('lease', release, 'release without TTL');
const releaseWithTtl = { ...release, ttl_ms: 30000 };
check('tools/lease.input.json', releaseWithTtl, true, 'flat schema release TTL exception');
assert.throws(() => checkInput('lease', releaseWithTtl, 'release TTL semantic exception'), /release must omit ttl_ms/);
check('tools/lease.input.json', { ...release, operation_id: 'not-allowed' }, false, 'lease excludes operation ID');
assert.equal(counts.illustrativeBlocks, 2);
assert(counts.positive > 0 && counts.negative > 0 && counts.wire > 0);
console.log(JSON.stringify({ ...counts, formats: [...counts.formats].sort(), exampleCases: cases.length,
  ...(process.argv.includes('--cases') ? { cases } : {}),
  caseTableSha256: digest(JSON.stringify(cases)), pinSha256: digest(readFileSync(join(root, 'pin.json'))),
  node: process.version, ajv: require('ajv/package.json').version, ajvFormats: require('ajv-formats/package.json').version }, null, 2));
