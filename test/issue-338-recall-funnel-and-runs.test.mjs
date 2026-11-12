/**
 * Issues 338 and 339: `recall` says where a missed positive lost its expected
 * finding (`lostAt`) and which verdict each run reached (`event`), and
 * `recall --runs <n>` scores every fixture n times so a figure comes with its
 * range. Canned fixtures and the fake agent backend throughout, so no model
 * is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { MAX_RUNS, RecallUsageError, runRecall } from '../plugins/review-voice/src/evaluate/recall.ts';
import { LOST_AT, combineAttempts, lostAt, readRecallResults, recallMetrics, summariseResults } from '../plugins/review-voice/src/evaluate/recall-results.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'plugins/review-voice/src/cli.ts');
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const canned = join(root, 'test/fixtures-recall');

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-338-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const inProcess = (fetchImpl) => (args, stdin) => runInProcess(args, { stdin, fetchImpl });

/** The harness in this process, as the command runs it. */
function recall(overrides = {}, deps = {}) {
  return runRecall({ fixtures: canned, classes: ['positive', 'negative', 'no-findings'], runner: 'fake', only: null, keep: false, ...overrides }, { commandWith: inProcess, ...deps });
}

/** The loss counts of a summary, zero everywhere but where given. */
const lost = (counts = {}) => ({ 'not-raised': 0, 'dropped-at-check': 0, 'verifier-rejected': 0, 'held-other': 0, challenge: 0, 'below-gate': 0, 'posted-elsewhere': 0, ...counts });

/**
 * A fixtures directory holding one positive, `positive/case`, copied from a
 * canned one. `agents` replaces canned agent outputs by file name, and
 * `expect` adds lines to the end of the `expect:` block.
 */
function variant(t, agents = {}, { from = 'positive/hit', expect = [] } = {}) {
  const fixtures = scratch(t);
  const dir = join(fixtures, 'positive/case');
  cpSync(join(canned, from), dir, { recursive: true });
  for (const [file, output] of Object.entries(agents)) writeFileSync(join(dir, 'agents', file), JSON.stringify({ output }));
  if (expect.length > 0) writeFileSync(join(dir, 'case.yaml'), `${readFileSync(join(dir, 'case.yaml'), 'utf8').trimEnd()}\n${expect.join('\n')}\n`);
  return fixtures;
}

/** One canned positive through the real driver, as its result and the summary. */
async function one(t, agents, options, deps) {
  const run = await recall({ fixtures: variant(t, agents, options), classes: ['positive'] }, deps);
  const [result] = run.results.fixtures;
  assert.equal(result.exitCode, 0, result.error);
  return { result, summary: run.results.summary };
}

const verification = (fields) => ({ verifications: [{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.95, reason: 'Read at the head.', ...fields }] });
const REFUTED = { verdicts: [{ candidate_id: 'cand_001', verdict: 'refuted', line_ok: true, decisive_evidence: ['src/app.ts:3'], reason: 'qty has a default of one where items are built.' }] };

/** The words of the canned hit candidate, as another reviewer would have left them on the pull request. */
const SAME_POINT = 'The total now multiplies by qty, which is undefined for items created before qty existed. Old cart items produce NaN totals.';

