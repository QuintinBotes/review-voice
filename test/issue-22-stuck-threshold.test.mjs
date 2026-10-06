/**
 * The stuck-check threshold is configurable (#22, docs/adr/0013): a long,
 * healthy suite must not read as needing a rerun just for running past an
 * hour. 60 minutes stays the default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { classifyCheckRun, readCi, stuckAfterFor, summariseCi } from '../plugins/review-voice/src/publish/ci.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const REPO = 'example/shop';
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-06T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

let nextId = 1;
const running = (name, minutes) => ({ id: nextId++, name, status: 'in_progress', conclusion: null, started_at: minutesAgo(minutes) });

test('the default threshold is still 60 minutes', () => {
  assert.equal(stuckAfterFor('build'), 60);
  assert.equal(summariseCi([running('build', 61)], [], [], { now: NOW }).state, 'needs-rerun');
  assert.equal(summariseCi([running('build', 59)], [], [], { now: NOW }).state, 'pending');
});

test('a repository threshold replaces the default', () => {
  const rules = { stuckAfterMinutes: 90 };
  assert.equal(summariseCi([running('build', 75)], [], [], { now: NOW }, rules).state, 'pending');
  const stuck = summariseCi([running('build', 91)], [], [], { now: NOW }, rules);
  assert.equal(stuck.state, 'needs-rerun');
  assert.equal(stuck.rerun[0].detail, 'in_progress for 91 min');
});

test('a per-check override applies only to the checks it names, and the first match wins', () => {
  const rules = {
    stuckAfter: [
      { name: 'backend / integration*', minutes: 180 },
      { name: 'backend / *', minutes: 30 },
    ],
  };
  assert.equal(stuckAfterFor('Backend / Integration (shard 2)', rules), 180);
  assert.equal(stuckAfterFor('backend / unit', rules), 30);
  assert.equal(stuckAfterFor('lint', rules), 60);

  const long = summariseCi([running('backend / integration (shard 2)', 120)], [], [], { now: NOW }, rules);
  assert.equal(long.state, 'pending');
  const mixed = summariseCi(
    [running('backend / integration (shard 2)', 120), running('lint', 75)],
    [],
    [],
    { now: NOW },
    rules,
  );
  assert.equal(mixed.state, 'needs-rerun');
  assert.deepEqual(mixed.rerun.map((entry) => entry.name), ['lint']);
});

test('classifyCheckRun takes the threshold it is given', () => {
  assert.equal(classifyCheckRun({ status: 'queued', started_at: minutesAgo(100) }, NOW, 120).result, 'pending');
  assert.equal(classifyCheckRun({ status: 'queued', started_at: minutesAgo(121) }, NOW, 120).result, 'rerun');
});

test('the live read uses the rules it is given', async () => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [running('e2e', 75)] });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });
  assert.equal((await readCi(client, REPO, SHA, [], NOW)).state, 'needs-rerun');
  assert.equal((await readCi(client, REPO, SHA, [], NOW, { stuckAfter: [{ name: 'e2e', minutes: 120 }] })).state, 'pending');
});

function withConfig(lines, body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-stuck-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), [...lines, ''].join('\n'));
    body(loadConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('thresholds are read from ci.stuck_after_minutes and ci.stuck_after_overrides', () => {
  withConfig(
    [
      'ci:',
      '  stuck_after_minutes: 90',
      '  stuck_after_overrides:',
      '    - name: "backend / integration*"',
      '      minutes: 180',
    ],
    (config) => {
      assert.deepEqual(config.ciRules, {
        stuckAfterMinutes: 90,
        stuckAfter: [{ name: 'backend / integration*', minutes: 180 }],
      });
      assert.deepEqual(config.warnings, []);
    },
  );
});

test('a threshold that is not a whole number above zero keeps the default and warns', () => {
  withConfig(
    [
      'ci:',
      '  stuck_after_minutes: 0',
      '  stuck_after_overrides:',
      '    - name: "e2e"',
      '      minutes: -5',
      '    - minutes: 30',
      '    - name: "deploy"',
      '      minutes: 45',
    ],
    (config) => {
      assert.deepEqual(config.ciRules, { stuckAfter: [{ name: 'deploy', minutes: 45 }] });
      assert.equal(config.warnings.length, 3);
    },
  );
  withConfig([], (config) => assert.deepEqual(config.ciRules, {}));
});
