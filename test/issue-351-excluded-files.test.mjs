/**
 * Issue 351: a pull request changed twelve files, ten of them under a
 * first-party directory named vendor, and the review read two with no word
 * about the rest. The diff now says how many changed files it left out and
 * why, the count travels to the stored run, explain, the driver's report and
 * the scope block, and `review.first_party_paths` names paths that are never
 * a vendored dependency, read from the trusted configuration. A follow-up
 * counts the files of its own scope, and reads in full a file the earlier
 * review left out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { deletedFileCheck } from '../plugins/review-voice/src/cli/score.ts';
import { acquireDiff } from '../plugins/review-voice/src/diff/acquire.ts';
import { classify, findHandEdited, firstPartyMatcher, isReviewable } from '../plugins/review-voice/src/diff/classify.ts';
import { leftOutPaths, parseExclusions, summariseExclusions } from '../plugins/review-voice/src/diff/exclusions.ts';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';
import { acquirePullRequestDiff, applyReviewScope } from '../plugins/review-voice/src/diff/pull-request.ts';
import { collectSymbolContext } from '../plugins/review-voice/src/diff/symbols.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { CONFIG_KEYS, loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { scopeBlock } from '../plugins/review-voice/src/publish/verdict.ts';
import { runReview } from '../plugins/review-voice/src/review/driver.ts';
import { computeReach, isCode } from '../plugins/review-voice/src/scoring/reach.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { runDetail } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
const REPO = 'acme/api';
const PR = 12;
const VENDOR = 'packages/vendor';
const FIRST_PARTY = `review:\n  first_party_paths:\n    - "${VENDOR}/**"\n`;
const LANE =
  '  lanes:\n    - name: structure\n      agent: structure-analyst\n      prefix: st_\n      when: { min_changed_source_lines: 40 }\n';
const TEN_OF_TWELVE = 'Excluded 10 of 12 changed files: 10 vendored dependency.';
// An inherited override would make every loader here read another file than the temporary repository's.
delete process.env.REVIEW_VOICE_CONFIG;

const APP_BASE = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}', ''].join('\n');
const APP_HEAD = APP_BASE.replace('item.price;', 'item.price * item.qty;');
const UTIL = ['export function round(value) {', '  const scale = 100;', '  return Math.round(value * scale) / scale;', '}', ''].join('\n');
/** Seventeen lines and one decision point, so ten of them are 170 lines and ten decision points. Synthetic. */
const vendorSource = (n) =>
  [
    `export function rate${n}(order) {`,
    `  if (order.total > ${n}00) return ${n};`,
    ...Array.from({ length: 13 }, (_, step) => `  order.steps.push(${n * 100 + step});`),
    '  return 0;',
    '}',
    '',
  ].join('\n');
const vendorPaths = Array.from({ length: 10 }, (_, index) => `${VENDOR}/src/rate${index + 1}.ts`);
/** The change of the issue: two files outside the vendor directory, ten inside it. */
const CHANGE = {
  'src/app.ts': APP_HEAD,
  'src/util.ts': UTIL,
  ...Object.fromEntries(vendorPaths.map((path, index) => [path, vendorSource(index + 1)])),
};
const LOCK = { [`${VENDOR}/package-lock.json`]: '{\n  "lockfileVersion": 3\n}\n' };

/** A clone with a base commit on main and the change committed on `feature`; ends on main. */
function repository(t, change, baseFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-351-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write({ 'src/app.ts': APP_BASE, 'README.md': '# Api\n\nSums prices.\n', ...baseFiles });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'feature');
  write(change);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  const repo = { dir, base, head, git, write, paths: Object.keys(change), files: [] };
  repo.files = served(repo);
  return repo;
}

/** The pull request's files as GitHub would serve them, for the paths the change touched. */
function served(repo) {
  return repo.paths.map((path) => {
    const patch = repo.git('diff', repo.base, repo.head, '--', path);
    const body = patch.slice(patch.indexOf('@@'));
    const additions = body.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = body.split('\n').filter((line) => line.startsWith('-')).length;
    return { filename: path, status: 'modified', additions, deletions, changes: additions + deletions, patch: body };
  });
}

/** One more commit on `feature`: the head moves and the files are served again; ends on main. */
function followUp(repo, change) {
  repo.git('checkout', '-q', 'feature');
  repo.write(change);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'follow-up');
  repo.head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', 'main');
  repo.paths = [...new Set([...repo.paths, ...Object.keys(change)])];
  repo.files = served(repo);
}

/** Whatever `act` commits on `feature`, a merge or a rename: the head moves and `paths` are served; ends on main. */
function onFeature(repo, act, paths = repo.paths) {
  repo.git('checkout', '-q', 'feature');
  act();
  repo.head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', 'main');
  repo.paths = paths;
  repo.files = served(repo);
}

/** One commit on main, as when the repository changes its configuration: the base tip moves. */
function onMain(repo, change) {
  repo.write(change);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'main moves');
  repo.base = repo.git('rev-parse', 'HEAD').trim();
  repo.files = served(repo);
}

