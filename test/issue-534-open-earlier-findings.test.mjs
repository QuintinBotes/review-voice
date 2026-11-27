/**
 * #534: on review-voice-scratch#1 the Action requested changes with two
 * important findings, then a push that touched none of their lines was
 * reviewed as an interdiff and mapped to APPROVE, which on GitHub would
 * replace the tool's own request for changes. A narrower re-review now
 * follows the earlier findings through the outcome rules: one still open on
 * unchanged lines holds the approval at COMMENT. GitHub is stubbed with the
 * live payloads of that pull request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { recoverPostedReviews } from '../plugins/review-voice/src/store/recover.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { decide } from '../plugins/review-voice/src/publish/verdict.ts';

const REPO = 'QuintinBotes/review-voice-scratch';
const PR = 1;
const BOT = 'github-actions[bot]';
const OWNER = 'QuintinBotes';
const REVIEWED = '84420f2a2c3cbc68f2ff5367edba7a4257698bd7';
const HEAD = '8f50952a608bca1e5a555a99f3325f540333ee44';
const REVIEW_ID = 6091799079;

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// The four inline comments of the Action's review, as GET /pulls/1/comments listed them.
const root = (id, path, line, body) => ({
  id,
  in_reply_to_id: null,
  path,
  line,
  original_line: line,
  start_line: null,
  side: 'RIGHT',
  body,
  user: { login: BOT },
  pull_request_review_id: REVIEW_ID,
  commit_id: HEAD,
  original_commit_id: REVIEWED,
  created_at: '2026-11-27T17:56:47Z',
});
const COMMENTS = [
  root(4722389479, 'src/cart.js', 20, '**important** - applyCoupon compares the ISO string coupon.expires with the number Date.now(), so the string becomes NaN and the comparison is false. Expired coupons still get the discount. Use Date.parse(coupon.expires) < Date.now().'),
  root(4722389487, 'src/cart.js', 27, '**important** - removeItem does not check for findIndex returning -1, so splice(-1, 1) removes the last item when the id is not found. Removing an unknown id silently deletes the last cart item. Return items unchanged if index < 0.'),
  root(4722389494, 'src/cart.js', 34, '**minor** - averageUnitPrice divides by units, which is 0 for an empty cart. The result is NaN (0/0) instead of 0 or an error, which can reach displayed prices.'),
  root(4722389500, 'test/cart.test.js', 16, '**nit** - The new tests cover only happy paths: no expired coupon, missing id in removeItem, or empty cart in averageUnitPrice. Regressions in those edge cases are not caught, so the bugs above stay green.'),
];
// The owner's two replies, as posted on the pull request.
const REPLIES = [
  { id: 4722428870, in_reply_to_id: 4722389479, path: 'src/cart.js', line: null, original_line: 20, body: 'Good catch, fixed: it now parses the date first.', user: { login: OWNER }, pull_request_review_id: 6091848339, created_at: '2026-11-27T18:02:22Z' },
  { id: 4722429081, in_reply_to_id: 4722389487, path: 'src/cart.js', line: 27, original_line: 27, body: "Won't fix: removeItem is only called with ids taken from the cart, so the id is always present.", user: { login: OWNER }, pull_request_review_id: 6091848564, created_at: '2026-11-27T18:02:23Z' },
];
// The commits since the review touched only ci-mode.txt; the fix later touched line 20.
const ONLY_CI_MODE = [{ filename: 'ci-mode.txt', patch: '@@ -1 +1 @@\n-green\n+pending' }];
const FIXED_LINE_20 = [
  ...ONLY_CI_MODE,
  { filename: 'src/cart.js', patch: '@@ -20 +20 @@\n-  if (coupon.expires < Date.now()) return cents;\n+  if (Date.parse(coupon.expires) < Date.now()) return cents;' },
];

function fakeGitHub({ replies = [], resolved = [], compare = ONLY_CI_MODE } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === '/graphql') {
      const nodes = COMMENTS.map((c) => ({ isResolved: resolved.includes(c.id), isOutdated: false, comments: { nodes: [{ databaseId: c.id }] } }));
      return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (path === `/repos/${REPO}/pulls`) return json([{ number: PR, updated_at: '2026-11-27T18:00:00Z' }]);
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
    if (path === `/repos/${REPO}/pulls/${PR}/reviews`) {
      return json([{ id: REVIEW_ID, state: 'CHANGES_REQUESTED', commit_id: REVIEWED, user: { login: BOT }, submitted_at: '2026-11-27T17:56:47Z' }]);
    }
    // The per-review list has `position` and no line numbers (#531).
    if (path === `/repos/${REPO}/pulls/${PR}/reviews/${REVIEW_ID}/comments`) return json(COMMENTS.map(({ line, original_line, ...rest }) => ({ ...rest, position: 3 })));
    if (path === `/repos/${REPO}/pulls/${PR}/comments`) return json([...COMMENTS, ...replies]);
    if (path.includes('/compare/')) return json({ files: compare });
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-11-27T18:00:00Z' }] });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (path === '/user') return new Response('{"message":"Resource not accessible by integration"}', { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-534-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = 'No actionable findings.';

/** The Action's review recorded as the earlier run, and the re-review of `kind` at HEAD that found nothing. */
async function reReview(db, impl, kind) {
  const recovered = await recoverPostedReviews({ db, client: client(impl), allowlist: [REPO], since: '2026-11-01T00:00:00.000Z' });
  assert.equal(recovered.recovered.length, 1);
  const priorRunId = recovered.recovered[0].runId;
  const scopes = {
    full: { kind: 'full', cause: 'requested', since: null, priorRunId: null },
    interdiff: { kind: 'interdiff', since: REVIEWED, priorRunId, priorReviewedAt: null, mergeBase: REVIEWED, files: ['ci-mode.txt'], hunks: 1 },
    incremental: { kind: 'incremental', since: REVIEWED, priorRunId, priorReviewedAt: null, commits: 1, files: ['ci-mode.txt'] },
  };
  const scope = scopes[kind];
  const current = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: CLEAN, scope });
  assert.equal(runDetail(db, current.reviewRunId).scope?.kind, kind, 'the scope is stored as given');
  return computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review: CLEAN, owner: OWNER });
}

