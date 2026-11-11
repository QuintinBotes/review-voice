/**
 * S21. One bounded reply per own finding (docs/adr/0035): the writer's second
 * checked path, the pure renderer and its three pinned properties, the posting
 * guards around `postReplies`, the `reply` command and the documents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { claimKey, computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { classifyReply, replyStats, saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';
import { computeMetrics } from '../plugins/review-voice/src/evaluate/metrics.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { defaultWatchConfig } from '../plugins/review-voice/src/watch/config.ts';
import { GitHubClient, NotAllowlisted } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter, WriteViolation } from '../plugins/review-voice/src/github/writer.ts';
import { postReplies, renderReply } from '../plugins/review-voice/src/publish/reply.ts';
import { pendingQuestionLine } from '../plugins/review-voice/src/cli/outcomes.ts';
import { DEFAULT_LIMITS } from '../plugins/review-voice/src/contract/limits.ts';
import { findForbiddenPhrases } from '../plugins/review-voice/src/contract/validate.ts';
import { redact } from '../plugins/review-voice/src/redact/redact.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const REPO = 'acme/web';
const PR = 7;
const HEAD = 'a1b2c3d' + 'e'.repeat(33);
const ROOT_ID = 555;
const REPLY_PATH = `/repos/${REPO}/pulls/${PR}/comments/${ROOT_ID}/replies`;

const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const CONFIRMED = { verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/cart.ts:12', 'src/pricing.ts:48'], reason: 'not posted' };
const score = (challenge = CONFIRMED) => ({
  candidateId: 'cart',
  path: 'src/cart.ts',
  line: 12,
  severity: { severity: 'minor' },
  confidenceSource: 'verifier',
  eligible: true,
  ...(challenge === null ? {} : { challenge }),
});
const candidate = (evidence) => ({
  candidate_id: 'cart',
  path: 'src/cart.ts',
  line: 12,
  category: 'correctness',
  severity: 'minor',
  claim: 'The total skips the discount.',
  failure_mode: 'A discounted cart is overcharged.',
  evidence,
  technical_confidence: 0.9,
});
const EVIDENCE = ['`src/cart.ts:12` sums the lines before the discount runs', 'The discount is read at src/discount.ts:30-34.'];
const FINDING = { findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stand-in for GitHub that takes the one POST, and serves reads through `onGet` (GraphQL is a read). */
function fakeGitHub({ onPost, onGet } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = { method: init.method ?? 'GET', path: parsed.pathname, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.method === 'POST' && call.path !== '/graphql') {
      return onPost === undefined ? json({ id: 901, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r901` }) : onPost(call);
    }
    return onGet?.(call) ?? new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  impl.allowlists = [];
  impl.posts = () => calls.filter((c) => c.method === 'POST' && c.path !== '/graphql');
  return impl;
}

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reply-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(db, { repository = REPO, scores = [score()], candidates = [candidate(EVIDENCE)], headRef = HEAD, output = MINOR } = {}) {
  return recordRun(db, { repository, baseRef: null, headRef, pullNumber: PR, diff: 'diff', output, scores, candidates }).reviewRunId;
}

const question = (reviewRunId, extra = {}) => ({
  reviewRunId,
  findingId: 'rv_01',
  repository: REPO,
  pullNumber: PR,
  rootCommentId: ROOT_ID,
  path: 'src/cart.ts',
  line: 12,
  askedBy: 'author',
  askedAt: '2026-11-02T10:00:00Z',
  stance: 'question',
  ...extra,
});

function reply(db, impl, questions, extra = {}) {
  return postReplies({
    db,
    client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} }),
    repository: REPO,
    pullNumber: PR,
    questions,
    writerFor: (allowlist) => {
      impl.allowlists.push(allowlist);
      return new ReviewWriter({ allowlist, token: 't', fetchImpl: impl });
    },
    confirm: true,
    postingEnabled: true,
    ...extra,
  });
}

const audits = (db, action) =>
  db.prepare('SELECT metadata_json FROM audit_events WHERE action = ? ORDER BY created_at, rowid').all(action).map((row) => JSON.parse(row.metadata_json));

// --- AC-1: the writer's second path ---

test('replyToComment sends exactly { body } to the replies path and nothing else', async () => {
  const impl = fakeGitHub();
  const writer = new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl });
  const sent = await writer.replyToComment(REPO, PR, ROOT_ID, 'A reply.');
  assert.deepEqual(sent, { id: 901, htmlUrl: `https://github.com/${REPO}/pull/${PR}#discussion_r901` });
  assert.equal(impl.posts().length, 1);
  assert.equal(impl.posts()[0].path, REPLY_PATH);
  assert.deepEqual(impl.posts()[0].body, { body: 'A reply.' });
  assert.deepEqual(Object.keys(impl.posts()[0].body), ['body']);
});

test('the writer refuses an empty, an overlong or a widened reply body, and a comment id that is not one', async () => {
  const impl = fakeGitHub();
  const writer = new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl });
  for (const payload of [{ body: '' }, { body: '   ' }, { body: 'x'.repeat(601) }, { body: 'ok', extra: true }, { body: 'ok', event: 'COMMENT' }, 'ok', null]) {
    await assert.rejects(() => writer.request('POST', REPLY_PATH, payload), WriteViolation, JSON.stringify(payload));
  }
  await assert.rejects(() => writer.replyToComment(REPO, PR, 0, 'ok'), WriteViolation);
  await assert.rejects(() => writer.replyToComment(REPO, 0, ROOT_ID, 'ok'), WriteViolation);
  await assert.rejects(() => writer.request('POST', `/repos/acme/other/pulls/${PR}/comments/${ROOT_ID}/replies`, { body: 'ok' }), NotAllowlisted);
  // A well-formed reply body to each near-miss path, so the path check alone has to refuse it.
  for (const path of [
    `/repos/${REPO}/pulls/${PR}/comments/${ROOT_ID}`,
    `/repos/${REPO}/pulls/${PR}/comments/${ROOT_ID}/reactions`,
    `/repos/${REPO}/pulls/${PR}/comments/${ROOT_ID}/replies?x=1`,
    `/repos/${REPO}/pulls/${PR}/comments/${ROOT_ID}/replies/9`,
    `/repos/${REPO}/pulls/${PR}/comments/0/replies`,
    `/repos/${REPO}/issues/${PR}/comments/${ROOT_ID}/replies`,
  ]) {
    await assert.rejects(() => writer.request('POST', path, { body: 'ok' }), WriteViolation, path);
  }
  assert.equal(impl.calls.length, 0);
  // Exactly 600 characters is the bound, not over it.
  await writer.request('POST', REPLY_PATH, { body: 'x'.repeat(600) });
  assert.equal(impl.calls.length, 1);
});

