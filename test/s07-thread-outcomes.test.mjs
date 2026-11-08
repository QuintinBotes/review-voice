import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { checkOutcomes, saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';

const OWNER = 'your-github-login';
const REPO = 'your-org/your-repo';
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const FINDING = { id: 101, path: 'src/billing/retry.ts', line: 5, text: 'The retry repeats the backoff calculation.' };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s07-outcomes-'));
  const path = join(dir, 'review-voice.db');
  const db = openDatabase(path);
  return Promise.resolve()
    .then(() => body(db, path))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function postedRun(db) {
  const { reviewRunId } = recordRun(db, {
    repository: REPO, baseRef: null, headRef: HEAD, pullNumber: 7, diff: 'd',
    output: `[minor] \`${FINDING.path}:${FINDING.line}\` - ${FINDING.text}`,
    candidates: [{ ...FINDING, category: 'maintainability' }],
  });
  const subject = { type: 'pull_request', id: `${REPO}#7` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 555 });
  return reviewRunId;
}

function fakeGitHub({ login = 'your-review-login', replies = [], changed = false } = {}) {
  const roots = [{
    id: FINDING.id, path: FINDING.path, line: FINDING.line, original_line: FINDING.line,
    body: `**minor** - ${FINDING.text}`, user: { login }, created_at: '2026-10-01T10:00:00Z',
  }];
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/graphql') return json({ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: FINDING.id }] } }],
    } } } } });
    if (path === '/user') return json({ login });
    if (path === `/repos/${REPO}/pulls/7`) return json({ head: { sha: changed ? NEW_HEAD : HEAD } });
    if (path === `/repos/${REPO}/pulls/7/comments`) return json([...roots, ...replies]);
    if (path === `/repos/${REPO}/pulls/7/reviews/555/comments`) return json(roots);
    if (path.includes('/compare/')) return json({ files: [{ filename: FINDING.path, patch: '@@ -5,1 +5,1 @@\n-old\n+new' }] });
    throw new Error(`Unexpected GitHub read: ${path}`);
  };
}

const reply = (login, body) => ({
  id: 201, in_reply_to_id: FINDING.id, user: { login }, body, created_at: '2026-10-02T10:00:00Z',
});

async function check(db, options = {}, ownerReviewer = OWNER) {
  const result = await checkOutcomes({
    db, client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(options), sleep: async () => {} }),
    allowlist: [REPO], since: '2000-01-01T00:00:00.000Z', ownerReviewer,
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.outcomes.length, 1);
  return result.outcomes[0];
}

test('AC-1: reply and owner feedback dismissals persist their decider, while weak outcomes clear it', () =>
  withDb(async (db) => {
    const runId = postedRun(db);
    const dismissed = await check(db, { replies: [reply('your-teammate-login', 'This is intentional.')] });
    assert.deepEqual([dismissed.outcome, dismissed.strength, dismissed.decidedBy], ['dismissed', 'strong', 'your-teammate-login']);
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, 'your-teammate-login');

    const weak = await check(db);
    assert.deepEqual([weak.outcome, weak.strength, weak.decidedBy], ['open', 'weak', null]);
    // Rechecking must erase the old decider so silence cannot retain owner evidence.
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, null);
    saveOutcome(db, { ...weak, decidedBy: OWNER });
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, null);

    assert.equal(recordFeedback(db, { findingRef: `${runId}:rv_01`, action: 'dismiss', actor: 'owner' }).ok, true);
    const feedback = await check(db);
    assert.deepEqual([feedback.outcome, feedback.strength, feedback.decidedBy], ['dismissed', 'strong', OWNER]);
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, OWNER);
    await check(db, {}, null);
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, null);
  }));

test('AC-1: the owner can reject their own posted finding, but acknowledging it changes nothing', () =>
  withDb(async (db) => {
    postedRun(db);
    const options = { login: OWNER.toUpperCase(), changed: true };
    const dismissed = await check(db, { ...options, replies: [reply(OWNER, 'This is not a bug.')] });
    assert.deepEqual([dismissed.outcome, dismissed.strength, dismissed.decidedBy], ['dismissed', 'strong', OWNER]);
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, OWNER);

    const silent = await check(db, options);
    const acknowledged = await check(db, { ...options, replies: [reply(OWNER, 'Good catch, fixed.')] });
    // Changed lines would count as a fix if the poster's acknowledgement were trusted.
    for (const field of ['outcome', 'strength', 'decidedBy', 'evidence']) {
      assert.equal(acknowledged[field], silent[field]);
    }
    assert.deepEqual([acknowledged.outcome, acknowledged.strength, acknowledged.decidedBy], ['outdated', 'weak', null]);
    assert.equal(db.prepare('SELECT decided_by FROM finding_outcomes').get().decided_by, null);
    const withoutOwner = await check(db, { ...options, replies: [reply(OWNER, 'This is not a bug.')] }, null);
    assert.equal(withoutOwner.outcome, 'outdated');
  }));

