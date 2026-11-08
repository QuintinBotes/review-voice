/**
 * Issue 275: conventions are read from a trusted commit (`conventions --ref`),
 * and the second-pass command runs where it is told (`verify --cwd`), while
 * the configuration that names it still comes from the checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverConventions } from '../plugins/review-voice/src/conventions/discover.ts';
import { filesystemReader, gitTreeReader } from '../plugins/review-voice/src/conventions/tree.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-275-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** Writes each file (null removes it), commits, and returns the commit. */
function commit(dir, files) {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) {
      rmSync(join(dir, path));
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

const cli = (dir, args, input = '') => spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input });

test('conventions --ref reads the base commit with the head checked out, and without it the checkout as before', (t) => {
  const dir = scratch(t);
  const base = commit(dir, {
    'CLAUDE.md': 'Base rule: handlers validate before they persist.\n',
    'AGENTS.md': 'Base agents keep the audit log.\n',
    'CONTRIBUTING.md': 'Squash merges only.\n',
  });
  commit(dir, {
    'CLAUDE.md': 'Head rule: validation is optional.\n',
    'AGENTS.md': 'Head agents may skip the audit log.\n',
    'CONTRIBUTING.md': null,
    '.agents/rules/added.md': 'A rule only the head has.\n',
  });

  const atBase = cli(dir, ['conventions', '--path', 'src/app.ts', '--ref', base]);
  assert.equal(atBase.status, 0, atBase.stderr);
  const report = JSON.parse(atBase.stdout);
  const content = Object.fromEntries(report.documents.map((document) => [document.path, document.content]));
  assert.deepEqual(Object.keys(content).sort(), ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'], 'the base set, with the head deletion present and the head addition absent');
  assert.equal(content['CLAUDE.md'], 'Base rule: handlers validate before they persist.\n');
  assert.equal(content['AGENTS.md'], 'Base agents keep the audit log.\n');

  const checkout = cli(dir, ['conventions', '--path', 'src/app.ts']);
  assert.equal(checkout.status, 0, checkout.stderr);
  const { trust: _trust, note: _note, ...withoutRef } = JSON.parse(checkout.stdout);
  assert.deepEqual(withoutRef, discoverConventions(dir, ['src/app.ts'], filesystemReader(dir)));
  assert.match(withoutRef.documents.find((document) => document.path === 'CLAUDE.md').content, /optional/);
});

test('the git reader ranks, budgets, truncates and skips exactly as the filesystem reader does on the same tree', (t) => {
  const dir = scratch(t);
  const huge = (name) => `# ${name}\n${`${name} guidance line.\n`.repeat(900)}`;
  const sectioned = ['# House rules', 'Applies to the whole repository.', '## Controller conventions', 'Controllers must return ActionResult.', '## Filler', 'Unrelated guidance.\n'.repeat(1200)].join('\n');
  commit(dir, {
    'CLAUDE.md': huge('root'),
    'AGENTS.md': '規則の行\n'.repeat(4000),
    'src/CLAUDE.md': 'Source rules.\n',
    'src/Controllers/AGENTS.md': sectioned,
    '.agents/rules/a-large.md': huge('alpha'),
    '.agents/rules/b-large.md': huge('beta'),
    '.agents/rules/c-large.md': huge('gamma'),
    '.agents/rules/z-unit-test.md': '---\npaths: ["**/*.test.ts"]\n---\nEvery test names its subject.\n',
    '.claude/rules/stub.md': '---\npaths: ["**/Controllers/**/*.cs"]\n---\n@.agents/rules/controllers.md\n@.agents/rules/gone.md\n',
    '.agents/rules/controllers.md': 'Controllers never touch the database.\n',
    '.claude/skills/deploy/SKILL.md': huge('deploy'),
    '.claude/skills/not-a-skill.txt': 'ignored\n',
  });
  const changed = ['src/thing.test.ts', 'src/Controllers/UserController.cs'];

  const fromDisk = discoverConventions(dir, changed);
  const fromGit = discoverConventions(dir, changed, gitTreeReader(dir, 'HEAD'));
  assert.deepEqual(fromGit, fromDisk);
  // The fixture reaches every path that matters, so the equality says something.
  assert.ok(fromDisk.skipped.some((entry) => /budget/.test(entry.reason)), JSON.stringify(fromDisk.skipped));
  assert.ok(fromDisk.skipped.some((entry) => entry.path === '.agents/rules/gone.md'));
  assert.ok(fromDisk.documents.some((document) => document.scoped));
  assert.ok(fromDisk.documents.some((document) => document.truncated && !document.scoped));
  assert.ok(fromDisk.documents.some((document) => document.path === '.agents/rules/controllers.md'));
});

test('a symbolic link in the trusted tree is not followed, wherever it points', (t) => {
  const dir = scratch(t);
  const outside = mkdtempSync(join(tmpdir(), 'rv-275-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'rules.md'), 'Rules from outside the repository.\n');
  writeFileSync(join(dir, 'inside.md'), 'Rules the link points at.\n');
  symlinkSync(join(outside, 'rules.md'), join(dir, 'CLAUDE.md'));
  symlinkSync('inside.md', join(dir, 'AGENTS.md'));
  const base = commit(dir, {});

  const onDisk = discoverConventions(dir, []).documents.map((document) => document.path);
  assert.deepEqual(onDisk.sort(), ['AGENTS.md', 'CLAUDE.md'], 'the checkout follows both links, so the next check is not vacuous');
  assert.deepEqual(discoverConventions(dir, [], gitTreeReader(dir, base)), { documents: [], totalBytes: 0, skipped: [], warnings: [] });
});

test('conventions --ref with a ref that does not resolve, or no ref at all, exits 2, and the help names the flag', (t) => {
  const dir = scratch(t);
  commit(dir, { 'CLAUDE.md': 'Rules.\n' });
  for (const args of [['--ref', 'no-such-ref'], ['--ref']]) {
    const run = cli(dir, ['conventions', ...args]);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /--ref/);
    assert.equal(run.stdout, '');
  }
  assert.match(cli(dir, ['conventions', '--help']).stdout, /--ref <ref>/);
});

/** A checkout whose configuration names a verification command, written as JSON, which is valid YAML. */
function verifierRepo(t, name, command) {
  const dir = scratch(t);
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify({ verification: { enabled: true, name, command } }));
  return dir;
}

const VERDICT = `echo '{"verdict":"confirmed","confidence":0.9,"reason":"holds"}'`;
const CANDIDATES = JSON.stringify({
  candidates: [{ candidate_id: 'cand_001', path: 'src/app.ts', line: 3, severity: 'minor', claim: 'qty may be undefined.', failure_mode: 'NaN totals.', evidence: ['src/app.ts:3'] }],
});

test('verify --cwd runs this checkout\'s command in another directory, never that directory\'s configuration', (t) => {
  const here = verifierRepo(t, 'trusted', `touch verify-ran; ${VERDICT}`);
  const there = verifierRepo(t, 'planted', `touch should-not-run; ${VERDICT}`);

  const alone = cli(here, ['verify'], CANDIDATES);
  assert.equal(alone.status, 0, alone.stderr);
  assert.ok(existsSync(join(here, 'verify-ran')), 'without --cwd it runs in the checkout, as before');
  rmSync(join(here, 'verify-ran'));

  const moved = cli(here, ['verify', '--cwd', there], CANDIDATES);
  assert.equal(moved.status, 0, moved.stderr);
  const report = JSON.parse(moved.stdout);
  assert.equal(report.verifier, 'trusted', 'the command is this checkout\'s');
  assert.deepEqual(report.didNotRun, []);
  assert.ok(existsSync(join(there, 'verify-ran')), 'and it ran where --cwd said');
  assert.equal(existsSync(join(here, 'verify-ran')), false);
  assert.equal(existsSync(join(here, 'should-not-run')), false);
  assert.equal(existsSync(join(there, 'should-not-run')), false);
});

test('verify --cwd needs an existing directory, and the help names the flag', (t) => {
  const dir = verifierRepo(t, 'trusted', `touch verify-ran; ${VERDICT}`);
  for (const args of [['--cwd'], ['--cwd', join(dir, 'missing')]]) {
    const run = cli(dir, ['verify', ...args], CANDIDATES);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /--cwd/);
  }
  assert.equal(existsSync(join(dir, 'verify-ran')), false, 'nothing ran');
  assert.match(cli(dir, ['verify', '--help']).stdout, /--cwd <dir>/);
});