test('#534: an interdiff that found nothing does not approve over the two important findings still open', async () => {
  await withDb(async (db) => {
    const impl = fakeGitHub();
    const { output } = await reReview(db, impl, 'interdiff');
    assert.ok(impl.calls.includes('/graphql'), JSON.stringify(impl.calls));
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.action, 'post');
    assert.ok(
      output.reasons.includes('an earlier review posted 2 findings that still stand (src/cart.js:20, src/cart.js:27), so this comments rather than approves'),
      JSON.stringify(output.reasons),
    );
    assert.equal(output.payload.body, 'Not approving yet.');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get().n, 0, 'the verdict reads outcomes without storing them');
  });
});

test('#534: once one is fixed and the other turned down by the owner, the same re-review approves', async () => {
  await withDb(async (db) => {
    const impl = fakeGitHub({ replies: REPLIES, resolved: [4722389500], compare: FIXED_LINE_20 });
    const { output } = await reReview(db, impl, 'incremental');
    assert.equal(output.event, 'APPROVE', JSON.stringify(output.reasons));
    // The earlier findings were followed, not skipped: their threads and the compare were read.
    assert.ok(impl.calls.includes('/graphql'), JSON.stringify(impl.calls));
    assert.ok(impl.calls.some((path) => path.includes(`/compare/${REVIEWED}...${HEAD}`)));
  });
});

test('#534: a full review reads every line itself, so it does not look the earlier findings up', async () => {
  await withDb(async (db) => {
    const impl = fakeGitHub();
    const { output } = await reReview(db, impl, 'full');
    assert.equal(output.event, 'APPROVE');
    assert.equal(impl.calls.filter((path) => path.includes('/compare/')).length, 0);
  });
});

test('#534: a re-check of such an approval is refused', () => {
  const decision = decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: true, openEarlier: ['src/cart.js:20'] });
  assert.deepEqual([decision.event, decision.action, decision.exitCode], ['COMMENT', 'refuse', 2]);
});
