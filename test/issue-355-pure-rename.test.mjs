/**
 * Issue 355. A patch that renames or copies a file without changing it has no
 * hunk for that file, so the base rebuilt from the patch's lines never held the
 * old path and `git apply` refused the whole patch. The builder now gives that
 * old path filler, and `import-benchmark` no longer refuses such an item.
 *
 * A rename that differs only by case failed for a second reason on a file
 * system that folds case, where the working directory already answers to the
 * new name. The head is now built in the index and then written out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import { materializeFixture } from '../plugins/review-voice/src/evaluate/fixtures.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const scratch = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rv-issue-355-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Builds `patch` as the only file of a throwaway fixture and returns the repository with its commits. */
function build(t, patch) {
  const dir = scratch(t);
  const fixture = join(dir, 'positive', 'demo');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'diff.patch'), patch);
  const repo = join(dir, 'repo');
  const built = materializeFixture(fixture, repo);
  assert.equal(readFileSync(join(fixture, 'diff.patch'), 'utf8'), patch, 'the fixture is not written to');
  return { repo, ...built };
}

/** Every path a commit holds, outside the configuration the builder adds. */
const pathsAt = (repo, commit) =>
  git(repo, 'ls-tree', '-r', '-z', '--name-only', commit)
    .split('\0')
    .filter((path) => path !== '' && !path.startsWith('.review-voice/'));

const ORDINARY = ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' const a = 1;', '+const b = 2;', ' const c = 3;'];
const pureRename = (from, to, verb = 'rename') => [`diff --git a/${from} b/${to}`, 'similarity index 100%', `${verb} from ${from}`, `${verb} to ${to}`];