/** A data directory removed with the test. */
function dataDir(t) {
  const data = mkdtempSync(join(tmpdir(), 'rv-351-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  return data;
}

/** The built CLI run in `dir`, on the branch with the change, with a data directory of its own unless one is given. */
function cli(t, repo, args, input = '', data = dataDir(t)) {
  const run = spawnSync(process.execPath, [bundle, ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
  });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

/** `diff --base main --out`, then the manifest it wrote and the summary it printed. */
function diffOut(t, repo, extra = []) {
  repo.git('checkout', '-q', 'feature');
  const out = mkdtempSync(join(tmpdir(), 'rv-351-out-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const run = cli(t, repo, ['diff', '--base', 'main', '--out', out, ...extra]);
  return { out, stderr: run.stderr, summary: JSON.parse(run.stdout).summary, manifest: JSON.parse(readFileSync(join(out, 'files.json'), 'utf8')) };
}

const reviewedPaths = (manifest) => manifest.files.filter((file) => file.reviewed).map((file) => file.path).sort();

test('a first-party path lifts the vendored class and no other', () => {
  const own = firstPartyMatcher([`${VENDOR}/**`]);
  assert.equal(classify(`${VENDOR}/src/rate.ts`), 'vendored');
  assert.equal(classify(`${VENDOR}/src/rate.ts`, own), 'source');
  assert.equal(isReviewable(`${VENDOR}/src/rate.ts`, false, own), true);
  assert.equal(classify(`${VENDOR}/package-lock.json`, own), 'lockfile');
  assert.equal(classify(`${VENDOR}/dist/rate.js`, own), 'generated');
  assert.equal(classify(`${VENDOR}/logo.png`, own), 'binary');
  assert.equal(classify('third_party/lib/a.ts', own), 'vendored', 'a path the list does not name stays vendored');
  assert.equal(classify('src/app.ts', own), 'source');
});

test('the summary counts each reason once, by its short text, and is null when no file is left out', () => {
  const file = (path, excludedBecause) => ({ path, reviewed: excludedBecause === undefined, ...(excludedBecause === undefined ? {} : { excludedBecause }) });
  assert.equal(summariseExclusions([file('src/a.ts'), file('src/b.ts')]), null);
  assert.deepEqual(
    summariseExclusions([
      file('src/a.ts'),
      file('package-lock.json', 'lock file; use --include-generated if the dependency change is the point'),
      file('vendor/a.ts', 'vendored dependency'),
      file('vendor/b.ts', 'vendored dependency'),
      file('src/gone.ts', 'file deleted'),
    ]),
    {
      changedFiles: 5,
      excludedFiles: 4,
      reasons: [
        { reason: 'vendored dependency', files: 2 },
        { reason: 'lock file', files: 1 },
        { reason: 'file deleted', files: 1 },
      ],
      note: 'Excluded 4 of 5 changed files: 2 vendored dependency, 1 lock file, 1 file deleted.',
    },
  );
  assert.equal(summariseExclusions([file('vendor/a.ts', 'vendored dependency')]).note, 'Excluded 1 of 1 changed file: 1 vendored dependency.');
});

test('diff on a change mostly under a directory named vendor says so on stderr, in the JSON and in files.json', (t) => {
  const repo = repository(t, CHANGE);
  repo.git('checkout', '-q', 'feature');
  const expected = { changedFiles: 12, excludedFiles: 10, reasons: [{ reason: 'vendored dependency', files: 10 }], note: TEN_OF_TWELVE };

  const plain = cli(t, repo, ['diff', '--base', 'main']);
  assert.deepEqual(plain.stderr.trim().split('\n'), [TEN_OF_TWELVE]);
  assert.deepEqual(JSON.parse(plain.stdout).exclusions, expected);

  const { stderr, summary, manifest } = diffOut(t, repo);
  assert.deepEqual(stderr.trim().split('\n'), [TEN_OF_TWELVE]);
  assert.deepEqual(summary.exclusions, expected);
  assert.deepEqual(manifest.exclusions, expected);
  assert.deepEqual(reviewedPaths(manifest), ['src/app.ts', 'src/util.ts']);
});

test('diff says nothing about exclusions when every changed file is read, and --include-generated still reads them all', (t) => {
  const none = diffOut(t, repository(t, { 'src/app.ts': APP_HEAD, 'src/util.ts': UTIL }));
  assert.equal(none.stderr, '');
  assert.equal(none.summary.exclusions, null);
  assert.equal(none.manifest.exclusions, null);

  const all = diffOut(t, repository(t, { ...CHANGE, ...LOCK }), ['--include-generated']);
  assert.equal(all.stderr, '');
  assert.equal(all.summary.exclusions, null);
  assert.equal(all.summary.reviewedFileCount, 13);
});

test('review.first_party_paths brings the vendor files into the diff, the complexity count, the plan and the lane line counts, and a lock file under it stays out', (t) => {
  const lanes = (repo, found) => JSON.parse(cli(t, repo, ['lanes', '--files', join(found.out, 'files.json'), '--diff-file', join(found.out, 'diff.patch')]).stdout);
  const plan = (repo, found) => JSON.parse(cli(t, repo, ['plan', '--files', join(found.out, 'files.json'), '--diff-file', join(found.out, 'diff.patch')]).stdout);

  // Without the key the lane measures the six lines outside the vendor directory, as the issue reported.
  const without = repository(t, { ...CHANGE, ...LOCK }, { '.review-voice/config.yaml': `review:\n${LANE}` });
  const excluded = diffOut(t, without);
  assert.deepEqual(excluded.stderr.trim().split('\n'), ['Excluded 11 of 13 changed files: 10 vendored dependency, 1 lock file.']);
  assert.equal(excluded.manifest.complexity.decisionPoints, 1, 'the loop line of src/app.ts');
  assert.equal(lanes(without, excluded)[1].reason, '6 changed source lines, under the minimum of 40');
  assert.equal(plan(without, excluded).reason, 'auto: production source changed within the standard limits');

  const withKey = repository(t, { ...CHANGE, ...LOCK }, { '.review-voice/config.yaml': `${FIRST_PARTY}${LANE}` });
  const read = diffOut(t, withKey);
  assert.deepEqual(read.stderr.trim().split('\n'), ['Excluded 1 of 13 changed files: 1 lock file.']);
  assert.deepEqual(read.summary.exclusions.reasons, [{ reason: 'lock file', files: 1 }]);
  assert.deepEqual(reviewedPaths(read.manifest), [...vendorPaths, 'src/app.ts', 'src/util.ts'].sort());
  for (const file of read.manifest.files) {
    if (file.path.startsWith(`${VENDOR}/src/`)) assert.equal(file.class, 'source', file.path);
  }
  const lock = read.manifest.files.find((file) => file.path === `${VENDOR}/package-lock.json`);
  assert.equal(lock.reviewed, false);
  assert.equal(lock.class, 'lockfile');
  assert.match(readFileSync(join(read.out, 'diff.patch'), 'utf8'), /^\+export function rate10\(order\) \{$/m);
  assert.equal(read.manifest.complexity.decisionPoints, 11);
  const lane = lanes(withKey, read)[1];
  assert.equal(lane.eligible, true);
  assert.equal(lane.reason, '176 changed source lines, at least 40');
  assert.equal(plan(withKey, read).reason, 'auto: 176 production lines changed (over 150)');
});

test('a first_party_paths that is not a list of globs warns with the key and the entry, and the files stay excluded', (t) => {
  const cases = [
    [`review:\n  first_party_paths: "${VENDOR}/**"\n`, `review.first_party_paths must be a list of globs; "${VENDOR}/**" is not one, so the files it names stay excluded as vendored.`],
    ['review:\n  first_party_paths: [42]\n', 'review.first_party_paths must be a list of globs; 42 is not one, so the files it names stay excluded as vendored.'],
    ['review:\n  first_party_paths: [""]\n', 'review.first_party_paths must be a list of globs; "" is not one, so the files it names stay excluded as vendored.'],
  ];
  for (const [config, warning] of cases) {
    const { stderr, summary, manifest } = diffOut(t, repository(t, CHANGE, { '.review-voice/config.yaml': config }));
    assert.deepEqual(stderr.trim().split('\n'), [`Warning: ${warning}`, TEN_OF_TWELVE], config);
    assert.equal(summary.exclusions.excludedFiles, 10, config);
    assert.deepEqual(reviewedPaths(manifest), ['src/app.ts', 'src/util.ts'], config);
  }
});

test('a bad entry is dropped alone, and the loader lists the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-351-config-'));
  try {
    assert.deepEqual(loadConfig(dir, NO_BASELINE).firstPartyPaths, [], 'none by default');
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice/config.yaml'), `review:\n  first_party_paths: ["${VENDOR}/**", 7]\n`);
    const config = loadConfig(dir, NO_BASELINE);
    assert.deepEqual(config.firstPartyPaths, [`${VENDOR}/**`]);
    assert.deepEqual(config.warnings, ['review.first_party_paths must be a list of globs; 7 is not one, so the files it names stay excluded as vendored.']);
    assert.ok(CONFIG_KEYS.review.includes('first_party_paths'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the real driver

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GitHub as the commands read it, for one pull request of `repo`. */
function fakeGitHub(repo) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({
        number: PR,
        title: 'Rate orders by vendor',
        body: '',
        user: { login: 'an-author' },
        head: { sha: repo.head, ref: 'feature' },
        base: { sha: repo.base, ref: 'main' },
        changed_files: repo.files.length,
        commits: 1,
        additions: 1,
        deletions: 1,
      });
    }
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}/files`) return json(repo.files);
    if (parsed.pathname === '/user') return json({ login: 'your-github-login' });
    if (parsed.pathname.endsWith('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(parsed.pathname)) return json([]);
    return new Response('not found', { status: 404 });
  };
}

/** Canned answers for the fake agent backend: every analyst finds nothing. */
function fakes(t, agents) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-351-fakes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const agent of agents) writeFileSync(join(dir, `${agent}.1.json`), JSON.stringify({ output: { candidates: [] } }));
  return dir;
}

/** Runs the driver in the clone with its own data directory, then `fn` with the same environment. */
async function review(t, repo, agents, fn = async () => undefined, shared = null, options = {}) {
  const data = shared ?? mkdtempSync(join(tmpdir(), 'rv-351-driver-data-'));
  if (shared === null) t.after(() => rmSync(data, { recursive: true, force: true }));
  const github = fakeGitHub(repo);
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakes(t, agents), GITHUB_TOKEN: 't' });
  try {
    const report = await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false, ...options },
      {
        command: (argv, stdin) => runInProcess(argv, { stdin, fetchImpl: github }),
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    );
    return { report, data, extra: await fn() };
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_FAKE_AGENTS', 'GITHUB_TOKEN']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  }
}

const runFile = (report, name) => JSON.parse(readFileSync(join(report.runDir, name), 'utf8'));

test('a pull request mostly under vendor carries the exclusion in the report, the manifest, the stored run, explain and the scope block', async (t) => {
  const repo = repository(t, CHANGE, { '.review-voice/config.yaml': 'verdict:\n  scope_block: true\n' });
  const { report, data, extra: explained } = await review(t, repo, ['diff-analyst'], () => runInProcess(['explain']));
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.ok(report.notes.includes(TEN_OF_TWELVE), JSON.stringify(report.notes));

  const manifest = runFile(report, 'files.json');
  assert.equal(manifest.scope.kind, 'full');
  assert.deepEqual(manifest.exclusions, { changedFiles: 12, excludedFiles: 10, reasons: [{ reason: 'vendored dependency', files: 10 }], note: TEN_OF_TWELVE });
  for (const path of vendorPaths) assert.equal(manifest.files.find((file) => file.path === path).excludedBecause, 'vendored dependency');

  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    assert.deepEqual(runDetail(db, report.runId).exclusions, manifest.exclusions);
  } finally {
    db.close();
  }
  assert.equal(explained.code, 0, explained.stderr);
  assert.ok(explained.stdout.split('\n').includes(TEN_OF_TWELVE), explained.stdout);

  const body = report.verdict.payload.body;
  assert.match(body, /^Not checked: UI behaviour, product policy, load behaviour, 10 of 12 changed files left out \(10 vendored dependency\)\.$/m);
  assert.equal(body.includes(VENDOR), false, 'the block names no path');
});

test('with review.first_party_paths at the base the pull request files are reviewed, the lane counts their lines and the lock file stays excluded', async (t) => {
  const repo = repository(t, { ...CHANGE, ...LOCK }, { '.review-voice/config.yaml': `${FIRST_PARTY}${LANE}` });
  const { report } = await review(t, repo, ['diff-analyst', 'structure-analyst']);
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.ok(report.notes.includes('Excluded 1 of 13 changed files: 1 lock file.'), JSON.stringify(report.notes));

  const manifest = runFile(report, 'files.json');
  assert.deepEqual(reviewedPaths(manifest), [...vendorPaths, 'src/app.ts', 'src/util.ts'].sort());
  assert.equal(manifest.files.find((file) => file.path === `${VENDOR}/package-lock.json`).reviewed, false);
  assert.equal(manifest.complexity.decisionPoints, 11);
  const lane = runFile(report, 'lanes.json').find((entry) => entry.lane.name === 'structure');
  assert.equal(lane.eligible, true);
  assert.equal(lane.reason, '176 changed source lines, at least 40');
  assert.equal(report.plan.reason, 'auto: 176 production lines changed (over 150)');
});

test('first_party_paths set only in the pull request head does not take effect for that pull request', async (t) => {
  const repo = repository(t, { ...CHANGE, '.review-voice/config.yaml': `${FIRST_PARTY}${LANE}` }, { '.review-voice/config.yaml': `review:\n${LANE}` });
  // The checkout is the head, so the file on disk carries the key the base does not.
  repo.git('checkout', '-q', 'feature');
  assert.deepEqual(loadConfig(repo.dir, NO_BASELINE).firstPartyPaths, [`${VENDOR}/**`]);
  const { report } = await review(t, repo, ['diff-analyst']);
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.ok(report.notes.includes('Excluded 10 of 13 changed files: 10 vendored dependency.'), JSON.stringify(report.notes));
  const manifest = runFile(report, 'files.json');
  assert.deepEqual(reviewedPaths(manifest), ['.review-voice/config.yaml', 'src/app.ts', 'src/util.ts']);
  assert.equal(runFile(report, 'lanes.json').find((entry) => entry.lane.name === 'structure').eligible, false);
});

test('a follow-up that deletes a first-party file shows the deletion, as it would for any reviewed file', async (t) => {
  const old = `${VENDOR}/src/old.ts`;
  const repo = repository(t, { 'src/app.ts': APP_HEAD }, { '.review-voice/config.yaml': FIRST_PARTY, [old]: vendorSource(9) });
  const first = await review(t, repo, ['diff-analyst']);
  assert.equal(first.report.exitCode, 0, `${first.report.error} ${JSON.stringify(first.report.notes)}`);

  repo.git('checkout', '-q', 'feature');
  repo.git('rm', '-q', old);
  repo.git('commit', '-q', '-m', 'delete the old rate');
  repo.head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', 'main');
  const patch = repo.git('diff', repo.base, repo.head, '--', old);
  repo.files = [...repo.files, { filename: old, status: 'removed', additions: 0, deletions: 17, changes: 17, patch: patch.slice(patch.indexOf('@@')) }];

  const second = await review(t, repo, ['diff-analyst'], undefined, first.data);
  assert.equal(second.report.exitCode, 0, `${second.report.error} ${JSON.stringify(second.report.notes)}`);
  assert.equal(second.report.scope.kind, 'interdiff', JSON.stringify(second.report.scope));
  assert.deepEqual(runFile(second.report, 'files.json').scope.files, [old]);
  assert.match(readFileSync(join(second.report.runDir, 'diff.patch'), 'utf8'), /^-export function rate9\(order\) \{$/m);
});

test('a follow-up whose first-party file the base absorbed lists it, read with the same list as the diff', async (t) => {
  const rate = `${VENDOR}/src/rate1.ts`;
  const repo = repository(t, { 'src/app.ts': APP_HEAD, [rate]: vendorSource(1) }, { '.review-voice/config.yaml': FIRST_PARTY });
  const first = await review(t, repo, ['diff-analyst']);
  assert.equal(first.report.exitCode, 0, `${first.report.error} ${JSON.stringify(first.report.notes)}`);
  assert.deepEqual(reviewedPaths(runFile(first.report, 'files.json')), [rate, 'src/app.ts']);

  // The base lands the same file and the pull request merges it, so its own diff no longer holds the file.
  mkdirSync(join(repo.dir, VENDOR, 'src'), { recursive: true });
  writeFileSync(join(repo.dir, rate), vendorSource(1));
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'the base lands the same file');
  repo.base = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
  repo.head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', 'main');
  repo.files = repo.files.filter((file) => file.filename === 'src/app.ts');

  const second = await review(t, repo, [], undefined, first.data);
  assert.equal(second.report.exitCode, 0, `${second.report.error} ${JSON.stringify(second.report.notes)}`);
  const scope = runFile(second.report, 'files.json').scope;
  assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
  assert.deepEqual(scope.absorbedByBase, [rate]);
});

const SCOPE_BLOCK = 'verdict:\n  scope_block: true\n';
const TOUCHED_APP = { 'src/app.ts': APP_HEAD.replace('return sum;', 'return sum + 0;') };
const TOUCHED_VENDOR = { [vendorPaths[0]]: vendorSource(1).replace('return 0;', 'return -1;') };
const excludedNotes = (report) => report.notes.filter((note) => note.startsWith('Excluded'));
const notChecked = (report) => report.verdict.payload.body.split('\n').filter((line) => line.startsWith('Not checked'));
const coveredEarlier = (manifest) => manifest.files.filter((file) => /^unchanged since the last review/.test(file.excludedBecause ?? '')).map((file) => file.path);

function storedRun(data, runId) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    return runDetail(db, runId);
  } finally {
    db.close();
  }
}

/** Makes a stored run read as one recorded before the list of left-out files was kept. */
function forgetLeftOut(data, runId) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    const row = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(runId);
    const { leftOut, ...rest } = JSON.parse(row.output_json);
    assert.ok(Array.isArray(leftOut), 'the run kept the list');
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify(rest), runId);
  } finally {
    db.close();
  }
}

test('a follow-up counts the excluded files of its own scope, not those of the whole pull request', async (t) => {
  const repo = repository(t, CHANGE, { '.review-voice/config.yaml': SCOPE_BLOCK });
  const first = await review(t, repo, ['diff-analyst']);
  assert.deepEqual(excludedNotes(first.report), [TEN_OF_TWELVE]);
  assert.deepEqual(storedRun(first.data, first.report.runId).leftOut, vendorPaths);

  // One commit to a source file: no vendored file changed, so this review leaves none out.
  followUp(repo, TOUCHED_APP);
  const second = await review(t, repo, ['diff-analyst'], () => runInProcess(['explain']), first.data);
  assert.equal(second.report.exitCode, 0, `${second.report.error} ${JSON.stringify(second.report.notes)}`);
  const manifest = runFile(second.report, 'files.json');
  assert.equal(manifest.scope.kind, 'interdiff', JSON.stringify(manifest.scope));
  assert.deepEqual(manifest.scope.files, ['src/app.ts']);
  assert.equal(manifest.exclusions, null);
  assert.deepEqual(excludedNotes(second.report), []);
  assert.deepEqual(second.extra.stdout.split('\n').filter((line) => line.startsWith('Excluded')), []);
  assert.deepEqual(notChecked(second.report), ['Not checked: UI behaviour, product policy, load behaviour.']);
  // The files stay left out by the rule that left them out, and the run says so to the next one.
  for (const path of vendorPaths) assert.equal(manifest.files.find((file) => file.path === path).excludedBecause, 'vendored dependency');
  assert.deepEqual(coveredEarlier(manifest), ['src/util.ts']);
  assert.deepEqual(storedRun(first.data, second.report.runId).leftOut, vendorPaths);

  // One commit to a vendored file, after a run that kept no list: the scope is that file, and it is left out.
  forgetLeftOut(first.data, second.report.runId);
  followUp(repo, TOUCHED_VENDOR);
  const third = await review(t, repo, [], () => runInProcess(['explain']), first.data);
  assert.equal(third.report.exitCode, 0, `${third.report.error} ${JSON.stringify(third.report.notes)}`);
  const one = 'Excluded 1 of 1 changed file: 1 vendored dependency.';
  const last = runFile(third.report, 'files.json');
  assert.equal(last.scope.kind, 'unchanged', JSON.stringify(last.scope));
  assert.deepEqual(last.exclusions, { changedFiles: 1, excludedFiles: 1, reasons: [{ reason: 'vendored dependency', files: 1 }], note: one });
  assert.deepEqual(excludedNotes(third.report), [one]);
  assert.ok(third.extra.stdout.split('\n').includes(one), third.extra.stdout);
});

test('a follow-up after the repository names the vendor files first-party reads them, and never calls them unchanged since a review that left them out', async (t) => {
  // On record of the earlier review is the list of files it left out, a run from before that list was kept, or no run at all.
  for (const onRecord of ['the list', 'a run without the list', 'no run']) {
    const repo = repository(t, CHANGE, { '.review-voice/config.yaml': SCOPE_BLOCK });
    const first = await review(t, repo, ['diff-analyst']);
    assert.deepEqual(excludedNotes(first.report), [TEN_OF_TWELVE]);
    if (onRecord === 'a run without the list') forgetLeftOut(first.data, first.report.runId);
    const reviewedHead = repo.head;

    // The repository adopts the key, so the base tip carries it, and the author pushes one commit.
    onMain(repo, { '.review-voice/config.yaml': `${FIRST_PARTY}${SCOPE_BLOCK}` });
    followUp(repo, TOUCHED_APP);
    // With no run, the previous head is named by hand in a data directory that holds nothing, as after a lost store.
    const [data, options] = onRecord === 'no run' ? [null, { since: reviewedHead }] : [first.data, {}];
    const second = await review(t, repo, ['diff-analyst'], () => runInProcess(['explain']), data, options);
    assert.equal(second.report.exitCode, 0, `${second.report.error} ${JSON.stringify(second.report.notes)}`);
    const manifest = runFile(second.report, 'files.json');
    assert.deepEqual(
      manifest.scope,
      {
        kind: 'full',
        cause: 'not-read-before',
        since: reviewedHead,
        priorRunId: onRecord === 'no run' ? null : first.report.runId,
        detail: '10 files the earlier review is not known to have read are read now',
      },
      onRecord,
    );
    assert.deepEqual(reviewedPaths(manifest), [...vendorPaths, 'src/app.ts', 'src/util.ts'].sort());
    assert.deepEqual(coveredEarlier(manifest), []);
    assert.match(readFileSync(join(second.report.runDir, 'diff.patch'), 'utf8'), /^\+export function rate10\(order\) \{$/m);
    assert.equal(manifest.exclusions, null);
    assert.deepEqual(notChecked(second.report), ['Not checked: UI behaviour, product policy, load behaviour.']);
    assert.match(second.extra.stdout, /^Scope full \(not-read-before: 10 files the earlier review is not known to have read are read now\)$/m);

    // The key is in force and every file was read, so the next commit is read alone.
    followUp(repo, { 'src/util.ts': UTIL.replace('100', '1000') });
    const third = await review(t, repo, ['diff-analyst'], undefined, second.data);
    const narrowed = runFile(third.report, 'files.json');
    assert.equal(narrowed.scope.kind, 'interdiff', JSON.stringify(narrowed.scope));
    assert.deepEqual(narrowed.scope.files, ['src/util.ts']);
    assert.equal(coveredEarlier(narrowed).length, 11);
  }
});

test('a follow-up reads the whole pull request when it would read a file the earlier review left out, however the file came to be read', async (t) => {
  const rate = vendorPaths[0];
  const big = 'src/big.ts';
  const moved = 'packages/rate1.ts';
  const adoptKey = (repo) => onMain(repo, { '.review-voice/config.yaml': `${FIRST_PARTY}${SCOPE_BLOCK}` });
  const cases = [
    {
      name: 'the key names it and the follow-up changed one of its lines',
      then(repo) {
        adoptKey(repo);
        followUp(repo, TOUCHED_VENDOR);
      },
    },
    {
      name: 'the key names it and the pull request only merged the base',
      then(repo) {
        adoptKey(repo);
        onFeature(repo, () => repo.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main'));
      },
    },
    {
      name: 'GitHub withheld its patch and serves it once the follow-up changed one of its lines',
      path: big,
      reason: 'no patch returned (binary or too large)',
      then: (repo) => followUp(repo, { [big]: vendorSource(1).replace('return 0;', 'return -1;') }),
    },
    ...[false, true].map((noRun) => ({
      name: `the follow-up moved it out of the vendor directory${noRun ? ', with no run on record' : ''}`,
      readAt: moved,
      noRun,
      then: (repo) =>
        onFeature(
          repo,
          () => {
            repo.git('mv', rate, moved);
            repo.git('commit', '-q', '-m', 'move the rate');
          },
          ['src/app.ts', moved],
        ),
    })),
  ];

  for (const { name, path = rate, reason = 'vendored dependency', readAt = path, noRun = false, then } of cases) {
    const repo = repository(t, { 'src/app.ts': APP_HEAD, [path]: vendorSource(1) }, { '.review-voice/config.yaml': SCOPE_BLOCK });
    if (path === big) repo.files = repo.files.map(({ patch, ...file }) => (file.filename === big ? file : { ...file, patch }));
    const first = await review(t, repo, ['diff-analyst']);
    assert.deepEqual(excludedNotes(first.report), [`Excluded 1 of 2 changed files: 1 ${reason}.`], name);
    assert.deepEqual(storedRun(first.data, first.report.runId).leftOut, [path], name);
    const reviewedHead = repo.head;

    then(repo);
    const [data, options] = noRun ? [null, { since: reviewedHead }] : [first.data, {}];
    const second = await review(t, repo, ['diff-analyst'], undefined, data, options);
    assert.equal(second.report.exitCode, 0, `${name}: ${second.report.error} ${JSON.stringify(second.report.notes)}`);
    const manifest = runFile(second.report, 'files.json');
    assert.deepEqual(
      manifest.scope,
      {
        kind: 'full',
        cause: 'not-read-before',
        since: reviewedHead,
        priorRunId: noRun ? null : first.report.runId,
        detail: '1 file the earlier review is not known to have read is read now',
      },
      name,
    );
    assert.deepEqual(reviewedPaths(manifest), [readAt, 'src/app.ts'].sort(), name);
    assert.deepEqual(coveredEarlier(manifest), [], name);
    // Every line the pull request adds to the file, not only what changed since the earlier review.
    assert.match(readFileSync(join(second.report.runDir, 'diff.patch'), 'utf8'), /^\+export function rate1\(order\) \{$/m, name);
    assert.equal(manifest.exclusions, null, name);
    assert.deepEqual(excludedNotes(second.report), [], name);
    assert.deepEqual(notChecked(second.report), ['Not checked: UI behaviour, product policy, load behaviour.'], name);
    assert.deepEqual(storedRun(second.data, second.report.runId).leftOut, [], name);

    // Every file was read now, so the next commit is read alone and the file is truly unchanged since.
    followUp(repo, TOUCHED_APP);
    const third = await review(t, repo, ['diff-analyst'], undefined, second.data);
    const narrowed = runFile(third.report, 'files.json');
    assert.equal(narrowed.scope.kind, 'interdiff', `${name}: ${JSON.stringify(narrowed.scope)}`);
    assert.deepEqual(narrowed.scope.files, ['src/app.ts'], name);
    assert.deepEqual(coveredEarlier(narrowed), [readAt], name);
  }
});

test('a carry that falls back to a full read reports the excluded files of the pull request once, not those of the scope it left', async (t) => {
  const repo = repository(t, CHANGE);
  const reviewedHead = repo.head;
  followUp(repo, TOUCHED_VENDOR);
  // No run is recorded in this data directory, so the unchanged scope has nothing to carry.
  const { report } = await review(t, repo, ['diff-analyst'], undefined, null, { since: reviewedHead });
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.ok(report.notes.includes('The scope is unchanged but no recorded run id was found, so the whole pull request is reviewed.'), JSON.stringify(report.notes));
  assert.deepEqual(excludedNotes(report), [TEN_OF_TWELVE]);
  assert.deepEqual(runFile(report, 'files.json').exclusions.note, TEN_OF_TWELVE);
});

test('the review command passes the exclusion line on, and records a change whose every file is left out', (t) => {
  const prompt = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  assert.match(prompt, /\*\*If `exclusions` is not null, print its `note` on its own line after the\nfindings/);
  assert.match(prompt, /^Excluded 10 of 12 changed files: 10 vendored dependency\.$/m);
  assert.match(prompt, /including after `No actionable findings\.`/);
  assert.doesNotMatch(prompt, /Silence is the answer|do not mention their\s+exclusion/);
  const record = /`RV record --repository <owner\/repo> --base <ref> --head <sha> --diff-file <tmpdir>\/diff\.patch --files <tmpdir>\/files\.json --origin interactive`\nwith exactly `No actionable findings\.` on stdin/;
  assert.match(prompt, record);
  assert.match(prompt, /\*\*If every changed file was left out, say so and record it\.\*\*/);
  // The closing list of what not to print does not take the line back.
  assert.match(prompt.split('## What not to do')[1], /The lines step 1 tells you to print after the findings still follow it, the\n`exclusions` note among them/);

  // The case the command stopped on without a word: ten changed files, all under the vendor directory.
  const repo = repository(t, Object.fromEntries(vendorPaths.map((path, index) => [path, vendorSource(index + 1)])));
  const found = diffOut(t, repo);
  const all = 'Excluded 10 of 10 changed files: 10 vendored dependency.';
  assert.deepEqual(found.stderr.trim().split('\n'), [all]);
  assert.deepEqual([found.summary.reviewedFileCount, found.summary.structure.removedControls, found.summary.exclusions.note], [0, [], all]);
  // The record call the command names for it, then what explain has to show.
  const data = dataDir(t);
  const files = ['--diff-file', join(found.out, 'diff.patch'), '--files', join(found.out, 'files.json')];
  cli(t, repo, ['record', '--repository', REPO, '--base', 'main', '--head', repo.head, ...files, '--origin', 'interactive'], 'No actionable findings.\n', data);
  assert.ok(cli(t, repo, ['explain'], '', data).stdout.split('\n').includes(all));
});

// ---------------------------------------------------------------- scopes and the other callers

const changed = (path, extra = {}) => ({ path, status: 'modified', class: 'source', language: 'typescript', additions: 1, deletions: 0, reviewed: true, ...extra });
const patchOf = (path) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,2 @@', ' x', '+y', ''].join('\n');

test('an incremental, an interdiff and an unchanged scope count only the files that changed since the earlier review', () => {
  const files = [
    changed('src/new.ts'),
    changed('src/earlier.ts'),
    changed('vendor/lib/a.ts', { class: 'vendored', reviewed: false, excludedBecause: 'vendored dependency' }),
    changed('vendor/lib/b.ts', { class: 'vendored', reviewed: false, excludedBecause: 'vendored dependency' }),
    changed('src/gone.ts', { status: 'deleted', reviewed: false, excludedBecause: 'file deleted' }),
  ];
  const acquired = {
    repositoryRoot: REPO, mode: 'pull-request', base: 'b'.repeat(40), head: 'c'.repeat(40), title: 'T', files,
    reviewedFileCount: 2, hunkFileCount: 2, excludedFileCount: 3, diff: files.filter((file) => file.reviewed).map((file) => patchOf(file.path)).join(''),
    exclusions: summariseExclusions(files), totalChangedFiles: 5, additions: 5, deletions: 0, truncated: false, truncationNote: null,
    refs: { base: { sha: 'b'.repeat(40), available: true }, head: { sha: 'c'.repeat(40), available: true }, mergeBase: 'b'.repeat(40) },
    suspectedWrongBase: null, squashedParentSuspected: null,
  };
  const prior = { since: 'a'.repeat(40), priorRunId: 'run-1', priorReviewedAt: '2026-11-01T10:00:00.000Z' };
  // Since the earlier review the author changed src/new.ts and one vendored file. The other three files are as that review met them.
  const since = ['vendor/lib/a.ts'];
  const narrowed = { changedFiles: 2, excludedFiles: 1, reasons: [{ reason: 'vendored dependency', files: 1 }], note: 'Excluded 1 of 2 changed files: 1 vendored dependency.' };
  const scopes = {
    incremental: (changedSince) => applyReviewScope(acquired, PR, { kind: 'incremental', ...prior, commits: 1, files: ['src/new.ts'] }, '/nonexistent', () => patchOf('src/new.ts'), null, changedSince),
    interdiff: (changedSince) =>
      applyReviewScope(acquired, PR, { kind: 'interdiff', ...prior, mergeBase: 'b'.repeat(40), files: ['src/new.ts'], hunks: 1 }, '/nonexistent', undefined, patchOf('src/new.ts'), changedSince),
    unchanged: (changedSince) => applyReviewScope(acquired, PR, { kind: 'unchanged', ...prior, mergeBase: 'b'.repeat(40), reason: 'base-merged' }, '/nonexistent', undefined, null, changedSince),
  };

  const full = applyReviewScope(acquired, PR, { kind: 'full', cause: 'requested', since: null, priorRunId: null }, '/nonexistent');
  assert.equal(full.exclusions.note, 'Excluded 3 of 5 changed files: 2 vendored dependency, 1 file deleted.');

  const incremental = scopes.incremental(since);
  assert.equal(incremental.files[1].excludedBecause, 'unchanged since the last review (aaaaaaa)');
  assert.deepEqual(incremental.exclusions, narrowed);
  assert.equal(incremental.excludedFileCount, 4, 'the manifest still lists every file the review does not read');
  // What the next review is told this one left out: not the file an earlier review covered.
  assert.deepEqual(leftOutPaths(incremental.files), ['vendor/lib/a.ts', 'vendor/lib/b.ts', 'src/gone.ts']);
  assert.deepEqual(scopes.interdiff(since).exclusions, narrowed);
  assert.equal(scopes.unchanged(since).exclusions.note, 'Excluded 1 of 1 changed file: 1 vendored dependency.');

  // A follow-up that touched no left-out file leaves none out, whatever the whole pull request holds.
  for (const [kind, scoped] of Object.entries(scopes)) assert.equal(scoped([]).exclusions, null, kind);
});

test('the planner names the left-out files that changed since the review, and reads in full a file the earlier review left out', (t) => {
  const repo = repository(t, CHANGE);
  const first = repo.head;
  followUp(repo, { 'src/app.ts': APP_HEAD.replace('return sum;', 'return sum + 0;'), [vendorPaths[0]]: vendorSource(1).replace('return 0;', 'return -1;') });
  const source = [{ path: 'src/app.ts' }, { path: 'src/util.ts' }];
  const vendor = vendorPaths.map((path) => ({ path }));
  const plan = (extra) =>
    planScope({
      priorRun: { reviewRunId: 'run-1', headRef: first, createdAt: null },
      head: repo.head,
      headAvailable: true,
      reviewedFiles: source,
      leftOutFiles: vendor,
      cwd: repo.dir,
      truncated: false,
      forceFull: false,
      base: repo.base,
      ...extra,
    });

  const interdiff = plan({});
  assert.equal(interdiff.scope.kind, 'interdiff', JSON.stringify(interdiff.scope));
  assert.deepEqual(interdiff.scope.files, ['src/app.ts']);
  assert.deepEqual(interdiff.leftOutChanged, [vendorPaths[0]]);
  const range = plan({ base: undefined });
  assert.equal(range.scope.kind, 'incremental', JSON.stringify(range.scope));
  assert.deepEqual(range.leftOutChanged, [vendorPaths[0]]);

  // The key now names the vendor files, so this review reads them. The earlier one left them out.
  const read = { reviewedFiles: [...source, ...vendor], leftOutFiles: [] };
  for (const base of [repo.base, undefined]) {
    assert.deepEqual(plan({ ...read, base, priorLeftOut: vendorPaths }), {
      scope: { kind: 'full', cause: 'not-read-before', since: first, priorRunId: 'run-1', detail: '10 files the earlier review is not known to have read are read now' },
      interdiffPatch: null,
    });
    assert.equal(plan({ ...read, base, priorLeftOut: [vendorPaths[1]] }).scope.detail, '1 file the earlier review is not known to have read is read now');
    // A left-out file the follow-up touched is in the narrowed scope, which holds one line of its seventeen.
    const touched = plan({ ...read, base, priorLeftOut: [vendorPaths[0]] });
    assert.deepEqual(
      [touched.scope.kind, touched.scope.cause, touched.scope.detail, touched.interdiffPatch],
      ['full', 'not-read-before', '1 file the earlier review is not known to have read is read now', null],
    );
  }
  // Files the earlier review read need no second read.
  const covered = plan({ ...read, priorLeftOut: [] });
  assert.equal(covered.scope.kind, 'interdiff', JSON.stringify(covered.scope));
  assert.deepEqual(covered.scope.files, [vendorPaths[0], 'src/app.ts']);
});

test('the planner reads in full a file renamed since out of a path the earlier review did not read', (t) => {
  const rate = vendorPaths[0];
  const big = 'src/big.ts';
  const edited = (n) => vendorSource(n).replace('return 0;', `return order.total > 5 ? ${n} : 0;`);
  // Both files are at the base and the pull request changes one line of each, so a rename alone carries a change.
  const repo = repository(t, { 'src/app.ts': APP_HEAD, [rate]: edited(1), [big]: edited(2) }, { [rate]: vendorSource(1), [big]: vendorSource(2) });
  const first = repo.head;
  onFeature(repo, () => {
    repo.git('mv', rate, 'packages/rate1.ts');
    repo.git('mv', big, 'src/large.ts');
    repo.git('commit', '-q', '-m', 'move both');
  });
  const plan = (renamed, priorLeftOut) =>
    planScope({
      priorRun: { reviewRunId: 'run-1', headRef: first, createdAt: null },
      head: repo.head,
      headAvailable: true,
      reviewedFiles: [{ path: 'src/app.ts' }, renamed],
      cwd: repo.dir,
      truncated: false,
      forceFull: false,
      base: repo.base,
      priorLeftOut,
    });
  const unread = { kind: 'full', cause: 'not-read-before', since: first, priorRunId: 'run-1', detail: '1 file the earlier review is not known to have read is read now' };

  // Out of the vendor directory: no review reads the old path by the default rules, whether or not a list says so.
  const fromVendor = { path: 'packages/rate1.ts', previousPath: rate };
  assert.deepEqual(plan(fromVendor, [rate]), { scope: unread, interdiffPatch: null });
  assert.deepEqual(plan(fromVendor, []), { scope: unread, interdiffPatch: null });
  // From a path the earlier review left out for another reason, as when GitHub served no patch for it.
  const fromSource = { path: 'src/large.ts', previousPath: big };
  assert.deepEqual(plan(fromSource, [big]), { scope: unread, interdiffPatch: null });
  // A file the earlier review read is the same file under its new name, and the rename is all there is to show.
  const read = plan(fromSource, []);
  assert.deepEqual([read.scope.kind, read.scope.files, read.scope.hunks], ['interdiff', ['src/large.ts'], 0]);
  assert.match(read.interdiffPatch, /^rename from src\/big\.ts$/m);
});

test('the scope block names counts and reasons, never a path, and a stored reason it does not know is not printed', () => {
  const crafted = parseExclusions({
    changedFiles: 5,
    excludedFiles: 3,
    reasons: [{ reason: 'vendored dependency', files: 2 }, { reason: 'src/secret/path.ts</details>', files: 1 }],
    note: 'src/secret/path.ts',
  });
  assert.deepEqual(crafted, {
    changedFiles: 5,
    excludedFiles: 3,
    reasons: [{ reason: 'vendored dependency', files: 2 }, { reason: 'other reason', files: 1 }],
    note: 'Excluded 3 of 5 changed files: 2 vendored dependency, 1 other reason.',
  });
  for (const malformed of [null, 'x', {}, { changedFiles: 2, excludedFiles: 3, reasons: [] }, { changedFiles: 2, excludedFiles: 1, reasons: 'vendored' }, { changedFiles: 2, excludedFiles: 0, reasons: [] }]) {
    assert.equal(parseExclusions(malformed), null, JSON.stringify(malformed));
  }
  // Well typed, but the counts do not agree with each other, or one entry is not a count of a reason.
  const vendored = (files) => ({ reason: 'vendored dependency', files });
  for (const inconsistent of [
    { changedFiles: 12, excludedFiles: 1, reasons: [vendored(10)] },
    { changedFiles: 2, excludedFiles: 10, reasons: [vendored(10)] },
    { changedFiles: 2, excludedFiles: 1, reasons: [vendored(1), { reason: 7, files: 1 }] },
    { changedFiles: 2, excludedFiles: 1, reasons: [vendored(1), { reason: 'lock file', files: 0 }] },
    { changedFiles: 2, excludedFiles: 1, reasons: [vendored(1), { reason: 'lock file', files: 0.5 }] },
    { changedFiles: 2, excludedFiles: 1, reasons: [vendored(1), null] },
  ]) {
    assert.equal(parseExclusions(inconsistent), null, JSON.stringify(inconsistent));
  }

  const run = { headRef: null, provenance: null, checks: null, scope: null, stages: [], held: [], families: null, exclusions: crafted };
  const planned = { inline: [], unanchored: [], held: [], belowTier: [] };
  const block = scopeBlock(run, planned, { scopeBlockModels: false });
  assert.match(block, /^Not checked: UI behaviour, product policy, load behaviour, 3 of 5 changed files left out \(2 vendored dependency, 1 other reason\)\.$/m);
  assert.equal(block.includes('secret'), false);
  assert.match(scopeBlock({ ...run, exclusions: null }, planned, { scopeBlockModels: false }), /^Not checked: UI behaviour, product policy, load behaviour\.$/m);
  const single = scopeBlock({ ...run, exclusions: summariseExclusions([{ reviewed: false, excludedBecause: 'vendored dependency' }]) }, planned, { scopeBlockModels: false });
  assert.match(single, /^Not checked: UI behaviour, product policy, load behaviour, 1 of 1 changed file left out \(1 vendored dependency\)\.$/m);
});

test('every reason a pull request file is left out for reaches the file list, the summary and the scope block in the wording of the diff', async (t) => {
  const repo = repository(
    t,
    { 'src/app.ts': APP_HEAD, 'dist/app.min.js': 'var a=1;\n', 'package-lock.json': '{\n  "lockfileVersion": 3\n}\n', [vendorPaths[0]]: vendorSource(1), 'data/rates.csv': 'a,b\n' },
    { 'src/old.ts': UTIL },
  );
  repo.git('checkout', '-q', 'feature');
  repo.git('rm', '-q', 'src/old.ts');
  repo.git('commit', '-q', '-m', 'delete the old helper');
  repo.head = repo.git('rev-parse', 'HEAD').trim();
  const hunk = '@@ -1 +1 @@\n-a\n+b';
  // As GitHub serves them: one file with no patch, and one the base tip already holds as the head does.
  const listed = [
    { filename: 'src/app.ts', status: 'modified', patch: hunk },
    { filename: 'src/old.ts', status: 'removed', patch: hunk },
    { filename: 'data/rates.csv', status: 'added' },
    { filename: 'README.md', status: 'modified', patch: hunk },
    { filename: 'dist/app.min.js', status: 'added', patch: hunk },
    { filename: 'package-lock.json', status: 'added', patch: hunk },
    { filename: vendorPaths[0], status: 'added', patch: hunk },
  ];
  const pull = { number: PR, title: 'T', base: { sha: repo.base, ref: 'main' }, head: { sha: repo.head, ref: 'feature' }, changed_files: listed.length, additions: 7, deletions: 7 };
  const fetchImpl = async (url) => json(/\/pulls\/\d+$/.test(new URL(String(url)).pathname) ? pull : listed);
  const result = await acquirePullRequestDiff({
    repository: REPO,
    pullNumber: PR,
    includeGenerated: false,
    cwd: repo.dir,
    client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} }),
  });

  const reasons = [
    'file deleted',
    'no patch returned (binary or too large)',
    'identical to the base branch tip (already merged there)',
    'generated or minified',
    'lock file',
    'vendored dependency',
  ];
  assert.deepEqual(
    result.files.map((file) => file.excludedBecause),
    [undefined, ...reasons.map((reason) => (reason === 'lock file' ? 'lock file; use --include-generated if the dependency change is the point' : reason))],
  );
  assert.deepEqual(result.exclusions, {
    changedFiles: 7,
    excludedFiles: 6,
    reasons: reasons.map((reason) => ({ reason, files: 1 })),
    note: `Excluded 6 of 7 changed files: ${reasons.map((reason) => `1 ${reason}`).join(', ')}.`,
  });
  // Each is a wording the reader knows, so none is posted as another reason.
  const stored = parseExclusions(JSON.parse(JSON.stringify(result.exclusions)));
  assert.deepEqual(stored, result.exclusions);
  const run = { headRef: null, provenance: null, checks: null, scope: null, stages: [], held: [], families: null, exclusions: stored };
  const block = scopeBlock(run, { inline: [], unanchored: [], held: [], belowTier: [] }, { scopeBlockModels: false });
  assert.ok(block.split('\n').includes(`Not checked: UI behaviour, product policy, load behaviour, 6 of 7 changed files left out (${reasons.map((reason) => `1 ${reason}`).join(', ')}).`), block);
});

test('a hand-edited generated file under a first-party path is kept for review, as anywhere else', async (t) => {
  const HEADER = '// This file is generated. Do not edit manually.\n';
  const path = `${VENDOR}/sdk/generated/client.ts`;
  const own = firstPartyMatcher([`${VENDOR}/**`]);
  assert.deepEqual([...findHandEdited([path], () => HEADER)], [], 'vendored, so never a generated file to suspect');
  assert.deepEqual([...findHandEdited([path], () => HEADER, own)], [path]);

  const repo = repository(t, { [path]: `${HEADER}export const client = 2;\n` }, { [path]: `${HEADER}export const client = 1;\n` });
  repo.git('checkout', '-q', 'feature');
  const local = (firstPartyPaths) => acquireDiff({ cwd: repo.dir, staged: false, base: 'main', includeGenerated: false, firstPartyPaths }).files[0];
  assert.deepEqual([local([]).reviewed, local([]).excludedBecause], [false, 'vendored dependency']);
  const read = local([`${VENDOR}/**`]);
  assert.deepEqual([read.reviewed, read.handEditSuspected, read.class], [true, true, 'generated']);

  // No head commit in this clone, so the header comes from the added lines of the patch.
  const served = [{ filename: path, status: 'added', additions: 2, deletions: 0, patch: `@@ -0,0 +1,2 @@\n+${HEADER}+export const client = 2;` }];
  const pull = { number: PR, title: 'T', base: { sha: 'b'.repeat(40), ref: 'main' }, head: { sha: 'f'.repeat(40), ref: 'feature' }, changed_files: 1, additions: 2, deletions: 0 };
  const fetchImpl = async (url) => json(/\/pulls\/\d+$/.test(new URL(String(url)).pathname) ? pull : served);
  const acquire = async (firstPartyPaths) =>
    (
      await acquirePullRequestDiff({
        repository: REPO,
        pullNumber: PR,
        includeGenerated: false,
        cwd: '/nonexistent',
        firstPartyPaths,
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} }),
      })
    ).files[0];
  const left = await acquire([]);
  assert.deepEqual([left.reviewed, left.excludedBecause], [false, 'vendored dependency']);
  const kept = await acquire([`${VENDOR}/**`]);
  assert.deepEqual([kept.reviewed, kept.handEditSuspected, kept.class], [true, true, 'generated']);
});

