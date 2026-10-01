import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acquireDiff } from '../plugins/review-voice/src/diff/acquire.ts';
import { acquirePullRequestDiff } from '../plugins/review-voice/src/diff/pull-request.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const HEADER = '// This file is generated. Do not edit manually.\n';

/** A repository whose first commit holds generated files under sdk/generated. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hand-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'sdk/generated'), { recursive: true });
  for (const name of files) writeFileSync(join(dir, 'sdk/generated', name), `${HEADER}export const v = 1;\n`);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { dir, git };
}

const edit = (dir, name) => writeFileSync(join(dir, 'sdk/generated', name), `${HEADER}export const v = 2;\n`);

test('a lone hand edit to a generated file stays in the review', () => {
  const { dir } = repo(['a.ts', 'b.ts']);
  edit(dir, 'a.ts');
  const result = acquireDiff({ cwd: dir, staged: false, base: null, includeGenerated: false });
  const file = result.files.find((f) => f.path === 'sdk/generated/a.ts');
  assert.equal(file.reviewed, true);
  assert.equal(file.handEditSuspected, true);
  assert.match(result.diff, /sdk\/generated\/a\.ts/);
});

test('a regeneration touching several files stays excluded', () => {
  const { dir } = repo(['a.ts', 'b.ts']);
  edit(dir, 'a.ts');
  edit(dir, 'b.ts');
  // A lone edit in a different generated directory is still a hand edit.
  mkdirSync(join(dir, 'other/generated'), { recursive: true });
  writeFileSync(join(dir, 'other/generated/z.ts'), `${HEADER}export const z = 1;\n`);
  const result = acquireDiff({ cwd: dir, staged: false, base: null, includeGenerated: false });
  const suspected = result.files.filter((f) => f.handEditSuspected).map((f) => f.path);
  assert.deepEqual(suspected, ['other/generated/z.ts']);
  assert.equal(result.reviewedFileCount, 1);
});

test('a generated file without a do-not-edit header stays excluded', () => {
  const { dir } = repo([]);
  writeFileSync(join(dir, 'sdk/generated/plain.ts'), 'export const v = 1;\n');
  const result = acquireDiff({ cwd: dir, staged: false, base: null, includeGenerated: false });
  assert.equal(result.reviewedFileCount, 0);
});

test('diff --out summary lists the suspected hand edits', () => {
  const { dir } = repo(['a.ts']);
  edit(dir, 'a.ts');
  const out = join(dir, '.out');
  const stdout = execFileSync(process.execPath, [bundle, 'diff', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout).summary.handEditSuspected, ['sdk/generated/a.ts']);
});

async function pullRequest(files, headSha, cwd) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const json = /\/pulls\/\d+$/.test(String(url))
      ? { number: 1, title: 't', base: { sha: 'b', ref: 'main' }, head: { sha: headSha, ref: 'topic' },
          changed_files: files.length, additions: 1, deletions: 1 }
      : files;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    return await acquirePullRequestDiff({ repository: 'org/a', pullNumber: 1, includeGenerated: false, cwd });
  } finally {
    globalThis.fetch = original;
    delete process.env.GITHUB_TOKEN;
  }
}

test('a pull request hand edit is found from the local head commit', async () => {
  const { dir, git } = repo(['a.ts']);
  edit(dir, 'a.ts');
  git('commit', '-qam', 'edit');
  const head = git('rev-parse', 'HEAD').trim();
  // The patch holds only the changed line, so the header can come from the commit alone.
  const patch = '@@ -5 +5 @@\n-export const v = 1;\n+export const v = 2;';
  const result = await pullRequest([{ filename: 'sdk/generated/a.ts', status: 'modified', patch }], head, dir);
  assert.equal(result.files[0].handEditSuspected, true);
  assert.equal(result.files[0].reviewed, true);
});

test('without the head commit a pull request uses the patch header, else stays excluded', async () => {
  const { dir } = repo([]);
  const missing = 'f'.repeat(40);
  const withHeader = { filename: 'sdk/generated/a.ts', status: 'added', patch: `@@ -0,0 +1,2 @@\n+${HEADER}+x` };
  const without = { filename: 'sdk/generated/b.ts', status: 'modified', patch: '@@ -9 +9 @@\n-a\n+b' };
  const found = await pullRequest([withHeader], missing, dir);
  assert.equal(found.files[0].handEditSuspected, true);
  const left = await pullRequest([without], missing, dir);
  assert.equal(left.files[0].reviewed, false);
});
