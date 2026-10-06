import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';

// Another reviewer raised a concern about one query in a file and it was marked
// fixed; the fix covered that query only. A second-opinion candidate raised the
// same concern about another query about 15 lines away, outside the nearby-line
// window, and was kept with no link to the earlier comment.

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

const CLAIM = 'The orders query interpolates the customer filter into raw SQL';
const FAILURE = 'a crafted filter value can read other tenants rows';

function candidate(id, path, line) {
  return {
    candidate_id: id,
    path,
    line,
    category: 'security',
    severity: 'important',
    claim: CLAIM,
    failure_mode: FAILURE,
    evidence: ['Seen in the changed lines.'],
    technical_confidence: 0.9,
  };
}

function setup(candidates, thread) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-43-'));
  const patch = join(dir, 'diff.patch');
  const body = Array.from({ length: 80 }, (_, i) => `+line ${i + 1}`);
  writeFileSync(
    patch,
    ['repo.ts', 'other.ts']
      .flatMap((file) => [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,80 @@', ...body])
      .join('\n'),
  );
  const threadFile = join(dir, 'thread.json');
  writeFileSync(threadFile, JSON.stringify({ comments: thread }));
  return { dir, patch, threadFile, input: JSON.stringify({ candidates }) };
}

const EARLIER = {
  path: 'repo.ts',
  line: 20,
  author: 'acme-reviewer',
  body: `${CLAIM}; ${FAILURE}.`,
  kind: 'review-comment',
  outdated: true,
};

function check(s) {
  const r = run(['check-candidates', '--diff-file', s.patch, '--thread', s.threadFile, '--owner', 'owner-login'], s.input);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("another reviewer's same-file comment 15 lines away flags the candidate as a possible thread repeat", () => {
  const s = setup([candidate('c1', 'repo.ts', 35)], [EARLIER]);
  try {
    const out = check(s);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept.length, 1);
    assert.deepEqual(out.kept[0].possibleRepeatOf, {
      kind: 'thread',
      author: 'acme-reviewer',
      path: 'repo.ts',
      line: 20,
      outdated: true,
      excerpt: EARLIER.body,
    });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the owner's comment wins over another reviewer's when both match in the file", () => {
  const own = { ...EARLIER, author: 'owner-login', line: 70, outdated: undefined };
  const s = setup([candidate('c1', 'repo.ts', 35)], [EARLIER, own]);
  try {
    const flagged = check(s).kept[0].possibleRepeatOf;
    assert.equal(flagged.kind, 'own-comment');
    assert.equal(flagged.line, 70);
    assert.equal(flagged.outdated, undefined);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('the best wording match in the file wins, then the nearest line', () => {
  const weaker = { ...EARLIER, line: 45, body: `${CLAIM}.`, outdated: undefined };
  const s = setup([candidate('c1', 'repo.ts', 35)], [weaker, EARLIER]);
  try {
    assert.equal(check(s).kept[0].possibleRepeatOf.line, 20);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a comment in another file is not a same-file repeat', () => {
  const s = setup([candidate('c1', 'other.ts', 35)], [EARLIER]);
  try {
    assert.equal(check(s).kept[0].possibleRepeatOf, undefined);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('readThread marks an inline comment GitHub no longer places on the head as outdated', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const json =
      path === '/repos/acme/web/pulls/7'
        ? { body: '', user: { login: 'acme-author' } }
        : path === '/repos/acme/web/pulls/7/comments'
          ? [
              { path: 'repo.ts', line: null, original_line: 20, body: 'outdated one', user: { login: 'acme-reviewer' } },
              { path: 'repo.ts', line: 40, original_line: 38, body: 'current one', user: { login: 'acme-reviewer' } },
            ]
          : [];
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl });
  const { comments } = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  assert.equal(comments.length, 2);
  assert.equal(comments[0].line, 20);
  assert.equal(comments[0].outdated, true);
  assert.equal(comments[1].line, 40);
  assert.equal('outdated' in comments[1], false);
});
