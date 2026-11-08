/**
 * `review-voice recall` and `evaluate --recall` (docs/EVALUATION.md, "Fixture
 * recall"): the harness run in process over canned fixtures and the fake agent
 * backend, the scoring edge cases, the isolation the command promises, and the
 * evaluate and help surfaces. No model is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runRecall, RecallUsageError } from '../plugins/review-voice/src/evaluate/recall.ts';
import { readRecallResults, recallMetrics, scoreFixture, summariseResults } from '../plugins/review-voice/src/evaluate/recall-results.ts';
import { AGREEMENT_LINE_TOLERANCE } from '../plugins/review-voice/src/evaluate/metrics.ts';
import { pluginVersion } from '../plugins/review-voice/src/version.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'plugins/review-voice/src/cli.ts');
const canned = join(root, 'test/fixtures-recall');

const scratch = (t, prefix = 'rv-recall-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Every file under a directory with its content, so a tree can be compared before and after. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path.slice(dir.length)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const ENV_KEYS = ['REVIEW_VOICE_DATA_DIR', 'GITHUB_TOKEN', 'GH_TOKEN', 'REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_NO_COMMANDS', 'REVIEW_VOICE_FAKE_AGENTS'];

/** The harness in this process, as the command runs it. */
function recall(overrides = {}, requests = []) {
  return runRecall(
    { fixtures: canned, classes: ['positive', 'negative', 'no-findings'], runner: 'fake', only: null, keep: false, ...overrides },
    { commandWith: (fetchImpl) => (args, stdin) => runInProcess(args, { stdin, fetchImpl }), onRequest: (call) => requests.push(call) },
  );
}

const byName = (run, name) => run.results.fixtures.find((fixture) => fixture.name === name);

test('canned fixtures: the hit is a hit, the miss is a miss, the clean one is silent', async (t) => {
  const before = snapshot(canned);
  const { results } = await recall();
  assert.equal(results.pluginVersion, pluginVersion());
  assert.equal(results.mode, 'auto');
  assert.equal(results.runner, 'fake');
  assert.deepEqual(
    results.fixtures.map((fixture) => fixture.name),
    ['positive/hit', 'positive/miss', 'positive/skipped', 'no-findings/clean'],
  );
  const hit = results.fixtures[0];
  assert.equal(hit.hit, true);
  assert.equal(hit.lineDelta, 0);
  const miss = results.fixtures[1];
  assert.equal(miss.hit, false);
  assert.ok(miss.lineDelta >= 4, `the miss is at least 4 lines away, got ${miss.lineDelta}`);
  assert.equal(miss.findings, 1);
  const clean = results.fixtures[3];
  assert.equal(clean.silent, true);
  assert.equal(clean.findings, 0);
  for (const fixture of [hit, miss, clean]) {
    assert.equal(fixture.exitCode, 0, fixture.error);
    assert.equal(fixture.error, undefined);
    assert.ok(fixture.lanes.includes('diff'));
  }
  assert.equal(results.fixtures[2].skipped, 'Not a stage the driver runs.');
  assert.deepEqual(results.summary, {
    keyBugRecall: 0.5,
    causalLineHit: 0.5,
    cleanSilence: 1,
    positives: 2,
    skipped: 1,
    cleanFixtures: 1,
    failedRuns: 0,
  });
  assert.deepEqual(snapshot(canned), before, 'nothing is written under the fixtures');
});

