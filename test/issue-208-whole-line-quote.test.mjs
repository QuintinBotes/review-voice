/**
 * #208: a quote under four words is kept when it is a whole line of the
 * description (whole sentences or a whole list item), not only when it is the
 * whole body of a section (#164). A short fragment of a line still drops.
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

const description =
  '## Summary\nRenames the notes routes in every menu.\nNo code changes.\n\n' +
  '## Checklist\n- [ ] Tests: not applicable\n- Docs updated for the new routes\n\n' +
  'The archive keeps its old layout. Archive moves later.';

function checkIntent(statements) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-208-'));
  try {
    const thread = join(dir, 'thread.json');
    const comments = [{ path: null, line: null, author: 'author', body: description, kind: 'description' }];
    writeFileSync(thread, JSON.stringify({ repository: 'example/notes', pullNumber: 7, comments, reviews: [] }));
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#208: a short sentence on its own line and a short whole list item are kept, with a note', () => {
  const result = checkIntent([
    { id: 'int_001', kind: 'claim', statement: 'The change makes no code changes.', quote: 'No code changes.' },
    { id: 'int_002', kind: 'qa', statement: 'Tests are not applicable.', quote: '- [ ] Tests: not applicable' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).statements.map(({ id, quote }) => [id, quote]),
    [
      ['int_001', 'No code changes.'],
      ['int_002', '- [ ] Tests: not applicable'],
    ],
  );
  assert.match(result.stderr, /Kept quote of int_001 under 4 words: it is a whole line of the description/);
});

test('#208: a short sentence that shares its line with another still drops', () => {
  const result = checkIntent([
    { id: 'int_001', kind: 'goal', statement: 'Notes routes are renamed in every menu.', quote: 'Renames the notes routes in every menu.' },
    { id: 'int_002', kind: 'deliberate', statement: 'The archive moves later.', quote: 'The archive keeps its old layout.', reason: 'Archive moves later.' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements.map(({ id }) => id), ['int_001']);
  assert.match(result.stderr, /Dropped statement int_002 \(statements\[1\]\.reason must be at least 4 words/);
});
