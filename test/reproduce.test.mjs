/**
 * S16 part A. The confined runner for verifier-written reproductions: the
 * configuration block, the command's skip and probe paths, every rule of the
 * runner through the injected spawn (which runs on every host), and the
 * confinement itself through the bundle wherever the probe passes. Every
 * reproduction runs in a throwaway copy of the head worktree, so a hook that
 * acts as the code under review acts on `options.cwd`, never on the head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnChild, spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { randomInt } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { layoutOf, linuxSetup, probeSandbox, reproduce, runProbe, sandboxProfile, shellQuote, wrapperArgv } from '../plugins/review-voice/src/evidence/reproduce.ts';
import { spawnCommand, stopCommands } from '../plugins/review-voice/src/evidence/run.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
const MARKER = 'RV_REPRO_REACHED cand_001';
const RUNNER = { name: 'node-test', run: 'node --test {file}', extension: '.test.mjs', timeoutSeconds: 120 };

function temporary(t, prefix = 'rv-s16-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A clone with one commit, and a run directory inside a data directory holding a linked head worktree, as the driver lays it out. */
function scratchRepository(t, { config, files = {}, links = {} } = {}) {
  const dir = temporary(t);
  const clone = join(dir, 'clone');
  mkdirSync(join(clone, 'src'), { recursive: true });
  git(clone, 'init', '-q', '-b', 'main');
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, 'src/add.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(clone, '.gitignore'), '*.log\nnode_modules\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), text);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(clone, path));
  if (config !== undefined) {
    mkdirSync(join(clone, '.review-voice'));
    writeFileSync(join(clone, '.review-voice/config.yaml'), JSON.stringify(config, null, 2));
  }
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'base');
  const dataDir = join(dir, 'data');
  const runDir = join(dataDir, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  const worktree = join(runDir, 'head');
  git(clone, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  return { dir, clone, dataDir, runDir, worktree, home };
}

const reproDir = (repo) => join(repo.runDir, 'reproductions');
const treesDir = (repo) => join(reproDir(repo), 'trees');
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every execution gets a fresh directory from mkdtemp, the id, a dash and six characters. */
const placesPattern = (repo, id) => `${escaped(treesDir(repo))}/${id === undefined ? '[A-Za-z0-9_.-]+' : escaped(id)}-[A-Za-z0-9]{6}`;
const assertCopyOf = (repo, cwd, id) => assert.match(cwd, new RegExp(`^${placesPattern(repo, id)}/tree$`), `${cwd} is a copy`);
/** The scratch directory beside a copy. */
const scratchBeside = (copy) => join(dirname(copy), 'scratch');
/** What is left in trees of an id, under the name the profile allowed or the dot-name of a removal. */
const leftOf = (repo, id = 'cand_001') => (existsSync(treesDir(repo)) ? readdirSync(treesDir(repo)).filter((name) => name.startsWith(`${id}-`) || name.startsWith(`.${id}-`)) : []);

/**
 * Runs `act` with fs.rmSync recording each path under trees it is given, and
 * the names in trees at that moment, before the real rmSync runs. The runner
 * imports rmSync by name, so the builtin's named exports are synced each way.
 */
async function withRemovals(repo, act) {
  const real = fs.rmSync;
  const removals = [];
  fs.rmSync = (path, ...rest) => {
    if (String(path).startsWith(`${treesDir(repo)}/`)) removals.push({ path: String(path), names: readdirSync(treesDir(repo)) });
    return real(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { result: await act(), removals };
  } finally {
    fs.rmSync = real;
    syncBuiltinESMExports();
  }
}

/** Every spawn, the probe included, ran in a candidate's copy and never in the head worktree. */
function assertInCopies(repo, calls) {
  for (const { options } of calls) {
    assert.notEqual(options.cwd, repo.worktree, 'never in the head worktree');
    assertCopyOf(repo, options.cwd);
  }
}

/** The head worktree as the driver made it, with no link the CLI made and no copy left behind. */
function assertHeadUntouched(repo, ids = ['cand_001'], message = 'the head') {
  assert.equal(git(repo.worktree, 'status', '--porcelain', '--ignored'), '', `${message}: nothing changed`);
  const tracked = new Set(git(repo.worktree, 'ls-files').split('\n'));
  // link_paths are single segments, so the top level holds every link the CLI makes; a recursive listing would follow links.
  const links = readdirSync(repo.worktree).filter((path) => lstatSync(join(repo.worktree, path)).isSymbolicLink() && !tracked.has(path));
  assert.deepEqual(links, [], `${message}: no link in it`);
  for (const id of ids) assert.deepEqual(leftOf(repo, id), [], `${message}: the copy of ${id} is gone`);
}

function context(repo, over = {}) {
  return {
    worktree: repo.worktree,
    runDir: repo.runDir,
    clone: repo.clone,
    dataDir: repo.dataDir,
    home: repo.home,
    config: { enabled: true, runners: [RUNNER], linkPaths: [], memoryMb: 1024, cpuSeconds: 60 },
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb',
      GITHUB_TOKEN: 'a-token-value', GH_TOKEN: 'another', ANTHROPIC_API_KEY: 'a-key', REVIEW_VOICE_DATA_DIR: '/data', OTHER: 'x',
    },
    // macOS runs nothing until issue 321, so the runner's rules are shown through the Linux wrapper.
    platform: 'linux',
    execPath: '/opt/node/bin/node',
    ...over,
  };
}

const isProbe = (options) => options.args.at(-1).includes('RV_PROBE_OK');

/** The inner command of the Linux wrapper, unquoted from the last line of its script. */
function innerOf(options) {
  const last = options.args.at(-1).split('\n').at(-1);
  const prefix = "exec unshare --user --map-root-user /bin/sh -c '";
  assert.ok(last.startsWith(prefix) && last.endsWith("'"), last);
  return last.slice(prefix.length, -1).replaceAll("'\\''", "'");
}

/** A layout of a copy as the runner lays one out, for the macOS profile and wrapper that issue 321 builds on. */
function copyLayout(repo, over = {}) {
  const copy = join(treesDir(repo), 'cand_001-AAAAAA', 'tree');
  mkdirSync(copy, { recursive: true });
  return layoutOf(context(repo, { platform: 'darwin', ...over }), { worktree: copy, scratch: scratchBeside(copy) });
}

/**
 * A spawn that passes the probe and answers each reproduction run from `runs`
 * in turn; `onRun` sees the run as it happens, so a test can act as the code
 * under review would.
 */
function fakeSpawn(runs = [], { onRun = () => {}, probe = { status: 0, stdout: 'RV_PROBE_OK\n', stderr: '' }, onProbe = () => {} } = {}) {
  const calls = [];
  const spawn = async (command, options) => {
    calls.push({ command, options });
    if (isProbe(options)) {
      onProbe(options);
      return probe;
    }
    onRun(options);
    const next = runs.shift();
    assert.ok(next !== undefined, 'a run nobody expected');
    return { stdout: '', stderr: '', status: 0, ...next };
  };
  return { spawn, calls, runs: () => calls.filter((call) => !isProbe(call.options)) };
}

const entry = (over = {}, id = 'cand_001') => ({
  candidate_id: id,
  reproduction: { runner: 'node-test', path: 'src/add.repro.test.mjs', content: "console.log('the reproduction')\n", expected: 'add subtracts', ...over },
});
const candidates = (severity = 'important', id = 'cand_001') => new Map([[id, { candidate_id: id, path: 'src/add.mjs', line: 1, severity }]]);

async function runOne(t, runs, over = {}, options = {}) {
  const repo = options.repo ?? scratchRepository(t);
  const fake = fakeSpawn(runs, options);
  const report = await reproduce({ verifications: [entry(options.entry)] }, candidates(options.severity), context(repo, { spawn: fake.spawn, ...over }));
  assertInCopies(repo, fake.calls);
  return { repo, fake, report, record: report.reproductions[0] };
}

const failing = { status: 1, stdout: `# ${MARKER}\nnot ok 1\n` };
const failingSecond = { status: 1, stdout: '# RV_REPRO_REACHED cand_002\nnot ok 1\n' };

// Configuration (AC-1).

function configWith(t, block) {
  const dir = temporary(t);
  const path = join(dir, 'config.yaml');
  writeFileSync(path, JSON.stringify({ reproduction: block }));
  return loadConfig(dir, NO_BASELINE, path);
}

test('the reproduction block is off by default with the stated limits', (t) => {
  const config = configWith(t, {});
  assert.deepEqual(config.reproduction, { enabled: false, runners: [], linkPaths: [], memoryMb: 1024, cpuSeconds: 60 });
  assert.deepEqual(config.warnings, []);
  const dir = temporary(t);
  assert.deepEqual(loadConfig(dir, NO_BASELINE, join(dir, 'absent.yaml')).reproduction.enabled, false);
});

test('a valid block loads whole, with timeout_seconds defaulting to 120', (t) => {
  const config = configWith(t, {
    enabled: true,
    runners: [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs' }, { name: 'py-2', run: 'python -m pytest -q {file}', extension: '.py', timeout_seconds: 600 }],
    link_paths: ['node_modules', '.venv'],
    memory_mb: 64,
    cpu_seconds: 600,
  });
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(config.reproduction, {
    enabled: true,
    runners: [
      { name: 'node-test', run: 'node --test {file}', extension: '.test.mjs', timeoutSeconds: 120 },
      { name: 'py-2', run: 'python -m pytest -q {file}', extension: '.py', timeoutSeconds: 600 },
    ],
    linkPaths: ['node_modules', '.venv'],
    memoryMb: 64,
    cpuSeconds: 600,
  });
});

test('a runner that breaks a rule is dropped with a warning naming it', (t) => {
  const good = { name: 'ok', run: 'node --test {file}', extension: '.test.mjs' };
  const cases = [
    [{ ...good, name: 'Bad_Name' }, 'reproduction.runners[0] (Bad_Name): name must be lower-case letters, digits and dashes; dropping the runner.'],
    [{ ...good, name: '1st' }, 'reproduction.runners[0] (1st): name must be lower-case letters, digits and dashes; dropping the runner.'],
    [{ ...good, run: 'node --test' }, 'reproduction.runners[0] (ok): run must contain {file} exactly once and no other brace placeholder; dropping the runner.'],
    [{ ...good, run: 'node {file} {file}' }, 'reproduction.runners[0] (ok): run must contain {file} exactly once and no other brace placeholder; dropping the runner.'],
    [{ ...good, run: 'node --test {file} {path}' }, 'reproduction.runners[0] (ok): run must contain {file} exactly once and no other brace placeholder; dropping the runner.'],
    [{ ...good, run: 7 }, 'reproduction.runners[0] (ok): run must contain {file} exactly once and no other brace placeholder; dropping the runner.'],
    [{ ...good, extension: 'test.mjs' }, 'reproduction.runners[0] (ok): extension must be a dot and up to 15 letters, digits or dots; dropping the runner.'],
    [{ ...good, extension: '.a/b' }, 'reproduction.runners[0] (ok): extension must be a dot and up to 15 letters, digits or dots; dropping the runner.'],
    [{ ...good, extension: `.${'a'.repeat(16)}` }, 'reproduction.runners[0] (ok): extension must be a dot and up to 15 letters, digits or dots; dropping the runner.'],
    [{ ...good, timeout_seconds: 0 }, 'reproduction.runners[0] (ok): timeout_seconds must be a whole number from 1 to 600; dropping the runner.'],
    [{ ...good, timeout_seconds: 601 }, 'reproduction.runners[0] (ok): timeout_seconds must be a whole number from 1 to 600; dropping the runner.'],
    [{ ...good, timeout_seconds: 1.5 }, 'reproduction.runners[0] (ok): timeout_seconds must be a whole number from 1 to 600; dropping the runner.'],
    ['node --test {file}', 'reproduction.runners[0]: must be a mapping; dropping the runner.'],
  ];
  for (const [runner, warning] of cases) {
    const config = configWith(t, { enabled: true, runners: [runner, { ...good, name: 'kept' }] });
    assert.deepEqual(config.warnings, [warning], JSON.stringify(runner));
    assert.deepEqual(config.reproduction.runners.map((kept) => kept.name), ['kept']);
  }
  const duplicate = configWith(t, { runners: [good, good] });
  assert.deepEqual(duplicate.warnings, ['reproduction.runners[1] (ok): name ok is already used; dropping the runner.']);
});

test('link_paths keeps single segments only, and the limits keep their ranges', (t) => {
  const config = configWith(t, { link_paths: ['node_modules', 'a/b', '.', '..', '', 5, 'node_modules'], memory_mb: 63, cpu_seconds: 0 });
  assert.deepEqual(config.reproduction.linkPaths, ['node_modules']);
  assert.deepEqual(config.warnings, [
    'reproduction.link_paths: "a/b" is not a single path segment; skipping it.',
    'reproduction.link_paths: "." is not a single path segment; skipping it.',
    'reproduction.link_paths: ".." is not a single path segment; skipping it.',
    'reproduction.link_paths: "" is not a single path segment; skipping it.',
    'reproduction.link_paths: 5 is not a single path segment; skipping it.',
    'reproduction.memory_mb must be a whole number from 64 to 16384; using 1024.',
    'reproduction.cpu_seconds must be a whole number from 1 to 600; using 60.',
  ]);
  const high = configWith(t, { memory_mb: 16385, cpu_seconds: 601 });
  assert.deepEqual([high.reproduction.memoryMb, high.reproduction.cpuSeconds], [1024, 60]);
  assert.equal(high.warnings.length, 2);
});

test('a block, a switch or a list of the wrong type warns and keeps the default', (t) => {
  assert.deepEqual(configWith(t, ['enabled']).warnings, ['reproduction must be a mapping; using the defaults.']);
  const config = configWith(t, { enabled: 'yes', runners: 'node-test', link_paths: 'node_modules' });
  assert.equal(config.reproduction.enabled, false);
  assert.deepEqual(config.warnings, [
    'reproduction.enabled must be true or false; using false.',
    'reproduction.runners must be a list; ignoring it.',
    'reproduction.link_paths must be a list; ignoring it.',
  ]);
});

test('the shipped example carries the block, off and empty', () => {
  const example = join(root, 'plugins/review-voice/templates/config.example.yaml');
  const config = loadConfig(root, NO_BASELINE, example);
  assert.deepEqual(config.reproduction, { enabled: false, runners: [], linkPaths: [], memoryMb: 1024, cpuSeconds: 60 });
  assert.match(readFileSync(example, 'utf8'), /#\s+run: node --test \{file\}/);
});

// The command (AC-2), through the bundle.

function cli(repo, args, env = {}) {
  const childEnv = { ...process.env, REVIEW_VOICE_DATA_DIR: repo.dataDir, ...env };
  delete childEnv.REVIEW_VOICE_CONFIG;
  if (env.REVIEW_VOICE_NO_COMMANDS === undefined) delete childEnv.REVIEW_VOICE_NO_COMMANDS;
  return spawnSync(process.execPath, [bundle, ...args], { cwd: repo.clone, env: childEnv, encoding: 'utf8' });
}

/** Written after the repository exists, so a path inside it can go in the configuration; the CLI reads it from the clone. */
function configure(repo, config) {
  mkdirSync(join(repo.clone, '.review-voice'), { recursive: true });
  writeFileSync(join(repo.clone, '.review-voice/config.yaml'), JSON.stringify(config, null, 2));
}

function inputs(repo) {
  const verification = join(repo.runDir, 'verification.json');
  const checked = join(repo.runDir, 'checked.json');
  writeFileSync(verification, JSON.stringify({ verifications: [entry()] }));
  writeFileSync(checked, JSON.stringify({ kept: [{ candidate_id: 'cand_001', path: 'src/add.mjs', line: 1, severity: 'blocking' }] }));
  const out = join(repo.runDir, 'reproductions.json');
  return { out, args: ['reproduce', '--worktree', repo.worktree, '--verification', verification, '--candidates', checked, '--out', out, '--run-dir', repo.runDir] };
}

test('switched off, with no runner, or under REVIEW_VOICE_NO_COMMANDS=1, the skipped report is written and nothing runs', (t) => {
  const cases = [
    [{ enabled: false }, {}, 'reproduction.enabled is false'],
    [{ enabled: true, runners: 'none' }, {}, 'no reproduction runner is configured'],
    [{ enabled: true }, { REVIEW_VOICE_NO_COMMANDS: '1' }, 'REVIEW_VOICE_NO_COMMANDS'],
  ];
  for (const [block, env, skipped] of cases) {
    const repo = scratchRepository(t);
    // No touch marker: a confined run writes only in its copy, which goes with it, so the report and the absent reproductions directory are the proof.
    const runners = block.runners === 'none' ? [] : [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs' }];
    configure(repo, { reproduction: { ...block, runners } });
    const { out, args } = inputs(repo);
    const result = cli(repo, args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { enabled: false, sandbox: null, reproductions: [], skipped });
    assert.equal(existsSync(reproDir(repo)), false, 'nothing was prepared to run');
  }
});

test('reproduce --probe prints the sandbox object and runs no reproduction', (t) => {
  const repo = scratchRepository(t);
  configure(repo, { reproduction: { enabled: true, runners: [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs' }] } });
  const { out, args } = inputs(repo);
  const result = cli(repo, [...args, '--probe']);
  assert.equal(result.status, 0, result.stderr);
  const sandbox = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(sandbox), ['platform', 'mechanism', 'probe']);
  assert.equal(sandbox.platform, process.platform);
  assert.equal(existsSync(out), false, 'no report of reproductions');
  assert.equal(existsSync(join(reproDir(repo), 'cand_001')), false, 'no copy, so nothing was placed');
  // A reproduction leaves trees behind even once its own copy is removed.
  assert.equal(existsSync(treesDir(repo)), false, 'no candidate places were made');
});

test('a missing flag or an unreadable input is exit 2', (t) => {
  const repo = scratchRepository(t, { config: { reproduction: { enabled: true, runners: [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs' }] } } });
  const { args } = inputs(repo);
  assert.equal(cli(repo, args.slice(0, -2)).status, 2);
  const unreadable = [...args];
  unreadable[unreadable.indexOf('--verification') + 1] = join(repo.runDir, 'absent.json');
  assert.equal(cli(repo, unreadable).status, 2);
  const notDir = [...args];
  notDir[notDir.indexOf('--worktree') + 1] = join(repo.runDir, 'absent');
  assert.equal(cli(repo, notDir).status, 2);
});

test('context carries the reproduction switch and runners for the driver', (t) => {
  const runners = [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs', timeout_seconds: 30 }];
  const repo = scratchRepository(t, { config: { reproduction: { enabled: true, runners } } });
  const result = cli(repo, ['context']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).reproduction, {
    enabled: true,
    runners: [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs', timeoutSeconds: 30 }],
  });
});

// The runner through the injected spawn (AC-3). These run on every host.

test('on macOS the probe is none until issue 321, and nothing is spawned or written', async (t) => {
  const repo = scratchRepository(t);
  const off = { platform: 'darwin', mechanism: 'none', probe: 'sandbox-exec is not yet trusted to confine a reproduction (issue #321)' };
  const fake = fakeSpawn([]);
  assert.deepEqual(await probeSandbox(context(repo, { platform: 'darwin', spawn: fake.spawn })), off);
  assert.equal(existsSync(reproDir(repo)), false, 'no profile, probe or canary was written');
  const report = await reproduce({ verifications: [entry()] }, candidates('blocking'), context(repo, { platform: 'darwin', spawn: fake.spawn }));
  assert.deepEqual(report.sandbox, off);
  assert.deepEqual(report.reproductions.map((r) => [r.outcome, r.reason, r.runs.length]), [['did-not-run', `the sandbox probe did not pass: ${off.probe}`, 0]]);
  assert.equal(fake.calls.length, 0, 'not even the probe');
  assert.equal(existsSync(join(reproDir(repo), 'sandbox.sb')), false, 'no profile');
  assertHeadUntouched(repo);
});

test('the macOS wrapper, kept for issue 321, is sandbox-exec with the profile and the ulimit line', (t) => {
  const repo = scratchRepository(t);
  assert.deepEqual(wrapperArgv(copyLayout(repo), "node --test 'src/add.repro.test.mjs'"), [
    '/usr/bin/sandbox-exec', '-f', join(reproDir(repo), 'sandbox.sb'), '/bin/sh', '-c',
    "ulimit -t 60; ulimit -v 1048576 2>/dev/null; ulimit -f 2097152; exec node --test 'src/add.repro.test.mjs'",
  ]);
});

test('on Linux the wrapper is unshare with the listed flags, a read-only root and a second user namespace', async (t) => {
  const given = scratchRepository(t);
  for (const file of ['.netrc', '.npmrc']) writeFileSync(join(given.home, file), 'machine example.com login x\n');
  const { repo, fake, record } = await runOne(t, [failing, failing], { config: { ...context({}).config, memoryMb: 512, cpuSeconds: 30 } }, { repo: given });
  const [call] = fake.runs();
  assert.equal(call.command, 'unshare');
  assert.deepEqual(call.options.args.slice(0, -1), ['--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '--kill-child', '/bin/sh', '-c']);
  const script = call.options.args.at(-1);
  const copy = call.options.cwd;
  const scratch = scratchBeside(copy);
  const inner = "ulimit -t 30; ulimit -v 524288; ulimit -f 2097152; exec node --test 'src/add.repro.test.mjs'";
  assert.ok(script.endsWith(`\ncd ${shellQuote(copy)}\nexec unshare --user --map-root-user /bin/sh -c ${shellQuote(inner)}`), script);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 120000);
  assert.equal(call.options.killSignal, 'SIGKILL');
  assert.equal(call.options.detached, true);
  assert.equal(record.outcome, 'reproduced');
  const stage = join(reproDir(repo), 'stage');
  // The candidate's copy and scratch are held and bound back, never the head worktree.
  assert.ok(!script.includes(shellQuote(repo.worktree)), 'the head worktree is not named');
  for (const line of [
    'set -e',
    `mount -t tmpfs -o mode=0700 rv-stage ${shellQuote(stage)}`,
    `mount --bind ${shellQuote(copy)} ${shellQuote(`${stage}/hold/w`)}`,
    `mount --bind ${shellQuote(scratch)} ${shellQuote(`${stage}/hold/s`)}`,
    `mount --rbind / ${shellQuote(`${stage}/root`)}`,
    `mount --bind ${shellQuote(`${stage}/hold/w`)} ${shellQuote(`${stage}/root${copy}`)}`,
    `mount --bind ${shellQuote(`${stage}/hold/s`)} ${shellQuote(`${stage}/root${scratch}`)}`,
    `mount --bind ${shellQuote(`${stage}/root${copy}/.git`)} ${shellQuote(`${stage}/root${copy}/.git`)}`,
    `ro ${shellQuote(`${stage}/root${copy}/.git`)}`,
    `mount -t proc proc ${shellQuote(`${stage}/root/proc`)}`,
    'umount -l .',
  ]) {
    assert.ok(script.split('\n').includes(line), `missing: ${line}`);
  }
  assert.ok(script.split('\n').some((line) => /^(\/\S+\/)?pivot_root \. \.$/.test(line)), 'pivot_root');
  assert.match(script, /mount -o "remount,bind,ro\$o" "\$p"/);
  // On a Linux host the temporary directory is itself covered, and what lies inside it goes with it.
  const covers = script.split('\n').map((line) => /^mount -t tmpfs -o mode=0755 rv-hidden '(.*)'$/.exec(line)?.[1]).filter(Boolean).map((path) => path.slice(`${stage}/root`.length));
  const covered = (path) => covers.find((cover) => path === cover || path.startsWith(`${cover}/`));
  // Where Unix sockets live, since a read-only mount still lets one connect.
  const sockets = ['/tmp', '/run', '/var/run'].filter((path) => existsSync(path)).map((path) => realpathSync(path));
  for (const hidden of [repo.dataDir, join(repo.home, '.ssh'), ...sockets]) {
    const cover = covered(hidden);
    assert.ok(cover !== undefined, `${hidden} is covered`);
    assert.ok(script.includes(`mount -o remount,bind,ro ${shellQuote(`${stage}/root${cover}`)}`), `${cover} is read-only`);
  }
  assert.ok(script.includes(`mkdir -p ${shellQuote(`${stage}/root${copy}`)}`), 'the copy has a place in its cover');
  const bound = (file) => script.split('\n').includes(`mount --bind /dev/null ${shellQuote(`${stage}/root${file}`)}`);
  for (const file of ['.netrc', '.npmrc'].map((name) => join(repo.home, name))) assert.ok(bound(file) || covered(file) !== undefined, `${file} is hidden`);
  // On a Linux host the temporary directory already covers these files, so the file branch is shown on its own too.
  const netrc = join(repo.home, '.netrc');
  const alone = linuxSetup({ ...layoutOf(context(repo, { platform: 'linux' })), hiddenDirs: [], hiddenFiles: [netrc, join(repo.home, '.git-credentials')] }).split('\n');
  assert.ok(alone.includes(`mount --bind /dev/null ${shellQuote(`${stage}/root${netrc}`)}`), 'an existing credential file is covered by /dev/null');
  assert.ok(!alone.some((line) => line.includes('.git-credentials')), 'one that does not exist needs no cover');
});

test('a reproduction gets only the allowlisted environment, with no token and no REVIEW_VOICE_* variable', async (t) => {
  // The whole ambient environment and more, so an allowlist that grows by any name, or loses LC_ALL, is seen.
  const env = {
    ...process.env, ...context({}).env, LC_ALL: 'C', USER: 'someone', SSH_AUTH_SOCK: '/agent.sock', NPM_TOKEN: 'npm-token', AWS_SECRET_ACCESS_KEY: 'aws-secret', GITHUB_ACTIONS: 'true',
  };
  const { repo, fake } = await runOne(t, [failing, failing], { env });
  // The candidate's own scratch, the probe's included, since the probe runs with the first candidate's layout.
  const scratch = scratchBeside(fake.calls[0].options.cwd);
  const expected = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'dumb', HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'), CI: '1', NO_COLOR: '1' };
  for (const call of fake.calls) assert.deepEqual(call.options.env, expected);
  assert.equal(fake.calls.length, 3, 'the probe and two runs');
});

test('the wall-clock limit of a run is its runner timeout_seconds', async (t) => {
  const config = { ...context({}).config, runners: [{ ...RUNNER, timeoutSeconds: 7 }] };
  const timeout = Object.assign(new Error('spawn /usr/bin/sandbox-exec ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const { fake, record } = await runOne(t, [{ status: null, error: timeout }], { config });
  assert.equal(fake.runs()[0].options.timeout, 7000);
  assert.deepEqual([record.outcome, record.reason], ['did-not-run', 'timed out after 7s']);
});

test('{file} is replaced once with the single-quoted path and nothing else reaches the command', async (t) => {
  const runner = { ...RUNNER, run: 'node --test --test-name-pattern=x {file}' };
  const { fake } = await runOne(t, [{ status: 0 }], { config: { ...context({}).config, runners: [runner] } }, { entry: { content: '$(touch /tmp/rv-bad)', expected: "it's `bad`" } });
  const inner = innerOf(fake.runs()[0].options);
  assert.ok(inner.endsWith("exec node --test --test-name-pattern=x 'src/add.repro.test.mjs'"), inner);
  const script = fake.runs()[0].options.args.join(' ');
  assert.ok(!script.includes('rv-bad') && !script.includes('bad`'));
});

test('two failing runs that reach the marker are reproduced', async (t) => {
  const { repo, record, fake } = await runOne(t, [failing, { status: 2, stdout: '', stderr: `${MARKER}\n` }]);
  assert.equal(record.outcome, 'reproduced');
  assert.equal(record.reason, undefined);
  assert.deepEqual(record.runs.map((run) => [run.exitCode, run.reached]), [[1, true], [2, true]]);
  assert.equal(fake.runs().length, 2);
  assert.equal(record.copy, join(reproDir(repo), 'cand_001', 'add.repro.test.mjs'));
  assert.equal(readFileSync(record.copy, 'utf8'), "console.log('the reproduction')\n");
  assert.deepEqual([record.candidateId, record.path, record.line, record.runner, record.file, record.expected], ['cand_001', 'src/add.mjs', 1, 'node-test', 'src/add.repro.test.mjs', 'add subtracts']);
  // The copy and its scratch go after the last run, and the kept copy of the file stays outside them.
  assertHeadUntouched(repo);
  assert.equal(existsSync(treesDir(repo)), true);
});

test('run 1 exiting 0, marker or not, is did-not-fail with no second run', async (t) => {
  for (const stdout of ['', `${MARKER}\n`]) {
    const { record, fake } = await runOne(t, [{ status: 0, stdout }]);
    assert.equal(record.outcome, 'did-not-fail');
    assert.equal(record.reason, 'run 1 exited 0');
    assert.equal(fake.runs().length, 1);
  }
});

test('a pass on run 2 is did-not-fail as flaky', async (t) => {
  const { record } = await runOne(t, [{ ...failing, status: 3 }, { status: 0 }]);
  assert.equal(record.outcome, 'did-not-fail');
  assert.equal(record.reason, 'flaky: run 1 exited 3, run 2 exited 0');
  assert.equal(record.runs.length, 2);
});

test('a run that fails before the marker, cannot start, times out or overflows is did-not-run', async (t) => {
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const cases = [
    [{ status: 1, stdout: 'Cannot find module\n' }, 'exited 1 before reaching its assertion'],
    [{ status: 1, stdout: 'RV_REPRO_REACHED cand_002\n' }, 'exited 1 before reaching its assertion'],
    [{ status: null, stdout: MARKER, error: failure('ETIMEDOUT', 'spawn unshare ETIMEDOUT') }, 'timed out after 120s'],
    [{ status: null, stdout: MARKER, error: failure('ENOBUFS', 'spawn unshare ENOBUFS') }, 'killed at the output cap'],
    [{ status: null, error: failure('ENOENT', 'spawn /usr/bin/sandbox-exec ENOENT') }, 'could not start: spawn /usr/bin/sandbox-exec ENOENT'],
    [{ status: 127, stdout: MARKER }, 'not found or not executable (exit 127)'],
    [{ status: 126, stdout: MARKER }, 'not found or not executable (exit 126)'],
    [{ status: null, stdout: MARKER }, 'ended by a signal'],
  ];
  for (const [run, reason] of cases) {
    const { record, fake } = await runOne(t, [run]);
    assert.deepEqual([record.outcome, record.reason], ['did-not-run', reason], JSON.stringify(run));
    assert.equal(fake.runs().length, 1, 'no second run');
  }
});

test('run 2 in a did-not-run state makes the record did-not-run with its reason', async (t) => {
  const timeout = Object.assign(new Error('spawn unshare ETIMEDOUT'), { code: 'ETIMEDOUT' });
  for (const [second, reason] of [[{ status: null, error: timeout }, 'timed out after 120s'], [{ status: 1, stdout: 'crash\n' }, 'exited 1 before reaching its assertion']]) {
    const { record } = await runOne(t, [failing, second]);
    assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', reason, 2]);
  }
});

test('the marker counts after a leading # and whitespace, and only exactly for its own candidate', async (t) => {
  const cases = [
    [`# ${MARKER}`, true],
    [` ##\t ${MARKER}\r`, true],
    [`${MARKER}0`, false],
    [`x ${MARKER}`, false],
    [`${MARKER} and more`, false],
  ];
  for (const [line, reached] of cases) {
    const { record } = await runOne(t, [{ status: 1, stdout: `ok\n${line}\n` }, { status: 1, stdout: `${MARKER}\n` }]);
    assert.equal(record.runs[0].reached, reached, line);
    assert.equal(record.outcome, reached ? 'reproduced' : 'did-not-run', line);
  }
});

test('output is stdout then stderr, redacted, and capped at 8 KiB with the first bytes kept', async (t) => {
  const token = `ghp_${'A1b2C3d4'.repeat(3)}`;
  const { record } = await runOne(t, [{ status: 0, stdout: `first\n${token}\n${'é'.repeat(10000)}`, stderr: 'the end' }]);
  const output = record.runs[0].output;
  assert.ok(output.startsWith('first\n[REDACTED:GITHUB_TOKEN]\n'), output.slice(0, 60));
  assert.ok(!output.includes(token));
  assert.ok(Buffer.byteLength(output) <= 8192 && Buffer.byteLength(output) > 8180, String(Buffer.byteLength(output)));
  assert.ok(!output.includes('�'), 'no character is split');
  const { record: short } = await runOne(t, [{ status: 0, stdout: 'out', stderr: 'err' }]);
  assert.equal(short.runs[0].output, 'out\nerr');
});

test('a run that modifies its copy is did-not-run, an ignored file included, and the head worktree never changes', async (t) => {
  // The walk counts every entry, so a nested repository is each of its files.
  const nested = (wt) => readdirSync(join(wt, 'nested'), { recursive: true }).length + 1;
  for (const [touch, count] of [
    [(wt) => writeFileSync(join(wt, 'debug.log'), 'ignored by the head'), () => 1],
    [(wt) => writeFileSync(join(wt, 'src/add.mjs'), 'export const add = (a, b) => a + b;\n'), () => 1],
    // A directory keeps its inode through a chmod, and its times are left out, so only its mode shows this.
    [(wt) => chmodSync(join(wt, 'src'), 0o700), () => 1],
    [(wt) => git(wt, 'init', '-q', 'nested'), nested],
  ]) {
    const repo = scratchRepository(t);
    let paths;
    const { record } = await runOne(t, [failing, failing], {}, { repo, onRun: (options) => {
      touch(options.cwd);
      paths = count(options.cwd);
    } });
    assert.equal(record.outcome, 'did-not-run');
    assert.equal(record.reason, `the reproduction modified the worktree (${paths} paths)`);
    assert.equal(record.runs.length, 1, 'no further run in that copy');
    assertHeadUntouched(repo);
  }
});

test('a run that changes its own file is did-not-run, since the baseline is taken after the write', async (t) => {
  const repo = scratchRepository(t);
  const { record } = await runOne(t, [failing, failing], {}, { repo, onRun: (options) => writeFileSync(join(options.cwd, 'src/add.repro.test.mjs'), 'rewritten\n') });
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'the reproduction modified the worktree (1 paths)', 1]);
  assertHeadUntouched(repo);
});

test('the file is written once before run 1, and run 2 meets the same file, never removed or rewritten', async (t) => {
  const repo = scratchRepository(t);
  const seen = [];
  const onRun = (options) => {
    const file = join(options.cwd, 'src/add.repro.test.mjs');
    const stat = lstatSync(file, { bigint: true });
    seen.push([stat.ino, stat.ctimeNs, readFileSync(file, 'utf8')]);
  };
  const { record } = await runOne(t, [failing, failing], {}, { repo, onRun });
  assert.deepEqual([record.outcome, record.runs.length], ['reproduced', 2], record.reason);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], seen[0], 'the same inode and ctime in both runs');
  assert.equal(seen[0][2], "console.log('the reproduction')\n");
  assertHeadUntouched(repo);
});

test('a run that changes a path already untracked, ignored or modified before it is did-not-run', async (t) => {
  // What earlier static checks leave in the head worktree, which git names the same whatever is in it.
  const existing = (wt) => {
    writeFileSync(join(wt, 'junit.xml'), 'before');
    writeFileSync(join(wt, 'debug.log'), 'before');
    mkdirSync(join(wt, 'coverage'));
    writeFileSync(join(wt, '.gitignore'), '*.log\nnode_modules\ncoverage/\n');
    writeFileSync(join(wt, 'coverage/lcov.info'), 'before');
  };
  const contents = (wt) => ['junit.xml', 'debug.log', '.gitignore', 'coverage/lcov.info', 'coverage/planted.js'].map((path) => (existsSync(join(wt, path)) ? readFileSync(join(wt, path), 'utf8') : null));
  const cases = [
    ['an untracked file rewritten', (wt) => writeFileSync(join(wt, 'junit.xml'), 'planted')],
    ['an ignored file rewritten', (wt) => writeFileSync(join(wt, 'debug.log'), 'planted')],
    ['a file added in an ignored directory', (wt) => writeFileSync(join(wt, 'coverage/planted.js'), 'planted')],
    ['a file in an ignored directory rewritten', (wt) => writeFileSync(join(wt, 'coverage/lcov.info'), 'planted')],
    ['a modified tracked file rewritten', (wt) => writeFileSync(join(wt, '.gitignore'), '*.log\nnode_modules\ncoverage/\n# planted\n')],
  ];
  for (const [name, act] of cases) {
    const repo = scratchRepository(t);
    existing(repo.worktree);
    const status = git(repo.worktree, 'status', '--porcelain', '--ignored');
    const was = contents(repo.worktree);
    const { record } = await runOne(t, [failing, failing], {}, { repo, onRun: (options) => act(options.cwd) });
    assert.equal(record.outcome, 'did-not-run', name);
    assert.equal(record.reason, 'the reproduction modified the worktree (1 paths)', name);
    assert.equal(record.runs.length, 1, name);
    assert.deepEqual(contents(repo.worktree), was, `${name}: the head is as it was`);
    assert.equal(git(repo.worktree, 'status', '--porcelain', '--ignored'), status, name);
    assert.deepEqual(leftOf(repo), [], `${name}: the copy is gone`);
  }
  // A copy carrying the same state with nothing changed by the run still reproduces, the CLI's own file in an ignored directory included.
  const repo = scratchRepository(t);
  existing(repo.worktree);
  const quiet = await runOne(t, [failing, failing], {}, { repo, entry: { path: 'coverage/add.repro.test.mjs' } });
  assert.deepEqual([quiet.record.outcome, quiet.record.reason, quiet.record.runs.length], ['reproduced', undefined, 2]);
  assert.equal(readFileSync(join(repo.worktree, 'junit.xml'), 'utf8'), 'before', 'nothing it had is cleared');
  assert.equal(existsSync(join(repo.worktree, 'coverage/add.repro.test.mjs')), false);
});

test('a same-size rewrite of an ignored file with its times put back is did-not-run', async (t) => {
  const repo = scratchRepository(t);
  writeFileSync(join(repo.worktree, 'debug.log'), 'same\n');
  // Whole seconds, set in the copy before the run is judged, so the times put back are exactly the times taken before.
  const onProbe = (options) => utimesSync(join(options.cwd, 'debug.log'), 1_000_000, 1_000_000);
  const onRun = (options) => {
    const log = join(options.cwd, 'debug.log');
    writeFileSync(log, 'evil\n');
    utimesSync(log, 1_000_000, 1_000_000);
  };
  const { record } = await runOne(t, [failing, failing], {}, { repo, onRun, onProbe });
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'the reproduction modified the worktree (1 paths)', 1]);
  assert.equal(readFileSync(join(repo.worktree, 'debug.log'), 'utf8'), 'same\n');
  assert.deepEqual(leftOf(repo), []);
});

test('a name that is not UTF-8 is an entry of its own, never read as the sibling it decodes to', async (t) => {
  // The byte 0xff decodes to U+FFFD, which the tracked sibling already ends in.
  const named = (dir) => Buffer.concat([Buffer.from(join(dir, 'src/x')), Buffer.from([0xff])]);
  const probe = temporary(t);
  mkdirSync(join(probe, 'src'));
  try {
    writeFileSync(named(probe), '');
  } catch (error) {
    t.skip(`this filesystem refuses a name that is not UTF-8 (${error.code}), so no run can make one`);
    return;
  }
  const repo = scratchRepository(t, { files: { 'src/x\uFFFD': 'tracked\n' } });
  const { record } = await runOne(t, [failing, failing], {}, { repo, onRun: (options) => writeFileSync(named(options.cwd), 'planted\n') });
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'the reproduction modified the worktree (1 paths)', 1]);
  assertHeadUntouched(repo);
});

test('a run that exits 0, or a second run, that modifies its copy is did-not-run', async (t) => {
  const plant = (options) => writeFileSync(join(options.cwd, 'src/add.mjs'), 'planted\n');
  const cases = [
    ['run 1 exits 0', [{ status: 0, stdout: `${MARKER}\n` }], () => true, 1],
    ['run 2 fails again', [failing, failing], (call) => call === 2, 2],
  ];
  for (const [name, runs, plants, count] of cases) {
    const repo = scratchRepository(t);
    let call = 0;
    const { record } = await runOne(t, runs, {}, { repo, onRun: (options) => plants(++call) && plant(options) });
    assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'the reproduction modified the worktree (1 paths)', count], name);
    assert.equal(readFileSync(join(repo.worktree, 'src/add.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n', name);
    assertHeadUntouched(repo, ['cand_001'], name);
  }
});

test('a run that locks a directory of its copy against the walk is did-not-run, keeps its run and copy, and its copy is still removed', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root passes a directory whatever its mode');
    return;
  }
  const repo = scratchRepository(t);
  const { record } = await runOne(t, [failing, failing], {}, { repo, onRun: (options) => chmodSync(join(options.cwd, 'src'), 0) });
  assert.deepEqual([record.outcome, record.reason], ['did-not-run', 'the reproduction modified the worktree (walk failed: EACCES)']);
  assert.equal(record.runs.length, 1);
  assert.equal(record.copy, join(reproDir(repo), 'cand_001', 'add.repro.test.mjs'));
  // Removed only because the directory is made usable again first.
  assertHeadUntouched(repo);
});

test('a change to the copy after run 1 is checked is did-not-run, and run 2 never starts', async (t) => {
  const cases = [
    ['plant', (cwd) => writeFileSync(join(cwd, 'src/add.mjs'), 'export const add = (a, b) => a + b;\n'), 1],
    // Before the write-once file, a link in place of its directory would have sent the CLI write out of the copy; now it is a change like any other.
    ['swap', (cwd, outside) => {
      renameSync(join(cwd, 'src'), join(cwd, 'src.bak'));
      symlinkSync(outside, join(cwd, 'src'));
    }, 6],
  ];
  for (const [name, act, paths] of cases) {
    const repo = scratchRepository(t);
    const outside = temporary(t);
    const calls = [];
    // The result's error is read only once the run is judged, which is just after the check of run 1, where a process run 1 left behind would act.
    const spawn = async (command, options) => {
      calls.push({ command, options });
      if (isProbe(options)) return { status: 0, stdout: 'RV_PROBE_OK\n', stderr: '' };
      let acted = false;
      return {
        status: 1, stdout: `# ${MARKER}\n`, stderr: '',
        get error() {
          if (!acted) act(options.cwd, outside);
          acted = true;
          return undefined;
        },
      };
    };
    const report = await reproduce({ verifications: [entry()] }, candidates(), context(repo, { spawn }));
    assertInCopies(repo, calls);
    const [record] = report.reproductions;
    assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', `the reproduction modified the worktree (${paths} paths)`, 1], name);
    assert.equal(calls.filter((call) => !isProbe(call.options)).length, 1, `${name}: no run in a copy changed after its check`);
    assert.deepEqual(readdirSync(outside), [], `${name}: nothing was written through the link`);
    assertHeadUntouched(repo, ['cand_001'], name);
  }
});

test('a copy the CLI cannot remove is named on stderr and the report is whole', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root removes an entry whatever its directory allows');
    return;
  }
  const repo = scratchRepository(t);
  let call = 0;
  // The directory holding the copies, which no reproduction can write, stands in for any removal that fails.
  const onRun = () => {
    if (++call === 2) chmodSync(treesDir(repo), 0o555);
  };
  const errors = t.mock.method(console, 'error', () => undefined);
  let report;
  let removals;
  try {
    ({ result: { report }, removals } = await withRemovals(repo, () => runOne(t, [failing, failing], {}, { repo, onRun })));
  } finally {
    chmodSync(treesDir(repo), 0o755);
  }
  assert.deepEqual(report.reproductions.map((r) => [r.outcome, r.reason, r.runs.length]), [['reproduced', undefined, 2]]);
  const named = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(named.some((line) => new RegExp(`^reproduce: could not remove ${placesPattern(repo, 'cand_001')}: `).test(line)), named.join('\n'));
  // The rename failed, so the directory is left in place under its own name rather than walked while a process left behind may write it.
  assert.deepEqual(removals, [], 'the delete never ran');
  const left = leftOf(repo);
  assert.equal(left.length, 1, left.join(', '));
  assert.match(left[0], /^cand_001-[A-Za-z0-9]{6}$/);
  assert.ok(existsSync(join(treesDir(repo), left[0], 'tree', 'src/add.mjs')), 'the copy is whole');
  assert.equal(git(repo.worktree, 'status', '--porcelain', '--ignored'), '');
});

test('a copy is renamed to a name no profile allows before the delete walks it', async (t) => {
  if (process.platform !== 'darwin' || process.getuid?.() === 0) {
    t.skip('needs a user-immutable file, which only macOS gives its owner (chflags uchg), to make the delete fail inside the copy');
    return;
  }
  const repo = scratchRepository(t);
  // A file the delete cannot unlink makes it fail inside the directory, so its error names the path it walked.
  const onRun = (options) => {
    writeFileSync(join(options.cwd, 'locked.log'), 'x');
    execFileSync('/usr/bin/chflags', ['uchg', join(options.cwd, 'locked.log')]);
  };
  const errors = t.mock.method(console, 'error', () => undefined);
  let record;
  try {
    ({ record } = await runOne(t, [failing], {}, { repo, onRun }));
  } finally {
    for (const name of existsSync(treesDir(repo)) ? readdirSync(treesDir(repo)) : []) execFileSync('/usr/bin/chflags', ['-R', 'nouchg', join(treesDir(repo), name)]);
  }
  assert.equal(record.outcome, 'did-not-run');
  const named = errors.mock.calls.map((c) => String(c.arguments[0]));
  const prefix = `reproduce: could not remove ${escaped(treesDir(repo))}/\\.cand_001-[A-Za-z0-9]{6}-`;
  assert.ok(named.some((line) => new RegExp(`^${prefix}[0-9a-f]{8}: `).test(line)), named.join('\n'));
  assert.deepEqual(readdirSync(treesDir(repo)).filter((name) => name.startsWith('cand_001-')), [], 'nothing is left at the name the profile allowed');
  assert.equal(git(repo.worktree, 'status', '--porcelain', '--ignored'), '');
});

test('on every host the delete is given the dot-name, once nothing is left at the name the profile allowed', async (t) => {
  const repo = scratchRepository(t);
  const { result: { record }, removals } = await withRemovals(repo, () => runOne(t, [failing, failing], {}, { repo }));
  assert.equal(record.outcome, 'reproduced', record.reason);
  assert.equal(removals.length, 1, removals.map((removal) => removal.path).join(', '));
  assert.match(removals[0].path, new RegExp(`^${escaped(treesDir(repo))}/\\.cand_001-[A-Za-z0-9]{6}-[0-9a-f]{8}$`));
  assert.deepEqual(removals[0].names.filter((name) => name.startsWith('cand_001-')), [], 'renamed before the delete starts');
  assertHeadUntouched(repo);
});

test('no git runs in a copy once a run has, and every git call before carries the pinned --git-dir and --work-tree', async (t) => {
  const repo = scratchRepository(t);
  const events = [];
  const recorder = (args, cwd) => {
    events.push({ git: args });
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const { record, fake } = await runOne(t, [failing, failing], { git: recorder }, { repo, onRun: () => events.push({ run: true }) });
  assert.equal(record.outcome, 'reproduced', record.reason);
  const firstRun = events.findIndex((event) => event.run === true);
  assert.ok(firstRun > 0, 'the runs happened, after git');
  assert.deepEqual(events.slice(firstRun), [{ run: true }, { run: true }], 'nothing but the runs from the first run on');
  const calls = events.filter((event) => event.git !== undefined).map((event) => event.git);
  // The copy's .git names the head's git directory, so git reads the head's index against the copy.
  const gitDir = realpathSync(join(repo.clone, '.git/worktrees/head'));
  const copy = fake.runs()[0].options.cwd;
  const resolving = calls.filter((args) => args[0] === 'rev-parse');
  const pinned = calls.filter((args) => args[0] !== 'rev-parse');
  assert.equal(resolving.length, 2, 'the clone and the copy are each resolved once, before any run');
  assert.deepEqual(pinned.map((args) => args[2]), ['ls-files'], 'the placement rule only');
  for (const args of pinned) assert.deepEqual(args.slice(0, 2), [`--git-dir=${gitDir}`, `--work-tree=${copy}`], args.join(' '));
});

test('the CLI git runs with GIT_OPTIONAL_LOCKS=0 and never rewrites the head index', async (t) => {
  const repo = scratchRepository(t);
  const index = join(repo.clone, '.git/worktrees/head/index');
  const before = readFileSync(index);
  // A git first on PATH that logs the variable as the CLI's own git passes it, then runs the real git.
  const shim = temporary(t);
  const log = join(shim, 'log');
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "\${GIT_OPTIONAL_LOCKS-unset}" >> ${shellQuote(log)}\nexec ${shellQuote(real)} "$@"\n`);
  chmodSync(join(shim, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${shim}:${path}`;
  let record;
  try {
    ({ record } = await runOne(t, [failing, failing], {}, { repo }));
  } finally {
    process.env.PATH = path;
  }
  assert.equal(record.outcome, 'reproduced', record.reason);
  // No call left takes the optional lock, so the variable is what keeps a git status a later change adds off the head index.
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['0', '0', '0'], 'the clone and copy resolved, and the placement rule, each with the variable');
  assert.ok(readFileSync(index).equals(before), 'the index is byte for byte as it was, though every file in the copy is new to it');
});

test('the profile, kept for issue 321, allows writes only in the copy and its scratch directory, and hides the store and credentials', (t) => {
  const repo = scratchRepository(t);
  const layout = copyLayout(repo);
  const profile = sandboxProfile(layout);
  const lines = profile.split('\n');
  const copy = layout.worktree;
  const scratch = layout.scratch;
  assert.deepEqual(lines.slice(0, 6), ['(version 1)', '(allow default)', '(deny network*)', '(deny signal)', '(allow signal (target same-sandbox))', '(deny file-write*)']);
  assert.deepEqual(lines.filter((line) => line.startsWith('(allow file-write*')), [`(allow file-write* (subpath "${copy}") (subpath "${scratch}") (literal "/dev/null"))`]);
  assert.ok(!profile.includes(`"${repo.worktree}"`), 'the head worktree is in no rule, so it is never writable');
  // Later rules win, so each deny inside the copy must come after the rule allowing writes there.
  const allowWrite = lines.findIndex((line) => line.startsWith('(allow file-write*'));
  for (const rule of [`(deny file-write* (literal "${copy}/.git"))`, '(deny file-write-flags)']) {
    assert.ok(lines.indexOf(rule) > allowWrite, `${rule} follows the allow`);
  }
  // cfprefsd would otherwise write a preference domain outside the copy for a reproduction.
  assert.ok(lines.includes('(deny user-preference-write)'), 'no preference write');
  const denied = lines.find((line) => line.startsWith('(deny file-read*'));
  const credentials = ['.ssh', '.gnupg', '.aws', '.config/gh', 'Library/Keychains'].map((dir) => join(repo.home, dir));
  for (const hidden of [repo.dataDir, repo.runDir, join(repo.clone, '.git'), ...credentials]) assert.ok(denied.includes(`(subpath "${hidden}")`), hidden);
  for (const file of ['.netrc', '.npmrc', '.git-credentials']) assert.ok(denied.includes(`(literal "${join(repo.home, file)}")`), file);
  assert.ok(lines.includes(`(allow file-read* (subpath "${copy}") (subpath "${scratch}"))`));
  const metadata = lines.find((line) => line.startsWith('(allow file-read-metadata'));
  assert.ok(metadata.includes(`(literal "${repo.dataDir}")`) && !metadata.includes('(subpath'), 'only the parents themselves');
  const quoted = sandboxProfile({ ...layoutOf(context(repo, { platform: 'darwin' })), worktree: '/a"b\\c', links: [] });
  assert.ok(quoted.includes('(subpath "/a\\"b\\\\c")'), 'a path cannot close its string');
});

test('the profile denies every signal and then allows one only within the same sandbox', (t) => {
  const repo = scratchRepository(t);
  const lines = sandboxProfile(copyLayout(repo)).split('\n');
  const rules = lines.filter((line) => line.includes('signal'));
  // Later rules win, so the allow must follow the deny for a reproduction to signal its own children and nothing else.
  assert.deepEqual(rules, ['(deny signal)', '(allow signal (target same-sandbox))']);
  assert.equal(lines.indexOf('(allow signal (target same-sandbox))'), lines.indexOf('(deny signal)') + 1);
});

test('link_paths are linked into the copy before the first run, read-only to it, and never into the head', async (t) => {
  const repo = scratchRepository(t);
  mkdirSync(join(repo.clone, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(repo.clone, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  const target = realpathSync(join(repo.clone, 'node_modules'));
  const config = { ...context(repo).config, linkPaths: ['node_modules', '.venv'] };
  const seen = [];
  const onRun = (options) => {
    const at = join(options.cwd, 'node_modules');
    seen.push([lstatSync(at).isSymbolicLink(), readlinkSync(at), existsSync(join(options.cwd, '.venv')), lstatSync(join(repo.worktree, 'node_modules'), { throwIfNoEntry: false }) === undefined]);
  };
  const { record, fake } = await runOne(t, [failing, failing], { config }, { repo, onRun });
  assert.equal(record.outcome, 'reproduced', record.reason);
  assert.deepEqual(seen, [[true, target, false, true], [true, target, false, true]]);
  assertHeadUntouched(repo);
  const script = fake.runs()[0].options.args.at(-1);
  const stage = join(reproDir(repo), 'stage');
  assert.ok(script.includes(`mount --bind ${shellQuote(target)} ${shellQuote(`${stage}/hold/l0`)}`));
  assert.ok(script.includes(`ro ${shellQuote(`${stage}/root${target}`)}`), 'the target is bound back read-only');
  // The macOS profile issue 321 builds on.
  const layout = copyLayout(repo, { config });
  const profile = sandboxProfile(layout).split('\n');
  const [copy, scratch] = [layout.worktree, layout.scratch];
  assert.ok(profile.includes(`(allow file-read* (subpath "${copy}") (subpath "${scratch}") (subpath "${target}"))`));
  // Readable by name, never writable, so a run cannot plant a module in the clone.
  assert.deepEqual(profile.filter((line) => line.startsWith('(allow file-write*')), [`(allow file-write* (subpath "${copy}") (subpath "${scratch}") (literal "/dev/null"))`]);
  assert.ok(!profile.some((line) => line.startsWith('(allow file-write') && line.includes(target)), 'no write rule names the target');
});

test('a path failing a placement rule is refused with its rule, and nothing is spawned', async (t) => {
  const outside = temporary(t);
  const repo = scratchRepository(t, { files: { 'src/old.test.mjs': 'tracked\n', 'src/gone.test.mjs': 'tracked\n' }, links: { out: outside } });
  // A tracked absolute link to the head worktree, which the copy keeps as it is, so it leads out of the copy.
  symlinkSync(join(repo.worktree, 'src'), join(repo.clone, 'into'));
  git(repo.clone, 'add', '-A');
  git(repo.clone, 'commit', '-q', '-m', 'into the head');
  git(repo.worktree, 'checkout', '-q', '--detach', git(repo.clone, 'rev-parse', 'HEAD'));
  unlinkSync(join(repo.worktree, 'src/gone.test.mjs'));
  writeFileSync(join(repo.worktree, 'src/here.test.mjs'), 'untracked\n');
  const cases = [
    [`${repo.worktree}/src/a.test.mjs`, 'not a relative path'],
    ["src/it's.test.mjs", 'only letters, digits, ., _, - and / are allowed'],
    ['src/a b.test.mjs', 'only letters, digits, ., _, - and / are allowed'],
    ['src\\a.test.mjs', 'only letters, digits, ., _, - and / are allowed'],
    ['src/../a.test.mjs', 'an empty or .. segment'],
    ['src//a.test.mjs', 'an empty or .. segment'],
    ['src/a.spec.js', 'does not end with .test.mjs'],
    ['node_modules/a.test.mjs', 'under the link path node_modules'],
    ['missing/a.test.mjs', 'its directory does not exist in the worktree'],
    ['out/a.test.mjs', 'its directory resolves outside the worktree'],
    ['into/a.test.mjs', 'its directory resolves outside the worktree'],
    ['src/old.test.mjs', 'a file of that name is already there'],
    ['src/here.test.mjs', 'a file of that name is already there'],
    ['src/gone.test.mjs', 'the path is tracked at the head'],
  ];
  const config = { ...context(repo).config, linkPaths: ['node_modules'] };
  for (const [path, rule] of cases) {
    const { record, fake } = await runOne(t, [], { config }, { repo, entry: { path } });
    assert.deepEqual([record.outcome, record.reason], ['did-not-run', `path refused: ${rule}`], path);
    assert.equal(fake.calls.length, 0, `${path}: nothing spawned, not even the probe`);
    assert.deepEqual(leftOf(repo), [], `${path}: the copy made for the check is removed`);
  }
  assert.deepEqual(readFileSync(join(repo.worktree, 'src/here.test.mjs'), 'utf8'), 'untracked\n');
  assert.equal(existsSync(join(outside, 'a.test.mjs')), false);
  assert.equal(existsSync(join(repo.worktree, 'src/a.test.mjs')), false);
});

test('only blocking and important candidates run, through a configured runner, on a linked worktree', async (t) => {
  for (const severity of ['minor', 'nit', 'question']) {
    const { record, fake } = await runOne(t, [], {}, { severity });
    assert.deepEqual([record.outcome, record.reason], ['did-not-run', `tier ${severity}: reproductions run for blocking and important findings only`]);
    assert.equal(fake.calls.length, 0);
  }
  const blocking = await runOne(t, [failing, failing], {}, { severity: 'blocking' });
  assert.equal(blocking.record.outcome, 'reproduced');
  const unknown = await runOne(t, [], {}, { entry: { runner: 'pytest' } });
  assert.deepEqual([unknown.record.reason, unknown.fake.calls.length], ['runner pytest is not configured', 0]);
  const repo = scratchRepository(t);
  const standalone = join(repo.dir, 'standalone');
  mkdirSync(join(standalone, 'src'), { recursive: true });
  git(standalone, 'init', '-q');
  const plain = await runOne(t, [], { worktree: standalone }, { repo });
  assert.deepEqual([plain.record.reason, plain.fake.calls.length], ['the worktree is not a linked git worktree (its .git is not a file)', 0]);
  assert.deepEqual(leftOf(repo), [], 'its copy is removed');
  const fake = fakeSpawn([]);
  const none = await reproduce({ verifications: [entry({}, 'cand_009'), { candidate_id: 'cand_001' }] }, candidates(), context(repo, { spawn: fake.spawn }));
  assert.deepEqual(none.reproductions.map((r) => [r.candidateId, r.reason]), [['cand_009', 'no candidate with this id in --candidates']]);
  assert.equal(fake.calls.length, 0);
});

test('a probe that fails runs nothing, names the reason, and is run once', async (t) => {
  const repo = scratchRepository(t);
  const fake = fakeSpawn([], { probe: { status: 1, stdout: '', stderr: 'unshare: unshare failed: Operation not permitted\n' } });
  const report = await reproduce(
    { verifications: [entry(), entry({ path: 'src/two.test.mjs' }, 'cand_002')] },
    new Map([...candidates(), ...candidates('blocking', 'cand_002')]),
    context(repo, { spawn: fake.spawn, platform: 'linux' }),
  );
  assert.deepEqual(report.sandbox, { platform: 'linux', mechanism: 'none', probe: 'unshare: unshare failed: Operation not permitted' });
  assert.deepEqual(report.reproductions.map((r) => [r.outcome, r.reason]), [
    ['did-not-run', 'the sandbox probe did not pass: unshare: unshare failed: Operation not permitted'],
    ['did-not-run', 'the sandbox probe did not pass: unshare: unshare failed: Operation not permitted'],
  ]);
  assert.equal(fake.calls.length, 1, 'the probe only');
  // With the first candidate's layout, in its copy.
  assertCopyOf(repo, fake.calls[0].options.cwd, 'cand_001');
  assertHeadUntouched(repo, ['cand_001', 'cand_002']);
});

test('an escape the probe reports, or one seen from outside, is mechanism none', async (t) => {
  const repo = scratchRepository(t);
  // Linux through probeSandbox, and the macOS probe issue 321 builds on through runProbe, where the profile is what a broken sandbox overwrites.
  for (const platform of ['linux', 'darwin']) {
    const layout = layoutOf(context(repo, { platform }));
    const cases = [
      [{ probe: { status: 0, stdout: 'escaped by write, connect\n', stderr: '' } }, 'escaped by write, connect'],
      [{ probe: { status: 0, stdout: 'escaped by signal\n', stderr: '' } }, 'escaped by signal'],
      [{ probe: { status: 0, stdout: 'escaped by preference\n', stderr: '' } }, 'escaped by preference'],
      [{ onProbe: () => writeFileSync(layout.escape, 'x') }, 'escaped by write'],
      [{ onProbe: () => writeFileSync(platform === 'darwin' ? layout.profile : layout.probeFile, '(allow default)') }, 'escaped by profile'],
    ];
    for (const [options, probe] of cases) {
      const ctx = context(repo, { platform, spawn: fakeSpawn([], options).spawn });
      assert.deepEqual(await (platform === 'darwin' ? runProbe(ctx, layout) : probeSandbox(ctx)), { platform, mechanism: 'none', probe }, `${platform}: ${probe}`);
    }
    assert.equal(existsSync(layout.escape), false, 'the escape file is cleared after the probe');
    assert.equal(existsSync(layout.canary), false, 'the canary is removed after the probe');
  }
});

test('a platform with no mechanism, or a worktree that holds a hidden path, runs nothing', async (t) => {
  const repo = scratchRepository(t);
  const fake = fakeSpawn([]);
  assert.deepEqual(await probeSandbox(context(repo, { spawn: fake.spawn, platform: 'win32' })), { platform: 'win32', mechanism: 'none', probe: 'no confinement mechanism on win32' });
  mkdirSync(join(repo.worktree, 'store'));
  const exposed = await probeSandbox(context(repo, { spawn: fake.spawn, dataDir: join(repo.worktree, 'store') }));
  assert.equal(exposed.mechanism, 'none');
  assert.equal(exposed.probe, `${join(repo.worktree, 'store')} is inside a place a reproduction may use, so the sandbox cannot hide it`);
  assert.equal(fake.calls.length, 0);
});

test('two candidates get two copies and scratches, and the second sees none of the first changes and still has its links', async (t) => {
  const swap = (wt, to) => {
    unlinkSync(join(wt, 'node_modules'));
    to(join(wt, 'node_modules'));
  };
  const cases = [
    ['writes beside it', (wt) => writeFileSync(join(wt, 'debug.log'), 'x')],
    ['replaces it with a directory', (wt) => swap(wt, (at) => {
      mkdirSync(join(at, 'dep'), { recursive: true });
      writeFileSync(join(at, 'dep/index.js'), 'planted');
    })],
    ['re-points it at its own scratch', (wt, tmp) => swap(wt, (at) => symlinkSync(tmp, at))],
  ];
  for (const [name, act] of cases) {
    const repo = scratchRepository(t);
    mkdirSync(join(repo.clone, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(repo.clone, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    const target = realpathSync(join(repo.clone, 'node_modules'));
    const config = { ...context(repo).config, linkPaths: ['node_modules'] };
    const seen = [];
    let run = 0;
    const onRun = (options) => {
      if (run++ === 0) {
        // What a process left behind would hold on to: the first candidate's copy and scratch.
        writeFileSync(join(options.env.TMPDIR, 'planted'), 'planted');
        return act(options.cwd, options.env.TMPDIR);
      }
      const at = join(options.cwd, 'node_modules');
      seen.push([
        lstatSync(at).isSymbolicLink(), readlinkSync(at), readFileSync(join(at, 'dep/index.js'), 'utf8'),
        existsSync(join(options.cwd, 'debug.log')), existsSync(join(options.env.TMPDIR, 'planted')), options.args.at(-1).includes(`\ncd ${shellQuote(options.cwd)}\n`),
      ]);
    };
    const fake = fakeSpawn([failing, failingSecond, failingSecond], { onRun });
    const report = await reproduce(
      { verifications: [entry(), entry({}, 'cand_002')] },
      new Map([...candidates(), ...candidates('important', 'cand_002')]),
      context(repo, { spawn: fake.spawn, config }),
    );
    assertInCopies(repo, fake.calls);
    const [first, second] = report.reproductions;
    assert.equal(first.outcome, 'did-not-run', name);
    assert.match(first.reason, /^the reproduction modified the worktree \(\d+ paths\)$/, name);
    assert.equal(second.outcome, 'reproduced', `${name}: ${second.reason}`);
    const expected = [true, target, 'module.exports = 1;\n', false, false, true];
    assert.deepEqual(seen, [expected, expected], name);
    const [one, two, three] = fake.runs().map((call) => call.options);
    assertCopyOf(repo, one.cwd, 'cand_001');
    assertCopyOf(repo, two.cwd, 'cand_002');
    assert.equal(three.cwd, two.cwd, name);
    assert.deepEqual([one.env.HOME, two.env.HOME], [join(scratchBeside(one.cwd), 'home'), join(scratchBeside(two.cwd), 'home')], name);
    assert.deepEqual([one.env.TMPDIR, two.env.TMPDIR], [join(scratchBeside(one.cwd), 'tmp'), join(scratchBeside(two.cwd), 'tmp')], name);
    assertHeadUntouched(repo, ['cand_001', 'cand_002'], name);
    assert.equal(readFileSync(join(target, 'dep/index.js'), 'utf8'), 'module.exports = 1;\n', `${name}: the clone is untouched`);
  }
});

test('a path with . segments or through a tracked link to a directory runs under the name git gives it', async (t) => {
  // A relative link, which the copy keeps relative, so it resolves inside the copy and never into the head.
  const repo = scratchRepository(t, { links: { alias: 'src' } });
  for (const [path, file] of [['./add.repro.test.mjs', 'add.repro.test.mjs'], ['src/./add.repro.test.mjs', 'src/add.repro.test.mjs'], ['alias/add.repro.test.mjs', 'src/add.repro.test.mjs']]) {
    const { record, fake } = await runOne(t, [failing, failing], {}, { repo, entry: { path } });
    assert.deepEqual([record.outcome, record.reason, record.file, record.runs.length], ['reproduced', undefined, file, 2], path);
    assert.ok(innerOf(fake.runs()[0].options).endsWith(`exec node --test ${shellQuote(file)}`), path);
  }
  assertHeadUntouched(repo);
});

test('the walk never follows a link, so a tracked link to its own directory still reproduces', async (t) => {
  // A walk that followed it would go round self/self/... until the system refused the path.
  const repo = scratchRepository(t, { links: { self: '.' } });
  const { record } = await runOne(t, [failing, failing], {}, { repo });
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['reproduced', undefined, 2]);
  assertHeadUntouched(repo);
});

test('a copy flooded past the walk cap is did-not-run, and a flood or a throw leaves the rest to run and removes its copy', async (t) => {
  let cap;
  const flood = (options) => {
    // The copy as the baseline saw it, its root included, since nothing has changed it yet.
    const baseline = readdirSync(options.cwd, { recursive: true }).length + 1;
    cap = 2 * baseline + 10_000;
    mkdirSync(join(options.cwd, 'flood'));
    // One entry past the cap, the directory included.
    for (let index = 0; index < cap - baseline; index += 1) writeFileSync(join(options.cwd, 'flood', String(index)), '');
  };
  const broken = () => {
    throw new Error('the spawn broke');
  };
  for (const [act, reason] of [[flood, () => `the reproduction modified the worktree (more than ${cap} entries)`], [broken, () => 'the runner failed: the spawn broke']]) {
    const repo = scratchRepository(t);
    let run = 0;
    const onRun = (options) => {
      if (run++ === 0) act(options);
    };
    const fake = fakeSpawn([...(act === flood ? [failing] : []), failingSecond, failingSecond], { onRun });
    const report = await reproduce(
      { verifications: [entry(), entry({}, 'cand_002')] },
      new Map([...candidates(), ...candidates('important', 'cand_002')]),
      context(repo, { spawn: fake.spawn }),
    );
    assertInCopies(repo, fake.calls);
    assert.deepEqual(report.reproductions.map((r) => [r.outcome, r.reason]), [['did-not-run', reason()], ['reproduced', undefined]]);
    assertHeadUntouched(repo, ['cand_001', 'cand_002']);
  }
});

test('a stop signal during a run removes the copy and its scratch before the exit', async (t) => {
  const repo = scratchRepository(t);
  mkdirSync(join(repo.clone, 'node_modules'));
  const config = { ...context(repo).config, linkPaths: ['node_modules'] };
  let seen;
  const onRun = (options) => {
    writeFileSync(join(options.cwd, 'src/add.mjs'), 'planted\n');
    // What the stop handler runs, in-process here, since its exit would end the test.
    stopCommands();
    seen = { copy: existsSync(options.cwd), scratch: existsSync(scratchBeside(options.cwd)), places: existsSync(dirname(options.cwd)) };
  };
  await runOne(t, [failing], { config }, { repo, onRun });
  assert.deepEqual(seen, { copy: false, scratch: false, places: false });
  assertHeadUntouched(repo);
});

test('a run its runner reports stopped by the CPU limit signal is did-not-run, after the marker too', async (t) => {
  for (const stdout of [`${MARKER}\nnot ok 1 - hangs\n  signal: 'SIGXCPU'\n`, `${MARKER}\n  signal: 'SIGKILL'\r\n`]) {
    const { record } = await runOne(t, [{ status: 1, stdout }]);
    assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'may have been stopped at the 60s CPU limit', 1], stdout);
  }
});

test('an exit of 137 or 152, a shell reporting SIGKILL or SIGXCPU, is did-not-run after the marker too', async (t) => {
  for (const status of [137, 152]) {
    const { record } = await runOne(t, [{ status, stdout: `${MARKER}\n` }]);
    assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', `may have been stopped by a resource limit (exit ${status})`, 1], String(status));
  }
  // On run 2 too, so a pair of limit stops is never a reproduction.
  const { record } = await runOne(t, [failing, { status: 137, stdout: `${MARKER}\n` }]);
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'may have been stopped by a resource limit (exit 137)', 2]);
});

test('a failing run that only names a signal, or outlasts cpu_seconds while waiting, still reproduces', async (t) => {
  // node --test prints an assertion about a signal as expected and actual, never as its own signal line.
  const named = { status: 1, stdout: `${MARKER}\nnot ok 1\n  expected: 'SIGKILL'\n  actual: 'SIGTERM'\n  message: stopCommands sends SIGKILL\n` };
  const { record } = await runOne(t, [named, named]);
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['reproduced', undefined, 2]);
  const repo = scratchRepository(t);
  const calls = [];
  const slow = async (command, options) => {
    calls.push({ command, options });
    if (isProbe(options)) return { status: 0, stdout: 'RV_PROBE_OK\n', stderr: '' };
    await new Promise((done) => setTimeout(done, 1100));
    return { stderr: '', ...failing };
  };
  const report = await reproduce({ verifications: [entry()] }, candidates(), context(repo, { spawn: slow, config: { ...context(repo).config, cpuSeconds: 1 } }));
  assertInCopies(repo, calls);
  const [waited] = report.reproductions;
  assert.deepEqual([waited.outcome, waited.reason, waited.runs.length], ['reproduced', undefined, 2]);
  assert.ok(waited.runs.every((run) => run.durationMs >= 1000), 'each run outlasted cpu_seconds');
});

test('the probe tries every escape, and a connection it does not admit still fails it', async (t) => {
  const repo = scratchRepository(t);
  // Unconfined on macOS the probe really writes its domain and deletes it, and cfprefsd keeps an empty plist.
  if (process.platform === 'darwin') t.after(() => rmSync(join(homedir(), 'Library/Preferences/review-voice.probe.plist'), { force: true }));
  for (const platform of ['darwin', 'linux']) {
    const layout = layoutOf(context(repo, { platform }));
    // The wrapper is dropped, so the probe script runs with nothing confining it, and can signal the CLI.
    const unconfined = (command, options) => spawnCommand(process.execPath, { ...options, shell: false, args: [layout.probeFile] });
    // Only the macOS probe tries a signal, since a Linux pid namespace can reuse the CLI's pid number.
    const signal = platform === 'darwin' ? ', signal' : '';
    // Only macOS has cfprefsd, and only the macOS probe tries it.
    const preference = platform === 'darwin' && process.platform === 'darwin' ? ', preference' : '';
    // The macOS probe through runProbe, since probeSandbox runs nothing on macOS until issue 321.
    const ctx = context(repo, { platform, spawn: unconfined });
    assert.deepEqual(await (platform === 'darwin' ? runProbe(ctx, layout) : probeSandbox(ctx)), { platform, mechanism: 'none', probe: `escaped by write, read, connect, profile${signal}${preference}` });
  }
  const liar = async (command, options) => {
    const port = Number(/"port":(\d+)/.exec(options.args.at(-1))[1]);
    await new Promise((done) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.destroy();
        done();
      });
      socket.on('error', done);
    });
    // A probe process exits some time after it connected; in-process the accept would otherwise come after the return.
    await new Promise((done) => setTimeout(done, 50));
    return { status: 0, stdout: 'RV_PROBE_OK\n', stderr: '' };
  };
  assert.deepEqual(await probeSandbox(context(repo, { spawn: liar })), { platform: 'linux', mechanism: 'none', probe: 'escaped by connect' });
});

test('a probe that dies with a fatal-error banner is named by its first line with words', async (t) => {
  const repo = scratchRepository(t);
  const banner = '\n\n#\n# Fatal error in , line 0\n# Check failed: reservation.\n#\n';
  const fake = fakeSpawn([], { probe: { status: null, stdout: '', stderr: banner } });
  const report = await reproduce({ verifications: [entry()] }, candidates(), context(repo, { spawn: fake.spawn, platform: 'linux' }));
  assert.deepEqual(report.sandbox, { platform: 'linux', mechanism: 'none', probe: 'unshare: # Fatal error in , line 0' });
});

test('a probe passes only when it exits 0 and prints exactly RV_PROBE_OK', async (t) => {
  const repo = scratchRepository(t);
  for (const probe of [{ status: 0, stdout: '' }, { status: 0, stdout: 'RV_PROBE_OK extra\n' }, { status: 0, stdout: 'RV_PROBE_OK\nRV_PROBE_OK\n' }, { status: 1, stdout: 'RV_PROBE_OK\n' }]) {
    const sandbox = await probeSandbox(context(repo, { spawn: fakeSpawn([], { probe: { stderr: '', ...probe } }).spawn }));
    assert.equal(sandbox.mechanism, 'none', JSON.stringify(probe));
    assert.notEqual(sandbox.probe, 'passed', JSON.stringify(probe));
  }
});

test('a stop signal during the probe removes the canary and the escape file before the exit', async (t) => {
  const repo = scratchRepository(t);
  const layout = layoutOf(context(repo));
  let seen;
  const onProbe = () => {
    writeFileSync(layout.escape, 'x');
    // What the stop handler runs, in-process here, since its exit would end the test.
    stopCommands();
    seen = [existsSync(layout.canary), existsSync(layout.escape)];
  };
  await probeSandbox(context(repo, { spawn: fakeSpawn([], { onProbe }).spawn }));
  assert.deepEqual(seen, [false, false]);
});

test('a probe that passes names the mechanism of its platform', async (t) => {
  const repo = scratchRepository(t);
  assert.deepEqual(await probeSandbox(context(repo, { platform: 'linux', spawn: fakeSpawn().spawn })), { platform: 'linux', mechanism: 'unshare', probe: 'passed' });
  // The macOS probe issue 321 builds on, which probeSandbox does not reach.
  const ctx = context(repo, { platform: 'darwin', spawn: fakeSpawn().spawn });
  assert.deepEqual(await runProbe(ctx, layoutOf(ctx)), { platform: 'darwin', mechanism: 'sandbox-exec', probe: 'passed' });
});

test('the git calls before a run carry SAFE_GIT, so a hook the pull request tracks never runs outside the sandbox', async (t) => {
  const repo = scratchRepository(t);
  const marker = join(repo.dir, 'hook-ran');
  mkdirSync(join(repo.clone, '.hooks'));
  writeFileSync(join(repo.clone, '.hooks/fsmonitor'), `#!/bin/sh\necho "$@" >> ${shellQuote(marker)}\n`);
  chmodSync(join(repo.clone, '.hooks/fsmonitor'), 0o755);
  git(repo.clone, 'add', '-A');
  git(repo.clone, 'commit', '-q', '-m', 'hook');
  git(repo.worktree, 'checkout', '-q', '--detach', git(repo.clone, 'rev-parse', 'HEAD'));
  // Relative, so a git that read it would run the copy of the file the pull request tracks, outside the sandbox.
  git(repo.clone, 'config', 'core.fsmonitor', '.hooks/fsmonitor');
  const { record } = await runOne(t, [failing], {}, { repo, onRun: (options) => writeFileSync(join(options.cwd, 'src/add.mjs'), 'planted\n') });
  assert.deepEqual([record.outcome, record.reason], ['did-not-run', 'the reproduction modified the worktree (1 paths)']);
  assert.equal(existsSync(marker), false, 'the hook never ran');
});

test('the hidden list names the main git directory of a clone that is itself a linked worktree', (t) => {
  const repo = scratchRepository(t);
  const linked = join(repo.dir, 'linked');
  git(repo.clone, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  const main = realpathSync(join(repo.clone, '.git'));
  for (const platform of ['darwin', 'linux']) assert.ok(layoutOf(context(repo, { clone: linked, platform })).hiddenDirs.includes(main), platform);
  const denied = sandboxProfile(layoutOf(context(repo, { clone: linked, platform: 'darwin' }))).split('\n').find((line) => line.startsWith('(deny file-read*'));
  assert.ok(denied.includes(`(subpath "${main}")`), 'the config that can hold a token is not readable');
});

test('a candidate id that names a reserved or outside directory, or a worktree holding its own git directory, runs nothing', async (t) => {
  const repo = scratchRepository(t);
  for (const id of ['scratch', 'sandbox.sb', 'probe', 'trees', '..', '.', 'a/b']) {
    const fake = fakeSpawn([]);
    const report = await reproduce({ verifications: [entry({}, id)] }, candidates('important', id), context(repo, { spawn: fake.spawn }));
    assert.deepEqual(report.reproductions.map((r) => r.reason), ['the candidate id cannot name a directory for the copy'], id);
    assert.equal(fake.calls.length, 0, id);
  }
  assert.equal(existsSync(treesDir(repo)), false, 'no copy was made');
  const own = join(repo.dir, 'own');
  mkdirSync(join(own, 'src'), { recursive: true });
  git(repo.dir, 'init', '-q', `--separate-git-dir=${join(own, '.gd')}`, own);
  // Relative, so in the copy it names the copy's own git directory, which a run could rewrite.
  writeFileSync(join(own, '.git'), 'gitdir: .gd\n');
  const inside = await runOne(t, [], { worktree: own }, { repo });
  assert.deepEqual([inside.record.reason, inside.fake.calls.length], ['the worktree holds its own git directory, which a reproduction could rewrite', 0]);
});

test('a copy that cannot be made is did-not-run with its reason, leaves no partial copy, and the next candidate still runs', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads a file whatever its mode');
    return;
  }
  const repo = scratchRepository(t);
  // A file the CLI cannot read fails the copy, and is readable again once the second entry is read.
  const locked = join(repo.worktree, 'locked.log');
  writeFileSync(locked, 'x');
  chmodSync(locked, 0);
  const second = { candidate_id: 'cand_002', get reproduction() {
    chmodSync(locked, 0o644);
    return entry({}, 'cand_002').reproduction;
  } };
  const fake = fakeSpawn([failingSecond, failingSecond]);
  const report = await reproduce({ verifications: [entry(), second] }, new Map([...candidates(), ...candidates('important', 'cand_002')]), context(repo, { spawn: fake.spawn }));
  assertInCopies(repo, fake.calls);
  const [one, two] = report.reproductions;
  assert.deepEqual([one.outcome, one.runs.length], ['did-not-run', 0]);
  assert.match(one.reason, /^could not copy the worktree: EACCES/);
  assert.deepEqual(leftOf(repo, 'cand_001'), [], 'the partial copy is removed');
  assert.deepEqual([two.outcome, two.runs.length], ['reproduced', 2]);
  // The test made this file in the head, so it goes before the head is judged.
  rmSync(locked);
  assertHeadUntouched(repo, ['cand_001', 'cand_002']);
});

