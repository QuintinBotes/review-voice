/**
 * Generated output is reviewed but left out of the decision-point count
 * (docs/adr/0012, amended 2026-10-06): files classified as generated, files
 * marked `linguist-generated` in .gitattributes, and configured globs. A
 * generator change of a few hundred lines once read as thousands of decision
 * points because of the output it emitted. Sensitive paths still apply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessComplexity, humanReviewNote, parseComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { linguistGeneratedPaths } from '../plugins/review-voice/src/diff/acquire.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const file = (path, extra = {}) => ({
  path,
  status: 'modified',
  class: 'source',
  language: null,
  additions: 1,
  deletions: 0,
  reviewed: true,
  ...extra,
});

function patch(path, added, start = 1) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +${start},${added.length} @@`,
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
}

const workflowLines = (n) => Array.from({ length: n }, () => "    if: github.event_name == 'push' && matrix.os == 'linux' || inputs.force");

test('linguist-generated, a configured glob and a reviewed generated-class file are all left out', () => {
  const diff = [
    patch('.github/workflows/build.yml', workflowLines(50)),
    patch('ci/out/deploy.yml', workflowLines(20)),
    patch('src/api/client.g.ts', ['if (a) {}']),
    patch('tools/workflow-gen/emit.ts', ['if (job.matrix) {', '} else if (job.needs) {'], 10),
  ].join('');
  const files = [
    file('.github/workflows/build.yml'),
    file('ci/out/deploy.yml'),
    file('src/api/client.g.ts', { class: 'generated', handEditSuspected: true }),
    file('tools/workflow-gen/emit.ts'),
  ];
  const result = assessComplexity(diff, files, { generatedPaths: ['ci/out/**'] }, new Set(['.github/workflows/build.yml']));

  assert.equal(result.decisionPoints, 2);
  assert.deepEqual(result.densestHunk, { path: 'tools/workflow-gen/emit.ts', line: 10, decisionPoints: 2 });
  assert.equal(result.excluded.generatedFiles, 3);
  assert.equal(result.excluded.generatedDecisionPoints, 70 * 3 + 1);
  // Sensitive-path matching is unchanged: the generated workflow still flags.
  assert.deepEqual(result.sensitivePaths, ['.github/workflows/build.yml']);
  assert.equal(result.level, 'high');
  assert.deepEqual(result.reasons, ['touches sensitive paths (.github/workflows/build.yml)']);
  assert.match(humanReviewNote(result), /Left out of the decision-point count: 3 generated files \(211 decision points\)\./);
});

test('without the attribute or a glob the same output is counted, as before', () => {
  const diff = patch('ci/out/deploy.yml', workflowLines(20));
  const result = assessComplexity(diff, [file('ci/out/deploy.yml')], { sensitivePaths: [] });
  assert.equal(result.decisionPoints, 60);
  assert.equal(result.excluded.generatedFiles, 0);
});

test('generated globs round-trip; an older record without them still parses', () => {
  const result = assessComplexity(patch('gen/a.ts', ['if (a) {}']), [file('gen/a.ts')], { generatedPaths: ['gen/**'] });
  assert.deepEqual(result.limits.generatedPaths, ['gen/**']);
  assert.deepEqual(parseComplexity(JSON.parse(JSON.stringify(result))), result);

  const older = JSON.parse(JSON.stringify(result));
  delete older.excluded.generatedFiles;
  delete older.excluded.generatedDecisionPoints;
  delete older.limits.generatedPaths;
  const parsed = parseComplexity(older);
  assert.equal(parsed.excluded.generatedDecisionPoints, 0);
  assert.deepEqual(parsed.limits.generatedPaths, []);
});

test('review.human_review.generated_paths is read from config and defaults to none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-42-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    assert.deepEqual(loadConfig(dir).humanReview.generatedPaths, []);
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), 'review:\n  human_review:\n    generated_paths: ["ci/out/**"]\n');
    assert.deepEqual(loadConfig(dir).humanReview.generatedPaths, ['ci/out/**']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- .gitattributes, through git and the bundle ----------------------------------

function scratchRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rv-issue-42-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { base, repo, git, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('linguistGeneratedPaths reads set and true, ignores unset, and falls back to the working tree', () => {
  const scratch = scratchRepo();
  try {
    writeFileSync(
      join(scratch.repo, '.gitattributes'),
      'pipelines/*.yml linguist-generated\nsdk/** linguist-generated=true\npipelines/manual.yml -linguist-generated\n',
    );
    const paths = ['pipelines/build.yml', 'pipelines/manual.yml', 'sdk/x/client.ts', 'src/a.ts'];
    const expected = new Set(['pipelines/build.yml', 'sdk/x/client.ts']);
    assert.deepEqual(linguistGeneratedPaths(scratch.repo, paths), expected);
    // The attributes are not committed yet, so a commit source has none and
    // the working tree is not consulted: the commit is what was reviewed.
    assert.deepEqual(linguistGeneratedPaths(scratch.repo, paths, 'HEAD'), new Set());
    scratch.git('add', '-A');
    scratch.git('commit', '-q', '-m', 'attributes');
    assert.deepEqual(linguistGeneratedPaths(scratch.repo, paths, 'HEAD'), expected);
    // A commit git does not have falls back to the working tree.
    assert.deepEqual(linguistGeneratedPaths(scratch.repo, paths, 'f'.repeat(40)), expected);
    assert.deepEqual(linguistGeneratedPaths(join(scratch.base, 'data'), paths), new Set());
  } finally {
    scratch.cleanup();
  }
});

test('diff honours linguist-generated: generated output is reported, not counted', () => {
  const scratch = scratchRepo();
  try {
    writeFileSync(join(scratch.repo, '.gitattributes'), 'sdk/** linguist-generated\n');
    mkdirSync(join(scratch.repo, 'sdk'));
    writeFileSync(join(scratch.repo, 'sdk/client.ts'), Array.from({ length: 30 }, () => 'if (a && b) { go(); }').join('\n') + '\n');
    writeFileSync(join(scratch.repo, 'gen.ts'), 'if (a) { emit(); }\n');

    const result = spawnSync(process.execPath, [bundle, 'diff', '--out', join(scratch.base, 'out')], {
      cwd: scratch.repo,
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.dataDir },
    });
    assert.equal(result.status, 0, result.stderr);
    const complexity = JSON.parse(result.stdout).summary.complexity;
    assert.equal(complexity.level, 'normal');
    assert.equal(complexity.decisionPoints, 1);
    assert.equal(complexity.excluded.generatedFiles, 1);
    assert.equal(complexity.excluded.generatedDecisionPoints, 60);
  } finally {
    scratch.cleanup();
  }
});
