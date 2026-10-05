/**
 * CI that never finished saying anything about the change (docs/adr/0013):
 * infrastructure failures and stuck checks are neither red nor worth waiting
 * on. They need a rerun, and until then nothing is approved or posted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { classifyCheckRun, readCi, summariseCi } from '../plugins/review-voice/src/publish/ci.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';

const HEAD = 'd'.repeat(40);
const MOVED = 'e'.repeat(40);
const REPO = 'example/shop';
const PR = 12;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

let nextId = 1;
const run = (name, status, conclusion = null, extra = {}) => ({
  id: nextId++,
  name,
  status,
  conclusion,
  started_at: minutesAgo(10),
  completed_at: status === 'completed' ? minutesAgo(5) : null,
  ...extra,
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Answers head and CI reads; `checks` is read in order, one per CI read. Records every request. */
function fakeGitHub({ heads = [HEAD], checks }) {
  const calls = [];
  let headReads = 0;
  let checkReads = 0;
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname });
    if (init.method === 'POST') return json({ id: 1, html_url: 'https://example.invalid/review/1', state: 'COMMENTED' });
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
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-rerun-'));
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

/** One review per mapped event, each with the scores that let it post. */
const REVIEWS = {
  APPROVE: { output: 'No actionable findings.', scores: [] },
  COMMENT: {
    output: '[minor] `src/basket.ts:12` - The total skips the discount. A discounted basket is overcharged.',
    scores: [verified('src/basket.ts', 12, 'minor')],
  },
  REQUEST_CHANGES: {
    output: '[blocking] `src/login.ts:84` - The token is returned before commit. A retry mints two.',
    scores: [verified('src/login.ts', 84, 'blocking')],
  },
};

function record(db, event) {
  const { output, scores } = REVIEWS[event];
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores });
  return output;
}

const verdict = (db, impl, review, extra = {}) =>
  computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, now: NOW, ...extra });

test('timed_out, startup_failure and action_required need a rerun; failure is still a failure', () => {
  for (const conclusion of ['timed_out', 'startup_failure', 'action_required']) {
    assert.deepEqual(classifyCheckRun({ status: 'completed', conclusion }), { result: 'rerun', detail: conclusion }, conclusion);
  }
  assert.equal(classifyCheckRun({ status: 'completed', conclusion: 'failure' }).result, 'failed');
  assert.equal(classifyCheckRun({ status: 'completed', conclusion: 'something_new' }).result, 'failed');

  const ci = summariseCi([run('build', 'completed', 'timed_out'), run('lint', 'completed', 'success')], []);
  assert.equal(ci.state, 'needs-rerun');
  assert.deepEqual(ci.rerun.map((entry) => [entry.name, entry.detail]), [['build', 'timed_out']]);
  assert.deepEqual(ci.failed, []);
});

test('a cancelled run needs a rerun, unless a later run of it passed', () => {
  const app = { id: 15, slug: 'actions' };
  const cancelled = summariseCi([run('deploy', 'completed', 'cancelled', { app })], []);
  assert.equal(cancelled.state, 'needs-rerun');
  assert.equal(cancelled.rerun[0].detail, 'cancelled, with no later run');

  const superseded = summariseCi(
    [run('deploy', 'completed', 'cancelled', { app }), run('deploy', 'completed', 'success', { app })],
    [],
  );
  assert.equal(superseded.state, 'green');
  assert.equal(superseded.passed, 1);
});

test('a check queued or running past an hour is stuck; within the hour it is still pending', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
    const stuck = classifyCheckRun({ status, started_at: minutesAgo(61) }, NOW);
    assert.deepEqual(stuck, { result: 'rerun', detail: `${status} for 61 min` }, status);
    assert.equal(classifyCheckRun({ status, started_at: minutesAgo(59) }, NOW).result, 'pending', status);
  }
  // No clock, or no start time, is no evidence of being stuck.
  assert.equal(classifyCheckRun({ status: 'in_progress', started_at: minutesAgo(600) }).result, 'pending');
  assert.equal(classifyCheckRun({ status: 'queued', started_at: null }, NOW).result, 'pending');

  const ci = summariseCi([run('e2e', 'in_progress', null, { started_at: minutesAgo(75) })], [], [], { now: NOW });
  assert.equal(ci.state, 'needs-rerun');
  assert.equal(ci.rerun[0].detail, 'in_progress for 75 min');
});