// --- AC-3: the renderer ---

const render = (over = {}) => renderReply({ head: HEAD, finding: FINDING, score: score(), candidate: { evidence: EVIDENCE }, ...over });

test('a confirmed challenge quotes its decisive lines, the head and the challenge sentence', () => {
  const out = render();
  assert.deepEqual(out.references, ['src/cart.ts:12', 'src/pricing.ts:48']);
  assert.equal(out.challengeConfirmed, true);
  assert.equal(
    out.body,
    'Review Voice checked this at a1b2c3d. The claim rests on `src/cart.ts:12` and `src/pricing.ts:48`. ' +
      'An independent challenge confirmed it at those lines. This reply is built from the recorded review and is not repeated.',
  );
});

test('without a confirmed challenge the candidate evidence citations are quoted, with no challenge sentence', () => {
  for (const s of [score(null), score({ ...CONFIRMED, verdict: 'partly' }), undefined]) {
    const out = render({ score: s });
    assert.deepEqual(out.references, ['src/cart.ts:12', 'src/discount.ts:30-34']);
    assert.equal(out.challengeConfirmed, false);
    assert.ok(!out.body.includes('independent challenge'));
    assert.ok(out.body.includes('rests on `src/cart.ts:12` and `src/discount.ts:30-34`.'));
  }
  // One reference stands alone; three are joined with commas and "and".
  assert.ok(render({ score: undefined, candidate: { evidence: ['src/a.ts:1'] } }).body.includes('rests on `src/a.ts:1`.'));
  assert.ok(render({ score: undefined, candidate: { evidence: ['src/a.ts:1', 'src/b.ts:2', 'src/c.ts:3'] } }).body.includes('`src/a.ts:1`, `src/b.ts:2` and `src/c.ts:3`'));
});

test('references are deduplicated, kept in recorded order and capped at four', () => {
  const evidence = ['src/a.ts:1 and src/b.ts:2', 'src/a.ts:1 again', 'src/c.ts:3', 'src/d.ts:4', 'src/e.ts:5'];
  assert.deepEqual(render({ score: undefined, candidate: { evidence } }).references, ['src/a.ts:1', 'src/b.ts:2', 'src/c.ts:3', 'src/d.ts:4']);
  const decisive = ['src/b.ts:2', 'src/a.ts:1', 'src/b.ts:2', 'src/c.ts:3', 'src/d.ts:4', 'src/e.ts:5'];
  assert.deepEqual(render({ score: score({ ...CONFIRMED, decisive_evidence: decisive }) }).references, ['src/b.ts:2', 'src/a.ts:1', 'src/c.ts:3', 'src/d.ts:4']);
});

