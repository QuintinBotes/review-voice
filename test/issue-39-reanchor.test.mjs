import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// Right side: 1 context, 2-4 added, 5-6 context; b.ts line 2 added.
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,6 @@',
  ' line 1',
  '+/** The display name. */',
  '+name: string;',
  '+other: number;',
  ' line 2',
  ' line 3',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,2 +1,3 @@',
  ' one',
  '+two',
  ' three',
  '',
].join('\n');

const verified = (id, path, line, extra = {}) => ({
  candidateId: id,
  path,
  line,
  eligible: true,
  rejectedBecause: null,
  finalScore: 0.82,
  confidenceSource: 'verifier',
  severity: { severity: 'nit', reason: 'documentation' },
  anchorCheck: { path, line, kind: 'added', ok: true, nearest: [line], patchLine: null, beyondHunks: false },
  ...extra,
});

const SCORES = {
  scores: [
    verified('cand_001', 'src/a.ts', 3),
    verified('cand_002', 'src/a.ts', 4),
    { candidateId: 'cand_003', path: 'src/b.ts', line: 2, eligible: false, rejectedBecause: 'score 0.41 is below 0.68', finalScore: 0.41 },
    verified('cand_004', 'docs/usage.md', 9, {
      anchorCheck: { path: 'docs/usage.md', line: 9, kind: 'stale-consumer', ok: true, nearest: [], patchLine: null, beyondHunks: false },
    }),
  ],
  distribution: { count: 4 },
  eligible: [
    { candidateId: 'cand_001', path: 'src/a.ts', line: 3, severity: 'nit', claim: 'The doc comment names the wrong field.' },
    { candidateId: 'cand_002', path: 'src/a.ts', line: 4, severity: 'nit', claim: 'Another point.' },
    {
      candidateId: 'cand_004', path: 'docs/usage.md', line: 9, severity: 'nit', claim: 'Stale usage.',
      anchor: 'stale-consumer', causedBy: { path: 'src/a.ts', line: 3 },
    },
  ],
  belowGate: [],
};

const CANDIDATES = {
  candidates: [
    { candidate_id: 'cand_001', path: 'src/a.ts', line: 3, category: 'documentation' },
    { candidate_id: 'cand_002', path: 'src/a.ts', line: 4, category: 'documentation' },
  ],
};

function withFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reanchor-'));
  const files = {
    patch: join(dir, 'diff.patch'),
    scores: join(dir, 'scores.json'),
    candidates: join(dir, 'candidates.json'),
  };
  writeFileSync(files.patch, PATCH);
  writeFileSync(files.scores, JSON.stringify(SCORES, null, 2));
  writeFileSync(files.candidates, JSON.stringify(CANDIDATES, null, 2));
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const reanchor = (id, line, extra = []) =>
    run(['reanchor', '--candidate', id, '--line', String(line), '--scores', files.scores, '--diff-file', files.patch, ...extra]);
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  try {
    return fn({ files, run, reanchor, read });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reanchor moves a scored candidate one line and validate-output then accepts it', () => {
  withFiles(({ files, run, reanchor, read }) => {
    const corrected = '[nit] `src/a.ts:2` - The doc comment names the wrong field. Readers look for name.\n';
    const before = run(['validate-output', '--scores', files.scores], corrected);
    assert.equal(before.code, 1);
    assert.match(before.stderr, /severity_no_score/);

    const moved = reanchor('cand_001', 2, ['--candidates', files.candidates]);
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(JSON.parse(moved.stdout).to, { path: 'src/a.ts', line: 2 });

    const scores = read(files.scores);
    const entry = scores.scores.find((s) => s.candidateId === 'cand_001');
    assert.equal(entry.line, 2);
    assert.deepEqual(entry.reanchoredFrom, { path: 'src/a.ts', line: 3 });
    // The score and its verification-derived fields are kept as they were.
    assert.equal(entry.finalScore, 0.82);
    assert.equal(entry.confidenceSource, 'verifier');
    assert.equal(entry.anchorCheck.kind, 'added');
    assert.equal(scores.eligible.find((s) => s.candidateId === 'cand_001').line, 2);
    assert.equal(read(files.candidates).candidates[0].line, 2);

    assert.equal(run(['validate-output', '--scores', files.scores], corrected).code, 0);
  });
});

test('reanchor can move a candidate to another file in the diff', () => {
  withFiles(({ reanchor, read, files }) => {
    const moved = reanchor('cand_002', 2, ['--path', 'src/b.ts']);
    assert.equal(moved.code, 0, moved.stderr);
    const entry = read(files.scores).scores.find((s) => s.candidateId === 'cand_002');
    assert.deepEqual([entry.path, entry.line], ['src/b.ts', 2]);
  });
});

test('reanchor refuses a line the diff did not change, and writes nothing', () => {
  withFiles(({ reanchor, files }) => {
    const before = readFileSync(files.scores, 'utf8');
    for (const line of [1, 5, 40]) {
      const refused = reanchor('cand_001', line, ['--candidates', files.candidates]);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /Not re-anchored: cand_001 anchors on src\/a\.ts/);
    }
    assert.equal(reanchor('cand_001', 2, ['--path', 'src/c.ts']).code, 1);
    assert.equal(readFileSync(files.scores, 'utf8'), before);
    assert.equal(JSON.parse(readFileSync(files.candidates, 'utf8')).candidates[0].line, 3);
  });
});

test('reanchor refuses a rejected candidate, a stale consumer and a taken location', () => {
  withFiles(({ reanchor }) => {
    const rejected = reanchor('cand_003', 2);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /not eligible/);

    const stale = reanchor('cand_004', 2);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /stale consumer/);

    const taken = reanchor('cand_001', 4);
    assert.equal(taken.code, 1);
    assert.match(taken.stderr, /cand_002 is already anchored at src\/a\.ts:4/);

    assert.equal(reanchor('cand_999', 2).code, 1);
  });
});

test('reanchor exits 2 without its required flags or for a candidate missing from --candidates', () => {
  withFiles(({ run, reanchor, files }) => {
    assert.equal(run(['reanchor', '--candidate', 'cand_001', '--line', '2']).code, 2);
    writeFileSync(files.candidates, JSON.stringify({ candidates: [] }));
    const before = readFileSync(files.scores, 'utf8');
    assert.equal(reanchor('cand_001', 2, ['--candidates', files.candidates]).code, 2);
    assert.equal(readFileSync(files.scores, 'utf8'), before);
  });
});
