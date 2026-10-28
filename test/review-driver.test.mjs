/**
 * The review driver (docs/adr/0022): the whole pipeline in one call, run
 * in-process against a temporary repository, a stubbed GitHub and the fake
 * agent backend, plus the CLI surface and the stage table's agreement with
 * commands/review.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { heldForRecord, historyName, runReview, NO_FINDINGS } from '../plugins/review-voice/src/review/driver.ts';
import { STAGES } from '../plugins/review-voice/src/review/stages.ts';
import { SCHEMAS } from '../plugins/review-voice/src/review/prompts.ts';
import { RUNNER_PREAMBLE, schemaForRunner, schemasDir } from '../plugins/review-voice/src/agents/runner.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const REPO = 'acme/api';
const PR = 12;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const APP_BASE = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}', ''].join('\n');
const APP_HEAD = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price * item.qty;', '  return sum;', '}', ''].join('\n');

/** A clone with a base commit and a head commit, and the patch GitHub would serve for each file. */
function repository(t, change) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-driver-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/app.ts'), APP_BASE);
  writeFileSync(join(dir, 'README.md'), '# Api\n\nSums prices.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'feature');
  for (const [path, content] of Object.entries(change)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  const files = Object.keys(change).map((path) => {
    const patch = git('diff', base, head, '--', path);
    const body = patch.slice(patch.indexOf('@@'));
    const additions = body.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = body.split('\n').filter((line) => line.startsWith('-')).length;
    return { filename: path, status: 'modified', additions, deletions, changes: additions + deletions, patch: body };
  });
  return { dir, base, head, files };
}

/** GitHub as the commands read it. `moved()` turns the head into another commit. */
function fakeGitHub(repo, { description = '', moved = () => false, comments = () => [] } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push({ method, path: parsed.pathname });
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (method === 'POST') return json({ id: 9, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-9`, state: 'COMMENTED' });
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({
        number: PR,
        title: 'Count quantities in the total',
        body: description,
        user: { login: 'an-author' },
        head: { sha: moved() ? 'f'.repeat(40) : repo.head, ref: 'feature' },
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
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}/comments`) return json(comments());
    if (/\/(comments|reviews|events)$/.test(parsed.pathname)) return json([]);
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const CANDIDATE = {
  candidate_id: 'cand_001',
  path: 'src/app.ts',
  line: 3,
  category: 'correctness',
  severity: 'minor',
  claim: 'The total now multiplies by qty, which is undefined for items created before qty existed.',
  failure_mode: 'Old cart items produce NaN totals.',
  evidence: ['src/app.ts:3 multiplies by item.qty without a default.'],
  technical_confidence: 0.9,
};
const VERIFIED = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.95, reason: 'qty is optional in the item type.' };
const confirmed = { candidate_id: 'cand_001', verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/app.ts:3'], reason: '' };
const refuted = { candidate_id: 'cand_001', verdict: 'refuted', line_ok: true, decisive_evidence: ['src/app.ts:3'], reason: 'Every item gets a qty when it is created.' };

/** Writes the fake agents' canned outputs: `{ 'diff-analyst': [out1, out2], ... }`, an Error for a failed call. */
function fakes(t, outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-driver-fakes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [agent, answers] of Object.entries(outputs)) {
    answers.forEach((answer, index) => {
      const body = answer instanceof Error ? { error: answer.message } : { output: answer };
      writeFileSync(join(dir, `${agent}.${index + 1}.json`), JSON.stringify(body));
    });
  }
  return dir;
}

function callsOf(fakeDir, agent) {
  const calls = join(fakeDir, '.calls');
  if (!existsSync(calls)) return [];
  return readdirSync(calls)
    .filter((name) => name.startsWith(`${agent}.`) && name.endsWith('.spec.json'))
    .map((name) => ({
      spec: JSON.parse(readFileSync(join(calls, name), 'utf8')),
      prompt: readFileSync(join(calls, name.replace('.spec.json', '.prompt.txt')), 'utf8'),
    }));
}

function allPrompts(fakeDir) {
  const calls = join(fakeDir, '.calls');
  return existsSync(calls) ? readdirSync(calls).filter((name) => name.endsWith('.prompt.txt')).map((name) => readFileSync(join(calls, name), 'utf8')) : [];
}

/** Runs the driver in the clone, with its own data directory, GitHub stub and fake agents. */
async function review(t, repo, fakeDir, github, options = {}) {
  const data = mkdtempSync(join(tmpdir(), 'rv-driver-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  return { report: await reviewIn(repo, fakeDir, github, data, options), data };
}

function assertWorktreeGone(repo, report) {
  const head = join(report.runDir, 'head');
  assert.equal(existsSync(head), false, 'the head worktree is removed');
  assert.ok(!execFileSync('git', ['worktree', 'list'], { cwd: repo.dir, encoding: 'utf8' }).includes(head));
}

function runCount(data) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n;
  } finally {
    db.close();
  }
}

test('schemas: every envelope the driver gives the runner resolves', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    assert.doesNotThrow(() => schemaForRunner(schema, schemasDir()), name);
  }
});