test('an unsafe reference is dropped, and a run with only unsafe ones renders nothing', () => {
  const unsafe = [
    '/Users/someone/.review-voice/runs/x/src/cart.ts:12',
    'C:\\work\\src\\cart.ts:12',
    '../other/src/cart.ts:12',
    './src/cart.ts:12',
    '~/src/cart.ts:12',
    'src/cart ts.ts:12',
    'src/`cart.ts:12',
    'src/.\u200b./b.ts:3',
    // A control character hides the leading `/`, splits a `..`, or rewrites the terminal preview.
    '\u001b/Users/someone/src/cart.ts:12',
    'src/.\u0085./b.ts:3',
    'src/\u001b[8mcart.ts:12',
    'src/cart.ts\u0007:12',
    'src/\u009bcart.ts:12',
    'src/done.ts:3',
    'src/consider.ts:3',
    'src/maybe.ts:3',
  ];
  for (const entry of unsafe) {
    assert.equal(render({ score: score({ ...CONFIRMED, decisive_evidence: [entry] }) }), null, entry);
  }
  const mixed = render({ score: score({ ...CONFIRMED, decisive_evidence: [...unsafe, 'src/cart.ts:12'] }) });
  assert.deepEqual(mixed.references, ['src/cart.ts:12']);
  assert.equal(render({ score: undefined, candidate: { evidence: ['no citation here', 'a time 10:30 is not one'] } }), null);
  // A space in an absolute path starts a citation on its relative-looking tail,
  // so a cited line that names the machine anywhere quotes nothing from it.
  const machine = [
    'Read /Users/someone/Library/Application Support/review-voice/runs/r1/src/cart.ts:12 first',
    '`/Users/someone/Library/Application Support/review-voice/clones/acme/web/src/cart.ts:12`',
    'C:\\Users\\Some One\\web\\src\\cart.ts:12',
    '~/My Projects/web/src/cart.ts:12',
  ];
  for (const entry of machine) assert.equal(render({ score: undefined, candidate: { evidence: [entry] } }), null, entry);
  assert.deepEqual(render({ score: undefined, candidate: { evidence: [...machine, 'src/cart.ts:12 sums the lines'] } }).references, ['src/cart.ts:12']);
  assert.equal(render({ score: undefined, candidate: undefined }), null);
});

test('a run with no head names the head it reviewed', () => {
  assert.ok(render({ head: null }).body.startsWith('Review Voice checked this at the head it reviewed. '));
  assert.ok(render({ head: 'abc' }).body.startsWith('Review Voice checked this at the head it reviewed. '));
});

test('every rendered body is at most 600 characters, holds no forbidden phrase and classifies as other', () => {
  const long = Array.from({ length: 4 }, (_, i) => `${'deep/'.repeat(15)}file${i}.ts:${i + 1}`);
  for (const out of [render(), render({ score: undefined }), render({ score: score({ ...CONFIRMED, decisive_evidence: long }) }), render({ head: null })]) {
    assert.ok(out !== null);
    assert.ok(out.body.length <= 600, String(out.body.length));
    assert.deepEqual(findForbiddenPhrases(out.body, DEFAULT_LIMITS.forbiddenPhrases), []);
    // The same body answers a question and a disagreement; neither reading is a stance.
    assert.equal(classifyReply(out.body), 'other');
    assert.equal(redact(out.body).text, out.body);
  }
  // Four references long enough to pass 600 render nothing rather than a cut body.
  const tooLong = Array.from({ length: 4 }, (_, i) => `${'deep/'.repeat(40)}file${i}.ts:${i + 1}`);
  assert.equal(render({ score: score({ ...CONFIRMED, decisive_evidence: tooLong }) }), null);
  // The bound holds on the redacted text, which is the text sent: the label is 7
  // characters longer than the token, so 595 characters before redaction are 602 after.
  const token = (pad) => `src/${'p'.repeat(pad + 1)}/xoxb-0123456789.ts:1`;
  const measured = render({ score: score({ ...CONFIRMED, decisive_evidence: [token(0)] }) }).body;
  assert.ok(measured.includes('[REDACTED:SLACK_TOKEN]'), measured);
  assert.equal(render({ score: score({ ...CONFIRMED, decisive_evidence: [token(602 - measured.length)] }) }), null);
  assert.equal(render({ score: score({ ...CONFIRMED, decisive_evidence: [token(600 - measured.length)] }) }).body.length, 600);
});

// --- AC-4: posting ---

