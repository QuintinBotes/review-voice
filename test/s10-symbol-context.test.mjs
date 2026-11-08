/**
 * S10 part B: symbol references split into production and test hits, and
 * callers of new declarations searched at the head. Searchers are injected, so
 * no test here needs a repository except the two that prove the CLI and the
 * driver pass the right arguments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSymbolContext } from '../plugins/review-voice/src/diff/symbols.ts';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runReview } from '../plugins/review-voice/src/review/driver.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

function addedDiff(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

const SYMBOL_DIFF = addedDiff('src/widget.ts', ['export const widgetLimit = 3;']);
const DECLARATION_DIFF = addedDiff('src/new.ts', ['export function toSnakeCase(value) {']);

function referencesOf(hits, options = {}) {
  const report = collectSymbolContext({
    diff: SYMBOL_DIFF,
    cwd: '/repo',
    ref: 'base',
    search: () => hits,
    lineSearch: () => [],
    ...options,
  });
  return { report, entry: report.files[0].symbols[0] };
}

function declaredOf(options = {}) {
  const report = collectSymbolContext({
    diff: DECLARATION_DIFF,
    cwd: '/repo',
    ref: 'base',
    search: () => [],
    lineSearch: () => [],
    ...options,
  });
  return report.files[0];
}

test('hits split into production references and test references with matching counts', () => {
  const { report, entry } = referencesOf([
    'src/widget.ts',
    'src/use-b.ts',
    'src/use-a.ts',
    'test/widget.test.ts',
    'src/__tests__/helper.ts',
  ]);
  assert.deepEqual(entry, {
    symbol: 'widgetLimit',
    references: ['src/use-a.ts', 'src/use-b.ts'],
    referenceCount: 2,
    testReferences: ['src/__tests__/helper.ts', 'test/widget.test.ts'],
    testReferenceCount: 2,
  });
  // The aggregate counts untouched production consumers only.
  assert.equal(report.downstreamFiles, 2);
});

test('an all-production hit set has no testReferences key at all', () => {
  const { entry } = referencesOf(['src/widget.ts', 'src/use.ts']);
  assert.deepEqual(entry, { symbol: 'widgetLimit', references: ['src/use.ts'], referenceCount: 1 });
  assert.equal('testReferences' in entry, false);
  assert.equal('testReferenceCount' in entry, false);
});

test('a symbol with only test hits has empty references and testReferences, and is not common', () => {
  const { report, entry } = referencesOf(['test/widget.test.ts']);
  assert.deepEqual(entry, {
    symbol: 'widgetLimit',
    references: [],
    referenceCount: 0,
    testReferences: ['test/widget.test.ts'],
    testReferenceCount: 1,
  });
  assert.equal(report.downstreamFiles, 0, 'a test consumer is not a downstream production file');
});

test('configured test_paths decide what a test is', () => {
  const hits = ['src/widget.ts', 'checks/widget.ts', 'test/widget.test.ts'];
  const custom = referencesOf(hits, { testPaths: ['checks/**'] }).entry;
  assert.deepEqual(custom.references, ['test/widget.test.ts']);
  assert.deepEqual(custom.testReferences, ['checks/widget.ts']);

  const defaults = referencesOf(hits).entry;
  assert.deepEqual(defaults.references, ['checks/widget.ts']);
  assert.deepEqual(defaults.testReferences, ['test/widget.test.ts']);
});

test('both lists keep the same display cap with the full count beside it', () => {
  const production = Array.from({ length: 10 }, (_, index) => `src/use-${String(index).padStart(2, '0')}.ts`);
  const tests = Array.from({ length: 9 }, (_, index) => `test/use-${String(index).padStart(2, '0')}.test.ts`);
  const { entry } = referencesOf([...production, ...tests]);
  assert.equal(entry.references.length, 8);
  assert.equal(entry.referenceCount, 10);
  assert.equal(entry.truncated, true);
  assert.equal(entry.testReferences.length, 8);
  assert.equal(entry.testReferenceCount, 9);
});

test('downstreamFiles counts untouched production files and ignores test files', () => {
  const diff = [
    addedDiff('src/widget.ts', ['export const widgetLimit = 3;']),
    addedDiff('src/other.ts', ['export const otherLimit = 4;']),
  ].join('\n');
  const report = collectSymbolContext({
    diff,
    cwd: '/repo',
    ref: 'base',
    lineSearch: () => [],
    search: (symbol) =>
      symbol === 'widgetLimit'
        ? ['src/other.ts', 'src/untouched.ts', 'test/a.test.ts', 'test/b.test.ts']
        : ['src/untouched.ts', 'test/c.test.ts'],
  });
  // src/other.ts is changed itself; the tests are never downstream.
  assert.equal(report.downstreamFiles, 1);
});

test('with a head, a declaration lists sorted callers and their full count', () => {
  const searched = [];
  const file = declaredOf({
    head: 'headsha',
    headSearch: (symbol, cwd, ref) => {
      searched.push([symbol, ref]);
      return ['src/z.ts', 'src/a.ts', 'src/a.ts'];
    },
  });
  assert.deepEqual(searched, [['toSnakeCase', 'headsha']]);
  assert.deepEqual(file.declared, [
    { name: 'toSnakeCase', line: 1, possibleExisting: [], callers: ['src/a.ts', 'src/z.ts'], callerCount: 2 },
  ]);
  assert.equal(file.declared[0].callersInconclusive, undefined);
});

test('callers exclude the declaring path, test paths and non-code', () => {
  const file = declaredOf({
    head: 'headsha',
    headSearch: () => ['src/new.ts', 'test/new.test.ts', 'src/new.spec.ts', 'docs/new.md', 'assets/new.png', 'src/use.ts'],
  });
  assert.deepEqual(file.declared[0].callers, ['src/use.ts']);
  assert.equal(file.declared[0].callerCount, 1);
});

test('callers are capped at 8 while callerCount stays complete', () => {
  const hits = Array.from({ length: 11 }, (_, index) => `src/c${String(index).padStart(2, '0')}.ts`);
  const entry = declaredOf({ head: 'headsha', headSearch: () => hits }).declared[0];
  assert.equal(entry.callers.length, 8);
  assert.deepEqual(entry.callers, hits.slice(0, 8));
  assert.equal(entry.callerCount, 11);
});

test('zero callers is a conclusion, distinct from an inconclusive search', () => {
  const entry = declaredOf({ head: 'headsha', headSearch: () => ['src/new.ts'] }).declared[0];
  assert.equal(entry.callerCount, 0);
  assert.deepEqual(entry.callers, []);
  assert.equal('callersInconclusive' in entry, false);
});

test('without a head the callers are unknown, and no head search is made', () => {
  let searches = 0;
  const entry = declaredOf({
    headSearch: () => {
      searches += 1;
      return [];
    },
  }).declared[0];
  assert.equal(searches, 0);
  assert.equal(entry.callersInconclusive, true);
  assert.equal('callers' in entry, false);
  assert.equal('callerCount' in entry, false);
});

test('a failed caller search is inconclusive, not zero, and marks the file partial', () => {
  const file = declaredOf({
    head: 'headsha',
    headSearch: () => {
      throw new Error('git grep failed');
    },
  });
  assert.equal(file.declared[0].callersInconclusive, true);
  assert.equal('callerCount' in file.declared[0], false);
  assert.equal(file.inconclusive, true);
});

test('an exhausted budget leaves callers inconclusive', () => {
  // The clock advances on every reading. The line search spends the last of
  // the budget, so the head search that follows must not run.
  let time = 0;
  let headSearches = 0;
  const report = collectSymbolContext({
    diff: DECLARATION_DIFF,
    cwd: '/repo',
    ref: 'base',
    head: 'headsha',
    maxMs: 100,
    now: () => time,
    search: () => [],
    lineSearch: () => {
      time = 200;
      return [];
    },
    headSearch: () => {
      headSearches += 1;
      return ['src/use.ts'];
    },
  });
  assert.equal(headSearches, 0);
  const file = report.files[0];
  assert.equal(file.declared[0].callersInconclusive, true);
  assert.equal(file.inconclusive, true);
  assert.equal(file.reason, 'time-budget');
  assert.equal(report.budget.exhausted, true);
});

test('a budget gone before any search marks every declaration callersInconclusive', () => {
  let time = 0;
  const report = collectSymbolContext({
    diff: DECLARATION_DIFF,
    cwd: '/repo',
    ref: 'base',
    head: 'headsha',
    maxMs: 100,
    now: () => {
      const reading = time;
      time += 500;
      return reading;
    },
    search: () => [],
    lineSearch: () => [],
    headSearch: () => [],
  });
  const declared = report.files[0].declared;
  assert.ok(declared.length > 0);
  assert.ok(declared.every((entry) => entry.callersInconclusive === true));
});

function gitRepository(files) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-s10-symbols-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const write = (changes) => {
    for (const [path, body] of Object.entries(changes)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), body);
    }
    git('add', '-A');
  };
  write(files);
  git('commit', '-q', '-m', 'base');
  return { directory, git, write };
}

test('the bundled symbols command searches the head for callers and rejects an unknown head', () => {
  const { directory, git, write } = gitRepository({ 'src/new.ts': '// module\n' });
  try {
    write({
      'src/new.ts': 'export function toSnakeCase(value: string) { return value; }\n',
      'src/use.ts': "import { toSnakeCase } from './new.ts';\nexport const key = toSnakeCase('a');\n",
      'test/use.test.ts': "import { toSnakeCase } from '../src/new.ts';\ntoSnakeCase('a');\n",
    });
    git('commit', '-q', '-m', 'head');
    const patch = join(directory, 'change.patch');
    writeFileSync(patch, git('diff', 'HEAD~1', 'HEAD', '--', 'src/new.ts'));

    const run = spawnSync(process.execPath, [bundle, 'symbols', '--diff-file', patch, '--base', 'HEAD~1', '--head', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const file = JSON.parse(run.stdout).files.find((entry) => entry.path === 'src/new.ts');
    assert.deepEqual(file.declared, [
      { name: 'toSnakeCase', line: 1, possibleExisting: [], callers: ['src/use.ts'], callerCount: 1 },
    ]);

    const unknown = spawnSync(process.execPath, [bundle, 'symbols', '--diff-file', patch, '--head', 'no-such-ref'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /--head no-such-ref does not resolve/);

    const missing = spawnSync(process.execPath, [bundle, 'symbols', '--diff-file', patch, '--head'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--head needs a git ref/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the bundled symbols command honours a configured test_paths glob', () => {
  const { directory } = gitRepository({
    'src/widget.ts': 'export const widgetLimit = 3;\n',
    'checks/widget.ts': 'import { widgetLimit } from "../src/widget.ts";\nexport const t = widgetLimit;\n',
    'src/use.ts': 'import { widgetLimit } from "./widget.ts";\nexport const u = widgetLimit;\n',
    '.review-voice/config.yaml': 'review:\n  human_review:\n    test_paths:\n      - "checks/**"\n',
  });
  try {
    const patch = join(directory, 'change.patch');
    writeFileSync(patch, addedDiff('src/widget.ts', ['export const widgetLimit = 3;']));
    const run = spawnSync(process.execPath, [bundle, 'symbols', '--diff-file', patch, '--base', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const entry = JSON.parse(run.stdout).files[0].symbols[0];
    assert.deepEqual(entry.testReferences, ['checks/widget.ts']);
    assert.deepEqual(entry.references, ['src/use.ts']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The driver: the symbols argv with the head available and without it.

const REPO = 'acme/api';
const PR = 12;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function driverRepository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s10-driver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/app.ts'), 'export function total(items) {\n  return items.length;\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'src/app.ts'), 'export function total(items) {\n  return items.length + 1;\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  const patch = git('diff', base, head, '--', 'src/app.ts');
  const body = patch.slice(patch.indexOf('@@'));
  return { dir, base, head, files: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: body }] };
}

function fakeGitHub(repo, reportedHead) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (method === 'POST') return json({ id: 9, html_url: 'https://github.com/x', state: 'COMMENTED' });
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({
        number: PR,
        title: 'Count one more',
        body: '',
        user: { login: 'an-author' },
        head: { sha: reportedHead, ref: 'feature' },
        base: { sha: repo.base, ref: 'main' },
        changed_files: 1,
        commits: 1,
        additions: 1,
        deletions: 1,
      });
    }
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}/files`) return json(repo.files);
    if (parsed.pathname === '/user') return json({ login: 'your-github-login' });
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: 0, check_runs: [] });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(parsed.pathname)) return json([]);
    return new Response('not found', { status: 404 });
  };
}

/** Runs the driver and returns the argv of its `symbols` invocation. */
async function symbolsArgv(t, reportedHead) {
  const repo = driverRepository(t);
  const fakeDir = mkdtempSync(join(tmpdir(), 'rv-s10-fakes-'));
  const data = mkdtempSync(join(tmpdir(), 'rv-s10-data-'));
  t.after(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  writeFileSync(join(fakeDir, 'diff-analyst.1.json'), JSON.stringify({ output: { candidates: [] } }));
  const github = fakeGitHub(repo, reportedHead === 'real' ? repo.head : reportedHead);
  const seen = [];
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakeDir, GITHUB_TOKEN: 't' });
  try {
    await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false },
      {
        command: (argv, stdin) => {
          if (argv[0] === 'symbols') seen.push(argv);
          return runInProcess(argv, { stdin, fetchImpl: github });
        },
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    ).catch(() => undefined);
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_FAKE_AGENTS', 'GITHUB_TOKEN']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  }
  assert.equal(seen.length, 1, 'the driver runs symbols once');
  return { argv: seen[0], repo };
}

