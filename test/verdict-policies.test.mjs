/**
 * Verdict policies (docs/adr/0028): five verdict behaviours are settings whose
 * defaults are the original rules, plus a thread re-check before posting. The
 * head guard, the single writer endpoint and the idempotency key stay fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { DEFAULT_VERDICT_POLICY, decide } from '../plugins/review-voice/src/publish/verdict.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'your-github-login';
const APPROVAL_URL = `https://github.com/${REPO}/pull/${PR}#pullrequestreview-55`;

const FAILING = 'Heads up: `build` failing on this head.';
const RERUN = 'Heads up: `e2e` need a rerun.';

// ---------------------------------------------------------------------------
// The table: every setting against every CI state and every mapped event.
// ---------------------------------------------------------------------------

const EVENTS = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'];
const STATES = ['green', 'pending', 'red', 'needs-rerun'];
const failedEntry = { name: 'build', source: 'check-run', result: 'failed', detail: 'failure' };
const rerunEntry = { name: 'e2e', source: 'check-run', result: 'rerun', detail: 'timed_out' };

/** Today's rules, which the defaults must reproduce exactly. */
function original(state, event, { needsHuman = false } = {}) {
  if (state === 'needs-rerun') return { event: null, action: 'wait', exitCode: 6, annotations: [] };
  if (event === 'APPROVE' && needsHuman) return { event: 'COMMENT', action: 'post', exitCode: 0, annotations: [] };
  if (event === 'APPROVE' && state === 'red') return { event: 'COMMENT', action: 'post', exitCode: 0, annotations: [], cappedByCi: true };
  if (event === 'APPROVE' && state === 'pending') return { event: 'APPROVE', action: 'wait', exitCode: 4, annotations: [] };
  return { event, action: 'post', exitCode: 0, annotations: [] };
}

const SETTINGS = [
  { name: 'defaults', policy: {}, expect: original },
  { name: 'explicit defaults', policy: { ...DEFAULT_VERDICT_POLICY }, expect: original },
  {
    name: 'ci_pending: proceed',
    policy: { ciPending: 'proceed' },
    expect: (state, event) =>
      state === 'pending' && event === 'APPROVE'
        ? { event: 'APPROVE', action: 'post', exitCode: 0, annotations: [] }
        : original(state, event),
  },
  {
    name: 'ci_red: annotate',
    policy: { ciRed: 'annotate' },
    expect: (state, event) =>
      state === 'red'
        ? { event, action: 'post', exitCode: 0, annotations: [FAILING], cappedByCi: false }
        : original(state, event),
  },
  {
    name: 'ci_needs_rerun: annotate',
    policy: { ciNeedsRerun: 'annotate' },
    expect: (state, event) =>
      state === 'needs-rerun'
        ? { event, action: 'post', exitCode: 0, annotations: [RERUN] }
        : original(state, event),
  },
  {
    name: 'cap_approval: true on a high-complexity change',
    policy: {},
    needsHuman: true,
    expect: (state, event) => original(state, event, { needsHuman: true }),
  },
  {
    name: 'cap_approval: false on a high-complexity change',
    policy: { capApproval: false },
    needsHuman: true,
    expect: original,
  },
  {
    name: 'carry_approval_on_unchanged with a standing approval',
    policy: { carryApprovalOnUnchanged: true },
    carried: APPROVAL_URL,
    // Only a clean approval carries; any other event is news, so it posts as usual.
    expect: (state, event) =>
      event === 'APPROVE'
        ? { event: null, action: 'carry', exitCode: 0, annotations: [], carriedReviewUrl: APPROVAL_URL }
        : original(state, event),
  },
];