test('every execution gets a fresh directory, so one left from before is neither used nor removed', async (t) => {
  const repo = scratchRepository(t);
  // The name a fixed directory per candidate would have taken, left by an earlier invocation.
  for (const name of ['cand_001', 'cand_001-AAAAAA']) {
    mkdirSync(join(treesDir(repo), name, 'tree'), { recursive: true });
    writeFileSync(join(treesDir(repo), name, 'tree', 'left'), 'from before');
  }
  const cwds = [];
  for (let invocation = 0; invocation < 2; invocation += 1) {
    const { record, fake } = await runOne(t, [failing, failing], {}, { repo, onRun: (options) => assert.equal(existsSync(join(options.cwd, 'left')), false, 'nothing of before is in it') });
    assert.deepEqual([record.outcome, record.runs.length], ['reproduced', 2], record.reason);
    cwds.push(fake.runs()[0].options.cwd);
  }
  assert.notEqual(cwds[0], cwds[1], 'each invocation has its own');
  for (const name of ['cand_001', 'cand_001-AAAAAA']) assert.equal(readFileSync(join(treesDir(repo), name, 'tree', 'left'), 'utf8'), 'from before', `${name} is not removed`);
  assert.deepEqual(readdirSync(treesDir(repo)).sort(), ['cand_001', 'cand_001-AAAAAA'], 'and the fresh ones are gone');
});

