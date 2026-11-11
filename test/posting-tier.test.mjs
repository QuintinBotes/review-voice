/**
 * `verdict.min_posted_tier` (docs/adr/0028, S24): a verified finding below the
 * tier is not posted, stays in the record, is listed in the preview and counted
 * in the scope block, and still keeps an approval at COMMENT when it is above a
 * nit. The five categories no suppression may reach post at any tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { planFindings, POSTED_TIERS } from '../plugins/review-voice/src/publish/verdict.ts';

const HEAD = 'a1b2c3d' + 'e'.repeat(33);
const REPO = 'acme/web';
const PR = 7;
const PROVENANCE = { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const GREEN = [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-11-01T10:00:00Z' }];

/** One finding per severity, each on its own line of one file, in review order. */
const LINE = { blocking: 10, important: 20, minor: 30, question: 40, nit: 50 };
const finding = (severity, line = LINE[severity]) =>
  `[${severity}] \`src/cart.ts:${line}\` - The ${severity} claim here. It is stated as the contract asks.`;
const score = (severity, line = LINE[severity], extra = {}) => ({
  candidateId: `c${line}`, path: 'src/cart.ts', line, severity: { severity }, confidenceSource: 'verifier', eligible: true, ...extra,
});
const ALL = ['blocking', 'important', 'minor', 'question', 'nit'];
const ids = (findings) => findings.map((f) => f.findingId);

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'rv-posting-tier-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = data;
  const db = openDatabase(join(data, 'review-voice.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  });
  return { db, data };
}

function record(db, output, scores, extra = {}) {
  return recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores, provenance: PROVENANCE, ...extra });
}

function fakeGitHub() {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/check-runs')) return json({ total_count: GREEN.length, check_runs: GREEN });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    throw new Error('Unexpected GitHub request: ' + path);
  };
}

function verdict(db, review, policy, extra = {}) {
  return computeVerdict({
    db, client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(), sleep: async () => {} }),
    repository: REPO, pullNumber: PR, head: HEAD, review, policy, ...extra,
  });
}

test('AC-1: the tier table withholds verified findings below it and held keeps only unverified ones', (t) => {
  const { db } = fixture(t);
  // Every severity verified, plus an unverified minor whose score is the analyst's own.
  const output = [...ALL.map((severity) => finding(severity)), finding('minor', 60)].join('\n\n');
  const scores = [...ALL.map((severity) => score(severity)), score('minor', 60, { confidenceSource: 'analyst' })];
  const id = record(db, output, scores).reviewRunId;
  const run = runDetail(db, id);
  const plan = (tier) => planFindings(output, run, () => null, tier);

  const important = plan('important');
  assert.deepEqual(ids(important.inline), ['rv_01', 'rv_02']);
  assert.deepEqual(ids(important.belowTier), ['rv_03', 'rv_04', 'rv_05']);
  assert.deepEqual(important.belowTier.map((f) => f.severity), ['minor', 'question', 'nit']);

  const minor = plan('minor');
  assert.deepEqual(ids(minor.inline), ['rv_01', 'rv_02', 'rv_03', 'rv_04']);
  assert.deepEqual(ids(minor.belowTier), ['rv_05']);

  const blocking = plan('blocking');
  assert.deepEqual(ids(blocking.inline), ['rv_01']);
  assert.deepEqual(ids(blocking.belowTier), ['rv_02', 'rv_03', 'rv_04', 'rv_05']);

  const everything = planFindings(output, run, () => null);
  assert.deepEqual(ids(everything.inline), ['rv_01', 'rv_02', 'rv_03', 'rv_04', 'rv_05']);
  assert.deepEqual(everything.belowTier, []);
  assert.deepEqual(plan('nit'), everything);

  for (const planned of [important, minor, blocking, everything]) {
    assert.deepEqual(ids(planned.held), ['rv_06'], 'held holds only the unverified finding');
    assert.match(planned.held[0].reason, /analyst/);
    assert.equal(planned.unanchored.length, 0);
  }
  assert.deepEqual(POSTED_TIERS, ['blocking', 'important', 'minor', 'nit']);
});

