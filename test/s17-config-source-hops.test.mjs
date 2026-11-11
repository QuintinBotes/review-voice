/**
 * S17, owner decision 1: `runners:` is honoured only from the operator's own
 * configuration, and that is a stated source carried with the path at every
 * hop, never inferred from a path being present. `watch` states `flag` only
 * for its own --config, hands its reviews the source beside the copy it
 * passes, and a loader given a path with no source treats it as repository
 * content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { spawnReview } from '../plugins/review-voice/src/watch/review.ts';
import { CONFIG_COPY, reviewSpawnOptions, watchConfigSource } from '../plugins/review-voice/src/watch/command.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
delete process.env.REVIEW_VOICE_CONFIG;
delete process.env.REVIEW_VOICE_CONFIG_SOURCE;

const RULE =
  'runners is read only from the operator\'s own configuration (the file --config names, an absolute REVIEW_VOICE_CONFIG, ' +
  'or the Action\'s config input), never from a repository\'s own file, checked out or at a base commit, ' +
  'because a runner is a command this machine executes; ignoring it.';
// Fires only when the runners block was read and names codex for the challenge.
const IN_USE = /runners: codex in use with watch\.run_repository_commands false/;
const RUNNERS = ['runners:', '  codex:', '    command: [codex, exec, "{schema}"]', '  use:', '    challenge: codex', ''].join('\n');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s17-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.review-voice'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return { dir, repo };
}

/** `watch --once` from the bundle; an empty allowlist stops it with the config warnings before anything reaches GitHub. */
function watch(cwd, dataDir, args = [], extra = {}) {
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir, ...extra };
  for (const name of ['REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_CONFIG_SOURCE']) if (!(name in extra)) delete env[name];
  return spawnSync(process.execPath, [bundle, 'watch', '--once', ...args], { cwd, encoding: 'utf8', env });
}

test('watch with a checkout config ignores its runners with the one warning that names the rule', (t) => {
  const { dir, repo } = scratch(t);
  writeFileSync(join(repo, '.review-voice', 'config.yaml'), RUNNERS);
  const run = watch(repo, join(dir, 'data'));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stderr.split('\n').filter((line) => line === `Warning: ${RULE}`).length, 1, run.stderr);
  assert.doesNotMatch(run.stderr, IN_USE, 'the checkout runners block never took effect');
});

test('watch --config names the operator configuration, so its runners are read', (t) => {
  const { dir, repo } = scratch(t);
  writeFileSync(join(repo, '.review-voice', 'config.yaml'), 'repositories:\n  include: []\n');
  const own = join(dir, 'own.yaml');
  writeFileSync(own, RUNNERS);
  const run = watch(repo, join(dir, 'data'), ['--config', own]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, IN_USE);
  assert.equal(run.stderr.includes(RULE), false, run.stderr);
});

test('watch --config with no value, or a file that does not exist, exits 2 before reading anything', (t) => {
  const { dir, repo } = scratch(t);
  const missing = watch(repo, join(dir, 'data'), ['--config']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--config needs a value\./);
  const absent = watch(repo, join(dir, 'data'), ['--config', join(dir, 'absent.yaml')]);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /--config .*absent\.yaml does not exist\./);
});

test('watch started with an operator REVIEW_VOICE_CONFIG reads its runners, as decision 1 allows', (t) => {
  const { dir, repo } = scratch(t);
  const own = join(dir, 'own.yaml');
  writeFileSync(own, RUNNERS);
  const run = watch(repo, join(dir, 'data'), [], { REVIEW_VOICE_CONFIG: own });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, IN_USE);
  assert.equal(run.stderr.includes(RULE), false, run.stderr);
});

