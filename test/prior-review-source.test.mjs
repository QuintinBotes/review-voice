/**
 * The previous head of a follow-up review, and where it came from.
 *
 * Only a run recorded on this machine used to count, so a review recorded from
 * another clone or profile was invisible and every follow-up read the whole
 * pull request again; and which run was picked was never shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestOwnReview, resolvePrior, resolveSince } from '../plugins/review-voice/src/diff/prior.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, recordedRunsForPull, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { parseReviewScope, describeScope } from '../plugins/review-voice/src/diff/incremental.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDir(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const recorded = [
  { runId: 'run_new', head: 'b'.repeat(40), createdAt: '2026-09-30T12:00:00.000Z' },
  { runId: 'run_old', head: 'a'.repeat(40), createdAt: '2026-09-29T12:00:00.000Z' },
];
const neverAsked = async () => {
  throw new Error('the GitHub source should not be consulted');
};

test('--since beats a recorded run, and the recorded runs are still listed', async () => {
  const { prior, resolution } = await resolvePrior({ since: 'c'.repeat(40), recorded, ownReview: neverAsked });
  assert.deepEqual(prior, { reviewRunId: null, headRef: 'c'.repeat(40), createdAt: null });
  assert.equal(resolution.source, 'flag');
  assert.deepEqual(resolution.recordedRuns.map((run) => run.runId), ['run_new', 'run_old']);
});

test('the newest recorded run is used when there is no --since', async () => {
  const { prior, resolution } = await resolvePrior({ since: null, recorded, ownReview: neverAsked });
  assert.equal(prior.headRef, 'b'.repeat(40));
  assert.equal(prior.reviewRunId, 'run_new');
  assert.equal(resolution.source, 'recorded');
});

test('with nothing recorded, the reviewer’s own latest GitHub review supplies the head', async () => {
  const { prior, resolution } = await resolvePrior({
    since: null,
    recorded: [],
    ownReview: async () => ({ head: 'd'.repeat(40), submittedAt: '2026-09-28T08:00:00Z' }),
  });
  assert.deepEqual(prior, { reviewRunId: null, headRef: 'd'.repeat(40), createdAt: '2026-09-28T08:00:00Z' });
  assert.equal(resolution.source, 'github-review');

  const none = await resolvePrior({ since: null, recorded: [], ownReview: async () => null });
  assert.equal(none.prior, null);
  assert.equal(none.resolution.source, null);
});

function fakeClient(routes) {
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new GitHubClient({ allowlist: ['acme/web'], token: 'test-token', fetchImpl, sleep: async () => {} });
}

test('the own-review source takes the viewer’s latest submitted review with a commit', async () => {
  const client = fakeClient({
    '/user': { login: 'Reviewer' },
    '/repos/acme/web/pulls/7/reviews': [
      { user: { login: 'reviewer' }, body: 'Two points.', commit_id: '1'.repeat(40), state: 'COMMENTED', submitted_at: '2026-09-20T10:00:00Z' },
      // A bare reply in a thread: a body-less review stamped with a later head.
      { user: { login: 'reviewer' }, body: '', commit_id: '5'.repeat(40), state: 'COMMENTED', submitted_at: '2026-09-26T10:00:00Z' },
      { user: { login: 'someone-else' }, commit_id: '2'.repeat(40), state: 'APPROVED', submitted_at: '2026-09-27T10:00:00Z' },
      { user: { login: 'reviewer' }, commit_id: '3'.repeat(40), state: 'CHANGES_REQUESTED', submitted_at: '2026-09-25T10:00:00Z' },
      { user: { login: 'reviewer' }, commit_id: '4'.repeat(40), state: 'PENDING', submitted_at: null },
    ],
  });
  assert.deepEqual(await latestOwnReview(client, 'acme/web', 7), { head: '3'.repeat(40), submittedAt: '2026-09-25T10:00:00Z' });
});

test('a failing GitHub read is no answer, never an error', async () => {
  const client = fakeClient({});
  assert.equal(await latestOwnReview(client, 'acme/web', 7), null);
});

test('--since resolves only to a commit this clone can read', () => {
  withDir('rv-since-', (dir) => {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'one');
    const head = git('rev-parse', 'HEAD').trim();
    assert.equal(resolveSince(head.slice(0, 10), 'acme/web', dir), head);
    // Absent, and no origin pointing at the reviewed repository to fetch from.
    assert.equal(resolveSince('e'.repeat(40), 'acme/web', dir), null);
    assert.equal(resolveSince('not-a-commit', 'acme/web', dir), null);
  });
});

test('diff --pr refuses an unresolvable --since before reading anything', () => {
  withDir('rv-since-cli-', (dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    let failure;
    try {
      execFileSync(process.execPath, [bundle, 'diff', '--pr', '7', '--repository', 'acme/web', '--since', 'e'.repeat(40)], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir, GITHUB_TOKEN: 'test-token' },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'expected a refusal');
    assert.equal(failure.status, 2);
    assert.match(failure.stderr, /--since e{40} is not a commit in this clone/);
  });
});

test('recorded runs of one pull request are listed newest first', () => {
  withDir('rv-runs-', (dir) => {
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      for (const [head, pullNumber] of [['a'.repeat(40), 7], ['b'.repeat(40), 7], ['c'.repeat(40), 8]]) {
        recordRun(db, { repository: 'acme/web', baseRef: null, headRef: head, pullNumber, diff: head, output: 'No actionable findings.' });
      }
      const runs = recordedRunsForPull(db, 'ACME/web', 7);
      assert.deepEqual(runs.map((run) => run.head), ['b'.repeat(40), 'a'.repeat(40)]);
    } finally {
      db.close();
    }
  });
});

test('every scope the planner produces survives the store and reads back', () => {
  const scopes = [
    { kind: 'unchanged', since: 'a'.repeat(40), priorRunId: null, priorReviewedAt: null, mergeBase: 'e'.repeat(40), reason: 'base-merged' },
    { kind: 'interdiff', since: 'a'.repeat(40), priorRunId: 'run_001', priorReviewedAt: '2026-09-30T12:00:00.000Z', mergeBase: 'e'.repeat(40), files: ['src/b.ts'], hunks: 2 },
    { kind: 'incremental', since: 'a'.repeat(40), priorRunId: null, priorReviewedAt: null, commits: 1, files: ['src/a.ts'] },
  ];
  withDir('rv-scope-store-', (dir) => {
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      for (const scope of scopes) {
        const { reviewRunId } = recordRun(db, { repository: 'acme/web', baseRef: null, headRef: 'f'.repeat(40), pullNumber: 7, scope, diff: JSON.stringify(scope), output: 'No actionable findings.' });
        assert.deepEqual(runDetail(db, reviewRunId).scope, scope);
      }
    } finally {
      db.close();
    }
  });
  assert.equal(parseReviewScope({ kind: 'unchanged', since: 'a', priorRunId: null, priorReviewedAt: null, mergeBase: 'e', reason: 'made-up' }), null);
  assert.equal(describeScope(scopes[0]), `unchanged since aaaaaaa (base-merged)`);
  assert.equal(describeScope(scopes[1]), 'interdiff since aaaaaaa (2 hunks in 1 file)');
});