test('(a) a clean run renders exactly the no-findings sentence and plans an approval', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, { 'diff-analyst': [{ candidates: [], toolCalls: 4, filesRead: 2 }] });
  const { report, data } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  assert.equal(readFileSync(join(report.runDir, 'review.txt'), 'utf8'), `${NO_FINDINGS}\n`);
  assert.equal(report.verdict.event, 'APPROVE');
  assert.equal(report.posted, false);
  assert.equal(runCount(data), 1);
  assert.deepEqual(callsOf(fakeDir, 'evidence-verifier'), [], 'no verifier for no candidates');
  const analyst = report.stages.find((stage) => stage.name === 'analyst');
  assert.equal(analyst.toolCalls, 4);
  assert.equal(analyst.model, 'sonnet');
});

test('(b) a finding the challenger confirms is rendered and recorded', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [CANDIDATE] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    challenger: [{ verdicts: [confirmed] }],
    'concise-editor': [{ text: '[minor] `src/app.ts:3` - The total multiplies by qty, which is undefined for items created before qty existed.' }],
  });
  const { report, data } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].path, 'src/app.ts');
  assert.equal(report.findings[0].line, 3);
  assert.equal(report.verdict.event, 'COMMENT');
  assert.equal(runCount(data), 1);
  assert.equal(callsOf(fakeDir, 'challenger').length, 1);
  const challengePrompt = callsOf(fakeDir, 'challenger')[0].prompt;
  assert.ok(!challengePrompt.includes('qty is optional'), "the challenger never sees the verifier's reasoning");
});

test('(c) a finding the challenger refutes is held, not rendered', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [CANDIDATE] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    challenger: [{ verdicts: [refuted] }],
  });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  assert.deepEqual(report.findings, []);
  assert.equal(readFileSync(join(report.runDir, 'review.txt'), 'utf8'), `${NO_FINDINGS}\n`);
  const held = report.held.find((entry) => entry.verdict === 'challenge-refuted');
  assert.ok(held, JSON.stringify(report.held));
  assert.equal(held.reason, refuted.reason);
  assert.deepEqual(callsOf(fakeDir, 'concise-editor'), [], 'nothing to edit');
  const recorded = JSON.parse(readFileSync(join(report.runDir, 'held.json'), 'utf8'));
  assert.ok(recorded.some((entry) => entry.verdict === 'challenge-refuted'));
});

test('(d) an analyst shape error is relaunched once with the refusal, then accepted', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [{ title: 'wrong shape', location: 'src/app.ts:3' }] }, { candidates: [] }],
  });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  const calls = callsOf(fakeDir, 'diff-analyst');
  assert.equal(calls.length, 2);
  assert.match(calls.find((call) => call.prompt.includes('previous answer was refused')).prompt, /Malformed candidate/);
});

test('a candidate off the diff goes back alone to be re-anchored, then passes', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, { 'diff-analyst': [{ candidates: [{ ...CANDIDATE, line: 1 }] }, { candidates: [] }] });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  const resent = callsOf(fakeDir, 'diff-analyst').find((call) => call.prompt.includes('failed the check'));
  assert.ok(resent, 'the failing candidate was sent back');
  assert.match(resent.prompt, /"line": 1/);
  assert.equal(JSON.parse(readFileSync(join(report.runDir, 'checked.json'), 'utf8')).kept.length, 0, 'withdrawn');
});

test('(e) an analyst that fails twice stops the run with exit 7 and records nothing', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, { 'diff-analyst': [new Error('model refused'), new Error('model refused again')] });
  const { report, data } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 7);
  assert.equal(report.runId, null);
  assert.equal(runCount(data), 0);
  assert.ok(existsSync(join(report.runDir, 'diff.patch')), 'the run directory stays for a resume by hand');
  assertWorktreeGone(repo, report);
});