test('the live read judges stuck checks against the clock it is given', async () => {
  const impl = fakeGitHub({ checks: [[run('e2e', 'in_progress', null, { started_at: minutesAgo(90) })]] });
  assert.equal((await readCi(client(impl), REPO, HEAD, [], NOW)).state, 'needs-rerun');
  assert.equal((await readCi(client(impl), REPO, HEAD, [], NOW - 60 * 60_000)).state, 'pending');
});

test('a real failure stays red beside a check that needs a rerun; a rerun outranks pending', () => {
  const red = summariseCi([run('build', 'completed', 'failure'), run('e2e', 'completed', 'timed_out')], []);
  assert.equal(red.state, 'red');
  assert.equal(red.rerun.length, 1);

  const rerun = summariseCi([run('lint', 'in_progress'), run('e2e', 'completed', 'startup_failure')], [], [], { now: NOW });
  assert.equal(rerun.state, 'needs-rerun');
});

test('a configured gate still moves a check that needs a rerun out of the way', () => {
  const ci = summariseCi(
    [run('ready to merge', 'completed', 'action_required'), run('build', 'completed', 'success')],
    [],
    [{ name: 'ready to merge' }],
  );
  assert.equal(ci.state, 'green');
  assert.equal(ci.gates.length, 1);
});

test('verdict exits 6 with nothing to send for every mapped event, and names the checks', async () => {
  const checks = [
    [
      run('build', 'completed', 'timed_out'),
      run('e2e', 'in_progress', null, { started_at: minutesAgo(75) }),
      run('lint', 'completed', 'success'),
    ],
  ];
  for (const event of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']) {
    await withDb(async (db) => {
      const review = record(db, event);
      for (const recheck of [false, true]) {
        const { exitCode, output } = await verdict(db, fakeGitHub({ checks }), review, { recheck });
        assert.equal(exitCode, 6, `${event} recheck=${recheck}`);
        assert.equal(output.event, null);
        assert.equal(output.action, 'wait');
        assert.equal(output.payload, null);
        assert.equal(output.preview, null);
        assert.equal(output.key, null);
        assert.equal(output.ci.state, 'needs-rerun');
        assert.ok(
          output.reasons.includes('CI needs a rerun: build (timed_out), e2e (in_progress for 75 min)'),
          output.reasons.join('; '),
        );
      }
    });
  }
});

test('a moved head still refuses with exit 3 before CI is considered', async () => {
  await withDb(async (db) => {
    const review = record(db, 'COMMENT');
    const impl = fakeGitHub({ heads: [MOVED], checks: [[run('build', 'completed', 'timed_out')]] });
    const { exitCode, output } = await verdict(db, impl, review);
    assert.equal(exitCode, 3);
    assert.equal(output.payload, null);
  });
});

function post(db, impl, review, event) {
  let writers = 0;
  return {
    writers: () => writers,
    result: postReview({
      db,
      client: client(impl),
      writerFor: (allowlist) => {
        writers += 1;
        return new ReviewWriter({ allowlist, token: 't', fetchImpl: impl });
      },
      repository: REPO,
      pullNumber: PR,
      head: HEAD,
      review,
      confirm: true,
      event,
      postingEnabled: true,
      now: NOW,
    }),
  };
}

test('post exits 6 and sends nothing while CI needs a rerun, whatever the event', async () => {
  for (const event of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']) {
    await withDb(async (db) => {
      const review = record(db, event);
      const impl = fakeGitHub({ checks: [[run('build', 'completed', 'cancelled')]] });
      const attempt = post(db, impl, review, event);
      const { exitCode, output } = await attempt.result;
      assert.equal(exitCode, 6, event);
      assert.equal(output.status, 'refused');
      assert.match(output.reasons.join('\n'), /CI needs a rerun: build \(cancelled, with no later run\)/);
      assert.equal(attempt.writers(), 0);
      assert.equal(impl.calls.filter((call) => call.method !== 'GET').length, 0);
    });
  }
});

test('post refuses an approval with exit 6 when CI needs a rerun at the moment of sending', async () => {
  await withDb(async (db) => {
    const review = record(db, 'APPROVE');
    const impl = fakeGitHub({
      checks: [[run('build', 'completed', 'success')], [run('build', 'completed', 'success'), run('e2e', 'completed', 'startup_failure')]],
    });
    const attempt = post(db, impl, review, 'APPROVE');
    const { exitCode, output } = await attempt.result;
    assert.equal(exitCode, 6);
    assert.equal(output.status, 'refused');
    assert.equal(attempt.writers(), 0);
    assert.equal(impl.calls.filter((call) => call.method !== 'GET').length, 0);
  });
});
