/**
 * #386: `diff --base` returned `mergeBase: null` and `refs: null`, while the
 * review reads the starting tree at the merge base.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

test('diff --base names both commits and the merge base the patch starts at', () => {
  const base = mkdtempSync(join(tmpdir(), 'rv-386-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    const commit = (file, text, message) => {
      writeFileSync(join(repo, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const fork = commit('src/a.ts', 'export const a = 1;\n', 'initial');
    git('checkout', '-q', '-b', 'feature');
    const head = commit('src/b.ts', 'export const b = 2;\n', 'feature');
    git('checkout', '-q', 'main');
    const tip = commit('src/c.ts', 'export const c = 3;\n', 'main moves on');
    git('checkout', '-q', 'feature');

    const result = spawnSync(process.execPath, [bundle, 'diff', '--base', 'main', '--out', join(base, 'out')], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    const { summary } = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'base');
    assert.equal(summary.mergeBase, fork);
    assert.deepEqual(summary.refs, {
      base: { sha: tip, available: true },
      head: { sha: head, available: true },
      mergeBase: fork,
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