test('isolation: nothing posted, the operator store untouched, the process restored, the temporary store removed', async (t) => {
  const operator = scratch(t, 'rv-recall-operator-');
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.REVIEW_VOICE_DATA_DIR = operator;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.REVIEW_VOICE_NO_COMMANDS;
  const cwd = process.cwd();
  const requests = [];

  const run = await recall({}, requests);

  assert.deepEqual(readdirSync(operator), [], 'the operator data directory is still empty');
  assert.ok(requests.length > 0);
  const writes = requests.filter((call) => call.method !== 'GET' && call.method !== 'HEAD');
  assert.ok(
    writes.every((call) => call.method === 'POST' && call.path === '/graphql'),
    `only the graphql read is a POST: ${JSON.stringify(writes)}`,
  );
  assert.equal(process.cwd(), cwd);
  assert.equal(process.env.REVIEW_VOICE_DATA_DIR, operator);
  assert.equal(process.env.GITHUB_TOKEN, undefined, 'the placeholder token does not outlive the run');
  assert.equal(process.env.REVIEW_VOICE_NO_COMMANDS, undefined, 'the flag is passed in the dependencies, not left in the environment');
  assert.equal(existsSync(run.dataDir), false, 'the temporary store is removed without --keep');
  assert.equal(run.kept, false);
});

test('--keep leaves the store with one recorded run per completed fixture, and the real token is not replaced', async (t) => {
  const saved = { token: process.env.GITHUB_TOKEN, data: process.env.REVIEW_VOICE_DATA_DIR };
  t.after(() => {
    if (saved.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.token;
  });
  process.env.GITHUB_TOKEN = 'an-operator-token';
  const run = await recall({ keep: true });
  t.after(() => rmSync(dirname(run.dataDir), { recursive: true, force: true }));
  assert.equal(run.kept, true);
  assert.equal(process.env.GITHUB_TOKEN, 'an-operator-token');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(run.dataDir, 'review-voice.db'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n, 3);
  } finally {
    db.close();
  }
  assert.equal(process.env.REVIEW_VOICE_DATA_DIR, saved.data);
});

test('a fixture config that names a command never runs it', async (t) => {
  const fixtures = scratch(t);
  cpSync(join(canned, 'positive/hit'), join(fixtures, 'positive/hit'), { recursive: true });
  const marker = join(fixtures, 'ran.txt');
  writeFileSync(
    join(fixtures, 'positive/hit/config.yaml'),
    `static_evidence:\n  enabled: true\n  commands:\n    - name: touch\n      run: "touch ${marker}"\n`,
  );
  const run = await recall({ fixtures, classes: ['positive'] });
  assert.equal(run.results.fixtures[0].exitCode, 0, run.results.fixtures[0].error);
  assert.equal(existsSync(marker), false, 'the repository command did not run');
});

test('scoring: the tolerance edge, a wrong path, no finding, a failed run, and a skipped fixture', () => {
  const positive = { class: 'positive', path: 'src/a.ts', line: 10, category: null };
  const outcome = (findings, completed = true) => ({ completed, findings, silent: false });
  assert.equal(AGREEMENT_LINE_TOLERANCE, 3);
  assert.equal(scoreFixture(positive, outcome([{ path: 'src/a.ts', line: 13 }])).hit, true, 'delta 3 hits');
  assert.equal(scoreFixture(positive, outcome([{ path: 'src/a.ts', line: 7 }])).hit, true, 'delta 3 hits below too');
  const four = scoreFixture(positive, outcome([{ path: 'src/a.ts', line: 14 }]));
  assert.equal(four.hit, false, 'delta 4 misses');
  assert.equal(four.lineDelta, 4);
  const wrong = scoreFixture(positive, outcome([{ path: 'src/b.ts', line: 10 }]));
  assert.equal(wrong.hit, false, 'a finding on another path is not a hit');
  assert.equal(wrong.lineDelta, null);
  const none = scoreFixture(positive, outcome([]));
  assert.equal(none.hit, false);
  assert.equal(none.lineDelta, null);
  const nearest = scoreFixture(positive, outcome([{ path: 'src/a.ts', line: 30 }, { path: 'src/a.ts', line: 11 }]));
  assert.equal(nearest.lineDelta, 1, 'the nearest finding on the path decides');
  const crashed = scoreFixture(positive, outcome([], false));
  assert.equal(crashed.hit, null, 'a crash is not a miss');
  assert.equal(scoreFixture({ class: 'no-findings', path: null, line: null, category: null }, { completed: false, findings: [], silent: false }).silent, null, 'a crash is not silence');

  const results = [
    { name: 'positive/a', class: 'positive', hit: true, lineDelta: 0, exitCode: 0 },
    { name: 'positive/b', class: 'positive', hit: false, lineDelta: 5, exitCode: 0 },
    { name: 'positive/c', class: 'positive', hit: null, lineDelta: null, exitCode: 1, error: 'boom' },
    { name: 'positive/d', class: 'positive', skipped: 'no stage' },
    { name: 'no-findings/e', class: 'no-findings', silent: true, exitCode: 0 },
    { name: 'no-findings/f', class: 'no-findings', silent: null, exitCode: 1, error: 'boom' },
  ];
  assert.deepEqual(summariseResults(results), {
    keyBugRecall: 0.5,
    causalLineHit: 0.5,
    cleanSilence: 1,
    positives: 3,
    skipped: 1,
    cleanFixtures: 2,
    failedRuns: 2,
  });
  const empty = summariseResults([{ name: 'positive/x', class: 'positive', skipped: 'r' }]);
  assert.equal(empty.keyBugRecall, null, 'no denominator is no data, not zero');
  assert.equal(empty.cleanSilence, null);
});

