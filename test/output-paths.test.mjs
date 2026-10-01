import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const source = new URL('../plugins/review-voice/src/cli.ts', import.meta.url).href;

function gitRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-output-paths-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/example.ts'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  writeFileSync(join(dir, 'src/example.ts'), 'export const value = 2;\n');
  return { dir, git };
}

function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('diff output includes a local summary and symbols accepts a directory output', () => {
  const { dir } = gitRepository();
  try {
    const diffOut = join(dir, 'diff-output');
    const diff = run(['diff', '--out', diffOut], dir);
    assert.equal(diff.code, 0, diff.stderr);
    const report = JSON.parse(diff.stdout);
    assert.equal(report.summary.mode, 'worktree');
    assert.equal(report.summary.base, null);
    assert.equal(typeof report.summary.head, 'string');
    assert.equal(report.summary.pullNumber, null);
    assert.equal(report.summary.scope, null);
    assert.equal(report.summary.scopeNote, null);
    assert.equal(report.summary.truncated, false);
    assert.equal(report.summary.truncationNote, null);
    assert.equal(report.summary.reviewedFileCount, 1);
    assert.equal(report.summary.hunkFileCount, 1);
    assert.equal(report.summary.excludedFileCount, 0);
    assert.equal(report.summary.refs, null);

    const symbolsOut = join(dir, 'symbols-output');
    mkdirSync(symbolsOut);
    const symbols = run(['symbols', '--diff-file', join(diffOut, 'diff.patch'), '--out', symbolsOut], dir);
    assert.equal(symbols.code, 0, symbols.stderr);
    assert.equal(JSON.parse(symbols.stdout).path, join(symbolsOut, 'symbols.json'));
    assert.ok(existsSync(join(symbolsOut, 'symbols.json')));

    const explicit = join(dir, 'explicit-symbols.json');
    assert.equal(run(['symbols', '--diff-file', join(diffOut, 'diff.patch'), '--out', explicit], dir).code, 0);
    assert.ok(existsSync(explicit));

    const blocker = join(dir, 'regular-file');
    writeFileSync(blocker, 'not a directory\n');
    const invalid = run(['symbols', '--diff-file', join(diffOut, 'diff.patch'), '--out', join(blocker, 'symbols.json')], dir);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /expected a file path or a directory/);
    assert.match(invalid.stderr, /regular-file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diff patch headers stay parseable when local git preferences change', () => {
  const { dir, git } = gitRepository();
  try {
    git('config', 'diff.noprefix', 'true');
    git('config', 'diff.mnemonicPrefix', 'true');
    git('config', 'color.diff', 'always');

    const result = run(['diff'], dir);
    assert.equal(result.code, 0, result.stderr);
    const diff = JSON.parse(result.stdout).diff;
    assert.match(diff, /^--- a\/src\/example\.ts$/m);
    assert.match(diff, /^\+\+\+ b\/src\/example\.ts$/m);
    assert.doesNotMatch(diff, /\u001b\[/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shared output resolver gives thread and symbols the same directory rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-resolve-out-'));
  try {
    const script = [
      "process.argv = [process.execPath, 'test'];",
      `const { resolveOutPath } = await import(${JSON.stringify(source)});`,
      `console.log(JSON.stringify([resolveOutPath(${JSON.stringify(dir)}, 'thread.json'), resolveOutPath(${JSON.stringify(`${dir}/`)}, 'symbols.json')]));`,
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.trim().split('\n').at(-1);
    assert.deepEqual(JSON.parse(line), [join(dir, 'thread.json'), join(dir, 'symbols.json')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