for (const setting of SETTINGS) {
  test(`verdict table: ${setting.name}`, () => {
    for (const state of STATES) {
      for (const mapped of EVENTS) {
        const decision = decide({
          mapped,
          headMoved: false,
          ci: state,
          failed: state === 'red' ? [failedEntry] : [],
          rerun: state === 'needs-rerun' ? [rerunEntry] : [],
          recheck: false,
          needsHuman: setting.needsHuman === true,
          carriedReviewUrl: setting.carried ?? null,
          policy: setting.policy,
        });
        const want = setting.expect(state, mapped);
        const label = `${setting.name}, CI ${state}, mapped ${mapped}`;
        assert.equal(decision.event, want.event, `${label}: event`);
        assert.equal(decision.action, want.action, `${label}: action`);
        assert.equal(decision.exitCode, want.exitCode, `${label}: exit`);
        assert.deepEqual(decision.annotations, want.annotations, `${label}: annotations`);
        assert.equal(decision.carriedReviewUrl, want.carriedReviewUrl ?? null, `${label}: carriedReviewUrl`);
        if (want.cappedByCi !== undefined) assert.equal(decision.cappedByCi, want.cappedByCi, `${label}: cappedByCi`);
        if (state === 'needs-rerun' && want.action !== 'carry') {
          assert.ok(decision.reasons.some((reason) => reason.includes('e2e (timed_out)')), `${label}: the reasons name the check`);
        }
      }
    }
  });
}

test('a moved head is exit 3 under every setting, carry included', () => {
  for (const setting of SETTINGS) {
    const decision = decide({
      mapped: 'APPROVE',
      headMoved: true,
      ci: null,
      recheck: false,
      carriedReviewUrl: setting.carried ?? null,
      policy: setting.policy,
    });
    assert.equal(decision.exitCode, 3, setting.name);
    assert.equal(decision.action, 'refuse', setting.name);
  }
});

test('--recheck still asks for green CI whatever the CI settings say', () => {
  const relaxed = { ciPending: 'proceed', ciRed: 'annotate', ciNeedsRerun: 'annotate' };
  const at = (ci) =>
    decide({ mapped: 'APPROVE', headMoved: false, ci, failed: [failedEntry], rerun: [rerunEntry], recheck: true, policy: relaxed });
  assert.equal(at('pending').exitCode, 4);
  assert.equal(at('red').exitCode, 5);
  assert.equal(at('needs-rerun').exitCode, 6);
  assert.equal(at('green').exitCode, 0);
  assert.deepEqual(at('green').annotations, []);
});

test('cap_approval: false lets --recheck re-check a high-complexity approval', () => {
  const recheck = (policy) =>
    decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: true, needsHuman: true, policy });
  assert.equal(recheck({}).exitCode, 2);
  const uncapped = recheck({ capApproval: false });
  assert.equal(uncapped.exitCode, 0);
  assert.equal(uncapped.event, 'APPROVE');
});

test('an annotation names at most five checks, each once, sorted', () => {
  const failed = ['f', 'b', 'a', 'b', 'e', 'c', 'd'].map((name) => ({ ...failedEntry, name }));
  const decision = decide({ mapped: 'APPROVE', headMoved: false, ci: 'red', failed, recheck: false, policy: { ciRed: 'annotate' } });
  assert.deepEqual(decision.annotations, ['Heads up: `a`, `b`, `c`, `d`, `e` failing on this head.']);
});

