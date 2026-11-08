import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { postedStats, saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';
import { computeMetrics, dismissedRateWarning, stageSeconds } from '../plugins/review-voice/src/evaluate/metrics.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const bundle = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugins/review-voice/dist/review-voice.mjs');

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-eval-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const metric = (metrics, name) => metrics.find((m) => m.name === name);
const run = (db, output) => recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd', output });

test('every metric reports no data rather than a flattering default', () => {
  withDb((db) => {
    const metrics = computeMetrics(db);
    // A reviewer that has never run is not a reviewer with perfect compliance,
    // and reporting 100% from zero samples is how a dashboard starts lying.
    for (const m of metrics) {
      assert.equal(m.value, null, `${m.name} invented a value`);
      assert.equal(m.meets, null, `${m.name} claimed a verdict`);
    }
  });
});

test('every metric explains how it was computed', () => {
  withDb((db) => {
    for (const m of computeMetrics(db)) {
      assert.ok(m.basis.length > 0, `${m.name} has no basis`);
      assert.ok(m.target.length > 0, `${m.name} has no target`);
    }
  });
});

test('contract compliance is measured against the validator, not asserted', () => {
  withDb((db) => {
    run(db, '[blocking] `src/a.ts:8` - Token returned before commit. A retry mints two. Commit first.');
    run(db, 'No actionable findings.');
    const metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'contract_compliance').value, 1);
    assert.equal(metric(metrics, 'contract_compliance').meets, true);
  });
});

test('a non-compliant recorded output drags compliance below target', () => {
  withDb((db) => {
    run(db, '[blocking] `src/a.ts:8` - Fine finding here. It fails. Fix it.');
    // Recorded through a path that skipped validation - the metric must notice.
    run(db, '## Review\n\nHi! Consider renaming things.\n');
    const compliance = metric(computeMetrics(db), 'contract_compliance');
    assert.ok(compliance.value < 1);
    assert.equal(compliance.meets, false);
  });
});

test('exact no-findings compliance counts only empty reviews', () => {
  withDb((db) => {
    run(db, 'No actionable findings.');
    run(db, '[minor] `src/a.ts:1` - A finding here. It fails. Fix it.');
    const m = metric(computeMetrics(db), 'exact_no_findings_compliance');
    assert.equal(m.value, 1);
    assert.equal(m.basis, '1/1 empty reviews used the exact string');
  });
});

test('a reworded empty review fails the exactness metric', () => {
  withDb((db) => {
    run(db, 'Nothing to flag here.');
    const m = metric(computeMetrics(db), 'exact_no_findings_compliance');
    assert.equal(m.value, 0);
    assert.equal(m.meets, false);
  });
});

test('precision excludes unlabelled findings', () => {
  withDb((db) => {
    run(db, [
      '[minor] `src/a.ts:1` - First problem here. It fails. Fix it.',
      '[minor] `src/b.ts:2` - Second problem here. It fails. Fix it.',
    ].join('\n\n'));
    recordFeedback(db, { findingRef: 'rv_01', action: 'keep', actor: 'owner' });

    const precision = metric(computeMetrics(db), 'owner_accepted_precision');
    // One keep, one untouched: 100%, not 50%. Silence is not a dismissal.
    assert.equal(precision.value, 1);
    assert.match(precision.basis, /unlabelled excluded/);
  });
});

test('a dismissal lowers precision', () => {
  withDb((db) => {
    run(db, [
      '[minor] `src/a.ts:1` - First problem here. It fails. Fix it.',
      '[minor] `src/b.ts:2` - Second problem here. It fails. Fix it.',
    ].join('\n\n'));
    recordFeedback(db, { findingRef: 'rv_01', action: 'keep', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_02', action: 'dismiss', actor: 'owner' });
    assert.equal(metric(computeMetrics(db), 'owner_accepted_precision').value, 0.5);
  });
});

test('a rewrite counts as accepted, since the problem was real', () => {
  withDb((db) => {
    run(db, '[minor] `src/a.ts:1` - A problem here. It fails. Fix it.');
    recordFeedback(db, { findingRef: 'rv_01', action: 'rewrite', replacementText: 'Better.', actor: 'owner' });
    assert.equal(metric(computeMetrics(db), 'owner_accepted_precision').value, 1);
  });
});

test('word and finding distributions are reported', () => {
  withDb((db) => {
    run(db, '[minor] `src/a.ts:1` - A short finding here. It fails. Fix it.');
    const metrics = computeMetrics(db);
    assert.ok(metric(metrics, 'median_words_per_finding').value > 0);
    assert.equal(metric(metrics, 'median_findings_per_review').value, 1);
  });
});

test('a goal is reported but never failed like a contract', () => {
  // median_words_per_finding asked for 28 while the validator's contract
  // allows 40, so every compliant review failed a metric it had not broken.
  withDb((db) => {
    const metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'median_words_per_finding').kind, 'goal');

    const ceiling = metric(metrics, 'p95_words_per_finding');
    assert.equal(ceiling.kind, 'gate');
    assert.equal(ceiling.target, '<= 40');

    assert.equal(metric(metrics, 'contract_compliance').kind, 'gate');
  });
});

