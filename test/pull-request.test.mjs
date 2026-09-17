import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';

const OUTPUT = '[blocking] `src/auth.ts:84` — Token returned before commit. A retry mints two. Commit first.';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-explain-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('explain reports the scoring that was recorded', () => {
  withDb((db) => {
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'd',
      output: OUTPUT,
      candidates: [{ path: 'src/auth.ts', line: 84, category: 'correctness' }],
      scores: [{ candidateId: 'cand_001', technicalConfidence: 0.91, finalScore: 0.86 }],
    });

    const detail = runDetail(db);
    assert.equal(detail.findings[0].category, 'correctness');
    assert.equal(detail.scores[0].finalScore, 0.86);
  });
});

test('a review recorded without scoring reports nothing rather than inventing it', () => {
  withDb((db) => {
    recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd', output: OUTPUT });
    const detail = runDetail(db);
    assert.deepEqual(detail.scores, []);
    // A rationale invented at explain-time is a story about the finding, not a
    // record of how it was produced.
    assert.equal(detail.findings[0].category, undefined);
  });
});

test('an older run can be explained explicitly', () => {
  withDb((db) => {
    const first = recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd1', output: OUTPUT });
    recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd2', output: 'No actionable findings.' });

    assert.equal(runDetail(db).findings.length, 0, 'bare explain shows the newest run');
    assert.equal(runDetail(db, first.reviewRunId).findings.length, 1);
  });
});

test('explaining with no runs at all returns null rather than throwing', () => {
  withDb((db) => {
    assert.equal(runDetail(db), null);
  });
});

test('two runs in the same millisecond still resolve to the newer one', () => {
  withDb((db) => {
    // A timestamp alone is not a total order. Without a tiebreaker, "the last
    // review" is ambiguous and feedback can land on the wrong finding.
    for (let i = 0; i < 12; i += 1) {
      recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: `d${i}`, output: OUTPUT });
      const last = recordRun(db, {
        repository: 'org/a',
        baseRef: null,
        headRef: null,
        diff: `e${i}`,
        output: 'No actionable findings.',
      });
      assert.equal(runDetail(db).reviewRunId, last.reviewRunId, `ambiguous on iteration ${i}`);
    }
  });
});