test('a second entry for a candidate id already seen is did-not-run, and nothing is spawned for it', async (t) => {
  const repo = scratchRepository(t);
  const fake = fakeSpawn([failing, failing]);
  const report = await reproduce({ verifications: [entry(), entry({ path: 'src/other.test.mjs', content: 'other\n' })] }, candidates(), context(repo, { spawn: fake.spawn }));
  assert.deepEqual(report.reproductions.map((r) => [r.candidateId, r.outcome, r.reason, r.runs.length]), [['cand_001', 'reproduced', undefined, 2], ['cand_001', 'did-not-run', 'duplicate candidate id', 0]]);
  assert.equal(fake.runs().length, 2, 'the first entry only');
  assert.equal(readFileSync(report.reproductions[0].copy, 'utf8'), "console.log('the reproduction')\n", 'the kept copy is the first entry file');
  assertHeadUntouched(repo);
  // Seen from the first entry on, so a first entry that was refused still keeps a second from running.
  const refused = fakeSpawn([failing, failing]);
  const again = await reproduce({ verifications: [entry({ path: 'src/../x.test.mjs' }), entry()] }, candidates(), context(repo, { spawn: refused.spawn }));
  assert.deepEqual(again.reproductions.map((r) => [r.outcome, r.reason, r.runs.length]), [['did-not-run', 'path refused: an empty or .. segment', 0], ['did-not-run', 'duplicate candidate id', 0]]);
  assert.deepEqual(refused.calls, [], 'nothing is spawned, not even the probe');
  assertHeadUntouched(repo);
});

