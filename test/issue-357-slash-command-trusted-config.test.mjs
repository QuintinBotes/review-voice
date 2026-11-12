/**
 * #357. The slash command runs the stage commands itself, and each read
 * .review-voice/config.yaml from the checkout, which on a pull request review
 * is the head its author wrote. `config resolve` makes the choice the review
 * driver makes, once, and the slash command hands the file and its source to
 * every stage command through `--trusted-config <dir>`, which sets
 * REVIEW_VOICE_CONFIG and REVIEW_VOICE_CONFIG_SOURCE for that command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const REPO = 'acme/api';
const PR = 12;
const CONFIG_FILE = '.review-voice/config.yaml';
const VARIABLES = ['REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_CONFIG_SOURCE'];

// Each setting shows in one stage command's output. That is the mode in `plan`,
// the gate in `score`, and the sensitive glob in the complexity `diff` assesses.
const BASE_CONFIG = ['review:', '  mode: thorough', '  confidence_threshold: 0.95', '  minor_confidence_threshold: 0.95', '  human_review:', '    sensitive_paths:', "      - 'src/billing/**'", ''].join('\n');
const HEAD_CONFIG = ['review:', '  mode: fast', '  confidence_threshold: 0.5', '  human_review:', '    sensitive_paths: []', ''].join('\n');
const RUNNERS = ['runners:', '  codex:', '    command: [codex, exec, "{schema}"]', '  use:', '    challenge: codex', ''].join('\n');
const CHARGE = ['export function charge(cents) {', '  if (cents < 0) return 0;', '  return cents * 2;', '}', ''].join('\n');
const RULE = /runners is read only from the operator's own configuration/;

function temporary(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clone whose base commit holds `baseConfig` and whose head, checked out, holds `headConfig` and a billing change. */
function repository(t, { baseConfig = BASE_CONFIG, headConfig = HEAD_CONFIG } = {}) {
  const dir = temporary(t, 'rv-357-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('src/app.ts', 'export const rate = 1;\n');
  if (baseConfig !== null) write(CONFIG_FILE, baseConfig);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  write('src/billing/charge.ts', CHARGE);
  if (headConfig !== null) write(CONFIG_FILE, headConfig);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return { dir, base, head: git('rev-parse', 'HEAD'), git };
}

/** GitHub as `config resolve` reads it, which is the pull request and nothing else. */
function fakeGitHub(repo, base = { sha: repo.base, ref: 'main' }) {
  return async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname !== `/repos/${REPO}/pulls/${PR}`) return new Response('not found', { status: 404 });
    const body = { number: PR, head: { sha: repo.head, ref: 'feature' }, ...(base === null ? {} : { base }) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** One command in the clone, in this process so GitHub can be stubbed. Neither variable is set unless `env` sets it. */
async function inClone(repo, argv, { env = {}, github = fakeGitHub(repo), stdin = '' } = {}) {
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  const touched = [...VARIABLES, 'GITHUB_TOKEN', ...Object.keys(env)];
  process.chdir(repo.dir);
  for (const name of VARIABLES) delete process.env[name];
  Object.assign(process.env, { GITHUB_TOKEN: 't', ...env });
  try {
    return await runInProcess(argv, { fetchImpl: github, stdin });
  } finally {
    process.chdir(saved.cwd);
    for (const name of touched) {
      if (saved.env[name] === undefined) delete process.env[name];
      else process.env[name] = saved.env[name];
    }
  }
}

/** One stage command from the built bundle, in the clone, with only the variables given. */
function stage(repo, data, args, variables = {}, input = '') {
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data, ...variables };
  for (const name of VARIABLES) if (!(name in variables)) delete env[name];
  const result = spawnSync(process.execPath, [bundle, ...args], { cwd: repo.dir, encoding: 'utf8', input, env });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  return result;
}

async function resolveConfig(repo, args, options) {
  const result = await inClone(repo, ['config', 'resolve', '--pr', String(PR), '--repository', REPO, ...args], options);
  return { ...result, json: result.code === 0 ? JSON.parse(result.stdout) : null };
}

const variablesOf = (resolved) => ({ REVIEW_VOICE_CONFIG: resolved.path, REVIEW_VOICE_CONFIG_SOURCE: resolved.source });
const sha7 = (sha) => sha.slice(0, 7);
const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('config resolve copies the base commit file into the run directory when the head changed the config', async (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const { code, stderr, json } = await resolveConfig(repo, ['--dir', run]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(json, { path: join(run, 'config.yaml'), source: 'base', ref: repo.base, notes: [] });
  assert.equal(readFileSync(json.path, 'utf8'), BASE_CONFIG, 'the base file, not the head that is checked out');
  assert.equal(statSync(json.path).mode & 0o777, 0o600, 'the copy is private to the owner');
  assert.equal(readFileSync(join(repo.dir, CONFIG_FILE), 'utf8'), HEAD_CONFIG, 'the checkout is untouched');
});

test('config resolve names the flag file with --config, ahead of the environment and the base commit', async (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  const other = join(temporary(t, 'rv-357-own-'), 'other.yaml');
  writeFileSync(own, RUNNERS);
  writeFileSync(other, HEAD_CONFIG);
  // Relative to the clone, so the printed path is shown to be absolute.
  const { code, stderr, json } = await resolveConfig(repo, ['--dir', run, '--config', relative(repo.dir, own)], { env: { REVIEW_VOICE_CONFIG: other } });
  assert.equal(code, 0, stderr);
  assert.deepEqual(json, { path: own, source: 'flag', notes: [] });
  assert.equal(existsSync(join(run, 'config.yaml')), false, 'nothing is copied from the base');
});

test('config resolve names the operator file from an absolute REVIEW_VOICE_CONFIG, with the source stated beside it', async (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, RUNNERS);

  const operator = await resolveConfig(repo, ['--dir', run], { env: { REVIEW_VOICE_CONFIG: own } });
  assert.equal(operator.code, 0, operator.stderr);
  assert.deepEqual(operator.json, { path: own, source: 'env', notes: [] });
  assert.equal(existsSync(join(run, 'config.yaml')), false, 'nothing is copied from the base');

  // A file `watch` copied from a checkout arrives with that source, and keeps it.
  const handedOn = await resolveConfig(repo, ['--dir', run], { env: { REVIEW_VOICE_CONFIG: own, REVIEW_VOICE_CONFIG_SOURCE: 'checkout' } });
  assert.deepEqual(handedOn.json, { path: own, source: 'checkout', notes: [] });

  const relativeValue = await resolveConfig(repo, ['--dir', run], { env: { REVIEW_VOICE_CONFIG: 'relative/config.yaml' } });
  assert.equal(relativeValue.code, 0, relativeValue.stderr);
  assert.equal(relativeValue.json.source, 'base', 'a relative value is not a source');
  assert.deepEqual(relativeValue.json.notes, ['REVIEW_VOICE_CONFIG must be an absolute path, so it was ignored and the base commit supplied the configuration.']);
});

test('config resolve names the built-in defaults when the base commit has no config, whatever the head adds', async (t) => {
  const repo = repository(t, { baseConfig: null });
  const run = temporary(t, 'rv-357-run-');
  // A copy an earlier run took from another base must not survive.
  writeFileSync(join(run, 'config.yaml'), HEAD_CONFIG);
  const { code, stderr, json } = await resolveConfig(repo, ['--dir', run]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(json, {
    path: join(run, 'config.yaml'),
    source: 'default',
    ref: repo.base,
    notes: [`No ${CONFIG_FILE} at the base commit ${sha7(repo.base)}; the review ran with the built-in defaults.`],
  });
  assert.equal(existsSync(json.path), false, 'no file, so every stage reads the defaults');
});

test('config resolve follows the driver rules for a clone that lacks the base commit', async (t) => {
  const absent = { sha: 'b'.repeat(40), ref: 'main' };

  // In a fork clone origin/main is the author's own branch, so it is no source.
  const fork = repository(t);
  fork.git('remote', 'add', 'origin', 'https://github.com/someone-else/api.git');
  fork.git('update-ref', 'refs/remotes/origin/main', fork.head);
  const forkRun = temporary(t, 'rv-357-run-');
  const fromFork = await resolveConfig(fork, ['--dir', forkRun], { github: fakeGitHub(fork, absent) });
  assert.equal(fromFork.code, 0, fromFork.stderr);
  assert.equal(fromFork.json.source, 'default');
  assert.equal(fromFork.json.ref, absent.sha);
  assert.equal(existsSync(join(forkRun, 'config.yaml')), false);

  // Origin is the repository under review, so its base branch stands in. A local branch of that name does not.
  const upstream = repository(t);
  upstream.git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  upstream.git('update-ref', 'refs/remotes/origin/main', upstream.base);
  upstream.git('branch', 'origin/main', upstream.head);
  const upstreamRun = temporary(t, 'rv-357-run-');
  const fromUpstream = await resolveConfig(upstream, ['--dir', upstreamRun], { github: fakeGitHub(upstream, absent) });
  assert.equal(fromUpstream.code, 0, fromUpstream.stderr);
  assert.deepEqual(fromUpstream.json, { path: join(upstreamRun, 'config.yaml'), source: 'base', ref: 'refs/remotes/origin/main', notes: [] });
  assert.equal(readFileSync(fromUpstream.json.path, 'utf8'), BASE_CONFIG);
});

test('config resolve refuses a bad invocation with exit 2 and writes nothing', async (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const pull = ['--pr', String(PR), '--repository', REPO];
  for (const [argv, message] of [
    [['config', 'show', ...pull, '--dir', run], /Usage: review-voice config resolve/],
    [['config', 'resolve', ...pull], /Usage: review-voice config resolve/],
    [['config', 'resolve', '--repository', REPO, '--dir', run], /--pr needs a pull request number/],
    [['config', 'resolve', ...pull, '--dir', join(run, 'missing')], /is not a directory/],
    [['config', 'resolve', ...pull, '--dir', run, '--config'], /--config needs a value/],
  ]) {
    // Each is refused before GitHub is asked anything.
    const result = spawnSync(process.execPath, [bundle, ...argv], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
  }
  const missing = await resolveConfig(repo, ['--dir', run, '--config', join(run, 'missing.yaml')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--config .*missing\.yaml does not exist\./);
  const noBase = await resolveConfig(repo, ['--dir', run], { github: fakeGitHub(repo, null) });
  assert.equal(noBase.code, 2);
  assert.match(noBase.stderr, /GitHub returned no base commit for acme\/api#12, so there is no trusted configuration to read\./);
  assert.equal(existsSync(join(run, 'config.yaml')), false);
});

const CANDIDATE = {
  candidate_id: 'cand_001',
  path: 'src/billing/charge.ts',
  line: 3,
  category: 'correctness',
  severity: 'minor',
  claim: 'The charge doubles the amount, so every customer pays twice the price shown.',
  failure_mode: 'A charge of 500 cents is taken as 1000.',
  evidence: ['src/billing/charge.ts:3 multiplies cents by 2.'],
  technical_confidence: 0.9,
};

/** What `diff`, `plan` and `score` say in the clone under `variables`, for the three settings the two configs disagree on. */
function stagesRead(repo, scratch, name, variables, trailing = []) {
  const out = join(scratch, name);
  stage(repo, scratch, ['diff', '--base', repo.base, '--out', out, ...trailing], variables);
  const files = join(out, 'files.json');
  const patch = join(out, 'diff.patch');
  const plan = JSON.parse(stage(repo, scratch, ['plan', '--files', files, '--diff-file', patch, ...trailing], variables).stdout);
  const verification = join(scratch, 'verification.json');
  writeFileSync(verification, JSON.stringify({ results: [{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9 }] }));
  const scored = JSON.parse(stage(repo, scratch, ['score', '--verification', verification, '--diff-file', patch, ...trailing], variables, JSON.stringify({ candidates: [CANDIDATE] })).stdout);
  return {
    sensitive: JSON.parse(readFileSync(files, 'utf8')).complexity.sensitivePaths,
    mode: plan.mode,
    eligible: scored.eligible.length,
    gate: scored.belowGate.map((entry) => entry.threshold),
  };
}

test('with the printed variables set, diff, plan and score read the base settings and not the head settings', async (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const scratch = temporary(t, 'rv-357-scratch-');
  const { code, stderr, json } = await resolveConfig(repo, ['--dir', run]);
  assert.equal(code, 0, stderr);

  assert.deepEqual(stagesRead(repo, scratch, 'trusted', variablesOf(json)), {
    sensitive: [CONFIG_FILE, 'src/billing/charge.ts'],
    mode: 'thorough',
    eligible: 0,
    gate: [0.95],
  });
});

test('with the defaults printed, the stage commands read the built-in defaults and not the head settings', async (t) => {
  const repo = repository(t, { baseConfig: null });
  const { code, stderr, json } = await resolveConfig(repo, ['--dir', temporary(t, 'rv-357-run-')]);
  assert.equal(code, 0, stderr);
  assert.equal(json.source, 'default');
  // No mode is configured, so auto picks one from the change; the head asked for fast and a 0.5 gate.
  assert.deepEqual(stagesRead(repo, temporary(t, 'rv-357-scratch-'), 'defaults', variablesOf(json)), {
    sensitive: [CONFIG_FILE],
    mode: 'thorough',
    eligible: 1,
    gate: [],
  });
});

test('a stage command run by hand in a checkout, with no variable set, keeps reading the checkout', (t) => {
  const repo = repository(t);
  const scratch = temporary(t, 'rv-357-scratch-');
  assert.deepEqual(stagesRead(repo, scratch, 'checkout', {}), { sensitive: [CONFIG_FILE], mode: 'fast', eligible: 1, gate: [] });
});

/** The challenge family `plan` names, and whether it warned that a runners block was ignored. */
function challengeFamily(repo, scratch, variables, trailing = []) {
  stage(repo, scratch, ['diff', '--base', repo.base, '--out', scratch, ...trailing], variables);
  const plan = stage(repo, scratch, ['plan', '--files', join(scratch, 'files.json'), '--diff-file', join(scratch, 'diff.patch'), ...trailing], variables);
  return { family: JSON.parse(plan.stdout).families.challenge, ruled: RULE.test(plan.stderr) };
}

test('a runners block the pull request adds is not honoured, at the head or at the base commit', async (t) => {
  // Only the head has it, and the file the stages read is the base copy, which has none.
  const headOnly = repository(t, { headConfig: RUNNERS });
  const headRun = temporary(t, 'rv-357-run-');
  const fromHead = await resolveConfig(headOnly, ['--dir', headRun]);
  assert.equal(fromHead.json.source, 'base');
  assert.doesNotMatch(readFileSync(fromHead.json.path, 'utf8'), /runners/);
  assert.deepEqual(challengeFamily(headOnly, temporary(t, 'rv-357-scratch-'), variablesOf(fromHead.json)), { family: 'claude', ruled: false });

  // The base has it. The source says the file is repository content, so the loader ignores the block and says why.
  const atBase = repository(t, { baseConfig: RUNNERS, headConfig: RUNNERS });
  const baseRun = temporary(t, 'rv-357-run-');
  const fromBase = await resolveConfig(atBase, ['--dir', baseRun]);
  assert.equal(fromBase.json.source, 'base');
  assert.equal(readFileSync(fromBase.json.path, 'utf8'), RUNNERS);
  assert.deepEqual(challengeFamily(atBase, temporary(t, 'rv-357-scratch-'), variablesOf(fromBase.json)), { family: 'claude', ruled: true });
  // Why the slash command sets both variables. The path with no source beside it reads as the operator file.
  assert.equal(challengeFamily(atBase, temporary(t, 'rv-357-scratch-'), { REVIEW_VOICE_CONFIG: fromBase.json.path }).family, 'codex');
});

test('a runners block in the file the operator named is honoured, by flag and by environment', async (t) => {
  const repo = repository(t);
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, RUNNERS);
  const byFlag = await resolveConfig(repo, ['--dir', temporary(t, 'rv-357-run-'), '--config', own]);
  const byEnv = await resolveConfig(repo, ['--dir', temporary(t, 'rv-357-run-')], { env: { REVIEW_VOICE_CONFIG: own } });
  assert.equal(byFlag.json.source, 'flag');
  assert.equal(byEnv.json.source, 'env');
  for (const resolved of [byFlag.json, byEnv.json]) {
    assert.deepEqual(challengeFamily(repo, temporary(t, 'rv-357-scratch-'), variablesOf(resolved)), { family: 'codex', ruled: false }, resolved.source);
  }
});

const CLEAN = 'No actionable findings.';
// What the base asks for: approval left to a person, and nothing posted.
const STRICT_VERDICT = ['verdict:', '  never_approve: true', 'writes:', '  github_posting_enabled: false', ''].join('\n');
const LOOSE_VERDICT = ['review:', '  human_review:', '    cap_approval: false', 'verdict:', '  never_approve: false', 'writes:', '  github_posting_enabled: true', ''].join('\n');

/** GitHub as `verdict` and `post` read it: the head unmoved, CI green, no earlier review. */
function greenGitHub(repo) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith('/graphql')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (pathname === '/user') return json({ login: 'your-github-login' });
    if (pathname === `/repos/${REPO}/pulls/${PR}`) return json({ number: PR, head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' } });
    if (pathname.endsWith('/reviews') || pathname.endsWith('/comments') || pathname.endsWith('/files')) return json([]);
    if (pathname.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    if (pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
}

test('with the printed variables set, verdict and post read the base settings, so the head cannot approve or post its own review', async (t) => {
  const repo = repository(t, { baseConfig: STRICT_VERDICT, headConfig: LOOSE_VERDICT });
  const data = temporary(t, 'rv-357-data-');
  const db = openDatabase(join(data, 'review-voice.db'));
  recordRun(db, { repository: REPO, baseRef: repo.base, headRef: repo.head, pullNumber: PR, diff: 'diff', output: CLEAN, scores: [] });
  db.close();
  const github = greenGitHub(repo);
  const resolved = await resolveConfig(repo, ['--dir', temporary(t, 'rv-357-run-')], { github });
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.equal(resolved.json.source, 'base');

  const target = ['--repository', REPO, '--pr', String(PR), '--head', repo.head];
  const run = async (command, variables) => {
    const result = await inClone(repo, [command, ...target, ...(command === 'post' ? ['--event', 'APPROVE'] : [])], { env: { REVIEW_VOICE_DATA_DIR: data, ...variables }, github, stdin: `${CLEAN}\n` });
    return { code: result.code, ...JSON.parse(result.stdout) };
  };

  // As commands/draft-review.md runs them, after its step 0.
  const verdict = await run('verdict', variablesOf(resolved.json));
  assert.equal(verdict.event, 'COMMENT', 'the base leaves approval to a person');
  assert.ok(verdict.reasons.includes('approval is left to a person by policy'), verdict.reasons.join('; '));
  const post = await run('post', variablesOf(resolved.json));
  assert.equal(post.code, 2);
  assert.deepEqual(post.reasons, ['writes.github_posting_enabled is false in .review-voice/config.yaml']);

  // Run by hand with neither variable, both read the checkout, which is why the document sets them.
  assert.equal((await run('verdict', {})).event, 'APPROVE');
  assert.deepEqual((await run('post', {})).reasons, ['no --confirm: nothing is posted without one, per post']);
});

test('the draft-review command resolves the configuration before the verdict and passes --trusted-config to verdict and post', () => {
  const text = readFileSync(join(plugin, 'commands/draft-review.md'), 'utf8');
  const start = text.indexOf('## 0 ');
  assert.ok(start >= 0, 'a step 0');
  const first = text.indexOf('## 1 ');
  assert.ok(start < first, 'before the verdict is computed');
  const step = text.slice(start, first).replace(/\s+/g, ' ');
  assert.match(step, /`RV config resolve --pr <number> --repository <owner\/repo> --dir <tmpdir>` before any other command/);
  assert.match(step, /`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/review-voice\.mjs" <command> \.\.\. --trusted-config <tmpdir>`/);
  assert.match(step, /writes both to `<tmpdir>\/trusted-config\.json`/);
  assert.match(step, /an option and not a variable prefix, so the `Bash\(node:\*\)` rule this command is allowed matches every one\./);
  assert.match(step, /every `RV` command below with `--trusted-config <tmpdir>` at the end/);
  assert.match(step, /`RV verdict`, `RV post`, the later `--recheck` and `RV anchors`/);
  assert.match(step, /the pull request's author wrote, so a verdict that read the checkout would let a change lift its own approval cap and switch posting on\./, 'says why');
  // Nothing after step 0 sends the reader back to the checkout for the verdict settings.
  assert.doesNotMatch(text.slice(first), /in `\.review-voice\/config\.yaml`/);
});

test('every command document that takes a pull request resolves the configuration before its stage commands', () => {
  const commands = join(plugin, 'commands');
  const taking = readdirSync(commands).filter((name) => name.endsWith('.md') && /--pr\b/.test(readFileSync(join(commands, name), 'utf8')));
  assert.deepEqual(taking.sort(), ['draft-review.md', 'review.md'], 'a new one needs a step 0 too, then a place in this list');
  for (const name of taking) {
    const text = readFileSync(join(commands, name), 'utf8');
    const resolve = text.indexOf('`RV config resolve --pr <number>');
    assert.ok(resolve >= 0, `${name} never resolves the configuration`);
    // The first stage command written out with its flags, fenced or inline, comes after it.
    const firstStage = text.search(/\bRV (?!config resolve)[a-z-]+ [^`\n]*--(?:pr|head|out)\b/);
    assert.ok(firstStage > resolve, `${name} runs a stage command before resolving the configuration`);
    // A variable prefix would not match the Bash(node:*) rule the document is allowed, so each stage would prompt.
    assert.match(text, /^allowed-tools: Bash\(node:\*\)/m, name);
    assert.ok(text.includes('--trusted-config <tmpdir>`'), `${name} does not pass --trusted-config to its stage commands`);
    for (const variable of VARIABLES) assert.ok(!text.includes(`${variable}=`), `${name} still sets ${variable} as a prefix`);
  }
});

test('the slash command resolves the configuration first on a pull request review and passes --trusted-config to its stage commands', () => {
  const text = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const start = text.indexOf('## Step 0');
  assert.ok(start >= 0, 'a step 0');
  const first = text.indexOf('## Step 1 ');
  assert.ok(start < first, 'before the diff is acquired');
  // Wrapped prose, so line breaks are not part of what is pinned.
  const step = text.slice(start, first).replace(/\s+/g, ' ');
  assert.match(step, /On a `--pr` run/);
  assert.match(step, /`RV config resolve --pr <number> --dir <tmpdir>`/);
  assert.match(step, /before any other command/);
  assert.match(step, /`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/review-voice\.mjs" <command> \.\.\. --trusted-config <tmpdir>`/);
  assert.match(step, /writes both to `<tmpdir>\/trusted-config\.json`/);
  assert.match(step, /an option and not a variable prefix, so the `Bash\(node:\*\)` rule this command is allowed matches every stage command\./);
  assert.match(step, /every `RV` command of this review with `--trusted-config <tmpdir>` at the end/);
  assert.match(step, /the pull request's author wrote, so a review that read the checkout would let a change choose the settings it is judged by\./, 'says why');
  assert.match(step, /Without `--pr`, skip this step and pass no `--trusted-config`/);
  // The two steps that run in the head worktree no longer say the checkout supplies their configuration.
  assert.doesNotMatch(text, /still comes from this checkout/);
});

test('the help for config and for review say where a pull request review gets its configuration', () => {
  const help = (command) => spawnSync(process.execPath, [bundle, command, '--help'], { encoding: 'utf8' }).stdout;
  const config = help('config');
  assert.match(config, /^review-voice config resolve --pr <n> --dir <dir> \[--repository owner\/repo\] \[--config <path>\]$/m);
  for (const word of ['REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_CONFIG_SOURCE', 'base commit', '{path, source, ref, notes}', '--trusted-config <dir>', 'trusted-config.json']) {
    assert.ok(config.includes(word), `config --help does not mention ${word}`);
  }
  assert.match(help('review'), /review-voice config resolve/);
  assert.match(spawnSync(process.execPath, [bundle, '--help'], { encoding: 'utf8' }).stdout, /^ {2}--trusted-config <dir> +On any command/m);
});

const TRUSTED = 'trusted-config.json';

/** `config resolve` from the built bundle, GitHub answered by a module loaded first, as a slash command runs it. */
function resolveFromBundleRaw(t, repo, dir, extra = [], variables = {}) {
  const fetchDir = temporary(t, 'rv-357-fetch-');
  const standIn = join(fetchDir, 'fetch.mjs');
  // The answer is data in a file of its own, so no value is spliced into the module's code.
  writeFileSync(join(fetchDir, 'pull.json'), JSON.stringify({ number: PR, head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' } }));
  writeFileSync(
    standIn,
    "import { readFileSync } from 'node:fs';\n" +
      "const body = readFileSync(new URL('./pull.json', import.meta.url), 'utf8');\n" +
      "globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });\n",
  );
  const env = { ...process.env, GITHUB_TOKEN: 't' };
  for (const name of VARIABLES) delete env[name];
  Object.assign(env, variables);
  const args = ['--import', pathToFileURL(standIn).href, bundle, 'config', 'resolve', '--pr', String(PR), '--repository', REPO, '--dir', dir, ...extra];
  return spawnSync(process.execPath, args, { cwd: repo.dir, encoding: 'utf8', env });
}

function resolveFromBundle(t, repo, dir, extra = [], variables = {}) {
  const result = resolveFromBundleRaw(t, repo, dir, extra, variables);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('config resolve from the built bundle writes trusted-config.json, private to the owner, holding the path and source it prints', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const printed = resolveFromBundle(t, repo, run);
  assert.equal(printed.source, 'base');
  const file = join(run, TRUSTED);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { path: printed.path, source: printed.source, sha256: sha256Of(printed.path) });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // A re-run into the same directory replaces it, and a refused one leaves none behind.
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, HEAD_CONFIG);
  resolveFromBundle(t, repo, run, ['--config', own]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { path: own, source: 'flag', sha256: sha256Of(own) });
  const refused = resolveFromBundleRaw(t, repo, run, ['--config', join(run, 'missing.yaml')]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(existsSync(file), false);
});

test('with --trusted-config, diff, plan and score read the base settings and not the head settings', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  resolveFromBundle(t, repo, run);
  assert.deepEqual(stagesRead(repo, temporary(t, 'rv-357-scratch-'), 'trusted', {}, ['--trusted-config', run]), {
    sensitive: [CONFIG_FILE, 'src/billing/charge.ts'],
    mode: 'thorough',
    eligible: 0,
    gate: [0.95],
  });

  // The defaults name a path with no file on purpose, and the option still takes it.
  const bare = repository(t, { baseConfig: null });
  const bareRun = temporary(t, 'rv-357-run-');
  assert.equal(resolveFromBundle(t, bare, bareRun).source, 'default');
  assert.deepEqual(stagesRead(bare, temporary(t, 'rv-357-scratch-'), 'defaults', {}, ['--trusted-config', bareRun]), {
    sensitive: [CONFIG_FILE],
    mode: 'thorough',
    eligible: 1,
    gate: [],
  });
});

test('a --trusted-config that cannot be trusted refuses the command with exit 2, names the problem and runs nothing', (t) => {
  const repo = repository(t);
  const config = join(temporary(t, 'rv-357-own-'), 'config.yaml');
  writeFileSync(config, BASE_CONFIG);
  const sha256 = sha256Of(config);
  const holding = (content) => {
    const dir = temporary(t, 'rv-357-run-');
    writeFileSync(join(dir, TRUSTED), typeof content === 'string' ? content : JSON.stringify(content));
    return dir;
  };
  const directory = temporary(t, 'rv-357-run-');
  mkdirSync(join(directory, TRUSTED));
  const shape = /must hold exactly \{"path", "source", "sha256"\}/;
  for (const [trailing, problem] of [
    [['--trusted-config'], /--trusted-config needs the directory config resolve wrote to\./],
    [['--trusted-config', '--json'], /--trusted-config needs the directory/],
    [['--trusted-config', temporary(t, 'rv-357-run-')], /trusted-config\.json does not exist\. Run review-voice config resolve/],
    [['--trusted-config', directory], /trusted-config\.json cannot be read/],
    [['--trusted-config', holding('not json')], shape],
    [['--trusted-config', holding([config, 'base'])], shape],
    [['--trusted-config', holding({ path: config })], shape],
    [['--trusted-config', holding({ path: config, source: 'base', ref: 'main' })], shape],
    [['--trusted-config', holding({ path: 7, source: 'base' })], shape],
    [['--trusted-config', holding({ path: config, source: 'operator', sha256 })], /names the source operator, which is not one of flag, env, checkout, base, default\./],
    [['--trusted-config', holding({ path: 'config.yaml', source: 'base', sha256 })], /names the path config\.yaml, which is not absolute\./],
    [['--trusted-config', holding({ path: join(dirname(config), 'missing.yaml'), source: 'base', sha256 })], /missing\.yaml, which is not a file\./],
    [['--trusted-config', holding({ path: dirname(config), source: 'flag', sha256 })], /which is not a file\./],
  ]) {
    const out = join(temporary(t, 'rv-357-scratch-'), 'out');
    const env = { ...process.env };
    for (const name of VARIABLES) delete env[name];
    const result = spawnSync(process.execPath, [bundle, 'diff', '--base', repo.base, '--out', out, ...trailing], { cwd: repo.dir, encoding: 'utf8', env });
    assert.equal(result.status, 2, `${trailing.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, problem);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(out), false, 'diff never ran');
  }
});

test('a command run without --trusted-config is unchanged, and the file alone changes nothing', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const printed = resolveFromBundle(t, repo, run);
  assert.ok(existsSync(join(run, TRUSTED)));
  assert.deepEqual(stagesRead(repo, temporary(t, 'rv-357-scratch-'), 'checkout', {}), { sensitive: [CONFIG_FILE], mode: 'fast', eligible: 1, gate: [] });
  assert.deepEqual(stagesRead(repo, temporary(t, 'rv-357-scratch-'), 'variables', variablesOf(printed)).mode, 'thorough');
  // An explicit --config still beats the environment the option sets.
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, HEAD_CONFIG);
  const other = temporary(t, 'rv-357-run-');
  assert.deepEqual(resolveFromBundle(t, repo, other, ['--config', own, '--trusted-config', run]), { path: own, source: 'flag', notes: [] });
});

test('a runners block only the head adds is not honoured through --trusted-config, and one at the base is ruled out', (t) => {
  const headOnly = repository(t, { headConfig: RUNNERS });
  const headRun = temporary(t, 'rv-357-run-');
  resolveFromBundle(t, headOnly, headRun);
  assert.deepEqual(challengeFamily(headOnly, temporary(t, 'rv-357-scratch-'), {}, ['--trusted-config', headRun]), { family: 'claude', ruled: false });

  const atBase = repository(t, { baseConfig: RUNNERS, headConfig: RUNNERS });
  const baseRun = temporary(t, 'rv-357-run-');
  resolveFromBundle(t, atBase, baseRun);
  assert.deepEqual(challengeFamily(atBase, temporary(t, 'rv-357-scratch-'), {}, ['--trusted-config', baseRun]), { family: 'claude', ruled: true });
});

/** `diff` from the built bundle with `trailing`, which must be refused with exit 2 before it writes anything. Returns stderr. */
function refusedStage(t, repo, trailing, variables = {}) {
  const out = join(temporary(t, 'rv-357-scratch-'), 'out');
  const env = { ...process.env };
  for (const name of VARIABLES) delete env[name];
  Object.assign(env, variables);
  const result = spawnSync(process.execPath, [bundle, 'diff', '--base', repo.base, '--out', out, ...trailing], { cwd: repo.dir, encoding: 'utf8', env });
  assert.equal(result.status, 2, `${trailing.join(' ')}: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(out), false, 'diff never ran');
  return result.stderr;
}

const writeManifest = (dir, manifest) => writeFileSync(join(dir, TRUSTED), JSON.stringify(manifest));

test('config resolve binds the base copy to its SHA-256 and the defaults to null, and stages still accept both', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const printed = resolveFromBundle(t, repo, run);
  assert.deepEqual(JSON.parse(readFileSync(join(run, TRUSTED), 'utf8')), { path: join(run, 'config.yaml'), source: 'base', sha256: sha256Of(join(run, 'config.yaml')) });
  assert.equal(stagesRead(repo, temporary(t, 'rv-357-scratch-'), 'base', {}, ['--trusted-config', run]).mode, 'thorough', printed.source);

  const bare = repository(t, { baseConfig: null });
  const bareRun = temporary(t, 'rv-357-run-');
  resolveFromBundle(t, bare, bareRun);
  assert.deepEqual(JSON.parse(readFileSync(join(bareRun, TRUSTED), 'utf8')), { path: join(bareRun, 'config.yaml'), source: 'default', sha256: null });
  assert.deepEqual(stagesRead(bare, temporary(t, 'rv-357-scratch-'), 'defaults', {}, ['--trusted-config', bareRun]).gate, []);
});

test('a manifest swapped to name the checkout file with a runners block as the flag source is refused and runs nothing', (t) => {
  const repo = repository(t, { headConfig: RUNNERS });
  const run = temporary(t, 'rv-357-run-');
  resolveFromBundle(t, repo, run);
  const checkout = join(repo.dir, CONFIG_FILE);
  writeManifest(run, { path: checkout, source: 'flag', sha256: sha256Of(checkout) });
  const stderr = refusedStage(t, repo, ['--trusted-config', run]);
  assert.match(stderr, /names the source flag, which it cannot confer, since the slash commands never pass --config\./);
});

test('config resolve with --config still prints the flag file and source, and its manifest is refused by every stage', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, RUNNERS);
  assert.deepEqual(resolveFromBundle(t, repo, run, ['--config', own]), { path: own, source: 'flag', notes: [] });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), /set REVIEW_VOICE_CONFIG to its absolute path before config resolve, or run review --pr --config <path>\./);
});

test('a manifest naming the source env is accepted only beside the operator own absolute REVIEW_VOICE_CONFIG for that path', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, RUNNERS);
  const other = join(temporary(t, 'rv-357-own-'), 'other.yaml');
  writeFileSync(other, RUNNERS);
  assert.equal(resolveFromBundle(t, repo, run, [], { REVIEW_VOICE_CONFIG: own }).source, 'env');
  const trailing = ['--trusted-config', run];
  const problem = /names the source env, which only the operator's own environment confers/;
  assert.match(refusedStage(t, repo, trailing), problem);
  assert.match(refusedStage(t, repo, trailing, { REVIEW_VOICE_CONFIG: other }), problem);
  assert.match(refusedStage(t, repo, trailing, { REVIEW_VOICE_CONFIG: own, REVIEW_VOICE_CONFIG_SOURCE: 'checkout' }), problem);

  // The operator's own shell set the variable, so its runners block is honoured.
  assert.deepEqual(challengeFamily(repo, temporary(t, 'rv-357-scratch-'), { REVIEW_VOICE_CONFIG: own }, trailing), { family: 'codex', ruled: false });
  assert.equal(challengeFamily(repo, temporary(t, 'rv-357-scratch-'), { REVIEW_VOICE_CONFIG: own, REVIEW_VOICE_CONFIG_SOURCE: 'env' }, trailing).family, 'codex');
});

test('a manifest naming the source checkout is refused, even with the variables it came from set', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const own = join(temporary(t, 'rv-357-own-'), 'own.yaml');
  writeFileSync(own, RUNNERS);
  const variables = { REVIEW_VOICE_CONFIG: own, REVIEW_VOICE_CONFIG_SOURCE: 'checkout' };
  assert.equal(resolveFromBundle(t, repo, run, [], variables).source, 'checkout');
  assert.match(refusedStage(t, repo, ['--trusted-config', run], variables), /names the source checkout, a file from a checkout, which is never trusted\./);
});

test('a copy whose bytes changed after config resolve is refused', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const { path } = resolveFromBundle(t, repo, run);
  writeFileSync(path, `${BASE_CONFIG}${RUNNERS}`);
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), /config\.yaml is not the file config resolve chose, since its SHA-256 differs/);
});

test('a file created at the path a default manifest names is refused, as is a default manifest with a hash', (t) => {
  const repo = repository(t, { baseConfig: null });
  const run = temporary(t, 'rv-357-run-');
  const { path, source } = resolveFromBundle(t, repo, run);
  assert.equal(source, 'default');
  writeFileSync(path, RUNNERS);
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), /names the built-in defaults at .*config\.yaml, where something now exists\./);

  rmSync(path);
  writeManifest(run, { path, source: 'default', sha256: sha256Of(join(repo.dir, CONFIG_FILE)) });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), /names the built-in defaults, so its sha256 must be null\./);
});

test('a manifest path that is a symbolic link or runs through one is refused', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const { path } = resolveFromBundle(t, repo, run);
  const sha256 = sha256Of(path);
  const problem = /which is a symbolic link, runs through one, or lies in no directory\./;

  const alias = join(run, 'alias.yaml');
  symlinkSync(path, alias);
  writeManifest(run, { path: alias, source: 'base', sha256 });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), problem);

  const linked = join(temporary(t, 'rv-357-link-'), 'run');
  symlinkSync(run, linked);
  writeManifest(run, { path: join(linked, 'config.yaml'), source: 'base', sha256 });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), problem);
});

test('a manifest with an extra key, with no sha256 or with a null sha256 for a copy is refused', (t) => {
  const repo = repository(t);
  const run = temporary(t, 'rv-357-run-');
  const { path } = resolveFromBundle(t, repo, run);
  const shape = /must hold exactly \{"path", "source", "sha256"\}/;
  writeManifest(run, { path, source: 'base', sha256: sha256Of(path), extra: true });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), shape);
  writeManifest(run, { path, source: 'base' });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), shape);
  writeManifest(run, { path, source: 'base', sha256: null });
  assert.match(refusedStage(t, repo, ['--trusted-config', run]), /its SHA-256 differs/);
});