test('AC-1: a withheld minor keeps an approval at COMMENT; a withheld nit leaves APPROVE intact', async (t) => {
  const { db } = fixture(t);
  record(db, finding('minor'), [score('minor')]);
  const capped = await verdict(db, finding('minor'), { minPostedTier: 'important' });
  assert.equal(capped.exitCode, 0, JSON.stringify(capped.output));
  assert.equal(capped.output.event, 'COMMENT');
  assert.equal(capped.planned.heldBackApproval, true);
  assert.equal(capped.output.payload.body, 'Not approving yet.');
  assert.deepEqual(capped.output.payload.comments, []);
  assert.ok(capped.output.reasons.some((reason) => reason.includes('below the posting tier')), capped.output.reasons.join('\n'));

  record(db, finding('nit'), [score('nit')]);
  const approved = await verdict(db, finding('nit'), { minPostedTier: 'minor' });
  assert.equal(approved.exitCode, 0, JSON.stringify(approved.output));
  assert.equal(approved.output.event, 'APPROVE');
  assert.equal(approved.planned.heldBackApproval, false);
  assert.equal(approved.output.payload.body, 'No problems found.');
  assert.deepEqual(approved.output.belowTier.map((f) => f.findingId), ['rv_01']);

  // The tier that withholds an important finding, the other severity the cap covers.
  record(db, finding('important'), [score('important')]);
  const important = await verdict(db, finding('important'), { minPostedTier: 'blocking' });
  assert.equal(important.exitCode, 0, JSON.stringify(important.output));
  assert.equal(important.output.event, 'COMMENT');
  assert.equal(important.planned.heldBackApproval, true);
  assert.equal(important.output.payload.body, 'Not approving yet.');
  assert.deepEqual(important.output.belowTier.map((f) => f.findingId), ['rv_01']);
});

test('AC-1: a withheld verified important keeps the standing request for changes, as a held one does', async (t) => {
  const { db } = fixture(t);
  const high = assessComplexity('', [{ path: 'src/auth/login.ts', status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true }]);
  assert.equal(high.level, 'high');
  record(db, finding('important'), [score('important')], { complexity: high });
  const calls = [];
  const plain = fakeGitHub();
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith('/reviews')) {
      const review = { id: 101, user: { login: 'owner-login' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-01T09:00:00Z', html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-101` };
      return json([review]);
    }
    return plain(url, init);
  };
  const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} });
  const result = await verdict(db, finding('important'), { minPostedTier: 'blocking' }, { client, owner: 'owner-login' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.equal(result.output.event, 'COMMENT');
  assert.deepEqual(result.output.belowTier.map((f) => f.findingId), ['rv_01']);
  assert.equal(result.output.staleRequestChanges, null);
  assert.ok(!calls.some((path) => path.endsWith('/reviews')), calls.join('\n'));
  assert.ok(!result.output.reasons.some((reason) => reason.includes('dismiss it by hand')), result.output.reasons.join('\n'));
});

test('AC-2: the default posts every verified finding, and an unknown tier warns and keeps nit', (t) => {
  const { db, data } = fixture(t);
  const output = ALL.map((severity) => finding(severity)).join('\n\n');
  const id = record(db, output, ALL.map((severity) => score(severity))).reviewRunId;
  const planned = planFindings(output, runDetail(db, id), () => null);
  assert.equal(planned.inline.length, 5);
  assert.deepEqual(planned.belowTier, []);

  mkdirSync(join(data, '.review-voice'));
  writeFileSync(join(data, '.review-voice/config.yaml'), 'verdict:\n  min_posted_tier: critical\n');
  const config = loadConfig(data);
  assert.equal(config.verdictPolicy.minPostedTier, 'nit');
  assert.deepEqual(config.warnings, ['verdict.min_posted_tier must be one of blocking, important, minor, nit; using nit.']);
  writeFileSync(join(data, '.review-voice/config.yaml'), 'verdict:\n  min_posted_tier: important\n  reading_guide: true\n');
  const chosen = loadConfig(data);
  assert.equal(chosen.verdictPolicy.minPostedTier, 'important');
  assert.equal(chosen.verdictPolicy.readingGuide, true);
  assert.deepEqual(chosen.warnings, []);
});

