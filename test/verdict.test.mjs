/**
 * The review event and its guards (docs/adr/0010): the event follows the
 * verified findings, the head must be the one the review read, red CI caps an
 * approval and pending CI holds it back. Reads only; nothing here posts.
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
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { eventFor, reviewFindings } from '../plugins/review-voice/src/publish/verdict.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const REPO = 'acme/web';
const PR = 7;

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const check = (name, status, conclusion = null, id = 1) => ({
  id,
  name,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-10-01T10:00:00Z' : null,
});
const GREEN = [check('build', 'completed', 'success')];
const RED = [check('build', 'completed', 'failure')];
const PENDING = [check('build', 'in_progress')];

function fakeGitHub({ heads = [HEAD], checkRuns = GREEN } = {}) {
  const calls = [];
  let headReads = 0;
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname, search: parsed.search });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) {
      const sha = heads[Math.min(headReads, heads.length - 1)];
      headReads += 1;
      return json({ head: { sha } });
    }
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: checkRuns.length, check_runs: checkRuns });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

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

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-verdict-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  const restore = () => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() => body(db))
    .finally(restore);
}

function record(db, output, scores, extra = {}) {
  return recordRun(db, {
    repository: REPO,
    baseRef: null,
    headRef: HEAD,
    pullNumber: PR,
    diff: 'diff',
    output,
    scores,
    ...extra,
  });
}

function verdict(db, impl, review, extra = {}) {
  return computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, ...extra });
}

const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const IMPORTANT = '[important] `src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';
const BLOCKING = '[blocking] `src/auth.ts:84` - The token is returned before commit. A retry mints two.';
const CLEAN = 'No actionable findings.';

test('the event follows the highest severity, fixed in code', () => {
  assert.equal(eventFor([]), 'APPROVE');
  assert.equal(eventFor(['nit']), 'APPROVE');
  assert.equal(eventFor(['nit', 'nit']), 'APPROVE');
  assert.equal(eventFor(['minor']), 'COMMENT');
  assert.equal(eventFor(['question', 'nit']), 'COMMENT');
  assert.equal(eventFor(['important']), 'REQUEST_CHANGES');
  assert.equal(eventFor(['nit', 'blocking', 'minor']), 'REQUEST_CHANGES');
});

test('findings are numbered as record numbers them', async () => {
  await withDb((db) => {
    const output = [MINOR, NIT].join('\n\n');
    const { findings } = record(db, output, []);
    assert.deepEqual(
      reviewFindings(output).map((f) => f.findingId),
      findings.map((f) => f.findingId),
    );
  });
});

test('a clean review with green CI approves, with a one-line body and no comments', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub();
    const { exitCode, output } = await verdict(db, impl, CLEAN);
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.action, 'post');
    assert.deepEqual(output.payload, { commit_id: HEAD, event: 'APPROVE', body: 'No problems found.', comments: [] });
    assert.equal(output.preview.split('\n')[0], 'APPROVE');
    // Check runs are read as "latest", which is the reading that settles.
    const checks = impl.calls.find((c) => c.path.endsWith('/check-runs'));
    assert.match(checks.search, /filter=latest/);
    assert.ok(impl.calls.every((c) => c.method === 'GET'));
  });
});

test('every anchored finding is an inline comment; the body only states the verdict', async () => {
  await withDb(async (db) => {
    const output = [MINOR, NIT].join('\n\n');
    record(db, output, [verified('src/cart.ts', 12), verified('src/cart.ts', 40)]);
    const { output: result } = await verdict(db, fakeGitHub(), output);
    assert.equal(result.event, 'COMMENT');
    assert.deepEqual(
      result.payload.comments.map((c) => [c.path, c.line, c.side]),
      [
        ['src/cart.ts', 12, 'RIGHT'],
        ['src/cart.ts', 40, 'RIGHT'],
      ],
    );
    assert.match(result.payload.comments[0].body, /The total skips the discount/);
    assert.ok(!result.payload.body.includes('\n'), 'the body is one line');
    assert.ok(!result.payload.body.includes('discount'), 'findings are never posted as one global block');
    for (const comment of result.payload.comments) {
      assert.ok(result.preview.includes(`${comment.path}:${comment.line}\n  ${comment.body}`));
    }
  });
});

test('important or blocking requests changes, whatever CI says', async () => {
  await withDb(async (db) => {
    const output = [BLOCKING, IMPORTANT].join('\n\n');
    record(db, output, [verified('src/auth.ts', 84), verified('src/pay.ts', 8)]);
    for (const checkRuns of [RED, PENDING]) {
      const { exitCode, output: result } = await verdict(db, fakeGitHub({ checkRuns }), output);
      assert.equal(exitCode, 0);
      assert.equal(result.event, 'REQUEST_CHANGES');
      assert.equal(result.action, 'post');
      assert.equal(result.payload.comments.length, 2);
    }
  });
});

test('an unverified finding is held back and named, and keeps the review from approving', async () => {
  await withDb(async (db) => {
    const output = [BLOCKING, NIT].join('\n\n');
    record(db, output, [analystOnly('src/auth.ts', 84), verified('src/cart.ts', 40)]);
    const { output: result } = await verdict(db, fakeGitHub(), output);
    // The blocking claim is not posted, so it cannot request changes; but an
    // approval past a concern nobody checked is the false APPROVE to avoid.
    assert.equal(result.event, 'COMMENT');
    assert.deepEqual(result.payload.comments.map((c) => c.line), [40]);
    assert.equal(result.held.length, 1);
    assert.equal(result.held[0].findingId, 'rv_01');
    assert.match(result.held[0].reason, /analyst/);
    assert.match(result.preview, /Held back, not verified: 1\n {2}rv_01 src\/auth\.ts:84/);
  });
});

test('a finding with no score, or an ineligible one, does not post', async () => {
  await withDb(async (db) => {
    const output = [MINOR, NIT].join('\n\n');
    record(db, output, [{ ...verified('src/cart.ts', 12), eligible: false }]);
    const { output: result } = await verdict(db, fakeGitHub(), output);
    assert.equal(result.payload.comments.length, 0);
    assert.deepEqual(result.held.map((h) => h.findingId), ['rv_01', 'rv_02']);
    assert.match(result.held[0].reason, /did not clear/);
    assert.match(result.held[1].reason, /no score/);
  });
});

test('a moved head refuses with exit 3 and does not read CI', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const impl = fakeGitHub({ heads: [MOVED] });
    const { exitCode, output } = await verdict(db, impl, CLEAN);
    assert.equal(exitCode, 3);
    assert.equal(output.action, 'refuse');
    assert.equal(output.payload, null);
    assert.deepEqual(output.head, { expected: HEAD, actual: MOVED });
    assert.ok(!impl.calls.some((c) => c.path.endsWith('/check-runs')));
  });
});

test('red CI caps an approval at COMMENT and still posts', async () => {
  await withDb(async (db) => {
    record(db, NIT, [verified('src/cart.ts', 40)]);
    const { exitCode, output } = await verdict(db, fakeGitHub({ checkRuns: RED }), NIT);
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.action, 'post');
    assert.equal(output.ci.state, 'red');
    assert.match(output.payload.body, /CI is red/);
    assert.equal(output.payload.comments.length, 1);
  });
});

test('pending CI turns an approval into a wait, exit 4, with nothing to send', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const { exitCode, output } = await verdict(db, fakeGitHub({ checkRuns: PENDING }), CLEAN);
    assert.equal(exitCode, 4);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.action, 'wait');
    assert.equal(output.payload, null);
  });
});

test('--recheck emits an approval only when the head holds and CI is green', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, []);
    const green = await verdict(db, fakeGitHub(), CLEAN, { recheck: true });
    assert.equal(green.exitCode, 0);
    assert.equal(green.output.payload.event, 'APPROVE');

    const pending = await verdict(db, fakeGitHub({ checkRuns: PENDING }), CLEAN, { recheck: true });
    assert.equal(pending.exitCode, 4);
    assert.equal(pending.output.payload, null);

    const red = await verdict(db, fakeGitHub({ checkRuns: RED }), CLEAN, { recheck: true });
    assert.equal(red.exitCode, 5);
    assert.equal(red.output.payload, null);

    const moved = await verdict(db, fakeGitHub({ heads: [MOVED] }), CLEAN, { recheck: true });
    assert.equal(moved.exitCode, 3);
  });
});

test('--recheck on a review that does not approve has nothing to re-check', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12)]);
    const { exitCode, output } = await verdict(db, fakeGitHub(), MINOR, { recheck: true });
    assert.equal(exitCode, 2);
    assert.equal(output.payload, null);
  });
});

test('the review on stdin must be the one recorded, before anything is read', async () => {
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 12)]);
    const impl = fakeGitHub();
    const edited = MINOR.replace('overcharged', 'charged twice');
    const { exitCode, output } = await verdict(db, impl, edited);
    assert.equal(exitCode, 2);
    assert.match(output.reasons[0], /not the review recorded/);
    assert.equal(impl.calls.length, 0);
  });
});

test('no recorded review, or one of another head, refuses', async () => {
  await withDb(async (db) => {
    const impl = fakeGitHub();
    assert.equal((await verdict(db, impl, CLEAN)).exitCode, 2);
    record(db, CLEAN, [], { headRef: MOVED });
    const { exitCode, output } = await verdict(db, impl, CLEAN);
    assert.equal(exitCode, 2);
    assert.match(output.reasons[0], /reviewed b{40}/);
    assert.equal(impl.calls.length, 0);
    assert.equal((await verdict(db, impl, CLEAN, { head: 'abc' })).exitCode, 2);
  });
});

test('a carried finding counts as verified when the run it came from verified it', async () => {
  await withDb(async (db) => {
    const earlier = recordRun(db, {
      repository: REPO,
      baseRef: null,
      headRef: MOVED,
      pullNumber: PR,
      diff: 'old',
      output: '[minor] `src/cart.ts:10` - The total skips the discount. A discounted cart is overcharged.',
      scores: [verified('src/cart.ts', 10)],
    });
    record(db, MINOR, [], {
      carried: {
        runId: earlier.reviewRunId,
        findings: [{ findingId: 'rv_01', path: 'src/cart.ts', oldLine: 10, line: 12, text: MINOR }],
      },
    });
    const { output } = await verdict(db, fakeGitHub(), MINOR);
    assert.equal(output.held.length, 0);
    assert.deepEqual(output.payload.comments.map((c) => c.line), [12]);
  });
});

test('anchors prints exactly what it printed before the extraction moved', () => {
  const input = [
    '[blocking] `src/auth.ts:84` - Token returned before commit. A retry mints two.',
    '',
    '[nit] no anchor here at all',
    '',
    '[minor] `a/b.ts:3` - Wrapped',
    '  across lines.',
    '',
  ].join('\n');
  const stdout = execFileSync(process.execPath, [bundle, 'anchors'], { input, encoding: 'utf8' });
  const expected =
    '{\n' +
    '  "anchors": [\n' +
    '    {\n' +
    '      "findingId": "rv_01",\n' +
    '      "severity": "blocking",\n' +
    '      "path": "src/auth.ts",\n' +
    '      "line": 84,\n' +
    '      "body": "[blocking] `src/auth.ts:84` - Token returned before commit. A retry mints two."\n' +
    '    },\n' +
    '    {\n' +
    '      "findingId": "rv_02",\n' +
    '      "severity": "minor",\n' +
    '      "path": "a/b.ts",\n' +
    '      "line": 3,\n' +
    '      "body": "[minor] `a/b.ts:3` - Wrapped\\n  across lines."\n' +
    '    }\n' +
    '  ],\n' +
    '  "unanchorable": 1\n' +
    '}\n';
  assert.equal(stdout, expected);
});

test('a score backs one finding, and only at the severity it derived', async () => {
  await withDb(async (db) => {
    // An unverified important on the same line as a verified nit must not post
    // on the nit's score.
    const IMPORTANT_40 = '[important] `src/cart.ts:40` - The retry charges twice. A timeout bills the card again.';
    const output = [NIT, IMPORTANT_40].join('\n\n');
    record(db, output, [verified('src/cart.ts', 40, 'nit'), analystOnly('src/cart.ts', 40, 'important')]);
    const { output: result } = await verdict(db, fakeGitHub(), output);
    assert.equal(result.payload.comments.length, 1);
    assert.match(result.payload.comments[0].body, /^\*\*nit\*\*/);
    assert.deepEqual(result.held.map((h) => h.severity), ['important']);
    assert.equal(result.event, 'COMMENT');
  });
});

