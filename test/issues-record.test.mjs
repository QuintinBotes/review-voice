/**
 * #201 record keeps a candidate's lane, #204 the thread re-check ignores
 * comments that quote the tool's own earlier text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { postedBreakdown } from '../plugins/review-voice/src/store/outcomes.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { postReview } from '../plugins/review-voice/src/publish/post.ts';

const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'your-github-login';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const run = (name, status, conclusion = null, id = 1) => ({
  id,
  name,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-10-01T10:00:00Z' : null,
});
const GREEN = [run('build', 'completed', 'success')];
const RED = [run('build', 'completed', 'failure')];
const PENDING = [run('build', 'in_progress')];

/**
 * A stand-in for GitHub. `checks` are served in order, one per read, so a test
 * can change CI between the verdict and the send.
 */
function fakeGitHub({ checks = [GREEN], reviews = [], inline = [], conversation = [], viewer = OWNER, onPost } = {}) {
  const calls = [];
  let checkReads = 0;
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = {
      method: init.method ?? 'GET',
      path: parsed.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (parsed.pathname.endsWith('/graphql')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (call.method === 'POST') {
      if (onPost !== undefined) return onPost(call);
      return json({ id: 101, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-101`, state: call.body.event });
    }
    if (parsed.pathname === '/user') return json({ login: viewer });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/reviews')) return json(reviews);
    if (/\/pulls\/\d+\/comments$/.test(parsed.pathname)) return json(inline);
    if (/\/issues\/\d+\/comments$/.test(parsed.pathname)) return json(conversation);
    if (parsed.pathname.endsWith('/check-runs')) {
      const runs = checks[Math.min(checkReads, checks.length - 1)];
      checkReads += 1;
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  impl.posts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-verdict-policies-'));
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

const verified = (path, line, severity) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});

const MINOR_PROSE = 'The total skips the discount. A discounted cart is overcharged.';
const MINOR = `[minor] \`src/cart.ts:12\` - ${MINOR_PROSE}`;
function record(db, output, scores = [], extra = {}) {
  return recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores, ...extra });
}

function post(db, impl, review, extra = {}) {
  return postReview({
    db,
    client: client(impl),
    writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review,
    owner: OWNER,
    confirm: true,
    event: 'APPROVE',
    postingEnabled: true,
    ...extra,
  });
}

const raised = (login, extra = {}) => ({
  id: 900,
  user: { login },
  path: 'src/cart.ts',
  line: 12,
  body: MINOR_PROSE,
  html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r900`,
  ...extra,
});
const AFTER_RUN = '2999-01-01T00:00:00Z';
const conversation = (login, text) => ({ id: 901, user: { login }, body: text, created_at: AFTER_RUN, html_url: 'https://example.test/c' });
const recheck = (db, impl) => post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });

test('#201 record stores each candidate lane and the finding carries it', async () => {
  await withDb(async (db) => {
    const output = `[minor] \`src/a.ts:3\` - First point here.\n\n[minor] \`src/b.ts:4\` - Second point here.`;
    const candidates = [
      { path: 'src/a.ts', line: 3, category: 'x', lane: 'structure', blocker_class: 'file-size' },
      { path: 'src/b.ts', line: 4, category: 'y' },
    ];
    const { reviewRunId, findings } = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output, candidates });
    assert.deepEqual(findings.map((f) => f.lane), ['structure', 'diff']);
    const stored = JSON.parse(db.prepare('SELECT candidates_json FROM review_runs').get().candidates_json);
    assert.deepEqual(stored.map((c) => [c.lane, c.blocker_class]), [['structure', 'file-size'], ['diff', undefined]]);

    const outcome = (id) => db.prepare('INSERT INTO finding_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(reviewRunId, id, REPO, PR, 1, 'fixed', 'strong', 'e', 'now');
    outcome('rv_01');
    outcome('rv_02');
    const { byLane } = postedBreakdown(db);
    assert.deepEqual(Object.keys(byLane).sort(), ['diff', 'structure']);
    assert.deepEqual([byLane.structure.tracked, byLane.structure.fixed, byLane.diff.tracked], [1, 1, 1]);
  });
});

test('#204 a colleague comment quoting the tool in a blockquote does not block', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({
      inline: [raised(OWNER, { id: 800, created_at: AFTER_RUN })],
      conversation: [conversation('a-colleague', `> src/cart.ts:12 ${MINOR_PROSE}\n\nThanks for the review.`)],
    });
    const { exitCode, output } = await recheck(db, impl);
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    assert.equal(impl.posts().length, 1);
  });
});

test('#204 a colleague pasting the tool text without a quote marker does not block', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({
      inline: [raised(OWNER, { id: 800, created_at: AFTER_RUN })],
      conversation: [conversation('a-colleague', MINOR_PROSE)],
    });
    const { exitCode } = await recheck(db, impl);
    assert.equal(exitCode, 0);
  });
});

test('#204 a colleague raising the same point in their own words still blocks', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({
      inline: [raised(OWNER, { id: 800, created_at: AFTER_RUN })],
      conversation: [
        conversation('a-colleague', `> unrelated quoted line\nsrc/cart.ts:12 The discounted total skips the discount, so a discounted cart is overcharged.`),
      ],
    });
    const { exitCode, output } = await recheck(db, impl);
    assert.equal(exitCode, 8, JSON.stringify(output.reasons));
    assert.equal(output.findings[0].raisedBy, 'a-colleague');
    assert.equal(impl.posts().length, 0);
  });
});

test('#204 a short colleague comment inside the tool text still blocks', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({
      inline: [
        raised(OWNER, { id: 800, created_at: AFTER_RUN }),
        raised('a-colleague', { id: 801, body: 'The total skips the discount.', created_at: AFTER_RUN }),
      ],
    });
    const { exitCode } = await recheck(db, impl);
    assert.equal(exitCode, 8);
  });
});
