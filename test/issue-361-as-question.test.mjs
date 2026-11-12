/**
 * Issue 361: a held minor could not be posted as a question, because
 * validate-output checks the tag against the scored tier and no score option
 * changed a tier to `question`. `score --as-question <id>` now posts a verified
 * minor or nit as a question, past the gate that held it as `--promote` would,
 * and records the choice so the score, the tag, the verdict and `explain` agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { compileProposals } from '../plugins/review-voice/src/policy/compile.ts';
import { approvePolicy, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';
import { planFindings } from '../plugins/review-voice/src/publish/verdict.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const candidate = (over = {}) => ({
  candidate_id: 'cand_001',
  path: 'ci/paths.ts',
  line: 2,
  category: 'reliability',
  severity: 'minor',
  claim: 'The renamed workflow path skips the required check.',
  failure_mode: 'A protected change can merge without the check running.',
  evidence: ['ci/paths.ts:2 adds a path guard shared by every workflow.'],
  technical_confidence: 0.9,
  ...over,
});

const verified = [{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 }];
const QUESTION = '[question] `ci/paths.ts:2` - Does the renamed workflow path still run the required check?\n';
const MINOR = '[minor] `ci/paths.ts:2` - The renamed workflow path skips the required check.\n';
const NIT = '[nit] `ci/paths.ts:2` - The renamed workflow path skips the required check.\n';

const patch = [
  'diff --git a/ci/paths.ts b/ci/paths.ts',
  '--- a/ci/paths.ts',
  '+++ b/ci/paths.ts',
  '@@ -1 +1,2 @@',
  ' export const sharedPaths = [];',
  '+export function SharedPipelineGuard() { return true; }',
  '',
].join('\n');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-361-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args, input = '') {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
  });
}

function repository(dir) {
  mkdirSync(join(dir, 'ci'), { recursive: true });
  writeFileSync(join(dir, 'ci', 'paths.ts'), 'export const sharedPaths = [];\n');
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  writeFileSync(join(dir, 'ci', 'paths.ts'), 'export const sharedPaths = [];\nexport function SharedPipelineGuard() { return true; }\n');
  writeFileSync(join(dir, 'change.patch'), patch);
}

function score(dir, extra, { verifications = verified, candidates = [candidate()] } = {}) {
  const verification = join(dir, 'verification.json');
  writeFileSync(verification, JSON.stringify(verifications));
  return run(dir, ['score', '--verification', verification, '--diff-file', join(dir, 'change.patch'), ...extra], JSON.stringify({ candidates }));
}

function scored(dir, extra, options) {
  const result = score(dir, extra, options);
  assert.equal(result.status, 0, result.stderr);
  return { out: JSON.parse(result.stdout), text: result.stdout };
}

/** Validates and records `review` against the score text, and returns the run's planned verdict. */
function postThrough(dir, scoreText, review, minPostedTier = 'nit') {
  const scores = join(dir, 'scores.json');
  writeFileSync(scores, scoreText);
  const validated = run(dir, ['validate-output', '--scores', scores], review);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  const recorded = run(dir, ['record', '--scores', scores], review);
  assert.equal(recorded.status, 0, recorded.stderr);
  const runId = JSON.parse(recorded.stdout).reviewRunId;
  const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: join(dir, 'data') }));
  try {
    const detail = runDetail(db, runId);
    const planned = planFindings(review, detail, (id) => runDetail(db, id), minPostedTier);
    return { runId, detail, planned, mapped: planned.mapped };
  } finally {
    db.close();
  }
}

test('a below-gate minor posted with --as-question validates as a question and comments', () =>
  withDir((dir) => {
    repository(dir);
    const held = scored(dir, ['--min-score', '0.99']).out;
    assert.equal(held.belowGate.length, 1);
    assert.equal(held.belowGate[0].severity, 'minor');

    const { out, text } = scored(dir, ['--min-score', '0.99', '--as-question', 'cand_001']);
    assert.deepEqual(out.belowGate, []);
    assert.equal(out.eligible.length, 1);
    assert.equal(out.eligible[0].severity, 'question');
    assert.equal(out.eligible[0].requestedSeverity, 'minor');
    assert.match(out.eligible[0].severityReason, /the owner posted this as a question$/);
    assert.equal(out.scores[0].ownerQuestion, true);
    assert.equal(out.scores[0].ownerPromotion.gate, 'score');

    // The tag must now be the question one: the minor tag no longer matches the score.
    const scores = join(dir, 'scores.json');
    writeFileSync(scores, text);
    const asMinor = run(dir, ['validate-output', '--scores', scores], MINOR);
    assert.notEqual(asMinor.status, 0);
    assert.match(asMinor.stdout + asMinor.stderr, /tagged minor but its score derived question/);

    const { mapped } = postThrough(dir, text, QUESTION);
    assert.equal(mapped, 'COMMENT');
  }));

