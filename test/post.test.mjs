/**
 * The plugin's one GitHub write (docs/adr/0010): a review submitted with its
 * event, once, after an explicit confirmation, through a writer that can make
 * no other request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { GitHubClient, NotAllowlisted } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter, WriteViolation } from '../plugins/review-voice/src/github/writer.ts';
import { postReview } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const REPO = 'acme/web';
const PR = 7;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const check = (name, status, conclusion = null) => ({
  id: 1,
  name,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-10-01T10:00:00Z' : null,
});
const GREEN = [check('build', 'completed', 'success')];
const RED = [check('build', 'completed', 'failure')];
const PENDING = [check('build', 'in_progress')];

/**
 * A stand-in for GitHub. `heads` and `checks` are read in order, one per
 * request, so a test can change the answer between the verdict and the send.
 */
function fakeGitHub({ heads = [HEAD], checks = [GREEN], onPost } = {}) {
  const calls = [];
  let headReads = 0;
  let checkReads = 0;
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = {
      method: init.method ?? 'GET',
      path: parsed.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (call.method === 'POST') {
      return onPost === undefined
        ? json({ id: 101, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-101`, state: 'APPROVED' })
        : onPost(call);
    }
    if (/\/pulls\/\d+$/.test(parsed.pathname)) {
      const sha = heads[Math.min(headReads, heads.length - 1)];
      headReads += 1;
      return json({ head: { sha } });
    }
    if (parsed.pathname.endsWith('/check-runs')) {
      const runs = checks[Math.min(checkReads, checks.length - 1)];
      checkReads += 1;
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  impl.allowlists = [];
  impl.posts = () => calls.filter((c) => c.method === 'POST');
  return impl;
}

/** The severity each fixture finding is rendered at, which its score must have derived. */
const SEVERITY_AT = {
  'src/cart.ts:10': 'minor',
  'src/cart.ts:12': 'minor',
  'src/cart.ts:40': 'nit',
  'src/auth.ts:84': 'blocking',
  'src/pay.ts:8': 'important',
};
const verified = (path, line, severity = SEVERITY_AT[`${path}:${line}`]) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});
const analystOnly = (path, line, severity) => ({ ...verified(path, line, severity), confidenceSource: 'analyst' });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-post-'));
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

function record(db, output, scores) {
  return recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores });
}

function post(db, impl, review, extra = {}) {
  return postReview({
    db,
    client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} }),
    writerFor: (allowlist) => {
      impl.allowlists.push(allowlist);
      return new ReviewWriter({ allowlist, token: 't', fetchImpl: impl });
    },
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review,
    confirm: true,
    event: 'APPROVE',
    postingEnabled: true,
    ...extra,
  });
}

function audits(db, action) {
  return db
    .prepare('SELECT metadata_json FROM audit_events WHERE action = ? ORDER BY created_at, rowid')
    .all(action)
    .map((row) => JSON.parse(row.metadata_json));
}

const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const BLOCKING = '[blocking] `src/auth.ts:84` - The token is returned before commit. A retry mints two.';
const CLEAN = 'No actionable findings.';

const PAYLOAD = { commit_id: HEAD, event: 'COMMENT', body: 'One comment inline.', comments: [] };

test('the writer refuses every method but POST, before the network', async () => {
  const impl = fakeGitHub();
  const writer = new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl });
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'post']) {
    await assert.rejects(() => writer.request(method, `/repos/${REPO}/pulls/${PR}/reviews`, PAYLOAD), WriteViolation, method);
  }
  assert.equal(impl.calls.length, 0);
});

test('the writer refuses every path but creating a review', async () => {
  const impl = fakeGitHub();
  const writer = new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl });
  for (const path of [
    `/repos/${REPO}/issues/${PR}/comments`,
    `/repos/${REPO}/pulls/${PR}/comments`,
    `/repos/${REPO}/pulls/${PR}/merge`,
    `/repos/${REPO}/pulls/${PR}/reviews/5/events`,
    `/repos/${REPO}/pulls/${PR}/reviews/5/dismissals`,
    `/repos/${REPO}/pulls/${PR}/reviews?event=APPROVE`,
    `/repos/${REPO}/statuses/${HEAD}`,
    `/repos/${REPO}/pulls/0/reviews`,
    `/repos/${REPO}/../other/pulls/${PR}/reviews`,
    '/graphql',
    `https://api.github.com/repos/${REPO}/pulls/${PR}/reviews`,
  ]) {
    await assert.rejects(() => writer.request('POST', path, PAYLOAD), WriteViolation, path);
  }
  await assert.rejects(() => writer.request('POST', `/repos/acme/other/pulls/${PR}/reviews`, PAYLOAD), NotAllowlisted);
  assert.equal(impl.calls.length, 0);
});

test('a review without its event, or with PENDING, is never sent', async () => {
  const impl = fakeGitHub();
  const writer = new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl });
  for (const payload of [
    { ...PAYLOAD, event: undefined },
    { ...PAYLOAD, event: 'PENDING' },
    { ...PAYLOAD, commit_id: 'abc123' },
    { ...PAYLOAD, comments: [{ path: 'a.ts', side: 'RIGHT', body: 'no line' }] },
    { ...PAYLOAD, extra: true },
  ]) {
    await assert.rejects(() => writer.submitReview(REPO, PR, payload), WriteViolation);
  }
  assert.equal(impl.calls.length, 0);
});