test('a worktree named through a link is copied, never used through the link', async (t) => {
  const repo = scratchRepository(t);
  const via = join(repo.dir, 'via');
  symlinkSync(repo.worktree, via);
  const { record, fake } = await runOne(t, [failing], { worktree: via }, { repo, onRun: (options) => writeFileSync(join(options.cwd, 'src/add.mjs'), 'planted\n') });
  assertCopyOf(repo, fake.runs()[0].options.cwd, 'cand_001');
  assert.deepEqual([record.outcome, record.reason], ['did-not-run', 'the reproduction modified the worktree (1 paths)']);
  assertHeadUntouched(repo);
});

// The confinement itself (AC-4), through the bundle wherever the probe passes.

test('the runner confines a real reproduction, or names why it cannot and runs nothing', async (t) => {
  const repo = scratchRepository(t, { config: { reproduction: { enabled: true, runners: [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs', timeout_seconds: 120 }], link_paths: ['node_modules'] } } });
  mkdirSync(join(repo.clone, 'node_modules'));
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  const probeRun = cli(repo, ['reproduce', '--worktree', repo.worktree, '--run-dir', repo.runDir, '--probe'], env);
  assert.equal(probeRun.status, 0, probeRun.stderr);
  const sandbox = JSON.parse(probeRun.stdout);
  assert.doesNotMatch(sandbox.probe, /^escaped by/, 'a probe that reports an escape is a broken confinement, not a missing one');

  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const overwrite = join(reproDir(repo), process.platform === 'darwin' ? 'sandbox.sb' : 'probe/probe.js');
  const targets = { port: server.address().port, escape: join(reproDir(repo), 'probe-escape'), canary: join(repo.runDir, 'test-canary'), overwrite, pid: process.pid, head: join(repo.worktree, 'planted'), domain: `review-voice.test.${process.pid}` };
  writeFileSync(targets.canary, 'secret\n');
  if (process.platform === 'darwin') {
    // What a broken sandbox would leave in the real preferences.
    t.after(() => {
      spawnSync('/usr/bin/defaults', ['delete', targets.domain], { stdio: 'ignore' });
      rmSync(join(homedir(), 'Library/Preferences', `${targets.domain}.plist`), { force: true });
    });
  }
  const content = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import net from 'node:net';",
    "import { spawnSync } from 'node:child_process';",
    "import { add } from './add.mjs';",
    `const t = ${JSON.stringify(targets)};`,
    "test('add adds', async () => {",
    '  const tried = {};',
    "  try { fs.writeFileSync(t.escape, 'x'); tried.write = 'succeeded'; } catch (e) { tried.write = e.code; }",
    "  try { fs.readFileSync(t.canary); tried.read = 'succeeded'; } catch (e) { tried.read = e.code; }",
    "  try { fs.writeFileSync(t.overwrite, 'tampered'); tried.profile = 'succeeded'; } catch (e) { tried.profile = e.code; }",
    "  try { fs.writeFileSync('node_modules/planted.js', 'x'); tried.link = 'succeeded'; } catch (e) { tried.link = e.code; }",
    // Opened for appending and given nothing, so a sandbox that allowed it leaves the worktree's git link intact.
    "  try { fs.appendFileSync('.git', ''); tried.git = 'succeeded'; } catch (e) { tried.git = e.code; }",
    // This test process stands for any process of the user outside the sandbox.
    "  try { process.kill(t.pid, 0); tried.signal = 'succeeded'; } catch (e) { tried.signal = e.code; }",
    "  try { fs.writeFileSync(t.head, 'x'); tried.head = 'succeeded'; } catch (e) { tried.head = e.code; }",
    "  if (process.platform === 'darwin') {",
    "    fs.writeFileSync(process.env.TMPDIR + '/flagged', 'x');",
    "    const r = spawnSync('/usr/bin/chflags', ['nodump', process.env.TMPDIR + '/flagged']);",
    "    tried.flags = r.status === 0 ? 'succeeded' : 'refused';",
    // cfprefsd writes a named domain into the real ~/Library/Preferences, outside the copy.
    "    tried.preference = spawnSync('/usr/bin/defaults', ['write', t.domain, 'planted', 'yes']).status === 0 ? 'succeeded' : 'refused';",
    '  }',
    '  tried.connect = await new Promise((done) => {',
    "    const s = net.connect(t.port, '127.0.0.1');",
    "    const timer = setTimeout(() => { s.destroy(); done('timed out'); }, 2000);",
    "    s.on('connect', () => { clearTimeout(timer); s.destroy(); done('succeeded'); });",
    "    s.on('error', (e) => { clearTimeout(timer); done(e.code); });",
    '  });',
    "  console.log('RV_ESCAPES ' + JSON.stringify(tried));",
    `  console.log('${MARKER}');`,
    '  assert.equal(add(2, 2), 4);',
    '});',
    '',
  ].join('\n');
  const verification = join(repo.runDir, 'verification.json');
  const checked = join(repo.runDir, 'checked.json');
  const out = join(repo.runDir, 'reproductions.json');
  writeFileSync(verification, JSON.stringify({ verifications: [entry({ content })] }));
  writeFileSync(checked, JSON.stringify({ kept: [{ candidate_id: 'cand_001', path: 'src/add.mjs', line: 1, severity: 'blocking' }] }));
  const childEnv = { ...process.env, REVIEW_VOICE_DATA_DIR: repo.dataDir, ...env };
  delete childEnv.REVIEW_VOICE_CONFIG;
  delete childEnv.REVIEW_VOICE_NO_COMMANDS;
  // Asynchronous, so the listener above accepts while the reproduction runs.
  const status = await new Promise((done) => {
    const child = spawnChild(process.execPath, [bundle, 'reproduce', '--worktree', repo.worktree, '--verification', verification, '--candidates', checked, '--out', out, '--run-dir', repo.runDir], { cwd: repo.clone, env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', done);
  });
  await new Promise((done) => setImmediate(done));
  rmSync(targets.canary, { force: true });
  assert.equal(status, 0);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const [record] = report.reproductions;
  assert.equal(existsSync(targets.escape), false, 'nothing was written outside the worktree and the scratch directory');
  assert.equal(connections, 0, 'the listener saw no connection');
  assert.equal(existsSync(join(repo.worktree, 'src/add.repro.test.mjs')), false);
  assert.equal(existsSync(join(repo.clone, 'node_modules/planted.js')), false, 'nothing was written through a link into the clone');
  assertHeadUntouched(repo);

  if (sandbox.probe === 'passed') {
    assert.deepEqual(report.sandbox, sandbox);
    const tried = JSON.parse(/RV_ESCAPES (\{.*\})/.exec(record.runs[0]?.output ?? '')?.[1] ?? '{}');
    assert.ok(tried.write && tried.write !== 'succeeded', `write: ${tried.write}`);
    assert.ok(tried.read && tried.read !== 'succeeded', `read: ${tried.read}`);
    assert.ok(tried.profile && tried.profile !== 'succeeded', `profile: ${tried.profile}`);
    assert.ok(tried.link && tried.link !== 'succeeded', `link: ${tried.link}`);
    assert.ok(tried.git && tried.git !== 'succeeded', `git: ${tried.git}`);
    assert.ok(tried.signal && tried.signal !== 'succeeded', `signal: ${tried.signal}`);
    assert.ok(tried.head && tried.head !== 'succeeded', `head: ${tried.head}`);
    if (process.platform === 'darwin') assert.equal(tried.flags, 'refused', 'a file flag cannot be set');
    if (process.platform === 'darwin') assert.equal(tried.preference, 'refused', 'no preference domain is written through cfprefsd');
    assert.ok(tried.connect && tried.connect !== 'succeeded', `connect: ${tried.connect}`);
    assert.notEqual(readFileSync(overwrite, 'utf8'), 'tampered', 'the profile is unchanged');
    assert.equal(record.outcome, 'reproduced', `${record.reason}\n${record.runs.map((run) => run.output).join('\n')}`);
    assert.equal(record.runs.length, 2);
    assert.ok(record.runs.every((run) => !run.output.includes('ulimit')), 'a limit the host refuses leaves no line in the record');
    return;
  }
  assert.equal(report.sandbox.mechanism, 'none');
  assert.equal(report.sandbox.probe, sandbox.probe);
  assert.ok(report.reproductions.length > 0 && report.reproductions.every((entry) => entry.outcome === 'did-not-run' && entry.reason.includes(sandbox.probe)));
  t.diagnostic(`sandbox unavailable: ${sandbox.probe}`);
  if (process.env.REVIEW_VOICE_REQUIRE_SANDBOX === '1') assert.fail(`REVIEW_VOICE_REQUIRE_SANDBOX=1 and the sandbox is unavailable: ${sandbox.probe}`);
});

test('a stop signal to reproduce kills the running reproduction, removes its copy and leaves the head worktree as it found it', async (t) => {
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    const runner = { name: 'sh', run: '/bin/sh {file}', extension: '.sh', timeout_seconds: 120 };
    const repo = scratchRepository(t, { config: { reproduction: { enabled: true, runners: [runner], link_paths: ['node_modules'] } } });
    mkdirSync(join(repo.clone, 'node_modules'));
    const probe = JSON.parse(cli(repo, ['reproduce', '--worktree', repo.worktree, '--run-dir', repo.runDir, '--probe'], env).stdout);
    if (probe.probe !== 'passed') {
      t.skip(`needs a sandbox that holds: ${probe.probe}`);
      return;
    }
    const { out, args } = inputs(repo);
    // The fresh directory of the execution, once mkdtemp has made it.
    const places = () => readdirSync(treesDir(repo)).filter((name) => name.startsWith('cand_001-')).map((name) => join(treesDir(repo), name))[0] ?? join(treesDir(repo), 'none');
    // TMPDIR is the scratch directory inside the sandbox, so the test sees when the reproduction has started.
    const started = () => existsSync(treesDir(repo)) && existsSync(join(places(), 'scratch', 'tmp', 'started'));
    // Found by its arguments, which the host sees, since a pid written inside a pid namespace is 1 there.
    const seconds = `600.${randomInt(1e9)}`;
    const running = () => spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).stdout.split('\n').some((line) => line.trim() === `sleep ${seconds}`);
    writeFileSync(join(repo.runDir, 'verification.json'), JSON.stringify({ verifications: [entry({ runner: 'sh', path: 'src/stop.sh', content: `echo started > "$TMPDIR/started"\nexec sleep ${seconds}\n` })] }));
    const childEnv = { ...process.env, REVIEW_VOICE_DATA_DIR: repo.dataDir, ...env };
    delete childEnv.REVIEW_VOICE_CONFIG;
    delete childEnv.REVIEW_VOICE_NO_COMMANDS;
    const child = spawnChild(process.execPath, [bundle, ...args], { cwd: repo.clone, env: childEnv, stdio: 'ignore' });
    const exited = new Promise((done) => child.on('exit', (status) => done(status)));
    const deadline = Date.now() + 30_000;
    while (!started() || !running()) {
      assert.ok(Date.now() < deadline, 'the reproduction started, and the host sees it');
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(lstatSync(join(places(), 'tree', 'node_modules')).isSymbolicLink(), 'linked into the copy while it runs');
    assert.equal(lstatSync(join(repo.worktree, 'node_modules'), { throwIfNoEntry: false }), undefined, 'never into the head');
    child.kill(signal);
    assert.equal(await exited, code, signal);
    // Reaped once the CLI has gone, which takes a moment.
    for (let wait = 0; running() && wait < 100; wait += 1) await new Promise((done) => setTimeout(done, 50));
    assert.equal(running(), false, `${signal}: the reproduction was killed`);
    assertHeadUntouched(repo, ['cand_001'], signal);
    assert.equal(existsSync(out), false, 'a stopped run writes no report');
  }
});

test('a process a reproduction leaves behind never writes the head worktree', async (t) => {
  // On macOS a child started with setsid leaves the process group, outlives the run and its group kill, and keeps the sandbox it was started in.
  const runner = { name: 'node', run: 'node {file}', extension: '.mjs', timeout_seconds: 60 };
  const repo = scratchRepository(t, { config: { reproduction: { enabled: true, runners: [runner] } } });
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  const probe = JSON.parse(cli(repo, ['reproduce', '--worktree', repo.worktree, '--run-dir', repo.runDir, '--probe'], env).stdout);
  if (probe.probe !== 'passed') {
    t.skip(`needs a sandbox that holds: ${probe.probe}`);
    return;
  }
  const planted = join(repo.worktree, 'planted-head');
  // Written a second after the run, once the CLI has checked the place the run had.
  const child = `setTimeout(() => { const fs = require('fs'); try { fs.writeFileSync('planted-here', 'x'); } catch {} try { fs.writeFileSync(${JSON.stringify(planted)}, 'x'); } catch {} }, 1000);`;
  const content = [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref();`,
    '',
  ].join('\n');
  const verification = join(repo.runDir, 'verification.json');
  const checked = join(repo.runDir, 'checked.json');
  const out = join(repo.runDir, 'reproductions.json');
  writeFileSync(verification, JSON.stringify({ verifications: [entry({ runner: 'node', path: 'src/leave.mjs', content })] }));
  writeFileSync(checked, JSON.stringify({ kept: [{ candidate_id: 'cand_001', path: 'src/add.mjs', line: 1, severity: 'blocking' }] }));
  const result = cli(repo, ['reproduce', '--worktree', repo.worktree, '--verification', verification, '--candidates', checked, '--out', out, '--run-dir', repo.runDir], env);
  assert.equal(result.status, 0, result.stderr);
  const [record] = JSON.parse(readFileSync(out, 'utf8')).reproductions;
  assert.deepEqual([record.outcome, record.reason], ['did-not-fail', 'run 1 exited 0'], record.runs.map((run) => run.output).join('\n'));
  await new Promise((done) => setTimeout(done, 2500));
  assert.equal(git(repo.worktree, 'status', '--porcelain', '--ignored'), '', 'the head worktree is as the driver made it');
  assert.equal(existsSync(join(repo.worktree, 'planted-here')), false, 'not in the place the run had');
  assert.equal(existsSync(planted), false, 'not through the head path either');
});
