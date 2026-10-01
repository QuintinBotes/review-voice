/**
 * A suggested fix is a second claim, verified separately from the defect.
 *
 * A traced defect and a safe repair are different things: on one pull request
 * two successive repairs for a real defect each broke a path the original code
 * already served, and independent cross-checks rejected the finding because of
 * the repair rather than the defect. These tests pin the separation - the fix
 * verdict decides only what the editor may render - and that it fails closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreCandidate,
  DEFAULT_THRESHOLDS,
  normaliseCandidate,
  editorFix,
} from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const read = (path) => readFileSync(join(plugin, path), 'utf8');

const ANALYST = read('agents/diff-analyst.md');
const VERIFIER = read('agents/evidence-verifier.md');
const EDITOR = read('agents/concise-editor.md');
const REVIEW = read('commands/review.md');

/** Runs with stdin and an isolated data directory, never the user's corpus. */
function runWithInput(args, input, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function withDir(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const candidate = (over = {}) => ({
  candidateId: 'cand_001',
  path: 'src/auth.ts',
  line: 84,
  category: 'correctness',
  severity: 'blocking',
  claim: 'The response returns a refresh token before its transaction commits.',
  failureMode: 'A request retry can create multiple valid tokens.',
  evidence: ['Transaction begins at line 65.', 'Response is returned at line 84.', 'Commit happens after the return path.'],
  technicalConfidence: 0.91,
  suggestedFix: 'Move the write after validation.',
  fixConfidence: 0.95,
  ...over,
});

const precedent = (over = {}) => ({
  eventId: 'gh_1',
  repository: 'acme/web',
  reviewerLogin: 'someone',
  role: 'owner',
  outcome: 'accepted',
  createdAt: '2026-09-01T00:00:00Z',
  filePath: 'src/auth.ts',
  lineStart: 84,
  excerpt: 'Same issue here.',
  weight: 1.2,
  relevance: 5,
  polarity: 'positive',
  ...over,
});

// A path that exists, because score rejects a citation of a file that does not.
const RAW = {
  candidate_id: 'cand_004',
  path: 'plugins/review-voice/src/scoring/score.ts',
  line: 12,
  category: 'correctness',
  severity: 'important',
  claim: 'The write runs before validation.',
  failure_mode: 'Invalid input reaches storage.',
  evidence: ['`writeRecord` runs at line 12.', 'Validation happens after the write.'],
  suggested_fix: 'Move the write after validation.',
  fix_confidence: 0.75,
  technical_confidence: 0.75,
};

const CANDIDATE_WITH_FIX = JSON.stringify({ candidates: [RAW] });

// The render rule

test('a fix renders only for the separately verified cases the CLI permits', () => {
  const cases = [
    { label: 'verified at the threshold', verdict: 'verified', confidence: 0.8, direction: undefined, render: 'fix' },
    { label: 'verified below the threshold', verdict: 'verified', confidence: 0.79, direction: undefined, render: 'none' },
    { label: 'partial with a direction', verdict: 'partial', confidence: 0.7, direction: 'Preserve the existing branch.', render: 'direction' },
    { label: 'partial without a direction', verdict: 'partial', confidence: 0.7, direction: undefined, render: 'none' },
    { label: 'refuted', verdict: 'refuted', confidence: 0.9, direction: undefined, render: 'none' },
    { label: 'absent', verdict: 'absent', confidence: 0.9, direction: undefined, render: 'none' },
    { label: 'missing', verdict: undefined, confidence: 0.9, direction: undefined, render: 'none' },
    { label: 'unknown', verdict: 'unrecognised', confidence: 0.9, direction: undefined, render: 'none' },
  ];

  for (const row of cases) {
    const result = scoreCandidate(candidate(), [], [], DEFAULT_THRESHOLDS, {
      candidateId: 'cand_001',
      fixVerdict: row.verdict,
      fixConfidence: row.confidence,
      fixDirection: row.direction,
      fixReason: 'The traced input reaches the existing validation branch.',
    });
    assert.equal(result.fix.render, row.render, row.label);
  }
});

test('a verified verdict with no suggested fix still renders nothing', () => {
  const result = scoreCandidate(candidate({ suggestedFix: null }), [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    fixVerdict: 'verified',
    fixConfidence: 0.95,
  });
  assert.equal(result.fix.render, 'none');
});

test('a fix verdict cannot change the defect score or its eligibility', () => {
  const input = candidate();
  const verified = scoreCandidate(input, [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    technicalConfidence: 0.91,
    fixVerdict: 'verified',
    fixConfidence: 0.91,
    fixReason: 'The traced input reaches the existing validation branch.',
  });
  const refuted = scoreCandidate(input, [precedent()], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    technicalConfidence: 0.91,
    fixVerdict: 'refuted',
    fixConfidence: 0.91,
    fixReason: 'The traced input bypasses a path the current code serves.',
  });

  assert.equal(verified.eligible, true);
  assert.equal(verified.eligible, refuted.eligible);
  assert.equal(verified.technicalConfidence, refuted.technicalConfidence);
  assert.equal(verified.finalScore, refuted.finalScore);
  assert.equal(verified.rejectedBecause, refuted.rejectedBecause);
  assert.deepEqual(verified.severity, refuted.severity);
  assert.equal(verified.fix.render, 'fix');
  assert.equal(refuted.fix.render, 'none');
});

test('a direction renders only as one short sentence without code, for a suggested fix', () => {
  const partial = (direction, over = {}) =>
    scoreCandidate(candidate(over), [], [], DEFAULT_THRESHOLDS, {
      candidateId: 'cand_001',
      fixVerdict: 'partial',
      fixConfidence: 0.7,
      fixDirection: direction,
    }).fix.render;

  assert.equal(partial('Handle the admin path before comparing ids.'), 'direction');
  assert.equal(partial('Replace the check with `allowAll()`.'), 'none', 'code in a direction is a specific repair');
  assert.equal(partial('Guard the admin path. Then compare the ids.'), 'none', 'two sentences');
  assert.equal(partial(`Handle ${'the admin path '.repeat(10)}first.`), 'none', 'over the length limit');
  assert.equal(partial('Handle the admin path.\nThen compare.'), 'none', 'a line break');
  assert.equal(partial('Handle the admin path first.', { suggestedFix: null }), 'none', 'no repair was suggested');
});

test('the editor is handed only the repair text it may state', () => {
  const base = { suggested: 'Move the write after validation.', analystConfidence: 0.9, verdict: null, confidence: null, direction: 'Validate first.', reason: 'r' };
  assert.deepEqual(editorFix({ ...base, render: 'fix' }), { render: 'fix', text: 'Move the write after validation.' });
  assert.deepEqual(editorFix({ ...base, render: 'direction' }), { render: 'direction', text: 'Validate first.' });
  assert.deepEqual(editorFix({ ...base, render: 'none' }), { render: 'none', text: null });
});

test('the analyst fix confidence is kept in the breakdown for audit only', () => {
  const low = scoreCandidate(candidate({ fixConfidence: 0.2 }), [], [], DEFAULT_THRESHOLDS, {
    candidateId: 'cand_001',
    fixVerdict: 'verified',
    fixConfidence: 0.9,
  });
  assert.equal(low.fix.analystConfidence, 0.2);
  assert.equal(low.fix.render, 'fix');
});

// Candidate shape

test('optional fix fields are retained for audit and malformed values are refused', () => {
  const parsed = normaliseCandidate(RAW, 0);
  assert.equal(parsed.suggestedFix, RAW.suggested_fix);
  assert.equal(parsed.fixConfidence, RAW.fix_confidence);

  assert.throws(() => normaliseCandidate({ ...RAW, suggested_fix: 12 }, 0), /suggested_fix must be a string/);
  for (const fix_confidence of [-0.01, 1.01, Number.NaN]) {
    assert.throws(
      () => normaliseCandidate({ ...RAW, fix_confidence }, 0),
      /fix_confidence must be a finite number from 0 to 1/,
    );
  }
});

test('check-candidates accepts optional fix fields and refuses malformed values', () => {
  withDir('rv-fix-candidate-', (dir) => {
    const valid = runWithInput(['check-candidates'], CANDIDATE_WITH_FIX, dir);
    assert.equal(valid.code, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).candidates, 1);

    for (const [field, value] of [
      ['suggested_fix', 12],
      ['fix_confidence', -0.01],
      ['fix_confidence', 1.01],
    ]) {
      const malformed = { candidates: [{ ...RAW, [field]: value }] };
      const result = runWithInput(['check-candidates'], JSON.stringify(malformed), dir);
      assert.equal(result.code, 2, `${field}=${value} should be refused`);
      assert.match(result.stderr, new RegExp(field));
    }
  });
});

