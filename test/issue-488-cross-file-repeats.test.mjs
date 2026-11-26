/**
 * #488: a repeat on another file, or in a CI heads-up line, went out although
 * the thread already said it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alreadySaidOnThread, commentsNaming, threadRaisesCheck } from '../plugins/review-voice/src/scoring/score.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const CLAIM = 'The child form is built before the upload settles, so spaceIds defaults start empty.';
const FAILURE = 'A saved selection is lost because the form never receives the settled upload values.';
const candidate = {
  candidateId: 'c1',
  path: 'src/Child.tsx',
  line: 59,
  category: 'correctness',
  severity: 'important',
  claim: CLAIM,
  failureMode: FAILURE,
  evidence: [],
  suggestedFix: null,
  fixConfidence: null,
  technicalConfidence: 0.9,
};
const onParent = (body) => ({ path: 'src/Parent.tsx', line: 89, author: 'a-reviewer', body, kind: 'review-comment' });
const SAME = 'The form in child.tsx is built before the upload settles, so the spaceIds defaults start empty and a saved selection is lost.';

test('scenario 1: a comment on another file that names the candidate file repeats it', () => {
  const found = alreadySaidOnThread(candidate, [onParent(SAME.replace('spaceIds', 'the'))]);
  assert.equal(found?.path, 'src/Parent.tsx');
  assert.equal(found?.line, 89);
});

test('scenario 1: a comment on another file that names the candidate symbol repeats it', () => {
  const body = 'The form is built before the upload settles, so the spaceIds defaults start empty and a saved selection is lost.';
  const found = alreadySaidOnThread(candidate, [onParent(body)]);
  assert.equal(found?.author, 'a-reviewer');
});

test('scenario 2: a comment on another file naming neither file nor symbol is not a repeat', () => {
  const body = 'The form is built before the upload settles, so the defaults start empty and a saved selection is lost.';
  assert.equal(alreadySaidOnThread(candidate, [onParent(body)]), null);
});

test('scenario 2: naming the file with unrelated wording is not a repeat', () => {
  assert.equal(alreadySaidOnThread(candidate, [onParent('Please rename the prop passed to Child.tsx for clarity.')]), null);
});

test('the verifier is given every comment naming the file or symbol, however far', () => {
  const far = { ...onParent('Unrelated remark about child.tsx styling.'), line: 400 };
  const other = { ...onParent('Nothing to do with it.'), line: 3 };
  assert.deepEqual(commentsNaming(candidate, [far, other]), [far]);
});

function setup(thread) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-488-'));
  const patch = join(dir, 'diff.patch');
  const body = Array.from({ length: 80 }, (_, i) => `+line ${i + 1}`);
  writeFileSync(
    patch,
    ['src/Parent.tsx', 'src/Child.tsx']
      .flatMap((file) => [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,80 @@', ...body])
      .join('\n'),
  );
  const threadFile = join(dir, 'thread.json');
  writeFileSync(threadFile, JSON.stringify({ comments: thread }));
  const input = JSON.stringify({
    candidates: [
      {
        candidate_id: 'c1',
        path: 'src/Child.tsx',
        line: 59,
        category: 'correctness',
        severity: 'important',
        claim: CLAIM,
        failure_mode: FAILURE,
        evidence: ['Seen in the changed lines.'],
        technical_confidence: 0.95,
      },
    ],
  });
  return { dir, patch, threadFile, input };
}

const check = (s) =>
  JSON.parse(
    execFileSync(process.execPath, [bundle, 'check-candidates', '--diff-file', s.patch, '--thread', s.threadFile], {
      encoding: 'utf8',
      input: s.input,
    }),
  );

test('check-candidates drops the cross-file repeat, and passes a weaker named comment to the verifier', () => {
  const s = setup([onParent(SAME)]);
  try {
    const out = check(s);
    assert.equal(out.droppedAsRepeat.length, 1);
    assert.equal(out.droppedAsRepeat[0].commentPath, 'src/Parent.tsx');
    assert.equal(out.droppedAsRepeat[0].commentLine, 89);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
  const weak = setup([onParent('Maybe look at the spaceIds handling here.'), { ...onParent('Child.tsx also needs a test.'), line: 300 }]);
  try {
    const out = check(weak);
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0].possibleRepeatOf.path, 'src/Parent.tsx');
    assert.equal(out.kept[0].possibleRepeatOf.alsoNaming.length, 1);
    assert.equal(out.kept[0].possibleRepeatOf.alsoNaming[0].line, 300);
  } finally {
    rmSync(weak.dir, { recursive: true, force: true });
  }
});

test('check-candidates keeps a candidate untouched when no comment names it', () => {
  const s = setup([onParent('Unrelated remark about naming here.')]);
  try {
    const out = check(s);
    assert.equal(out.kept.length, 1);
    assert.equal('possibleRepeatOf' in out.kept[0], false);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Heads-up lines and the pre-send re-check, through the post path.
// ---------------------------------------------------------------------------

const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'the-owner';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failing = (name) => ({ id: 1, name, status: 'completed', conclusion: 'failure', completed_at: '2026-10-01T10:00:00Z' });

function fakeGitHub({ checks, reviews = [], inline = [], conversation = [] }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push({ method, path: parsed.pathname });
    if (parsed.pathname.endsWith('/graphql')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (method === 'POST') return json({ id: 101, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-101`, state: 'COMMENT' });
    if (parsed.pathname === '/user') return json({ login: OWNER });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/reviews')) return json(reviews);
    if (/\/pulls\/\d+\/comments$/.test(parsed.pathname)) return json(inline);
    if (/\/issues\/\d+\/comments$/.test(parsed.pathname)) return json(conversation);
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: checks.length, check_runs: checks });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.posts = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-488-db-'));
  mkdirSync(dir, { recursive: true });
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

const CLEAN = 'No actionable findings.';
const SPLIT = {
  id: 7,
  user: { login: 'a-colleague' },
  state: 'COMMENTED',
  body: 'Please split this PR to get under the size limit.',
  html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-7`,
  submitted_at: '2099-01-01T00:00:00Z',
};
const policy = { ciRed: 'annotate' };
const verdict = (db, impl, review = CLEAN) =>
  computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, owner: OWNER, policy });
const record = (db, output, scores = []) =>
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores });

test('scenario 3: a failing check another reviewer already raised gets no heads-up line', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { output } = await verdict(db, fakeGitHub({ checks: [failing('Check PR size')], reviews: [SPLIT] }));
    assert.deepEqual(output.annotations, []);
    assert.doesNotMatch(output.payload.body, /Heads up/);
  });
});

test('scenario 4: a failing check nobody mentioned keeps its heads-up', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { output } = await verdict(db, fakeGitHub({ checks: [failing('Check PR size')], reviews: [{ ...SPLIT, body: 'Looks fine to me.' }] }));
    assert.deepEqual(output.annotations, ['Heads up: `Check PR size` failing on this head.']);
    assert.match(output.payload.body, /Heads up: `Check PR size` failing on this head\./);
  });
});

test('scenario 3: only the check the thread named is dropped from a line naming two', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { output } = await verdict(db, fakeGitHub({ checks: [failing('Check PR size'), { ...failing('unit'), id: 2 }], reviews: [SPLIT] }));
    assert.deepEqual(output.annotations, ['Heads up: `unit` failing on this head.']);
  });
});

test('threadRaisesCheck ignores the description and the tool\'s own earlier heads-up', () => {
  const own = { path: null, line: null, author: 'x', body: 'Heads up: `Check PR size` failing on this head.', kind: 'review-body' };
  const description = { path: null, line: null, author: 'x', body: 'This keeps the size small.', kind: 'description' };
  assert.equal(threadRaisesCheck('Check PR size', [own, description]), null);
});

const MINOR_PROSE = 'The total skips the discount. A discounted cart is overcharged.';
const MINOR = `[minor] \`src/cart.ts:12\` - ${MINOR_PROSE}`;
const scored = [{ candidateId: 'src/cart.ts:12', path: 'src/cart.ts', line: 12, severity: { severity: 'minor' }, confidenceSource: 'verifier', eligible: true }];
const send = (db, impl, extra = {}) =>
  postReview({
    db,
    client: client(impl),
    writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review: MINOR,
    owner: OWNER,
    confirm: true,
    event: 'COMMENT',
    postingEnabled: true,
    recheckThread: true,
    policy,
    ...extra,
  });

test('scenario 5: --recheck-thread refuses on a repeat added on another file since the run', async () => {
  await withDb(async (db) => {
    record(db, MINOR, scored);
    const inline = [
      {
        id: 900,
        user: { login: 'a-colleague' },
        path: 'src/other.ts',
        line: 3,
        body: `In cart.ts: ${MINOR_PROSE}`,
        created_at: '2099-01-01T00:00:00Z',
        html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r900`,
      },
    ];
    const impl = fakeGitHub({ checks: [failing('build')], inline });
    const { exitCode, output } = await send(db, impl);
    assert.equal(exitCode, 8, JSON.stringify(output.reasons));
    assert.equal(output.refused, 'thread-changed');
    assert.deepEqual(output.findings, [
      { path: 'src/cart.ts', line: 12, raisedBy: 'a-colleague', commentUrl: `https://github.com/${REPO}/pull/${PR}#discussion_r900` },
    ]);
    assert.equal(impl.posts().length, 0);
  });
});

test('scenario 5: --recheck-thread refuses on a heads-up check named since the run', async () => {
  await withDb(async (db) => {
    record(db, MINOR, scored);
    const early = { ...SPLIT, submitted_at: '2000-01-01T00:00:00Z', body: 'Looks fine to me.' };
    const impl = fakeGitHub({ checks: [failing('Check PR size')], reviews: [early], conversation: [] });
    // The first read shows no mention; the person then writes one after the run.
    const late = { id: 8, user: { login: 'a-bot' }, body: 'The PR size check fails; reduce the size.', created_at: '2099-01-01T00:00:00Z', html_url: `https://github.com/${REPO}/pull/${PR}#issuecomment-8` };
    let reads = 0;
    const flipping = async (url, init) => {
      if (/\/issues\/\d+\/comments$/.test(new URL(String(url)).pathname)) {
        reads += 1;
        // Read 1 is the verdict's heads-up read, read 2 the re-check.
        return json(reads === 1 ? [] : [late]);
      }
      return impl(url, init);
    };
    flipping.posts = impl.posts;
    const { exitCode, output } = await send(db, flipping);
    assert.equal(exitCode, 8, JSON.stringify(output.reasons));
    assert.equal(output.refused, 'thread-changed');
    assert.deepEqual(output.findings, [{ path: null, line: null, raisedBy: 'a-bot', commentUrl: late.html_url }]);
    assert.equal(flipping.posts().length, 0);
  });
});