test('finding counts are reported without a target', () => {
  // A count reflects the diff. Since the contract stopped capping findings, a
  // run that correctly reported nine defects was failing a target of two.
  withDb((db) => {
    const metrics = computeMetrics(db);
    for (const name of ['median_findings_per_review', 'p95_findings_per_review']) {
      assert.equal(metric(metrics, name).target, 'no target');
      assert.equal(metric(metrics, name).kind, 'goal');
    }
  });
});

// Which findings exist at all, run to run

const runWithCandidates = (db, diffHash, candidates) =>
  recordRun(db, {
    repository: 'org/a',
    baseRef: 'base',
    headRef: 'head',
    diff: diffHash,
    output: '[nit] `src/a.ts:1` - A. B. C.',
    candidates,
  });

test('candidate set agreement is not measurable from a single run', () => {
  withDb((db) => {
    runWithCandidates(db, 'same', [{ path: 'src/a.ts', line: 1 }]);
    const m = metric(computeMetrics(db), 'candidate_set_agreement');
    assert.equal(m.value, null);
    assert.match(m.basis, /reviewed twice/);
    assert.equal(m.kind, 'goal');
  });
});

test('two runs of one diff that agree entirely score 1', () => {
  withDb((db) => {
    for (let i = 0; i < 2; i += 1) {
      runWithCandidates(db, 'same', [
        { path: 'src/a.ts', line: 1 },
        { path: 'src/b.ts', line: 9 },
      ]);
    }
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, 1);
  });
});

test('two runs that share nothing score 0', () => {
  withDb((db) => {
    runWithCandidates(db, 'same', [{ path: 'src/a.ts', line: 1 }]);
    runWithCandidates(db, 'same', [{ path: 'src/z.ts', line: 4 }]);
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, 0);
  });
});

test('agreement is measured by location, not by wording', () => {
  // The editor rewrites prose. Two runs naming the same defect at the same
  // line are the same finding however they phrase it.
  withDb((db) => {
    runWithCandidates(db, 'same', [{ path: 'src/a.ts', line: 1, claim: 'One phrasing.' }]);
    runWithCandidates(db, 'same', [{ path: 'src/a.ts', line: 1, claim: 'Entirely different words.' }]);
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, 1);
  });
});

test('runs of different diffs are never compared to each other', () => {
  withDb((db) => {
    runWithCandidates(db, 'one', [{ path: 'src/a.ts', line: 1 }]);
    runWithCandidates(db, 'two', [{ path: 'src/z.ts', line: 4 }]);
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, null);
  });
});

test('the observed shape is reproduced: six and four candidates sharing two', () => {
  // The live number from a real pull request reviewed twice.
  withDb((db) => {
    runWithCandidates(db, 'same', [
      { path: 'a.ts', line: 1 },
      { path: 'b.ts', line: 2 },
      { path: 'c.ts', line: 3 },
      { path: 'd.ts', line: 4 },
      { path: 'e.ts', line: 5 },
      { path: 'f.ts', line: 6 },
    ]);
    runWithCandidates(db, 'same', [
      { path: 'a.ts', line: 1 },
      { path: 'b.ts', line: 2 },
      { path: 'x.ts', line: 7 },
      { path: 'y.ts', line: 8 },
    ]);
    // Two shared of eight distinct.
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, 0.25);
  });
});