// The score command

test('score without fix fields renders no fix and keeps the defect result', () => {
  withDir('rv-fix-absent-', (dir) => {
    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify({ results: [{ candidate_id: 'cand_004', technical_confidence: 0.9 }] }));
    const noFix = JSON.stringify({ candidates: [{ ...RAW, suggested_fix: undefined, fix_confidence: undefined }] });
    const { code, stdout, stderr } = runWithInput(['score', '--verification', file], noFix, dir);
    assert.equal(code, 0, stderr);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.scores[0].verifiedConfidence, 0.9);
    assert.deepEqual(parsed.scores[0].fix, {
      suggested: null,
      analystConfidence: null,
      verdict: null,
      confidence: null,
      direction: null,
      render: 'none',
      reason: 'no fix was proposed',
    });
  });
});

test('score reads verifier fix fields in either casing and withholds unknown verdicts', () => {
  withDir('rv-fix-verification-', (dir) => {
    const cases = [
      { name: 'snake', fields: { fix_verdict: 'verified', fix_confidence: 0.86, fix_reason: 'Traced.' } },
      { name: 'camel', fields: { fixVerdict: 'verified', fixConfidence: 0.86, fixReason: 'Traced.' } },
    ];

    for (const { name, fields } of cases) {
      const file = join(dir, `${name}.json`);
      writeFileSync(file, JSON.stringify({ results: [{ candidate_id: 'cand_004', technical_confidence: 0.9, ...fields }] }));
      const { code, stdout, stderr } = runWithInput(['score', '--verification', file], CANDIDATE_WITH_FIX, dir);
      assert.equal(code, 0, stderr);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.scores[0].fix.render, 'fix', name);
      assert.equal(parsed.scores[0].fix.confidence, 0.86, name);
      assert.equal(parsed.eligible[0].fix.render, 'fix', name);
      assert.equal(parsed.eligible[0].fix.text, RAW.suggested_fix, name);
    }

    const unknown = join(dir, 'unknown.json');
    writeFileSync(
      unknown,
      JSON.stringify({
        results: [{ candidate_id: 'cand_004', technical_confidence: 0.9, fix_verdict: 'unrecognised', fix_confidence: 1 }],
      }),
    );
    const result = runWithInput(['score', '--verification', unknown], CANDIDATE_WITH_FIX, dir);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scores[0].fix.verdict, null);
    assert.equal(parsed.scores[0].fix.render, 'none');
  });
});