test('verify --cwd hands the command an absolute diff path, so a relative --diff-file still names the file', (t) => {
  const here = verifierRepo(t, 'trusted', `cat > context.json; ${VERDICT}`);
  const there = verifierRepo(t, 'planted', 'true');
  writeFileSync(join(here, 'change.patch'), '');
  const run = cli(here, ['verify', '--cwd', there, '--diff-file', 'change.patch'], CANDIDATES);
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(readFileSync(join(there, 'context.json'), 'utf8')).context.diffPath;
  assert.equal(realpathSync(seen), realpathSync(join(here, 'change.patch')));
});

test('verify resolves its refs where it was invoked, so HEAD names the commit of this checkout, not of the --cwd worktree', (t) => {
  const here = verifierRepo(t, 'trusted', `cat > context.json; ${VERDICT}`);
  const first = commit(here, { 'src/app.ts': 'export const a = 1;\n' });
  const second = commit(here, { 'src/app.ts': 'export const a = 2;\n' });
  const there = verifierRepo(t, 'planted', 'true');
  const elsewhere = commit(there, { 'src/other.ts': 'export const b = 1;\n' });
  const run = cli(here, ['verify', '--cwd', there, '--base', 'HEAD~1', '--head', 'HEAD'], CANDIDATES);
  assert.equal(run.status, 0, run.stderr);
  const { context } = JSON.parse(readFileSync(join(there, 'context.json'), 'utf8'));
  assert.deepEqual([context.base, context.head], [first, second]);
  assert.notEqual(context.head, elsewhere);
  const unknown = cli(here, ['verify', '--cwd', there, '--base', 'no-such-ref'], CANDIDATES);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(JSON.parse(readFileSync(join(there, 'context.json'), 'utf8')).context.base, null, 'an unresolvable ref is not passed on');
  assert.match(unknown.stderr, /no-such-ref does not resolve to a commit here/);
});

test('step 1d skips conventions on a pull-request review whose base is not readable', () => {
  const text = readFileSync(join(root, 'plugins/review-voice/commands/review.md'), 'utf8');
  assert.match(text, /On a pull-request review whose base is not readable \(`refs\.base\.available` is\nfalse in step 1\), do not run this step\./);
});

test('step 3b tells the second pass which change it is judging', () => {
  const text = readFileSync(join(root, 'plugins/review-voice/commands/review.md'), 'utf8');
  assert.match(text, /Run `RV verify --repository <owner\/repo> --diff-file <tmpdir>\/diff\.patch` with the/);
  assert.match(text, /adding `--base <ref>`\nand `--head <head sha>` on a pull-request or `--base` review/);
});
