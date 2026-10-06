/**
 * A high-complexity verdict tells the agent what the review would have posted
 * without the cap, and finds the owner's earlier request for changes that a
 * COMMENT leaves blocking (docs/adr/0012, amended 2026-10-06). Both are for the
 * agent and the user only: nothing reaches the posted review, and nothing is
 * dismissed - every request to GitHub is a GET.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const HEAD = 'c'.repeat(40);
const REPO = 'acme/shop';
const PR = 12;
const OWNER = 'owner-login';

const changed = (path) => ({ path, status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true });
const HIGH = assessComplexity('', [changed('src/auth/login.ts')]);
const NORMAL = assessComplexity('', [changed('src/plain.ts')]);

const CLEAN = 'No actionable findings.';
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const IMPORTANT = '[important] `src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';

const verified = (path, line, severity) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const review = (id, login, state, at) => ({
  id,
  user: { login },
  state,
  submitted_at: at,
  html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-${id}`,
});

function fakeGitHub(reviews = [], { reviewsStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/reviews')) {
      return reviewsStatus === 200 ? json(reviews) : new Response('boom', { status: reviewsStatus });
    }
    if (parsed.pathname.endsWith('/check-runs')) {
      return json({
        total_count: 1,
        check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }],
      });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-44-'));
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

function record(db, output, extra = {}) {
  return recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, ...extra });
}

const verdict = (db, impl, text, owner = OWNER) =>
  computeVerdict({
    db,
    client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} }),
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review: text,
    owner,
  });

const REQUESTED = [
  review(101, OWNER, 'CHANGES_REQUESTED', '2026-10-01T09:00:00Z'),
  review(102, 'someone-else', 'APPROVED', '2026-10-01T10:00:00Z'),
  // A later COMMENT does not replace the request for changes.
  review(103, OWNER, 'COMMENTED', '2026-10-02T09:00:00Z'),
];

test('a capped approval says what it would have been, outside the posted body', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const { output } = await verdict(db, fakeGitHub(), CLEAN);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.wouldHaveEvent, 'APPROVE');
    assert.equal(output.wouldHaveSummary, 'Would have approved: no problems found.');
    assert.equal(output.payload.body, 'No problems found.');
    assert.ok(!output.preview.includes('Would have'));
  });
  await withDb(async (db) => {
    record(db, NIT, { complexity: HIGH, scores: [verified('src/cart.ts', 40, 'nit')] });
    const { output } = await verdict(db, fakeGitHub(), NIT);
    assert.equal(output.wouldHaveSummary, 'Would have approved, with 1 nit.');
    assert.equal(output.payload.body, '1 nit.');
  });
});

test('the would-have verdict also names a comment or a request for changes, and is null on a normal change', async () => {
  await withDb(async (db) => {
    record(db, IMPORTANT, { complexity: HIGH, scores: [verified('src/pay.ts', 8, 'important')] });
    const { output } = await verdict(db, fakeGitHub(), IMPORTANT);
    assert.equal(output.wouldHaveEvent, 'REQUEST_CHANGES');
    assert.equal(output.wouldHaveSummary, 'Would have requested changes: 1 comment, the highest important.');
  });
  await withDb(async (db) => {
    record(db, MINOR, { complexity: HIGH, scores: [verified('src/cart.ts', 12, 'minor')] });
    const { output } = await verdict(db, fakeGitHub(), MINOR);
    assert.equal(output.wouldHaveEvent, 'COMMENT');
    assert.equal(output.wouldHaveSummary, 'Would have commented: 1 comment, the highest minor.');
  });
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: NORMAL });
    const impl = fakeGitHub(REQUESTED);
    const { output } = await verdict(db, impl, CLEAN);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.wouldHaveEvent, null);
    assert.equal(output.wouldHaveSummary, null);
    assert.equal(output.staleRequestChanges, null);
    assert.ok(!impl.calls.some((call) => call.path.endsWith('/reviews')), 'a normal change does not look');
  });
});

test("the owner's standing request for changes is reported, read with GETs only", async () => {
  await withDb(async (db) => {
    record(db, NIT, { complexity: HIGH, scores: [verified('src/cart.ts', 40, 'nit')] });
    const impl = fakeGitHub(REQUESTED);
    const { output } = await verdict(db, impl, NIT);
    assert.deepEqual(output.staleRequestChanges, {
      reviewId: 101,
      submittedAt: '2026-10-01T09:00:00Z',
      url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-101`,
    });
    assert.ok(output.reasons.some((reason) => /REQUEST_CHANGES \(review 101\).*dismiss it by hand/.test(reason)));
    assert.ok(!output.payload.body.includes('REQUEST_CHANGES'));
    assert.ok(impl.calls.every((call) => call.method === 'GET'));
  });
});

test('nothing is reported when the request was answered, is not the owner\'s, or the review still blocks', async () => {
  const cases = [
    [...REQUESTED, review(104, OWNER, 'APPROVED', '2026-10-03T09:00:00Z')],
    [review(101, OWNER, 'DISMISSED', '2026-10-01T09:00:00Z')],
    [review(101, 'someone-else', 'CHANGES_REQUESTED', '2026-10-01T09:00:00Z')],
    [],
  ];
  for (const reviews of cases) {
    await withDb(async (db) => {
      record(db, CLEAN, { complexity: HIGH });
      const { output } = await verdict(db, fakeGitHub(reviews), CLEAN);
      assert.equal(output.staleRequestChanges, null);
    });
  }
  await withDb(async (db) => {
    record(db, IMPORTANT, { complexity: HIGH, scores: [verified('src/pay.ts', 8, 'important')] });
    const impl = fakeGitHub(REQUESTED);
    const { output } = await verdict(db, impl, IMPORTANT);
    assert.equal(output.staleRequestChanges, null);
    assert.ok(!impl.calls.some((call) => call.path.endsWith('/reviews')));
  });
  await withDb(async (db) => {
    // An unverified important finding is held, and still might block.
    record(db, IMPORTANT, { complexity: HIGH });
    const { output } = await verdict(db, fakeGitHub(REQUESTED), IMPORTANT);
    assert.equal(output.staleRequestChanges, null);
  });
});

test('an unknown owner or an unreadable review list skips the check with a reason', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const impl = fakeGitHub(REQUESTED);
    const { output } = await verdict(db, impl, CLEAN, null);
    assert.equal(output.staleRequestChanges, null);
    assert.ok(output.reasons.some((reason) => /identity\.owner_reviewer is not set/.test(reason)));
    assert.ok(!impl.calls.some((call) => call.path.endsWith('/reviews')));
  });
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: HIGH });
    const { exitCode, output } = await verdict(db, fakeGitHub(REQUESTED, { reviewsStatus: 403 }), CLEAN);
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.staleRequestChanges, null);
    assert.ok(output.reasons.some((reason) => /could not read the pull request's reviews/.test(reason)));
  });
});