test('a verification file carrying the documented fix fields renders a direction', () => {
  withDir('rv-fix-seam-', (dir) => {
    const file = join(dir, 'verification.json');
    writeFileSync(
      file,
      JSON.stringify({
        results: [
          {
            candidate_id: 'cand_004',
            evidence_quality: 'high',
            technical_confidence: 0.88,
            fix_verdict: 'partial',
            fix_confidence: 0.7,
            fix_reason: 'The traced input still needs the existing validation branch.',
            fix_direction: 'Preserve the existing validation branch.',
          },
        ],
      }),
    );
    const { code, stdout, stderr } = runWithInput(['score', '--verification', file], CANDIDATE_WITH_FIX, dir);
    assert.equal(code, 0, stderr);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.scores[0].confidenceSource, 'verifier');
    assert.equal(parsed.scores[0].fix.render, 'direction');
    assert.equal(parsed.scores[0].fix.direction, 'Preserve the existing validation branch.');
  });
});

test('eligible entries carry what the editor writes from, and no withheld repair', () => {
  withDir('rv-fix-eligible-', (dir) => {
    const file = join(dir, 'verification.json');
    writeFileSync(
      file,
      JSON.stringify({
        results: [{ candidate_id: 'cand_004', technical_confidence: 0.9, fix_verdict: 'refuted', fix_confidence: 0.9, fix_reason: 'Breaks a served path.' }],
      }),
    );
    const { code, stdout, stderr } = runWithInput(['score', '--verification', file], CANDIDATE_WITH_FIX, dir);
    assert.equal(code, 0, stderr);
    const parsed = JSON.parse(stdout);
    const entry = parsed.eligible[0];
    assert.equal(entry.claim, RAW.claim);
    assert.equal(entry.failureMode, RAW.failure_mode);
    assert.deepEqual(entry.evidence, RAW.evidence);
    assert.deepEqual(entry.fix, { render: 'none', text: null });
    assert.doesNotMatch(JSON.stringify(entry), /Move the write after validation/);
    // The audit record still has the whole decision.
    assert.equal(parsed.scores[0].fix.suggested, RAW.suggested_fix);
    assert.equal(parsed.scores[0].fix.verdict, 'refuted');
  });
});