test('a below-gate nit posted with --as-question comments where it would have approved', () =>
  withDir((dir) => {
    repository(dir);
    const nit = { candidates: [candidate({ category: 'style' })] };
    const promoted = scored(dir, ['--min-score', '0.99', '--promote', 'cand_001'], nit);
    assert.equal(promoted.out.eligible[0].severity, 'nit');
    assert.equal(postThrough(dir, promoted.text, NIT).mapped, 'APPROVE');

    const { out, text } = scored(dir, ['--min-score', '0.99', '--as-question', 'cand_001'], nit);
    assert.equal(out.eligible[0].severity, 'question');
    assert.equal(out.eligible[0].requestedSeverity, 'minor');
    assert.equal(postThrough(dir, text, QUESTION).mapped, 'COMMENT');
  }));

test('a nit posted as a question stays below a minor posting tier, as a promoted nit does', () =>
  withDir((dir) => {
    repository(dir);
    const nit = { candidates: [candidate({ category: 'style' })] };
    const promoted = postThrough(dir, scored(dir, ['--min-score', '0.99', '--promote', 'cand_001'], nit).text, NIT, 'minor').planned;
    assert.equal(promoted.mapped, 'APPROVE');
    assert.deepEqual(promoted.belowTier.map((f) => f.severity), ['nit']);

    for (const extra of [['--min-score', '0.99', '--as-question', 'cand_001'], ['--as-question', 'cand_001']]) {
      const { out, text } = scored(dir, extra, nit);
      assert.equal(out.scores[0].ownerQuestionFrom, 'nit');
      const planned = postThrough(dir, text, QUESTION, 'minor').planned;
      assert.equal(planned.mapped, 'APPROVE');
      assert.deepEqual(planned.inline, []);
      assert.deepEqual(planned.belowTier.map((f) => f.severity), ['question']);
    }

    // A minor posted as a question still clears a minor posting tier.
    const minor = postThrough(dir, scored(dir, ['--as-question', 'cand_001']).text, QUESTION, 'minor').planned;
    assert.equal(minor.mapped, 'COMMENT');
    assert.deepEqual(minor.inline.map((f) => f.severity), ['question']);
  }));

test('an eligible minor posted with --as-question changes only its tier', () =>
  withDir((dir) => {
    repository(dir);
    const plain = scored(dir, []).out;
    assert.equal(plain.eligible[0].severity, 'minor');
    const { out } = scored(dir, ['--as-question', 'cand_001']);
    const [before] = plain.scores;
    const [after] = out.scores;
    assert.equal(after.eligible, true);
    assert.equal(after.ownerPromotion, undefined);
    assert.equal(after.ownerQuestion, true);
    assert.equal(after.severity.severity, 'question');
    assert.equal(after.severity.reason, `${before.severity.reason}, the owner posted this as a question`);
    assert.equal(after.ownerQuestionFrom, 'minor');
    const { severity: _a, ownerQuestion: _b, ownerQuestionFrom: _d, ...restAfter } = after;
    const { severity: _c, ...restBefore } = before;
    assert.deepEqual(restAfter, restBefore);
  }));

test('a suppressed finding posts as a question past the policy that held it', () =>
  withDir((dir) => {
    repository(dir);
    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: join(dir, 'data') }));
    try {
      const output = [5, 6, 7].map((line) => `[minor] \`ci/paths.ts:${line}\` - Repeated calculation here. It drifts. Fix it.`).join('\n\n');
      recordRun(db, {
        repository: 'org/a', baseRef: null, headRef: null, diff: 'x', output,
        candidates: [5, 6, 7].map((line) => ({ path: 'ci/paths.ts', line, category: 'reliability' })),
      });
      for (const ref of ['rv_01', 'rv_02', 'rv_03']) recordFeedback(db, { findingRef: ref, action: 'dismiss', actor: 'owner' });
      const proposal = proposePolicy(db, compileProposals(db));
      assert.equal(approvePolicy(db, proposal.policyId).ok, true);
    } finally {
      db.close();
    }
    const held = scored(dir, []).out;
    assert.equal(held.suppressed.length, 1);
    assert.equal(held.suppressed[0].ruleId, 'reliability:diff');

    const { out, text } = scored(dir, ['--as-question', 'cand_001']);
    assert.deepEqual(out.suppressed, []);
    assert.equal(out.eligible[0].severity, 'question');
    assert.equal(out.scores[0].ownerPromotion.gate, 'policy');
    assert.equal(out.scores[0].ownerPromotion.ruleId, 'reliability:diff');
    assert.equal(postThrough(dir, text, QUESTION).mapped, 'COMMENT');
  }));