test('(f) an unchanged scope carries the earlier run without calling an agent', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const github = fakeGitHub(repo);
  const data = mkdtempSync(join(tmpdir(), 'rv-driver-shared-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const one = await reviewIn(repo, fakes(t, { 'diff-analyst': [{ candidates: [] }] }), github, data);
  assert.equal(one.exitCode, 0, one.error);

  // The base branch moves on and is merged in: a new head with the same own diff.
  const git = (...args) => execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' });
  writeFileSync(join(repo.dir, 'README.md'), '# Api\n\nSums prices, now documented.\n');
  git('commit', '-q', '-am', 'docs on main');
  repo.base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--no-edit', 'main');
  repo.head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');

  const second = fakes(t, {});
  const two = await reviewIn(repo, second, github, data);
  assert.equal(two.exitCode, 0, `${two.error} ${JSON.stringify(two.notes)}`);
  assert.equal(two.scope.kind, 'unchanged');
  assert.equal(two.carried, true);
  assert.equal(allPrompts(second).length, 0, 'no agent was called');
  assert.equal(readFileSync(join(two.runDir, 'review.txt'), 'utf8'), `${NO_FINDINGS}\n`);
  assert.equal(runCount(data), 2);
});

/** Like review(), but on a given data directory, so runs can follow one another. */
async function reviewIn(repo, fakeDir, github, data, options = {}) {
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakeDir, GITHUB_TOKEN: 't' });
  try {
    return await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false, ...options },
      {
        command: (argv, stdin) => runInProcess(argv, { stdin, fetchImpl: github }),
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    );
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_FAKE_AGENTS', 'GITHUB_TOKEN']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  }
}

test('(g) a head that moves before record stops with exit 3 and records nothing', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, { 'diff-analyst': [{ candidates: [] }] });
  const github = fakeGitHub(repo, { moved: () => existsSync(join(fakeDir, '.calls', 'diff-analyst.count')) });
  const { report, data } = await review(t, repo, fakeDir, github);
  assert.equal(report.exitCode, 3, report.error);
  assert.equal(runCount(data), 0);
  assert.ok(existsSync(join(report.runDir, 'review.txt')), 'the run directory stays');
  assertWorktreeGone(repo, report);
});

test('(h) fast mode on a docs-only change runs no other lane and no challenger for a nit', async (t) => {
  const repo = repository(t, { 'README.md': '# Api\n\nSums prices and quantities.\n' });
  mkdirSync(join(repo.dir, '.review-voice'));
  writeFileSync(
    join(repo.dir, '.review-voice', 'config.yaml'),
    'review:\n  lanes:\n    - name: structure\n      agent: structure-analyst\n      prefix: st_\n      when: { min_changed_source_lines: 0, exclude_kinds: [] }\n',
  );
  const nit = {
    ...CANDIDATE,
    path: 'README.md',
    line: 3,
    category: 'style',
    severity: 'nit',
    claim: 'The sentence says quantities but the function name still says total.',
    failure_mode: 'Readers look for a quantity helper that does not exist.',
    evidence: ['README.md:3 mentions quantities.'],
  };
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [nit] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    'concise-editor': [{ text: '[nit] `README.md:3` - The sentence says quantities but the function name still says total.' }],
  });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.plan.mode, 'fast');
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  const scores = JSON.parse(readFileSync(join(report.runDir, 'scores.json'), 'utf8'));
  assert.equal(scores.eligible.length, 1, 'the nit is eligible, so only the mode kept the challenger away');
  const lanes = JSON.parse(readFileSync(join(report.runDir, 'lanes.json'), 'utf8'));
  assert.ok(lanes.find((entry) => entry.lane.name === 'structure').eligible, 'the structure lane was eligible');
  assert.deepEqual(callsOf(fakeDir, 'structure-analyst'), []);
  assert.deepEqual(callsOf(fakeDir, 'challenger'), []);
  assert.equal(report.findings.length, 1);
  assert.ok(report.stages.some((stage) => stage.name === 'challenge' && stage.skipped !== undefined));
});