test('a fixture that cannot be materialised is a failed run, counted and left out of the figures', async (t) => {
  const fixtures = scratch(t);
  cpSync(join(canned, 'positive/hit'), join(fixtures, 'positive/hit'), { recursive: true });
  cpSync(join(canned, 'positive/miss'), join(fixtures, 'positive/miss'), { recursive: true });
  writeFileSync(join(fixtures, 'positive/miss/diff.patch'), 'this is not a patch\n');
  const run = await recall({ fixtures, classes: ['positive'] });
  assert.equal(run.results.summary.failedRuns, 1);
  assert.equal(run.results.summary.keyBugRecall, 1, 'the failed run is not in the denominator');
  const failed = byName(run, 'positive/miss');
  assert.equal(failed.hit, null);
  assert.ok(failed.error);
});

test('bad invocations are refused before anything runs', async () => {
  await assert.rejects(recall({ fixtures: join(canned, 'nowhere') }), RecallUsageError);
  await assert.rejects(recall({ only: 'no-such-fixture' }), RecallUsageError);
  for (const args of [[], ['--fixtures'], ['--fixtures', canned, '--class', 'prompt-injection'], ['--fixtures', canned, '--runner', 'other'], ['--fixtures', canned, '--bogus']]) {
    const result = spawnSync(process.execPath, [cli, 'recall', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
  }
});

test('the command writes results.json and prints the figures', (t) => {
  const dir = scratch(t);
  const out = join(dir, 'results.json');
  const data = join(dir, 'operator');
  mkdirSync(data);
  const before = snapshot(canned);
  const result = spawnSync(process.execPath, [cli, 'recall', '--fixtures', canned, '--runner', 'fake', '--out', out], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
  });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(written), ['pluginVersion', 'mode', 'runner', 'fixtures', 'summary']);
  assert.equal(written.summary.keyBugRecall, 0.5);
  assert.match(result.stdout, /key-bug recall 0\.50, causal-line hit 0\.50, clean silence 1\.00/);
  assert.match(result.stdout, /positive\/skipped\s+skipped: Not a stage the driver runs\./);
  assert.deepEqual(readdirSync(data), [], 'the operator data directory is untouched');
  assert.deepEqual(snapshot(canned), before);

  const inside = spawnSync(process.execPath, [cli, 'recall', '--fixtures', canned, '--runner', 'fake', '--out', join(canned, 'results.json')], { encoding: 'utf8' });
  assert.equal(inside.status, 2, 'it never writes inside the fixtures');
  assert.equal(existsSync(join(canned, 'results.json')), false);
});

/** `evaluate` against a fresh, empty store. */
function evaluate(t, ...args) {
  const data = scratch(t, 'rv-recall-eval-');
  return spawnSync(process.execPath, [cli, 'evaluate', ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: data } });
}

