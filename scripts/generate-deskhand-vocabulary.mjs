import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'vendor/deskhand/contract-v0.11-draft');
const schemas = join(source, 'docs/schemas');
const destination = join(root, 'src/service/deskhand/vocabulary.generated.ts');
const inventoryPath = join(root, 'tests/fixtures/deskhand-results/schema-inventory.json');
const reviewPath = join(root, 'tests/fixtures/deskhand-results/reviewed-sources.json');
const provenancePath = join(root, 'tests/fixtures/deskhand-results/vocabulary-provenance.json');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const entries = [];
function leaf(name, file, pointer) {
  const bytes = readFileSync(join(schemas, file));
  let value = JSON.parse(bytes);
  for (const part of pointer.slice(1).split('/')) {
    assert(Object.hasOwn(value, part), `Missing literal ${file}#${pointer}`);
    value = value[part];
  }
  assert(Array.isArray(value) ? value.length > 0 && value.every((v) => ['string', 'number'].includes(typeof v)) : ['string', 'number'].includes(typeof value));
  entries.push({ name, file, pointer, sha256: hash(bytes), value });
}
const contract = readFileSync(join(source, 'docs/contract.md'), 'utf8');
const catalog = contract.split('### 3.2 ')[1].split('### 3.3 ')[0];
const toolNames = [...catalog.match(/in the order ([\s\S]*?), in one page/)[1].matchAll(/`([a-z]+)`/g)].map((match) => match[1]);
assert.deepEqual(readdirSync(join(schemas, 'tools')).filter((file) => file.endsWith('.output.json')).map((file) => file.split('.')[0]).sort(), [...toolNames].sort());
for (const [name, field] of Object.entries({ states: 'state', blockingStates: 'blocking_state', conditions: 'condition', errorCodes: 'error_code', operationStatuses: 'operation_status', staleReasons: 'stale_frame_reason', buttons: 'mouse_button', modifiers: 'modifier', keys: 'key' })) leaf(name, 'defs.json', `/$defs/${field}/enum`);
leaf('deniedBy', 'defs.json', '/$defs/tool_error/properties/details/properties/denied_by/enum');
leaf('completedStatus', 'defs.json', '/$defs/effect_result/properties/status/const');
for (const tool of toolNames) leaf(`${tool}Errors`, `tools/${tool}.output.json`, `/$defs/${tool}_error/allOf/1/properties/code/enum`);
for (const [name, field] of Object.entries({ contractVersion: 'contract_version', protocolVersion: 'mcp_protocol_version' })) leaf(name, 'tools/status.output.json', `/$defs/status_result/properties/${field}/const`);
for (const [name, field] of Object.entries({ formats: 'format', jpegQualities: 'jpeg_quality' })) leaf(name, 'tools/screenshot.output.json', `/$defs/screenshot_result/properties/${field}/enum`);
leaf('jpegMime', 'tools/screenshot.output.json', '/$defs/screenshot_result/then/properties/mime_type/const');
leaf('pngMime', 'tools/screenshot.output.json', '/$defs/screenshot_result/else/properties/mime_type/const');
for (const [name, path] of Object.entries({ maxImageBytes: 'image_bytes/maximum', maxWidth: 'output_pixel_size/properties/width/maximum', maxHeight: 'output_pixel_size/properties/height/maximum' })) leaf(name, 'tools/screenshot.output.json', `/$defs/screenshot_result/properties/${path}`);
leaf('maxPixels', 'tools/status.output.json', '/$defs/limits/properties/max_pixels/const');
leaf('maxDragPoints', 'tools/pointer.input.json', '/$defs/pointer_drag/properties/path/maxItems');
for (const [name, field] of Object.entries({ leaseOperations: 'op', leaseOutcomes: 'outcome', leaseRefusals: 'code' })) leaf(name, 'tools/lease.output.json', `/$defs/lease_result/properties/${field}/enum`);
for (const [name, path] of Object.entries({ acquireOutcomes: '2/then/properties/outcome/enum', acquireRefusals: '2/then/properties/code/enum', renewOutcomes: '3/then/properties/outcome/enum', releaseOperation: '4/if/properties/op/const', releaseOutcomes: '4/then/properties/outcome/enum', releaseRefusals: '4/then/properties/code/enum' })) leaf(name, 'tools/lease.output.json', `/$defs/lease_result/allOf/${path}`);
leaf('leaseInputOperations', 'tools/lease.input.json', '/properties/op/enum');
leaf('rpcErrors', 'wire/jsonrpc-error.json', '/properties/error/properties/code/enum');
assert.deepEqual(entries.find((entry) => entry.name === 'leaseOperations').value, entries.find((entry) => entry.name === 'leaseInputOperations').value);
function declaration(name, value) {
  const literal = JSON.stringify(value);
  return `export const ${name}: ${Array.isArray(value) ? `readonly ${literal}` : literal} = ${literal};`;
}
const generated = [declaration('toolNames', toolNames), ...entries.map((entry) => declaration(entry.name, entry.value)), `export const errorsByTool = { ${toolNames.map((tool) => `${tool}: ${tool}Errors`).join(', ')} };`, ''].join('\n');
const inventory = [];
const sources = [];
function visit(value, file, pointer = '') {
  if (!value || typeof value !== 'object') return;
  if (value.properties || value.required || value.$ref) inventory.push({ file, pointer, ...(value.properties ? { properties: Object.keys(value.properties).sort() } : {}), ...(value.required ? { required: value.required } : {}), ...(value.$ref ? { reference: value.$ref } : {}) });
  for (const [key, child] of Object.entries(value)) visit(child, file, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
}
function collect(directory) {
  for (const name of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, name.name);
    if (name.isDirectory()) { if (name.name !== 'examples') collect(path); }
    else if (name.name.endsWith('.json')) { const file = relative(schemas, path); visit(load(path), file); sources.push({ file: `docs/schemas/${file}`, sha256: hash(readFileSync(path)) }); }
  }
}
collect(schemas);
sources.push({ file: 'docs/contract.md', sha256: hash(contract) });
const reviewed = { purpose: 'Semantic review required for every source change, including conditionals without new properties.', sources };
function checkOrWrite(path, value) {
  if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), value, `${relative(root, path)} drift requires review`);
  else writeFileSync(path, value);
}
checkOrWrite(destination, generated);
checkOrWrite(provenancePath, `${JSON.stringify(entries.map(({ name, file, pointer, sha256 }) => ({ name, file, pointer, sha256 })), null, 2)}\n`);
checkOrWrite(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
if (process.argv.includes('--record-reviewed-pin')) writeFileSync(reviewPath, `${JSON.stringify(reviewed, null, 2)}\n`);
else assert.deepEqual(load(reviewPath), reviewed, 'Semantic pin changed. Review contract conditions and behavioral fixtures before recording approval.');
