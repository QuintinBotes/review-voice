/**
 * #67: `carry-candidates` given the interdiff `diff --pr` wrote by default
 * refused every candidate in a file the interdiff leaves out, with nothing
 * saying the diff was the wrong one. It now refuses that diff up front, and a
 * refusal for a file the diff does not touch names the diff it needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

const candidate = {
  candidate_id: 'cand_001',
  path: 'a.ts',
  line: 9,
  category: 'correctness',
  severity: 'important',
  claim: 'The loop at line 9 never ends.',
  failure_mode: 'The request hangs.',
  evidence: ['a.ts:9 has no exit condition.'],
  technical_confidence: 0.9,
};

/** The pull request's whole diff: `a.ts` is new, every line added. */
const fullDiff = ['diff --git a/a.ts b/a.ts', 'new file mode 100644', '--- /dev/null', '+++ b/a.ts', '@@ -0,0 +1,20 @@',
  ...lines(20).split('\n').slice(0, -1).map((r) => `+${r}`), ''].join('\n');
/** The interdiff since the review: only `b.ts`, which the author pushed. */
const interdiff = ['diff --git a/b.ts b/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/b.ts', '@@ -0,0 +1 @@', '+unrelated', ''].join('\n');

function withPush(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-issue-67-'));
  const repo = join(base, 'repo');
  try {
    for (const dir of [repo, join(base, 'full'), join(base, 'inter'), join(base, 'loose')]) mkdirSync(dir, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), lines(20));
    git('add', '-A');
    git('commit', '-q', '-m', 'reviewed');
    const since = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.ts'), 'unrelated\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'push');
    const head = git('rev-parse', 'HEAD');

    writeFileSync(join(base, 'candidates.json'), JSON.stringify({ candidates: [candidate] }));
    writeFileSync(join(base, 'verification.json'), JSON.stringify([{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.92 }]));
    const prior = { since, priorRunId: null, priorReviewedAt: null };
    writeFileSync(join(base, 'full', 'diff.patch'), fullDiff);
    writeFileSync(join(base, 'full', 'files.json'), JSON.stringify({ head, scope: { kind: 'full', cause: 'requested', ...prior } }));
    writeFileSync(join(base, 'inter', 'diff.patch'), interdiff);
    writeFileSync(
      join(base, 'inter', 'files.json'),
      JSON.stringify({ head, scope: { kind: 'interdiff', ...prior, mergeBase: since, files: ['b.ts'], hunks: 1 } }),
    );
    writeFileSync(join(base, 'loose', 'diff.patch'), interdiff);

    const carry = (dir) => {
      const r = spawnSync(
        process.execPath,
        [bundle, 'carry-candidates', '--candidates', join(base, 'candidates.json'), '--verification', join(base, 'verification.json'),
          '--since', since, '--head', head, '--diff-file', join(base, dir, 'diff.patch'), '--out', join(base, `out-${dir}`)],
        { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') } },
      );
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    return fn({ carry });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('the interdiff diff --pr wrote is refused up front, naming the diff to pass', () => {
  withPush(({ carry }) => {
    const result = carry('inter');
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /is the interdiff patch `diff --pr` wrote, not the whole pull request's diff/);
    assert.match(result.stderr, /diff --pr <number> --full --out <dir>/);
  });
});

test('the whole pull request diff carries a candidate in a file unchanged since the review', () => {
  withPush(({ carry }) => {
    const result = carry('full');
    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
});

test('a diff with no files.json beside it is read as given, and the refusal names the diff it needs', () => {
  withPush(({ carry }) => {
    const result = carry('loose');
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const refused = JSON.parse(result.stdout).refused ?? [];
    const text = JSON.stringify(refused) + result.stderr;
    assert.match(text, /in a file the diff does not touch; --diff-file must be the whole pull request's diff/);
  });
});

test('carry-candidates --help says --diff-file is the whole pull request diff and lists exit 1', () => {
  const r = spawnSync(process.execPath, [bundle, 'carry-candidates', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /whole pull request's diff/);
  assert.match(r.stdout, /1 at least one was refused/);
});
