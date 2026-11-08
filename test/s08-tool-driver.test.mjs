import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runReview, NO_FINDINGS } from '../plugins/review-voice/src/review/driver.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { runDetail } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const REPO = 'acme/api';
const PR = 12;
const CLAIM = 'Optional quantity produces invalid cart totals for existing items.';
const MESSAGE = `TS2345: ${CLAIM}`;
const SIGNAL_LINE = `src/app.ts(1,1): error ${MESSAGE}`;
const CANDIDATE = {
  candidate_id: 'cand_001', path: 'src/app.ts', line: 3,
  category: 'correctness', severity: 'minor', claim: CLAIM, failure_mode: CLAIM,
  evidence: ['src/app.ts:3 multiplies by an optional quantity.'], technical_confidence: 0.9,
};
const EXPECTED_HELD = {
  candidateId: 'cand_001', path: 'src/app.ts', line: 3, verdict: 'restates-tool',
  source: 'typecheck', reason: `line 1: ${MESSAGE}`, text: CLAIM,
};

function temporary(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repository(t) {
  const dir = temporary(t, 'rv-s08-driver-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify({
    static_evidence: { enabled: true, commands: [
      { name: 'typecheck', run: `printf '%s\\n' '${SIGNAL_LINE}'; touch typecheck-ran`, version: 'touch typecheck-version-ran; printf "tool 1.2\\n"' },
      { name: 'lint', run: 'touch lint-ran', version: 'touch lint-version-ran' },
    ] },
  }));
  const baseText = 'export function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}\n';
  writeFileSync(join(dir, 'src/app.ts'), baseText);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'src/app.ts'), baseText.replace('item.price;', 'item.price * item.qty;'));
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const patch = git('diff', base, head, '--', 'src/app.ts');
  return { dir, base, head, files: [{
    filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2,
    patch: patch.slice(patch.indexOf('@@')),
  }] };
}

function fakeGitHub(repo) {
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/graphql' && init.method === 'POST') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    assert.equal(init.method ?? 'GET', 'GET', 'The fixture must never post a review.');
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({
      number: PR, title: 'Count quantities in the total', body: '', user: { login: 'an-author' },
      head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' },
      changed_files: 1, commits: 1, additions: 1, deletions: 1,
    });
    if (path === `/repos/${REPO}/pulls/${PR}/files`) return json(repo.files);
    if (path === '/user') return json({ login: 'your-github-login' });
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [
      { id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' },
    ] });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(path)) return json([]);
    return new Response('not found', { status: 404 });
  };
}

async function review(t, noCommands) {
  const repo = repository(t);
  const data = temporary(t, 'rv-s08-driver-data-');
  const fakes = temporary(t, 'rv-s08-driver-agents-');
  writeFileSync(join(fakes, 'diff-analyst.1.json'), JSON.stringify({ output: { candidates: noCommands ? [] : [CANDIDATE] } }));
  const env = {
    REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakes,
    REVIEW_VOICE_NO_COMMANDS: noCommands ? '1' : '0', GITHUB_TOKEN: 't',
    // The audit probe must not launch an installed agent CLI during this fixture.
    REVIEW_VOICE_CLAUDE_BIN: join(fakes, 'absent-claude'),
  };
  const saved = { cwd: process.cwd(), env: Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])) };
  const calls = [];
  const github = fakeGitHub(repo);
  process.chdir(repo.dir);
  Object.assign(process.env, env);
  try {
    const report = await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false },
      {
        command: (argv, stdin) => {
          calls.push(argv);
          if (argv[0] === 'check-candidates' || argv[0] === 'evidence') {
            // These public interfaces must exercise the shipped bundle with an isolated store on every call.
            const result = spawnSync(process.execPath, [bundle, ...argv], {
              cwd: repo.dir, input: stdin, encoding: 'utf8',
              env: { ...process.env, REVIEW_VOICE_DATA_DIR: temporary(t, 'rv-s08-driver-cli-data-') },
            });
            assert.ifError(result.error);
            return { code: result.status, stdout: result.stdout, stderr: result.stderr };
          }
          return runInProcess(argv, { stdin, fetchImpl: github });
        },
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    );
    assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
    const explained = await runInProcess(['explain', '--run', report.runId]);
    assert.equal(explained.code, 0, explained.stderr);
    return { repo, data, fakes, report, calls, explained: explained.stdout };
  } finally {
    process.chdir(saved.cwd);
    for (const [key, value] of Object.entries(saved.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('AC-2: the driver checks evidence, records the tool hold and explains the candidate anchor', async (t) => {
  const { repo, data, fakes, report, calls, explained } = await review(t, false);
  const checked = calls.find((args) => args[0] === 'check-candidates' && args.includes('--diff-file'));
  assert.equal(checked[checked.indexOf('--evidence') + 1], join(report.runDir, 'evidence.json'));
  assert.ok(checked.includes('--thread'));
  assert.ok(calls.some((args) => args[0] === 'evidence'));
  const record = calls.find((args) => args[0] === 'record');
  assert.equal(record[record.indexOf('--held') + 1], join(report.runDir, 'held.json'));
  assert.deepEqual(report.held, [EXPECTED_HELD]);
  assert.deepEqual(JSON.parse(readFileSync(join(report.runDir, 'held.json'), 'utf8')), [EXPECTED_HELD]);
  assert.deepEqual(report.findings, []);
  assert.equal(readFileSync(join(report.runDir, 'review.txt'), 'utf8'), `${NO_FINDINGS}\n`);
  const evidence = JSON.parse(readFileSync(join(report.runDir, 'evidence.json'), 'utf8'));
  assert.equal(evidence.signals[0].claim, MESSAGE);
  assert.equal(evidence.signals[0].line, 1);
  assert.equal(evidence.commands[0].version, 'tool 1.2');
  assert.equal(existsSync(join(repo.dir, 'typecheck-ran')), true);
  assert.equal(existsSync(join(fakes, '.calls/evidence-verifier.count')), false);
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    assert.deepEqual(runDetail(db, report.runId).held, [EXPECTED_HELD]);
  } finally {
    db.close();
  }
  assert.ok(explained.includes(`[restates-tool] src/app.ts:3  typecheck - line 1: ${MESSAGE}`), explained);
});

test('AC-3: the driver names every skipped check without calling evidence', async (t) => {
  const { repo, report, calls } = await review(t, true);
  assert.deepEqual(JSON.parse(readFileSync(join(report.runDir, 'evidence.json'), 'utf8')), {
    enabled: false, signals: [], commands: [], didNotRun: ['typecheck', 'lint'], skipped: 'REVIEW_VOICE_NO_COMMANDS',
  });
  assert.equal(calls.some((args) => args[0] === 'evidence'), false);
  assert.doesNotMatch(readFileSync(join(report.runDir, 'commands.log'), 'utf8'), /^\$ review-voice evidence(?:\s|$)/m);
  for (const marker of ['typecheck-ran', 'typecheck-version-ran', 'lint-ran', 'lint-version-ran']) {
    assert.equal(existsSync(join(repo.dir, marker)), false);
  }
});
