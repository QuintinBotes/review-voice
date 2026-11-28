/**
 * A defect a human reviewer raised after Review Voice's review was never
 * counted as a miss (#550). `outcomes` now follows each listed reviewer's
 * inline comment made after a run, on the head it reviewed and a file it read,
 * classes it against the run, and gives it the same outcome rules as a posted
 * finding; `evaluate` reports the strong fixes the run did not post. GitHub is
 * stubbed with the live payload shapes: the pull request's comment list has
 * `line`, `original_line` and `original_commit_id`, the list per review only
 * `position` (#531).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { checkOutcomes } from '../plugins/review-voice/src/store/outcomes.ts';
import { computeMetrics, evaluationReport } from '../plugins/review-voice/src/evaluate/metrics.ts';

const REPO = 'acme/web';
const PR = 7;
const OLD_HEAD = 'c'.repeat(40);
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const SINCE = '2026-11-01T00:00:00.000Z';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const later = () => new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** An inline comment as `/pulls/{n}/comments` returns it. */
const comment = (id, login, path, line, extra = {}) => ({
  id,
  path,
  line,
  original_line: line,
  start_line: null,
  original_start_line: null,
  commit_id: NEW_HEAD,
  original_commit_id: HEAD,
  body: 'This drops the error.',
  created_at: later(),
  user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
  pull_request_review_id: 1000 + id,
  ...extra,
});

function fakeGitHub() {
  // Review Voice's own comment, posted under the owner's credential (docs/adr/0002).
  const own = comment(301, 'owner', 'src/z.ts', 1, { body: '**minor** - Posted from here.', pull_request_review_id: 900 });
  const all = [
    own,
    comment(501, 'teammate', 'src/a.ts', 21), // at the run's held candidate; resolved and changed
    comment(502, 'teammate', 'src/b.ts', 5), // nothing there; the author agreed and changed it
    comment(503, 'teammate', 'src/b.ts', 40), // nothing there; unchanged and open
    comment(504, 'a-stranger', 'src/b.ts', 5), // not a listed reviewer
    comment(505, 'dependabot[bot]', 'src/b.ts', 5), // a bot
    comment(506, 'teammate', 'src/skip.ts', 5), // a file the run left out
    comment(507, 'teammate', 'src/b.ts', 5, { original_commit_id: OLD_HEAD }), // another head
    comment(508, 'teammate', 'src/b.ts', 5, { created_at: '2000-01-01T00:00:00Z' }), // before the run
    { id: 601, in_reply_to_id: 502, path: 'src/b.ts', line: 5, original_line: 5, original_commit_id: HEAD, body: 'Good catch, fixed in the next commit.', created_at: later(), user: { login: 'author' }, pull_request_review_id: 1601 },
  ];
  const resolved = new Set([301, 501, 504, 506, 507, 508]);
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ method: init.method ?? 'GET', path });
    if (path === '/graphql') {
      const nodes = all.filter((c) => c.in_reply_to_id == null).map((c) => ({ isResolved: resolved.has(c.id), isOutdated: false, comments: { nodes: [{ databaseId: c.id }] } }));
      return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: NEW_HEAD } });
    if (path === `/repos/${REPO}/pulls/${PR}/comments`) return json(all);
    // The list per review is the older shape: `position`, and neither `line` nor `original_line` (#531).
    if (path === `/repos/${REPO}/pulls/${PR}/reviews/900/comments`) {
      const { line, original_line, ...rest } = own;
      return json([{ ...rest, position: 3 }]);
    }
    if (path.includes('/compare/')) {
      const touch = (filename, at) => ({ filename, patch: `@@ -${at - 2},5 +${at - 2},5 @@\n x\n x\n-old\n+new\n x\n x` });
      // Every commented line changed after the review except src/b.ts:40.
      return json({ files: [{ filename: 'src/z.ts', patch: '@@ -1,2 +1,2 @@\n-old\n+new\n x' }, touch('src/a.ts', 21), touch('src/b.ts', 5), touch('src/skip.ts', 5)] });
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-550-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

/** A run at HEAD that posted one finding as review 900, held a security candidate at src/a.ts:20, and left src/skip.ts out. */
function recordReviewedRun(db) {
  const { reviewRunId } = recordRun(db, {
    repository: REPO,
    baseRef: null,
    headRef: HEAD,
    pullNumber: PR,
    diff: 'd',
    output: '[minor] `src/z.ts:1` - Posted from here.',
    held: [{ path: 'src/a.ts', line: 20, verdict: 'below-gate', source: 'score', reason: 'below the confidence floor', candidateId: 'c1' }],
    scores: [{ candidateId: 'c1', lane: 'security', path: 'src/a.ts', line: 20, eligible: false, gate: 'confidence' }],
    leftOut: ['src/skip.ts'],
  });
  const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 900 });
  return reviewRunId;
}

