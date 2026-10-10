/**
 * Issue #108: `diff --out` lists production files a change pushes past a
 * line-count threshold, as evidence for the analyst. It never touches the
 * verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countLines, findStructureSignals } from '../plugins/review-voice/src/diff/structure.ts';
import { productionPaths } from '../plugins/review-voice/src/diff/complexity.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// ---- line counting and the crossing rule ------------------------------------

test('countLines counts a last line without a newline', () => {
  assert.equal(countLines(Buffer.from('')), 0);
  assert.equal(countLines(Buffer.from('a')), 1);
  assert.equal(countLines(Buffer.from('a\n')), 1);
  assert.equal(countLines(Buffer.from('a\nb')), 2);
  assert.equal(countLines(Buffer.from('\n\n')), 2);
});

/** A patch adding `count` lines to `path` from new-side line `start`. */
function patchAdding(path, start, count) {
  const added = Array.from({ length: count }, (_, i) => `+line ${start + i}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start - 1},0 +${start},${count} @@`,
    added,
    '',
  ].join('\n');
}

const limits = { maxFileLines: 1000, maxAddedBranchesPerFunction: 3 };

test('a file crossing the threshold is listed, anchored at its first added line past it', () => {
  const diff = patchAdding('src/big.ts', 951, 100);
  const signals = findStructureSignals(diff, ['src/big.ts'], new Map([['src/big.ts', { base: 950, head: 1050 }]]), limits);
  assert.deepEqual(signals.sizeCrossings, [
    { path: 'src/big.ts', baseLines: 950, headLines: 1050, threshold: 1000, line: 1001 },
  ]);
  assert.deepEqual(signals.unmeasured, { count: 0, paths: [] });
});

test('the anchor falls back to the first added line when none lies past the threshold', () => {
  const diff = patchAdding('src/big.ts', 10, 60);
  const signals = findStructureSignals(diff, ['src/big.ts'], new Map([['src/big.ts', { base: 990, head: 1050 }]]), limits);
  assert.equal(signals.sizeCrossings[0].line, 10);
});

test('a file already over the threshold, one shrinking under it, or one staying under is not listed', () => {
  const counts = new Map([
    ['already.ts', { base: 1200, head: 1300 }],
    ['shrinks.ts', { base: 1100, head: 900 }],
    ['under.ts', { base: 400, head: 1000 }],
  ]);
  const signals = findStructureSignals('', [...counts.keys()], counts, limits);
  assert.deepEqual(signals.sizeCrossings, []);
});

test('a new file is counted from zero', () => {
  const diff = patchAdding('src/new.ts', 1, 1001);
  const signals = findStructureSignals(diff, ['src/new.ts'], new Map([['src/new.ts', { base: 0, head: 1001 }]]), limits);
  assert.equal(signals.sizeCrossings.length, 1);
  assert.equal(signals.sizeCrossings[0].line, 1001);
});