test('AC-3: the verdict output, preview and scope block all carry the withheld findings', async (t) => {
  const { db } = fixture(t);
  // One unverified blocking, so the held lines come first and the tier lines follow them.
  const output = [finding('blocking'), finding('important'), finding('minor'), finding('nit')].join('\n\n');
  record(db, output, [score('important'), score('minor'), score('nit')], {
    scope: { kind: 'full', cause: 'requested', since: null, priorRunId: null },
    checks: { staticRan: [], staticDidNotRun: [], symbolsInconclusive: 0, symbolsBudgetExhausted: false },
  });
  const result = await verdict(db, output, { minPostedTier: 'important', scopeBlock: true });
  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.equal(result.output.event, 'REQUEST_CHANGES');
  assert.deepEqual(result.output.held.map((f) => f.findingId), ['rv_01']);
  assert.deepEqual(result.output.belowTier, [
    { findingId: 'rv_03', severity: 'minor', path: 'src/cart.ts', line: 30, reason: 'below verdict.min_posted_tier (important)' },
    { findingId: 'rv_04', severity: 'nit', path: 'src/cart.ts', line: 50, reason: 'below verdict.min_posted_tier (important)' },
  ]);
  assert.deepEqual(result.output.payload.comments.map((c) => c.line), [20]);
  const preview = result.output.preview;
  const held = preview.indexOf('Held back, not verified: 1\n  rv_01 src/cart.ts:10 (');
  const below = preview.indexOf('Below the posting tier, not posted: 2\n  rv_03 src/cart.ts:30 (minor)\n  rv_04 src/cart.ts:50 (nit)');
  assert.ok(held >= 0, preview);
  assert.ok(below > held, preview);
  const body = result.output.payload.body;
  assert.match(body, /^Not posted: 1 held for other reasons, 2 below the posting tier\.$/m);
  const trailer = JSON.parse(body.match(/\n<!-- review-voice (\{[^\n]*\}) -->$/)[1]);
  assert.equal(trailer.held.belowTier, 2);
  assert.equal(trailer.held.other, 1);
  assert.deepEqual(Object.keys(trailer.held), ['unverified', 'belowGate', 'challenge', 'restatesTool', 'policySuppressed', 'other', 'belowTier']);
  assert.deepEqual(trailer.findings, { blocking: 0, important: 1, minor: 0, nit: 0, question: 0 });
  // The withheld findings are in the record, so `explain` can still show them.
  assert.equal(result.run.findings.length, 4);
});

test('AC-4: the five suppression-exempt categories post under min_posted_tier blocking', (t) => {
  const { db } = fixture(t);
  const exempt = ['security', 'authorization', 'authentication', 'data_integrity', 'trust_boundary'];
  for (const category of exempt) {
    const output = finding('minor');
    const id = record(db, output, [score('minor')], { candidates: [{ path: 'src/cart.ts', line: LINE.minor, category }] }).reviewRunId;
    const run = runDetail(db, id);
    assert.equal(run.findings[0].category, category);
    const planned = planFindings(output, run, () => null, 'blocking');
    assert.deepEqual(ids(planned.inline), ['rv_01'], category);
    assert.deepEqual(planned.belowTier, [], category);
    assert.equal(planned.mapped, 'COMMENT', category);
  }
});

test('AC-4: a non-exempt category and a finding with no category are withheld under blocking', (t) => {
  const { db } = fixture(t);
  const output = finding('minor');
  const correctness = record(db, output, [score('minor')], { candidates: [{ path: 'src/cart.ts', line: LINE.minor, category: 'correctness' }] }).reviewRunId;
  const withCategory = planFindings(output, runDetail(db, correctness), () => null, 'blocking');
  assert.deepEqual(withCategory.inline, []);
  assert.deepEqual(ids(withCategory.belowTier), ['rv_01']);
  assert.equal(withCategory.mapped, 'COMMENT', 'a withheld minor still caps the approval');

  const none = record(db, output, [score('minor')]).reviewRunId;
  assert.equal(runDetail(db, none).findings[0].category, undefined);
  const noCategory = planFindings(output, runDetail(db, none), () => null, 'blocking');
  assert.deepEqual(noCategory.inline, []);
  assert.deepEqual(ids(noCategory.belowTier), ['rv_01']);
});

test('a carried finding keeps the exemption its origin recorded, for each of the five categories', (t) => {
  const { db } = fixture(t);
  const output = finding('minor');
  for (const category of ['security', 'authorization', 'authentication', 'data_integrity', 'trust_boundary']) {
    const origin = record(db, output, [score('minor')], { candidates: [{ path: 'src/cart.ts', line: LINE.minor, category }] }).reviewRunId;
    const carried = runDetail(db, origin).findings.map((f) => ({ findingId: f.findingId, path: f.path, oldLine: f.line, line: f.line, text: f.text }));
    const run = runDetail(db, record(db, output, [], { carried: { runId: origin, findings: carried } }).reviewRunId);
    assert.equal(run.findings[0].category, undefined, `${category}: the carried record names no category of its own`);
    assert.deepEqual(run.findings[0].carriedFrom, { runId: origin, findingId: 'rv_01' });
    const planned = planFindings(output, run, (id) => runDetail(db, id), 'blocking');
    assert.deepEqual(ids(planned.inline), ['rv_01'], category);
    assert.deepEqual(planned.belowTier, [], category);
  }
});
