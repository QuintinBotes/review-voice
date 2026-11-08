/**
 * Issue 265: a change that only deletes a guarded file has no reviewed file,
 * yet the control it removed is a lead and a finding about it is real. Given
 * the two commits, check-candidates accepts a candidate on a file present at
 * the base and absent at the head, at a line its base copy has. It asks git,
 * so no manifest, stale or crafted, can grant the exemption.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const GUARD = ['export function requireAdmin(user) {', "  if (!user.isAdmin) throw new Error('Forbidden');", '}', ''].join('\n');

const candidate = (extra = {}) => ({
  candidate_id: 'cand_001', path: 'src/guard.ts', line: 2, category: 'authorization', severity: 'important',
  claim: 'Deleting requireAdmin removes the only admin check.', failure_mode: 'Non-admin users reach admin actions.',
  evidence: ['src/guard.ts:2 at the base threw Forbidden.'], technical_confidence: 0.9, ...extra,
});

/**
 * A base with src/guard.ts, src/old.ts, README.md and a lock file. The head
 * deletes the guard and the lock file and renames old.ts; afterwards the base
 * branch moves on and adds src/upstream.ts, which the change never touched.
 */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-265-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/guard.ts'), GUARD);
  writeFileSync(join(dir, 'README.md'), '# Api\n\nSums prices.\n');
  writeFileSync(join(dir, 'package-lock.json'), '{\n  "lockfileVersion": 3\n}\n');
  writeFileSync(join(dir, 'src/old.ts'), 'export const total = (items) => items.length;\nexport const unit = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  git('rm', '-q', 'src/guard.ts', 'package-lock.json');
  git('mv', 'src/old.ts', 'src/moved.ts');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'src/upstream.ts'), 'export const later = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'upstream');
  const upstream = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'feature');
  writeFileSync(join(dir, 'diff.patch'), '');
  return { dir, base, head, upstream };
}

async function check(s, candidates, refs = ['--base', s.base, '--head', s.head]) {
  const saved = process.cwd();
  process.chdir(s.dir);
  try {
    return await runInProcess(['check-candidates', '--diff-file', join(s.dir, 'diff.patch'), ...refs], { stdin: JSON.stringify({ candidates }) });
  } finally {
    process.chdir(saved);
  }
}

test('check-candidates accepts a candidate on a file the change deleted, at a line of its base copy', async (t) => {
  const s = scratch(t);
  const result = await check(s, [candidate()]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /1 candidate on a deleted file, posted in the review body: cand_001/);
  assert.equal((await check(s, [candidate({ line: 3 })])).code, 0, 'the last line of the base copy');
});

test('without both commits, or with a commit the clone lacks, the anchor fails as it always did', async (t) => {
  const s = scratch(t);
  for (const refs of [[], ['--base', s.base], ['--head', s.head], ['--base', s.base, '--head', 'f'.repeat(40)]]) {
    const result = await check(s, [candidate()], refs);
    assert.equal(result.code, 1, refs.join(' '));
    assert.equal(JSON.parse(result.stdout).anchorFailures[0].kind, 'file-not-in-diff');
  }
});

test('a file that still exists at the head is not exempt, whatever a manifest says', async (t) => {
  const s = scratch(t);
  const result = await check(s, [candidate({ path: 'README.md', line: 2 })]);
  assert.equal(result.code, 1);
});

test('a line the deleted file never had, a file the base never had, and a lock file are not exempt', async (t) => {
  const s = scratch(t);
  for (const extra of [{ line: 4 }, { line: 999999 }, { path: 'src/never.ts', line: 1 }, { path: 'package-lock.json', line: 1 }, { path: '../src/guard.ts', line: 2 }]) {
    assert.equal((await check(s, [candidate(extra)])).code, 1, JSON.stringify(extra));
  }
});

test('the anchors command puts a deleted-file finding in the body, with or without a diff to check', async (t) => {
  const s = scratch(t);
  const scores = join(s.dir, 'scores.json');
  writeFileSync(scores, JSON.stringify({ scores: [{ path: 'src/guard.ts', line: 2, eligible: true, confidenceSource: 'verifier', severity: { severity: 'blocking' }, deletedFile: true }] }));
  const review = '[blocking] `src/guard.ts:2` - Deleting requireAdmin removes the only admin check. Restore it.';
  for (const extra of [[], ['--diff-file', join(s.dir, 'diff.patch')]]) {
    const result = await runInProcess(['anchors', '--scores', scores, ...extra], { stdin: review });
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out.anchors, [], extra.join(' ') || 'no diff');
    assert.deepEqual(out.unanchored.map((entry) => [entry.path, entry.reason]), [['src/guard.ts', 'file-not-in-diff']]);
  }
});

test('the slash command reviews a deletion-only change that removed a control, and gives both checks the two commits', () => {
  const text = read('plugins/review-voice/commands/review.md');
  assert.match(text, /If `reviewedFileCount` is `0` and `structure\.removedControls` is empty, output\nexactly this and stop:/);
  assert.match(text, /every one is from a file the change deleted \(`deletedFile: true`\)\. Do not\nstop/);
  assert.match(text, /RV check-candidates --diff-file <tmpdir>\/diff\.patch`, adding\n`--base <ref> --head <head sha>`/);
  assert.match(text, /RV score --repository <name> --verification <tmpdir>\/verification\.json --base <ref> --head <head sha> --diff-file <tmpdir>\/diff\.patch/);
});

test('both prompts say where a deleted file\'s base copy is and how to anchor on it', () => {
  assert.match(read('plugins/review-voice/agents/diff-analyst.md'), /An entry with `deletedFile: true` comes from a file the change deletes/);
  assert.match(read('plugins/review-voice/agents/evidence-verifier.md'), /Read its base copy \(the `base\/` directory the prompt\nnames/);
});

test('the old path of a rename is not a deletion, though it is gone from the head', async (t) => {
  const s = scratch(t);
  assert.equal((await check(s, [candidate({ path: 'src/old.ts', line: 1 })])).code, 1);
});

test('against the base branch tip, a file the base added after the fork is not one this change deleted', async (t) => {
  const s = scratch(t);
  const refs = ['--base', s.upstream, '--head', s.head];
  assert.equal((await check(s, [candidate({ path: 'src/upstream.ts', line: 1 })], refs)).code, 1, 'the upstream file');
  assert.equal((await check(s, [candidate()], refs)).code, 0, 'while the real deletion is still measured from the merge base');
});

test('a deletion is matched by the path git reports, so a file whose name differs only by its separator is not exempt', async (t) => {
  const s = scratch(t);
  const git = (...args) => execFileSync('git', args, { cwd: s.dir, encoding: 'utf8' }).trim();
  // Both names at the base; the change deletes only the one with a backslash in its name.
  writeFileSync(join(s.dir, 'src', 'guard.ts'), GUARD);
  writeFileSync(join(s.dir, 'src\\guard.ts'), GUARD);
  git('add', '-A');
  git('commit', '-q', '-m', 'both names');
  const base = git('rev-parse', 'HEAD');
  git('rm', '-q', 'src\\guard.ts');
  git('commit', '-q', '-m', 'delete the backslash one');
  const head = git('rev-parse', 'HEAD');
  const refs = ['--base', base, '--head', head];
  assert.equal((await check(s, [candidate({ path: 'src/guard.ts' })], refs)).code, 1, 'the file still at the head is not exempt');
  assert.equal((await check(s, [candidate({ path: 'src\\guard.ts' })], refs)).code, 0, 'the deleted one is');
});