test('check names are untrusted: one line of inline code, no backticks, at most 60 characters', () => {
  const hostile = 'lint\n\n[click me](https://example.com/x) @release-bot `rm -rf`\u0007\u202e\u2066\u200b\ufeff';
  const long = 'x'.repeat(80);
  // 58 characters, then an astral one that a UTF-16 cut at 59 would split.
  const astral = `${'w'.repeat(58)}\u{1F600}${'z'.repeat(10)}`;
  const failed = [hostile, long, astral, hostile].map((name) => ({ ...failedEntry, name }));
  const decision = decide({ mapped: 'APPROVE', headMoved: false, ci: 'red', failed, recheck: false, policy: { ciRed: 'annotate' } });
  assert.deepEqual(decision.annotations, [
    `Heads up: \`lint [click me](https://example.com/x) @release-bot rm -rf\`, \`${'w'.repeat(58)}\u{1F600}…\`, \`${'x'.repeat(59)}…\` failing on this head.`,
  ]);
  assert.doesNotMatch(decision.annotations[0], /[\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/);
  assert.ok(decision.annotations[0].isWellFormed(), 'no lone surrogate');
  assert.doesNotMatch(decision.annotations[0], /\n/);
});

test('carry needs a clean approval: a held-back finding or an uncovered carry is not carried', () => {
  const base = { mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false, carriedReviewUrl: APPROVAL_URL, policy: { carryApprovalOnUnchanged: true } };
  assert.equal(decide(base).action, 'carry');
  assert.equal(decide({ ...base, mapped: 'COMMENT', heldBackApproval: true }).action, 'post');
  assert.equal(decide({ ...base, heldBackApproval: true }).action, 'post');
  const uncovered = decide({ ...base, uncoveredCarry: true });
  assert.equal(uncovered.action, 'post');
  assert.equal(uncovered.event, 'COMMENT');
});

// ---------------------------------------------------------------------------
// End to end through computeVerdict and postReview, with GitHub stubbed.
// ---------------------------------------------------------------------------

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

const CLEAN = 'No actionable findings.';
const MINOR_PROSE = 'The total skips the discount. A discounted cart is overcharged.';
const MINOR = `[minor] \`src/cart.ts:12\` - ${MINOR_PROSE}`;
const limits = { maxDecisionPoints: 40, maxHunkDecisionPoints: 15, sensitivePaths: [] };
const HIGH = { level: 'high', decisionPoints: 80, sensitivePaths: [], densestHunk: null, limits, reasons: ['80 decision points added'] };
const UNCHANGED = {
  kind: 'unchanged',
  since: 'd'.repeat(40),
  priorRunId: null,
  priorReviewedAt: null,
  mergeBase: 'e'.repeat(40),
  reason: 'base-merged',
};

const IMPORTANT = '[important] `src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';
const approval = (extra = {}) => ({
  id: 55,
  user: { login: OWNER },
  state: 'APPROVED',
  commit_id: UNCHANGED.since,
  html_url: APPROVAL_URL,
  ...extra,
});

function audits(db, action) {
  return db
    .prepare('SELECT metadata_json FROM audit_events WHERE action = ? ORDER BY created_at, rowid')
    .all(action)
    .map((row) => JSON.parse(row.metadata_json));
}

function record(db, output, scores = [], extra = {}) {
  return recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores, ...extra });
}

function verdict(db, impl, review, extra = {}) {
  return computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, owner: OWNER, ...extra });
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

test('defaults change nothing in the verdict output beyond two empty fields', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { exitCode, output } = await verdict(db, fakeGitHub({ checks: [RED] }), CLEAN);
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.payload.body, 'No problems found, but not approving while CI is red.');
    assert.deepEqual(output.annotations, []);
    assert.equal(output.carriedReviewUrl, null);
  });
});

test('ci_red: annotate posts the approval with the note as the last line of the body', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { exitCode, output } = await verdict(db, fakeGitHub({ checks: [RED] }), CLEAN, { policy: { ciRed: 'annotate' } });
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'APPROVE');
    assert.deepEqual(output.annotations, [FAILING]);
    assert.equal(output.payload.body, `No problems found.\n\n${FAILING}`);
    assert.deepEqual(output.payload.comments, []);
  });
});

test('annotations leave inline comments alone and are not part of the idempotency key', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const capped = await verdict(db, fakeGitHub({ checks: [RED] }), MINOR);
    const annotated = await verdict(db, fakeGitHub({ checks: [RED] }), MINOR, { policy: { ciRed: 'annotate' } });
    assert.equal(capped.output.event, 'COMMENT');
    assert.equal(annotated.output.event, 'COMMENT');
    assert.deepEqual(annotated.output.payload.comments, capped.output.payload.comments);
    assert.equal(annotated.output.payload.body, `${capped.output.payload.body}\n\n${FAILING}`);
    assert.equal(annotated.output.key, capped.output.key);
  });
});

test('post sends the annotation in the body', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const impl = fakeGitHub({ checks: [RED] });
    const { exitCode, output } = await post(db, impl, CLEAN, { policy: { ciRed: 'annotate' } });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    assert.equal(output.status, 'sent');
    const [sent] = impl.posts();
    assert.equal(sent.body.event, 'APPROVE');
    assert.equal(sent.body.body, `No problems found.\n\n${FAILING}`);
    assert.equal(output.key, output.verdict.key);
  });
});

