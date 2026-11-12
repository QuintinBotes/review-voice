/**
 * S25 (docs/adr/0036), AC-3: `evaluate` prints `no data` with nothing settled,
 * the escape rate with its Wilson bound and the basis otherwise, and `--json`
 * carries `approval_breakdown` with null for a group that settled nothing.
 * Also the `status` warning, the Wilson arithmetic, the `outcomes` config and
 * the `outcomes --approvals` command through the bundle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { computeMetrics } from '../plugins/review-voice/src/evaluate/metrics.ts';
import {
  approvalBreakdown,
  approvalEscapeWarning,
  approvalStats,
  DEFAULT_OUTCOMES,
  saveApprovalOutcome,
  wilsonUpper,
} from '../plugins/review-voice/src/store/approvals.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
delete process.env.REVIEW_VOICE_CONFIG;

const metric = (metrics, name) => metrics.find((m) => m.name === name);

/** A data directory with a store, removed after. */
function withDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-approval-metrics-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    return fn(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const STRONG = { reverted: 'strong', changes_requested: 'strong', survived: 'strong' };

/** Records a run and stores an approval outcome for it. */
function approvalRow(db, outcome, { provenance, complexity } = {}) {
  const { reviewRunId } = recordRun(db, {
    repository: 'acme/web',
    baseRef: null,
    headRef: 'a'.repeat(40),
    pullNumber: 1,
    diff: 'd',
    output: 'No actionable findings.',
    ...(provenance === undefined ? {} : { provenance }),
    ...(complexity === undefined ? {} : { complexity }),
  });
  saveApprovalOutcome(db, {
    reviewRunId,
    repository: 'acme/web',
    pullNumber: 1,
    head: 'a'.repeat(40),
    reviewId: null,
    outcome,
    strength: STRONG[outcome] ?? 'weak',
    evidence: { summary: outcome, state: 'closed', mergedAt: null, currentHead: null },
    checkedAt: '2026-10-20T00:00:00.000Z',
  });
  return reviewRunId;
}

const cli = (args, dataDir, cwd = dataDir) =>
  spawnSync(process.execPath, [bundle, ...args], { cwd, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });

test('the Wilson upper bound is honest at small counts and bounded by one', () => {
  assert.equal(wilsonUpper(0, 0), 1);
  assert.equal(wilsonUpper(5, 5), 1);
  // 0 of 5 is not certainly 0: the 95% upper bound is about 0.43.
  assert.ok(Math.abs(wilsonUpper(0, 5) - 0.4345) < 0.001, String(wilsonUpper(0, 5)));
  assert.ok(Math.abs(wilsonUpper(1, 30) - 0.1664) < 0.001, String(wilsonUpper(1, 30)));
  assert.ok(wilsonUpper(0, 100) < wilsonUpper(0, 10));
});

test('with nothing settled the figures are no data, never zero, and the basis says so', () => {
  withDataDir((db) => {
    let metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'approvals_tracked').value, null);
    assert.equal(metric(metrics, 'approval_escape_rate').value, null);
    assert.equal(metric(metrics, 'approval_escape_rate').basis, '0 escaped / 0 settled approvals; 0 pending, 0 weak excluded');
    assert.equal(metric(metrics, 'approval_escape_rate').kind, 'goal');
    // Pending and weak rows are tracked and still settle nothing.
    approvalRow(db, 'pending');
    approvalRow(db, 'merged_other_head');
    metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'approvals_tracked').value, 2);
    assert.equal(metric(metrics, 'approval_escape_rate').value, null);
    assert.equal(metric(metrics, 'approval_escape_rate').basis, '0 escaped / 0 settled approvals; 1 pending, 1 weak excluded');
  });
});

test('the escape rate counts strong outcomes only and prints its bound in the basis', () => {
  withDataDir((db) => {
    approvalRow(db, 'reverted');
    approvalRow(db, 'changes_requested');
    approvalRow(db, 'survived');
    approvalRow(db, 'survived');
    approvalRow(db, 'pending');
    approvalRow(db, 'open');
    const stats = approvalStats(db);
    assert.deepEqual(
      { tracked: stats.tracked, escaped: stats.escaped, survived: stats.survived, settled: stats.settled, pending: stats.pending, weak: stats.weak, rate: stats.rate },
      { tracked: 6, escaped: 2, survived: 2, settled: 4, pending: 1, weak: 1, rate: 0.5 },
    );
    const rate = metric(computeMetrics(db), 'approval_escape_rate');
    assert.equal(rate.value, 0.5);
    assert.equal(rate.basis, `2 escaped / 4 settled approvals; 1 pending, 1 weak excluded; Wilson 95% upper bound ${wilsonUpper(2, 4).toFixed(2)}`);
    assert.equal(metric(computeMetrics(db), 'approvals_tracked').value, 6);
  });
});