const RESULTS = {
  pluginVersion: '9.9.9',
  mode: 'auto',
  runner: 'fake',
  fixtures: [
    { name: 'positive/a', class: 'positive', hit: true, lineDelta: 0, exitCode: 0 },
    { name: 'positive/b', class: 'positive', hit: false, lineDelta: 5, exitCode: 0 },
    { name: 'positive/c', class: 'positive', skipped: 'no stage' },
  ],
  summary: { keyBugRecall: 0.5, causalLineHit: 0.5, cleanSilence: null, positives: 2, skipped: 1, cleanFixtures: 0, failedRuns: 0 },
};

test('evaluate without --recall prints no data for the three figures', (t) => {
  const result = evaluate(t);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['fixture_key_bug_recall', 'fixture_causal_line_hit', 'fixture_clean_silence']) {
    const line = result.stdout.split('\n').find((text) => text.includes(name));
    assert.ok(line, `${name} is listed`);
    assert.match(line, /no data/);
  }
  assert.match(result.stdout, /pass evaluate --recall <results\.json>/);
});

test('evaluate --recall reports the figures as goals with the file basis; a null figure is no data', (t) => {
  const dir = scratch(t);
  const file = join(dir, 'results.json');
  writeFileSync(file, JSON.stringify(RESULTS));
  const text = evaluate(t, '--recall', file);
  assert.equal(text.status, 0, text.stderr);
  const recallLine = text.stdout.split('\n').find((line) => line.includes('fixture_key_bug_recall'));
  assert.match(recallLine, /0\.5/);
  assert.match(text.stdout, /1\/2 completed positives/);
  assert.match(text.stdout, /plugin 9\.9\.9, runner fake/);
  assert.match(text.stdout.split('\n').find((line) => line.includes('fixture_clean_silence')), /no data/);

  const json = JSON.parse(evaluate(t, '--recall', file, '--json').stdout);
  const metrics = json.metrics.filter((metric) => metric.name.startsWith('fixture_'));
  assert.deepEqual(metrics.map((metric) => metric.name), ['fixture_key_bug_recall', 'fixture_causal_line_hit', 'fixture_clean_silence']);
  assert.deepEqual(metrics.map((metric) => metric.value), [0.5, 0.5, null]);
  assert.ok(metrics.every((metric) => metric.kind === 'goal'), 'goals, not gates');
});

test('evaluate --recall: a missing or malformed file is exit 2', (t) => {
  const dir = scratch(t);
  const missing = evaluate(t, '--recall', join(dir, 'absent.json'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such file/);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  const broken = evaluate(t, '--recall', bad);
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /not valid JSON/);
  const shapeless = join(dir, 'shapeless.json');
  writeFileSync(shapeless, JSON.stringify({ pluginVersion: '1', mode: 'auto', runner: 'fake', fixtures: 'none', summary: {} }));
  assert.equal(evaluate(t, '--recall', shapeless).status, 2);
  assert.equal(evaluate(t, '--recall').status, 2, 'the flag needs a file');
  assert.throws(() => readRecallResults(shapeless), /malformed/);
  assert.equal(recallMetrics(null).every((metric) => metric.value === null), true);
});

test('help names recall and the --recall flag', async () => {
  const recallHelp = await runInProcess(['help', 'recall']);
  assert.equal(recallHelp.code, 0);
  assert.match(recallHelp.stdout, /^review-voice recall/m);
  for (const flag of ['--fixtures', '--class', '--runner', '--keep', '--out']) assert.ok(recallHelp.stdout.includes(flag), flag);
  for (const heading of ['Flags:', 'Reads:', 'Writes:', 'Exit codes:']) assert.ok(recallHelp.stdout.includes(heading), heading);
  const evaluateHelp = await runInProcess(['help', 'evaluate']);
  assert.ok(evaluateHelp.stdout.includes('--recall <results.json>'));
});
