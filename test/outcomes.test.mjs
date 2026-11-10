/**
 * What became of the comments Review Voice posted (docs/adr/0029): each
 * outcome class, the owner's feedback, the review-id fallback, the allowlist,
 * a repeated check, and the metrics `evaluate` derives. GitHub is stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { checkOutcomes, classifyReply, saveOutcome, patchTouches, postedBreakdown, replyWanted } from '../plugins/review-voice/src/store/outcomes.ts';
import { computeMetrics } from '../plugins/review-voice/src/evaluate/metrics.ts';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const REPO = 'acme/web';
const PR = 7;
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const SINCE = '2000-01-01T00:00:00.000Z';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const patchAt = (line) => `@@ -${line - 2},5 +${line - 2},5 @@\n x\n x\n-old\n+new\n x\n x`;

const FINDINGS = [
  { id: 101, sev: 'important', path: 'src/fixed.ts', line: 10, text: 'The retry charges twice on a timeout.' },
  { id: 102, sev: 'minor', path: 'src/dismissed.ts', line: 20, text: 'The total skips the discount for carts.' },
  { id: 103, sev: 'minor', path: 'src/resolved.ts', line: 30, text: 'The cache key ignores the locale setting.' },
  { id: 104, sev: 'nit', path: 'src/outdated.ts', line: 40, text: 'This helper shadows the imported formatter.' },
  { id: 105, sev: 'minor', path: 'src/open.ts', line: 50, text: 'The parser accepts an empty identifier.' },
  { id: 106, sev: 'minor', path: 'src/unknown.ts', line: 60, text: 'The loop reads past the final element.' },
  { id: 107, sev: 'important', path: 'src/ack.ts', line: 70, text: 'The token is returned before the commit.' },
];
const OUTPUT = FINDINGS.map((f) => `[${f.sev}] \`${f.path}:${f.line}\` - ${f.text}`).join('\n\n');

/** A stub of the reads `outcomes` makes. `calls` records every request. */
function fakeGitHub(options = {}) {
  const {
    currentHead = NEW_HEAD,
    resolved = [101, 103],
    outdated = [],
    unlisted = [106],
    replies = [
      { id: 202, in_reply_to_id: 102, user: { login: 'author' }, body: 'This is intentional, the discount is applied later.', created_at: '2026-10-02T10:00:00Z' },
      { id: 207, in_reply_to_id: 107, user: { login: 'author' }, body: 'Good catch, done.', created_at: '2026-10-02T10:00:00Z' },
    ],
    files = [
      { filename: 'src/fixed.ts', patch: patchAt(10) },
      { filename: 'src/outdated.ts', patch: patchAt(40) },
      { filename: 'src/unknown.ts' },
      { filename: 'src/ack.ts', patch: patchAt(70) },
    ],
    reviews = [],
    graphqlFails = false,
    login = 'review-bot-user',
  } = options;
  const calls = [];
  const roots = FINDINGS.map((f) => ({
    id: f.id,
    path: f.path,
    line: f.line,
    original_line: f.line,
    body: `**${f.sev}** - ${f.text}`,
    user: { login },
    created_at: '2026-10-01T10:00:00Z',
  }));
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname });
    const path = parsed.pathname;
    if (path === '/graphql') {
      if (graphqlFails) return new Response('boom', { status: 502 });
      const nodes = FINDINGS.filter((f) => !unlisted.includes(f.id)).map((f) => ({
        isResolved: resolved.includes(f.id),
        isOutdated: outdated.includes(f.id),
        comments: { nodes: [{ databaseId: f.id }] },
      }));
      return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (path === '/user') return json({ login });
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: currentHead } });
    if (path === `/repos/${REPO}/pulls/${PR}/comments`) return json([...roots, ...replies]);
    if (path === `/repos/${REPO}/pulls/${PR}/reviews`) return json(reviews);
    if (/\/pulls\/\d+\/reviews\/\d+\/comments$/.test(path)) return json(roots);
    if (path.includes('/compare/')) return json({ files });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl, allowlist = [REPO]) => new GitHubClient({ allowlist, token: 't', fetchImpl: impl, sleep: async () => {} });

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-outcomes-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

/** Records a run of the seven findings, and a sent review for it. */
function postedRun(db, { repository = REPO, reviewId = 555 } = {}) {
  const { reviewRunId } = recordRun(db, { repository, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: OUTPUT });
  const subject = { type: 'pull_request', id: `${repository.toLowerCase()}#${PR}` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, ...(reviewId === null ? {} : { reviewId }) });
  return reviewRunId;
}

