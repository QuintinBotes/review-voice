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