test('nothing else in the plugin issues a write', () => {
  // The read-only client keeps refusing non-GET REST requests. Its one POST is
  // a GraphQL query, refused unless it is one (ADR 0018, tested in
  // issue-43-thread-resolution); the writer is the only place a write is.
  const src = join(root, 'plugins/review-voice/src');
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(src.length + 1));
    }
  };
  walk(src);
  assert.deepEqual(offenders.sort(), ['github/client.ts', 'github/writer.ts']);
});

test('a confirmed review is submitted with its event in one request', async () => {
  await withDb(async (db) => {
    const output = [MINOR, NIT].join('\n\n');
    record(db, output, [verified('src/cart.ts', 12), verified('src/cart.ts', 40)]);
    const impl = fakeGitHub();
    const { exitCode, output: result } = await post(db, impl, output, { event: 'COMMENT' });
    assert.equal(exitCode, 0, result.reasons.join('; '));
    assert.equal(result.status, 'sent');
    const posts = impl.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, `/repos/${REPO}/pulls/${PR}/reviews`);
    assert.equal(posts[0].body.event, 'COMMENT');
    assert.equal(posts[0].body.commit_id, HEAD);
    assert.equal(posts[0].body.comments.length, 2);
    assert.ok(!posts[0].body.body.includes('\n'));
    assert.equal(result.review.id, 101);
    assert.equal(audits(db, 'review_post_sent').length, 1);
  });
});

test('the key is recorded as attempted before the request goes out', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    let attemptedAtSend = null;
    const impl = fakeGitHub({
      onPost: () => {
        attemptedAtSend = audits(db, 'review_post_attempted');
        return json({ id: 5 });
      },
    });
    const { output } = await post(db, impl, CLEAN);
    assert.equal(output.status, 'sent');
    assert.equal(attemptedAtSend.length, 1);
    assert.equal(attemptedAtSend[0].key, output.key);
    assert.ok(output.key.startsWith(`${REPO}#${PR}@${HEAD}:`));
  });
});

test('a key already sent is refused, with no request', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub();
    assert.equal((await post(db, impl, CLEAN)).output.status, 'sent');
    const again = await post(db, impl, CLEAN);
    assert.equal(again.output.status, 'refused');
    assert.match(again.output.reasons[0], /already sent/);
    assert.equal(impl.posts().length, 1);
    assert.equal(audits(db, 'review_post_refused').length, 1);
  });
});

test('without --confirm nothing is sent, and the refusal is audited', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub();
    const { exitCode, output } = await post(db, impl, CLEAN, { confirm: false });
    assert.equal(exitCode, 2);
    assert.equal(output.status, 'refused');
    assert.match(output.reasons[0], /--confirm/);
    // The exact preview is still shown, from the payload that would be sent.
    assert.equal(output.verdict.preview.split('\n')[0], 'APPROVE');
    assert.equal(impl.posts().length, 0);
    assert.equal(audits(db, 'review_post_refused').length, 1);
    assert.equal(audits(db, 'review_post_attempted').length, 0);
  });
});

test('posting disabled in config refuses before reading anything', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub();
    const { exitCode, output } = await post(db, impl, CLEAN, { postingEnabled: false });
    assert.equal(exitCode, 2);
    assert.match(output.reasons[0], /github_posting_enabled/);
    assert.equal(impl.calls.length, 0);
    assert.equal(audits(db, 'review_post_refused').length, 1);
  });
});

