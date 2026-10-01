/**
 * The CI guard behind an approval (docs/adr/0010). Each case is a way a
 * hand-written guard got CI wrong: unsettled `filter=all` readings, a first
 * page taken as all of it, a superseded cancellation counted as a failure, and
 * a gate check counted as red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, ReadOnlyViolation } from '../plugins/review-voice/src/github/client.ts';
import { readCi, summariseCi, classifyCheckRun } from '../plugins/review-voice/src/publish/ci.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const SHA = 'c'.repeat(40);
const REPO = 'acme/web';

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

let nextId = 1;
const run = (name, status, conclusion = null, at = '2026-10-01T10:00:00Z', extra = {}) => ({
  id: nextId++,
  name,
  status,
  conclusion,
  started_at: at,
  completed_at: status === 'completed' ? at : null,
  ...extra,
});

function client(impl) {
  return new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });
}

test('wrapped pages are followed to the end, with GETs only', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).includes('page=2')) return json({ total_count: 3, check_runs: [{ id: 3 }] });
    return json(
      { total_count: 3, check_runs: [{ id: 1 }, { id: 2 }] },
      { link: `<https://api.github.com/repos/${REPO}/commits/${SHA}/check-runs?page=2>; rel="next"` },
    );
  };
  const gh = client(impl);
  const items = await gh.paginateWrapped(`/repos/${REPO}/commits/${SHA}/check-runs`, 'check_runs', 100);
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3]);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET']);
  // The reader is still a reader.
  await assert.rejects(() => gh.get(`/repos/${REPO}/pulls/1/reviews`, { method: 'POST' }), ReadOnlyViolation);
});

test('more than 100 check runs are all read, as latest, and statuses too', async () => {
  const first = Array.from({ length: 100 }, (_, i) => run(`job ${i}`, 'completed', 'success'));
  const second = Array.from({ length: 30 }, (_, i) => run(`job ${100 + i}`, 'completed', 'success'));
  const urls = [];
  const impl = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/check-runs') && u.includes('page=2')) return json({ total_count: 130, check_runs: second });
    if (u.includes('/check-runs')) {
      return json(
        { total_count: 130, check_runs: first },
        { link: `<https://api.github.com/repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100&page=2>; rel="next"` },
      );
    }
    if (u.includes('/status')) return json({ state: 'success', total_count: 1, statuses: [{ id: 9, context: 'lint', state: 'success' }] });
    return new Response('no', { status: 404 });
  };
  const ci = await readCi(client(impl), REPO, SHA);
  assert.equal(ci.state, 'green');
  assert.equal(ci.passed, 131);
  assert.ok(urls[0].includes('filter=latest') && urls[0].includes('per_page=100'));
  assert.ok(urls.some((u) => u.endsWith(`/commits/${SHA}/status?per_page=100`)));
});

test('a failure is never masked by another run, whatever its name', () => {
  // Two workflows with a job of the same name: the newer one passing must not
  // turn the older failure green.
  const failed = run('build', 'completed', 'failure', '2026-10-01T09:00:00Z');
  const passed = run('build', 'completed', 'success', '2026-10-01T10:00:00Z');
  const ci = summariseCi([failed, passed], []);
  assert.equal(ci.state, 'red');
  assert.deepEqual(ci.failed.map((f) => f.name), ['build']);
});

test('an unfinished or cancelled run is replaced only by a later completed run of the same app and name', () => {
  const app = { id: 15, slug: 'actions' };
  const orphan = run('build', 'queued', null, '2026-10-01T09:00:00Z', { app });
  const cancelled = run('test', 'completed', 'cancelled', '2026-10-01T09:00:00Z', { app });
  const rebuilt = run('build', 'completed', 'success', '2026-10-01T10:00:00Z', { app });
  const retested = run('test', 'completed', 'success', '2026-10-01T10:00:00Z', { app });
  const ci = summariseCi([orphan, cancelled, rebuilt, retested], []);
  assert.equal(ci.state, 'green');
  assert.equal(ci.passed, 2);

  // Another app's run of the same name replaces nothing.
  const other = run('build', 'completed', 'success', '2026-10-01T11:00:00Z', { app: { id: 99, slug: 'other-ci' } });
  const queued = run('build', 'in_progress', null, '2026-10-01T09:30:00Z', { app });
  assert.equal(summariseCi([queued, other], []).state, 'pending');

  // An earlier completed run does not replace a later queued one.
  const early = run('lint', 'completed', 'success', '2026-10-01T08:00:00Z', { app });
  const late = run('lint', 'queued', null, '2026-10-01T12:00:00Z', { app });
  assert.equal(summariseCi([late, early], []).state, 'pending');
});

test('a cancelled run with nothing later is pending; stale, skipped and neutral do not count', () => {
  assert.equal(summariseCi([run('deploy', 'completed', 'cancelled')], []).state, 'pending');
  const ci = summariseCi(
    ['stale', 'skipped', 'neutral'].map((c) => run(`job ${c}`, 'completed', c)).concat(run('build', 'completed', 'success')),
    [],
  );
  assert.equal(ci.state, 'green');
  assert.equal(ci.ignored.length, 3);
});

test('no checks at all is pending, never green', () => {
  assert.equal(summariseCi([], []).state, 'pending');
  assert.equal(summariseCi([], [], [], { combined: { state: 'pending', totalCount: 0 } }).state, 'pending');
});

test('a combined state of pending counts when statuses exist', () => {
  const runs = [run('build', 'completed', 'success')];
  assert.equal(summariseCi(runs, [], [], { combined: { state: 'pending', totalCount: 2 } }).state, 'pending');
  // GitHub reports pending for a commit with no statuses at all; with check
  // runs passing, that alone is not a reason to wait.
  assert.equal(summariseCi(runs, [], [], { combined: { state: 'pending', totalCount: 0 } }).state, 'green');
});

test('a reading that reached its cap is not green', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => run(`job ${i}`, 'completed', 'success'));
  const impl = async (url) => {
    const u = String(url);
    if (u.includes('/check-runs')) return json({ total_count: many.length, check_runs: many });
    return json({ state: 'success', total_count: 0, statuses: [] });
  };
  const ci = await readCi(client(impl), REPO, SHA);
  assert.equal(ci.state, 'pending');
  assert.ok(ci.pending.some((p) => /more than 1000/.test(p.name)));
});

test('running checks are pending; failing ones are red, and red wins', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    assert.equal(classifyCheckRun({ status }).result, 'pending', status);
  }
  for (const conclusion of ['failure', 'timed_out', 'action_required', 'startup_failure']) {
    assert.equal(classifyCheckRun({ status: 'completed', conclusion }).result, 'failed', conclusion);
  }
  // A conclusion nobody has classified is not a pass.
  assert.equal(classifyCheckRun({ status: 'completed', conclusion: 'something_new' }).result, 'failed');

  assert.equal(summariseCi([run('a', 'in_progress')], []).state, 'pending');
  assert.equal(summariseCi([run('a', 'in_progress'), run('b', 'completed', 'failure')], []).state, 'red');
});

test('combined commit statuses are read the same way', () => {
  assert.equal(summariseCi([], [{ id: 1, context: 'deploy', state: 'pending' }]).state, 'pending');
  assert.equal(summariseCi([], [{ id: 1, context: 'deploy', state: 'error' }]).state, 'red');
  assert.equal(summariseCi([], [{ id: 1, context: 'deploy', state: 'failure' }]).state, 'red');
  assert.equal(summariseCi([], [{ id: 1, context: 'deploy', state: 'success' }]).state, 'green');
});

test('a configured gate moves a failing or pending check out of the way', () => {
  const runs = [
    run('ci / ready to merge', 'completed', 'failure'),
    run('contract check', 'completed', 'failure', undefined, { output: { title: 'Contract', summary: 'Has not yet run on this head' } }),
    run('approvals', 'in_progress'),
    run('build', 'completed', 'success'),
  ];
  // None are built in: unconfigured, these are red.
  assert.equal(summariseCi(runs, []).state, 'red');

  const gates = [{ name: '*ready to merge' }, { name: 'contract*', summary: 'has not yet run' }, { name: 'approvals' }];
  const ci = summariseCi(runs, [], gates);
  assert.equal(ci.state, 'green');
  assert.deepEqual(ci.gates.map((g) => g.name).sort(), ['approvals', 'ci / ready to merge', 'contract check']);
});

test('a gate with a summary only matches a check that says so', () => {
  const runs = [run('contract check', 'completed', 'failure', undefined, { output: { summary: '3 breaking changes' } })];
  const ci = summariseCi(runs, [], [{ name: 'contract*', summary: 'has not yet run' }]);
  assert.equal(ci.state, 'red');
  assert.equal(ci.gates.length, 0);
});

test('gate checks are read from ci.gate_checks in the repository config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-ci-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(
      join(dir, '.review-voice', 'config.yaml'),
      [
        'ci:',
        '  gate_checks:',
        '    - name: "*ready to merge"',
        '    - name: "contract*"',
        '      summary: "has not yet run"',
        '    - approvals',
        '    - summary: "no name, so ignored"',
        '',
      ].join('\n'),
    );
    assert.deepEqual(loadConfig(dir).ciGateChecks, [
      { name: '*ready to merge' },
      { name: 'contract*', summary: 'has not yet run' },
      { name: 'approvals' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no config there are no gates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-ci-config-'));
  try {
    assert.deepEqual(loadConfig(dir).ciGateChecks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