test('the CI re-read before an approval applies the policy and rewrites the note to match', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    // Green for the verdict, red at the moment of sending.
    const impl = fakeGitHub({ checks: [GREEN, RED] });
    const { exitCode, output } = await post(db, impl, CLEAN, { policy: { ciRed: 'annotate' } });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    const [sent] = impl.posts();
    assert.equal(sent.body.event, 'APPROVE');
    assert.equal(sent.body.body, `No problems found.\n\n${FAILING}`);
    assert.deepEqual(output.verdict.annotations, [FAILING]);
    // The key is the green verdict's: the note follows CI, the review does not.
    const greenKey = (await verdict(db, fakeGitHub(), CLEAN)).output.key;
    assert.equal(output.key, greenKey);
  });
});

test('the CI re-read still refuses a red approval under the default', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const impl = fakeGitHub({ checks: [GREEN, RED] });
    const { exitCode } = await post(db, impl, CLEAN);
    assert.equal(exitCode, 5);
    assert.equal(impl.posts().length, 0);
  });
});

test('ci_pending: proceed approves at the verdict and at the re-read', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const impl = fakeGitHub({ checks: [PENDING] });
    const { exitCode, output } = await post(db, impl, CLEAN, { policy: { ciPending: 'proceed' } });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    assert.equal(impl.posts().length, 1);
    assert.equal(impl.posts()[0].body.body, 'No problems found.');
  });
});

test('cap_approval: false approves a clean high-complexity run; the local fields stay', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, [], { complexity: HIGH });
    const capped = await verdict(db, fakeGitHub(), CLEAN);
    assert.equal(capped.output.event, 'COMMENT');

    const { exitCode, output } = await verdict(db, fakeGitHub(), CLEAN, { policy: { capApproval: false } });
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.payload.body, 'No problems found.');
    assert.doesNotMatch(JSON.stringify(output.payload), /human|complex/i);
    assert.match(output.humanReviewNote, /Needs a human reviewer/);
    assert.equal(output.wouldHaveEvent, 'APPROVE');
    assert.equal(output.wouldHaveSummary, capped.output.wouldHaveSummary);
  });
});

test('carry: an unchanged scope with the owner\'s standing approval carries and posts nothing', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, [], { scope: UNCHANGED });
    const reviews = [approval()];
    const policy = { carryApprovalOnUnchanged: true };

    const computed = await verdict(db, fakeGitHub({ reviews }), CLEAN, { policy });
    assert.equal(computed.exitCode, 0);
    assert.equal(computed.output.action, 'carry');
    assert.equal(computed.output.event, null);
    assert.equal(computed.output.carriedReviewUrl, APPROVAL_URL);
    assert.equal(computed.output.payload, null);

    const impl = fakeGitHub({ reviews });
    const { exitCode, output } = await post(db, impl, CLEAN, { policy });
    assert.equal(exitCode, 0);
    assert.equal(output.carried, true);
    assert.equal(output.reviewUrl, APPROVAL_URL);
    assert.equal(impl.posts().length, 0);
    assert.deepEqual(audits(db, 'review_carried'), [{ repository: REPO, pull: PR, head: HEAD, reviewUrl: APPROVAL_URL }]);

    // Without --confirm it is a preview: the same answer, and nothing recorded.
    const preview = await post(db, fakeGitHub({ reviews }), CLEAN, { policy, confirm: false, event: undefined });
    assert.equal(preview.output.status, 'carried');
    assert.equal(audits(db, 'review_carried').length, 1);
  });
});

test('carry: an approval of another commit, by someone else, or of a request for changes is not carried', async () => {
  await withDb(async (db) => {
    const policy = { carryApprovalOnUnchanged: true };
    record(db, CLEAN, [], { scope: UNCHANGED });
    const older = await verdict(db, fakeGitHub({ reviews: [approval({ commit_id: 'f'.repeat(40) })] }), CLEAN, { policy });
    assert.equal(older.output.action, 'post');
    assert.ok(older.output.reasons.some((reason) => reason.includes('not carried')));

    const colleague = await verdict(db, fakeGitHub({ reviews: [approval({ user: { login: 'a-colleague' } })] }), CLEAN, { policy });
    assert.equal(colleague.output.action, 'post');
  });
  await withDb(async (db) => {
    record(db, IMPORTANT, [verified('src/pay.ts', 8, 'important')], { scope: UNCHANGED });
    const { output } = await verdict(db, fakeGitHub({ reviews: [approval()] }), IMPORTANT, { policy: { carryApprovalOnUnchanged: true } });
    assert.equal(output.action, 'post');
    assert.equal(output.event, 'REQUEST_CHANGES');
  });
});

