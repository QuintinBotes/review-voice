/**
 * Reviews the Action posts live only in its runner's store, so `outcomes` could
 * never follow them (#529, docs/adr/0042). `outcomes --recover` records a
 * review by the Action's login as a run from its posted finding comments, and
 * the ordinary outcome check takes it from there. GitHub is stubbed.
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
import { postedFindings, recoverPostedReviews } from '../plugins/review-voice/src/store/recover.ts';
import { EVIDENCE_MARKER } from '../plugins/review-voice/src/publish/evidence-block.ts';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';

const REPO = 'acme/web';
const PR = 7;
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const BOT = 'github-actions[bot]';
const SINCE = '2026-11-01T00:00:00.000Z';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const finding = (id, path, line, text, extra = {}) => ({ id, path, line, original_line: line, body: `**minor** - ${text}`, user: { login: BOT }, ...extra });

/** The Action's review 900 with two findings, one with an owner reply; a person's review; one with no finding in it. */
function fakeGitHub({ replies = [{ id: 401, in_reply_to_id: 301, user: { login: 'owner' }, body: 'Agreed, fixed in the next commit.', created_at: '2026-11-27T10:00:00Z' }], pulls } = {}) {
  const first = finding(301, 'src/a.ts', 5, 'The total ignores the discount for carts.', { pull_request_review_id: 900 });
  const second = finding(302, 'src/b.ts', 9, 'The cache key leaves out the locale.', { pull_request_review_id: 900 });
  const persons = finding(350, 'src/c.ts', 1, 'A person wrote this in the same words.', { pull_request_review_id: 901 });
  // A review whose only comment is a person's note, not a finding.
  const note = { id: 360, path: 'src/d.ts', line: 3, original_line: 3, body: 'Looks fine to me.', user: { login: BOT }, pull_request_review_id: 902 };
  // The list per review is the older shape: `position`, and neither `line` nor `original_line` (#531).
  const perReview = (comments) => comments.map(({ line, original_line, ...rest }) => ({ ...rest, position: 3 }));
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    calls.push({ method: init.method ?? 'GET', path });
    if (path === '/graphql') {
      const nodes = [first, second].map((comment) => ({ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: comment.id }] } }));
      return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (path === `/repos/${REPO}/pulls`) return json(pulls ?? [{ number: PR, updated_at: '2026-11-27T10:00:00Z' }]);
    // The author pushed a change to the anchored lines of src/a.ts after the review.
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: NEW_HEAD } });
    if (path === `/repos/${REPO}/pulls/${PR}/reviews`) {
      return json([
        { id: 900, state: 'COMMENTED', commit_id: HEAD, user: { login: BOT } },
        { id: 901, state: 'COMMENTED', commit_id: HEAD, user: { login: 'a-person' } },
        { id: 902, state: 'COMMENTED', commit_id: HEAD, user: { login: BOT } },
      ]);
    }
    if (path === `/repos/${REPO}/pulls/${PR}/reviews/900/comments`) return json(perReview([first, second]));
    if (path === `/repos/${REPO}/pulls/${PR}/reviews/901/comments`) return json(perReview([persons]));
    if (path === `/repos/${REPO}/pulls/${PR}/reviews/902/comments`) return json(perReview([note]));
    if (path === `/repos/${REPO}/pulls/${PR}/comments`) return json([first, second, persons, note, ...replies]);
    if (path.includes('/compare/')) return json({ files: [{ filename: 'src/a.ts', patch: '@@ -3,5 +3,5 @@\n x\n x\n-old\n+new\n x\n x' }] });
    if (path === '/user') return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-529-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

const recover = (db, impl, extra = {}) => recoverPostedReviews({ db, client: client(impl), allowlist: [REPO], since: SINCE, ...extra });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('#529: a review by the Action is recorded as a run with the findings it posted, and only that one', async () => {
  await withDb(async (db) => {
    const result = await recover(db, fakeGitHub());
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.recovered.map((r) => [r.repository, r.pullNumber, r.reviewId, r.findings]), [[REPO, PR, 900, 2]]);
    assert.equal(count(db, 'review_runs'), 1, "a person's review and a review with no finding in it record nothing");
    const run = db.prepare('SELECT repository, pull_number, head_ref FROM review_runs').get();
    assert.deepEqual({ ...run }, { repository: REPO, pull_number: PR, head_ref: HEAD });
    const sent = JSON.parse(db.prepare(`SELECT metadata_json FROM audit_events WHERE action = 'review_post_sent'`).get().metadata_json);
    assert.deepEqual([sent.reviewId, sent.head, sent.recovered], [900, HEAD, true]);
  });
});

test('#529: outcomes then follows the recovered findings, and the owner\'s reply is the outcome', async () => {
  await withDb(async (db) => {
    const impl = fakeGitHub();
    await recover(db, impl);
    const result = await checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: SINCE });
    const got = Object.fromEntries(result.outcomes.map((o) => [`${o.path}:${o.line}`, o]));
    assert.deepEqual([got['src/a.ts:5'].outcome, got['src/a.ts:5'].strength, got['src/a.ts:5'].commentId], ['fixed', 'strong', 301]);
    assert.deepEqual([got['src/b.ts:9'].outcome, got['src/b.ts:9'].strength], ['open', 'weak']);
    assert.equal(got['src/a.ts:5'].reviewIdSource, 'audit');
    assert.equal(count(db, 'finding_outcomes'), 2);
  });
});