test('AC-1: migration 13 preserves old outcome rows and gives them a null decider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s07-migration-'));
  const path = join(dir, 'review-voice.db');
  try {
    const db = openDatabase(path);
    db.close();
    const old = new DatabaseSync(path);
    try {
      // Rewind only the added column so reopening exercises the real migration.
      old.exec('ALTER TABLE finding_outcomes DROP COLUMN decided_by');
      old.exec('UPDATE schema_version SET version = 12');
      old.prepare(`INSERT INTO finding_outcomes
        (review_run_id, finding_id, repository, pull_number, comment_id, outcome, strength, evidence, checked_at)
        VALUES ('old-run', 'rv_01', ?, 7, 101, 'dismissed', 'strong', 'a reply rejected it', '2026-10-02T10:00:00Z')`).run(REPO);
    } finally {
      old.close();
    }
    const migrated = openDatabase(path);
    try {
      assert.ok(migrated.prepare('SELECT version FROM schema_version').get().version >= 13);
      const row = migrated.prepare('SELECT * FROM finding_outcomes').get();
      assert.equal(row.review_run_id, 'old-run');
      assert.equal(row.outcome, 'dismissed');
      assert.equal(row.strength, 'strong');
      assert.equal(row.decided_by, null);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The owner's word outranks a teammate's: a teammate agreeing later with the
// owner's rejection must not take the owner's name off the decision.
test('a teammate agreeing after the owner rejected leaves the owner as the decider', () =>
  withDb(async (db) => {
    postedRun(db);
    const replies = [
      { id: 201, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Not a bug, the delay is recomputed on purpose.', created_at: '2026-10-02T10:00:00Z' },
      { id: 202, in_reply_to_id: FINDING.id, user: { login: 'a-teammate' }, body: 'This is intentional.', created_at: '2026-10-02T11:00:00Z' },
    ];
    const outcome = await check(db, { replies });
    assert.equal(outcome.outcome, 'dismissed');
    assert.equal(outcome.strength, 'strong');
    assert.equal(outcome.decidedBy, OWNER);
    const stored = db.prepare('SELECT decided_by FROM finding_outcomes').get();
    assert.equal(stored.decided_by, OWNER);
  }));

// The owner's latest word decides first, so the order of teammates' replies
// cannot manufacture or remove the owner's evidence.
test('an owner rejection the owner took back is not revived by a later teammate reject', () =>
  withDb(async (db) => {
    postedRun(db);
    const replies = [
      { id: 201, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Not a bug.', created_at: '2026-10-02T10:00:00Z' },
      { id: 202, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Good catch, will fix.', created_at: '2026-10-02T11:00:00Z' },
      { id: 203, in_reply_to_id: FINDING.id, user: { login: 'a-teammate' }, body: 'This is intentional.', created_at: '2026-10-02T12:00:00Z' },
    ];
    const outcome = await check(db, { replies });
    assert.equal(outcome.outcome, 'dismissed');
    assert.equal(outcome.decidedBy, 'a-teammate', 'the teammate decided it; the owner had taken the rejection back');
  }));

test('an owner rejection holds against a teammate agreeing afterwards', () =>
  withDb(async (db) => {
    postedRun(db);
    const replies = [
      { id: 201, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Not a bug.', created_at: '2026-10-02T10:00:00Z' },
      { id: 202, in_reply_to_id: FINDING.id, user: { login: 'a-teammate' }, body: 'Good catch, will fix.', created_at: '2026-10-02T11:00:00Z' },
    ];
    const outcome = await check(db, { replies });
    assert.equal(outcome.outcome, 'dismissed');
    assert.equal(outcome.strength, 'strong');
    assert.equal(outcome.decidedBy, OWNER);
  }));

// The same two orderings when the owner posted the review: the owner's own
// acknowledge is still a retraction, though it never counts as evidence of a fix.
test('an owner who posted the review can take a rejection back, and a teammate then decides', () =>
  withDb(async (db) => {
    postedRun(db);
    const replies = [
      { id: 201, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Not a bug.', created_at: '2026-10-02T10:00:00Z' },
      { id: 202, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Good catch, will fix.', created_at: '2026-10-02T11:00:00Z' },
      { id: 203, in_reply_to_id: FINDING.id, user: { login: 'a-teammate' }, body: 'This is intentional.', created_at: '2026-10-02T12:00:00Z' },
    ];
    const outcome = await check(db, { login: OWNER, replies });
    assert.equal(outcome.outcome, 'dismissed');
    assert.equal(outcome.decidedBy, 'a-teammate');
  }));

test('an owner who posted the review and only acknowledged proves no fix by it', () =>
  withDb(async (db) => {
    postedRun(db);
    const replies = [
      { id: 201, in_reply_to_id: FINDING.id, user: { login: OWNER }, body: 'Good catch, will fix.', created_at: '2026-10-02T10:00:00Z' },
    ];
    const outcome = await check(db, { login: OWNER, replies });
    assert.notEqual(outcome.outcome, 'fixed', 'the posting account agreeing with itself is not evidence');
    assert.notEqual(outcome.outcome, 'dismissed');
    assert.equal(outcome.decidedBy, null);
  }));