test('a run recorded without a diff is never compared to another', () => {
  // Every run recorded by the shipped pipeline carried the hash of the empty
  // string, so the metric compared unrelated pull requests and reported their
  // disagreement as this reviewer's variance. It fell further the more work
  // was recorded.
  withDb((db) => {
    for (const diff of ['', '']) {
      recordRun(db, {
        repository: 'org/a',
        baseRef: 'base',
        headRef: 'head',
        diff,
        output: '[nit] `src/a.ts:1` - A. B. C.',
        candidates: [{ path: 'src/a.ts', line: 1 }],
      });
    }
    const m = metric(computeMetrics(db), 'candidate_set_agreement');
    assert.equal(m.value, null);
    assert.match(m.basis, /not measurable/);
    assert.match(m.basis, /without --diff-file/);
  });
});

test('an anchor that drifted a line or two is the same finding', () => {
  // Observed: the same comment at 174 in one run and 176 in the next, scored
  // as two complete misses.
  withDb((db) => {
    runWithCandidates(db, 'same', [{ path: 'a.tsx', line: 174 }]);
    runWithCandidates(db, 'same', [{ path: 'a.tsx', line: 176 }]);
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, 1);
  });
});

test('two genuinely distant findings in one file are still two', () => {
  withDb((db) => {
    runWithCandidates(db, 'same', [{ path: 'a.tsx', line: 10 }]);
    runWithCandidates(db, 'same', [{ path: 'a.tsx', line: 200 }]);
    assert.equal(metric(computeMetrics(db), 'candidate_set_agreement').value, 0);
  });
});

// Latency, cost, hold rate and the rolling posted rates

const recordWith = (db, extra) =>
  recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd', output: 'No actionable findings.', ...extra });

test('p95 review seconds sits beside the median over per-run stage sums', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'analyst', seconds: 10 }, { name: 'verifier', seconds: 5 }] });
    recordWith(db, { stages: [{ name: 'analyst', seconds: 20 }, { name: 'verifier', seconds: 15 }] });
    recordWith(db, { stages: [{ name: 'analyst', seconds: 30 }] });
    const metrics = computeMetrics(db);
    // Run totals are 15, 35 and 30.
    assert.equal(metric(metrics, 'median_review_seconds').value, 30);
    assert.equal(metric(metrics, 'p95_review_seconds').value, 35);
    assert.equal(metric(metrics, 'p95_review_seconds').basis, '3 run(s) with recorded stages');
    assert.equal(metric(metrics, 'p95_review_seconds').kind, 'goal');
  });
});

test('stageSeconds reports median, p95 and run count per stage', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'analyst', seconds: 10 }, { name: 'verifier', seconds: 5 }] });
    recordWith(db, { stages: [{ name: 'analyst', seconds: 20 }, { name: 'verifier', seconds: 15 }] });
    recordWith(db, { stages: [{ name: 'analyst', seconds: 30 }] });
    assert.deepEqual(stageSeconds(db), {
      analyst: { median: 20, p95: 30, runs: 3 },
      verifier: { median: 15, p95: 15, runs: 2 },
    });
  });
});

test('stageSeconds is empty on an empty store, and is not a metric', () => {
  withDb((db) => {
    assert.deepEqual(stageSeconds(db), {});
    assert.equal(metric(computeMetrics(db), 'stage_seconds'), undefined);
  });
});

test('cost is summed over costed runs and the basis counts none excluded', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 0.25 }, { name: 'b', seconds: 1, costUsd: 0.25 }] });
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 0.5 }, { name: 'b', seconds: 1, costUsd: 0.5 }] });
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 1 }, { name: 'b', seconds: 1, costUsd: 0.5 }] });
    const metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'median_review_cost_usd').value, 1);
    assert.equal(metric(metrics, 'p95_review_cost_usd').value, 1.5);
    assert.equal(metric(metrics, 'median_review_cost_usd').basis, '3 costed run(s), 0 excluded (no cost recorded)');
    assert.equal(metric(metrics, 'p95_review_cost_usd').basis, '3 costed run(s), 0 excluded (no cost recorded)');
  });
});