test('two candidates sharing an id are refused before anything is joined by id', () => {
  withDir('rv-fix-duplicate-', (dir) => {
    const twice = JSON.stringify({ candidates: [RAW, { ...RAW, line: 20, suggested_fix: 'Something else.' }] });
    for (const command of [['check-candidates'], ['score']]) {
      const result = runWithInput(command, twice, dir);
      assert.equal(result.code, 2, `${command[0]} should refuse a repeated id`);
      assert.match(result.stderr, /cand_004: appears more than once/);
    }
  });
});

// Explain

test('explain reports stored fix decisions and leaves older score records unchanged', () => {
  const output = '[minor] `src/a.ts:12` - A write runs before validation. Invalid input reaches storage.';
  withDir('rv-fix-explain-', (dir) => {
    const scores = join(dir, 'scores.json');
    writeFileSync(
      scores,
      JSON.stringify({
        scores: [
          {
            path: 'src/a.ts',
            line: 12,
            technicalConfidence: 0.9,
            finalScore: 0.9,
            fix: {
              suggested: 'Move the write after validation.',
              verdict: 'refuted',
              confidence: 0.7,
              direction: null,
              render: 'none',
              reason: 'The traced path skips validation.',
            },
          },
        ],
      }),
    );
    assert.equal(runWithInput(['record', '--scores', scores], output, dir).code, 0);
    const explained = runWithInput(['explain'], '', dir);
    assert.equal(explained.code, 0, explained.stderr);
    assert.match(explained.stdout, /fix  withheld \(refuted\): The traced path skips validation\./);
  });

  withDir('rv-fix-explain-old-', (dir) => {
    const scores = join(dir, 'scores.json');
    writeFileSync(scores, JSON.stringify({ scores: [{ path: 'src/a.ts', line: 12, technicalConfidence: 0.9, finalScore: 0.9 }] }));
    assert.equal(runWithInput(['record', '--scores', scores], output, dir).code, 0);
    const explained = runWithInput(['explain'], '', dir);
    assert.equal(explained.code, 0, explained.stderr);
    assert.doesNotMatch(explained.stdout, /fix  (?:verified|direction|withheld|none proposed)/);
  });
});

// The output contract

test('validate-output accepts a finding without a fix sentence', () => {
  const stdout = execFileSync(process.execPath, [bundle, 'validate-output', '--json'], {
    input: '[minor] `src/a.ts:12` - A write runs before validation. Invalid input reaches storage.',
    encoding: 'utf8',
  });
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true, JSON.stringify(result.violations));
  assert.equal(result.findingCount, 1);
});

// Seams: prompts and the CLI agree on the fix fields

test('the verifier prompt documents every fix field score reads', () => {
  const documented = [...VERIFIER.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  for (const field of ['fix_verdict', 'fix_confidence', 'fix_reason', 'fix_direction']) {
    assert.ok(documented.includes(field), `score reads ${field} and the verifier prompt never mentions it`);
  }
  assert.match(VERIFIER, /does not feed `verified` or `technical_confidence`/);
});

test('the analyst prompt names the optional fix fields and keeps suggestion refused', () => {
  for (const field of ['suggested_fix', 'fix_confidence']) {
    assert.ok(ANALYST.includes(field), `the analyst prompt never names ${field}`);
  }
  assert.match(ANALYST, /`suggestion` is not `suggested_fix`/);
});

test('the editor names every fix render state and never writes a correction itself', () => {
  for (const render of ['fix', 'direction', 'none']) {
    assert.ok(EDITOR.includes(`\`${render}\``), `the editor never names fix.render ${render}`);
  }
  assert.match(EDITOR, /fix\.render/);
  assert.doesNotMatch(EDITOR, /smallest practical correction/i);
});

test('the review command hands the editor each fix inline', () => {
  const step = REVIEW.slice(REVIEW.indexOf('## Step 5'), REVIEW.indexOf('## Step 6'));
  assert.match(step, /`render` is `fix` or `direction`/);
  assert.match(step, /`claim`, `failureMode`, `evidence`/);
  assert.match(step, /a withheld repair never reaches it/);
});