test('posting disabled refuses with one audit row and exit 2, with no request and no attempt', async () => {
  await withDb(async (db) => {
    const runId = record(db);
    const impl = fakeGitHub();
    // Every statement the refusal prepares: the store is not read before the switch.
    const prepared = [];
    const prepare = db.prepare;
    db.prepare = (sql) => (prepared.push(sql), prepare.call(db, sql));
    const { exitCode, replies, refused: reasons } = await reply(db, impl, [question(runId)], { postingEnabled: false }).finally(() => {
      db.prepare = prepare;
    });
    assert.equal(prepared.length, 1, prepared.join('\n'));
    assert.match(prepared[0], /^\s*INSERT INTO audit_events/);
    assert.equal(exitCode, 2);
    assert.equal(replies[0].status, 'refused');
    assert.match(replies[0].reasons[0], /github_posting_enabled/);
    assert.deepEqual(reasons, replies[0].reasons);
    assert.equal(impl.calls.length, 0);
    const refused = audits(db, 'review_reply_refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].questions, 1);
    assert.equal(audits(db, 'review_reply_attempted').length, 0);
  });
});

test('without confirm the reply is previewed, the refusal is audited and nothing is sent', async () => {
  await withDb(async (db) => {
    const runId = record(db);
    const impl = fakeGitHub();
    const { exitCode, replies } = await reply(db, impl, [question(runId)], { confirm: false });
    assert.equal(exitCode, 0);
    assert.equal(replies[0].status, 'previewed');
    assert.equal(replies[0].key, `reply:${REPO}#${PR}:${ROOT_ID}`);
    assert.ok(replies[0].body.startsWith('Review Voice checked this at a1b2c3d.'));
    assert.match(replies[0].reasons[0], /--confirm/);
    assert.equal(impl.posts().length, 0);
    assert.equal(audits(db, 'review_reply_refused').length, 1);
    assert.equal(audits(db, 'review_reply_attempted').length, 0);
  });
});

test('a confirmed reply is attempted before the request, sent once with its metadata, and refused on its key after', async () => {
  await withDb(async (db) => {
    // Spelt apart from the question and --repository, so the writer's allowlist shows its source.
    const runId = record(db, { repository: 'Acme/Web' });
    let attemptedAtSend = null;
    const impl = fakeGitHub({
      onPost: () => {
        attemptedAtSend = audits(db, 'review_reply_attempted');
        return json({ id: 901, html_url: 'https://example.com/r901' });
      },
    });
    const q = question(runId);
    const { exitCode, replies } = await reply(db, impl, [q]);
    assert.equal(exitCode, 0);
    assert.equal(replies[0].status, 'sent');
    assert.deepEqual(replies[0].reply, { id: 901, url: 'https://example.com/r901' });
    assert.equal(attemptedAtSend.length, 1);
    assert.equal(attemptedAtSend[0].key, replies[0].key);
    assert.deepEqual(
      { run: attemptedAtSend[0].run, finding: attemptedAtSend[0].finding, rootCommentId: attemptedAtSend[0].rootCommentId, askedBy: attemptedAtSend[0].askedBy, stance: attemptedAtSend[0].stance },
      { run: runId, finding: 'rv_01', rootCommentId: ROOT_ID, askedBy: 'author', stance: 'question' },
    );
    // The one request: the replies path, exactly { body }, the redacted rendered text.
    const posts = impl.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, REPLY_PATH);
    assert.deepEqual(Object.keys(posts[0].body), ['body']);
    assert.equal(posts[0].body.body, redact(render().body).text);
    assert.deepEqual(impl.allowlists, [['Acme/Web']]);
    const sent = audits(db, 'review_reply_sent');
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['askedBy', 'attempt', 'finding', 'head', 'key', 'replyId', 'rootCommentId', 'run', 'stance', 'url']);
    assert.equal(sent[0].replyId, 901);
    assert.equal(sent[0].head, HEAD);

    // The same thread again: refused on the key, no request.
    const again = await reply(db, impl, [q]);
    assert.equal(again.exitCode, 0);
    assert.equal(again.replies[0].status, 'refused');
    assert.match(again.replies[0].reasons[0], /already sent/);
    assert.equal(impl.posts().length, 1);
    // A reworded question on the same thread is the same reply.
    const reworded = await reply(db, impl, [question(runId, { askedBy: 'someone-else', stance: 'reject' })]);
    assert.equal(reworded.replies[0].status, 'refused');
    assert.equal(impl.posts().length, 1);
    // A preview on the answered thread is refused too, not shown as a body to send.
    const preview = await reply(db, impl, [q], { confirm: false });
    assert.equal(preview.replies[0].status, 'refused');
    assert.match(preview.replies[0].reasons[0], /already sent/);
  });
});

test('a token-shaped reference is redacted in the preview, which is exactly the body sent', async () => {
  await withDb(async (db) => {
    const secret = 'src/ghp_abcdefghijklmnopqrstuvwxyz.ts:1';
    const runId = record(db, { scores: [score({ ...CONFIRMED, decisive_evidence: [secret] })] });
    const impl = fakeGitHub();
    const q = question(runId);
    const preview = await reply(db, impl, [q], { confirm: false });
    assert.ok(!preview.replies[0].body.includes('ghp_'), preview.replies[0].body);
    assert.ok(preview.replies[0].body.includes('[REDACTED:GITHUB_TOKEN]'), preview.replies[0].body);
    const { replies } = await reply(db, impl, [q]);
    assert.equal(replies[0].status, 'sent');
    const posted = impl.posts()[0].body.body;
    assert.equal(posted, preview.replies[0].body);
    assert.equal(replies[0].body, posted);
    assert.equal(redact(posted).text, posted);
    assert.equal(audits(db, 'review_reply_sent').length, 1);
  });
});

