/**
 * #441: check-intent dropped a quote taken from one cell of a Markdown table
 * in the description, because the whole row read as one line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function checkIntent(description, statements) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-intent-441-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(thread, JSON.stringify({ repository: 'example/pay', pullNumber: 1, comments: [{ path: null, line: null, author: 'a', body: description, kind: 'description' }], reviews: [] }));
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TABLE = [
  '## Fix',
  '',
  '| call | what it is for | now |',
  '|---|---|---|',
  '| `shim` `readPgid` | the shim must lead its group | falls back to signal 0 on its own pid, which needs no `ps` |',
  '| watchdog | sample the memory of a check | kept; it runs outside the sandbox in production |',
  '',
  'The check profile does not need process listing.',
].join('\n');

test('a quote from one table cell is a whole unit of the description', () => {
  const result = checkIntent(TABLE, [
    { id: 'int_001', kind: 'claim', statement: 'The shim no longer needs ps to check its own group.', quote: 'falls back to signal 0 on its own pid, which needs no `ps`' },
    { id: 'int_002', kind: 'claim', statement: 'The watchdog still samples memory outside the sandbox.', quote: 'kept; it runs outside the sandbox in production' },
    { id: 'int_003', kind: 'claim', statement: 'The check profile needs no process listing.', quote: 'The check profile does not need process listing.' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements.map((s) => s.id), ['int_001', 'int_002', 'int_003']);
});

test('a quote spanning two cells is still not a whole unit', () => {
  const result = checkIntent(TABLE, [
    { id: 'int_001', kind: 'claim', statement: 'The watchdog samples memory.', quote: 'sample the memory of a check kept' },
  ]);
  assert.notEqual(result.status, 0);
});
