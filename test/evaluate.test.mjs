import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { computeMetrics } from '../plugins/review-voice/src/evaluate/metrics.ts';

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