/** GitHub as the harness serves it, with one conversation comment that already makes the canned point. */
const alreadySaid = (fetchImpl) => async (url, init) => {
  const { pathname } = new URL(String(url));
  if ((init?.method ?? 'GET') === 'GET' && pathname.endsWith('/issues/1/comments')) {
    return new Response(JSON.stringify([{ id: 7, user: { login: 'another-reviewer' }, body: SAME_POINT, created_at: '2026-01-01T00:00:00Z' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return fetchImpl(url, init);
};

test('lostAt follows the candidates on an accepted anchor and reports the furthest stage one reached', () => {
  const expectation = { path: 'src/a.ts', line: 10, anchors: [{ path: 'docs/a.md', line: 3 }] };
  const trail = (fields) => ({ candidates: [{ id: 'c1', path: 'src/a.ts', line: 11 }], kept: ['c1'], verified: ['c1'], held: [], eligible: [], posted: [], ...fields });
  const held = (verdict, candidateId = 'c1') => ({ candidateId, verdict });
  const far = { path: 'src/a.ts', line: 40 };

  assert.equal(lostAt(expectation, trail({ candidates: [] })), 'not-raised');
  assert.equal(lostAt(expectation, trail({ candidates: [], posted: [far, far] })), 'posted-elsewhere');
  assert.equal(lostAt(expectation, trail({ candidates: [{ id: 'c1', path: 'src/a.ts', line: 14 }], posted: [far] })), 'posted-elsewhere', 'four lines away is not on the anchor');
  for (const line of [7, 13]) {
    assert.equal(lostAt(expectation, trail({ candidates: [{ id: 'c1', path: 'src/a.ts', line }], held: [held('below-gate')], posted: [far] })), 'below-gate', `line ${line} is three lines away, the edge of the tolerance, and on the anchor`);
  }
  assert.equal(lostAt(expectation, trail({ candidates: [{ id: 'c1', path: 'src/b.ts', line: 10 }] })), 'not-raised', 'the same line of another file is not on the anchor');

  assert.equal(lostAt(expectation, trail({ kept: [] })), 'dropped-at-check');
  assert.equal(lostAt(expectation, trail({ kept: [], held: [held('repeat')] })), 'dropped-at-check', 'a repeat the check dropped is held, and never reached the verifier');
  assert.equal(lostAt(expectation, trail({ verified: [] })), 'verifier-rejected');
  assert.equal(lostAt(expectation, trail({ held: [held('below-gate')] })), 'below-gate');
  assert.equal(lostAt(expectation, trail({ held: [held('challenge-refuted')] })), 'challenge');
  assert.equal(lostAt(expectation, trail({ held: [held('challenge-partly')] })), 'challenge', 'a challenger that did not run holds as challenge-partly');
  assert.equal(lostAt(expectation, trail({ held: [held('policy-suppressed')] })), 'held-other');
  assert.equal(lostAt(expectation, trail({ held: [held('reproduction-did-not-fail')] })), 'held-other');
  assert.equal(lostAt(expectation, trail({ verified: [], held: [held('unverified')] })), 'held-other', 'held for context the verifier could not obtain');
  assert.equal(lostAt(expectation, trail({ held: [held('below-gate', 'another')] })), 'held-other', 'a hold on another candidate is not this one, which the score turned away');
  const moved = { id: 'c1', ...far };
  assert.equal(lostAt(expectation, trail({ eligible: [moved], posted: [far] })), 'posted-elsewhere', 'the challenger moved its line out of the tolerance, and it posted there');
  assert.equal(lostAt(expectation, trail({ eligible: [moved], posted: [] })), 'held-other', 'eligible to the end of a review that posted nothing is not posted anywhere');
  assert.equal(lostAt(expectation, trail({ eligible: [{ id: 'c1', path: 'src/a.ts', line: 11 }], posted: [far] })), 'held-other', 'a finding from another candidate is not this one, which the editor left out');
  assert.equal(lostAt(expectation, trail({ eligible: [moved], posted: [{ path: 'src/b.ts', line: 40 }] })), 'held-other', 'the same line of another file is not where it was moved to');

  const two = (second) => trail({ candidates: [{ id: 'c1', path: 'src/a.ts', line: 11 }, { id: 'c2', path: 'src/a.ts', line: 9 }], kept: ['c1', 'c2'], verified: ['c2'], ...second });
  assert.equal(lostAt(expectation, two({})), 'held-other', 'the one that got further decides');
  assert.equal(lostAt(expectation, two({ held: [held('below-gate', 'c2')] })), 'below-gate');
  assert.equal(
    lostAt(expectation, two({ verified: ['c1', 'c2'], held: [held('below-gate', 'c1')], eligible: [{ id: 'c2', path: 'src/a.ts', line: 9 }], posted: [far] })),
    'below-gate',
    'a second candidate there that never posted does not hide the gate',
  );
  assert.equal(lostAt(expectation, two({ held: [held('below-gate', 'c1'), held('challenge-refuted', 'c2')] })), 'below-gate', 'a gate is further than the challenger');
  assert.equal(lostAt(expectation, two({ held: [held('challenge-refuted', 'c2')], kept: ['c2'] })), 'challenge');
  assert.equal(lostAt(expectation, two({ kept: ['c1'], verified: [] })), 'verifier-rejected', 'a rejection is further than a drop at the check');

  const second = trail({ candidates: [{ id: 'c1', path: 'docs/a.md', line: 5 }], held: [held('below-gate')] });
  assert.equal(lostAt(expectation, second), 'below-gate', 'a candidate on a further anchor is followed too');
  assert.equal(lostAt({ ...expectation, anchors: [] }, second), 'not-raised', 'and without that anchor it is not');
  assert.deepEqual([...LOST_AT].reverse().slice(1, 6), ['below-gate', 'challenge', 'held-other', 'verifier-rejected', 'dropped-at-check'], 'the stages, from the furthest to the nearest');
});

test('a hit records a null lostAt, a miss where it was lost, and every completed fixture its event', async () => {
  const { results } = await recall();
  const [hit, miss, skipped, clean] = results.fixtures;
  assert.equal(hit.hit, true);
  assert.equal(hit.lostAt, null);
  assert.equal(hit.event, 'COMMENT');
  assert.equal(miss.hit, false);
  assert.equal(miss.lostAt, 'posted-elsewhere', 'the canned finding is six lines from the anchor');
  assert.equal(miss.event, 'COMMENT');
  assert.equal(clean.event, 'APPROVE', 'a clean fixture records the verdict too');
  assert.equal('lostAt' in clean, false, 'only a positive can lose a finding');
  assert.deepEqual(Object.keys(skipped), ['name', 'class', 'skipped'], 'a skipped fixture ran nothing');
  assert.equal(results.summary.completedPositives, 2);
  assert.equal(results.summary.approved, 0);
  assert.deepEqual(results.summary.lost, lost({ 'posted-elsewhere': 1 }));
});

test('a positive nobody raised a candidate for is not-raised, and it ends in APPROVE', async (t) => {
  const { result, summary } = await one(t, { 'diff-analyst.1.json': { candidates: [], toolCalls: 1, filesRead: 1 } });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 0);
  assert.equal(result.lostAt, 'not-raised');
  assert.equal(result.event, 'APPROVE');
  assert.deepEqual(summary.lost, lost({ 'not-raised': 1 }));
  assert.equal(summary.approved, 1, 'the review approved a change that carries the seeded defect');
  assert.equal(summary.completedPositives, 1);
});

test('a candidate the verifier did not verify is verifier-rejected', async (t) => {
  const { result, summary } = await one(t, { 'evidence-verifier.1.json': verification({ verified: false, evidence_quality: 'low', technical_confidence: 0.2, reason: 'qty is always set where items are built.' }) });
  assert.equal(result.hit, false);
  assert.equal(result.lostAt, 'verifier-rejected');
  assert.deepEqual(summary.lost, lost({ 'verifier-rejected': 1 }));
});

test('a verified candidate held under the confidence gate is below-gate', async (t) => {
  const { result, summary } = await one(t, { 'evidence-verifier.1.json': verification({ verified: true, technical_confidence: 0.5 }) });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 0);
  assert.equal(result.lostAt, 'below-gate');
  assert.deepEqual(summary.lost, lost({ 'below-gate': 1 }));
});

test('a candidate the challenger refuted is lost at the challenge', async (t) => {
  const { result, summary } = await one(t, { 'challenger.1.json': REFUTED });
  assert.equal(result.hit, false);
  assert.equal(result.lostAt, 'challenge');
  assert.deepEqual(summary.lost, lost({ challenge: 1 }));
});

test('a candidate held for context the verifier could not obtain is held-other', async (t) => {
  const missing = verification({ verified: false, reason: 'The item type is not in the change.', required_context_missing: ['the declaration of the item type'] });
  const { result, summary } = await one(t, { 'evidence-verifier.1.json': missing });
  assert.equal(result.hit, false);
  assert.equal(result.lostAt, 'held-other');
  assert.deepEqual(summary.lost, lost({ 'held-other': 1 }));
});

test('an eligible candidate on the anchor that the editor left out of a review with no finding is held-other', async (t) => {
  // The canned miss expects line 2. Raised there, verified and confirmed, and the editor still writes nothing.
  const raised = { candidate_id: 'cand_001', path: 'src/app.ts', line: 2, category: 'correctness', severity: 'minor', claim: 'The running sum now starts at one, so every total is one too high.', failure_mode: 'An empty cart totals one.', evidence: ['src/app.ts:2 initialises sum to 1.'], technical_confidence: 0.9 };
  const agents = {
    'diff-analyst.1.json': { candidates: [raised] },
    'challenger.1.json': { verdicts: [{ candidate_id: 'cand_001', verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/app.ts:2'], reason: '' }] },
    'concise-editor.1.json': { text: 'No actionable findings.' },
  };
  const { result, summary } = await one(t, agents, { from: 'positive/miss' });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 0);
  assert.equal(result.event, 'APPROVE');
  assert.equal(result.lostAt, 'held-other', 'nothing posted, so it was not posted elsewhere');
  assert.deepEqual(summary.lost, lost({ 'held-other': 1 }));
});

const candidate = (id, line, claim) => ({ candidate_id: id, path: 'src/app.ts', line, category: 'correctness', severity: 'minor', claim, failure_mode: 'Totals are wrong.', evidence: [`src/app.ts:${line} shows it.`], technical_confidence: 0.9 });
const verified = (id, fields = {}) => ({ candidate_id: id, verified: true, evidence_quality: 'high', technical_confidence: 0.95, reason: 'Read at the head.', ...fields });
const confirmed = (id, line, fields = {}) => ({ verdicts: [{ candidate_id: id, verdict: 'confirmed', line_ok: true, decisive_evidence: [`src/app.ts:${line}`], reason: '', ...fields }] });
const STARTS_AT_ONE = 'The running sum now starts at one, so every total is one too high.';
const EXTRA_UNIT = 'The returned total now includes an extra unit that no caller asked for.';

test('a candidate on the anchor that the editor left out is held-other, whatever else the review posted', async (t) => {
  // The canned miss expects line 2, and its editor writes only the line 8 finding.
  const agents = {
    'diff-analyst.1.json': { candidates: [candidate('cand_001', 2, STARTS_AT_ONE), candidate('cand_002', 8, EXTRA_UNIT)] },
    'evidence-verifier.1.json': { verifications: [verified('cand_001'), verified('cand_002')] },
    'challenger.1.json': confirmed('cand_001', 2),
    'challenger.2.json': confirmed('cand_002', 8),
  };
  const { result, summary } = await one(t, agents, { from: 'positive/miss' });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 1, 'only the line 8 finding posted');
  assert.equal(result.lineDelta, 6);
  assert.equal(result.event, 'COMMENT');
  assert.equal(result.lostAt, 'held-other', 'the finding that posted came from another candidate');
  assert.deepEqual(summary.lost, lost({ 'held-other': 1 }));
});

test('a below-gate hold on the anchor is not hidden by a second candidate there that never posted', async (t) => {
  const agents = {
    'diff-analyst.1.json': {
      candidates: [candidate('cand_001', 2, STARTS_AT_ONE), candidate('cand_002', 2, 'An empty cart no longer totals zero because the accumulator is seeded with one.'), candidate('cand_003', 8, EXTRA_UNIT)],
    },
    'evidence-verifier.1.json': { verifications: [verified('cand_001', { technical_confidence: 0.5 }), verified('cand_002'), verified('cand_003')] },
    'challenger.1.json': confirmed('cand_002', 2),
    'challenger.2.json': confirmed('cand_003', 8),
  };
  const { result, summary } = await one(t, agents, { from: 'positive/miss' });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 1);
  assert.equal(result.lostAt, 'below-gate');
  assert.deepEqual(summary.lost, lost({ 'below-gate': 1 }));
});

test('a candidate the challenger moved off the anchor, which posted where it was moved to, is posted-elsewhere', async (t) => {
  const agents = {
    'diff-analyst.1.json': { candidates: [candidate('cand_001', 2, EXTRA_UNIT)] },
    'evidence-verifier.1.json': { verifications: [verified('cand_001')] },
    'challenger.1.json': confirmed('cand_001', 8, { line_ok: false, corrected_line: 8 }),
  };
  const { result, summary } = await one(t, agents, { from: 'positive/miss' });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 1);
  assert.equal(result.lineDelta, 6);
  assert.equal(result.lostAt, 'posted-elsewhere');
  assert.deepEqual(summary.lost, lost({ 'posted-elsewhere': 1 }));
});

test('a candidate the check dropped as already said on the pull request is dropped-at-check', async (t) => {
  const { result, summary } = await one(t, {}, {}, { commandWith: (fetchImpl) => inProcess(alreadySaid(fetchImpl)) });
  assert.equal(result.hit, false);
  assert.equal(result.findings, 0);
  assert.equal(result.lostAt, 'dropped-at-check');
  assert.deepEqual(summary.lost, lost({ 'dropped-at-check': 1 }));
});

test('a candidate on a second accepted anchor is followed like one on expect.line', async (t) => {
  // The canned miss raises its candidate on line 8 and expects line 2; refuted, nothing posts at all.
  const refuted = { 'challenger.1.json': { verdicts: [{ ...REFUTED.verdicts[0], decisive_evidence: ['src/app.ts:8'] }] } };
  const anchored = await one(t, refuted, { from: 'positive/miss', expect: ['  anchors:', '    - { path: src/app.ts, line: 8 }'] });
  assert.equal(anchored.result.hit, false);
  assert.equal(anchored.result.lostAt, 'challenge', 'the candidate on the second anchor was raised, and the challenger held it');
  const bare = await one(t, refuted, { from: 'positive/miss' });
  assert.equal(bare.result.lostAt, 'not-raised', 'without the anchor no candidate was on an accepted place');
});

test('the summary counts each lostAt value over the misses and the positives that ended in APPROVE', () => {
  const positive = (name, fields) => ({ name: `positive/${name}`, class: 'positive', exitCode: 0, ...fields });
  const results = [
    positive('a', { hit: true, lineDelta: 0, lostAt: null, event: 'COMMENT' }),
    positive('b', { hit: false, lineDelta: null, lostAt: 'below-gate', event: 'COMMENT' }),
    positive('c', { hit: false, lineDelta: null, lostAt: 'below-gate', event: 'APPROVE' }),
    positive('d', { hit: false, lineDelta: 9, lostAt: 'posted-elsewhere', event: 'REQUEST_CHANGES' }),
    positive('e', { hit: false, lineDelta: null, lostAt: 'not-raised', event: 'APPROVE' }),
    positive('f', { hit: null, lineDelta: null, exitCode: 1, error: 'boom' }),
    positive('g', { hit: false, lineDelta: 5 }),
    { name: 'positive/h', class: 'positive', skipped: 'no stage' },
    { name: 'no-findings/i', class: 'no-findings', silent: true, exitCode: 0, event: 'APPROVE' },
  ];
  const summary = summariseResults(results);
  assert.deepEqual(summary.lost, lost({ 'below-gate': 2, 'posted-elsewhere': 1, 'not-raised': 1 }), 'a hit, a failed run and a miss written before lostAt existed lose nothing');
  assert.equal(summary.approved, 2, 'a clean fixture that approved is not a positive');
  assert.equal(summary.completedPositives, 6, 'the failed run and the skipped fixture did not complete');
  assert.equal(summary.positives, 7);
  assert.equal('runs' in summary, false, 'one run records no run count');
  assert.equal('ranges' in summary, false);
});

/** A results file as the command writes it, with every time set to zero so two runs compare. */
const timeless = (path) =>
  JSON.parse(readFileSync(path, 'utf8'), (key, value) => (key === 'seconds' ? 0 : value));

const command = (program, dir, ...args) => spawnSync(process.execPath, [program, 'recall', '--fixtures', canned, '--runner', 'fake', ...args], { encoding: 'utf8', cwd: dir, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'operator') } });