test('a moved head refuses, with no request', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub({ heads: [MOVED] });
    const { exitCode, output } = await post(db, impl, CLEAN);
    assert.equal(exitCode, 3);
    assert.equal(output.status, 'refused');
    assert.equal(impl.posts().length, 0);
  });
});

test('an approval is refused while CI is still running', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub({ checks: [PENDING] });
    const { exitCode, output } = await post(db, impl, CLEAN);
    assert.equal(exitCode, 4);
    assert.equal(output.status, 'refused');
    assert.equal(impl.posts().length, 0);
  });
});

test('head and CI are re-read immediately before an approval is sent', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const moved = fakeGitHub({ heads: [HEAD, MOVED] });
    const first = await post(db, moved, CLEAN);
    assert.equal(first.exitCode, 3);
    assert.equal(moved.posts().length, 0);

    const red = fakeGitHub({ checks: [GREEN, RED] });
    const second = await post(db, red, CLEAN);
    assert.equal(second.exitCode, 5);
    assert.equal(red.posts().length, 0);

    // Neither left an attempt behind, so neither blocks a later send.
    assert.equal(audits(db, 'review_post_attempted').length, 0);
    const third = await post(db, fakeGitHub(), CLEAN);
    assert.equal(third.output.status, 'sent');
  });
});

test('a non-approval does not wait for CI', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12)]);
    const impl = fakeGitHub({ checks: [PENDING] });
    const { output } = await post(db, impl, MINOR, { event: 'COMMENT' });
    assert.equal(output.status, 'sent');
    assert.equal(impl.posts()[0].body.event, 'COMMENT');
  });
});

test('only verified findings post', async () => {
  await withDb(async (db) => {
    const output = [BLOCKING, MINOR].join('\n\n');
    record(db, output, [analystOnly('src/auth.ts', 84), verified('src/cart.ts', 12)]);
    const impl = fakeGitHub();
    const { output: result } = await post(db, impl, output, { event: 'COMMENT' });
    assert.equal(result.status, 'sent');
    const sent = impl.posts()[0].body;
    assert.equal(sent.event, 'COMMENT');
    assert.deepEqual(sent.comments.map((c) => c.path), ['src/cart.ts']);
    assert.ok(!JSON.stringify(sent).includes('token is returned'));
    assert.deepEqual(result.verdict.held.map((h) => h.findingId), ['rv_01']);
  });
});

test('the precision gate is reported with every post but does not hold a verified finding back', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12)]);
    const { output } = await post(db, fakeGitHub(), MINOR, { event: 'COMMENT' });
    // Nothing has been labelled, so the measured gate is closed.
    assert.equal(output.postCheck.allowed, false);
    assert.ok(output.postCheck.reasons.some((r) => /labelled/.test(r)));
    assert.equal(output.status, 'sent');
  });
});

test('GitHub saying no is reported plainly and audited, and may be tried again', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const refused = fakeGitHub({
      onPost: () => new Response('{"message":"Can not approve your own pull request"}', { status: 422 }),
    });
    const { exitCode, output } = await post(db, refused, CLEAN);
    assert.equal(exitCode, 1);
    assert.equal(output.status, 'failed');
    assert.equal(output.error.status, 422);
    assert.match(output.error.message, /approve your own pull request/);
    assert.equal(refused.posts().length, 1);
    const failed = audits(db, 'review_post_failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 422);
    assert.equal(failed[0].uncertain, false);

    // A 4xx means nothing was created, so the same key may go again.
    assert.equal((await post(db, fakeGitHub(), CLEAN)).output.status, 'sent');
  });
});

test('a send with no definite answer blocks a blind retry', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const timeout = fakeGitHub({
      onPost: () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.equal((await post(db, timeout, CLEAN)).output.status, 'failed');
    assert.equal(audits(db, 'review_post_failed')[0].uncertain, true);

    const retry = fakeGitHub();
    const { output } = await post(db, retry, CLEAN);
    assert.equal(output.status, 'refused');
    assert.match(output.reasons[0], /may have posted/);
    assert.equal(retry.posts().length, 0);
  });
});

test('an approval is refused while no checks have been reported', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub({ checks: [[]] });
    const { exitCode, output } = await post(db, impl, CLEAN);
    assert.equal(exitCode, 4);
    assert.equal(output.status, 'refused');
    assert.equal(impl.posts().length, 0);
  });
});