test('a withdrawn first-party file the base absorbed is listed, as any file a review would have read', (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD, [`${VENDOR}/src/rate1.ts`]: vendorSource(1) });
  const { git, dir } = repo;
  // The base lands the same vendor file, the pull request merges it, and its own diff no longer holds the file.
  mkdirSync(join(dir, VENDOR, 'src'), { recursive: true });
  writeFileSync(join(dir, `${VENDOR}/src/rate1.ts`), vendorSource(1));
  git('add', '-A');
  git('commit', '-q', '-m', 'the base lands the same file');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
  const head = git('rev-parse', 'HEAD').trim();
  const plan = (firstPartyPaths) =>
    planScope({
      priorRun: { reviewRunId: 'run-1', headRef: repo.head, createdAt: null },
      head,
      headAvailable: true,
      reviewedFiles: [{ path: 'src/app.ts' }],
      cwd: dir,
      truncated: false,
      forceFull: false,
      base,
      firstPartyPaths,
    }).scope;
  assert.equal(plan([]).absorbedByBase, undefined);
  const scope = plan([`${VENDOR}/**`]);
  assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
  assert.deepEqual(scope.absorbedByBase, [`${VENDOR}/src/rate1.ts`]);
});

test('a finding on a deleted first-party file is one a review would read, by the configuration in force', (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD }, { [`${VENDOR}/src/rate1.ts`]: vendorSource(1) });
  const { git, dir } = repo;
  git('checkout', '-q', 'feature');
  git('rm', '-q', `${VENDOR}/src/rate1.ts`);
  git('commit', '-q', '-m', 'delete the rate');
  const head = git('rev-parse', 'HEAD').trim();
  const accepted = () => {
    const saved = process.cwd();
    process.chdir(dir);
    try {
      return deletedFileCheck(['--base', repo.base, '--head', head])({ path: `${VENDOR}/src/rate1.ts`, line: 2 }, { ok: false, kind: 'file-not-in-diff' });
    } finally {
      process.chdir(saved);
    }
  };
  assert.equal(accepted(), false);
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice/config.yaml'), FIRST_PARTY);
  assert.equal(accepted(), true);
});