test('(i, j) agents run in the head worktree, which is removed; base and history exist; no prompt asks for git', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const description = 'Multiply each price by its quantity so the total is right.';
  const fakeDir = fakes(t, {
    'intent-extractor': [{ statements: [{ id: 'int_001', kind: 'goal', statement: 'Multiply each price by its quantity', quote: description }] }],
    'diff-analyst': [{ candidates: [CANDIDATE] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    challenger: [{ verdicts: [confirmed] }],
    'concise-editor': [{ text: '[minor] `src/app.ts:3` - The total multiplies by qty, which is undefined for items created before qty existed.' }],
  });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo, { description }));
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  const head = join(report.runDir, 'head');
  const agents = ['intent-extractor', 'diff-analyst', 'evidence-verifier', 'challenger', 'concise-editor'];
  for (const agent of agents) {
    const calls = callsOf(fakeDir, agent);
    assert.equal(calls.length, 1, agent);
    assert.equal(calls[0].spec.cwd, head, `${agent} runs in the head worktree`);
    assert.deepEqual(calls[0].spec.addDirs, [report.runDir]);
  }
  assert.ok(callsOf(fakeDir, 'diff-analyst')[0].prompt.includes(join(report.runDir, 'intent.json')));
  assert.equal(existsSync(head), false, 'the worktree is removed');
  assert.ok(!execFileSync('git', ['worktree', 'list'], { cwd: repo.dir, encoding: 'utf8' }).includes(head));
  assert.equal(readFileSync(join(report.runDir, 'base', 'src', 'app.ts'), 'utf8'), APP_BASE);
  assert.match(readFileSync(join(report.runDir, 'history', 'src%2Fapp.ts.txt'), 'utf8'), /head/);
  const prompts = allPrompts(fakeDir);
  assert.equal(prompts.length, agents.length);
  for (const prompt of prompts) {
    assert.ok(prompt.startsWith(RUNNER_PREAMBLE), 'every prompt opens with the runner preamble');
    assert.match(prompt, /Shell and git are not available/);
    const own = prompt.slice(RUNNER_PREAMBLE.length);
    assert.doesNotMatch(own, /\bgit |\bshell\b|run the command/i, 'and nothing after it asks for a shell');
  }
});

test('--post sends the verdict once posting is enabled, and the JSON report keeps its shape', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  mkdirSync(join(repo.dir, '.review-voice'));
  writeFileSync(join(repo.dir, '.review-voice', 'config.yaml'), 'writes:\n  github_posting_enabled: true\n');
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [CANDIDATE] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    challenger: [{ verdicts: [confirmed] }],
    'concise-editor': [{ text: '[minor] `src/app.ts:3` - The total multiplies by qty, which is undefined for items created before qty existed.' }],
  });
  const github = fakeGitHub(repo);
  const { report } = await review(t, repo, fakeDir, github, { post: true });
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.equal(report.posted, true);
  assert.equal(report.reviewUrl, `https://github.com/${REPO}/pull/${PR}#pullrequestreview-9`);
  assert.equal(github.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/reviews')).length, 1);
  assert.match(readFileSync(join(report.runDir, 'commands.log'), 'utf8'), /\$ review-voice post .* --recheck-thread/, 'the thread re-check is on by default');

  // A watcher and the Action parse these names.
  for (const key of ['runId', 'head', 'scope', 'plan', 'findings', 'held', 'verdict', 'posted', 'carried', 'reviewUrl', 'costUsd', 'seconds', 'stages']) {
    assert.ok(Object.hasOwn(report, key), `report has ${key}`);
  }
  assert.equal(typeof report.runId, 'string');
  assert.equal(report.head, repo.head);
  assert.equal(typeof report.scope.kind, 'string');
  assert.equal(report.plan.mode, 'standard');
  assert.ok(report.plan.stages.challenge.run);
  for (const finding of report.findings) {
    assert.deepEqual(
      ['path', 'line', 'severity', 'text'].map((key) => typeof finding[key]),
      ['string', 'number', 'string', 'string'],
    );
  }
  assert.ok(Array.isArray(report.held));
  for (const key of ['event', 'action', 'annotations', 'carriedReviewUrl']) assert.ok(Object.hasOwn(report.verdict, key), `verdict has ${key}`);
  assert.equal(report.carried, false);
  assert.equal(report.costUsd, null, 'the fake backend reports no cost');
  assert.equal(typeof report.seconds, 'number');
  assert.ok(report.stages.every((stage) => typeof stage.name === 'string' && typeof stage.seconds === 'number'));
  const recorded = JSON.parse(readFileSync(join(report.runDir, 'stages.json'), 'utf8'));
  assert.deepEqual(recorded.map((stage) => stage.name), ['analyst', 'verifier', 'challenge', 'editor']);
  assert.ok(recorded.every((stage) => stage.model === 'sonnet'));
});