test('a pure rename beside an ordinary hunk builds, and the head holds the new path and not the old one', (t) => {
  const patch = [...pureRename('src/old-name.ts', 'src/new-name.ts'), ...ORDINARY, ''].join('\n');
  const { repo, base, head, files } = build(t, patch);

  assert.deepEqual(pathsAt(repo, base), ['src/app.ts', 'src/old-name.ts']);
  assert.deepEqual(pathsAt(repo, head), ['src/app.ts', 'src/new-name.ts']);
  assert.equal(git(repo, 'show', `${base}:src/old-name.ts`), '// filler\n', 'the old path holds filler, as any line the patch does not show');
  assert.equal(git(repo, 'show', `${head}:src/new-name.ts`), '// filler\n', 'the rename carries the content over unchanged');

  const hunks = parseHunks(git(repo, 'diff', '--no-color', '--no-ext-diff', '--no-renames', base, head, '--', 'src/app.ts'));
  assert.deepEqual([...hunks.get('src/app.ts').added], [2], 'the ordinary hunk still adds its line');
  assert.equal(git(repo, 'show', `${head}:src/app.ts`), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  // Its content is filler, so the renamed file is not one the review is served and no finding can anchor in it.
  assert.deepEqual(files, ['src/app.ts']);
});

test('a pure rename of a path with a space or a quoted character builds', (t) => {
  const patch = [
    ...pureRename('docs/old name.md', 'docs/new name.md'),
    'diff --git "a/src/say \\"hi\\".ts" "b/src/tab\\there.ts"',
    'similarity index 100%',
    'rename from "src/say \\"hi\\".ts"',
    'rename to "src/tab\\there.ts"',
    '',
  ].join('\n');
  const { repo, base, head } = build(t, patch);

  assert.deepEqual(pathsAt(repo, base), ['docs/old name.md', 'src/say "hi".ts']);
  assert.deepEqual(pathsAt(repo, head), ['docs/new name.md', 'src/tab\there.ts']);
  assert.equal(git(repo, 'show', `${head}:docs/new name.md`), '# filler\n');
});

test('a rename that carries a hunk builds as before, from the lines its hunk shows', (t) => {
  const patch = [
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 66%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    ...ORDINARY.slice(3),
    '',
  ].join('\n');
  const { repo, base, head, files } = build(t, patch);

  assert.deepEqual(pathsAt(repo, base), ['src/old.ts']);
  assert.deepEqual(pathsAt(repo, head), ['src/new.ts']);
  assert.equal(git(repo, 'show', `${base}:src/old.ts`), 'const a = 1;\nconst c = 3;\n', 'the base is the reconstruction, not filler');
  assert.equal(git(repo, 'show', `${head}:src/new.ts`), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  assert.deepEqual(files, ['src/new.ts']);
});

/** The working directory as a caller finds it: the files on disk under `dir`, and whether git sees any difference from the head. */
const onDisk = (repo, dir) => ({ names: readdirSync(join(repo, dir)).sort(), status: git(repo, 'status', '--porcelain') });

test('a rename that differs only by case builds with its hunk, on a file system that folds case as on one that does not', (t) => {
  const patch = [
    'diff --git a/src/App.tsx b/src/app.tsx',
    'similarity index 66%',
    'rename from src/App.tsx',
    'rename to src/app.tsx',
    '--- a/src/App.tsx',
    '+++ b/src/app.tsx',
    ...ORDINARY.slice(3),
    '',
  ].join('\n');
  const { repo, base, head, files } = build(t, patch);
  const after = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
  assert.deepEqual(pathsAt(repo, 'HEAD'), ['src/app.tsx'], 'the head commit lists the new name and not the old one');
  assert.deepEqual(pathsAt(repo, base), ['src/App.tsx']);
  assert.equal(git(repo, 'show', 'HEAD:src/app.tsx'), after);
  assert.equal(readFileSync(join(repo, 'src/app.tsx'), 'utf8'), after, 'the file a caller reads from disk has the content of the head');
  assert.deepEqual(onDisk(repo, 'src'), { names: ['app.tsx'], status: '' }, 'the working directory holds the name as the head spells it, and nothing else');
  assert.deepEqual(files, ['src/app.tsx']);

  // The recall harness moves to the base branch once the fixture is built.
  git(repo, 'checkout', '-q', 'main');
  assert.equal(readFileSync(join(repo, 'src/App.tsx'), 'utf8'), 'const a = 1;\nconst c = 3;\n');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('a pure rename that differs only by case builds', (t) => {
  const { repo, base } = build(t, [...pureRename('lib/Feedback.js', 'lib/feedback.js'), ...ORDINARY, ''].join('\n'));

  assert.deepEqual(pathsAt(repo, 'HEAD'), ['lib/feedback.js', 'src/app.ts'], 'the head commit lists the new name and not the old one');
  assert.deepEqual(pathsAt(repo, base), ['lib/Feedback.js', 'src/app.ts']);
  assert.equal(git(repo, 'show', 'HEAD:lib/feedback.js'), '// filler\n');
  assert.equal(readFileSync(join(repo, 'lib/feedback.js'), 'utf8'), '// filler\n');
  assert.equal(readFileSync(join(repo, 'src/app.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'the ordinary hunk reaches the working directory');
  assert.deepEqual(onDisk(repo, 'lib'), { names: ['feedback.js'], status: '' });
});

test('the working directory is the head after a rename: the old path is gone from disk and git sees no difference', (t) => {
  const { repo } = build(t, [...pureRename('src/old-name.ts', 'src/new-name.ts'), ...ORDINARY, ''].join('\n'));

  assert.deepEqual(onDisk(repo, 'src'), { names: ['app.ts', 'new-name.ts'], status: '' });
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
});

test('a pure copy builds: the source stays and the copy appears beside it', (t) => {
  const patch = [...pureRename('src/source.ts', 'src/duplicate.ts', 'copy'), ...ORDINARY, ''].join('\n');
  const { repo, base, head } = build(t, patch);

  assert.deepEqual(pathsAt(repo, base), ['src/app.ts', 'src/source.ts']);
  assert.deepEqual(pathsAt(repo, head), ['src/app.ts', 'src/duplicate.ts', 'src/source.ts']);
  assert.equal(git(repo, 'show', `${head}:src/duplicate.ts`), '// filler\n');
});

test('a pure copy of a file the patch also changes copies the reconstruction, not filler', (t) => {
  const patch = [...ORDINARY, ...pureRename('src/app.ts', 'src/app-copy.ts', 'copy'), ''].join('\n');
  const { repo, base, head } = build(t, patch);

  assert.deepEqual(pathsAt(repo, base), ['src/app.ts']);
  assert.deepEqual(pathsAt(repo, head), ['src/app-copy.ts', 'src/app.ts']);
  assert.equal(git(repo, 'show', `${base}:src/app.ts`), 'const a = 1;\nconst c = 3;\n');
  assert.equal(git(repo, 'show', `${head}:src/app-copy.ts`), 'const a = 1;\nconst c = 3;\n', 'git copies the file as it was before the patch');
});

test('a context file under the old path of a pure rename is used as given', (t) => {
  const dir = scratch(t);
  const fixture = join(dir, 'positive', 'demo');
  mkdirSync(join(fixture, 'context/src'), { recursive: true });
  writeFileSync(join(fixture, 'diff.patch'), [...pureRename('src/old-name.ts', 'src/new-name.ts'), ''].join('\n'));
  writeFileSync(join(fixture, 'context/src/old-name.ts'), 'export const given = true;\n');
  const repo = join(dir, 'repo');
  const { head } = materializeFixture(fixture, repo);

  assert.deepEqual(pathsAt(repo, head), ['src/new-name.ts']);
  assert.equal(git(repo, 'show', `${head}:src/new-name.ts`), 'export const given = true;\n');
});

test('a pure rename to a path outside the repository is refused before anything is built', (t) => {
  assert.throws(() => build(t, [...pureRename('src/old-name.ts', '../outside.ts'), ''].join('\n')), /is not a repository-relative path/);
  assert.throws(() => build(t, [...pureRename('.git/config', 'src/config.ts'), ''].join('\n')), /is not a repository-relative path/);
});

test('through the bundle, import-benchmark accepts an item whose patch holds a pure rename', (t) => {
  const dir = scratch(t);
  const diffs = join(dir, 'diffs');
  mkdirSync(diffs);
  const patch = [...pureRename('src/old-name.ts', 'src/new-name.ts'), ...ORDINARY, ''].join('\n');
  writeFileSync(join(diffs, 'widget-pull-11.patch'), patch);
  const set = join(dir, 'set.jsonl');
  writeFileSync(set, `${JSON.stringify({ repo: 'Widget', pr_url_to_review: 'https://example.com/example-benchmarks/Widget/pull/11', issues: [{ file_path: 'src/app.ts', start_line: 2 }] })}\n`);
  const licences = join(dir, 'licences.json');
  writeFileSync(licences, JSON.stringify({ Widget: 'MIT' }));
  const out = join(dir, 'out');

  // A failed import exits non-zero, which execFileSync throws with the refusal on stderr.
  execFileSync(process.execPath, [bundle, 'import-benchmark', '--from', set, '--set-version', 'v1.0', '--set-licence', 'MIT', '--licences', licences, '--diffs', diffs, '--out', out], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const manifest = JSON.parse(readFileSync(join(out, 'import.json'), 'utf8'));
  assert.deepEqual(manifest.refused, []);
  assert.deepEqual(
    manifest.items.map((entry) => [entry.fixture, entry.path, entry.line]),
    [['positive/widget-pull-11-1', 'src/app.ts', 2]],
  );
  assert.equal(readFileSync(join(out, 'positive/widget-pull-11-1/diff.patch'), 'utf8'), patch, 'the diff is copied as given');
});