const check = (db, impl, extra = {}) => checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: SINCE, ownerReviewer: 'owner', ...extra });

test('#550: a listed reviewer\'s later comment on lines the run read is classed, and a strong fix the run did not post is a miss', async () => {
  await withDb(async (db) => {
    const runId = recordReviewedRun(db);
    const impl = fakeGitHub();
    const result = await check(db, impl, { reviewers: ['owner', 'teammate'] });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.outcomes.map((o) => [o.commentId, o.outcome, o.strength]),
      [[301, 'fixed', 'strong']],
      "the run's own comment is still a posted finding",
    );
    const got = Object.fromEntries(result.reviewerFindings.map((r) => [r.commentId, [r.reviewRunId, r.class, r.stage, r.lane, r.outcome, r.strength]]));
    assert.deepEqual(got, {
      501: [runId, 'held', 'below-gate', 'security', 'fixed', 'strong'],
      502: [runId, 'never_raised', null, null, 'fixed', 'strong'],
      503: [runId, 'never_raised', null, null, 'open', 'weak'],
    }, "the run's own comment, a stranger, a bot, a file left out, another head and an earlier comment are not followed");
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviewer_findings').get().n, 3);
    assert.ok(impl.calls.every((call) => call.method === 'GET' || call.path === '/graphql'), 'nothing is written to GitHub');

    const metrics = Object.fromEntries(computeMetrics(db).map((m) => [m.name, m]));
    assert.equal(metrics.reviewer_findings_missed.value, 2);
    assert.match(metrics.reviewer_findings_missed.basis, /2 fixed reviewer comment\(s\) not posted \(1 held, 1 never_raised\) of 3 followed/);
    assert.equal(metrics.online_recall.value, 1 / 3);
    assert.match(metrics.online_recall.basis, /1 posted and fixed \/ \(1 \+ 2 fixed reviewer comment\(s\) not posted\)/);
    assert.equal(metrics.online_recall.kind, 'goal', 'reported, never gated');
    assert.deepEqual(evaluationReport(db, []).missed_breakdown, { by_class: { held: 1, never_raised: 1 }, by_lane: { security: 1 } });

    // A second check replaces the rows rather than adding to them.
    await check(db, fakeGitHub(), { reviewers: ['owner', 'teammate'] });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviewer_findings').get().n, 3);
  });
});

test('#550: with no reviewers listed nothing is followed, and evaluate says no data', async () => {
  await withDb(async (db) => {
    recordReviewedRun(db);
    const result = await check(db, fakeGitHub());
    assert.deepEqual(result.reviewerFindings, []);
    const metrics = Object.fromEntries(computeMetrics(db).map((m) => [m.name, m]));
    assert.equal(metrics.reviewer_findings_missed.value, null);
    assert.equal(metrics.online_recall.value, null, 'a posted fix alone is not a recall of 1');
  });
});

test('#550: a read-only check stores no reviewer finding', async () => {
  await withDb(async (db) => {
    recordReviewedRun(db);
    const result = await check(db, fakeGitHub(), { reviewers: ['teammate'], store: false });
    assert.equal(result.reviewerFindings.length, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviewer_findings').get().n, 0);
  });
});