test('a review watch launches gets the source beside the copy, and honours runners only for an operator source', async (t) => {
  const { dir } = scratch(t);
  const load = pathToFileURL(join(root, 'plugins/review-voice/src/policy/load.ts')).href;
  const script = join(dir, 'bundle.mjs');
  writeFileSync(
    script,
    `import { loadConfig } from ${JSON.stringify(load)};
     const config = loadConfig(process.cwd());
     process.stdout.write(JSON.stringify({ runId: JSON.stringify({ source: process.env.REVIEW_VOICE_CONFIG_SOURCE ?? null, challenge: config.runners.use.challenge, ruled: config.warnings.some((w) => w.startsWith('runners is read only')) }) }));`,
  );
  const clone = join(dir, 'clone');
  mkdirSync(clone);
  const copy = join(dir, 'watch-config.yaml');
  writeFileSync(copy, RUNNERS);
  const call = { repository: 'acme/web', pull: 7, expectHead: 'a'.repeat(40), timeoutMs: 60_000, runRepositoryCommands: false, clone, post: false };
  const seen = async (options) => JSON.parse((await spawnReview(script, { configPath: copy, ...options })(call)).runId);

  assert.deepEqual(await seen({ configSource: 'checkout' }), { source: 'checkout', challenge: 'claude', ruled: true });
  assert.deepEqual(await seen({ configSource: 'flag' }), { source: 'flag', challenge: 'codex', ruled: false });
  assert.deepEqual(await seen({ configSource: 'env' }), { source: 'env', challenge: 'codex', ruled: false });
  assert.deepEqual(await seen({}), { source: 'checkout', challenge: 'claude', ruled: true }, 'a copy with no stated source is not the operator configuration');
});

test('a path the caller passes with no stated source is repository content, and one stated as the operator choice is read', (t) => {
  const { dir } = scratch(t);
  const file = join(dir, 'config.yaml');
  writeFileSync(file, RUNNERS);
  const unstated = loadConfig(dir, NO_BASELINE, file);
  assert.ok(unstated.warnings.includes(RULE), unstated.warnings.join('\n'));
  assert.equal(unstated.runners.use.challenge, 'claude');
  for (const source of ['checkout', 'base', 'default']) {
    assert.equal(loadConfig(dir, NO_BASELINE, file, undefined, source).runners.use.challenge, 'claude', source);
  }
  for (const source of ['flag', 'env']) {
    const stated = loadConfig(dir, NO_BASELINE, file, undefined, source);
    assert.equal(stated.runners.use.challenge, 'codex', source);
    assert.equal(stated.warnings.includes(RULE), false, source);
  }
});

test('REVIEW_VOICE_CONFIG_SOURCE describes only an absolute REVIEW_VOICE_CONFIG: alone it never makes a checkout trusted', (t) => {
  const { repo } = scratch(t);
  writeFileSync(join(repo, '.review-voice', 'config.yaml'), RUNNERS);
  const saved = [process.env.REVIEW_VOICE_CONFIG, process.env.REVIEW_VOICE_CONFIG_SOURCE];
  try {
    process.env.REVIEW_VOICE_CONFIG_SOURCE = 'flag';
    const config = loadConfig(repo, NO_BASELINE);
    assert.ok(config.warnings.includes(RULE), config.warnings.join('\n'));
    assert.equal(config.runners.use.challenge, 'claude');

    process.env.REVIEW_VOICE_CONFIG = join(repo, '.review-voice', 'config.yaml');
    for (const stated of ['checkout', 'base', 'default', 'not-a-source', '']) {
      process.env.REVIEW_VOICE_CONFIG_SOURCE = stated;
      assert.equal(loadConfig(repo, NO_BASELINE).runners.use.challenge, 'claude', `stated ${JSON.stringify(stated)}`);
    }
    delete process.env.REVIEW_VOICE_CONFIG_SOURCE;
    assert.equal(loadConfig(repo, NO_BASELINE).runners.use.challenge, 'codex', 'an absolute REVIEW_VOICE_CONFIG with no source beside it is the operator environment');
  } finally {
    for (const [i, name] of ['REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_CONFIG_SOURCE'].entries()) {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }
  }
});