test('a 5xx is uncertain and blocks a retry; a 4xx is certain and does not', async () => {
  await withDb(async (db) => {
    const runId = record(db);
    const q = question(runId);
    const down = fakeGitHub({ onPost: () => new Response('down', { status: 502 }) });
    const first = await reply(db, down, [q]);
    assert.equal(first.exitCode, 1);
    assert.equal(first.replies[0].status, 'failed');
    const failed = audits(db, 'review_reply_failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 502);
    assert.equal(failed[0].uncertain, true);
    const retry = fakeGitHub();
    const blocked = await reply(db, retry, [q]);
    assert.equal(blocked.replies[0].status, 'refused');
    assert.match(blocked.replies[0].reasons[0], /may have posted/);
    assert.equal(retry.posts().length, 0);
  });
  await withDb(async (db) => {
    const runId = record(db);
    const q = question(runId);
    const refused = fakeGitHub({ onPost: () => new Response('{"message":"Not Found"}', { status: 404 }) });
    const first = await reply(db, refused, [q]);
    assert.equal(first.exitCode, 1);
    assert.equal(audits(db, 'review_reply_failed')[0].uncertain, false);
    const retry = fakeGitHub();
    assert.equal((await reply(db, retry, [q])).replies[0].status, 'sent');
    assert.equal(retry.posts().length, 1);
  });
});

test('a question whose run is of another repository, or has nothing to quote, is refused without a request', async () => {
  await withDb(async (db) => {
    const other = record(db, { repository: 'acme/other' });
    const bare = record(db, { scores: [score(null)], candidates: [candidate(['no citation'])] });
    const impl = fakeGitHub();
    const { exitCode, replies } = await reply(db, impl, [question(other), question(bare), question('no-such-run')]);
    assert.equal(exitCode, 0);
    assert.deepEqual(replies.map((r) => r.status), ['refused', 'refused', 'refused']);
    assert.match(replies[0].reasons[0], /not a recorded review of acme\/web/);
    assert.match(replies[1].reasons[0], /no recorded path:line evidence to quote/);
    assert.equal(impl.calls.length, 0);
    assert.deepEqual(impl.allowlists, []);
    assert.equal(audits(db, 'review_reply_refused').length, 3);
  });
});

const AUTH = '[minor] `src/auth.ts:84` - The session outlives the logout. A stolen cookie stays valid.';
const scoreFor = (candidateId, path, line, challenge, extra = {}) => ({ ...score(challenge), candidateId, path, line, ...extra });
const candidateFor = (candidateId, path, line, evidence) => ({ ...candidate(evidence), candidate_id: candidateId, path, line });

test('a reply quotes only the asked finding, from the score and candidate that backed it', async () => {
  for (const challenge of [{ ...CONFIRMED, decisive_evidence: ['src/auth.ts:84', 'src/session.ts:9'] }, null]) {
    await withDb(async (db) => {
      const runId = record(db, {
        output: `${MINOR}\n\n${AUTH}`,
        scores: [score(), scoreFor('auth', 'src/auth.ts', 84, challenge)],
        candidates: [candidate(EVIDENCE), candidateFor('auth', 'src/auth.ts', 84, ['`src/auth.ts:84` keeps the session', 'logout is at src/logout.ts:3'])],
      });
      const impl = fakeGitHub();
      const { replies } = await reply(db, impl, [question(runId, { findingId: 'rv_02', path: 'src/auth.ts', line: 84 })]);
      assert.equal(replies[0].status, 'sent');
      const body = impl.posts()[0].body.body;
      const quoted = challenge === null ? '`src/auth.ts:84` and `src/logout.ts:3`.' : '`src/auth.ts:84` and `src/session.ts:9`.';
      assert.ok(body.includes(`rests on ${quoted}`), body);
      assert.ok(!body.includes('cart'), body);
      assert.equal(body.includes('independent challenge'), challenge !== null);
    });
  }
});

test('a held, unverified or other-severity score at the same line never speaks for the posted finding', async () => {
  await withDb(async (db) => {
    const runId = record(db, {
      scores: [
        // A challenge the corrected line refused leaves a confirmed verdict on a held score.
        scoreFor('held', 'src/cart.ts', 12, { ...CONFIRMED, decisive_evidence: ['src/held.ts:1'] }, { eligible: false }),
        scoreFor('loud', 'src/cart.ts', 12, { ...CONFIRMED, decisive_evidence: ['src/loud.ts:2'] }, { severity: { severity: 'important' } }),
        scoreFor('own', 'src/cart.ts', 12, { ...CONFIRMED, decisive_evidence: ['src/own.ts:3'] }, { confidenceSource: 'analyst' }),
        score(null),
      ],
      candidates: [candidateFor('held', 'src/cart.ts', 12, ['src/held.ts:5']), candidate(EVIDENCE)],
    });
    const impl = fakeGitHub();
    const { replies } = await reply(db, impl, [question(runId)]);
    assert.equal(replies[0].status, 'sent');
    const body = impl.posts()[0].body.body;
    assert.ok(body.includes('rests on `src/cart.ts:12` and `src/discount.ts:30-34`.'), body);
    assert.ok(!body.includes('independent challenge'), body);
  });
  // With no score that verified it, nothing backs the finding, so nothing is quoted.
  await withDb(async (db) => {
    const runId = record(db, { scores: [scoreFor('cart', 'src/cart.ts', 12, CONFIRMED, { confidenceSource: 'analyst' })] });
    const impl = fakeGitHub();
    const { replies } = await reply(db, impl, [question(runId)]);
    assert.equal(replies[0].status, 'refused');
    assert.match(replies[0].reasons[0], /no recorded path:line evidence to quote/);
    assert.equal(impl.calls.length, 0);
  });
});

test('claimKey rechecks a reply key inside its transaction, so a second claim on the thread is refused', async () => {
  await withDb(async (db) => {
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    const key = `reply:${REPO}#${PR}:${ROOT_ID}`;
    assert.equal(typeof claimKey(db, key, subject, { run: 'r' }, 'review_reply_attempted'), 'string');
    const second = claimKey(db, key, subject, { run: 'r' }, 'review_reply_attempted');
    assert.match(second.blocked ?? '', /may have posted/);
    assert.equal(audits(db, 'review_reply_attempted').length, 1);
  });
});

// --- AC-5: the command, the line and the actions ---

function cli(args, dataDir) {
  try {
    // Run from the data directory, so the checkout's own config does not decide posting.
    const stdout = execFileSync(process.execPath, [bundle, ...args], { cwd: dataDir, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('reply is a command with its own help, dispatched beside outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reply-cli-'));
  try {
    const help = cli(['reply', '--help'], dir);
    assert.equal(help.code, 0);
    assert.ok(help.stdout.startsWith('review-voice reply --pr <number>'));
    for (const flag of ['--pr', '--repository', '--since', '--confirm', '--json']) assert.ok(help.stdout.includes(flag), flag);
    assert.match(help.stdout, /review_reply_/);
    // Exit 2 alone is also what posting off and no remote give here, so each refusal is told by its message.
    for (const args of [[], ['--pr', '0', '--repository', REPO], ['--pr', 'abc', '--repository', REPO], ['--pr', '1.5', '--repository', REPO]]) {
      const refused = cli(['reply', ...args], dir);
      assert.equal(refused.code, 2, args.join(' '));
      assert.match(refused.stderr, /--pr needs a pull request number/, args.join(' '));
    }
    for (const args of [['--repository', 'nonsense'], ['--repository', 'acme/web/extra'], ['--repository']]) {
      const refused = cli(['reply', '--pr', PR.toString(), ...args], dir);
      assert.equal(refused.code, 2, args.join(' '));
      assert.match(refused.stderr, /--repository takes owner\/repo/, args.join(' '));
    }
    const since = cli(['reply', '--pr', PR.toString(), '--repository', REPO, '--since', 'soon'], dir);
    assert.equal(since.code, 2);
    assert.match(since.stderr, /--since takes a number of days/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const source = read('plugins/review-voice/src/cli.ts');
  assert.match(source, /^ {4}case 'outcomes':\n.*\n\n {4}case 'reply':/m);
  // The outcomes help names the pending-question line.
  assert.match(read('plugins/review-voice/src/help.ts'), /awaiting a reply; run reply --pr/);
});

test('reply with posting off says why on stderr and in its JSON, with no pending question to carry the reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reply-cli-'));
  try {
    const text = cli(['reply', '--pr', PR.toString(), '--repository', REPO], dir);
    assert.equal(text.code, 2);
    assert.match(text.stdout, /No pending question/);
    assert.match(text.stderr, /github_posting_enabled is false.*nothing can be sent/);
    const asJson = cli(['reply', '--pr', PR.toString(), '--repository', REPO, '--json'], dir);
    assert.equal(asJson.code, 2);
    const parsed = JSON.parse(asJson.stdout);
    assert.deepEqual(parsed.replies, []);
    assert.match(parsed.refused[0], /github_posting_enabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ROOT_COMMENT = { id: ROOT_ID, path: 'src/cart.ts', line: 12, original_line: 12, body: '**minor** - The total skips the discount. A discounted cart is overcharged.', user: { login: 'review-bot-user' }, created_at: '2026-11-01T10:00:00Z' };

/** The reads `checkOutcomes` makes for one open thread with one question under it, asked by `asker`. */
const threadReads = (asker = 'author') => (call) => {
  const asked = { id: 600, in_reply_to_id: ROOT_ID, user: { login: asker }, body: 'Why does the discount matter here?', created_at: '2026-11-02T10:00:00Z' };
  if (call.path === '/graphql') {
    const nodes = [{ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: ROOT_ID }] } }];
    return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
  }
  if (call.path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
  if (call.path === `/repos/${REPO}/pulls/${PR}/comments`) return json([ROOT_COMMENT, asked]);
  if (call.path === `/repos/${REPO}/pulls/${PR}/reviews/77/comments`) return json([ROOT_COMMENT]);
  return undefined;
};

test('reply previews a pending question without --confirm, and posts it once with it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reply-cmd-'));
  const repo = join(dir, 'repo');
  const data = join(dir, 'data');
  mkdirSync(join(repo, '.review-voice'), { recursive: true });
  mkdirSync(data);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const config = (extra = '') => writeFileSync(join(repo, '.review-voice', 'config.yaml'), `writes:\n  github_posting_enabled: true\n${extra}`);
  config();
  const db = openDatabase(join(data, 'review-voice.db'));
  const runId = record(db);
  const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
  recordAudit(db, 'review_post_sent', subject, { attempt: recordAudit(db, 'review_post_attempted', subject, { run: runId }), head: HEAD, reviewId: 77 });
  db.close();
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, GITHUB_TOKEN: 't' });
  delete process.env.REVIEW_VOICE_CONFIG;
  const run = (impl, ...args) => runInProcess(['reply', '--pr', String(PR), '--repository', REPO, ...args], { fetchImpl: impl });
  try {
    const github = fakeGitHub({ onGet: threadReads() });
    const preview = await run(github);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /^src\/cart\.ts:12 author \(question\) previewed: no --confirm/m);
    assert.ok(preview.stdout.includes(`\n  ${render().body}\n`), preview.stdout);
    const asJson = await run(github, '--json');
    assert.equal(asJson.code, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    assert.deepEqual(Object.keys(parsed), ['questions', 'replies', 'refused']);
    assert.equal(parsed.questions[0].findingId, 'rv_01');
    assert.equal(parsed.replies[0].status, 'previewed');
    assert.equal(github.posts().length, 0);

    // Another pull request is left before any read, and the owner's own question is not one to answer.
    const other = fakeGitHub({ onGet: threadReads() });
    const elsewhere = await runInProcess(['reply', '--pr', String(PR + 1), '--repository', REPO, '--confirm'], { fetchImpl: other });
    assert.match(elsewhere.stdout, new RegExp(`No pending question on ${REPO}#${PR + 1}`));
    assert.equal(other.calls.length, 0);
    config('identity:\n  owner_reviewer: your-github-login\n');
    const owners = fakeGitHub({ onGet: threadReads('your-github-login') });
    assert.match((await run(owners, '--confirm')).stdout, /No pending question/);
    assert.equal(owners.posts().length, 0);
    config();

    const sent = await run(github, '--confirm');
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /^src\/cart\.ts:12 author \(question\) sent$/m);
    assert.equal(github.posts().length, 1);
    assert.equal(github.posts()[0].path, REPLY_PATH);
    assert.equal(github.posts()[0].body.body, render().body);
    const again = await run(github, '--confirm');
    assert.match(again.stdout, /refused: a reply on this thread was already sent/);
    assert.equal(github.posts().length, 1);
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'GITHUB_TOKEN', 'REVIEW_VOICE_CONFIG']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outcomes formats one line per pending question', () => {
  const line = pendingQuestionLine({ reviewRunId: 'r', findingId: 'rv_03', repository: REPO, pullNumber: PR, rootCommentId: 1, path: 'src/a.ts', line: 9, askedBy: 'author', askedAt: '', stance: 'question' });
  assert.equal(line, `${REPO}#${PR} rv_03 src/a.ts:9 question from author awaiting a reply; run reply --pr ${PR}`);
});

