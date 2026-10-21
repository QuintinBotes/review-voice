/** Stated intent: check-intent refuses invented intent, and intent_ref reaches the verifier. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const read = (path) => readFileSync(join(plugin, path), 'utf8');

const description =
  'Renames the notes routes.\n\nAll menus now link to the new /notes routes.\n' +
  'Archived notes are still excluded   from search.\nQA: the note_opened click event stays as it is.';

function withThread(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-intent-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(
      thread,
      JSON.stringify({ repository: 'example/notes', pullNumber: 7, comments: [{ path: null, line: null, author: 'author', body: description, kind: 'description' }], reviews: [] }),
    );
    return fn(thread);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const checkIntent = (statements) =>
  withThread((thread) =>
    spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) }),
  );

const goal = { id: 'int_001', kind: 'goal', statement: 'Every menu uses the new routes.', quote: 'All menus now link to the new /notes routes.', scope: 'complete' };
const deliberate = {
  id: 'int_002',
  kind: 'deliberate',
  statement: 'Archived notes stay out of search.',
  quote: 'Archived notes are still excluded from search.',
  reason: 'Archive indexing ships later.',
};

test('check-intent accepts quoted statements and normalises them', () => {
  const result = checkIntent([goal, deliberate, { id: 'int_003', kind: 'qa', statement: 'The click event is unchanged.', quote: 'the note_opened click event stays as it is' }]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.statements.length, 3);
  assert.equal(out.statements[0].scope, 'complete');
  assert.equal(out.statements[1].reason, 'Archive indexing ships later.');
  assert.equal('reason' in out.statements[2], false);
});

test('an empty statement list is valid', () => {
  const result = checkIntent([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { statements: [] });
});

for (const [name, statements, problem] of [
  ['an unknown kind', [{ ...goal, kind: 'wish', scope: undefined }], /kind must be one of/],
  ['a reason on a non-deliberate statement', [{ ...goal, reason: 'Because.' }], /reason belongs only on a deliberate/],
  ['a deliberate statement with no reason', [{ ...deliberate, reason: undefined }], /reason must be non-empty/],
  ['a scope on a non-goal', [{ ...deliberate, scope: 'complete' }], /scope may only be "complete", and only on a goal/],
  ['a quote not in the description', [{ ...goal, quote: 'All settings pages now use the new routes.' }], /quote does not occur in the pull request description/],
  ['a duplicate id', [goal, { ...deliberate, id: 'int_001' }], /int_001 is used twice/],
]) {
  test(`check-intent refuses ${name}`, () => {
    const result = checkIntent(statements);
    assert.equal(result.status, 2);
    assert.match(result.stderr, problem);
    assert.match(result.stderr, /Re-run the intent-extractor with the schema restated\. Do not hand-translate its output\./);
  });
}

test('check-intent needs the thread it validates quotes against', () => {
  const result = spawnSync(process.execPath, [bundle, 'check-intent'], { encoding: 'utf8', input: '{"statements": []}' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--thread/);
});

const candidate = {
  candidate_id: 'cand_001',
  path: 'src/menu.ts',
  line: 3,
  category: 'correctness',
  severity: 'important',
  claim: 'The settings menu still links to the old route.',
  failure_mode: 'Opening it leads to a 404.',
  evidence: ['src/menu.ts:3 links /note/list'],
  technical_confidence: 0.9,
  intent_ref: 'int_001',
};

test('intent_ref survives check-candidates into what the verifier receives', () => {
  withThread((thread) => {
    const dir = dirname(thread);
    const diff = join(dir, 'diff.patch');
    writeFileSync(diff, 'diff --git a/src/menu.ts b/src/menu.ts\n--- a/src/menu.ts\n+++ b/src/menu.ts\n@@ -1,3 +1,3 @@\n a\n b\n-c\n+c2\n');
    const result = spawnSync(process.execPath, [bundle, 'check-candidates', '--diff-file', diff, '--thread', thread, '--owner', 'owner'], {
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).kept[0].intent_ref, 'int_001');
  });
});

test('a malformed intent_ref is rejected', () => {
  const result = spawnSync(process.execPath, [bundle, 'check-candidates'], {
    encoding: 'utf8',
    input: JSON.stringify({ candidates: [{ ...candidate, intent_ref: 'goal-1' }] }),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /intent_ref must match int_NNN/);
});

test('the review, analyst and verifier carry stated intent through', () => {
  const review = read('commands/review.md');
  const analyst = read('agents/diff-analyst.md');
  const verifier = read('agents/evidence-verifier.md');
  assert.match(review, /## Step 1f - Extract stated intent/);
  assert.match(review, /RV check-intent --thread/);
  for (const prompt of [analyst, verifier]) {
    assert.match(prompt, /intent\.json/);
    assert.match(prompt, /scope: "complete"/);
    assert.match(prompt, /intent_ref/);
  }
  assert.match(read('agents/intent-extractor.md'), /\{"statements": \[\]\}/);
});
