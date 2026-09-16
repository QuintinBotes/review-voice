import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/** A throwaway repository with one commit, so diffs have a base. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { dir, git };
}

function runDiff(cwd, args = []) {
  const stdout = execFileSync(process.execPath, [bundle, 'diff', ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(stdout);
}

const pathsReviewed = (r) => r.files.filter((f) => f.reviewed).map((f) => f.path).sort();

test('an untracked file is reviewed — a new file is where defects hide', () => {
  const { dir } = scratchRepo();
  try {
    writeFileSync(join(dir, 'brand-new.ts'), 'export const x = 1;\n');
    const result = runDiff(dir);
    assert.deepEqual(pathsReviewed(result), ['brand-new.ts']);
    assert.match(result.diff, /brand-new\.ts/);
    assert.match(result.diff, /export const x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquiring a diff never mutates the index', () => {
  const { dir, git } = scratchRepo();
  try {
    writeFileSync(join(dir, 'untracked.ts'), 'export const y = 2;\n');
    const before = git('status', '--porcelain');
    runDiff(dir);
    assert.equal(git('status', '--porcelain'), before, 'git status must be unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock files, generated output, vendored code and binaries are excluded', () => {
  const { dir } = scratchRepo();
  try {
    mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package-lock.json'), '{}\n');
    writeFileSync(join(dir, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'dist/app.js'), 'var a=1;\n');
    writeFileSync(join(dir, 'app.min.js'), 'var b=1;\n');
    writeFileSync(join(dir, 'logo.png'), 'not really a png');
    writeFileSync(join(dir, 'real.ts'), 'export const z = 3;\n');

    const result = runDiff(dir);
    assert.deepEqual(pathsReviewed(result), ['real.ts']);

    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    assert.equal(byPath['package-lock.json'].class, 'lockfile');
    assert.equal(byPath['dist/app.js'].class, 'generated');
    assert.equal(byPath['app.min.js'].class, 'generated');
    assert.equal(byPath['logo.png'].class, 'binary');
    // Every exclusion is explained, so an omission is visible rather than silent.
    for (const file of result.files.filter((f) => !f.reviewed)) {
      assert.ok(file.excludedBecause, `${file.path} excluded without a reason`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--include-generated brings the excluded files back', () => {
  const { dir } = scratchRepo();
  try {
    writeFileSync(join(dir, 'package-lock.json'), '{"a":1}\n');
    assert.equal(runDiff(dir).reviewedFileCount, 0);
    assert.equal(runDiff(dir, ['--include-generated']).reviewedFileCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file named vendor.ts is source; a vendor/ directory is not', () => {
  const { dir } = scratchRepo();
  try {
    mkdirSync(join(dir, 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'vendor.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'vendor/lib.ts'), 'export const b = 2;\n');
    assert.deepEqual(pathsReviewed(runDiff(dir)), ['vendor.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--staged sees only the index', () => {
  const { dir, git } = scratchRepo();
  try {
    writeFileSync(join(dir, 'staged.ts'), 'export const s = 1;\n');
    writeFileSync(join(dir, 'unstaged.ts'), 'export const u = 1;\n');
    git('add', 'staged.ts');
    assert.deepEqual(pathsReviewed(runDiff(dir, ['--staged'])), ['staged.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted file is not reviewed but is still reported', () => {
  const { dir, git } = scratchRepo();
  try {
    writeFileSync(join(dir, 'doomed.ts'), 'export const d = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add');
    rmSync(join(dir, 'doomed.ts'));
    const result = runDiff(dir);
    const file = result.files.find((f) => f.path === 'doomed.ts');
    assert.equal(file.status, 'deleted');
    assert.equal(file.reviewed, false);
    assert.equal(file.excludedBecause, 'file deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty diff is reported honestly, not as an error', () => {
  const { dir } = scratchRepo();
  try {
    const result = runDiff(dir);
    assert.equal(result.reviewedFileCount, 0);
    assert.equal(result.diff, '');
    assert.deepEqual(result.files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('language is detected for classification', () => {
  const { dir } = scratchRepo();
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'b.py'), 'x = 1\n');
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    const byPath = Object.fromEntries(runDiff(dir).files.map((f) => [f.path, f.language]));
    assert.equal(byPath['a.ts'], 'typescript');
    assert.equal(byPath['b.py'], 'python');
    assert.equal(byPath['Dockerfile'], 'dockerfile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a repository it fails clearly rather than inventing a diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-norepo-'));
  try {
    execFileSync(process.execPath, [bundle, 'diff'], { cwd: dir, encoding: 'utf8' });
    assert.fail('should have exited non-zero');
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(error.stderr, /git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--base without a ref is an invocation error', () => {
  const { dir } = scratchRepo();
  try {
    execFileSync(process.execPath, [bundle, 'diff', '--base'], { cwd: dir, encoding: 'utf8' });
    assert.fail('should have exited non-zero');
  } catch (error) {
    assert.equal(error.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