test('a run with seconds and no costUsd alone leaves cost at no data', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'review', seconds: 40 }] });
    const metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'median_review_cost_usd').value, null);
    assert.equal(metric(metrics, 'p95_review_cost_usd').value, null);
    assert.equal(metric(metrics, 'median_review_cost_usd').basis, '0 costed run(s), 1 excluded (no cost recorded)');
    // Its seconds are still a latency measurement.
    assert.equal(metric(metrics, 'median_review_seconds').value, 40);
  });
});

test('a mixed store gives costed-only values and counts every excluded run', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 0.5 }] });
    recordWith(db, { stages: [{ name: 'review', seconds: 40 }] });
    recordWith(db, {});
    const m = metric(computeMetrics(db), 'median_review_cost_usd');
    assert.equal(m.value, 0.5);
    assert.equal(m.basis, '1 costed run(s), 2 excluded (no cost recorded)');
  });
});

test('one stage without costUsd excludes the whole run', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 3 }, { name: 'b', seconds: 1 }] });
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 0.5 }] });
    const m = metric(computeMetrics(db), 'median_review_cost_usd');
    assert.equal(m.value, 0.5);
    assert.equal(m.basis, '1 costed run(s), 1 excluded (no cost recorded)');
  });
});

test('a costUsd of 0 is a real cost', () => {
  withDb((db) => {
    recordWith(db, { stages: [{ name: 'a', seconds: 1, costUsd: 0 }] });
    const m = metric(computeMetrics(db), 'median_review_cost_usd');
    assert.equal(m.value, 0);
    assert.equal(m.basis, '1 costed run(s), 0 excluded (no cost recorded)');
  });
});

test('the hold rate is held over judged, from scores only', () => {
  withDb((db) => {
    recordWith(db, {
      scores: [
        { candidate_id: 'a', challenge: { verdict: 'confirmed' }, eligible: true },
        { candidate_id: 'b', challenge: { verdict: 'refuted' }, eligible: false, rejectedBecause: 'challenge-refuted' },
        { candidate_id: 'c', challenge: { verdict: 'partly' }, eligible: false, rejectedBecause: 'challenge-partly' },
        { candidate_id: 'd', eligible: true },
      ],
    });
    recordWith(db, { scores: [{ candidate_id: 'e', challenge: { verdict: 'confirmed' }, eligible: true }] });
    const m = metric(computeMetrics(db), 'challenge_hold_rate');
    // Three judged in the first run plus one in the second; the unjudged entry is not counted.
    assert.equal(m.value, 2 / 4);
    assert.equal(m.basis, '2 held / 4 judged over 2 run(s)');
    assert.equal(m.kind, 'goal');
  });
});

test('an entry rejected for another reason is not counted as held', () => {
  withDb((db) => {
    recordWith(db, {
      scores: [
        { candidate_id: 'a', challenge: { verdict: 'confirmed' }, eligible: false, rejectedBecause: 'below-threshold' },
        { candidate_id: 'b', challenge: { verdict: 'confirmed' }, eligible: true },
      ],
    });
    const m = metric(computeMetrics(db), 'challenge_hold_rate');
    assert.equal(m.value, 0);
    assert.equal(m.basis, '0 held / 2 judged over 1 run(s)');
  });
});

test('a stale held array with no challenge-keyed entry gives no data', () => {
  withDb((db) => {
    recordWith(db, {
      held: [{ candidate_id: 'a' }, { candidate_id: 'b' }],
      scores: [{ candidate_id: 'a', eligible: false, rejectedBecause: 'challenge-refuted' }],
    });
    const m = metric(computeMetrics(db), 'challenge_hold_rate');
    assert.equal(m.value, null);
    assert.equal(m.basis, '0 held / 0 judged over 0 run(s)');
  });
});

test('the hold rate never exceeds 1 when every judged entry is held', () => {
  withDb((db) => {
    recordWith(db, {
      scores: [
        { candidate_id: 'a', challenge: {}, eligible: false, rejectedBecause: 'challenge-refuted' },
        { candidate_id: 'b', challenge: {}, eligible: false, rejectedBecause: 'challenge-corrected-line-refused' },
      ],
      held: [{}, {}, {}, {}],
    });
    assert.equal(metric(computeMetrics(db), 'challenge_hold_rate').value, 1);
  });
});