test('an important or blocking finding is refused, with the way to post it named', () =>
  withDir((dir) => {
    repository(dir);
    const tiers = [
      ['important', candidate({ category: 'concurrency', severity: 'important' })],
      ['blocking', candidate({ category: 'security' })],
    ];
    for (const [tier, raised] of tiers) {
      assert.equal(scored(dir, [], { candidates: [raised] }).out.scores[0].severity.severity, tier);
      const refused = score(dir, ['--min-score', '0.99', '--as-question', 'cand_001'], { candidates: [raised] });
      assert.equal(refused.status, 2, refused.stdout);
      assert.match(refused.stderr, new RegExp(`--as-question cand_001: its tier is ${tier}`));
      assert.match(refused.stderr, /would soften a request for changes into a comment/);
      assert.match(refused.stderr, /--promote/);
      assert.match(refused.stderr, /--severity/);
    }
  }));

test('a candidate the verifier did not verify is refused', () =>
  withDir((dir) => {
    repository(dir);
    // Eligible on its confidence alone, but with no verified verdict.
    const silent = [{ candidate_id: 'cand_001', technical_confidence: 0.9 }];
    assert.equal(scored(dir, [], { verifications: silent }).out.scores[0].eligible, true);
    for (const verifications of [silent, [{ candidate_id: 'cand_001', verified: false, technical_confidence: 0.9 }]]) {
      const refused = score(dir, ['--as-question', 'cand_001'], { verifications });
      assert.equal(refused.status, 2, refused.stdout);
      assert.match(refused.stderr, /--as-question cand_001: the verifier did not verify it \(verified is not true\)/);
    }
  }));

test('a candidate already scored as a question is refused', () =>
  withDir((dir) => {
    repository(dir);
    const question = { candidates: [candidate({ severity: 'question' })], verifications: [{ ...verified[0], premises_verified: true }] };
    assert.equal(scored(dir, [], question).out.eligible[0].severity, 'question');
    const refused = score(dir, ['--as-question', 'cand_001'], question);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /--as-question cand_001: it is already a question/);
  }));

test('an unknown or repeated candidate id is refused', () =>
  withDir((dir) => {
    repository(dir);
    const unknown = score(dir, ['--as-question', 'cand_404']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /--as-question names unknown candidate "cand_404"/);
    const twice = score(dir, ['--as-question', 'cand_001', '--as-question', 'cand_001']);
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /--as-question names "cand_001" more than once/);
    const bare = score(dir, ['--as-question']);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /--as-question needs a candidate_id/);
  }));

test('--promote with --as-question on one candidate equals --as-question alone', () =>
  withDir((dir) => {
    repository(dir);
    for (const gate of [['--min-score', '0.99'], []]) {
      const alone = scored(dir, [...gate, '--as-question', 'cand_001']).text;
      const both = scored(dir, [...gate, '--promote', 'cand_001', '--as-question', 'cand_001']).text;
      assert.equal(both, alone);
    }
    // Alone, --promote refuses a finding that is already eligible.
    assert.equal(score(dir, ['--promote', 'cand_001']).status, 2);
  }));

test('an unverifiable finding posts as a question only with --allow-unverifiable and a note', () =>
  withDir((dir) => {
    repository(dir);
    const capped = { verifications: [{ ...verified[0], technical_confidence: 0.7, required_context_missing: ['whether a later change reorders the calls'] }] };
    const refused = score(dir, ['--as-question', 'cand_001'], capped);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--as-question cand_001: it is capped as unverifiable .*--allow-unverifiable/);
    const note = 'The ordering was checked by hand at head.';
    const { out } = scored(dir, ['--as-question', 'cand_001', '--allow-unverifiable', '--owner-note', note], capped);
    assert.equal(out.eligible[0].severity, 'question');
    assert.equal(out.scores[0].ownerPromotion.gate, 'unverifiable');
    assert.equal(out.scores[0].ownerPromotion.ownerNote, note);
  }));

test('record stores ownerQuestion with the finding and explain shows the owner posted it as a question', () =>
  withDir((dir) => {
    repository(dir);
    const { text } = scored(dir, ['--min-score', '0.99', '--as-question', 'cand_001']);
    const { runId, detail } = postThrough(dir, text, QUESTION);
    const stored = detail.scores.find((entry) => entry.candidate_id === 'cand_001');
    assert.equal(stored.ownerQuestion, true);
    assert.equal(detail.findings[0].severity, 'question');

    const explained = run(dir, ['explain', '--run', runId]);
    assert.equal(explained.status, 0, explained.stderr);
    assert.match(explained.stdout, /\[question\] ci\/paths\.ts:2\n(?:.*\n)*? {2}owner {13}posted this as a question\n/);

    // A finding the owner did not raise says nothing of the kind.
    const plain = postThrough(dir, scored(dir, []).text, MINOR);
    assert.doesNotMatch(run(dir, ['explain', '--run', plain.runId]).stdout, /posted this as a question/);
  }));

