import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStructure } from '../plugins/review-voice/src/diff/structure.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const controlPath = 'src/control.ts';
const guard = '  if (!permission) stop();';

function scratchRepo(t, extraFiles = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rv-removed-controls-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries({
    [controlPath]: `export function run(permission) {\n${guard}\n  work();\n}\n`,
    'src/other.ts': 'export const value = 1;\n',
    ...extraFiles,
  })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { base, repo, dataDir, git };
}

function diffOut(scratch, args = []) {
  const out = join(scratch.base, 'out');
  const result = spawnSync(process.execPath, [bundle, 'diff', ...args, '--out', out], {
    cwd: scratch.repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  const manifest = JSON.parse(readFileSync(join(out, 'files.json'), 'utf8'));
  assert.deepEqual(manifest.structure.removedControls, summary.structure.removedControls);
  assert.equal(manifest.files.find(({ path }) => path === controlPath).status, 'deleted');
  return summary;
}

for (const mode of ['worktree', 'staged', 'base']) {
  test(`diff --out reads a deleted production control from the base in ${mode} mode`, (t) => {
    const scratch = scratchRepo(t);
    rmSync(join(scratch.repo, controlPath));
    if (mode !== 'worktree') scratch.git('add', '-A');
    if (mode === 'base') {
      scratch.git('checkout', '-q', '-b', 'feature');
      scratch.git('commit', '-q', '-m', 'remove control');
    }
    const args = mode === 'staged' ? ['--staged'] : mode === 'base' ? ['--base', 'main'] : [];
    const summary = diffOut(scratch, args);
    assert.deepEqual(summary.structure.removedControls, [
      { path: controlPath, line: 1, kind: 'guard', text: guard.trim(), deletedFile: true },
    ]);
    assert.equal(summary.complexity.level, 'normal');
    assert.equal(summary.humanReviewNote, null);
  });
}

test('a deleted control is skipped when the base side is unavailable', (t) => {
  const scratch = scratchRepo(t);
  rmSync(join(scratch.repo, controlPath));
  const change = {
    mode: 'pull-request', base: null, head: scratch.git('rev-parse', 'HEAD'), diff: '',
    refs: { head: { available: true } },
    files: [{ path: controlPath, status: 'deleted', class: 'source', language: 'typescript', additions: 0, deletions: 4, reviewed: false }],
  };
  // The head still contains the control, so falling back to it would invent evidence.
  assert.deepEqual(collectStructure(scratch.repo, change, [], undefined, [controlPath]).removedControls, []);
  assert.deepEqual(collectStructure(scratch.repo, { ...change, base: 'f'.repeat(40) }, [], undefined, [controlPath]).removedControls, []);
});

for (const [name, extraFiles] of [
  ['configured test_paths', { '.review-voice/config.yaml': 'review:\n  human_review:\n    test_paths: ["src/control.*"]\n' }],
  ['a generated attribute at the base', { '.gitattributes': 'src/control.ts linguist-generated\n' }],
]) {
  test(`diff --out excludes a deleted control matching ${name}`, (t) => {
    const scratch = scratchRepo(t, extraFiles);
    rmSync(join(scratch.repo, controlPath));
    assert.deepEqual(diffOut(scratch).structure.removedControls, []);
  });
}

// A working-tree diff is taken against the index, so a file deleted in the
// working tree held what the index holds, not what the head commit holds.
test('a worktree deletion is read from the index, where a staged guard lives', (t) => {
  const scratch = scratchRepo(t, { [controlPath]: 'export function run() {\n  work();\n}\n' });
  // The committed file has no guard; a version with one is staged, then the file is deleted unstaged.
  writeFileSync(join(scratch.repo, controlPath), `export function run(permission) {\n${guard}\n  work();\n}\n`);
  scratch.git('add', controlPath);
  rmSync(join(scratch.repo, controlPath));
  const summary = diffOut(scratch);
  assert.deepEqual(summary.structure.removedControls.map((entry) => [entry.path, entry.kind, entry.deletedFile]), [[controlPath, 'guard', true]]);
});