test('the driver passes --head <sha> to symbols when the head is available', async (t) => {
  const { argv, repo } = await symbolsArgv(t, 'real');
  const at = argv.indexOf('--head');
  assert.notEqual(at, -1, argv.join(' '));
  assert.equal(argv[at + 1], repo.head);
});

test('the driver omits --head when the head is not in the clone', async (t) => {
  const { argv } = await symbolsArgv(t, 'a'.repeat(40));
  assert.equal(argv.includes('--head'), false, argv.join(' '));
});

// The documents that tell the analyst and the user about the new fields.

test('step 1e of review.md passes --head for a local head commit', () => {
  const text = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const start = text.indexOf('## Step 1e');
  const end = text.indexOf('## Step 1f');
  assert.ok(start !== -1 && end > start);
  const step = text.slice(start, end);
  assert.match(step, /--head <head sha>/);
  assert.match(step, /working-tree and staged/);
});

test('the analyst prompt documents testReferences and the single-caller lead', () => {
  const text = readFileSync(join(plugin, 'agents/diff-analyst.md'), 'utf8');
  assert.match(text, /testReferences/);
  assert.match(text, /test-adequacy/);
  assert.match(text, /callerCount/);
  assert.match(text, /callersInconclusive/);
  assert.match(text, /new generality with one caller/);
});

test('help documents --head on symbols', () => {
  assert.match(commandHelp('symbols'), /--head <ref>/);
});