test('review --help and bad invocations', () => {
  const run = (args) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'rv-driver-cli-')) } });
  const help = run(['review', '--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.startsWith('review-voice review --pr <n>'));
  assert.match(help.stdout, /7 an agent failed twice/);
  assert.match(run(['--help']).stdout, /^ {2}review {15}Review one pull request end to end/m);
  for (const args of [['review'], ['review', '--pr', 'x'], ['review', '--pr', '3', '--mode', 'cheap'], ['review', '--pr', '3', '--out']]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
  }
});

test('every agent commands/review.md launches has a stage, and every stage agent is in review.md', () => {
  const text = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const launched = new Set([...text.matchAll(/[Ll]aunch (?:the |a fresh )?`([a-z-]+)`/g)].map((match) => match[1]));
  const staged = new Set(STAGES.flatMap((stage) => stage.agents));
  assert.ok(launched.size >= 5, [...launched].join(', '));
  for (const agent of launched) assert.ok(staged.has(agent), `review.md launches ${agent}, which no stage runs`);
  for (const agent of staged) assert.ok(launched.has(agent), `a stage runs ${agent}, which review.md never launches`);
});

const RENDERED = '[minor] `src/app.ts:3` - The total multiplies by qty, which is undefined for items created before qty existed.';
const fullRun = (extra = {}) => ({
  'diff-analyst': [{ candidates: [CANDIDATE] }],
  'evidence-verifier': [{ verifications: [VERIFIED] }],
  challenger: [{ verdicts: [confirmed] }],
  'concise-editor': [{ text: RENDERED }],
  ...extra,
});

/** Runs with extra environment variables set for the duration. */
async function withEnv(vars, body) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the head checkout runs no repository code: a clone-level post-checkout hook does not fire', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const hooks = mkdtempSync(join(tmpdir(), 'rv-driver-hooks-'));
  t.after(() => rmSync(hooks, { recursive: true, force: true }));
  const marker = join(hooks, 'ran');
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: repo.dir });
  const { report } = await review(t, repo, fakes(t, { 'diff-analyst': [{ candidates: [] }] }), fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  assert.equal(existsSync(marker), false, 'the hook did not run');
});

test('a SIGTERM to a running review stops the agent, removes the worktree and exits 143', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const work = mkdtempSync(join(tmpdir(), 'rv-driver-signal-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const started = join(work, 'agent-started');
  const sleeper = join(work, 'claude');
  writeFileSync(sleeper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const src = (path) => JSON.stringify(new URL(`../plugins/review-voice/src/${path}`, import.meta.url).href);
  const script = join(work, 'run.mjs');
  writeFileSync(
    script,
    `import { runInProcess } from ${src('cli.ts')};
import { runReview } from ${src('review/driver.ts')};
import { GitHubClient } from ${src('github/client.ts')};
const repo = ${JSON.stringify({ head: repo.head, base: repo.base, files: repo.files })};
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const github = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  if ((init.method ?? 'GET') === 'POST') return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
  if (path === '/repos/${REPO}/pulls/${PR}') return json({ title: 't', body: '', user: { login: 'a' }, head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' }, changed_files: 1, commits: 1 });
  if (path === '/repos/${REPO}/pulls/${PR}/files') return json(repo.files);
  if (path === '/user') return json({ login: 'me' });
  if (/(comments|reviews|events)$/.test(path)) return json([]);
  return new Response('not found', { status: 404 });
};
await runReview(
  { repository: '${REPO}', pullNumber: ${PR}, post: false, out: null, since: null, full: false },
  { command: (argv, stdin) => runInProcess(argv, { stdin, fetchImpl: github }), client: new GitHubClient({ allowlist: ['${REPO}'], token: 't', fetchImpl: github }) },
);
`,
  );
  const data = join(work, 'data');
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_CLAUDE_BIN: sleeper, GITHUB_TOKEN: 't' };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [script], { cwd: repo.dir, env, stdio: 'ignore' });
  const exited = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })));
  for (let waited = 0; !existsSync(started); waited += 50) {
    assert.ok(waited < 30000, 'the agent never started');
    await new Promise((r) => setTimeout(r, 50));
  }
  const agentPid = Number(readFileSync(started, 'utf8'));
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  const runs = readdirSync(join(data, 'runs'));
  assert.equal(runs.length, 1);
  const head = join(data, 'runs', runs[0], 'head');
  assert.equal(existsSync(head), false, 'the worktree is removed');
  assert.ok(!execFileSync('git', ['worktree', 'list'], { cwd: repo.dir, encoding: 'utf8' }).includes(head));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(agentPid, 0), 'the agent process is gone');
});

