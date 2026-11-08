/**
 * #251: every patch the review reads is taken with an explicit context size,
 * so the same two heads produce the same hunks on every machine, whatever the
 * user's diff.context says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

/** A repository whose owner turned context lines off, with a reviewed head A and a follow-up head B. */
function withContextOff(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-251-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const lines = (n) => Array.from({ length: n }, (_, index) => `line ${index + 1}\n`).join('');
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'diff.context', '0');
    writeFileSync(join(root, 'a.ts'), lines(40));
    const base = commit('initial');
    git('checkout', '-q', '-b', 'pr');
    writeFileSync(join(root, 'a.ts'), lines(40).replace('line 10\n', 'line 10 by the author\n'));
    const reviewed = commit('reviewed head A');
    writeFileSync(join(root, 'a.ts'), lines(40).replace('line 10\n', 'line 10 by the author\n').replace('line 30\n', 'line 30 after the review\n'));
    const head = commit('follow-up head B');
    return fn({ root, git, base, reviewed, head });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('diff --base writes a patch with three context lines when the repository sets diff.context to 0', () => {
  withContextOff((repository) => {
    const out = mkdtempSync(join(tmpdir(), 'rv-issue-251-out-'));
    const data = mkdtempSync(join(tmpdir(), 'rv-issue-251-data-'));
    try {
      const bundle = join(process.cwd(), 'plugins/review-voice/dist/review-voice.mjs');
      execFileSync(process.execPath, [bundle, 'diff', '--base', 'main', '--out', out], {
        cwd: repository.root,
        encoding: 'utf8',
        env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const patch = readFileSync(join(out, 'diff.patch'), 'utf8');
      assert.match(patch, /^@@ -7,7 \+7,7 @@/m);
      assert.match(patch, /^@@ -27,7 \+27,7 @@/m);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

test('the interdiff keeps three context lines when the repository sets diff.context to 0', () => {
  withContextOff((repository) => {
    // The setting is in force for git itself.
    assert.match(repository.git('diff', repository.reviewed, repository.head), /^@@ -30 \+30 @@/m);
    const { scope, interdiffPatch } = planScope({
      priorRun: { reviewRunId: null, headRef: repository.reviewed, createdAt: null },
      head: repository.head,
      headAvailable: true,
      reviewedFiles: [{ path: 'a.ts' }],
      cwd: repository.root,
      truncated: false,
      forceFull: false,
      base: repository.base,
    });
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.match(interdiffPatch, /^@@ -27,7 \+27,7 @@/m);
    assert.match(interdiffPatch, /^ line 27$/m);
    assert.doesNotMatch(interdiffPatch, /line 10/);
  });
});
