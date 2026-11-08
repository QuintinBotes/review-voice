/**
 * S06, AC-4 through the driver: a candidate an approved suppression holds is
 * held once as `policy-suppressed`, with the rule id and policy version in
 * its reason, and is absent from the rendered review (docs/adr/0032). The
 * driver runs in process against a temporary repository, a stubbed GitHub
 * and the fake agent backend, with a fresh REVIEW_VOICE_DATA_DIR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runReview, NO_FINDINGS } from '../plugins/review-voice/src/review/driver.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { approvePolicy, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';

const REPO = 'acme/api';
const PR = 12;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const APP_BASE = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}', ''].join('\n');
const APP_HEAD = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price * item.qty;', '  return sum;', '}', ''].join('\n');

/** A clone with a base commit and a head commit, and the patch GitHub would serve. */
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s06-driver-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.ts'), APP_BASE);
  writeFileSync(join(dir, 'README.md'), '# Api\n\nSums prices.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'src', 'app.ts'), APP_HEAD);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  const patch = git('diff', base, head, '--', 'src/app.ts');
  const body = patch.slice(patch.indexOf('@@'));
  const additions = body.split('\n').filter((line) => line.startsWith('+')).length;
  const deletions = body.split('\n').filter((line) => line.startsWith('-')).length;
  const files = [
    { filename: 'src/app.ts', status: 'modified', additions, deletions, changes: additions + deletions, patch: body },
  ];
  return { dir, base, head, files };
}

/** GitHub as the commands read it. */
function fakeGitHub(repo) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (method === 'POST') return json({ id: 9, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-9`, state: 'COMMENTED' });
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({
        number: PR,
        title: 'Count quantities in the total',
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
const VERIFIED = {
  candidate_id: 'cand_001',
  verified: true,
  evidence_quality: 'high',
  technical_confidence: 0.95,
  reason: 'qty is optional in the item type.',
};

/** Writes the fake agents' canned outputs for the analyst and the verifier. */
function fakes(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s06-driver-fakes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'diff-analyst.1.json'), JSON.stringify({ output: { candidates: [CANDIDATE] } }));
  writeFileSync(join(dir, 'evidence-verifier.1.json'), JSON.stringify({ output: { verifications: [VERIFIED] } }));
  return dir;
}

/** Seeds one approved policy that suppresses the candidate's rule. */
function seedApprovedSuppression(data) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    const stored = proposePolicy(db, [
      {
        scope: { type: 'global', key: 'owner' },
        kind: 'suppress',
        category: 'correctness',
        ruleId: 'correctness:diff',
        rule: 'Suppress correctness findings unless they name a concrete failure mode.',
        evidence: {
          keeps: 0,
          dismissals: 3,
          rewrites: 0,
          ownerSignals: 3,
          contradictingSignals: 0,
          mostRecentAt: '2026-10-01T00:00:00Z',
          eventIds: [],
        },
        confidence: 0.9,
        activatable: true,
        blockedBecause: null,
      },
    ]);
    assert.equal(approvePolicy(db, stored.policyId).ok, true);
    return stored.version;
  } finally {
    db.close();
  }
}

test('the driver holds a policy-suppressed candidate once and renders nothing for it', async (t) => {
  const repo = repository(t);
  const fakeDir = fakes(t);
  const data = mkdtempSync(join(tmpdir(), 'rv-s06-driver-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const version = seedApprovedSuppression(data);

  const github = fakeGitHub(repo);
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakeDir, GITHUB_TOKEN: 't' });
  let report;
  try {
    report = await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false },
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

  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  assert.deepEqual(report.findings, []);
  assert.equal(readFileSync(join(report.runDir, 'review.txt'), 'utf8'), `${NO_FINDINGS}\n`);

  const held = report.held.filter((entry) => entry.candidateId === 'cand_001');
  assert.equal(held.length, 1, JSON.stringify(report.held));
  assert.equal(held[0].verdict, 'policy-suppressed');
  assert.match(held[0].reason, /correctness:diff/);
  assert.match(held[0].reason, new RegExp(`version ${version}`));

  // What was recorded for the run carries the same single held entry, and
  // the score output the driver kept lists it in suppressed only.
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    const detail = runDetail(db, report.runId);
    assert.equal(detail.held.filter((entry) => entry.verdict === 'policy-suppressed').length, 1);
  } finally {
    db.close();
  }
  const scores = JSON.parse(readFileSync(join(report.runDir, 'scores.json'), 'utf8'));
  assert.deepEqual(
    scores.suppressed.map((entry) => entry.candidateId),
    ['cand_001'],
  );
  assert.deepEqual(scores.belowGate, []);
  assert.deepEqual(scores.eligible, []);
});