test('the audit actions carry the four reply rows', () => {
  const source = read('plugins/review-voice/src/store/audit.ts');
  for (const action of ['review_reply_attempted', 'review_reply_sent', 'review_reply_refused', 'review_reply_failed']) {
    assert.ok(source.includes(`'${action}'`), action);
  }
});

// --- AC-6: the documents ---

test('the ADR exists and is listed, ADR 0010 is amended, and the threat model and architecture name the reply', () => {
  const index = read('docs/adr/README.md');
  const listed = /\[0035\]\((0035-[^)]+)\)/.exec(index);
  assert.ok(listed, 'docs/adr/README.md lists ADR 0035');
  assert.ok(existsSync(join(root, 'docs/adr', listed[1])), `${listed[1]} exists`);
  const adr = read(join('docs/adr', listed[1]));
  assert.match(adr, /replyToComment/);
  assert.match(adr, /classifyReply/);
  assert.match(index, /\[0010\]\([^)]+\) \| [^|]+ \| [^|]*0035/);
  const amendment = /## Amendment - \d{4}-\d{2}-\d{2}\n([\s\S]*?)(?=\n## |$)/g;
  const amended = [...read('docs/adr/0010-review-verdict-posting.md').matchAll(amendment)].some((m) => m[1].includes('replyToComment'));
  assert.ok(amended, 'a dated amendment of ADR 0010 names replyToComment');
  assert.match(read('docs/THREAT-MODEL.md'), /replyToComment/);
  const architecture = read('docs/ARCHITECTURE.md');
  const posting = architecture.slice(architecture.indexOf('### Posting'), architecture.indexOf('### The watcher'));
  assert.match(posting, /\*\*Replies\*\* \(ADR 0035\)/);
  assert.match(posting, /review_reply_attempted/);
});