const check = (db, impl, extra = {}) =>
  checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: SINCE, ...extra });
const byFinding = (result) => Object.fromEntries(result.outcomes.map((o) => [o.findingId, o]));

test('reply stance and patch arithmetic', () => {
  assert.equal(classifyReply('Good catch, fixed in the next commit'), 'acknowledge');
  assert.equal(classifyReply('This is intentional'), 'reject');
  assert.equal(classifyReply('Thanks, but that is by design'), 'reject');
  assert.equal(classifyReply('not fixed yet'), 'other');
  assert.equal(classifyReply('what do you mean here?'), 'other');
  assert.equal(patchTouches(patchAt(10), 10, 10), true);
  assert.equal(patchTouches(patchAt(10), 20, 22), false);
  // An insertion beside the anchor leaves the anchored lines as they were.
  assert.equal(patchTouches('@@ -10,1 +10,2 @@\n x\n+added', 10, 10), false);
});

test('every outcome class is told apart, with strength', async () => {
  await withDb(async (db) => {
    postedRun(db);
    const result = await check(db, fakeGitHub({ outdated: [104] }));
    const got = byFinding(result);
    const expected = {
      rv_01: ['fixed', 'strong'],
      rv_02: ['dismissed', 'strong'],
      rv_03: ['resolved', 'weak'],
      rv_04: ['outdated', 'weak'],
      rv_05: ['open', 'weak'],
      rv_06: ['unknown', 'weak'],
      rv_07: ['fixed', 'strong'],
    };
    for (const [id, [outcome, strength]] of Object.entries(expected)) {
      assert.deepEqual([got[id]?.outcome, got[id]?.strength], [outcome, strength], `${id}: ${got[id]?.evidence}`);
    }
    assert.equal(got.rv_01.reviewIdSource, 'audit');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get().n, 7);
    assert.equal(result.warnings.length, 0);
  });
});

test('an unread thread state is unknown, never open', async () => {
  await withDb(async (db) => {
    postedRun(db);
    const result = await check(db, fakeGitHub({ graphqlFails: true }));
    const got = byFinding(result);
    assert.equal(got.rv_05.outcome, 'unknown');
    assert.equal(got.rv_02.outcome, 'dismissed');
    assert.ok(result.warnings.some((w) => w.includes('resolved')));
  });
});

test('silence is never a dismissal', async () => {
  await withDb(async (db) => {
    postedRun(db);
    const result = await check(db, fakeGitHub({ replies: [], files: [] }));
    assert.equal(result.outcomes.filter((o) => o.outcome === 'dismissed').length, 0);
  });
});

test('the owner recording dismiss wins; keep leaves the outcome alone', async () => {
  await withDb(async (db) => {
    const runId = postedRun(db);
    recordFeedback(db, { findingRef: `${runId}:rv_05`, action: 'dismiss', actor: 'owner' });
    recordFeedback(db, { findingRef: `${runId}:rv_03`, action: 'keep', actor: 'owner' });
    recordFeedback(db, { findingRef: `${runId}:rv_01`, action: 'dismiss', actor: 'owner' });
    const got = byFinding(await check(db, fakeGitHub()));
    assert.deepEqual([got.rv_05.outcome, got.rv_05.strength], ['dismissed', 'strong']);
    assert.match(got.rv_05.evidence, /owner/);
    // Dismiss beats a fix on the page.
    assert.equal(got.rv_01.outcome, 'dismissed');
    assert.equal(got.rv_03.outcome, 'resolved');
  });
});

test('without a review id in the audit log the review is found by head and author', async () => {
  await withDb(async (db) => {
    postedRun(db, { reviewId: null });
    const impl = fakeGitHub({
      reviews: [
        { id: 900, commit_id: HEAD, user: { login: 'review-bot-user' } },
        { id: 901, commit_id: HEAD, user: { login: 'someone-else' } },
        { id: 902, commit_id: NEW_HEAD, user: { login: 'review-bot-user' } },
      ],
    });
    const result = await check(db, impl);
    assert.equal(result.outcomes.length, 7);
    assert.ok(result.outcomes.every((o) => o.reviewIdSource === 'reviews-list'));
    assert.match(result.outcomes[0].evidence, /found by commit and author/);
    const reads = impl.calls.map((c) => c.path);
    assert.ok(reads.includes(`/repos/${REPO}/pulls/${PR}/reviews/900/comments`));
    assert.ok(!reads.some((p) => p.includes('/reviews/901/') || p.includes('/reviews/902/')));
  });
});

