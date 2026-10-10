/**
 * `.gitattributes` decides what counts as generated only as of the commit a
 * change starts from (docs/adr/0012, amended 2026-10-06). Read at the head, a
 * change adding `src/** linguist-generated` would exempt its own code from the
 * decision-point count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributeSource } from '../plugins/review-voice/src/diff/acquire.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function scratchRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rv-attr-base-'));
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
  const diff = (...args) => {
    const result = spawnSync(process.execPath, [bundle, 'diff', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    return parsed.complexity ?? parsed.summary.complexity;
  };
  return { base, repo, git, diff, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const branchy = Array.from({ length: 30 }, () => 'if (a && b) { go(); }').join('\n') + '\n';

test('a branch that introduces linguist-generated for its own code still counts that code', () => {
  const scratch = scratchRepo();
  try {
    scratch.git('checkout', '-q', '-b', 'feature');
    mkdirSync(join(scratch.repo, 'src'));
    writeFileSync(join(scratch.repo, 'src/a.ts'), branchy);
    writeFileSync(join(scratch.repo, '.gitattributes'), 'src/** linguist-generated\n');
    scratch.git('add', '-A');
    scratch.git('commit', '-q', '-m', 'feature');

    const complexity = scratch.diff('--base', 'main');
    assert.equal(complexity.decisionPoints, 60);
    assert.equal(complexity.excluded.generatedFiles, 0);
    assert.equal(complexity.level, 'high');
  } finally {
    scratch.cleanup();
  }
});

test('an uncommitted attribute does not exempt the working-tree change it is part of', () => {
  const scratch = scratchRepo();
  try {
    mkdirSync(join(scratch.repo, 'src'));
    writeFileSync(join(scratch.repo, 'src/a.ts'), branchy);
    writeFileSync(join(scratch.repo, '.gitattributes'), 'src/** linguist-generated\n');
    const complexity = scratch.diff();
    assert.equal(complexity.decisionPoints, 60);
    assert.equal(complexity.excluded.generatedFiles, 0);
  } finally {
    scratch.cleanup();
  }
});

test('an attribute already on the base branch is honoured', () => {
  const scratch = scratchRepo();
  try {
    writeFileSync(join(scratch.repo, '.gitattributes'), 'sdk/** linguist-generated\n');
    scratch.git('add', '-A');
    scratch.git('commit', '-q', '-m', 'attributes');
    scratch.git('checkout', '-q', '-b', 'feature');
    mkdirSync(join(scratch.repo, 'sdk'));
    writeFileSync(join(scratch.repo, 'sdk/client.ts'), branchy);
    scratch.git('add', '-A');
    scratch.git('commit', '-q', '-m', 'regenerate');

    const complexity = scratch.diff('--base', 'main');
    assert.equal(complexity.decisionPoints, 0);
    assert.equal(complexity.excluded.generatedFiles, 1);
    assert.equal(complexity.excluded.generatedDecisionPoints, 60);
  } finally {
    scratch.cleanup();
  }
});

test('attributeSource is the merge base, else the base, else null; HEAD for local changes', () => {
  const scratch = scratchRepo();
  try {
    const main = scratch.git('rev-parse', 'HEAD');
    scratch.git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(scratch.repo, 'b.ts'), 'x\n');
    scratch.git('add', '-A');
    scratch.git('commit', '-q', '-m', 'b');
    const head = scratch.git('rev-parse', 'HEAD');

    assert.equal(attributeSource(scratch.repo, { mode: 'base', base: 'main', head }), main);
    assert.equal(attributeSource(scratch.repo, { mode: 'pull-request', base: main, head }), main);
    // The head is not here: fall back to the base, never to the head.
    assert.equal(attributeSource(scratch.repo, { mode: 'pull-request', base: main, head: 'e'.repeat(40) }), main);
    assert.equal(attributeSource(scratch.repo, { mode: 'pull-request', base: 'd'.repeat(40), head }), null);
    assert.equal(attributeSource(scratch.repo, { mode: 'pull-request', base: null, head }), null);
    assert.equal(attributeSource(scratch.repo, { mode: 'worktree', base: null, head }), head);
  } finally {
    scratch.cleanup();
  }
});