test('evaluate prints no data, then the rate with its bound and basis, and --json carries approval_breakdown', () => {
  withDataDir((db, dir) => {
    let run = cli(['evaluate'], dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /approval_escape_rate\s+no data\s+reported, not scored\n\s+0 escaped \/ 0 settled approvals; 0 pending, 0 weak excluded\n/);

    const provenance = { origin: 'watch', pluginVersion: '1.0.0', claudeVersion: null, mode: 'thorough' };
    const complexity = { level: 'high', decisionPoints: 50, sensitivePaths: [], reasons: ['decision points'] };
    approvalRow(db, 'reverted', { provenance, complexity });
    approvalRow(db, 'survived', { provenance, complexity });
    approvalRow(db, 'survived');
    // A group that settled nothing: an interactive run still pending.
    approvalRow(db, 'pending', { provenance: { ...provenance, origin: 'interactive', mode: null } });

    run = cli(['evaluate'], dir);
    assert.equal(run.status, 0, run.stderr);
    const bound = wilsonUpper(1, 3).toFixed(2);
    assert.match(run.stdout, new RegExp(`approval_escape_rate\\s+0\\.33\\s+reported, not scored\\n\\s+1 escaped / 3 settled approvals; 1 pending, 0 weak excluded; Wilson 95% upper bound ${bound}\\n`));
    assert.match(run.stdout, /approvals_tracked\s+4\s+reported, not scored/);

    run = cli(['evaluate', '--json'], dir);
    assert.equal(run.status, 0, run.stderr);
    const { approval_breakdown: breakdown, metrics } = JSON.parse(run.stdout);
    assert.equal(metrics.find((m) => m.name === 'approval_escape_rate').value, 1 / 3);
    assert.deepEqual(Object.keys(breakdown), ['by_mode', 'by_complexity', 'by_independence', 'by_origin']);
    assert.equal(breakdown.by_mode.thorough.settled, 2);
    assert.equal(breakdown.by_mode.thorough.rate, 0.5);
    assert.equal(breakdown.by_mode.thorough.upperBound, wilsonUpper(1, 2));
    assert.equal(breakdown.by_complexity.high.escaped, 1);
    assert.equal(breakdown.by_complexity.unknown.settled, 1);
    // The run recorded without provenance is `unknown` in every provenance group.
    assert.equal(breakdown.by_independence.independent.settled, 2);
    assert.equal(breakdown.by_independence.unknown.settled, 1);
    assert.equal(breakdown.by_origin.unknown.settled, 1);
    // Nothing settled: null, not zero.
    assert.equal(breakdown.by_origin.interactive.tracked, 1);
    assert.equal(breakdown.by_origin.interactive.rate, null);
    assert.equal(breakdown.by_origin.interactive.upperBound, null);
    assert.equal(breakdown.by_independence['not-independent'].rate, null);
    assert.deepEqual(approvalBreakdown(db).byOrigin.watch.settled, 2);
  });
});

test('the breakdown derives the independence label from the origin, never from the stored label', () => {
  withDataDir((db) => {
    const provenance = { origin: 'interactive', pluginVersion: '1.0.0', claudeVersion: null, mode: null };
    const edited = approvalRow(db, 'survived', { provenance });
    const unknownOrigin = approvalRow(db, 'reverted', { provenance });
    // Hand-edited rows: one claims independence it does not have, one names no origin Review Voice records.
    db.prepare(`UPDATE review_runs SET provenance_json = json_set(provenance_json, '$.independence', 'independent') WHERE review_run_id = ?`).run(edited);
    db.prepare(`UPDATE review_runs SET provenance_json = json_set(provenance_json, '$.origin', 'elsewhere', '$.independence', 'independent') WHERE review_run_id = ?`).run(unknownOrigin);
    const breakdown = approvalBreakdown(db);
    assert.deepEqual(Object.keys(breakdown.byIndependence), ['not-independent', 'unknown']);
    assert.equal(breakdown.byIndependence['not-independent'].survived, 1);
    assert.equal(breakdown.byIndependence.unknown.escaped, 1);
    assert.deepEqual(Object.keys(breakdown.byOrigin), ['interactive', 'unknown']);
  });
});