test('a run for a repository outside the allowlist is skipped, not read', async () => {
  await withDb(async (db) => {
    postedRun(db, { repository: 'other/private' });
    const impl = fakeGitHub();
    const result = await check(db, impl);
    assert.equal(result.outcomes.length, 0);
    assert.deepEqual(result.skipped.map((s) => s.repository), ['other/private']);
    assert.equal(impl.calls.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get().n, 0);
  });
});

test('a check only reads, and a run sent before the window is not followed', async () => {
  await withDb(async (db) => {
    postedRun(db);
    const impl = fakeGitHub();
    await check(db, impl);
    assert.ok(impl.calls.every((c) => c.method === 'GET' || c.path === '/graphql'));
    const later = fakeGitHub();
    const result = await check(db, later, { since: '2999-01-01T00:00:00.000Z' });
    assert.equal(result.outcomes.length, 0);
    assert.equal(later.calls.length, 0);
  });
});

test('checking again replaces the earlier outcome', async () => {
  await withDb(async (db) => {
    postedRun(db);
    await check(db, fakeGitHub({ resolved: [] }), { now: () => new Date('2026-10-10T00:00:00Z') });
    assert.equal(db.prepare(`SELECT outcome FROM finding_outcomes WHERE finding_id = 'rv_03'`).get().outcome, 'open');
    await check(db, fakeGitHub({ resolved: [103] }), { now: () => new Date('2026-10-11T00:00:00Z') });
    const rows = db.prepare(`SELECT outcome, checked_at FROM finding_outcomes WHERE finding_id = 'rv_03'`).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'resolved');
    assert.equal(rows[0].checked_at, '2026-10-11T00:00:00.000Z');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get().n, 7);
  });
});

test('evaluate reports posted precision from strong outcomes only, and null with none', async () => {
  await withDb(async (db) => {
    const empty = computeMetrics(db);
    const find = (metrics, name) => metrics.find((m) => m.name === name);
    assert.equal(find(empty, 'posted_findings_tracked').value, null);
    assert.equal(find(empty, 'posted_fixed_rate').value, null);
    assert.equal(find(empty, 'posted_dismissed_rate').value, null);
    const none = { tracked: 0, fixed: 0, dismissed: 0, fixedRate: null, dismissedRate: null };
    assert.deepEqual(postedBreakdown(db), { bySeverity: {}, byLane: {}, byRule: {}, byEvidenceBlock: { with: none, without: none, unknown: none } });

    postedRun(db);
    await check(db, fakeGitHub({ outdated: [104] }));
    const metrics = computeMetrics(db);
    // 2 fixed, 1 dismissed; the four weak outcomes are tracked and not counted.
    assert.equal(find(metrics, 'posted_findings_tracked').value, 7);
    assert.equal(find(metrics, 'posted_fixed_rate').value, 2 / 3);
    assert.equal(find(metrics, 'posted_dismissed_rate').value, 1 / 3);
    assert.equal(find(metrics, 'posted_fixed_rate').meets, true);

    const { bySeverity, byLane } = postedBreakdown(db);
    assert.equal(bySeverity.important.fixed, 2);
    assert.equal(bySeverity.important.fixedRate, 1);
    assert.equal(bySeverity.minor.dismissed, 1);
    assert.equal(bySeverity.nit.fixedRate, null);
    assert.equal(byLane.diff.tracked, 7);
  });
});

test('a lane recorded on the finding is used in the breakdown', async () => {
  await withDb(async (db) => {
    const runId = postedRun(db);
    await check(db, fakeGitHub());
    const row = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(runId);
    const parsed = JSON.parse(row.output_json);
    parsed.findings[0].lane = 'structure';
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify(parsed), runId);
    const { byLane } = postedBreakdown(db);
    assert.equal(byLane.structure.tracked, 1);
    assert.equal(byLane.diff.tracked, 6);
  });
});

// --- S21: threads awaiting this tool's one reply (docs/adr/0035) ---

const ROOT = { id: 105, path: 'src/open.ts', line: 50, body: '**minor** - The parser accepts an empty identifier.', user: { login: 'Review-Bot-User' } };
const OPEN = { resolved: false, outdated: false };
const at = (login, body, created_at, extra = {}) => ({ id: 300 + created_at.length, in_reply_to_id: 105, user: { login }, body, created_at, ...extra });

