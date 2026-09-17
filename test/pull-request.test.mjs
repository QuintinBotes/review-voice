import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';

const OUTPUT = '[blocking] `src/auth.ts:84` - Token returned before commit. A retry mints two. Commit first.';

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

test('each finding shows its own score, not the first one’s', () => {
  withDb((db) => {
    // Found by running the reviewer on its own pull request. The lookup used a
    // predicate that never discriminated between findings, so every finding
    // displayed the first finding's numbers - worse than displaying none, in
    // the command whose whole purpose is auditability.
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'd',
      output: [
        '[blocking] `src/a.ts:1` - First problem here. It fails. Fix it.',
        '[minor] `src/b.ts:2` - Second problem here. It fails differently. Fix it.',
      ].join('\n\n'),
      candidates: [
        { path: 'src/a.ts', line: 1, category: 'correctness' },
        { path: 'src/b.ts', line: 2, category: 'security' },
      ],
      scores: [
        { candidateId: 'cand_001', path: 'src/a.ts', line: 1, technicalConfidence: 0.91, finalScore: 0.86 },
        { candidateId: 'cand_002', path: 'src/b.ts', line: 2, technicalConfidence: 0.55, finalScore: 0.4 },
      ],
    });

    const detail = runDetail(db);
    const scoreFor = (finding) =>
      detail.scores.find((s) => s.path === finding.path && s.line === finding.line);

    const [first, second] = detail.findings;
    assert.equal(scoreFor(first).finalScore, 0.86);
    assert.equal(scoreFor(second).finalScore, 0.4);
    assert.notEqual(scoreFor(first).finalScore, scoreFor(second).finalScore);
  });
});

test('a score with no location is not attached to some other finding', () => {
  withDb((db) => {
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'd',
      output: OUTPUT,
      scores: [{ candidateId: 'cand_001', technicalConfidence: 0.91, finalScore: 0.86 }],
    });

    const detail = runDetail(db);
    const finding = detail.findings[0];
    const matched = detail.scores.find((s) => s.path === finding.path && s.line === finding.line);
    // Reporting nothing beats reporting somebody else's numbers.
    assert.equal(matched, undefined);
  });
});

test('a truncated read reports itself rather than passing as complete', async () => {
  const { acquirePullRequestDiff } = await import('../plugins/review-voice/src/diff/pull-request.ts');

  // A fake transport, so this tests the truncation logic without the network.
  const files = Array.from({ length: 250 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    status: 'modified',
    patch: '@@ -1 +1 @@\n-a\n+b',
  }));

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (/\/pulls\/\d+$/.test(href)) {
      return new Response(
        JSON.stringify({
          number: 1,
          title: 'big',
          base: { sha: 'b', ref: 'main' },
          head: { sha: 'h', ref: 'topic' },
          // GitHub says 480; we will only be allowed to read 250.
          changed_files: 480,
          additions: 9000,
          deletions: 4000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(files), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    process.env.GITHUB_TOKEN = 'test-token';
    const result = await acquirePullRequestDiff({
      repository: 'org/a',
      pullNumber: 1,
      includeGenerated: false,
      maxFiles: 250,
    });
    assert.equal(result.totalChangedFiles, 480);
    assert.equal(result.truncated, true);
    // Nothing downstream can tell files are missing unless this says so.
    assert.match(result.truncationNote, /250 of 480/);
    assert.match(result.truncationNote, /part of the change/);
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_TOKEN;
  }
});

test('a complete read carries no truncation note', async () => {
  const { acquirePullRequestDiff } = await import('../plugins/review-voice/src/diff/pull-request.ts');
  const original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    /\/pulls\/\d+$/.test(String(url))
      ? new Response(
          JSON.stringify({
            number: 1,
            title: 'small',
            base: { sha: 'b', ref: 'main' },
            head: { sha: 'h', ref: 'topic' },
            changed_files: 1,
            additions: 2,
            deletions: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      : new Response(
          JSON.stringify([{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    const result = await acquirePullRequestDiff({
      repository: 'org/a',
      pullNumber: 1,
      includeGenerated: false,
    });
    assert.equal(result.truncated, false);
    assert.equal(result.truncationNote, null);
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_TOKEN;
  }
});