test('recall --runs 1 writes the file recall writes with no flag, and prints where a miss was lost', (t) => {
  const dir = scratch(t);
  const plain = command(cli, dir, '--out', join(dir, 'plain.json'));
  const once = command(cli, dir, '--runs', '1', '--out', join(dir, 'once.json'));
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(once.status, 0, once.stderr);
  const written = timeless(join(dir, 'plain.json'));
  assert.deepEqual(timeless(join(dir, 'once.json')), written);
  assert.deepEqual(Object.keys(written), ['pluginVersion', 'mode', 'runner', 'fixtures', 'summary']);
  assert.deepEqual(Object.keys(written.fixtures[1]), ['name', 'class', 'hit', 'lineDelta', 'categoryMatch', 'findings', 'lostAt', 'event', 'lanes', 'seconds', 'costUsd', 'exitCode']);
  assert.deepEqual(Object.keys(written.summary), ['keyBugRecall', 'causalLineHit', 'cleanSilence', 'positives', 'skipped', 'cleanFixtures', 'failedRuns', 'completedPositives', 'approved', 'lost']);
  for (const output of [plain.stdout, once.stdout]) {
    assert.match(output, /positive\/hit\s+hit \(line delta 0\)\n/);
    assert.match(output, /positive\/miss\s+miss \(line delta 6\), lost at posted-elsewhere\n/);
    assert.match(output, /key-bug recall 0\.50, causal-line hit 0\.50, clean silence 1\.00; 2 positive\(s\)/);
  }
  assert.doesNotThrow(() => readRecallResults(join(dir, 'once.json')));
});