test('one verified score cannot verify two findings', async () => {
  await withDb(async (db) => {
    const twin = '[nit] `src/cart.ts:40` - This import is unused here.';
    const output = [NIT, twin].join('\n\n');
    record(db, output, [verified('src/cart.ts', 40, 'nit')]);
    const { output: result } = await verdict(db, fakeGitHub(), output);
    assert.equal(result.payload.comments.length, 1);
    assert.equal(result.held.length, 1);
  });
});

test('a verified score at another severity does not verify the finding', async () => {
  await withDb(async (db) => {
    const IMPORTANT_12 = '[important] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
    record(db, IMPORTANT_12, [verified('src/cart.ts', 12, 'minor')]);
    const { output } = await verdict(db, fakeGitHub(), IMPORTANT_12);
    assert.equal(output.payload.comments.length, 0);
    assert.match(output.held[0].reason, /derived at important/);
  });
});

test('a verified finding with no line goes in the body', async () => {
  await withDb(async (db) => {
    const NO_LINE = '[minor] `src/cart.ts` - The module never exports the discount rule. Callers reimplement it.';
    record(db, NO_LINE, [verified('src/cart.ts', 1, 'minor')]);
    const { output } = await verdict(db, fakeGitHub(), NO_LINE);
    assert.equal(output.held.length, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.payload.comments.length, 0);
    const [summary, ...rest] = output.payload.body.split('\n\n');
    assert.match(summary, /1 comment/);
    assert.deepEqual(rest, [NO_LINE]);
  });
});
