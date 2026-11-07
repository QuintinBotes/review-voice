/**
 * #237: a quote that keeps its task-list marker (`[ ] ...` or `[x] ...`) is
 * still a verbatim list item of the description. The marker is stripped from
 * both sides before matching, as the list bullet already was.
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

const description = [
  '## Summary',
  'Adds the lock banner.',
  '',
  '#### QA',
  '',
  '- [ ] lock and unlock the session, no banner',
  '- [x] open the settings page while locked',
  '* [X] reload with the session locked and the banner stays',
  '',
].join('\n');

function checkIntent(statements) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-237-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(
      thread,
      JSON.stringify({ repository: 'example/notes', pullNumber: 7, comments: [{ path: null, line: null, author: 'author', body: description, kind: 'description' }], reviews: [] }),
    );
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A statement must share a significant word with its quote, as the extractor's do.
const qa = (id, quote, statement) => ({ id, kind: 'qa', statement, quote });
const LOCK = 'Locking and unlocking the session shows no banner.';

test('a QA quote that keeps its task-list marker is accepted, with or without the bullet', () => {
  const result = checkIntent([
    qa('int_001', '[ ] lock and unlock the session, no banner', LOCK),
    qa('int_002', '- [x] open the settings page while locked', 'The settings page opens while locked.'),
    qa('int_003', '[X] reload with the session locked and the banner stays', 'The banner stays after a reload while locked.'),
    qa('int_004', 'lock and unlock the session, no banner', LOCK),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  // The quote is kept as given; the marker is stripped for matching only.
  assert.deepEqual(
    out.statements.map((statement) => statement.quote),
    [
      '[ ] lock and unlock the session, no banner',
      '- [x] open the settings page while locked',
      '[X] reload with the session locked and the banner stays',
      'lock and unlock the session, no banner',
    ],
  );
  assert.doesNotMatch(result.stderr, /Dropped statement/);
});

test('a marker alone does not make a quote that is not in the description match', () => {
  const result = checkIntent([
    qa('int_001', '[ ] lock and unlock the session, no banner', LOCK),
    qa('int_002', '[ ] lock and unlock the session, with a banner', 'Locking the session shows a banner.'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements.map((statement) => statement.id), ['int_001']);
  assert.match(result.stderr, /Dropped statement int_002 \(statements\[1\]\.quote does not occur in the pull request description/);
});