test('recall --runs 3 records each run as an attempt, with hits, the mean and the range', async (t) => {
  // The second review of the canned hit finds its point already made on the pull request, so that run misses.
  let reviews = 0;
  const commandWith = (fetchImpl) => {
    reviews += 1;
    return inProcess(reviews === 2 ? alreadySaid(fetchImpl) : fetchImpl);
  };
  const seen = [];
  const run = await recall({ runs: 3 }, { commandWith, onResult: (result) => seen.push(result.name) });
  const { fixtures, summary } = run.results;
  assert.deepEqual(seen, ['positive/hit', 'positive/miss', 'positive/skipped', 'no-findings/clean'], 'one result per fixture, once its runs are done');
  const [hit, miss, skipped, clean] = fixtures;

  assert.deepEqual(Object.keys(hit), ['name', 'class', 'runs', 'hits', 'lanes', 'attempts'], 'no single-run field is left to be read as the answer');
  assert.equal(hit.runs, 3);
  assert.equal(hit.hits, 2);
  assert.deepEqual(hit.attempts.map((attempt) => attempt.hit), [true, false, true]);
  assert.deepEqual(hit.attempts.map((attempt) => attempt.lostAt), [null, 'dropped-at-check', null]);
  assert.deepEqual(hit.attempts.map((attempt) => attempt.lineDelta), [0, null, 0]);
  assert.deepEqual(Object.keys(hit.attempts[0]), ['hit', 'lineDelta', 'categoryMatch', 'findings', 'lostAt', 'event', 'seconds', 'costUsd', 'exitCode']);
  assert.ok(hit.lanes.includes('diff'));
  assert.equal(miss.hits, 0);
  assert.deepEqual(miss.attempts.map((attempt) => attempt.lostAt), ['posted-elsewhere', 'posted-elsewhere', 'posted-elsewhere']);
  assert.deepEqual(skipped, { name: 'positive/skipped', class: 'positive', skipped: 'Not a stage the driver runs.' });
  assert.deepEqual(Object.keys(clean), ['name', 'class', 'runs', 'silentRuns', 'lanes', 'attempts']);
  assert.equal(clean.silentRuns, 3);
  assert.deepEqual(clean.attempts.map((attempt) => [attempt.silent, attempt.event]), [[true, 'APPROVE'], [true, 'APPROVE'], [true, 'APPROVE']]);

  assert.deepEqual(hit.attempts.map((attempt) => attempt.event), ['COMMENT', 'APPROVE', 'COMMENT'], 'with its one candidate dropped, the second run approved');
  assert.deepEqual(summary, {
    keyBugRecall: (0.5 + 0 + 0.5) / 3,
    causalLineHit: (0.5 + 0 + 0.5) / 3,
    cleanSilence: 1,
    positives: 2,
    skipped: 1,
    cleanFixtures: 1,
    failedRuns: 0,
    completedPositives: 6,
    approved: 1,
    lost: lost({ 'posted-elsewhere': 3, 'dropped-at-check': 1 }),
    runs: 3,
    ranges: {
      keyBugRecall: { lowest: 0, highest: 0.5, runs: [0.5, 0, 0.5] },
      causalLineHit: { lowest: 0, highest: 0.5, runs: [0.5, 0, 0.5] },
      cleanSilence: { lowest: 1, highest: 1, runs: [1, 1, 1] },
    },
  });

  const file = join(scratch(t), 'three.json');
  writeFileSync(file, JSON.stringify(run.results));
  assert.deepEqual(readRecallResults(file).summary, summary, 'the validator reads what the harness wrote');
});

