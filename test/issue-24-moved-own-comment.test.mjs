import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The owner's comment sat at line 1312 of a test file; the author inserted a
// test above it and GitHub then reported it at 1436. The same point came back
// on another line of the file, far outside the nearby-line window.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args, input) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const CLAIM = 'The new retry test never covers the timeout branch';
const FAILURE = 'a regression in timeout handling would pass unnoticed';

function candidate(id, path, line) {
  return {
    candidate_id: id,
    path,
    line,
    category: 'testing',
    severity: 'minor',
    claim: CLAIM,
    failure_mode: FAILURE,
    evidence: ['Seen in the changed lines.'],
    technical_confidence: 0.9,
  };
}

function setup(candidates, thread) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-24-'));
  const patch = join(dir, 'diff.patch');
  const body = Array.from({ length: 1500 }, (_, i) => `+line ${i + 1}`);
  writeFileSync(
    patch,
    ['client.test.ts', 'other.test.ts']
      .flatMap((file) => [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,1500 @@', ...body])
      .join('\n'),
  );
  const threadFile = join(dir, 'thread.json');
  writeFileSync(threadFile, JSON.stringify({ comments: thread }));
  return { dir, patch, threadFile, input: JSON.stringify({ candidates }) };
}

const comment = (author, path, line, body) => ({ path, line, author, body, kind: 'review-comment' });
const OWN = comment('owner-login', 'client.test.ts', 1436, `${CLAIM}; ${FAILURE}.`);

function check(s, extra = ['--owner', 'owner-login']) {
  const r = run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile, ...extra], s.input);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a candidate repeating the owner's moved comment elsewhere in the file is kept as a possible own-comment repeat", () => {
  const s = setup([candidate('c1', 'client.test.ts', 1290)], [OWN]);
  try {
    const out = check(s);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept.length, 1);
    assert.deepEqual(out.kept[0].possibleRepeatOf, {
      kind: 'own-comment',
      author: 'owner-login',
      path: 'client.test.ts',
      line: 1436,
      excerpt: OWN.body,
    });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('the owner login compares without case', () => {
  const s = setup([candidate('c1', 'client.test.ts', 1290)], [OWN]);
  try {
    assert.equal(check(s, ['--owner', 'Owner-Login']).kept[0].possibleRepeatOf.kind, 'own-comment');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the owner's comment in another file, or with unrelated wording, is not a match", () => {
  const unrelated = comment('owner-login', 'client.test.ts', 1436, 'Rename this helper to match the module.');
  const s = setup([candidate('c1', 'other.test.ts', 1290), candidate('c2', 'client.test.ts', 100)], [
    { ...OWN, path: 'elsewhere.test.ts' },
    unrelated,
  ]);
  try {
    const out = check(s);
    assert.equal(out.kept.length, 2);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
    assert.equal(out.kept[1].possibleRepeatOf, undefined);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a nearby comment by the owner is marked own-comment too', () => {
  // Three of the candidate's words: below the drop bar, above the flag bar.
  const near = comment('owner-login', 'client.test.ts', 1293, 'retry test timeout');
  const s = setup([candidate('c1', 'client.test.ts', 1290)], [near]);
  try {
    const flagged = check(s).kept[0].possibleRepeatOf;
    assert.equal(flagged.kind, 'own-comment');
    assert.equal(flagged.line, 1293);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('without a known owner, no comment is marked as the owner\'s', () => {
  const s = setup([candidate('c1', 'client.test.ts', 1290)], [OWN]);
  try {
    // Run outside any repository so no configured owner is found.
    const r = (() => {
      try {
        const stdout = execFileSync(
          process.execPath,
          [bundle, 'check-candidates', '--diff-file', s.patch, '--thread', s.threadFile],
          { encoding: 'utf8', input: s.input, cwd: s.dir },
        );
        return { code: 0, stdout };
      } catch (error) {
        return { code: error.status, stdout: error.stdout ?? '' };
      }
    })();
    assert.equal(r.code, 0);
    assert.notEqual(JSON.parse(r.stdout).kept[0].possibleRepeatOf?.kind, 'own-comment');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
