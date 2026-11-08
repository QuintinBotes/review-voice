/**
 * An advisory posture (docs/adr/0028 amendment): `verdict.never_approve`
 * turns every APPROVE into COMMENT, after the carry, needs-rerun and
 * uncovered-carry guards and before the complexity cap. The reason stays
 * local, and pending CI never makes such a head wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { buildPayload, decide, summaryLine } from '../plugins/review-voice/src/publish/verdict.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'your-github-login';
const APPROVAL_URL = `https://github.com/${REPO}/pull/${PR}#pullrequestreview-55`;
const failedEntry = { name: 'build', source: 'check-run', result: 'failed', detail: 'failure' };
const rerunEntry = { name: 'e2e', source: 'check-run', result: 'rerun', detail: 'timed_out' };
const FAILING = 'Heads up: `build` failing on this head.';

const at = (extra = {}) =>
  decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false, policy: { neverApprove: true }, ...extra });

test('never_approve: a clean review comments, with the local reason and no CI cap', () => {
  for (const ci of ['green', 'pending']) {
    const decision = at({ ci });
    assert.equal(decision.event, 'COMMENT', ci);
    assert.equal(decision.action, 'post', ci);
    assert.equal(decision.exitCode, 0, ci);
    assert.equal(decision.cappedByCi, false, ci);
    assert.ok(decision.reasons.includes('approval is left to a person by policy'), ci);
    assert.deepEqual(decision.annotations, [], ci);
  }
});

test('never_approve: red CI keeps annotations under annotate and adds no CI cap', () => {
  const capped = at({ ci: 'red', failed: [failedEntry] });
  assert.equal(capped.event, 'COMMENT');
  assert.equal(capped.cappedByCi, false);
  assert.deepEqual(capped.annotations, []);
  assert.deepEqual(capped.reasons, ['approval is left to a person by policy']);

  const annotated = at({ ci: 'red', failed: [failedEntry], policy: { neverApprove: true, ciRed: 'annotate' } });
  assert.equal(annotated.event, 'COMMENT');
  assert.equal(annotated.cappedByCi, false);
  assert.deepEqual(annotated.annotations, [FAILING]);
  assert.deepEqual(annotated.reasons, ['approval is left to a person by policy']);
});

test('never_approve: REQUEST_CHANGES and COMMENT are unchanged', () => {
  for (const mapped of ['REQUEST_CHANGES', 'COMMENT']) {
    const decision = at({ mapped, ci: 'pending' });
    assert.equal(decision.event, mapped);
    assert.equal(decision.action, 'post');
    assert.equal(decision.exitCode, 0);
    assert.ok(!decision.reasons.includes('approval is left to a person by policy'));
  }
});

test('never_approve: a standing owner approval still carries', () => {
  const decision = at({ ci: 'pending', carriedReviewUrl: APPROVAL_URL });
  assert.equal(decision.action, 'carry');
  assert.equal(decision.event, null);
  assert.equal(decision.carriedReviewUrl, APPROVAL_URL);
  assert.equal(decision.exitCode, 0);
});

test('never_approve: a needs-rerun CI state still waits with exit 6, for every event', () => {
  for (const mapped of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']) {
    const decision = at({ mapped, ci: 'needs-rerun', rerun: [rerunEntry] });
    assert.equal(decision.event, null, mapped);
    assert.equal(decision.action, 'wait', mapped);
    assert.equal(decision.exitCode, 6, mapped);
  }
});

test('never_approve: an uncovered carry and the complexity order', () => {
  const uncovered = at({ uncoveredCarry: true });
  assert.equal(uncovered.event, 'COMMENT');
  assert.ok(uncovered.reasons.some((reason) => reason.includes('carried to this head')));
  assert.ok(!uncovered.reasons.includes('approval is left to a person by policy'));

  const both = at({ needsHuman: true });
  assert.equal(both.event, 'COMMENT');
  assert.ok(both.reasons.includes('approval is left to a person by policy'));
  assert.ok(!both.reasons.some((reason) => reason.includes('raised for human review')));
});

test('never_approve: --recheck refuses with exit 2 and no CI cap', () => {
  for (const ci of ['green', 'pending', 'red']) {
    const decision = at({ ci, recheck: true, failed: [failedEntry] });
    assert.equal(decision.event, 'COMMENT', ci);
    assert.equal(decision.action, 'refuse', ci);
    assert.equal(decision.exitCode, 2, ci);
    assert.equal(decision.cappedByCi, false, ci);
    assert.ok(decision.reasons.includes('there is no approval to re-check under never_approve'), ci);
  }
  const rerun = at({ ci: 'needs-rerun', recheck: true, rerun: [rerunEntry] });
  assert.equal(rerun.exitCode, 6);
});

test('never_approve is off by default', () => {
  const decision = decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false });
  assert.equal(decision.event, 'APPROVE');
  assert.equal(decision.action, 'post');
});

test('summaryLine and buildPayload use the plain strings for a policy cap', () => {
  assert.equal(summaryLine('COMMENT', [], 'policy'), 'No problems found.');
  const nit = { findingId: 'rv_01', severity: 'nit', path: 'src/a.ts', line: 1, raw: '[nit] `src/a.ts:1` - x.', prose: 'x.' };
  assert.equal(summaryLine('COMMENT', [nit], 'policy'), '1 nit.');
  assert.equal(summaryLine('COMMENT', [nit, nit], 'policy'), '2 nits.');

  const planned = { inline: [], unanchored: [], held: [], mapped: 'APPROVE', heldBackApproval: false };
  const payload = buildPayload({ head: HEAD, event: 'COMMENT', planned, cappedBy: 'policy' });
  assert.equal(payload.body, 'No problems found.');
  assert.equal(payload.event, 'COMMENT');
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const run = (name, status, conclusion = null, id = 1) => ({
  id,
  name,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-10-01T10:00:00Z' : null,
});
const GREEN = [run('build', 'completed', 'success')];
const RED = [run('build', 'completed', 'failure')];
const PENDING = [run('build', 'in_progress')];

function fakeGitHub({ checks = [GREEN] } = {}) {
  let checkReads = 0;
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/reviews')) return json([]);
    if (parsed.pathname.endsWith('/check-runs')) {
      const runs = checks[Math.min(checkReads, checks.length - 1)];
      checkReads += 1;
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-never-approve-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = 'No actionable findings.';
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const verified = (path, line, severity) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});

function verdict(db, impl, review, extra = {}) {
  return computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, owner: OWNER, ...extra });
}

test('never_approve end to end: the posted body is the plain line, even on pending CI', async () => {
  await withDb(async (db) => {
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: CLEAN, scores: [] });
    const { exitCode, output } = await verdict(db, fakeGitHub({ checks: [PENDING] }), CLEAN, { policy: { neverApprove: true } });
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.action, 'post');
    assert.equal(output.payload.body, 'No problems found.');
    assert.ok(output.reasons.includes('approval is left to a person by policy'));
    assert.ok(!output.payload.body.includes('approval is left to a person'));
  });
});

test('never_approve end to end: nits and a red annotation follow the plain line', async () => {
  await withDb(async (db) => {
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: NIT, scores: [verified('src/cart.ts', 40, 'nit')] });
    const plain = await verdict(db, fakeGitHub(), NIT, { policy: { neverApprove: true } });
    assert.equal(plain.output.payload.body, '1 nit.');
    assert.equal(plain.output.event, 'COMMENT');
  });
  await withDb(async (db) => {
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: CLEAN, scores: [] });
    const annotated = await verdict(db, fakeGitHub({ checks: [RED] }), CLEAN, { policy: { neverApprove: true, ciRed: 'annotate' } });
    assert.equal(annotated.output.event, 'COMMENT');
    assert.equal(annotated.output.payload.body, `No problems found.\n\n${FAILING}`);
    assert.deepEqual(annotated.output.annotations, [FAILING]);
  });
});

test('config: never_approve is read, and a bad value warns and keeps the default', () => {
  const configFrom = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-never-approve-config-'));
    try {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
      return loadConfig(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const on = configFrom('verdict:\n  never_approve: true\n');
  assert.equal(on.verdictPolicy.neverApprove, true);
  assert.deepEqual(on.warnings, []);

  const bad = configFrom('verdict:\n  never_approve: maybe\n');
  assert.equal(bad.verdictPolicy.neverApprove, false);
  assert.ok(bad.warnings.some((w) => w.startsWith('verdict.never_approve must be true or false')));
});

test('documentation: help, example config, commands, watcher doc and ADR 0028 name never_approve', () => {
  const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
  const help = execFileSync(process.execPath, [bundle, 'verdict', '--help'], { encoding: 'utf8' });
  assert.ok(help.includes('never_approve'));

  const example = readFileSync(join(root, 'plugins/review-voice/templates/config.example.yaml'), 'utf8');
  assert.ok(example.includes('never_approve: false'));
  const dir = mkdtempSync(join(tmpdir(), 'rv-never-approve-example-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), example);
    assert.deepEqual(loadConfig(dir).warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const adr = readFileSync(join(root, 'docs/adr/0028-verdict-policies-are-configurable.md'), 'utf8');
  assert.match(adr, /## Amendment - 2026/);
  assert.ok(adr.includes('never_approve'));
  assert.ok(readFileSync(join(root, 'plugins/review-voice/commands/draft-review.md'), 'utf8').includes('never_approve'));
  assert.ok(readFileSync(join(root, 'docs/WATCHER.md'), 'utf8').includes('never_approve'));
  assert.ok(readFileSync(join(root, 'docs/adr/README.md'), 'utf8').includes('never_approve'));
});
