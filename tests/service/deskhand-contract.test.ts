import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('pinned Deskhand corpus qualifies with local Draft 2020-12 validation', () => {
  process.stdout.write(execFileSync(process.execPath, ['scripts/check-deskhand-contract.mjs'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
});