test('--expect-head stops at once with exit 3 when the pull request is elsewhere', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, {});
  const { report, data } = await review(t, repo, fakeDir, fakeGitHub(repo), { expectHead: 'e'.repeat(40) });
  assert.equal(report.exitCode, 3);
  assert.match(report.error, /not the expected e{40}/);
  assert.equal(report.runDir, null);
  assert.equal(allPrompts(fakeDir).length, 0);
  assert.equal(runCount(data), 0);
  const same = await review(t, repo, fakes(t, { 'diff-analyst': [{ candidates: [] }] }), fakeGitHub(repo), { expectHead: repo.head });
  assert.equal(same.report.exitCode, 0, same.report.error);
});

function commandsConfig(repo) {
  mkdirSync(join(repo.dir, '.review-voice'));
  writeFileSync(
    join(repo.dir, '.review-voice', 'config.yaml'),
    [
      'static_evidence:',
      '  enabled: true',
      '  commands:',
      "    - { name: mark, run: 'touch evidence-ran' }",
      'verification:',
      '  enabled: true',
      `  command: "touch verify-ran; echo '{\\"verdict\\":\\"confirmed\\",\\"confidence\\":0.9,\\"reason\\":\\"holds\\"}'"`,
      '',
    ].join('\n'),
  );
}

test('REVIEW_VOICE_NO_COMMANDS=1 skips the static evidence and second-pass commands, and says so', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  commandsConfig(repo);
  const { report } = await withEnv({ REVIEW_VOICE_NO_COMMANDS: '1' }, () => review(t, repo, fakes(t, fullRun()), fakeGitHub(repo)));
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.equal(report.plan.stages['second-pass'].run, true, 'the plan would have run it');
  assert.equal(existsSync(join(repo.dir, 'evidence-ran')), false);
  assert.equal(existsSync(join(repo.dir, 'verify-ran')), false);
  assert.ok(report.notes.some((note) => /NO_COMMANDS.*static evidence/.test(note)));
  assert.ok(report.notes.some((note) => /NO_COMMANDS.*second-pass/.test(note)));
  assert.ok(!readFileSync(join(report.runDir, 'commands.log'), 'utf8').includes('$ review-voice evidence'));
});

test('the second pass writes its first reconcile to disk, and the challenge stage records every model', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  commandsConfig(repo);
  const { report } = await review(t, repo, fakes(t, fullRun()), fakeGitHub(repo));
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.ok(existsSync(join(repo.dir, 'verify-ran')), 'the second pass ran');
  const reconciled = JSON.parse(readFileSync(join(report.runDir, 'reconcile.json'), 'utf8'));
  assert.ok(Array.isArray(reconciled.candidates) && Array.isArray(reconciled.disputes));
  const stages = JSON.parse(readFileSync(join(report.runDir, 'stages.json'), 'utf8'));
  assert.deepEqual(stages.find((stage) => stage.name === 'challenge').models, ['sonnet']);
});

test('history and base copies never collide: `a` and `a.txt/b` in one pull request', async (t) => {
  const repo = repository(t, { a: 'one\ntwo\n', 'a.txt/b': 'three\n' });
  const { report } = await review(t, repo, fakes(t, { 'diff-analyst': [{ candidates: [] }] }), fakeGitHub(repo));
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.ok(existsSync(join(report.runDir, 'history', historyName('a'))));
  assert.ok(existsSync(join(report.runDir, 'history', historyName('a.txt/b'))));
  assert.notEqual(historyName('a'), historyName('a.txt/b'));
});

test('held entries without a line move to their file\'s first changed line, or stay local with a note', () => {
  const diff = ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -3,1 +3,1 @@', '-old', '+new', ''].join('\n');
  const entry = (path, line) => ({ path, line, verdict: 'below-gate', source: 'score', reason: 'below the score gate' });
  const result = heldForRecord([entry('src/app.ts', 3), entry('src/app.ts', null), entry('src/app.ts', Number.NaN), entry('docs/other.md', null)], diff);
  assert.deepEqual(result.held.map((held) => held.line), [3, 3, 3]);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /^heldUnanchored: docs\/other\.md/);
});