test('output that does not parse or has no scores array is skipped by the hold rate', () => {
  withDb((db) => {
    recordWith(db, {});
    const bad = recordWith(db, {});
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run('{not json', bad.reviewRunId);
    const worse = recordWith(db, {});
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify({ scores: 'x' }), worse.reviewRunId);
    const m = metric(computeMetrics(db), 'challenge_hold_rate');
    assert.equal(m.value, null);
  });
});

const DAY = 86_400_000;
const age = (db, runId, days) =>
  db
    .prepare('UPDATE review_runs SET created_at = ? WHERE review_run_id = ?')
    .run(new Date(Date.now() - days * DAY).toISOString(), runId);
const outcomes = (db, runId, fixed, dismissed, weak = 0) => {
  let n = 0;
  const save = (outcome, strength) => {
    n += 1;
    saveOutcome(db, {
      reviewRunId: runId, findingId: `rv_${n}`, repository: 'org/a', pullNumber: 1, commentId: n,
      outcome, strength, evidence: 'test', checkedAt: new Date().toISOString(), path: 'src/a.ts', line: 1, reviewIdSource: 'audit',
    });
  };
  for (let i = 0; i < fixed; i += 1) save('fixed', 'strong');
  for (let i = 0; i < dismissed; i += 1) save('dismissed', 'strong');
  for (let i = 0; i < weak; i += 1) save('open', 'weak');
};

test('the recent rates count only runs created in the window', () => {
  withDb((db) => {
    const fresh = recordWith(db, {}).reviewRunId;
    const old = recordWith(db, {}).reviewRunId;
    outcomes(db, fresh, 3, 1, 2);
    outcomes(db, old, 0, 4);
    age(db, old, 31);
    const metrics = computeMetrics(db);
    const fixed = metric(metrics, 'posted_fixed_rate_recent');
    assert.equal(fixed.value, 0.75);
    assert.equal(fixed.basis, '3 fixed / 4 fixed or dismissed from runs created in the last 30 days; weak outcomes excluded');
    const dismissed = metric(metrics, 'posted_dismissed_rate_recent');
    assert.equal(dismissed.value, 0.25);
    assert.equal(dismissed.basis, '1 dismissed / 4 fixed or dismissed from runs created in the last 30 days; weak outcomes excluded');
    // The all-time rates still see the aged run.
    assert.equal(metric(metrics, 'posted_dismissed_rate').value, 5 / 8);
  });
});

test('a run just inside the window is kept and a wider window brings an older one back', () => {
  withDb((db) => {
    const inside = recordWith(db, {}).reviewRunId;
    const older = recordWith(db, {}).reviewRunId;
    outcomes(db, inside, 1, 0);
    outcomes(db, older, 0, 1);
    age(db, inside, 29);
    age(db, older, 31);
    assert.equal(metric(computeMetrics(db), 'posted_dismissed_rate_recent').value, 0);
    const wide = metric(computeMetrics(db, { windowDays: 60 }), 'posted_dismissed_rate_recent');
    assert.equal(wide.value, 0.5);
    assert.match(wide.basis, /in the last 60 days/);
    const narrow = metric(computeMetrics(db, { windowDays: 7 }), 'posted_fixed_rate_recent');
    assert.equal(narrow.value, null);
    assert.match(narrow.basis, /in the last 7 days/);
  });
});

test('an outcome with no run row is in the all-time rates only', () => {
  withDb((db) => {
    outcomes(db, 'ghost-run', 0, 2);
    assert.equal(postedStats(db).dismissed, 2);
    assert.equal(postedStats(db, { since: '2000-01-01T00:00:00.000Z' }).dismissed, 0);
    const metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'posted_dismissed_rate').value, 1);
    assert.equal(metric(metrics, 'posted_dismissed_rate_recent').value, null);
  });
});

test('an empty window reports no data, not zero', () => {
  withDb((db) => {
    const run = recordWith(db, {}).reviewRunId;
    outcomes(db, run, 0, 0, 3);
    const m = metric(computeMetrics(db), 'posted_fixed_rate_recent');
    assert.equal(m.value, null);
    assert.equal(m.basis, '0 fixed / 0 fixed or dismissed from runs created in the last 30 days; weak outcomes excluded');
  });
});