test('carry: a dismissed approval, or the setting off, takes the normal path', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, [], { scope: UNCHANGED });
    const dismissed = [approval({ state: 'DISMISSED' })];
    const standing = [approval()];

    const afterDismissal = await verdict(db, fakeGitHub({ reviews: dismissed }), CLEAN, { policy: { carryApprovalOnUnchanged: true } });
    assert.equal(afterDismissal.output.action, 'post');
    assert.equal(afterDismissal.output.event, 'APPROVE');

    const off = fakeGitHub({ reviews: standing });
    const byDefault = await verdict(db, off, CLEAN);
    assert.equal(byDefault.output.action, 'post');
    assert.ok(!off.calls.some((c) => c.path.endsWith('/reviews')), 'reviews are not read with the setting off');
  });
});

test('carry: a full scope is never carried', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { output } = await verdict(db, fakeGitHub({ reviews: [approval()] }), CLEAN, { policy: { carryApprovalOnUnchanged: true } });
    assert.equal(output.action, 'post');
  });
});

const raised = (login, line = 12) => ({
  id: 900,
  user: { login },
  path: 'src/cart.ts',
  line,
  body: `${MINOR_PROSE}`,
  html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r900`,
});

test('thread re-check: a finding someone else raised meanwhile refuses with exit 8 and sends nothing', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({ inline: [raised('a-colleague')] });
    const { exitCode, output } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 8);
    assert.equal(output.refused, 'thread-changed');
    assert.deepEqual(output.findings, [
      { path: 'src/cart.ts', line: 12, raisedBy: 'a-colleague', commentUrl: `https://github.com/${REPO}/pull/${PR}#discussion_r900` },
    ]);
    assert.equal(impl.posts().length, 0);
  });
});

test('thread re-check: verdict.recheck_thread_before_post does what the flag does', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({ conversation: [{ ...raised('a-colleague'), path: undefined, line: undefined, body: `src/cart.ts:12 ${MINOR_PROSE}` }] });
    const { exitCode, output } = await post(db, impl, MINOR, { event: 'COMMENT', policy: { recheckThreadBeforePost: true } });
    assert.equal(exitCode, 8);
    assert.equal(output.findings[0].raisedBy, 'a-colleague');
    assert.equal(impl.posts().length, 0);
  });
});

test('thread re-check: the token user\'s own comments and unrelated ones do not hold the post', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const unrelated = { ...raised('a-colleague', 80), body: 'Please rename this helper for clarity.' };
    const impl = fakeGitHub({ inline: [raised(OWNER), unrelated] });
    const { exitCode, output } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    assert.equal(output.status, 'sent');
    assert.equal(impl.posts().length, 1);
  });
});

test('thread re-check: off by default, so the thread is not read', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({ inline: [raised('a-colleague')] });
    const { exitCode } = await post(db, impl, MINOR, { event: 'COMMENT' });
    assert.equal(exitCode, 0);
    assert.ok(!impl.calls.some((c) => c.path.endsWith('/comments')));
  });
});

const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';

test('the key ignores annotations: after CI changes on the same head, a sent review is not sent again', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const policy = { ciRed: 'annotate' };
    const first = await post(db, fakeGitHub({ checks: [RED] }), CLEAN, { policy });
    assert.equal(first.output.status, 'sent');

    const impl = fakeGitHub({ checks: [GREEN] });
    const again = await post(db, impl, CLEAN, { policy });
    assert.equal(again.exitCode, 2);
    assert.match(again.output.reasons.join(' '), /already sent/);
    assert.equal(impl.posts().length, 0);
  });
});