test('status warns only past the configured bound with at least 30 settled approvals, and sends nothing', () => {
  const stats = (escaped, settled) => ({ escaped, settled, upperBound: wilsonUpper(escaped, settled) });
  assert.equal(approvalEscapeWarning({ ...stats(1, 29), threshold: 0.05 }), null);
  assert.equal(approvalEscapeWarning({ ...stats(1, 30), threshold: 0.2 }), null);
  assert.equal(approvalEscapeWarning({ escaped: 0, settled: 0, upperBound: null, threshold: 0.05 }), null);
  assert.equal(
    approvalEscapeWarning({ ...stats(1, 30), threshold: DEFAULT_OUTCOMES.approvalEscapeWarn }),
    'Warning: 1 of 30 settled approvals escaped (reverted or changes requested); the 95% upper bound 0.17 is above outcomes.approval_escape_warn 0.05. ' +
      'Run `review-voice outcomes --approvals` to see them.',
  );
  // 0 of 30 has an upper bound near 0.11, so the default threshold warns even then; a repository may raise it.
  assert.ok(approvalEscapeWarning({ ...stats(0, 30), threshold: 0.05 }) !== null);
  assert.equal(approvalEscapeWarning({ ...stats(0, 30), threshold: 0.12 }), null);

  withDataDir((db, dir) => {
    for (let i = 0; i < 29; i += 1) approvalRow(db, 'survived');
    approvalRow(db, 'reverted');
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.review-voice'), { recursive: true });
    // `status` finds the config through the repository root, which is git's.
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.review-voice', 'config.yaml'), 'outcomes:\n  approval_escape_warn: 0.5\n');
    let run = cli(['status'], dir, repo);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /settled approvals escaped/);
    writeFileSync(join(repo, '.review-voice', 'config.yaml'), 'outcomes:\n  approval_escape_warn: 0.1\n');
    run = cli(['status'], dir, repo);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Warning: 1 of 30 settled approvals escaped .* is above outcomes\.approval_escape_warn 0\.1\./);
  });
});

test('outcomes --approvals runs the approval check through the bundle, and an empty store tracks nothing', () => {
  withDataDir((db, dir) => {
    const run = cli(['outcomes', '--approvals'], dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '0 approval(s) tracked: 0 reverted, 0 changes requested, 0 survived, 0 merged at another head, 0 pending, 0 closed, 0 open, 0 unknown\n');
    const json = cli(['outcomes', '--approvals', '--json'], dir);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), []);
  });
});

test('the outcomes block is read with defaults, and a bad value warns and keeps the default', () => {
  const load = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-outcomes-config-'));
    try {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
      return loadConfig(dir, NO_BASELINE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(load('identity: {}\n').outcomes, { approvalWindowDays: 14, approvalEscapeWarn: 0.05 });
  assert.deepEqual(load('outcomes:\n  approval_window_days: 7\n  approval_escape_warn: 0.1\n').outcomes, { approvalWindowDays: 7, approvalEscapeWarn: 0.1 });
  const bad = load('outcomes:\n  approval_window_days: 0\n  approval_escape_warn: 2\n');
  assert.deepEqual(bad.outcomes, { approvalWindowDays: 14, approvalEscapeWarn: 0.05 });
  assert.ok(bad.warnings.includes('outcomes.approval_window_days must be a whole number above zero; using 14.'), bad.warnings.join('\n'));
  assert.ok(bad.warnings.includes('outcomes.approval_escape_warn must be a number from 0 to 1; using 0.05.'), bad.warnings.join('\n'));
  assert.ok(load('outcomes: 3\n').warnings.includes('outcomes must be a mapping; using the defaults.'));
  assert.ok(load('outcomes:\n  window: 3\n').warnings.includes('outcomes.window is not a setting Review Voice reads; ignoring it.'));
});
