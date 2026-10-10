/**
 * An ordinary follow-up commit that edits the line next to a reviewed hunk.
 *
 * git merges the two edits into one hunk, and the reviewed hunk's neighbouring
 * context line now shows as removed. That used to read as a revert, and the
 * follow-up review read the whole pull request again. The reviewed edit is
 * still there, so the new hunk alone is what needs reading. A real revert next
 * to such an edit must still read in full.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const numbered = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);
const text = (lines) => `${lines.join('\n')}\n`;

/** Base, reviewed head and follow-up head of one file, planned against the base. */
function scenario(base, reviewed, next) {
  const root = mkdtempSync(join(tmpdir(), 'rv-adjacent-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (contents, message) => {
    writeFileSync(join(root, 'src.ts'), contents);
    git('add', '-A');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    const baseSha = commit(text(base), 'base');
    git('checkout', '-q', '-b', 'pr');
    const priorHead = commit(text(reviewed), 'reviewed');
    const head = commit(text(next), 'address review feedback');
    return planScope({
      priorRun: { reviewRunId: 'run_001', headRef: priorHead, createdAt: '2026-09-30T12:00:00.000Z' },
      head,
      headAvailable: true,
      reviewedFiles: [{ path: 'src.ts' }],
      cwd: root,
      truncated: false,
      forceFull: false,
      base: baseSha,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `lines` with `added` inserted after line `after` (1-based). */
const insertAfter = (lines, after, added) => [...lines.slice(0, after), added, ...lines.slice(after)];
const replace = (lines, number, value) => lines.map((line, index) => (index === number - 1 ? value : line));

const base = numbered(20);
const reviewed = insertAfter(base, 10, 'added by the author');

test('a follow-up that edits the line after a reviewed addition reads only the new hunk', () => {
  const next = replace(reviewed, 12, 'line 11 edited after review');
  const { scope, interdiffPatch } = scenario(base, reviewed, next);
  assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
  assert.deepEqual(scope.files, ['src.ts']);
  assert.equal(scope.hunks, 1);
  assert.match(interdiffPatch, /^\+line 11 edited after review$/m);
  assert.match(interdiffPatch, /^-line 11$/m);
});

test('a follow-up that edits the line before a reviewed addition reads only the new hunk', () => {
  const next = replace(reviewed, 10, 'line 10 edited after review');
  const { scope, interdiffPatch } = scenario(base, reviewed, next);
  assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
  assert.match(interdiffPatch, /^\+line 10 edited after review$/m);
});

test('a follow-up that edits the line after a reviewed replacement reads only the new hunk', () => {
  const replaced = replace(base, 5, 'line 5 changed by the author');
  const next = replace(replaced, 6, 'line 6 changed after review');
  const { scope, interdiffPatch } = scenario(base, replaced, next);
  assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
  assert.match(interdiffPatch, /^\+line 6 changed after review$/m);
});

test('a follow-up that edits the line next to a reviewed removal reads only the new hunk', () => {
  const removed = base.filter((line) => line !== 'line 8');
  const next = replace(removed, 8, 'line 9 edited after review');
  const { scope } = scenario(base, removed, next);
  assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
});

// Safety: matching the site on its text alone would accept these, because the
// new hunk still sits on the reviewed hunk's lines. The reviewed edit is gone,
// so the follow-up must be read in full.

test('a reverted addition next to an edited neighbour is read as its removal', () => {
  const next = replace(base, 11, 'line 11 edited after review');
  const { scope, interdiffPatch } = scenario(base, reviewed, next);
  assert.equal(scope.kind, 'interdiff');
  assert.match(interdiffPatch, /^-added by the author$/m);
  assert.match(interdiffPatch, /^\+line 11 edited after review$/m);
});

test('a reverted addition next to an edited line before it is read as its removal', () => {
  const next = replace(base, 10, 'line 10 edited after review');
  const { scope, interdiffPatch } = scenario(base, reviewed, next);
  assert.equal(scope.kind, 'interdiff');
  assert.match(interdiffPatch, /^-added by the author$/m);
});

test('a reverted replacement next to an edited neighbour is read as its removal', () => {
  const replaced = replace(base, 5, 'line 5 changed by the author');
  const next = replace(base, 6, 'line 6 changed after review');
  const { scope, interdiffPatch } = scenario(base, replaced, next);
  assert.equal(scope.kind, 'interdiff');
  assert.match(interdiffPatch, /^-line 5 changed by the author$/m);
});

test('a restored removal next to an edited neighbour is read as the restored line', () => {
  const removed = base.filter((line) => line !== 'line 8');
  const next = replace(base, 9, 'line 9 edited after review');
  const { scope, interdiffPatch } = scenario(base, removed, next);
  assert.equal(scope.kind, 'interdiff');
  assert.match(interdiffPatch, /^\+line 8$/m);
});

test('one of two reviewed additions reverted beside an edit is read as its removal', () => {
  const twice = insertAfter(insertAfter(base, 10, 'first addition'), 12, 'second addition');
  // The second addition is withdrawn and the line between them edited.
  const next = replace(insertAfter(base, 10, 'first addition'), 12, 'line 11 edited after review');
  const { scope, interdiffPatch } = scenario(base, twice, next);
  assert.equal(scope.kind, 'interdiff');
  assert.match(interdiffPatch, /^-second addition$/m);
});
