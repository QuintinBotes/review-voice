/**
 * #406: a one-word section answer ("None.") was dropped when a thematic break
 * followed its section, and when the same answer sat under two headings.
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
  const dir = mkdtempSync(join(tmpdir(), 'rv-intent-406-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(thread, JSON.stringify({ repository: 'example/pay', pullNumber: 1, comments: [{ path: null, line: null, author: 'a', body: description, kind: 'description' }], reviews: [] }));
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const none = { id: 'int_001', kind: 'claim', statement: 'No database changes.', quote: 'None.' };
const headingOf = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).statements[0].heading;
};

test('a thematic break after the section, or between sections, leaves the answer whole', () => {
  for (const body of [
    '## Database changes\nNone.\n\n---\n',
    '## Database changes\nNone.\n\n***\n\n## Testing\nUnit tests cover the new branch.',
    '## Summary\nAdds a cache.\n\n---\n\n## Database changes\nNone.\n\n---',
  ]) {
    assert.equal(headingOf(checkIntent(body, [none])), 'Database changes', JSON.stringify(body));
  }
});

test('the same answer under two headings is matched to the heading the statement is about', () => {
  const body = '## Breaking changes\nNone.\n\n## Database changes\nNone.\n';
  assert.equal(headingOf(checkIntent(body, [none])), 'Database changes');
  const breaking = { ...none, statement: 'No breaking changes.' };
  assert.equal(headingOf(checkIntent(body, [breaking])), 'Breaking changes');
  // A tie goes to the first heading, unless the extractor named one.
  const tie = { ...none, statement: 'No changes.' };
  assert.equal(headingOf(checkIntent(body, [tie])), 'Breaking changes');
  assert.equal(headingOf(checkIntent(body, [{ ...tie, heading: 'Database changes' }])), 'Database changes');
  // A heading never stands in for the word check: a statement sharing nothing is still refused.
  assert.equal(checkIntent(body, [{ ...none, statement: 'Nothing else is affected.' }]).status, 2);
});

test('a thematic break inside a fenced block, or right under text, is not read as one', () => {
  const fenced = '## Database changes\nNone.\n\n```\n---\n```\n';
  assert.notEqual(checkIntent(fenced, [none]).status, 0, 'the fence is still text of the section');
});