test('replyWanted asks only for a question or a questioning disagreement from someone else on an open thread', () => {
  const asked = at('author', 'Why is this a problem?', '2026-10-02T10:00:00Z');
  assert.deepEqual(replyWanted(ROOT, [asked], OPEN, 'your-github-login'), { askedBy: 'author', askedAt: '2026-10-02T10:00:00Z', stance: 'question' });
  // A disagreement that asks gets the reply; one that asks nothing is recorded only.
  assert.equal(replyWanted(ROOT, [at('author', 'This is intentional, is it not?', '2026-10-02T10:00:00Z')], OPEN, null).stance, 'reject');
  assert.equal(replyWanted(ROOT, [at('author', 'This is intentional.', '2026-10-02T10:00:00Z')], OPEN, null), null);
  // An acknowledgement, with or without a question mark, and an other without one.
  assert.equal(replyWanted(ROOT, [at('author', 'Good catch, done. Anything else?', '2026-10-02T10:00:00Z')], OPEN, null), null);
  assert.equal(replyWanted(ROOT, [at('author', 'Looking into it.', '2026-10-02T10:00:00Z')], OPEN, null), null);
  // A question mark only inside a blockquote is the quoted text, not a question.
  assert.equal(replyWanted(ROOT, [at('author', '> Why would this fail?\nIt does not.', '2026-10-02T10:00:00Z')], OPEN, null), null);
  // A bot, the poster (case-insensitively) and the owner ask nothing.
  assert.equal(replyWanted(ROOT, [at('dependabot[bot]', 'Why?', '2026-10-02T10:00:00Z')], OPEN, null), null);
  assert.equal(replyWanted(ROOT, [at('helper', 'Why?', '2026-10-02T10:00:00Z', { user: { login: 'helper', type: 'Bot' } })], OPEN, null), null);
  assert.equal(replyWanted(ROOT, [at('review-bot-user', 'Why?', '2026-10-02T10:00:00Z')], OPEN, null), null);
  assert.equal(replyWanted(ROOT, [at('Your-GitHub-Login', 'Why?', '2026-10-02T10:00:00Z')], OPEN, 'your-github-login'), null);
  // Any poster reply under the root closes the thread to this tool, whoever asked after it.
  assert.equal(replyWanted(ROOT, [at('review-bot-user', 'Answered.', '2026-10-02T09:00:00Z'), asked], OPEN, null), null);
  // The newest eligible reply decides, by time and not by list order: a bot after the author changes nothing, a later agreement does.
  assert.equal(replyWanted(ROOT, [asked, at('ci[bot]', 'Build passed.', '2026-10-02T11:00:00Z')], OPEN, null).stance, 'question');
  assert.equal(replyWanted(ROOT, [at('teammate', 'Agreed, makes sense.', '2026-10-02T11:00:00Z'), asked], OPEN, null), null);
  // A resolved thread, an unknown state, a reply to another root, and a root with no login.
  assert.equal(replyWanted(ROOT, [asked], { resolved: true, outdated: false }, null), null);
  assert.equal(replyWanted(ROOT, [asked], null, null), null);
  assert.equal(replyWanted(ROOT, [{ ...asked, in_reply_to_id: 999 }], OPEN, null), null);
  assert.equal(replyWanted({ ...ROOT, user: {} }, [asked], OPEN, null), null);
});

test('checkOutcomes returns the pending questions from the reads it already makes', async () => {
  await withDb(async (db) => {
    const runId = postedRun(db);
    const quiet = fakeGitHub();
    const before = await check(db, quiet);
    assert.deepEqual(before.questions, []);
    const asking = fakeGitHub({
      replies: [
        { id: 202, in_reply_to_id: 102, user: { login: 'author' }, body: 'This is intentional, the discount is applied later.', created_at: '2026-10-02T10:00:00Z' },
        { id: 207, in_reply_to_id: 107, user: { login: 'author' }, body: 'Good catch, done.', created_at: '2026-10-02T10:00:00Z' },
        { id: 205, in_reply_to_id: 105, user: { login: 'author' }, body: 'Why is an empty identifier a problem here?', created_at: '2026-10-02T10:00:00Z' },
        { id: 206, in_reply_to_id: 106, user: { login: 'author' }, body: 'Why?', created_at: '2026-10-02T10:00:00Z' },
        { id: 203, in_reply_to_id: 103, user: { login: 'author' }, body: 'Why?', created_at: '2026-10-02T10:00:00Z' },
      ],
    });
    const result = await check(db, asking);
    // 106 has no thread state and 103 is resolved; only 105 asks on an open thread.
    assert.deepEqual(result.questions, [
      { reviewRunId: runId, findingId: 'rv_05', repository: REPO, pullNumber: PR, rootCommentId: 105, path: 'src/open.ts', line: 50, askedBy: 'author', askedAt: '2026-10-02T10:00:00Z', stance: 'question' },
    ]);
    // Detection costs no request, and the outcomes are as before.
    assert.deepEqual(asking.calls.map((c) => c.path), quiet.calls.map((c) => c.path));
    assert.equal(byFinding(result).rv_05.outcome, 'open');
    assert.equal(byFinding(result).rv_02.outcome, 'dismissed');
    // The owner's own question is not one this tool answers.
    const owner = await check(db, fakeGitHub({ replies: [{ id: 205, in_reply_to_id: 105, user: { login: 'author' }, body: 'Why?', created_at: '2026-10-02T10:00:00Z' }] }), { ownerReviewer: 'author' });
    assert.deepEqual(owner.questions, []);
  });
});

