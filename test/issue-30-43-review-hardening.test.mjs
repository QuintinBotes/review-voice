/**
 * Hardening of thread resolution and follow-up tracking after a review.
 *
 * - A GraphQL document that was a query could still reach another repository
 *   through a variable, `viewer`, `search`, `node` or `organization`. Only the
 *   exact known query is sent now, with only the variables it declares.
 * - Anyone resolving the follow-up's thread settled it; now only the owner's
 *   resolution counts, and anything else is left to the verifier.
 * - The owner's original comment could pass for the posted follow-up. It is
 *   now told apart by its id, by when it was written, and by wording.
 * - `record --thread` applied any thread file; it now refuses one of another
 *   pull request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient, ReadOnlyViolation, REVIEW_THREADS_QUERY } from '../plugins/review-voice/src/github/client.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('graphql sends only the known query, with only its declared variables', async () => {
  const calls = [];
  const client = new GitHubClient({
    allowlist: ['acme/web'],
    token: 'test-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json({ data: {} });
    },
  });
  const bypasses = [
    'query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }',
    'query { viewer { repositories(first: 10) { nodes { name } } } }',
    'query($q: String!) { search(query: $q, type: REPOSITORY, first: 5) { nodes { __typename } } }',
    'query($id: ID!) { node(id: $id) { id } }',
    'query($l: String!) { organization(login: $l) { id } }',
    `${REVIEW_THREADS_QUERY} `,
  ];
  for (const document of bypasses) {
    await assert.rejects(() => client.graphql('acme/web', document, {}), ReadOnlyViolation, document);
  }
  for (const variables of [{ number: 1, o: 'secret-org' }, { number: 1, owner: 'secret-org' }, { number: 1, name: 'x' }, { number: '1' }, { number: 1, cursor: 5 }]) {
    await assert.rejects(() => client.graphql('acme/web', REVIEW_THREADS_QUERY, variables), ReadOnlyViolation, JSON.stringify(variables));
  }
  assert.equal(calls.length, 0);
  // REST is still GET-only.
  await assert.rejects(() => client.get('/repos/acme/web/pulls/1', { method: 'PATCH' }), ReadOnlyViolation);
  assert.equal(calls.length, 0);
});

test('readThread records who resolved a thread, each comment id and when it was written, and names its pull request', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/graphql') {
      sent.push(JSON.parse(init.body).query);
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ isResolved: true, isOutdated: false, resolvedBy: { login: 'acme-author' }, comments: { nodes: [{ databaseId: 101 }] } }],
              },
            },
          },
        },
      });
    }
    if (path === '/repos/acme/web/pulls/7') return json({ body: '', user: { login: 'acme-author' } });
    if (path === '/repos/acme/web/pulls/7/comments') {
      return json([{ id: 101, path: 'a.ts', line: 3, original_line: 3, body: 'x', user: { login: 'owner-login' }, created_at: '2026-10-01T00:00:00Z' }]);
    }
    return json([]);
  };
  const client = new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl });
  const result = await readThread({ repository: 'acme/web', pullNumber: 7, client });
  assert.deepEqual(sent, [REVIEW_THREADS_QUERY]);
  assert.match(sent[0], /resolvedBy \{ login \}/);
  assert.equal(result.repository, 'acme/web');
  assert.equal(result.pullNumber, 7);
  const [comment] = result.comments;
  assert.equal(comment.resolved, true);
  assert.equal(comment.resolvedBy, 'acme-author');
  assert.equal(comment.id, 101);
  assert.equal(comment.createdAt, '2026-10-01T00:00:00Z');
});

function run(dir, args, input = '') {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('check-candidates passes on the linked comment id and who resolved it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hardening-'));
  try {
    const patch = join(dir, 'diff.patch');
    writeFileSync(patch, ['diff --git a/repo.ts b/repo.ts', '--- /dev/null', '+++ b/repo.ts', '@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`)].join('\n'));
    const claim = 'The orders query interpolates the customer filter into raw SQL';
    const failure = 'a crafted filter value can read other tenants rows';
    const thread = writeJson(dir, 'thread.json', {
      comments: [{ id: 55, path: 'repo.ts', line: 10, author: 'acme-reviewer', body: `${claim}; ${failure}.`, kind: 'review-comment', resolved: true, resolvedBy: 'acme-author' }],
    });
    const candidate = { candidate_id: 'c1', path: 'repo.ts', line: 30, category: 'security', severity: 'important', claim, failure_mode: failure, evidence: ['Seen.'], technical_confidence: 0.9 };
    const r = run(dir, ['check-candidates', '--diff-file', patch, '--thread', thread, '--owner', 'owner-login'], JSON.stringify({ candidates: [candidate] }));
    assert.equal(r.code, 0, r.stderr);
    const link = JSON.parse(r.stdout).kept[0].possibleRepeatOf;
    assert.equal(link.commentId, 55);
    assert.equal(link.resolvedBy, 'acme-author');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const OWNER = 'owner-login';
const REPO = 'acme/web';
const PR = 9;
const PATH = 'docs/rules.md';
const REMAINING = ['the retired queue name', 'the old timeout setting'];
const PROSE = '2 of 4 stale points remain: the retired queue name and the old timeout setting. Readers follow stale guidance.';
const ORIGINAL_ID = 501;

function withFollowUp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hardening-follow-up-'));
  try {
    const candidates = writeJson(dir, 'scored.json', {
      candidates: [{
        path: PATH, line: 12, category: 'documentation',
        possibleRepeatOf: {
          kind: 'own-comment', status: 'partly-addressed', author: OWNER, path: PATH, line: 12, commentId: ORIGINAL_ID,
          remaining: REMAINING, addressed: ['the deploy step', 'the owner list'],
        },
      }],
    });
    const first = run(dir, ['record', '--repository', REPO, '--head', 'a'.repeat(40), '--candidates', candidates, '--files', writeJson(dir, 'f1.json', { pullNumber: PR })], `[nit] \`${PATH}:12\` - ${PROSE}\n`);
    assert.equal(first.code, 0, first.stderr);
    const { reviewRunId, findings } = JSON.parse(first.stdout);
    assert.equal(findings[0].partlyAddressed.prior.commentId, ORIGINAL_ID);
    return fn({ dir, runId: reviewRunId });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function laterWithThread(s, comments, thread = { repository: REPO, pullNumber: PR }) {
  const manifest = writeJson(s.dir, 'f2.json', { pullNumber: PR });
  const file = writeJson(s.dir, 'thread.json', { ...thread, comments });
  return run(s.dir, ['record', '--repository', REPO, '--head', 'c'.repeat(40), '--files', manifest, '--thread', file], 'No actionable findings.\n');
}

const AFTER = () => new Date(Date.now() + 60_000).toISOString();
const posted = (extra) => ({
  id: 777, path: PATH, line: 12, author: OWNER, body: `**nit** - ${PROSE}`, kind: 'review-comment',
  createdAt: AFTER(), resolved: true, resolvedBy: OWNER, ...extra,
});

const status = (r) => {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).followUps[0].status;
};

test('only the owner resolving the thread settles a follow-up', () =>
  withFollowUp((s) => {
    assert.equal(status(laterWithThread(s, [posted({ resolvedBy: 'acme-author' })])), 'open');
    assert.equal(status(laterWithThread(s, [posted({ resolvedBy: undefined })])), 'open');
    assert.equal(status(laterWithThread(s, [posted({})])), 'resolved');
  }));

test("the original comment is never taken for the posted follow-up: not by id, not when written earlier, not by line alone", () =>
  withFollowUp((s) => {
    // Same id as the original the follow-up was linked to.
    assert.equal(status(laterWithThread(s, [posted({ id: ORIGINAL_ID })])), 'open');
    // Written before the follow-up's run was recorded.
    assert.equal(status(laterWithThread(s, [posted({ createdAt: '2020-01-01T00:00:00Z' })])), 'open');
    // No time to tell.
    assert.equal(status(laterWithThread(s, [posted({ createdAt: undefined })])), 'open');
    // Same line and form, saying something else.
    assert.equal(status(laterWithThread(s, [posted({ body: '**nit** - The heading level skips from two to four.' })])), 'open');
  }));

test('record refuses a thread file of another pull request, or one that does not say', () =>
  withFollowUp((s) => {
    for (const thread of [{ repository: 'acme/other', pullNumber: PR }, { repository: REPO, pullNumber: PR + 1 }, {}]) {
      const r = laterWithThread(s, [posted({})], thread);
      assert.equal(r.code, 2, JSON.stringify(thread));
      assert.match(r.stderr, /not the thread of this run's pull request/);
    }
    const list = JSON.parse(run(s.dir, ['follow-ups', '--pr', String(PR), '--repository', REPO]).stdout).followUps;
    assert.equal(list.length, 1);
  }));