test('the key ignores annotations: an uncertain attempt still blocks a retry after CI changes', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const policy = { ciRed: 'annotate' };
    const failing = fakeGitHub({ checks: [RED], onPost: () => json({ message: 'boom' }, 502) });
    const first = await post(db, failing, CLEAN, { policy });
    assert.equal(first.output.status, 'failed');

    const impl = fakeGitHub({ checks: [GREEN] });
    const retry = await post(db, impl, CLEAN, { policy });
    assert.equal(retry.exitCode, 2);
    assert.match(retry.output.reasons.join(' '), /no definite answer/);
    assert.equal(impl.posts().length, 0);
  });
});

test('thread re-check runs before the approval re-read, which stays last before the send', async () => {
  await withDb(async (db) => {
    record(db, NIT, [verified('src/cart.ts', 40, 'nit')]);
    const impl = fakeGitHub();
    const { exitCode, output } = await post(db, impl, NIT, { recheckThread: true });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    const last = (test) => impl.calls.findLastIndex(test);
    const threadRead = last((c) => c.path.endsWith('/comments'));
    const headRead = last((c) => /\/pulls\/\d+$/.test(c.path));
    const ciRead = last((c) => c.path.endsWith('/check-runs'));
    const send = last((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
    assert.ok(threadRead > 0, 'the thread was read');
    assert.ok(threadRead < headRead && threadRead < ciRead, 'thread reads precede the final head and CI reads');
    assert.ok(headRead < send && ciRead < send);
  });
});

test('thread re-check: a colleague\'s review body citing path:line refuses with exit 8', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const reviewUrl = `https://github.com/${REPO}/pull/${PR}#pullrequestreview-77`;
    const reviews = [{ id: 77, user: { login: 'a-colleague' }, state: 'COMMENTED', body: `src/cart.ts:12 ${MINOR_PROSE}`, html_url: reviewUrl }];
    const impl = fakeGitHub({ reviews });
    const { exitCode, output } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 8);
    assert.deepEqual(output.findings, [{ path: 'src/cart.ts', line: 12, raisedBy: 'a-colleague', commentUrl: reviewUrl }]);
    assert.equal(impl.posts().length, 0);
  });
});

const BEFORE_RUN = '2000-01-01T00:00:00Z';
const AFTER_RUN = '2999-01-01T00:00:00Z';

test('thread re-check: a close comment made before the run started does not hold the post', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({ inline: [{ ...raised('a-colleague'), created_at: BEFORE_RUN }] });
    const { exitCode, output } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    assert.equal(impl.posts().length, 1);
  });
});

test('thread re-check: the same comment made after the run started holds it', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const impl = fakeGitHub({ inline: [{ ...raised('a-colleague'), created_at: AFTER_RUN }] });
    const { exitCode } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 8);
    assert.equal(impl.posts().length, 0);
  });
});

test('thread re-check: an author reply quoting the tool\'s earlier comment does not hold the post', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')]);
    const ownEarlier = { ...raised(OWNER), id: 500, created_at: BEFORE_RUN };
    const reply = { ...raised('pr-author'), id: 501, in_reply_to_id: 500, created_at: AFTER_RUN, body: `> ${MINOR_PROSE}\n\nFixed in the next push.` };
    const impl = fakeGitHub({ inline: [ownEarlier, reply] });
    const { exitCode, output } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 0, JSON.stringify(output.reasons));
    assert.equal(impl.posts().length, 1);
  });
});

test('thread re-check: a finding is matched on its recorded claim and failure mode, not its prose', async () => {
  await withDb(async (db) => {
    const candidate = {
      candidate_id: 'cand_001',
      path: 'src/cart.ts',
      line: 12,
      category: 'correctness',
      severity: 'minor',
      claim: 'Coupon codes are ignored when the checkout total is computed',
      failure_mode: 'shoppers holding coupons pay full price',
      evidence: ['src/cart.ts:12'],
      technical_confidence: 0.9,
    };
    record(db, MINOR, [verified('src/cart.ts', 12, 'minor')], { candidates: [candidate] });
    const comment = { ...raised('a-colleague'), body: 'Coupon codes are ignored here, so shoppers holding coupons pay full price at checkout.' };
    const impl = fakeGitHub({ inline: [comment] });
    const { exitCode } = await post(db, impl, MINOR, { event: 'COMMENT', recheckThread: true });
    assert.equal(exitCode, 8);
    assert.equal(impl.posts().length, 0);
  });
});