test('reach and the symbol context count a first-party file as code', () => {
  const own = firstPartyMatcher([`${VENDOR}/**`]);
  const path = `${VENDOR}/src/rate1.ts`;
  assert.equal(isCode(path), false);
  assert.equal(isCode(path, own), true);

  const patch = (file) =>
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,1 @@', '-export const computeRate = (order) => 1;', '+export const computeRate = (order) => 2;', ''].join('\n');
  const hits = [path, 'src/app.ts', 'src/billing/invoice.ts', 'lib/report.ts'];
  const search = (symbol) => (symbol === 'computeRate' ? hits : []);
  const reach = (firstParty) => computeReach('computeRate returns the wrong rate', path, '/nonexistent', null, search, patch(path), firstParty);
  // Vendored, the changed file is not code, so its own symbol is set aside and nothing is measured.
  assert.equal(reach(undefined).reach, null);
  assert.deepEqual(reach(undefined).ignoredSymbols, ['computeRate']);
  assert.equal(reach(own).reach, 'repository');
  assert.ok(reach(own).countedPaths.includes(path));

  const references = (firstPartyPaths) =>
    collectSymbolContext({ diff: patch('src/app.ts'), cwd: '/nonexistent', ref: null, search, lineSearch: () => [], firstPartyPaths }).files[0].symbols[0].references;
  assert.deepEqual(references([]), ['lib/report.ts', 'src/billing/invoice.ts']);
  assert.deepEqual(references([`${VENDOR}/**`]), ['lib/report.ts', path, 'src/billing/invoice.ts']);
});