test('the warning appears only above 20% and from ten strong outcomes', () => {
  const line = dismissedRateWarning({ dismissed: 4, strong: 15, windowDays: 30 });
  assert.equal(
    line,
    'Warning: 4 of 15 posted findings in the last 30 days were dismissed (27%); run `review-voice explain` on the dismissed ones and consider /review-voice:feedback.',
  );
  // Exactly 20% is the boundary and stays quiet.
  assert.equal(dismissedRateWarning({ dismissed: 2, strong: 10, windowDays: 30 }), null);
  assert.notEqual(dismissedRateWarning({ dismissed: 3, strong: 10, windowDays: 30 }), null);
  // A tiny sample is not evidence, even at 100%.
  assert.equal(dismissedRateWarning({ dismissed: 9, strong: 9, windowDays: 30 }), null);
  assert.notEqual(dismissedRateWarning({ dismissed: 10, strong: 10, windowDays: 30 }), null);
  assert.equal(dismissedRateWarning({ dismissed: 0, strong: 0, windowDays: 30 }), null);
  assert.match(dismissedRateWarning({ dismissed: 5, strong: 10, windowDays: 7 }), /in the last 7 days/);
});

function cli(args, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Seeds a store in a fresh data directory, runs `fn` against the bundle, removes it. */
function withStore(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-eval-cli-'));
  try {
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      seed(db);
    } finally {
      db.close();
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('evaluate --json carries stage_seconds beside metrics, and the text does not print it', () => {
  withStore(
    (db) => recordWith(db, { stages: [{ name: 'analyst', seconds: 12 }] }),
    (dir) => {
      const result = cli(['evaluate', '--json'], dir);
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed.stage_seconds, { analyst: { median: 12, p95: 12, runs: 1 } });
      assert.ok(Array.isArray(parsed.metrics));
      assert.ok(parsed.posted_breakdown);
      assert.equal(parsed.metrics.some((m) => m.name === 'stage_seconds'), false);
      assert.ok(parsed.metrics.some((m) => m.name === 'p95_review_seconds'));
      const text = cli(['evaluate'], dir);
      assert.equal(text.code, 0, text.stderr);
      assert.doesNotMatch(text.stdout, /stage_seconds/);
      assert.match(text.stdout, /p95_review_cost_usd/);
    },
  );
});

test('evaluate --since changes the window and the basis, and a bad value exits 2', () => {
  withStore(
    (db) => {
      const run = recordWith(db, {}).reviewRunId;
      outcomes(db, run, 1, 1);
      age(db, run, 10);
    },
    (dir) => {
      const find = (args, name) => JSON.parse(cli(args, dir).stdout).metrics.find((m) => m.name === name);
      const at30 = find(['evaluate', '--json'], 'posted_dismissed_rate_recent');
      assert.equal(at30.value, 0.5);
      assert.match(at30.basis, /in the last 30 days/);
      const at7 = find(['evaluate', '--json', '--since', '7d'], 'posted_dismissed_rate_recent');
      assert.equal(at7.value, null);
      assert.match(at7.basis, /in the last 7 days/);
      for (const bad of ['7', 'abc', '-3d', '1.5d', '7days']) {
        const result = cli(['evaluate', '--since', bad], dir);
        assert.equal(result.code, 2, bad);
        assert.match(result.stderr, /--since takes a whole number of days, such as 30d\./);
      }
      assert.equal(cli(['evaluate', '--since'], dir).code, 2);
    },
  );
});

test('evaluate help documents --since and the exit codes', () => {
  const help = commandHelp('evaluate');
  assert.match(help, /--since <Nd>/);
  assert.match(help, /default 30d/);
  assert.match(help, /Exit codes: 0 ok, 2 bad invocation\./);
});

test('status prints the dismissed-rate warning only when the condition holds', () => {
  const seed = (dismissed, days) => (db) => {
    const run = recordWith(db, {}).reviewRunId;
    outcomes(db, run, 15 - dismissed, dismissed);
    age(db, run, days);
  };
  withStore(seed(4, 1), (dir) => {
    const result = cli(['status'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Warning: 4 of 15 posted findings in the last 30 days were dismissed \(27%\)/);
  });
  withStore(seed(2, 1), (dir) => assert.doesNotMatch(cli(['status'], dir).stdout, /Warning: .* posted findings/));
  withStore(seed(4, 31), (dir) => assert.doesNotMatch(cli(['status'], dir).stdout, /Warning: .* posted findings/));
});