test('a failed run is not hidden by a passing run of the same name', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const runs = [
      { id: 1, name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-10-01T10:00:00Z' },
      { id: 2, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:05:00Z' },
    ];
    const impl = fakeGitHub({ checks: [runs] });
    const { exitCode, output } = await post(db, impl, CLEAN, { event: 'COMMENT' });
    assert.equal(exitCode, 0);
    assert.equal(output.verdict.ci.state, 'red');
    assert.equal(impl.posts()[0].body.event, 'COMMENT');
  });
});

test('--confirm needs the event the preview showed', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub();
    const { exitCode, output } = await post(db, impl, CLEAN, { event: undefined });
    assert.equal(exitCode, 2);
    assert.match(output.reasons[0], /--event/);
    assert.equal(impl.calls.length, 0);
    assert.equal(audits(db, 'review_post_refused').length, 1);
  });
});

test('an event that changed since the preview is refused, not sent', async () => {
  await withDb(async (db) => {
    record(db, NIT, [verified('src/cart.ts', 40)]);
    // The preview saw red CI and showed COMMENT; by the post, CI is green and
    // the review would approve. Nobody confirmed an approval.
    const impl = fakeGitHub({ checks: [RED, GREEN] });
    const preview = await post(db, impl, NIT, { confirm: false });
    assert.equal(preview.output.verdict.event, 'COMMENT');
    const { exitCode, output } = await post(db, impl, NIT, { event: 'COMMENT' });
    assert.equal(exitCode, 3);
    assert.match(output.reasons[0], /now APPROVE, not the COMMENT that was confirmed; preview it again/);
    assert.equal(impl.posts().length, 0);
    assert.equal(audits(db, 'review_post_refused').length, 2);
  });
});

test('an approval after a comment on the same head does not post the comments again', async () => {
  await withDb(async (db) => {
    record(db, NIT, [verified('src/cart.ts', 40)]);
    const impl = fakeGitHub({ checks: [RED, GREEN] });
    const first = await post(db, impl, NIT, { event: 'COMMENT' });
    assert.equal(first.output.status, 'sent');
    const second = await post(db, impl, NIT, { event: 'APPROVE' });
    assert.equal(second.output.status, 'sent', second.output.reasons.join('; '));
    const posts = impl.posts();
    assert.deepEqual(posts.map((p) => p.body.event), ['COMMENT', 'APPROVE']);
    assert.deepEqual(posts.map((p) => p.body.comments.length), [1, 0]);
    assert.equal(second.output.verdict.alreadyInline, 1);
    assert.match(second.output.verdict.preview, /not sent again: 1/);
  });
});

test('the writer may post only to the repository the recorded run reviewed', async () => {
  await withDb(async (db) => {
    recordRun(db, { repository: 'Acme/Web', baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: CLEAN, scores: [] });
    const impl = fakeGitHub();
    assert.equal((await post(db, impl, CLEAN)).output.status, 'sent');
    assert.deepEqual(impl.allowlists, [['Acme/Web']]);

    // A run of another repository is not consent to post to this one.
    const other = recordRun(db, { repository: 'acme/other', baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: CLEAN, scores: [] });
    const stray = fakeGitHub();
    const { output } = await post(db, stray, CLEAN, { runId: other.reviewRunId });
    assert.equal(output.status, 'refused');
    assert.equal(stray.calls.length, 0);
    assert.deepEqual(stray.allowlists, []);
  });
});

test('an attempt with no outcome blocks the key', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const { output: preview } = await post(db, fakeGitHub(), CLEAN, { confirm: false });
    recordAudit(db, 'review_post_attempted', { type: 'pull_request', id: `${REPO}#${PR}` }, { key: preview.key });
    const impl = fakeGitHub();
    const { output } = await post(db, impl, CLEAN);
    assert.match(output.reasons[0], /may have posted/);
    assert.equal(impl.posts().length, 0);
  });
});

test('two posts of the same review started together send once', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub({
      onPost: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({ id: 7 });
      },
    });
    const results = await Promise.all([post(db, impl, CLEAN), post(db, impl, CLEAN)]);
    assert.deepEqual(results.map((r) => r.output.status).sort(), ['refused', 'sent']);
    assert.equal(impl.posts().length, 1);
  });
});
