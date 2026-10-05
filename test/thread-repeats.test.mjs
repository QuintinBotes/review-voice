import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';

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

// Eight significant words (longer than three characters) in the wording below,
// so overlap fractions are easy to set exactly.
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

function setup(candidates, thread) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-thread-repeats-'));
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

const anchored = (path, line, body) => ({ path, line, author: 'acme-bot', body, kind: 'review-comment' });

test('an anchored repeat within 2 lines is dropped with its author and location', () => {
  const s = setup([candidate('c1', 'a.ts', 10)], [anchored('a.ts', 12, `${CLAIM} ${FAILURE}`)]);
  try {
    const r = run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.candidates, 0);
    assert.deepEqual(out.kept, []);
    assert.equal(out.droppedAsRepeat.length, 1);
    assert.equal(out.droppedAsRepeat[0].candidateId, 'c1');
    assert.equal(out.droppedAsRepeat[0].author, 'acme-bot');
    assert.equal(out.droppedAsRepeat[0].commentPath, 'a.ts');
    assert.equal(out.droppedAsRepeat[0].commentLine, 12);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('the same wording on a different file is kept', () => {
  const s = setup([candidate('c1', 'b.ts', 10)], [anchored('a.ts', 10, `${CLAIM} ${FAILURE}`)]);
  try {
    const out = JSON.parse(run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input).stdout);
    assert.equal(out.kept.length, 1);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
    // Without --thread the output is the previous shape, byte for byte.
    const plain = JSON.parse(run(['check-candidates', '--diff-file', s.patch], s.input).stdout);
    assert.deepEqual(plain, { valid: true, candidates: 1, anchors: { checked: 1 } });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('an unanchored review body at the unanchored threshold drops the candidate', () => {
  const body = { path: null, line: null, author: 'acme-reviewer', body: `${CLAIM} echo foxtrot golf`, kind: 'review-body' };
  const s = setup([candidate('c1', 'a.ts', 10)], [body]);
  try {
    const out = JSON.parse(run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input).stdout);
    assert.equal(out.kept.length, 0);
    assert.equal(out.droppedAsRepeat[0].author, 'acme-reviewer');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a lower-overlap comment within 5 lines flags a possible repeat and keeps the candidate', () => {
  // 3 of 8 words: below the 0.4 drop threshold, above the 0.25 flag threshold.
  const s = setup([candidate('c1', 'a.ts', 10)], [anchored('a.ts', 15, 'alpha bravo charlie unrelated words')]);
  try {
    const out = JSON.parse(run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input).stdout);
    assert.equal(out.candidates, 1);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept[0].candidate_id, 'c1');
    assert.deepEqual(out.kept[0].possibleRepeatOf, {
      author: 'acme-bot',
      path: 'a.ts',
      line: 15,
      excerpt: 'alpha bravo charlie unrelated words',
    });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a missing or malformed thread file exits 2', () => {
  const s = setup([candidate('c1', 'a.ts', 10)], []);
  try {
    const missing = run(['check-candidates', '--diff-file', s.patch, '--thread', join(s.dir, 'nope.json')], s.input);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /nope\.json/);
    writeFileSync(s.threadFile, '{not json');
    const bad = run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /thread\.json/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('readThread returns the pull request body as a description, and a restating candidate is sent to the verifier', async () => {
  const description = `${CLAIM} ${FAILURE}`;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const json =
      path === '/repos/acme/web/pulls/7'
        ? { body: description, user: { login: 'acme-author' } }
        : [];
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl });
  const { comments } = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].kind, 'description');
  assert.equal(comments[0].author, 'acme-author');
  assert.equal(comments[0].path, null);

  const s = setup([candidate('c1', 'a.ts', 10)], comments);
  try {
    const out = JSON.parse(run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], s.input).stdout);
    assert.equal(out.kept.length, 1);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept[0].possibleRepeatOf.kind, 'description');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
