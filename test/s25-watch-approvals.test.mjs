/**
 * S25 (docs/adr/0034), AC-5: `watch --once` follows the approvals it sent in
 * the same pass as the finding outcomes, and a failure reading one of them is
 * reported without failing the pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { DEFAULT_VERDICT_POLICY } from '../plugins/review-voice/src/publish/verdict.ts';
import { defaultQueueConfig } from '../plugins/review-voice/src/queue/config.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { saveApprovalOutcome, storedApprovalOutcomes } from '../plugins/review-voice/src/store/approvals.ts';
import { defaultWatchConfig } from '../plugins/review-voice/src/watch/config.ts';
import { watchCommand } from '../plugins/review-voice/src/watch/command.ts';

const ME = 'your-github-login';
const REPO = 'acme/web';
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-10-25T12:00:00Z');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GitHub with an empty queue, pull 5 merged at the approved head three weeks ago and pull 9 unreadable. */
function fakeGitHub() {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname });
    const path = parsed.pathname;
    if (path.endsWith('/graphql')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (path === '/user') return json({ login: ME });
    if (path === '/search/issues') return json({ total_count: 0, incomplete_results: false, items: [] });
    if (path.startsWith(`/repos/${REPO}/pulls/9`)) return new Response('boom', { status: 500 });
    if (path === `/repos/${REPO}/pulls/5`) return json({ state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z', head: { sha: HEAD } });
    if (path.endsWith('/reviews')) return json([{ id: 555, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-09-30T00:00:00Z', user: { login: ME } }]);
    if (/\/(pulls|issues)\/\d+\/comments$/.test(path)) return json([]);
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const settings = () => ({
  allowlist: ['acme/*'],
  // Requested only, so the queue itself never reads the recorded pull requests; the outcome steps do.
  queue: { ...defaultQueueConfig(), sources: ['requested'] },
  watch: defaultWatchConfig(),
  warnings: [],
  postingEnabled: false,
  ciGateChecks: [],
  ciRules: {},
  ownerReviewer: ME,
  verdictPolicy: { ...DEFAULT_VERDICT_POLICY },
});

/** Records a run for pull `number` and an APPROVE sent for it; returns the run id. */
function approvedRun(db, number) {
  const { reviewRunId } = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: number, diff: 'd', output: 'No actionable findings.' });
  const subject = { type: 'pull_request', id: `${REPO}#${number}` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, event: 'APPROVE', reviewId: 555, inline: [] });
  return reviewRunId;
}

/** One `watch --once` pass over `dbPath` against `impl`; returns the exit code and what was printed. */
async function once(dir, dbPath, impl) {
  const out = [];
  const err = [];
  const source = join(dir, 'source-config.yaml');
  writeFileSync(source, 'watch: {}\n');
  const code = await watchCommand(['--once'], {
    configSource: source,
    loadSettings: () => settings(),
    client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} }),
    writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
    openDb: () => openDatabase(dbPath),
    dataDir: dir,
    review: async () => ({ exitCode: 0, runId: null, event: null, reviewUrl: null, detail: null }),
    stopReview: () => {},
    prepareClone: () => {},
    now: () => NOW,
    sleep: async () => {},
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out, err };
}

test('watch --once follows approvals in the same pass as findings, and a failure there does not fail the pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-approvals-'));
  const dbPath = join(dir, 'review-voice.db');
  try {
    const db = openDatabase(dbPath);
    approvedRun(db, 5);
    approvedRun(db, 9);
    db.close();
    const impl = fakeGitHub();
    const { code, out, err } = await once(dir, dbPath, impl);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(out[0].split('\n'), ['0 entries; 0 not reached; outcomes followed on 2 pull request(s)']);
    // Pull 9 could not be read: said on stderr, and the pass still exits 0.
    assert.ok(err.some((line) => line.startsWith(`${REPO}#9: approval not checked (`)), err.join('\n'));

    const after = openDatabase(dbPath);
    try {
      const rows = storedApprovalOutcomes(after);
      assert.deepEqual(rows.map((row) => [row.pullNumber, row.outcome, row.strength]), [[5, 'survived', 'strong']]);
    } finally {
      after.close();
    }
    assert.ok(impl.calls.every((call) => call.method === 'GET' || call.path.endsWith('/graphql')), 'nothing was written');
    assert.ok(impl.calls.some((call) => call.path === `/repos/${REPO}/pulls/5/reviews`), 'the approval check read the reviews');
    // Only the finding check reads the review comments, so this shows it ran in the same pass.
    assert.ok(impl.calls.some((call) => call.path === `/repos/${REPO}/pulls/5/comments`), 'the finding check read the review comments');
    assert.ok(err.some((line) => line.startsWith(`${REPO}#9: not checked (`)), 'the finding check reported the unreadable pull request');
    assert.ok(existsSync(dbPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a quiet pass with nothing sent in the week still checks a stored approval not yet settled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-watch-approvals-quiet-'));
  const dbPath = join(dir, 'review-voice.db');
  try {
    const db = openDatabase(dbPath);
    const runId = approvedRun(db, 5);
    // The send is a month old, so no pull request has a review sent in the last week.
    db.prepare(`UPDATE audit_events SET created_at = '2026-09-25T00:00:00.000Z'`).run();
    // An earlier pass saw the merge inside the window; by NOW the window has passed.
    saveApprovalOutcome(db, {
      reviewRunId: runId, repository: REPO, pullNumber: 5, head: HEAD, reviewId: 555, outcome: 'pending', strength: 'weak',
      evidence: { summary: 'merged at the approved head; the window ends 2026-10-15T00:00:00.000Z', state: 'closed', mergedAt: '2026-10-01T00:00:00Z', currentHead: HEAD },
      checkedAt: '2026-10-02T00:00:00.000Z',
    });
    db.close();
    const impl = fakeGitHub();
    const { code, out, err } = await once(dir, dbPath, impl);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(out[0].split('\n'), ['0 entries; 0 not reached; outcomes followed on 0 pull request(s)']);
    const after = openDatabase(dbPath);
    try {
      assert.deepEqual(storedApprovalOutcomes(after).map((row) => [row.pullNumber, row.outcome, row.strength]), [[5, 'survived', 'strong']]);
    } finally {
      after.close();
    }
    assert.ok(impl.calls.some((call) => call.path === `/repos/${REPO}/pulls/5`), 'the approval check read the pull request');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