test('a symbol used only under a first-party path has reach, callers and look-alikes there', () => {
  const own = firstPartyMatcher([`${VENDOR}/**`]);
  const path = `${VENDOR}/src/rate1.ts`;
  const caller = `${VENDOR}/billing/invoice.ts`;
  const lookAlike = `${VENDOR}/lib/report.ts`;
  const within = [path, caller, lookAlike, `${VENDOR}/api/handler.ts`];
  const patch = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,1 @@', '-export const computeRate = (order) => 1;', '+export const computeRate = (order) => 2;', ''].join('\n');
  // Found by its own name, then only by the name of its module, which is the fallback for a symbol with no hit.
  for (const name of ['computeRate', 'rate1']) {
    const reach = (firstParty) => computeReach('computeRate returns the wrong rate', path, '/nonexistent', null, (symbol) => (symbol === name ? within : []), patch, firstParty);
    assert.equal(reach(undefined).reach, null, name);
    assert.equal(reach(own).reach, 'repository', name);
    assert.deepEqual(reach(own).countedPaths, [...within].sort(), name);
    assert.equal(reach(own).moduleFallback, name === 'rate1', name);
  }

  const added = ['diff --git a/src/rates.ts b/src/rates.ts', '--- a/src/rates.ts', '+++ b/src/rates.ts', '@@ -1,1 +1,4 @@', ' export const one = 1;', '+export function computeOrderRate(order) {', '+  return order.total;', '+}', ''].join('\n');
  const declared = (firstPartyPaths) =>
    collectSymbolContext({
      diff: added,
      cwd: '/nonexistent',
      ref: null,
      head: 'h',
      search: () => [],
      headSearch: (symbol) => (symbol === 'computeOrderRate' ? [caller] : []),
      lineSearch: () => [{ path: lookAlike, line: 3, text: 'export function computeRateForOrder(order) {' }],
      firstPartyPaths,
    }).files[0].declared[0];
  assert.deepEqual([declared([]).callers, declared([]).possibleExisting], [[], []]);
  const found = declared([`${VENDOR}/**`]);
  assert.deepEqual(found.callers, [caller]);
  assert.deepEqual(found.possibleExisting, [{ path: lookAlike, line: 3, name: 'computeRateForOrder' }]);
});

