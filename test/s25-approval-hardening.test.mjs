/**
 * S25 (docs/adr/0034): the approval check never settles on less evidence than
 * its outcome claims. A weak row is final only after a check made once its
 * window ended; an older check never overwrites a newer one; a purge is not
 * undone by a check still in flight; and a review list cut at the read limit
 * cannot prove that no one asked for changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { checkApprovals, saveApprovalOutcome, storedApprovalOutcomes } from '../plugins/review-voice/src/store/approvals.ts';

const REPO = 'acme/web';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const EPOCH = '2000-01-01T00:00:00.000Z';
const LATER = '2999-01-01T00:00:00.000Z';
const MERGED_AT = '2026-10-01T12:00:00Z';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const approval = (number) => ({ id: 500 + number, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-09-30T10:00:00Z', user: { login: 'review-bot-user' } });

/** A fake GitHub: `pulls` by number, `reviews` per pull, and the revert search's hits. */
function github({ pulls = {}, reviews = {}, reverts = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (parsed.pathname === '/search/issues') {
      return json({ total_count: reverts.length, incomplete_results: false, items: reverts.map((number) => ({ number, repository_url: `https://api.github.com/repos/${REPO}`, pull_request: {} })) });
    }
    const pull = /^\/repos\/acme\/web\/pulls\/(\d+)(\/reviews|\/commits)?$/.exec(parsed.pathname);
    if (pull === null) return new Response('not found', { status: 404 });
    const number = Number(pull[1]);
    if (pull[2] === '/reviews') return json(reviews[number] ?? [approval(number)]);
    if (pull[2] === '/commits') return json([{ sha: HEAD }, { sha: OTHER_HEAD }]);
    return pulls[number] === undefined ? new Response('not found', { status: 404 }) : json(pulls[number]);
  };
  return { calls, client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} }) };
}

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-approval-hardening-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sentRun(db, number) {
  const { reviewRunId } = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: number, diff: 'd', output: 'No actionable findings.' });
  const subject = { type: 'pull_request', id: `${REPO}#${number}` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, event: 'APPROVE', reviewId: 500 + number });
  return reviewRunId;
}

const outcomeOf = (db, runId) => storedApprovalOutcomes(db).find((row) => row.reviewRunId === runId);

test('a weak row checked before its window ended is checked again after it, so a revert in between counts', async () => {
  await withDb(async (db) => {
    const runId = sentRun(db, 14);
    const pulls = {
      14: { state: 'closed', merged: true, merged_at: MERGED_AT, head: { sha: OTHER_HEAD } },
      72: { state: 'closed', merged: true, merged_at: '2026-10-12T00:00:00Z', body: 'Reverts acme/web#14', head: { sha: 'e'.repeat(40) } },
    };
    // Checked on day 9 of 14: merged at another head, no revert yet.
    const before = github({ pulls });
    await checkApprovals({ db, client: before.client, since: EPOCH, now: () => new Date('2026-10-10T12:00:00Z') });
    assert.equal(outcomeOf(db, runId).outcome, 'merged_other_head');
    // The revert merged on day 11; the next pass runs after the window, with a since past this approval.
    const after = github({ pulls, reverts: [72] });
    const result = await checkApprovals({ db, client: after.client, since: LATER, now: () => new Date('2026-10-20T12:00:00Z') });
    assert.ok(after.calls.length > 0, 'the row was taken as settled because the clock passed its window');
    assert.equal(outcomeOf(db, runId).outcome, 'reverted', JSON.stringify(result));
  });
});

test('a weak row checked after its window ended is settled and not read again', async () => {
  await withDb(async (db) => {
    sentRun(db, 15);
    const pulls = { 15: { state: 'closed', merged: true, merged_at: MERGED_AT, head: { sha: OTHER_HEAD } } };
    await checkApprovals({ db, client: github({ pulls }).client, since: EPOCH, now: () => new Date('2026-10-20T12:00:00Z') });
    const again = github({ pulls });
    await checkApprovals({ db, client: again.client, since: LATER, now: () => new Date('2026-10-25T12:00:00Z') });
    assert.deepEqual(again.calls, []);
  });
});

test('an older check finishing last does not overwrite a newer one', async () => {
  await withDb(async (db) => {
    const runId = sentRun(db, 16);
    const base = { reviewRunId: runId, repository: REPO, pullNumber: 16, head: HEAD, reviewId: 516 };
    saveApprovalOutcome(db, { ...base, outcome: 'reverted', strength: 'strong', evidence: { summary: 'newer' }, checkedAt: '2026-10-20T12:00:00.000Z' });
    saveApprovalOutcome(db, { ...base, outcome: 'survived', strength: 'strong', evidence: { summary: 'older' }, checkedAt: '2026-10-19T12:00:00.000Z' });
    assert.equal(outcomeOf(db, runId).outcome, 'reverted');
    saveApprovalOutcome(db, { ...base, outcome: 'survived', strength: 'strong', evidence: { summary: 'newest' }, checkedAt: '2026-10-21T12:00:00.000Z' });
    assert.equal(outcomeOf(db, runId).outcome, 'survived');
  });
});

test('a check that finishes after its run was purged writes nothing back', async () => {
  await withDb(async (db) => {
    const runId = sentRun(db, 17);
    db.prepare('DELETE FROM review_runs').run();
    saveApprovalOutcome(db, { reviewRunId: runId, repository: REPO, pullNumber: 17, head: HEAD, reviewId: 517, outcome: 'survived', strength: 'strong', evidence: { summary: 'late' }, checkedAt: '2026-10-20T12:00:00.000Z' });
    assert.deepEqual(storedApprovalOutcomes(db), []);
  });
});

test('a review list cut at the read limit settles nothing unless it shows an escape', async () => {
  await withDb(async (db) => {
    const runId = sentRun(db, 18);
    const filler = Array.from({ length: 1000 }, (_, index) => ({ id: 2000 + index, state: 'COMMENTED', commit_id: HEAD, submitted_at: '2026-09-30T11:00:00Z', user: { login: `person${index}` } }));
    const pulls = { 18: { state: 'closed', merged: true, merged_at: MERGED_AT, head: { sha: HEAD } } };
    // A request for changes past the first thousand reviews is never read.
    const reviews = { 18: [approval(18), ...filler, { id: 9000, state: 'CHANGES_REQUESTED', commit_id: HEAD, submitted_at: '2026-09-30T12:00:00Z', user: { login: 'carol' } }] };
    const result = await checkApprovals({ db, client: github({ pulls, reviews }).client, since: EPOCH, now: () => new Date('2026-10-20T12:00:00Z') });
    assert.equal(outcomeOf(db, runId), undefined, 'a truncated list was stored as proof of survival');
    assert.ok(result.warnings.some((warning) => /read limit/.test(warning)), result.warnings.join('\n'));
  });
});
