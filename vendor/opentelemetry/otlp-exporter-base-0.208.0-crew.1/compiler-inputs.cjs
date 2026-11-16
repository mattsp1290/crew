'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { fileURLToPath } = require('node:url');
const read = fs.readFileSync.bind(fs);
const write = fs.writeFileSync.bind(fs);
const root = process.env.CREW_BUILD_ROOT;
const pins = JSON.parse(read(process.env.CREW_INPUT_MANIFEST, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const reads = new Map();

fs.readFileSync = function (file, options) {
  assert(typeof file === 'string' || Buffer.isBuffer(file) || file instanceof URL,
    'Compiler descriptor reads are not tracked');
  const absolute = fs.realpathSync(file instanceof URL ? fileURLToPath(file) : file);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  assert(relative && !relative.startsWith('../') && !path.isAbsolute(relative),
    `Compiler input outside build root: ${absolute}`);
  const bytes = read(absolute);
  assert.equal(hash(bytes), pins[relative], `Unpinned compiler input: ${relative}`);
  reads.set(relative, hash(bytes));
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
};

fs.readFile = fs.promises.readFile = () => {
  throw new Error('Unexpected asynchronous compiler read');
};

process.on('exit', () => {
  for (const [relative, digest] of reads) {
    assert.equal(hash(read(path.join(root, relative))), digest,
      `Compiler input changed: ${relative}`);
  }
  write(process.env.CREW_READ_REPORT,
    JSON.stringify(Object.fromEntries([...reads].sort()), null, 2) + '\n',
    { flag: 'wx' });
});