test('the symbols and score commands read first_party_paths from the configuration', (t) => {
  const user = `${VENDOR}/src/rate1.ts`;
  const RATE = 'export const computeRate = (order) => 1;\n';
  const uses = "import { computeRate } from './rates';\nexport const rate = (order) => computeRate(order);\n";
  const candidate = {
    candidate_id: 'cand_001', path: 'src/rates.ts', line: 1, category: 'correctness', severity: 'minor',
    claim: 'computeRate now returns 2 for every order.', failure_mode: 'Every order is charged the wrong rate.',
    evidence: ['src/rates.ts:1 returns 2.'], technical_confidence: 0.9,
  };
  const measured = (config) => {
    const repo = repository(t, { 'src/rates.ts': RATE.replace('=> 1', '=> 2') }, { 'src/rates.ts': RATE, 'lib/report.ts': uses, [user]: uses, ...config });
    repo.git('checkout', '-q', 'feature');
    const patch = join(mkdtempSync(join(tmpdir(), 'rv-351-patch-')), 'diff.patch');
    t.after(() => rmSync(dirname(patch), { recursive: true, force: true }));
    writeFileSync(patch, repo.git('diff', 'main', 'feature'));
    const symbols = JSON.parse(cli(t, repo, ['symbols', '--diff-file', patch]).stdout);
    const scored = JSON.parse(cli(t, repo, ['score', '--diff-file', patch], JSON.stringify({ candidates: [candidate] })).stdout);
    return {
      references: symbols.files[0].symbols.find((entry) => entry.symbol === 'computeRate').references,
      counted: scored.scores[0].severity.reach.countedPaths,
    };
  };
  assert.deepEqual(measured({}), { references: ['lib/report.ts'], counted: ['lib/report.ts', 'src/rates.ts'] });
  assert.deepEqual(measured({ '.review-voice/config.yaml': FIRST_PARTY }), {
    references: ['lib/report.ts', user],
    counted: ['lib/report.ts', user, 'src/rates.ts'],
  });
});

