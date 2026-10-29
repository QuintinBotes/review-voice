/**
 * #164: a valid statement was dropped when its sentence ran over 300
 * characters (no quote passed both the cap and the whole-sentence rule), or
 * when it was a short answer under a heading ("No flag." under "Feature
 * flags"). Both now keep the statement without giving up the guarantee that a
 * quote never loses a negation or condition.
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

const long =
  'When the upstream service times out, the retry loop waits for the configured back-off, records the attempt in the audit table, ' +
  'and gives up after the third attempt without marking the payment as failed, because the reconciliation job settles it the next ' +
  'morning from the provider report and a premature failure would send the guest a second charge request.';

const description = [
  '## Summary',
  'Adds retries to the payment capture call.',
  '',
  long,
  '',
  '## Feature flags',
  'No flag.',
  '',
  '## Database changes',
  'None.',
  '',
  '## Testing',
  'Ran the suite. All green.',
].join('\n');

function checkIntent(statements) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-intent-164-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(thread, JSON.stringify({ repository: 'example/pay', pullNumber: 1, comments: [{ path: null, line: null, author: 'a', body: description, kind: 'description' }], reviews: [] }));
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#164: a whole sentence over 300 characters is kept as the quote', () => {
  assert.ok(long.length > 300);
  const result = checkIntent([{ id: 'int_001', kind: 'claim', statement: 'A timed-out capture is not marked as failed.', quote: long }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).statements[0].quote, long);
});

test('#164: a clause of a sentence over 300 characters widens to the whole sentence', () => {
  const clause = 'gives up after the third attempt without marking the payment as failed';
  const result = checkIntent([{ id: 'int_001', kind: 'claim', statement: 'Retries give up after the third attempt.', quote: clause }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).statements[0].quote, long);
  assert.match(result.stderr, /Widened quote of int_001 to its whole sentence\./);
});

test('#164: a short answer that is the whole of a section is kept with its heading', () => {
  const result = checkIntent([
    { id: 'int_001', kind: 'claim', statement: 'No feature flag is added.', quote: 'No flag.' },
    { id: 'int_002', kind: 'claim', statement: 'The database schema does not change.', quote: 'None.' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  const [flag, schema] = JSON.parse(result.stdout).statements;
  assert.deepEqual([flag.quote, flag.heading], ['No flag.', 'Feature flags']);
  assert.deepEqual([schema.quote, schema.heading], ['None.', 'Database changes']);
});

test('#164: a short quote that is a heading is still dropped; a short sentence in a section keeps its heading (#222)', () => {
  const result = checkIntent([
    { id: 'int_001', kind: 'claim', statement: 'Retries are added to capture.', quote: 'Adds retries to the payment capture call.' },
    { id: 'int_002', kind: 'claim', statement: 'Feature flags are covered.', quote: 'Feature flags' },
    { id: 'int_003', kind: 'qa', statement: 'All tests are green.', quote: 'All green.' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements.map((s) => [s.id, s.heading]), [['int_001', undefined], ['int_003', 'Testing']]);
  assert.match(result.stderr, /Dropped statement int_002 \(statements\[1\]\.quote must be at least 4 words/);
});

test('#164: check-intent accepts its own output again, heading included', () => {
  const first = checkIntent([{ id: 'int_001', kind: 'claim', statement: 'No feature flag is added.', quote: 'No flag.' }]);
  const again = checkIntent(JSON.parse(first.stdout).statements);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, '');
  assert.equal(JSON.parse(again.stdout).statements[0].heading, 'Feature flags');
});
