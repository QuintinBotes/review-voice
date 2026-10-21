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
const { normaliseCandidate } = await import('../plugins/review-voice/src/scoring/score.ts');

const description =
  '## Routes renamed\nRenames the notes routes.\n\nAll menus now link to the new /notes routes.\n' +
  'Archived notes are still excluded   from search. Archive indexing ships in a later change.\n' +
  'QA: the note_opened click event stays as it is.\n\n' +
  'We do not remove the legacy endpoint everywhere; only the docs link changes.\n\n' +
  '- Settings keep the old\n  layout for now';

function withThread(fn, body = description) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-intent-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(
      thread,
      JSON.stringify({ repository: 'example/notes', pullNumber: 7, comments: body === null ? [] : [{ path: null, line: null, author: 'author', body, kind: 'description' }], reviews: [] }),
    );
    return fn(thread);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const checkIntent = (statements, body = description) =>
  withThread(
    (thread) => spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) }),
    body,
  );

const goal = { id: 'int_001', kind: 'goal', statement: 'Every menu uses the new routes.', quote: 'All menus now link to the new /notes routes.', scope: 'complete' };
const deliberate = {
  id: 'int_002',
  kind: 'deliberate',
  statement: 'Archived notes stay out of search.',
  quote: 'Archived notes are still excluded from search.',
  reason: 'Archive indexing ships in a later change.',
};
const qa = { id: 'int_003', kind: 'qa', statement: 'The click event is unchanged.', quote: 'QA: the note_opened click event stays as it is.' };

test('check-intent accepts quoted statements and normalises them', () => {
  const listItem = { id: 'int_004', kind: 'claim', statement: 'Settings keep the old layout.', quote: '- Settings keep the old layout for now' };
  const result = checkIntent([goal, deliberate, qa, listItem]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.statements.length, 4);
  assert.equal(out.statements[0].scope, 'complete');
  assert.equal(out.statements[1].reason, 'Archive indexing ships in a later change.');
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
  ['more than 40 statements', Array.from({ length: 41 }, (_, i) => ({ ...goal, id: `int_${String(i + 1).padStart(3, '0')}` })), /at most 40 entries/],
  ['a statement over 300 characters', [{ ...goal, statement: 'x'.repeat(301) }], /statement must be at most 300 characters/],
  ['an unexpected field', [{ ...goal, confidence: 0.9 }], /unexpected "confidence" field/],
  ['an unexpected top-level field', null, /unexpected "notes" field/],
  ['a quote under four words', [{ ...goal, quote: 'Routes renamed', statement: 'Routes are renamed.' }], /quote must be at least 4 words/],
  ['a quote without a word of its statement', [{ ...goal, statement: 'Search excludes archived items.' }], /shares no significant word with its statement/],
  ['a reason not in the description', [{ ...deliberate, reason: 'Archive indexing is too slow today.' }], /reason does not occur in the pull request description/],
  ['a free-text reason that is part of a sentence', [{ ...deliberate, reason: 'Archive indexing ships in a later' }], /reason must be a whole sentence or list item/],
  [
    'a quote that drops the leading negation',
    [{ id: 'int_005', kind: 'claim', statement: 'The legacy endpoint is removed everywhere.', quote: 'remove the legacy endpoint everywhere' }],
    /quote must be a whole sentence or list item/,
  ],
  ['whitespace-only text', [{ ...goal, statement: '   ' }], /statement must be non-empty text/],
]) {
  test(`check-intent refuses ${name}`, () => {
    const result =
      statements === null
        ? withThread((thread) =>
            spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements: [], notes: 'x' }) }),
          )
        : checkIntent(statements);
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

test('check-intent refuses a mid-sentence quote even when wrapped across lines', () => {
  const wrapped = 'We do not\nremove the legacy endpoint everywhere.';
  const result = checkIntent([{ id: 'int_001', kind: 'claim', statement: 'The legacy endpoint is removed.', quote: 'remove the legacy endpoint everywhere.' }], wrapped);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /whole sentence or list item/);
});

test('check-intent fails closed when the thread has no description', () => {
  for (const body of [null, '   ']) {
    const result = checkIntent([], body);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /No pull request description to validate intent against/);
  }
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

test('normaliseCandidate keeps intent_ref as intentRef, and leaves it off when absent', () => {
  assert.equal(normaliseCandidate(candidate, 0).intentRef, 'int_001');
  assert.equal(normaliseCandidate({ ...candidate, intent_ref: undefined, intentRef: 'int_002' }, 0).intentRef, 'int_002');
  assert.equal('intentRef' in normaliseCandidate({ ...candidate, intent_ref: undefined }, 0), false);
});

test('check-candidates --intent fails only the candidate whose intent_ref names no statement', () => {
  withThread((thread) => {
    const dir = dirname(thread);
    const intent = join(dir, 'intent.json');
    writeFileSync(intent, JSON.stringify({ statements: [goal] }));
    const plain = { ...candidate, candidate_id: 'cand_002', intent_ref: undefined };
    const run = (candidates, extra = []) =>
      spawnSync(process.execPath, [bundle, 'check-candidates', '--intent', intent, ...extra], { encoding: 'utf8', input: JSON.stringify({ candidates }) });

    assert.equal(run([candidate, plain]).status, 0);

    const dangling = run([{ ...candidate, intent_ref: 'int_009' }, plain]);
    assert.equal(dangling.status, 1);
    const out = JSON.parse(dangling.stdout);
    assert.deepEqual(out.intentFailures.map((failure) => [failure.candidateId, failure.intentRef]), [['cand_001', 'int_009']]);
    assert.match(out.intentFailures[0].reason, /names no statement/);

    const diff = join(dir, 'diff.patch');
    writeFileSync(diff, 'diff --git a/src/menu.ts b/src/menu.ts\n--- a/src/menu.ts\n+++ b/src/menu.ts\n@@ -1,3 +1,3 @@\n a\n b\n-c\n+c2\n');
    const withDiff = run([{ ...candidate, intent_ref: 'int_009' }], ['--diff-file', diff]);
    assert.equal(withDiff.status, 1);
    assert.equal(JSON.parse(withDiff.stdout).intentFailures.length, 1);
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