test('the help, the example configuration, the architecture and the decision records describe the summary and the key', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const help = (command) => spawnSync(process.execPath, [bundle, command, '--help'], { encoding: 'utf8' }).stdout;
  for (const command of ['diff', 'review']) {
    assert.match(help(command), /Excluded 10 of 12 changed files: 10 vendored dependency\./, command);
    assert.match(help(command), /review\.first_party_paths/, command);
  }
  const template = read('plugins/review-voice/templates/config.example.yaml').split('\nreview:\n')[1].split('\nci:\n')[0];
  assert.match(template, /^  first_party_paths: \[\]$/m);
  const architecture = read('docs/ARCHITECTURE.md');
  assert.match(architecture, /`review\.first_party_paths`/);
  assert.match(architecture, /Excluded 10 of 12 changed files: 10 vendored dependency\./);
  // The follow-up rules: the count is over the scope, and an unread file sends a full read.
  assert.match(architecture, /the\s+files that changed since the earlier review/);
  assert.match(architecture, /the scope is `full` with the cause `not-read-before`/);
  assert.match(architecture, /A previous head with no\s+recorded run, from `--since` or from a review on GitHub/);
  assert.match(help('diff'), /cause not-read-before/);
  const scopeRecord = read('docs/adr/0028-verdict-policies-are-configurable.md').split('## Amendment - 2026-11-11\n')[1];
  assert.ok(scopeRecord, 'ADR 0028 carries the dated amendment');
  assert.match(scopeRecord, /Not checked/);
  assert.match(scopeRecord, /never a path/);
  const countRecord = read('docs/adr/0012-complex-changes-need-human-approval.md').split('## Amendment - 2026-11-11\n')[1];
  assert.ok(countRecord, 'ADR 0012 carries the dated amendment');
  assert.match(countRecord, /`review\.first_party_paths`/);
  assert.match(read('docs/adr/README.md'), /\| \[0028\][^\n]*amended 2026-11-11 \(files left out\)/);
  assert.match(read('docs/adr/README.md'), /\| \[0012\][^\n]*amended 2026-11-11 \(`review\.first_party_paths`\)/);
});