test('a run that failed is counted within its own run, and the mean is over the runs that have a rate', () => {
  const attempt = (hit, lostAt) => ({ name: 'positive/a', class: 'positive', hit, lineDelta: hit ? 0 : null, lostAt, event: 'COMMENT', lanes: ['diff'], exitCode: 0 });
  const broken = { name: 'positive/a', class: 'positive', hit: null, lineDelta: null, lanes: [], exitCode: 7, error: 'an agent failed twice' };
  const fixtures = [
    combineAttempts([attempt(true, null), broken, attempt(false, 'below-gate')]),
    { name: 'positive/b', class: 'positive', skipped: 'no stage' },
  ];
  assert.equal(fixtures[0].hits, 1);
  assert.deepEqual(fixtures[0].lanes, ['diff'], 'the lanes are the fixture, not the run');
  assert.equal('lanes' in fixtures[0].attempts[0], false);
  const summary = summariseResults(fixtures, 3);
  assert.deepEqual(summary.ranges.keyBugRecall, { lowest: 0, highest: 1, runs: [1, null, 0] }, 'the failed run has no rate, as a failed run has none today');
  assert.equal(summary.keyBugRecall, 0.5, 'the mean of the two runs that completed');
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.completedPositives, 2);
  assert.equal(summary.positives, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.cleanSilence, null);
  assert.deepEqual(summary.ranges.cleanSilence, { lowest: null, highest: null, runs: [null, null, null] });
});

test('--keep, --only, --class and --mode work with --runs, and every run keeps its own store', async (t) => {
  const run = await recall({ runs: 2, keep: true });
  t.after(() => rmSync(dirname(dirname(run.dataDir)), { recursive: true, force: true }));
  assert.equal(run.kept, true);
  assert.equal(run.dataDirs.length, 2);
  assert.equal(run.dataDirs[0], run.dataDir);
  assert.notEqual(run.dataDirs[0], run.dataDirs[1]);
  const { DatabaseSync } = await import('node:sqlite');
  for (const dataDir of run.dataDirs) {
    const db = new DatabaseSync(join(dataDir, 'review-voice.db'));
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n, 3, 'one recorded run per completed fixture, in each store');
    } finally {
      db.close();
    }
  }

  const narrowed = await recall({ runs: 2, only: 'hit', classes: ['positive'], mode: 'fast' });
  assert.equal(existsSync(narrowed.dataDir), false, 'without --keep every store is removed');
  assert.equal(narrowed.results.mode, 'fast');
  assert.deepEqual(narrowed.results.fixtures.map((fixture) => [fixture.name, fixture.runs, fixture.hits]), [['positive/hit', 2, 2]]);
  const clean = await recall({ runs: 2, classes: ['no-findings'] });
  assert.deepEqual(clean.results.fixtures.map((fixture) => [fixture.name, fixture.silentRuns]), [['no-findings/clean', 2]]);
  assert.equal(clean.results.summary.keyBugRecall, null);
});

test('a finding one run held is not dropped from the next run as a repeat of it', async (t) => {
  // In one store the first run would be an earlier run of the same pull request, and its hold would drop the candidate at the check.
  const run = await recall({ fixtures: variant(t, { 'challenger.1.json': REFUTED }), classes: ['positive'], runs: 2 });
  const [fixture] = run.results.fixtures;
  assert.deepEqual(fixture.attempts.map((attempt) => [attempt.exitCode, attempt.lostAt]), [[0, 'challenge'], [0, 'challenge']], 'each run is lost where the first was, since neither saw the other');
  assert.deepEqual(run.results.summary.lost, lost({ challenge: 2 }));
});

test('the command prints hits over runs for each fixture and each rate with its range, to the file --out names', (t) => {
  const dir = scratch(t);
  const out = join(dir, 'nested', 'twice.json');
  const result = command(cli, dir, '--runs', '2', '--out', out, '--keep');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /positive\/hit\s+2\/2 runs hit\n/);
  assert.match(result.stdout, /positive\/miss\s+0\/2 runs hit; lost at posted-elsewhere 2\n/);
  assert.match(result.stdout, /positive\/skipped\s+skipped: Not a stage the driver runs\.\n/);
  assert.match(result.stdout, /no-findings\/clean\s+2\/2 runs silent\n/);
  assert.match(result.stdout, /key-bug recall 0\.50 \(0\.50 to 0\.50\), causal-line hit 0\.50 \(0\.50 to 0\.50\), clean silence 1\.00 \(1\.00 to 1\.00\); mean of 2 runs with the lowest and highest run; 2 positive\(s\), 1 clean, 1 skipped, 0 failed run\(s\)/);
  const kept = [...result.stdout.matchAll(/^Kept: (.+)$/gm)].map((match) => match[1]);
  t.after(() => kept.forEach((store) => rmSync(dirname(dirname(store)), { recursive: true, force: true })));
  assert.equal(kept.length, 2, 'both stores are named');
  assert.ok(kept.every((store) => existsSync(join(store, 'review-voice.db'))));
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.runs, 2);
});

