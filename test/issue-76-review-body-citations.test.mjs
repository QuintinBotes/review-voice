/**
 * #76: a point another reviewer made in a review body, cited by `path:line`,
 * was only compared on wording at the unanchored bar, so `check-candidates`
 * kept a repeat of it and only the verifier caught it. A cited location now
 * counts as a comment at that line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { citedLocations } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const FILE = 'path/to/File.tsx';
// Eight significant words, so overlap fractions are easy to read. A comment
// holding CLAIM alone shares half of them: under the 0.7 a review body needs
// on wording alone, over the 0.4 an anchored comment needs.
const CLAIM = 'alpha bravo charlie delta';
const FAILURE = 'echo foxtrot golf hotel';

function candidate(id, path, line) {
  return {
    candidate_id: id,
    path,
    line,
    category: 'correctness',
    severity: 'important',
    claim: CLAIM,
    failure_mode: FAILURE,
    evidence: ['Seen in the changed lines.'],
    technical_confidence: 0.95,
  };
}

function check(candidates, comments, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-76-'));
  try {
    const body = Array.from({ length: 200 }, (_, i) => `+line ${i + 1}`);
    const files = [FILE, 'other/Other.tsx'];
    writeFileSync(
      join(dir, 'diff.patch'),
      files.flatMap((file) => [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,200 @@', ...body]).join('\n'),
    );
    writeFileSync(join(dir, 'thread.json'), JSON.stringify({ repository: 'o/r', pullNumber: 1, comments }));
    mkdirSync(join(dir, 'data'));
    const stdout = execFileSync(
      process.execPath,
      [bundle, 'check-candidates', '--diff-file', join(dir, 'diff.patch'), '--thread', join(dir, 'thread.json'), ...extra],
      { encoding: 'utf8', input: JSON.stringify({ candidates }), cwd: dir, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } },
    );
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const reviewBody = (body, author = 'other-reviewer') => ({ path: null, line: null, author, body, kind: 'review-body' });

test('a repeat of a point a review body cites two lines away is dropped up front', () => {
  const out = check(
    [candidate('c1', FILE, 107)],
    [reviewBody(`Findings:\n- P3 ${FILE}:105 - ${CLAIM}\n- P2 other/Other.tsx:12 - unrelated naming nit`)],
  );
  assert.deepEqual(out.droppedAsRepeat.map((d) => [d.candidateId, d.author, d.commentPath, d.commentLine]), [
    ['c1', 'other-reviewer', FILE, 105],
  ]);
  assert.equal(out.kept.length, 0);
});

test('only the text of the cited item counts, not the rest of the body', () => {
  // The matching words sit under the other citation, so the item at line 105
  // does not repeat the candidate.
  const out = check(
    [candidate('c1', FILE, 107)],
    [reviewBody(`- ${FILE}:105 - unrelated naming nit\n- other/Other.tsx:12 - ${CLAIM}`)],
  );
  assert.deepEqual(out.droppedAsRepeat, []);
});

test('a citation by file name alone matches the file, a backticked one too', () => {
  const out = check([candidate('c1', FILE, 107)], [reviewBody(`\`File.tsx:106\`: ${CLAIM}`)]);
  assert.deepEqual(out.droppedAsRepeat.map((d) => d.candidateId), ['c1']);
});

test('a citation far from the candidate is not a repeat', () => {
  const out = check([candidate('c1', FILE, 150)], [reviewBody(`${FILE}:105 - ${CLAIM}`)]);
  assert.deepEqual(out.droppedAsRepeat, []);
});

test("a reply in the conversation that cites the location counts the same way", () => {
  const out = check(
    [candidate('c1', FILE, 104)],
    [{ path: null, line: null, author: 'the-author', body: `Re ${FILE}:105: ${CLAIM}, will follow up.`, kind: 'conversation' }],
  );
  assert.deepEqual(out.droppedAsRepeat.map((d) => d.author), ['the-author']);
});

test("the owner's own review body citation is flagged, not dropped, like the owner's inline comment", () => {
  const out = check(
    [candidate('c1', FILE, 107)],
    [reviewBody(`${FILE}:105 - ${CLAIM}`, 'the-owner')],
    ['--owner', 'the-owner'],
  );
  assert.deepEqual(out.droppedAsRepeat, []);
  assert.equal(out.kept[0].possibleRepeatOf.kind, 'own-comment');
  assert.equal(out.kept[0].possibleRepeatOf.line, 105);
});

test('citedLocations leaves the description, inline comments and times alone', () => {
  const thread = [
    { path: null, line: null, author: 'a', body: `Changes ${FILE}:105`, kind: 'description' },
    { path: FILE, line: 3, author: 'b', body: `see ${FILE}:105`, kind: 'review-comment' },
    { path: null, line: null, author: 'c', body: 'Standup at 10:30, see https://example.com:8080/x', kind: 'conversation' },
  ];
  assert.equal(citedLocations(thread).length, thread.length);
});