test('#529: running it again records nothing twice, and a review already named by a sent row is left alone', async () => {
  await withDb(async (db) => {
    const impl = fakeGitHub();
    await recover(db, impl);
    assert.deepEqual((await recover(db, impl)).recovered, []);
    assert.equal(count(db, 'review_runs'), 1);

    // A review posted from here, with its own run, is not recorded a second time.
    const { reviewRunId } = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: '[minor] `src/z.ts:1` - Posted from here.' });
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
    recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 902 });
    assert.deepEqual((await recover(db, impl, { logins: [BOT, 'a-person'] })).recovered.map((r) => r.reviewId), [901]);
  });
});

test('#529: only the logins asked for are read, and a pull request not updated inside the window is not', async () => {
  await withDb(async (db) => {
    assert.deepEqual((await recover(db, fakeGitHub(), { logins: ['another-bot[bot]'] })).recovered, []);
    assert.deepEqual((await recover(db, fakeGitHub({ pulls: [{ number: PR, updated_at: '2026-10-01T00:00:00Z' }] }))).recovered, []);
    assert.equal(count(db, 'review_runs'), 0);
  });
});

test('#529: no reply is offered under a recovered thread, which was not posted from here', async () => {
  await withDb(async (db) => {
    const ask = { id: 402, in_reply_to_id: 302, user: { login: 'a-person' }, body: 'Why does the locale matter here?', created_at: '2026-11-27T11:00:00Z' };
    const impl = fakeGitHub({ replies: [ask] });
    await recover(db, impl);
    const result = await checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: SINCE });
    assert.deepEqual(result.questions, []);
  });
});

test('#529: a comment is a finding only when it reads as one `post` renders, with the evidence and suggestion blocks left off', () => {
  const evidence = `\n\n${EVIDENCE_MARKER}\n<details><summary>Evidence</summary>\n\nfacts\n</details>`;
  const comments = [
    { path: 'src/a.ts', line: 5, body: `**important** - The retry\ncharges twice.${evidence}` },
    { path: 'src/b.ts', line: null, original_line: 8, body: '**nit** - The name shadows the import.\n\n```suggestion\nbetter\n```' },
    { path: 'src/c.ts', line: 3, body: '**minor** - A reply, not a finding.', in_reply_to_id: 1 },
    { path: 'src/d.ts', line: 3, body: 'Looks fine to me.' },
    { path: 'src/e.ts', line: 3, body: '**fatal** - Not a severity this tool uses.' },
    { line: 3, body: '**minor** - No file.' },
  ];
  assert.deepEqual(postedFindings(comments), [
    '[important] `src/a.ts:5` - The retry charges twice.',
    '[nit] `src/b.ts:8` - The name shadows the import.',
  ]);
});

test('#529: outcomes --recover records the review first, then follows it, from the command line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-529-cli-'));
  const saved = { REVIEW_VOICE_DATA_DIR: process.env.REVIEW_VOICE_DATA_DIR, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  process.env.GITHUB_TOKEN = 't';
  try {
    const pulls = [{ number: PR, updated_at: new Date().toISOString() }];
    const without = await runInProcess(['outcomes', '--repository', REPO, '--json'], { fetchImpl: fakeGitHub({ pulls }) });
    assert.equal(without.code, 0, without.stderr);
    assert.deepEqual(JSON.parse(without.stdout), [], 'without --recover nothing the Action posted is followed');

    const result = await runInProcess(['outcomes', '--recover', '--repository', REPO, '--json'], { fetchImpl: fakeGitHub({ pulls }) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`${REPO}#${PR}: recovered review 900 as run \\S+ \\(2 finding\\(s\\)\\)`));
    assert.match(result.stderr, /1 review\(s\) recovered from github-actions\[bot\]/);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows.map((row) => [row.path, row.line, row.outcome, row.strength]).sort(), [['src/a.ts', 5, 'fixed', 'strong'], ['src/b.ts', 9, 'open', 'weak']]);

    const again = await runInProcess(['outcomes', '--recover', '--repository', REPO, '--json'], { fetchImpl: fakeGitHub({ pulls }) });
    assert.match(again.stderr, /0 review\(s\) recovered/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#531: a comment the review list gave without lines takes them from the pull request list, by id, and keeps any it has', async () => {
  const { withLines } = await import('../plugins/review-voice/src/store/outcomes.ts');
  const all = [
    { id: 1, line: 27, original_line: 25, start_line: null, original_start_line: null },
    { id: 2, line: 9, original_line: 9 },
  ];
  assert.deepEqual(withLines([{ id: 1, path: 'a', position: 3 }, { id: 2, path: 'b', line: 11 }, { id: 3, path: 'c' }], all), [
    { id: 1, path: 'a', position: 3, line: 27, original_line: 25, start_line: null, original_start_line: null },
    { id: 2, path: 'b', line: 11, original_line: 9, start_line: null, original_start_line: null },
    { id: 3, path: 'c' },
  ]);
});