test('a bad --runs value is refused before anything runs', (t) => {
  const dir = scratch(t);
  const out = join(dir, 'never.json');
  for (const value of ['0', '-1', '1.5', 'three', '1e2', '']) {
    const result = command(cli, dir, '--out', out, '--runs', value);
    assert.equal(result.status, 2, `--runs ${value}: ${result.stdout}`);
    assert.match(result.stderr, /--runs takes a positive whole number/);
  }
  const bare = command(cli, dir, '--out', out, '--runs');
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--runs needs a value/);
  assert.equal(existsSync(out), false);
});

test('a --runs count too large to run is a usage error that leaves nothing behind', async (t) => {
  const dir = scratch(t);
  const temporary = join(dir, 'tmp');
  mkdirSync(temporary);
  const out = join(dir, 'never.json');
  // 4294967296 is one more than a list can hold, and the next is not a whole number any more once read.
  for (const value of ['4294967296', '99999999999999999999999', String(MAX_RUNS + 1)]) {
    const result = spawnSync(process.execPath, [cli, 'recall', '--fixtures', canned, '--runner', 'fake', '--only', 'positive/skipped', '--out', out, '--runs', value], { encoding: 'utf8', cwd: dir, env: { ...process.env, TMPDIR: temporary } });
    assert.equal(result.status, 2, `--runs ${value}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stderr.split('\n')[0], `--runs takes a positive whole number up to ${MAX_RUNS}; ${value} is not one.`);
  }
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(temporary), [], 'no temporary directory is left');

  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = temporary;
  t.after(() => (saved === undefined ? delete process.env['TMPDIR'] : (process.env['TMPDIR'] = saved)));
  for (const runs of [4294967296, MAX_RUNS + 1, 0, 1.5]) await assert.rejects(recall({ runs }), RecallUsageError, `runs ${runs}`);
  assert.deepEqual(readdirSync(temporary), [], 'and none by the harness called directly');
  assert.ok((await runInProcess(['help', 'recall'])).stdout.includes(`number up to ${MAX_RUNS},`), 'the help names the limit');
});

test('an attempt is counted under the class of its fixture, whatever it carries', () => {
  const run = { hit: true, lineDelta: 0, findings: 1, lostAt: null, event: 'COMMENT', exitCode: 0 };
  const fixtures = [{ name: 'positive/a', class: 'positive', runs: 2, hits: 2, lanes: ['diff'], attempts: [run, { ...run, name: 'no-findings/z', class: 'no-findings' }] }];
  const summary = summariseResults(fixtures, 2);
  assert.equal(summary.completedPositives, 2);
  assert.equal(summary.cleanFixtures, 0);
  assert.equal(summary.cleanSilence, null);
  assert.deepEqual(summary.ranges.keyBugRecall.runs, [1, 1]);
});

/** A results file under `dir` holding these fixtures, with the summary they give unless one is passed. */
function resultsFile(dir, name, fixtures, runs = 1, summary = summariseResults(fixtures, runs)) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ pluginVersion: '9.9.9', mode: 'auto', runner: 'fake', fixtures, summary }));
  return path;
}

const hitRun = { hit: true, lineDelta: 0, findings: 1, lostAt: null, event: 'COMMENT', exitCode: 0 };
const missRun = { hit: false, lineDelta: null, findings: 0, lostAt: 'below-gate', event: 'APPROVE', exitCode: 0 };
const silentRun = { silent: true, findings: 0, event: 'APPROVE', exitCode: 0 };
/** Three runs of two positives and a clean fixture, as `recall --runs 3` records them. */
const threeRuns = () => [
  { name: 'positive/a', class: 'positive', runs: 3, hits: 2, lanes: ['diff'], attempts: [hitRun, missRun, hitRun] },
  { name: 'positive/b', class: 'positive', runs: 3, hits: 0, lanes: ['diff'], attempts: [missRun, missRun, missRun] },
  { name: 'positive/c', class: 'positive', skipped: 'no stage' },
  { name: 'no-findings/d', class: 'no-findings', runs: 3, silentRuns: 3, lanes: ['diff'], attempts: [silentRun, silentRun, silentRun] },
];
const oneRun = () => [
  { name: 'positive/a', class: 'positive', ...hitRun },
  { name: 'positive/b', class: 'positive', ...missRun },
  { name: 'positive/c', class: 'positive', skipped: 'no stage' },
];

test('the validator accepts both shapes and refuses a file that mixes them', (t) => {
  const dir = scratch(t);
  assert.equal(readRecallResults(resultsFile(dir, 'one', oneRun())).summary.runs, undefined);
  const three = readRecallResults(resultsFile(dir, 'three', threeRuns(), 3));
  assert.equal(three.summary.runs, 3);
  assert.deepEqual(three.summary.ranges.keyBugRecall, { lowest: 0, highest: 0.5, runs: [0.5, 0, 0.5] });

  const refused = (name, fixtures, runs, pattern, summary = summariseResults(threeRuns(), 3)) => assert.throws(() => readRecallResults(resultsFile(dir, name, fixtures, runs, summary)), pattern, name);
  const mixed = threeRuns();
  mixed[1] = { name: 'positive/b', class: 'positive', ...missRun };
  refused('a single-run fixture among attempts', mixed, 3, /fixtures\[1\] does not carry the 3 attempts the summary records/);
  refused('attempts under a summary of one run', threeRuns(), 1, /fixtures\[0\] carries runs, hits, attempts, but the summary records one run/, summariseResults(oneRun()));
  const both = threeRuns();
  both[0] = { ...both[0], ...hitRun };
  refused('single-run fields beside attempts', both, 3, /fixtures\[0\] carries hit, lineDelta, findings, lostAt, event, exitCode beside its attempts/);
  const short = threeRuns();
  short[0] = { ...short[0], attempts: [hitRun, missRun] };
  refused('fewer attempts than runs', short, 3, /fixtures\[0\] does not carry the 3 attempts/);
  const skipped = threeRuns();
  skipped[2] = { ...skipped[2], runs: 3, attempts: [hitRun, hitRun, hitRun] };
  refused('a skipped fixture with attempts', skipped, 3, /fixtures\[2\]: a skipped fixture carries no result, but this one has runs, attempts/);
  refused('a run count of one', oneRun(), 1, /summary\.runs is not a whole number above 1/, { ...summariseResults(oneRun()), runs: 1 });
  const { ranges } = summariseResults(threeRuns(), 3);
  refused('ranges under a summary of one run', oneRun(), 1, /summary\.ranges is given, but the summary records one run/, { ...summariseResults(oneRun()), ranges });
  const { lost: _lost, ...withoutLost } = summariseResults(oneRun());
  refused('one run with approvals and no loss counts', oneRun(), 1, /summary\.lost is undefined but the fixtures give/, withoutLost);
  const { completedPositives: _completed, approved: _approved, ...lostAlone } = summariseResults(oneRun());
  refused('one run with loss counts alone', oneRun(), 1, /summary\.completedPositives is undefined but the fixtures give 2/, lostAlone);
});

test('the validator refuses counts that disagree with the attempts or the fixtures', (t) => {
  const dir = scratch(t);
  const three = (name, edit, pattern, editSummary = (summary) => summary) => {
    const fixtures = threeRuns();
    edit(fixtures);
    const summary = editSummary(summariseResults(fixtures, 3));
    assert.throws(() => readRecallResults(resultsFile(dir, name, fixtures, 3, summary)), pattern, name);
  };
  three('hits', (fixtures) => { fixtures[0].hits = 3; }, /fixtures\[0\]\.hits is 3 but its attempts give 2/);
  three('silentRuns', (fixtures) => { fixtures[3].silentRuns = 1; }, /fixtures\[3\]\.silentRuns is 1 but its attempts give 3/);
  three('the other count', (fixtures) => { fixtures[0].silentRuns = 0; }, /fixtures\[0\] is a positive fixture and carries silentRuns/);
  three('runs on a fixture', (fixtures) => { fixtures[0].runs = 2; }, /fixtures\[0\] does not carry the 3 attempts/);
  three('an attempt that cannot be true', (fixtures) => { fixtures[0].attempts[1] = { ...missRun, lineDelta: 1, findings: 1 }; }, /fixtures\[0\]\.attempts\[1\]: hit is false but lineDelta is 1/);
  three('a skipped attempt', (fixtures) => { fixtures[0].attempts[1] = { skipped: 'r' }; }, /fixtures\[0\]\.attempts\[1\] is not one run/);
  three('a lostAt on a hit', (fixtures) => { fixtures[0].attempts[0] = { ...hitRun, lostAt: 'challenge' }; }, /fixtures\[0\]\.attempts\[0\]: lostAt is challenge but hit is true/);
  three('no lostAt on a miss', (fixtures) => { fixtures[0].attempts[1] = { ...missRun, lostAt: null }; }, /fixtures\[0\]\.attempts\[1\]: lostAt is null but hit is false/);
  three('an unknown lostAt', (fixtures) => { fixtures[0].attempts[1] = { ...missRun, lostAt: 'somewhere' }; }, /fixtures\[0\]\.attempts\[1\]\.lostAt is not null or one of not-raised/);
  three('an attempt with a class of its own', (fixtures) => { fixtures[0].attempts[1] = { ...missRun, class: 'no-findings' }; }, /fixtures\[0\]\.attempts\[1\] carries class, which one run does not record/);
  three('an attempt with fixture fields', (fixtures) => { fixtures[0].attempts[0] = { ...hitRun, name: 'positive/z', lanes: ['diff'], runs: 3, attempts: [] }; }, /fixtures\[0\]\.attempts\[0\] carries name, lanes, runs, attempts, which one run does not record/);
  three('an event that is not text', (fixtures) => { fixtures[0].attempts[1] = { ...missRun, event: 3 }; }, /fixtures\[0\]\.attempts\[1\]\.event is not a string or null/);
  const same = () => {};
  three('the mean', same, /summary\.keyBugRecall is 0\.5 but the fixtures give 0\.33/, (summary) => ({ ...summary, keyBugRecall: 0.5 }));
  three('the range', same, /summary\.ranges is .* but the fixtures give/, (summary) => ({ ...summary, ranges: { ...summary.ranges, keyBugRecall: { ...summary.ranges.keyBugRecall, lowest: 0.5 } } }));
  three('no ranges', same, /summary\.ranges does not give every rate a value for each of the 3 runs/, ({ ranges: _ranges, ...summary }) => summary);
  three('a short range', same, /summary\.ranges does not give every rate a value for each of the 3 runs/, (summary) => ({ ...summary, ranges: { ...summary.ranges, cleanSilence: { lowest: 1, highest: 1, runs: [1, 1] } } }));
  three('the run count', same, /fixtures\[0\] does not carry the 2 attempts/, (summary) => ({ ...summary, runs: 2 }));
  three('the loss counts', same, /summary\.lost is .* but the fixtures give/, (summary) => ({ ...summary, lost: lost({ 'below-gate': 1 }) }));
  three('the approvals', same, /summary\.approved is 0 but the fixtures give 4/, (summary) => ({ ...summary, approved: 0 }));
  three('no loss counts', same, /summary\.lost is undefined but the fixtures give/, ({ lost: _lost, ...summary }) => summary);

  // A run count no list in the file backs is refused before a summary is built for each run.
  const unbacked = { ...summariseResults([], 2), runs: 1_000_000_000 };
  assert.throws(() => readRecallResults(resultsFile(dir, 'unbacked', [], 1, unbacked)), /summary\.ranges does not give every rate a value for each of the 1000000000 runs/);

  const single = (name, summary, pattern) => assert.throws(() => readRecallResults(resultsFile(dir, name, oneRun(), 1, summary)), pattern, name);
  single('single loss counts', { ...summariseResults(oneRun()), lost: lost() }, /summary\.lost is .* but the fixtures give/);
  single('single approvals', { ...summariseResults(oneRun()), approved: 2 }, /summary\.approved is 2 but the fixtures give 1/);
  single('single completed positives', { ...summariseResults(oneRun()), completedPositives: 1 }, /summary\.completedPositives is 1 but the fixtures give 2/);
});

test('a results file written before lostAt existed is still read', (t) => {
  const dir = scratch(t);
  const fixtures = [
    { name: 'positive/a', class: 'positive', hit: true, lineDelta: 0, exitCode: 0 },
    { name: 'positive/b', class: 'positive', hit: false, lineDelta: 5, exitCode: 0 },
  ];
  const summary = { keyBugRecall: 0.5, causalLineHit: 0.5, cleanSilence: null, positives: 2, skipped: 0, cleanFixtures: 0, failedRuns: 0 };
  assert.deepEqual(readRecallResults(resultsFile(dir, 'earlier', fixtures, 1, summary)).summary, summary);
  const committed = readRecallResults(join(root, 'docs/evaluation/recall-1.22.0.json'));
  assert.equal(committed.summary.positives, 22, 'the committed 1.22.0 results still read');
  assert.equal(committed.summary.runs, undefined, 'and they are one run');
});

/** `evaluate` against a fresh, empty store. */
const evaluate = (dir, ...args) => spawnSync(process.execPath, [cli, 'evaluate', ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'store') } });
const fixtureMetrics = (result) => JSON.parse(result.stdout).metrics.filter((metric) => metric.name.startsWith('fixture_'));

test('evaluate --recall reads both shapes, and for several runs gives the mean with the number of runs and the range', (t) => {
  const dir = scratch(t);
  const single = evaluate(dir, '--recall', resultsFile(dir, 'one', oneRun()), '--json');
  assert.equal(single.status, 0, single.stderr);
  assert.deepEqual(fixtureMetrics(single).map((metric) => metric.value), [0.5, 1, null]);
  assert.match(fixtureMetrics(single)[0].basis, /^1\/2 completed positives had a finding on an accepted anchor; 1 skipped, 0 failed run\(s\) excluded \(plugin 9\.9\.9, runner fake, mode auto\)$/);

  const file = resultsFile(dir, 'three', threeRuns(), 3);
  const several = evaluate(dir, '--recall', file, '--json');
  assert.equal(several.status, 0, several.stderr);
  const metrics = fixtureMetrics(several);
  assert.deepEqual(metrics.map((metric) => metric.name), ['fixture_key_bug_recall', 'fixture_causal_line_hit', 'fixture_clean_silence']);
  assert.deepEqual(metrics.map((metric) => metric.value), [(0.5 + 0 + 0.5) / 3, 1, 1], 'each value is the mean over the runs that have one');
  assert.match(metrics[0].basis, /^mean of 3 runs, lowest 0\.00, highest 0\.50, of completed positives with a finding on an accepted anchor; 1 skipped, 0 failed run\(s\) excluded \(plugin 9\.9\.9, runner fake, mode auto\)$/);
  assert.match(metrics[1].basis, /^mean of 3 runs, lowest 1\.00, highest 1\.00, of positives with a finding on an expected file/);
  assert.match(metrics[2].basis, /^mean of 3 runs, lowest 1\.00, highest 1\.00, of completed clean fixtures/);
  assert.ok(metrics.every((metric) => metric.kind === 'goal' && metric.meets === true), 'goals, not gates');
  assert.deepEqual(recallMetrics(readRecallResults(file)).map((metric) => metric.basis), metrics.map((metric) => metric.basis));

  const text = evaluate(dir, '--recall', file);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /mean of 3 runs, lowest 0\.00, highest 0\.50/);

  const mixed = threeRuns();
  mixed[1] = { name: 'positive/b', class: 'positive', ...missRun };
  const refused = evaluate(dir, '--recall', resultsFile(dir, 'mixed', mixed, 3, summariseResults(threeRuns(), 3)));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /fixtures\[1\] does not carry the 3 attempts/);
});

test('the built bundle runs recall --runs and evaluate reads what it wrote', (t) => {
  const dir = scratch(t);
  const out = join(dir, 'bundle.json');
  const result = command(bundle, dir, '--runs', '2', '--only', 'positive/miss', '--out', out);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /positive\/miss\s+0\/2 runs hit; lost at posted-elsewhere 2\n/);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.summary.runs, 2);
  assert.deepEqual(written.fixtures[0].attempts.map((attempt) => [attempt.lostAt, attempt.event]), [['posted-elsewhere', 'COMMENT'], ['posted-elsewhere', 'COMMENT']]);
  const read = spawnSync(process.execPath, [bundle, 'evaluate', '--recall', out], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'store') } });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /mean of 2 runs, lowest 0\.00, highest 0\.00/);
});

test('the help and docs/EVALUATION.md say what --runs and lostAt mean', async () => {
  const recallHelp = (await runInProcess(['help', 'recall'])).stdout;
  assert.match(recallHelp, /--runs <n>/);
  for (const stage of LOST_AT) assert.ok(recallHelp.includes(stage), `recall help names ${stage}`);
  assert.match(recallHelp, /lostAt/);
  assert.match(recallHelp, /attempts/);
  const evaluateHelp = (await runInProcess(['help', 'evaluate'])).stdout;
  assert.match(evaluateHelp, /--runs/);
  assert.match(evaluateHelp, /range/);

  const guide = readFileSync(join(root, 'docs/EVALUATION.md'), 'utf8');
  const section = guide.slice(guide.indexOf('## Fixture recall'), guide.indexOf('## Reading the numbers')).replace(/\s+/g, ' ');
  for (const stage of LOST_AT) assert.ok(section.includes(`\`${stage}\``), `the guide says what ${stage} means`);
  assert.match(section, /--runs/);
  assert.match(section, /A recall figure is stated with its number of runs and its range/);
  assert.match(section, /called a regression only when its range sits below the earlier range/);
  assert.match(section, /### Measured on 1\.22\.0 .* These figures are one run/);
});