test('a side that could not be read is unmeasured, not fine', () => {
  const paths = Array.from({ length: 25 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
  const counts = new Map(paths.map((path) => [path, { base: 10, head: null }]));
  const signals = findStructureSignals('', paths, counts, limits);
  assert.deepEqual(signals.sizeCrossings, []);
  assert.equal(signals.unmeasured.count, 25);
  assert.equal(signals.unmeasured.paths.length, 20);
  assert.equal(signals.unmeasured.paths[0], 'src/f00.ts');
});

test('only production source is measured: tests, docs, generated and excluded files are not', () => {
  const file = (path, extra = {}) => ({
    path, status: 'modified', class: 'source', language: 'typescript', additions: 1, deletions: 0, reviewed: true, ...extra,
  });
  const files = [
    file('src/app.ts'),
    file('src/app.test.ts'),
    file('docs/guide.md', { language: 'markdown' }),
    file('src/gen/client.ts'),
    file('package-lock.json', { class: 'lockfile', reviewed: false }),
    file('src/marked.ts'),
  ];
  const paths = productionPaths(files, { generatedPaths: ['src/gen/**'] }, new Set(['src/marked.ts']));
  assert.deepEqual(paths, ['src/app.ts']);
});

// ---- configuration -------------------------------------------------------

function configIn(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-108-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice/config.yaml'), yaml);
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('review.structure.max_file_lines sets the threshold; a bad value warns and keeps the default', () => {
  assert.equal(configIn('review:\n  max_words_per_finding: 40\n').structure.maxFileLines, 1000);
  assert.equal(configIn('review:\n  structure:\n    max_file_lines: 600\n').structure.maxFileLines, 600);
  for (const bad of ['0', '2.5', '"many"']) {
    const config = configIn(`review:\n  structure:\n    max_file_lines: ${bad}\n`);
    assert.equal(config.structure.maxFileLines, 1000);
    assert.deepEqual(config.warnings, ['review.structure.max_file_lines must be a whole number above zero; using the default.']);
  }
});

// ---- diff --out, through the bundle ---------------------------------------

const lines = (count, prefix = 'const x') => Array.from({ length: count }, (_, i) => `${prefix}${i} = ${i};`).join('\n') + '\n';

function scratchRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rv-108-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'src/big.ts'), lines(950));
  writeFileSync(join(repo, 'src/huge.ts'), lines(1200));
  writeFileSync(join(repo, 'src/big.test.ts'), lines(950));
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { base, repo, git, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function diffOut(scratch, args = []) {
  const out = join(scratch.base, `out-${Math.random().toString(36).slice(2)}`);
  const result = spawnSync(process.execPath, [bundle, 'diff', ...args, '--out', out], {
    cwd: scratch.repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    summary: JSON.parse(result.stdout).summary,
    manifest: JSON.parse(readFileSync(join(out, 'files.json'), 'utf8')),
  };
}

function growFiles(repo) {
  writeFileSync(join(repo, 'src/big.ts'), lines(950) + lines(100, 'const y'));
  writeFileSync(join(repo, 'src/huge.ts'), lines(1200) + lines(100, 'const y'));
  writeFileSync(join(repo, 'src/big.test.ts'), lines(950) + lines(100, 'const y'));
}

test('diff --out lists a working-tree crossing in files.json and the summary, and leaves the verdict alone', () => {
  const scratch = scratchRepo();
  try {
    growFiles(scratch.repo);
    const { summary, manifest } = diffOut(scratch);
    assert.deepEqual(summary.structure.sizeCrossings, [
      { path: 'src/big.ts', baseLines: 950, headLines: 1050, threshold: 1000, line: 1001 },
    ]);
    assert.deepEqual(manifest.structure, summary.structure);
    assert.equal(summary.complexity.level, 'normal');
    assert.equal(summary.humanReviewNote, null);
  } finally {
    scratch.cleanup();
  }
});

test('diff --staged reads the head from the index, and --base from the commit', () => {
  const scratch = scratchRepo();
  try {
    growFiles(scratch.repo);
    scratch.git('add', '-A');
    // An unstaged edit past the staged one must not be what --staged measures.
    writeFileSync(join(scratch.repo, 'src/big.ts'), lines(10));
    const staged = diffOut(scratch, ['--staged']).summary.structure;
    assert.deepEqual(staged.sizeCrossings.map((c) => [c.path, c.headLines]), [['src/big.ts', 1050]]);

    scratch.git('checkout', '-q', '-b', 'feature');
    scratch.git('commit', '-q', '-m', 'grow');
    const branch = diffOut(scratch, ['--base', 'main']).summary.structure;
    assert.deepEqual(branch.sizeCrossings.map((c) => [c.path, c.baseLines, c.headLines]), [['src/big.ts', 950, 1050]]);
  } finally {
    scratch.cleanup();
  }
});

test('a renamed file is measured against its previous path, and the threshold comes from config', () => {
  const scratch = scratchRepo();
  try {
    scratch.git('mv', 'src/big.ts', 'src/moved.ts');
    writeFileSync(join(scratch.repo, 'src/moved.ts'), lines(950) + lines(20, 'const y'));
    mkdirSync(join(scratch.repo, '.review-voice'));
    writeFileSync(join(scratch.repo, '.review-voice/config.yaml'), 'review:\n  structure:\n    max_file_lines: 960\n');
    scratch.git('add', '-A');
    const structure = diffOut(scratch, ['--staged']).summary.structure;
    assert.deepEqual(
      structure.sizeCrossings.map((c) => [c.path, c.baseLines, c.headLines, c.threshold, c.line]),
      [['src/moved.ts', 950, 970, 960, 961]],
    );
  } finally {
    scratch.cleanup();
  }
});

test('a pull request whose head commit is not here has no head side to read', async () => {
  const { changeSides } = await import('../plugins/review-voice/src/diff/structure.ts');
  const sides = changeSides(root, { mode: 'pull-request', base: null, head: 'f'.repeat(40), refs: { head: { available: false } } });
  assert.deepEqual(sides, { base: null, head: null });
});

test('a follow-up review measures from the reviewed head, so an earlier crossing is not reported again', async () => {
  const { collectStructure } = await import('../plugins/review-voice/src/diff/structure.ts');
  const scratch = scratchRepo();
  try {
    const start = scratch.git('rev-parse', 'HEAD');
    writeFileSync(join(scratch.repo, 'src/big.ts'), lines(1050));
    scratch.git('commit', '-qam', 'cross');
    const reviewed = scratch.git('rev-parse', 'HEAD');
    writeFileSync(join(scratch.repo, 'src/big.ts'), lines(1055));
    scratch.git('commit', '-qam', 'grow a little');
    const head = scratch.git('rev-parse', 'HEAD');
    const files = [{ path: 'src/big.ts', status: 'modified', class: 'source', language: 'typescript', additions: 5, deletions: 0, reviewed: true }];
    const change = { mode: 'pull-request', base: start, head, diff: '', files, refs: { head: { available: true } } };

    const full = collectStructure(scratch.repo, change, ['src/big.ts']);
    assert.deepEqual(full.sizeCrossings.map((c) => [c.baseLines, c.headLines]), [[950, 1055]]);

    const followUp = collectStructure(scratch.repo, { ...change, scope: { kind: 'interdiff', since: reviewed } }, ['src/big.ts']);
    assert.deepEqual(followUp.sizeCrossings, []);
    assert.equal(followUp.unmeasured.count, 0);
  } finally {
    scratch.cleanup();
  }
});

test('a deleted file is neither a crossing nor unmeasured', async () => {
  const { collectStructure } = await import('../plugins/review-voice/src/diff/structure.ts');
  const scratch = scratchRepo();
  try {
    rmSync(join(scratch.repo, 'src/big.ts'));
    const files = [{ path: 'src/big.ts', status: 'deleted', class: 'source', language: 'typescript', additions: 0, deletions: 950, reviewed: true }];
    const signals = collectStructure(scratch.repo, { mode: 'worktree', base: null, head: scratch.git('rev-parse', 'HEAD'), diff: '', files }, ['src/big.ts']);
    assert.deepEqual(signals, { sizeCrossings: [], branchGrowth: [], typeEscapes: [], unmeasured: { count: 0, paths: [] } });
  } finally {
    scratch.cleanup();
  }
});
