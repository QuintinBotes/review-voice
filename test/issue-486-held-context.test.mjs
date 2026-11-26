/**
 * #486: a driver run stores every scored candidate's context, held or not.
 * One candidate is eligible and one is held by an approved suppression. Both
 * keep their category and claim in the stored candidates; the held one is
 * marked `held: true` and is never a posted finding, nor does it take over the
 * eligible finding's category when it shares its line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runReview } from '../plugins/review-voice/src/review/driver.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { recordedCandidates } from '../plugins/review-voice/src/publish/post.ts';
import { approvePolicy, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';

const REPO = 'acme/api';
const PR = 12;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const APP_BASE = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}', ''].join('\n');
const APP_HEAD = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price * item.qty;', '  return sum;', '}', ''].join('\n');

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-486-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.ts'), APP_BASE);
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
  return { dir, base, head, files: [{ filename: 'src/app.ts', status: 'modified', additions, deletions, changes: additions + deletions, patch: body }] };
}

function fakeGitHub(repo) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (method === 'POST') return json({ id: 9, html_url: 'https://github.com/x', state: 'COMMENTED' });
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({ number: PR, title: 'Count quantities', body: '', user: { login: 'an-author' }, head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' }, changed_files: 1, commits: 1, additions: 1, deletions: 1 });
    }
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}/files`) return json(repo.files);
    if (parsed.pathname === '/user') return json({ login: 'your-github-login' });
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(parsed.pathname)) return json([]);
    return new Response('not found', { status: 404 });
  };
}

const HELD = {
  candidate_id: 'cand_001', path: 'src/app.ts', line: 3, category: 'correctness', severity: 'minor',
  claim: 'The total now multiplies by qty, which is undefined for items created before qty existed.',
  failure_mode: 'Old cart items produce NaN totals.',
  evidence: ['src/app.ts:3 multiplies by item.qty without a default.'], technical_confidence: 0.9,
};
const ELIGIBLE = {
  candidate_id: 'cand_002', path: 'src/app.ts', line: 3, category: 'error_handling', severity: 'minor',
  claim: 'A negative qty silently lowers the total instead of being rejected.',
  failure_mode: 'A bad quantity from the cart service yields an under-charged order.',
  evidence: ['src/app.ts:3 adds item.price * item.qty with no check on qty.'], technical_confidence: 0.9,
};
const verified = (id) => ({ candidate_id: id, verified: true, evidence_quality: 'high', technical_confidence: 0.95, reason: 'confirmed in the code.' });

function seedSuppression(data) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    const stored = proposePolicy(db, [{
      scope: { type: 'global', key: 'owner' }, kind: 'suppress', category: 'correctness', ruleId: 'correctness:diff',
      rule: 'Suppress correctness findings unless they name a concrete failure mode.',
      evidence: { keeps: 0, dismissals: 3, rewrites: 0, ownerSignals: 3, contradictingSignals: 0, mostRecentAt: '2026-10-01T00:00:00Z', eventIds: [] },
      confidence: 0.9, activatable: true, blockedBecause: null,
    }]);
    assert.equal(approvePolicy(db, stored.policyId).ok, true);
  } finally {
    db.close();
  }
}

async function drive(t) {
  const repo = repository(t);
  const fakeDir = mkdtempSync(join(tmpdir(), 'rv-486-fakes-'));
  const data = mkdtempSync(join(tmpdir(), 'rv-486-data-'));
  t.after(() => { rmSync(fakeDir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  writeFileSync(join(fakeDir, 'diff-analyst.1.json'), JSON.stringify({ output: { candidates: [HELD, ELIGIBLE] } }));
  writeFileSync(join(fakeDir, 'evidence-verifier.1.json'), JSON.stringify({ output: { verifications: [verified('cand_001'), verified('cand_002')] } }));
  writeFileSync(join(fakeDir, 'challenger.1.json'), JSON.stringify({ output: { verdicts: [{ candidate_id: 'cand_002', verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/app.ts:3'], reason: 'src/app.ts:3 is the line the claim names.' }] } }));
  writeFileSync(join(fakeDir, 'concise-editor.1.json'), JSON.stringify({ output: { text: '[minor] `src/app.ts:3` - a negative qty silently lowers the total, so a bad quantity under-charges the order.' } }));
  seedSuppression(data);
  const github = fakeGitHub(repo);
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakeDir, GITHUB_TOKEN: 't' });
  try {
    const report = await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false },
      {
        command: (argv, stdin) => runInProcess(argv, { stdin, fetchImpl: github }),
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    );
    return { report, data };
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_FAKE_AGENTS', 'GITHUB_TOKEN']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  }
}

test('a driver run stores both candidates with context and marks the held one', async (t) => {
  const { report, data } = await drive(t);
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  const stored = JSON.parse(readFileSync(join(report.runDir, 'record-candidates.json'), 'utf8')).candidates;
  const byId = Object.fromEntries(stored.map((c) => [c.candidate_id ?? c.candidateId, c]));
  assert.equal(byId.cand_001.held, true);
  assert.equal(byId.cand_001.category, 'correctness');
  assert.equal(byId.cand_001.claim, HELD.claim);
  assert.equal(byId.cand_002.held, false);
  assert.equal(byId.cand_002.category, 'error_handling');

  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    const row = db.prepare('SELECT candidates_json FROM review_runs WHERE review_run_id = ?').get(report.runId);
    const kept = JSON.parse(row.candidates_json);
    assert.deepEqual(kept.map((c) => [c.held, c.category]).sort(), [[false, 'error_handling'], [true, 'correctness']]);
    // Only the eligible finding is posted, it keeps rv_01, and it is not given the held category.
    const findings = runDetail(db, report.runId).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].findingId, 'rv_01');
    assert.equal(findings[0].category, 'error_handling');
    // Readers of the stored candidates skip the held one.
    assert.ok(!recordedCandidates(db, report.runId).some((c) => c.candidateId === 'cand_001'));
  } finally {
    db.close();
  }
});

test('record still takes an old candidates list without the mark', (t) => {
  const data = mkdtempSync(join(tmpdir(), 'rv-486-old-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    const text = '[minor] `src/app.ts:3` - a negative qty silently lowers the total.\n';
    const { reviewRunId, findings } = recordRun(db, { repository: REPO, baseRef: null, headRef: 'abc', pullNumber: PR, diff: 'diff', output: text, candidates: [{ path: 'src/app.ts', line: 3, category: 'error_handling' }] });
    assert.equal(findings[0].category, 'error_handling');
    assert.equal(JSON.parse(db.prepare('SELECT candidates_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId).candidates_json)[0].held, undefined);
  } finally {
    db.close();
  }
});