test('a --severity override to minor followed by --as-question posts a question', () =>
  withDir((dir) => {
    repository(dir);
    const important = { candidates: [candidate({ category: 'concurrency', severity: 'important' })] };
    const { out, text } = scored(dir, ['--severity', 'cand_001=minor', '--as-question', 'cand_001'], important);
    assert.equal(out.eligible[0].severity, 'question');
    assert.match(out.eligible[0].severityReason, /held at minor by an explicit owner override, the owner posted this as a question$/);
    assert.equal(postThrough(dir, text, QUESTION).mapped, 'COMMENT');
  }));

test('the question cap does not hold a question the owner posted, nor count it against the analyst', () =>
  withDir((dir) => {
    const added = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'];
    mkdirSync(join(dir, 'ci'), { recursive: true });
    writeFileSync(join(dir, 'ci', 'paths.ts'), 'export const sharedPaths = [];\n');
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    writeFileSync(join(dir, 'ci', 'paths.ts'), ['export const sharedPaths = [];', ...added, ''].join('\n'));
    writeFileSync(
      join(dir, 'change.patch'),
      ['diff --git a/ci/paths.ts b/ci/paths.ts', '--- a/ci/paths.ts', '+++ b/ci/paths.ts', '@@ -1 +1,4 @@', ' export const sharedPaths = [];', ...added.map((l) => `+${l}`), ''].join('\n'),
    );
    const at = (id, line, severity, claim, confidence) =>
      candidate({ candidate_id: id, line, severity, claim, evidence: [`ci/paths.ts:${line} adds value ${id}.`], technical_confidence: confidence });
    const candidates = [
      at('cand_001', 2, 'question', 'Is constant a meant to be exported for the workflow runner?', 0.95),
      at('cand_002', 3, 'question', 'Does constant b need to match the runner timeout value?', 0.95),
      at('cand_003', 4, 'minor', 'Constant c duplicates the timeout defined in the runner config.', 0.9),
    ];
    const verifications = candidates.map((c) => ({ candidate_id: c.candidate_id, verified: true, premises_verified: true, technical_confidence: c.technical_confidence }));
    const held = scored(dir, [], { candidates, verifications }).out;
    assert.deepEqual(held.belowGate.map((b) => b.candidate_id), ['cand_003']);

    const { out, text } = scored(dir, ['--as-question', 'cand_003'], { candidates, verifications });
    assert.deepEqual(out.eligible.map((e) => e.candidate_id), ['cand_001', 'cand_002', 'cand_003']);
    assert.deepEqual(out.belowGate, []);

    const review = [
      '[question] `ci/paths.ts:2` - Is constant a meant to be exported for the workflow runner?',
      '[question] `ci/paths.ts:3` - Does constant b need to match the runner timeout value?',
      '[question] `ci/paths.ts:4` - Does constant c duplicate the timeout defined in the runner config?',
      '',
    ].join('\n\n');
    const scores = join(dir, 'scores.json');
    writeFileSync(scores, text);
    assert.equal(run(dir, ['validate-output', '--scores', scores], review).status, 0);
    const recorded = run(dir, ['record', '--scores', scores, '--diff-file', join(dir, 'change.patch')], review);
    assert.equal(recorded.status, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: join(dir, 'data') }));
    try {
      const plan = planFindings(review, runDetail(db, runId), (id) => runDetail(db, id));
      assert.deepEqual(plan.inline.map((f) => f.findingId), ['rv_01', 'rv_02', 'rv_03']);
      assert.deepEqual(plan.held, []);
    } finally {
      db.close();
    }
  }));

test('explain shows the owner question on the finding it backs when another candidate shares the anchor', () =>
  withDir((dir) => {
    repository(dir);
    const candidates = [
      candidate(),
      candidate({ candidate_id: 'cand_002', claim: 'The guard returns true for every input, so the filter is a no-op.', failure_mode: 'Every path passes the guard, so excluded paths run.' }),
    ];
    const verifications = [verified[0], { ...verified[0], candidate_id: 'cand_002' }];
    const { out, text } = scored(dir, ['--min-score', '0.99', '--as-question', 'cand_002'], { candidates, verifications });
    assert.deepEqual(out.scores.map((s) => [s.candidate_id, s.eligible]), [['cand_001', false], ['cand_002', true]]);
    const { runId } = postThrough(dir, text, '[question] `ci/paths.ts:2` - Does the guard return true for every input?\n');
    const explained = run(dir, ['explain', '--run', runId]);
    assert.equal(explained.status, 0, explained.stderr);
    assert.match(explained.stdout, /\[question\] ci\/paths\.ts:2\n(?:.*\n)*? {2}owner {13}posted this as a question\n/);
  }));