// --- Part B: the metrics, the scope block and the watcher ---

test('evaluate reports posted replies and the fixed rate of replied findings as goals, null with none', async () => {
  await withDb(async (db) => {
    const find = (name) => computeMetrics(db).find((m) => m.name === name);
    for (const name of ['posted_replies', 'replied_fixed_rate']) {
      assert.equal(find(name).value, null, name);
      assert.equal(find(name).kind, 'goal', name);
      assert.equal(find(name).target, 'no target', name);
    }
    const runId = record(db);
    assert.equal((await reply(db, fakeGitHub(), [question(runId)])).replies[0].status, 'sent');
    // Right after a first reply nothing is decided, so the rate is no data, not 0.
    assert.deepEqual(replyStats(db), { replied: 1, fixed: 0, dismissed: 0, fixedRate: null });
    assert.equal(find('posted_replies').value, 1);
    assert.equal(find('replied_fixed_rate').value, null);
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    for (const finding of ['rv_02', 'rv_03', 'rv_04']) recordAudit(db, 'review_reply_sent', subject, { run: runId, finding });
    const outcome = (findingId, name, strength) =>
      saveOutcome(db, { reviewRunId: runId, findingId, repository: REPO, pullNumber: PR, commentId: 1, outcome: name, strength, evidence: 'e', checkedAt: '2026-11-03T00:00:00Z', decidedBy: null });
    // A weak outcome alone decides nothing either.
    outcome('rv_03', 'open', 'weak');
    assert.deepEqual(replyStats(db), { replied: 4, fixed: 0, dismissed: 0, fixedRate: null });
    assert.equal(find('replied_fixed_rate').value, null);
    // Of four replied findings one was fixed, one dismissed, one is open (weak) and one has no outcome yet; rv_05 was fixed with no reply.
    outcome('rv_01', 'fixed', 'strong');
    outcome('rv_02', 'dismissed', 'strong');
    outcome('rv_05', 'fixed', 'strong');
    assert.deepEqual(replyStats(db), { replied: 4, fixed: 1, dismissed: 1, fixedRate: 0.5 });
    // Every posted finding's rate is 2 of 3 here, so this tells the replied rate apart from it.
    assert.equal(find('replied_fixed_rate').value, 0.5);
    // Only a sent reply counts. Finding ids restart in every run, so each case is its own run with a strong outcome on its rv_01:
    // a preview, a 404 that was attempted and not sent, and a run with no reply row at all.
    const previewRun = record(db);
    assert.equal((await reply(db, fakeGitHub(), [question(previewRun, { rootCommentId: 556 })], { confirm: false })).replies[0].status, 'previewed');
    const failedRun = record(db);
    const notFound = fakeGitHub({ onPost: () => new Response('{"message":"Not Found"}', { status: 404 }) });
    assert.equal((await reply(db, notFound, [question(failedRun, { rootCommentId: 557 })])).replies[0].status, 'failed');
    const quietRun = record(db);
    for (const [other, name] of [[previewRun, 'fixed'], [failedRun, 'dismissed'], [quietRun, 'dismissed']]) {
      saveOutcome(db, { reviewRunId: other, findingId: 'rv_01', repository: REPO, pullNumber: PR, commentId: 1, outcome: name, strength: 'strong', evidence: 'e', checkedAt: '2026-11-03T00:00:00Z', decidedBy: null });
    }
    assert.deepEqual(replyStats(db), { replied: 4, fixed: 1, dismissed: 1, fixedRate: 0.5 });
    assert.equal(find('posted_replies').value, 4);
    assert.equal(find('replied_fixed_rate').value, 0.5);
    assert.match(find('replied_fixed_rate').basis, /1 fixed \/ \(2 fixed or dismissed\) of 4 replied/);
  });
});