test('a review found by commit and author offers no reply, since the comment may be a person\'s', async () => {
  await withDb(async (db) => {
    // The sent row names no review, so the review is found by the account and commit alone.
    postedRun(db, { reviewId: null });
    const asked = { id: 205, in_reply_to_id: 105, user: { login: 'author' }, body: 'Why is an empty identifier a problem here?', created_at: '2026-10-02T10:00:00Z' };
    const reviews = [{ id: 777, user: { login: 'review-bot-user' }, commit_id: HEAD }];
    const result = await check(db, fakeGitHub({ reviews, replies: [asked] }), { pullNumber: PR });
    assert.deepEqual(result.questions, []);
    // The outcomes are still followed through the found review.
    assert.equal(byFinding(result).rv_05.reviewIdSource, 'reviews-list');
  });
});

test('two findings on one line keep their own comments, so a question is paired with the finding it was asked about', async () => {
  await withDb(async (db) => {
    // An earlier review carried A, so this review posted only B, on the same line.
    const A = 'The parser accepts an empty identifier.';
    const B = 'The cache key ignores the locale.';
    const output = [`[minor] \`src/open.ts:50\` - ${A}`, `[minor] \`src/open.ts:50\` - ${B}`].join('\n\n');
    const { reviewRunId } = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output });
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
    recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 555 });
    const root = { id: 901, path: 'src/open.ts', line: 50, original_line: 50, body: `**minor** - ${B}`, user: { login: 'review-bot-user' }, created_at: '2026-10-01T10:00:00Z' };
    const asked = { id: 902, in_reply_to_id: 901, user: { login: 'author' }, body: 'Why does the locale matter here?', created_at: '2026-10-02T10:00:00Z' };
    const impl = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/graphql') {
        return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 901 }] } }] } } } } });
      }
      if (path === '/user') return json({ login: 'review-bot-user' });
      if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
      if (path === `/repos/${REPO}/pulls/${PR}/comments`) return json([root, asked]);
      if (path === `/repos/${REPO}/pulls/${PR}/reviews/555/comments`) return json([root]);
      return new Response('not found', { status: 404 });
    };
    // The matcher before this one paired A with B's comment and stored that.
    saveOutcome(db, {
      reviewRunId, findingId: 'rv_01', repository: REPO, pullNumber: PR, commentId: 901,
      outcome: 'dismissed', strength: 'strong', evidence: 'an earlier check', checkedAt: '2026-10-02T12:00:00.000Z', path: 'src/open.ts', line: 50, reviewIdSource: 'audit',
    });
    const result = await check(db, impl, { pullNumber: PR });
    assert.deepEqual(result.questions.map((q) => [q.findingId, q.rootCommentId]), [['rv_02', 901]]);
    assert.deepEqual(result.outcomes.map((o) => [o.findingId, o.commentId]), [['rv_02', 901]]);
    // The stale pairing is gone, so the thread is counted once, under B.
    assert.deepEqual(db.prepare('SELECT finding_id, comment_id FROM finding_outcomes ORDER BY finding_id').all().map((row) => [row.finding_id, row.comment_id]), [['rv_02', 901]]);
  });
});

