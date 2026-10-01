/**
 * Edges of the own-diff comparison where an author change could compare as
 * nothing at all: a revert hiding behind a shared site, a line-ending edit, and
 * a final-newline edit. Each must keep the follow-up from reading as unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

function scenario(base, reviewed, next) {
  const root = mkdtempSync(join(tmpdir(), 'rv-own-edge-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const commit = (contents, message) => {
    writeFileSync(join(root, 'src.ts'), contents);
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'core.autocrlf=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    const baseSha = commit(base, 'base');
    git('checkout', '-q', '-b', 'pr');
    const priorHead = commit(reviewed, 'reviewed');
    const head = commit(next, 'next');
    return planScope({
      priorRun: { reviewRunId: 'run_001', headRef: priorHead, createdAt: '2026-09-30T12:00:00.000Z' },
      head,
      headAvailable: true,
      reviewedFiles: [{ path: 'src.ts' }],
      cwd: root,
      truncated: false,
      forceFull: false,
      base: baseSha,
    }).scope;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('one rewrite on a shared site does not hide a second reviewed hunk being reverted', () => {
  const base = 'function a() {\n}\nfunction b() {\n}\nend();\n';
  const reviewed = 'function a() {\n}\nlockA();\nfunction b() {\n}\nlockB();\nend();\n';
  const next = 'function a() {\n}\nfunction b() {\n}\nlockB2();\nend();\n';
  const scope = scenario(base, reviewed, next);
  assert.equal(scope.kind, 'full');
  assert.equal(scope.cause, 'own-diff-unrepresentable');
});

test('a line-ending-only edit is not unchanged', () => {
  const base = 'first();\n';
  const scope = scenario(base, 'first();\nnewline();\n', 'first();\nnewline();\r\n');
  assert.notEqual(scope.kind, 'unchanged');
});

test('removing the final newline is not unchanged', () => {
  const base = 'first();\n';
  const scope = scenario(base, 'first();\ntail();\n', 'first();\ntail();');
  assert.notEqual(scope.kind, 'unchanged');
});