test('a sent reply changes neither the body the scope block ends nor the review key', async () => {
  await withDb(async (db) => {
    const runId = record(db);
    const github = fakeGitHub({
      onGet: (call) => {
        if (call.path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
        if (call.path.endsWith('/reviews')) return json([]);
        if (call.path.endsWith('/check-runs')) {
          return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-11-01T10:00:00Z' }] });
        }
        if (call.path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
        return undefined;
      },
    });
    const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} });
    const verdict = () =>
      computeVerdict({ db, client, repository: REPO, pullNumber: PR, head: HEAD, review: MINOR, runId, owner: 'your-github-login', policy: { scopeBlock: true } });
    const before = await verdict();
    assert.equal(before.exitCode, 0, JSON.stringify(before.output));
    assert.match(before.output.payload.body, /<details><summary>Review scope<\/summary>/);
    assert.equal((await reply(db, github, [question(runId)])).replies[0].status, 'sent');
    assert.equal(audits(db, 'review_reply_sent').length, 1);
    const after = await verdict();
    assert.equal(after.output.payload.body, before.output.payload.body);
    assert.equal(after.output.key, before.output.key);
  });
});

test('the watcher has no reply path and no reply setting, so it never replies unattended', () => {
  // The owner admitted the reply for `reply --confirm` only; a watch.reply switch would be a path left switched off.
  const watch = join(root, 'plugins/review-voice/src/watch');
  for (const name of readdirSync(watch)) {
    assert.doesNotMatch(readFileSync(join(watch, name), 'utf8'), /publish\/reply|postReplies|replyToComment/, name);
  }
  assert.equal('reply' in defaultWatchConfig(), false);
  const dir = mkdtempSync(join(tmpdir(), 'rv-reply-watch-'));
  try {
    writeFileSync(join(dir, 'config.yaml'), 'watch:\n  reply: true\n');
    const config = loadConfig(dir, join(dir, 'no-baseline.yaml'), join(dir, 'config.yaml'));
    assert.ok(config.warnings.includes('watch.reply is not a setting Review Voice reads; ignoring it.'), config.warnings.join('\n'));
    assert.equal('reply' in config.watch, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ADR 0029 is amended with the reply row and its index row mentions replies', () => {
  const amendment = /## Amendment - \d{4}-\d{2}-\d{2}[^\n]*\n([\s\S]*?)(?=\n## |$)/g;
  const amended = [...read('docs/adr/0029-posted-findings-are-followed-to-an-outcome.md').matchAll(amendment)];
  assert.ok(amended.some((m) => m[1].includes('review_reply_sent')), 'a dated amendment of ADR 0029 names review_reply_sent');
  const row = read('docs/adr/README.md').split('\n').find((line) => line.startsWith('| [0029]'));
  assert.match(row, /repl/);
});

test('the watcher and architecture documents give the writer two paths, and the outcomes line never comes from an acknowledgement', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const watcher = flat(read('docs/WATCHER.md'));
  assert.doesNotMatch(watcher, /single endpoint/);
  assert.doesNotMatch(flat(read('docs/ARCHITECTURE.md')), /single endpoint/);
  const outcomes = watcher.slice(watcher.indexOf('### `outcomes`'), watcher.indexOf('## Verdict policy'));
  assert.match(outcomes, /An acknowledgement gets none, even with a question mark/);
  const help = flat(read('plugins/review-voice/src/help.ts').replace(/',\n\s*'/g, ' '));
  assert.match(help, /newest reply from someone other than the poster, the owner or a bot asks a question/);
  assert.match(help, /an acknowledgement never does, even with a question mark/);
});
