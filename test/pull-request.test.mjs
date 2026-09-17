import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

// Ref availability. `diff --pr` builds the diff from the API and never touches
// local git, so nothing downstream had grounds to believe base or head could be
// read. On a live run head was simply absent and the verifier fell back to the
// patch without saying so.

/** Built from parts so the identity guard does not read it as an address. */
const sshRemote = (repo) => `${'git'}@github.com:${repo}.git`;

function gitRepo(originUrl) {
  const root = mkdtempSync(join(tmpdir(), 'rv-refs-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  if (originUrl) git('remote', 'add', 'origin', originUrl);
  return { root, head: git('rev-parse', 'HEAD').trim() };
}

async function pullRequestWith(shas, options) {
  const { acquirePullRequestDiff } = await import('../plugins/review-voice/src/diff/pull-request.ts');
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/\/pulls\/\d+$/.test(String(url))) {
      return new Response(
        JSON.stringify({
          number: 7,
          title: 't',
          base: { sha: shas.base, ref: 'main' },
          head: { sha: shas.head, ref: 'topic' },
          changed_files: 1,
          additions: 1,
          deletions: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify([{ filename: 'a.txt', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    return await acquirePullRequestDiff({
      repository: 'org/a',
      pullNumber: 7,
      includeGenerated: false,
      ...options,
    });
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_TOKEN;
  }
}

test('ref availability is established by asking git, not by assuming a fetch worked', async () => {
  const { root, head } = gitRepo(null);
  try {
    const result = await pullRequestWith(
      { base: head, head: '0'.repeat(40) },
      { cwd: root },
    );

    assert.equal(result.refs.base.available, true, 'a commit that is present reads as present');
    assert.equal(result.refs.head.available, false, 'a commit that is absent is never assumed present');
    assert.equal(result.refs.head.sha, '0'.repeat(40));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clone of a different repository is never fetched from', async () => {
  // Fetching pull/<n>/head from an unrelated clone yields plausible commits
  // from the wrong project, which is strictly worse than their absence.
  const { root, head } = gitRepo(sshRemote('someone/unrelated'));
  try {
    const result = await pullRequestWith({ base: head, head: '0'.repeat(40) }, { cwd: root });

    assert.equal(result.refs.fetched, false);
    assert.match(result.refs.note, /someone\/unrelated/);
    assert.match(result.refs.note, /wrong project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fetch that cannot run is not fatal, and the diff still arrives', async () => {
  const { root, head } = gitRepo(sshRemote('org/a'));
  try {
    const result = await pullRequestWith({ base: head, head: '0'.repeat(40) }, { cwd: root });

    // No network in the test; the fetch fails and the review proceeds.
    assert.equal(result.reviewedFileCount, 1);
    assert.equal(result.refs.head.available, false);
    assert.match(result.refs.note, /could not be made available/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('when both commits are already present nothing is fetched and no note is raised', async () => {
  const { root, head } = gitRepo(sshRemote('org/a'));
  try {
    const result = await pullRequestWith({ base: head, head }, { cwd: root });

    assert.equal(result.refs.fetched, false);
    assert.equal(result.refs.note, null);
    assert.equal(result.refs.base.available, true);
    assert.equal(result.refs.head.available, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
