import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args, input, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// The finding says the retry is unsafe; the description says it is safe. The
// two share nearly every significant word, which is the case lexical matching
// cannot tell apart from a restatement.
const CLAIM = 'The retry wrapper replays payment capture after a timeout, which is unsafe.';
const FAILURE = 'A slow gateway response charges the customer twice for one order.';

// A summary first, long enough that the first 200 characters say nothing about
// the retry, then the sentence the finding contradicts.
const SUMMARY =
  'This change moves the checkout client onto the shared HTTP module, renames a handful of ' +
  'configuration keys to match the other services, and removes the old logging adapter that ' +
  'nothing has called since the last migration.';
const STATED = 'The retry wrapper replays payment capture after a timeout, which is safe because a slow gateway response never charges the customer twice for one order.';
const DESCRIPTION = `${SUMMARY}\n\n${STATED}\n\nNo schema changes.`;

function candidate(id, path, line) {
  return {
    candidate_id: id,
    path,
    line,
    category: 'correctness',
    severity: 'important',
    claim: CLAIM,
    failure_mode: FAILURE,
    evidence: ['The retry wrapper is added on the changed lines.'],
    technical_confidence: 0.95,
  };
}

function setup(candidates, thread) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-description-overlap-'));
  const patch = join(dir, 'diff.patch');
  const body = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
  writeFileSync(
    patch,
    ['a.ts', 'b.ts']
      .flatMap((file) => [`diff --git a/${file} b/${file}`, `--- /dev/null`, `+++ b/${file}`, '@@ -0,0 +1,40 @@', ...body])
      .join('\n'),
  );
  const threadFile = join(dir, 'thread.json');
  writeFileSync(threadFile, JSON.stringify({ comments: thread }));
  return { dir, patch, threadFile, input: JSON.stringify({ candidates }) };
}

const description = { path: null, line: null, author: 'acme-author', body: DESCRIPTION, kind: 'description' };

function checkCandidates(s) {
  const r = run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input, s.dir);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a candidate overlapping the description is kept and flagged for the verifier', () => {
  const s = setup([candidate('c1', 'a.ts', 10)], [description]);
  try {
    const out = checkCandidates(s);
    assert.equal(out.candidates, 1);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept[0].candidate_id, 'c1');
    const flag = out.kept[0].possibleRepeatOf;
    assert.equal(flag.kind, 'description');
    assert.equal(flag.author, 'acme-author');
    assert.equal(flag.path, null);
    assert.equal(flag.line, null);
    // The verifier gets the sentence the finding contradicts, not the summary
    // that happens to open the description.
    assert.ok(flag.excerpt.includes(STATED), flag.excerpt);
    assert.ok(!flag.excerpt.includes('logging adapter'), flag.excerpt);
    assert.ok(flag.excerpt.length <= 400);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a description excerpt stays within its budget when one sentence is very long', () => {
  const long = `${STATED.slice(0, -1)} ${'and further qualifications about the gateway '.repeat(20)}.`;
  const s = setup([candidate('c1', 'a.ts', 10)], [{ ...description, body: `${SUMMARY} ${long}` }]);
  try {
    const excerpt = checkCandidates(s).kept[0].possibleRepeatOf.excerpt;
    assert.ok(excerpt.length <= 400, String(excerpt.length));
    assert.ok(excerpt.startsWith('The retry wrapper replays payment capture'), excerpt);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a nearby anchored comment takes precedence over a description match', () => {
  // Some shared words within five lines: enough to flag, not to drop.
  const nearby = { path: 'a.ts', line: 13, author: 'acme-bot', body: 'retry wrapper replays capture here', kind: 'review-comment' };
  const s = setup([candidate('c1', 'a.ts', 10)], [description, nearby]);
  try {
    const out = checkCandidates(s);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.deepEqual(out.kept[0].possibleRepeatOf, {
      kind: 'thread',
      author: 'acme-bot',
      path: 'a.ts',
      line: 13,
      excerpt: 'retry wrapper replays capture here',
    });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a candidate repeating an anchored review comment is still dropped', () => {
  const comment = { path: 'a.ts', line: 11, author: 'acme-bot', body: `${CLAIM} ${FAILURE}`, kind: 'review-comment' };
  const s = setup([candidate('c1', 'a.ts', 10)], [description, comment]);
  try {
    const out = checkCandidates(s);
    assert.deepEqual(out.kept, []);
    assert.equal(out.droppedAsRepeat.length, 1);
    assert.equal(out.droppedAsRepeat[0].author, 'acme-bot');
    assert.equal(out.droppedAsRepeat[0].commentPath, 'a.ts');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a candidate repeating an unanchored review body is still dropped', () => {
  const reviewBody = { path: null, line: null, author: 'acme-reviewer', body: `${CLAIM} ${FAILURE}`, kind: 'review-body' };
  const s = setup([candidate('c1', 'a.ts', 10)], [reviewBody]);
  try {
    const out = checkCandidates(s);
    assert.deepEqual(out.kept, []);
    assert.equal(out.droppedAsRepeat[0].author, 'acme-reviewer');
    assert.equal(out.droppedAsRepeat[0].commentPath, null);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('score does not reject a description overlap as already said, but still rejects a review-body repeat', () => {
  const s = setup([candidate('c1', 'a.ts', 10)], [description]);
  // A low score gate, so the only thing that can reject this candidate is the
  // check under test.
  const score = ['score', '--diff-file', s.patch, '--thread', s.threadFile, '--min-score', '0.1'];
  try {
    const scored = run(score, s.input, s.dir);
    assert.equal(scored.code, 0, scored.stderr);
    const entry = JSON.parse(scored.stdout).scores[0];
    assert.equal(entry.eligible, true, entry.rejectedBecause);
    assert.doesNotMatch(entry.rejectedBecause ?? '', /already said/);

    // The same candidate against a review body making the same point is still
    // rejected, which shows the echo check ran on an eligible candidate above.
    writeFileSync(
      s.threadFile,
      JSON.stringify({ comments: [{ path: null, line: null, author: 'acme-reviewer', body: `${CLAIM} ${FAILURE}`, kind: 'review-body' }] }),
    );
    const echoed = run(score, s.input, s.dir);
    assert.equal(echoed.code, 0, echoed.stderr);
    assert.match(JSON.parse(echoed.stdout).scores[0].rejectedBecause, /already said on this pull request by acme-reviewer/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('the analyst and verifier prompts carry the stated-intent rule', () => {
  const analyst = readFileSync(join(root, 'plugins/review-voice/agents/diff-analyst.md'), 'utf8');
  const verifier = readFileSync(join(root, 'plugins/review-voice/agents/evidence-verifier.md'), 'utf8');
  for (const prompt of [analyst, verifier]) {
    assert.match(prompt, /\*\*Stated intent\.\*\*/);
    assert.match(prompt, /the intent itself is wrong/);
  }
  assert.match(verifier, /`kind: description`/);
  assert.match(verifier, /only when the description already states the same defect or risk/);
});