test('a reply list cut at the read limit offers no reply, since the answer may be past the cut', async () => {
  await withDb(async (db) => {
    postedRun(db);
    const asked = { id: 205, in_reply_to_id: 105, user: { login: 'author' }, body: 'Why is an empty identifier a problem here?', created_at: '2026-10-02T10:00:00Z' };
    // Seven roots, the question and 992 other comments are the first 1000; the poster's answer is the 1001st.
    const filler = Array.from({ length: 992 }, (_, i) => ({ id: 10_000 + i, in_reply_to_id: 999, user: { login: 'someone' }, body: 'Noted.', created_at: '2026-10-02T11:00:00Z' }));
    const answered = { id: 20_000, in_reply_to_id: 105, user: { login: 'review-bot-user' }, body: 'It is rejected later.', created_at: '2026-10-03T10:00:00Z' };
    const cutWarning = /only the first 1000 inline comments were read, so no reply is offered/;
    const result = await check(db, fakeGitHub({ replies: [asked, ...filler, answered] }), { pullNumber: PR });
    assert.deepEqual(result.questions, []);
    assert.ok(result.warnings.some((warning) => cutWarning.test(warning)), result.warnings.join('\n'));
    assert.equal(result.outcomes.length, 7);
    // The watcher and `outcomes` read every pull request and offer no reply, so they are not told of one.
    const unnarrowed = await check(db, fakeGitHub({ replies: [asked, ...filler, answered] }));
    assert.deepEqual(unnarrowed.questions, []);
    assert.equal(unnarrowed.warnings.some((warning) => cutWarning.test(warning)), false, unnarrowed.warnings.join('\n'));
    // Under the limit the same question is offered.
    assert.equal((await check(db, fakeGitHub({ replies: [asked, ...filler.slice(1)] }))).questions.length, 1);
  });
});

test('a pullNumber narrows the check to one pull request before any request', async () => {
  await withDb(async (db) => {
    postedRun(db);
    const other = fakeGitHub();
    const none = await check(db, other, { pullNumber: PR + 1 });
    assert.equal(none.outcomes.length, 0);
    assert.equal(other.calls.length, 0);
    const mine = fakeGitHub();
    assert.equal((await check(db, mine, { pullNumber: PR })).outcomes.length, 7);
    assert.ok(mine.calls.length > 0);
  });
});

function cli(args, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('outcomes --json with no runs is an empty array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-outcomes-cli-'));
  try {
    const empty = cli(['outcomes', '--json'], dir);
    assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), []);
    assert.equal(cli(['outcomes', '--since', 'soon'], dir).code, 2);
    assert.equal(cli(['outcomes', '--repository', 'nonsense'], dir).code, 2);
    assert.match(cli(['outcomes', '--help'], dir).stdout, /--since <Nd>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outcomes prints the pending-question line in text mode, and its --json stays an array of outcomes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-outcomes-cli-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  postedRun(db);
  db.close();
  const saved = { REVIEW_VOICE_DATA_DIR: process.env.REVIEW_VOICE_DATA_DIR, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  process.env.GITHUB_TOKEN = 't';
  try {
    const replies = [{ id: 205, in_reply_to_id: 105, user: { login: 'author' }, body: 'Why is an empty identifier a problem here?', created_at: '2026-10-02T10:00:00Z' }];
    const text = await runInProcess(['outcomes', '--repository', REPO], { fetchImpl: fakeGitHub({ replies }) });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^${REPO}#${PR} rv_05 src/open[.]ts:50 question from author awaiting a reply; run reply --pr ${PR}$`, 'm'), text.stdout);
    const asJson = await runInProcess(['outcomes', '--repository', REPO, '--json'], { fetchImpl: fakeGitHub({ replies }) });
    assert.equal(asJson.code, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 7);
    assert.ok(!asJson.stdout.includes('awaiting a reply'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purge --all removes followed outcomes along with the runs they belong to', async () => {
  const { executePurge } = await import('../plugins/review-voice/src/consent/purge.ts');
  const { saveOutcome } = await import('../plugins/review-voice/src/store/outcomes.ts');
  const dir = mkdtempSync(join(tmpdir(), 'rv-outcomes-purge-'));
  try {
    const db = openDatabase(join(dir, 'review-voice.db'));
    saveOutcome(db, {
      reviewRunId: 'run-1', findingId: 'rv_01', repository: 'acme/api', pullNumber: 1, commentId: 7,
      outcome: 'dismissed', strength: 'strong', evidence: 'a reviewer replied turning it down', checkedAt: new Date().toISOString(), path: 'src/a.ts', line: 3, reviewIdSource: 'audit',
    });
    executePurge(db, { all: true });
    const left = db.prepare('SELECT COUNT(*) AS n FROM finding_outcomes').get();
    assert.equal(left.n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