test('the watch help names --config and the source rule', () => {
  const run = spawnSync(process.execPath, [bundle, 'watch', '--help'], { encoding: 'utf8' });
  const text = `${run.stdout}${run.stderr}`;
  assert.match(text, /--config <path>/);
  assert.match(readFileSync(join(root, 'docs/WATCHER.md'), 'utf8'), /REVIEW_VOICE_CONFIG_SOURCE/);
});

test('the reviews watch launches get the source of the file watch started with: checkout, --config, or an operator REVIEW_VOICE_CONFIG', async (t) => {
  const { dir, repo } = scratch(t);
  writeFileSync(join(repo, '.review-voice', 'config.yaml'), RUNNERS);
  const own = join(dir, 'own.yaml');
  writeFileSync(own, RUNNERS);
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  // What a pass leaves for its reviews: the copy of whichever file watch read, here the same runners block every time.
  writeFileSync(join(dataDir, CONFIG_COPY), RUNNERS);
  const load = pathToFileURL(join(root, 'plugins/review-voice/src/policy/load.ts')).href;
  const script = join(dir, 'bundle.mjs');
  writeFileSync(
    script,
    `import { loadConfig } from ${JSON.stringify(load)};
     const config = loadConfig(process.cwd());
     process.stdout.write(JSON.stringify({ runId: JSON.stringify({ path: process.env.REVIEW_VOICE_CONFIG, source: process.env.REVIEW_VOICE_CONFIG_SOURCE ?? null, challenge: config.runners.use.challenge }) }));`,
  );
  const clone = join(dir, 'clone');
  mkdirSync(clone);
  const call = { repository: 'acme/web', pull: 7, expectHead: 'a'.repeat(40), timeoutMs: 60_000, runRepositoryCommands: false, clone, post: false };
  const child = async (argv) => {
    const config = watchConfigSource(argv, repo);
    assert.notEqual(typeof config, 'string', String(config));
    return JSON.parse((await spawnReview(script, reviewSpawnOptions(dataDir, config))(call)).runId);
  };
  const copy = join(dataDir, CONFIG_COPY);

  assert.deepEqual(await child([]), { path: copy, source: 'checkout', challenge: 'claude' }, 'a checkout file never names a runner in a review');
  assert.deepEqual(await child(['--config', own]), { path: copy, source: 'flag', challenge: 'codex' });
  process.env.REVIEW_VOICE_CONFIG = own;
  try {
    assert.deepEqual(await child([]), { path: copy, source: 'env', challenge: 'codex' });
  } finally {
    delete process.env.REVIEW_VOICE_CONFIG;
  }
});

test('watch outside a repository reads only the file --config names', (t) => {
  const { dir } = scratch(t);
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  const own = join(dir, 'own.yaml');
  writeFileSync(own, RUNNERS);
  const run = watch(outside, join(dir, 'data'), ['--config', own]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, IN_USE, 'the operator file was read, runners included');
  assert.equal(run.stderr.includes(RULE), false, run.stderr);
  assert.deepEqual(watchConfigSource(['--config', own], null), { path: own, source: 'flag' });
  assert.equal(watchConfigSource([], null), null, 'no file at all, as before --config existed');
});

/**
 * `watch --once --json` from the bundle, all the way to the review it launches.
 * A module loaded into both processes stands in for GitHub in the watcher
 * (one pull request waiting for review) and, in the review, answers with what
 * the bundle's own `plan` reads from the configuration it was handed.
 */