test('a refused candidate that matches no id still goes back to its lane by its anchor', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const { candidate_id: _id, ...unnamed } = CANDIDATE;
  const fakeDir = fakes(t, { 'diff-analyst': [{ candidates: [{ ...unnamed, line: 1 }] }, { candidates: [] }] });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  assert.equal(callsOf(fakeDir, 'diff-analyst').length, 2, 'the promised relaunch happened');
});

test('#207: in fast mode a corrected line cannot land on an unchallenged nit', async (t) => {
  const head = APP_BASE.replace('let sum = 0;', 'let sum = 0.0;').replace('item.price;', 'item.price * item.qty;');
  const repo = repository(t, { 'src/app.ts': head });
  const minor = { ...CANDIDATE, line: 2, claim: 'The sum starts as a float literal, which hides integer cents.', failure_mode: 'Totals drift by fractions.', evidence: ['src/app.ts:2 starts at 0.0.'] };
  const nit = { ...CANDIDATE, candidate_id: 'cand_002', category: 'style', severity: 'nit', claim: 'The loop body is long enough to want a name.', failure_mode: 'Harder to scan.', evidence: ['src/app.ts:3 is a long line.'] };
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [minor, nit] }],
    'evidence-verifier': [{ verifications: [VERIFIED, { ...VERIFIED, candidate_id: 'cand_002' }] }],
    challenger: [{ verdicts: [{ candidate_id: 'cand_001', verdict: 'confirmed', line_ok: false, corrected_line: 3, decisive_evidence: ['src/app.ts:3'], reason: '' }] }],
    'concise-editor': [{ text: '[nit] `src/app.ts:3` - The loop body is long enough to want a name.' }],
  });
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo), { mode: 'fast' });
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  const scores = JSON.parse(readFileSync(join(report.runDir, 'scores.json'), 'utf8'));
  assert.equal(scores.eligible.length, 2, 'both were eligible');
  assert.equal(callsOf(fakeDir, 'challenger').length, 1, 'only the minor was challenged');
  const held = report.held.find((entry) => entry.candidateId === 'cand_001');
  assert.equal(held?.verdict, 'challenge-partly');
  assert.match(held.reason, /cand_002 is already anchored at src\/app\.ts:3/);
  assert.deepEqual(report.findings.map((finding) => `${finding.severity} ${finding.line}`), ['nit 3']);
});

test('a challenger that fails twice holds its finding', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const fakeDir = fakes(t, fullRun({ challenger: [new Error('overloaded'), new Error('overloaded')] }));
  const { report } = await review(t, repo, fakeDir, fakeGitHub(repo));
  assert.equal(report.exitCode, 0, report.error);
  assert.deepEqual(report.findings, []);
  const held = report.held.find((entry) => entry.verdict === 'challenge-partly');
  assert.match(held.reason, /^challenger failed: /);
});

test('an editor that fails validation twice stops with exit 7 and records nothing', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  const wrong = { text: RENDERED.replace('[minor]', '[blocking]') };
  const { report, data } = await review(t, repo, fakes(t, fullRun({ 'concise-editor': [wrong, wrong] })), fakeGitHub(repo));
  assert.equal(report.exitCode, 7);
  assert.equal(runCount(data), 0);
  assertWorktreeGone(repo, report);
});

test('exit 8 from post, a point raised on the thread during the run, surfaces as exit 8', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD });
  mkdirSync(join(repo.dir, '.review-voice'));
  writeFileSync(join(repo.dir, '.review-voice', 'config.yaml'), 'writes:\n  github_posting_enabled: true\n');
  const fakeDir = fakes(t, fullRun());
  const raised = {
    id: 501,
    user: { login: 'another-reviewer' },
    body: CANDIDATE.claim,
    path: 'src/app.ts',
    line: 3,
    created_at: '2099-01-01T00:00:00Z',
    html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r501`,
  };
  const github = fakeGitHub(repo, { comments: () => (existsSync(join(fakeDir, '.calls', 'concise-editor.count')) ? [raised] : []) });
  const { report } = await review(t, repo, fakeDir, github, { post: true });
  assert.equal(report.exitCode, 8, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.equal(report.posted, false);
  assert.equal(github.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/reviews')).length, 0);
});