test('cap_approval: false keeps the stale request-for-changes note when CI still caps the approval', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, [], { complexity: HIGH });
    const reviews = [{ id: 9, user: { login: OWNER }, state: 'CHANGES_REQUESTED', html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-9` }];
    const policy = { capApproval: false };
    const red = await verdict(db, fakeGitHub({ checks: [RED], reviews }), CLEAN, { policy });
    assert.equal(red.output.event, 'COMMENT');
    assert.equal(red.output.staleRequestChanges?.reviewId, 9);

    const green = await verdict(db, fakeGitHub({ reviews }), CLEAN, { policy });
    assert.equal(green.output.event, 'APPROVE');
    assert.equal(green.output.staleRequestChanges, null);
  });
});

test('the sent audit row records whether CI capped the event', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    await post(db, fakeGitHub({ checks: [RED] }), CLEAN, { event: 'COMMENT' });
    await post(db, fakeGitHub(), CLEAN);
    assert.deepEqual(audits(db, 'review_post_sent').map((row) => [row.event, row.cappedByCi]), [
      ['COMMENT', true],
      ['APPROVE', false],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Config and help.
// ---------------------------------------------------------------------------

function configFrom(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-verdict-config-'));
  try {
    if (yaml !== null) {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    }
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config: no verdict keys means the defaults', () => {
  assert.deepEqual(configFrom(null).verdictPolicy, DEFAULT_VERDICT_POLICY);
  const config = configFrom('identity:\n  owner_reviewer: your-github-login\n');
  assert.deepEqual(config.verdictPolicy, DEFAULT_VERDICT_POLICY);
  assert.deepEqual(config.warnings, []);
});

test('config: each setting is read', () => {
  const config = configFrom(
    [
      'verdict:',
      '  ci_pending: proceed',
      '  ci_red: annotate',
      '  ci_needs_rerun: annotate',
      '  carry_approval_on_unchanged: true',
      '  recheck_thread_before_post: true',
      'review:',
      '  human_review:',
      '    cap_approval: false',
      '',
    ].join('\n'),
  );
  assert.deepEqual(config.verdictPolicy, {
    ciPending: 'proceed',
    ciRed: 'annotate',
    ciNeedsRerun: 'annotate',
    capApproval: false,
    carryApprovalOnUnchanged: true,
    recheckThreadBeforePost: true,
  });
  assert.deepEqual(config.warnings, []);
});

test('config: an invalid value warns and keeps that setting\'s default', () => {
  const config = configFrom(
    [
      'verdict:',
      '  ci_pending: sometimes',
      '  ci_red: annotate',
      '  ci_needs_rerun: 3',
      '  carry_approval_on_unchanged: "yes"',
      '  recheck_thread_before_post: maybe',
      'review:',
      '  human_review:',
      '    cap_approval: no-thanks',
      '',
    ].join('\n'),
  );
  assert.deepEqual(config.verdictPolicy, { ...DEFAULT_VERDICT_POLICY, ciRed: 'annotate' });
  assert.equal(config.warnings.length, 5);
  assert.ok(config.warnings.some((w) => w.startsWith('verdict.ci_pending must be one of wait, proceed')));
  assert.ok(config.warnings.some((w) => w.startsWith('review.human_review.cap_approval must be true or false')));
  assert.deepEqual(configFrom('verdict: annotate\n').warnings, ['verdict must be a mapping; using the defaults.']);
});

test('help for verdict and post names the settings and exit 8', () => {
  const help = (command) => execFileSync(process.execPath, [bundle, command, '--help'], { encoding: 'utf8' });
  const verdictHelp = help('verdict');
  for (const key of ['ci_pending', 'ci_red', 'ci_needs_rerun', 'cap_approval', 'carry_approval_on_unchanged']) {
    assert.ok(verdictHelp.includes(key), `verdict --help: ${key}`);
  }
  const postHelp = help('post');
  assert.match(postHelp, /--recheck-thread/);
  assert.match(postHelp, /recheck_thread_before_post/);
  assert.match(postHelp, /8 the thread re-check/);
});