function watchedReview(t, { checkout, args = [], extra = {} }) {
  const { dir, repo } = scratch(t);
  writeFileSync(join(repo, '.review-voice', 'config.yaml'), checkout);
  const git = (cwd, ...rest) => execFileSync('git', ['-c', 'user.name=hops', '-c', 'user.email=hops@example.com', ...rest], { cwd, encoding: 'utf8' }).trim();
  const origin = join(dir, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q');
  writeFileSync(join(origin, 'app.ts'), 'export const one = 1;\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'first');
  const head = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/7/head', head);
  const dataDir = join(dir, 'data');
  const clone = join(dataDir, 'clones', 'acme', 'web');
  mkdirSync(dirname(clone), { recursive: true });
  git(dir, 'clone', '-q', origin, clone);

  const files = join(dir, 'files.json');
  const patch = join(dir, 'diff.patch');
  writeFileSync(files, JSON.stringify({ files: [] }));
  writeFileSync(patch, '');
  const standIn = join(dir, 'stand-in.mjs');
  writeFileSync(
    standIn,
    `import { spawnSync } from 'node:child_process';
     const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
     if (process.argv[2] === 'watch') {
       globalThis.fetch = async (url) => {
         const { pathname } = new URL(url);
         if (pathname === '/user') return json({ login: 'owner' });
         if (pathname === '/search/issues') return json({ total_count: 1, items: [{ repository_url: 'https://api.github.com/repos/acme/web', number: 7 }] });
         if (pathname === '/repos/acme/web/pulls/7') return json({ state: 'open', draft: false, head: { sha: ${JSON.stringify(head)} }, user: { login: 'dev', type: 'User' }, created_at: '2026-01-01T00:00:00Z' });
         return json([]);
       };
     } else if (process.argv[2] === 'review') {
       const env = { ...process.env };
       delete env.NODE_OPTIONS;
       const plan = spawnSync(process.execPath, [process.argv[1], 'plan', '--files', ${JSON.stringify(files)}, '--diff-file', ${JSON.stringify(patch)}], { encoding: 'utf8', env });
       const read = plan.status === 0 ? JSON.parse(plan.stdout) : null;
       const seen = { source: process.env.REVIEW_VOICE_CONFIG_SOURCE ?? null, challenge: read?.families.challenge ?? plan.stderr, runners: Object.keys(read?.runners ?? {}), ruled: plan.stderr.includes('runners is read only') };
       await new Promise(() => process.stdout.write(JSON.stringify({ runId: JSON.stringify(seen) }), () => process.exit(0)));
     }`,
  );
  const run = watch(repo, dataDir, ['--json', ...args], {
    NODE_OPTIONS: `--import ${pathToFileURL(standIn).href}`,
    GITHUB_TOKEN: ['stand', 'in'].join('-'),
    ...extra,
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  const rows = JSON.parse(run.stdout);
  assert.deepEqual(rows.map((row) => [row.repository, row.pull, row.status]), [['acme/web', 7, 'reviewed']], run.stdout);
  return { seen: JSON.parse(rows[0].runId), stderr: run.stderr };
}

const ALLOWED = 'repositories:\n  include: [acme/web]\nwatch:\n  run_repository_commands: true\n';

test('the watch command hands the review it launches the checkout source, so that review never reads the runners a checkout names', (t) => {
  const { seen, stderr } = watchedReview(t, { checkout: `${ALLOWED}${RUNNERS}` });
  assert.deepEqual(seen, { source: 'checkout', challenge: 'claude', runners: [], ruled: true });
  assert.ok(stderr.includes(RULE), 'the watcher names the rule too');
});

test('the watch command hands the review it launches the flag source for its own --config, and that review reads the runners', (t) => {
  const { dir } = scratch(t);
  const own = join(dir, 'own.yaml');
  writeFileSync(own, `${ALLOWED}${RUNNERS}`);
  const { seen } = watchedReview(t, { checkout: 'repositories:\n  include: []\n', args: ['--config', own] });
  assert.deepEqual(seen, { source: 'flag', challenge: 'codex', runners: ['codex'], ruled: false });
});

test('the watch command hands the review it launches the env source for an operator REVIEW_VOICE_CONFIG, and that review reads the runners', (t) => {
  const { dir } = scratch(t);
  const own = join(dir, 'own.yaml');
  writeFileSync(own, `${ALLOWED}${RUNNERS}`);
  const { seen } = watchedReview(t, { checkout: `${ALLOWED}${RUNNERS}`, extra: { REVIEW_VOICE_CONFIG: own } });
  assert.deepEqual(seen, { source: 'env', challenge: 'codex', runners: ['codex'], ruled: false });
});
