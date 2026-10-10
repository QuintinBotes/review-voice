/**
 * Severity is escalated only on evidence.
 *
 * `deriveSeverity` is a pure table over category and reach, and reach measures
 * how widely a touched file's symbols are referenced, not whether the defect
 * propagates. Left alone it raised analyst-minor findings to important on
 * popularity, and let a claim ending "Is that intended?" block. The bound under
 * test is a separate scoring stage; the table itself is pinned elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseCandidate, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const RAW = {
  candidate_id: 'c1',
  path: 'src/a.ts',
  line: 10,
  category: 'correctness',
  severity: 'minor',
  claim: 'The default drops the retry budget.',
  failure_mode: 'Callers that rely on the budget never retry.',
  evidence: 'src/a.ts:10 sets the budget to zero.',
  technical_confidence: 0.9,
};

const REPOSITORY_REACH = {
  reach: 'repository',
  symbolSource: 'hunks',
  moduleFallback: false,
  symbols: ['retry'],
  ignoredSymbols: [],
  paths: [],
  countedPaths: [],
  directoryCount: 6,
  outsideDirectoryCount: 5,
  inconclusive: false,
  searchedRef: 'HEAD',
};

function tier(overrides, verification) {
  const candidate = normaliseCandidate({ ...RAW, ...overrides }, 0);
  const v = verification === undefined ? undefined : { candidateId: 'c1', ...verification };
  return scoreCandidate(candidate, [], [], undefined, v).severity;
}

function validate(output) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, 'validate-output', '--json'], {
      input: output,
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(error.stdout || '{}');
  }
}

test('api_contract requested minor with no reach stays minor', () => {
  const severity = tier({ category: 'api_contract' }, { technicalConfidence: 0.9 });
  assert.equal(severity.severity, 'minor');
  assert.match(severity.reason, /held at minor because escalation needs the verifier to trace impact/);

  // Security and authorization boundaries keep their tier whatever was requested.
  for (const category of ['security', 'authorization', 'authentication']) {
    const kept = tier({ category }, { technicalConfidence: 0.9 });
    assert.notEqual(kept.severity, 'minor', category);
  }
  assert.equal(tier({ category: 'trust_boundary' }, { technicalConfidence: 0.9 }).severity, 'minor');
  assert.equal(tier({ category: 'security' }, { technicalConfidence: 0.9 }).severity, 'blocking');
});

test('repository reach escalates only with traced impact and confidence of 0.85', () => {
  const reach = REPOSITORY_REACH;
  assert.equal(tier({}, { technicalConfidence: 0.9, reach }).severity, 'minor');
  assert.equal(tier({}, { technicalConfidence: 0.9, reach, impactTraced: true }).severity, 'important');
  assert.equal(tier({}, { technicalConfidence: 0.84, reach, impactTraced: true }).severity, 'minor');
  assert.equal(tier({}, { technicalConfidence: 0.85, reach, impactTraced: true }).severity, 'important');
});

test('an interrogative claim is capped at minor, unless it was asked as a question', () => {
  const claim = 'Is the default intended?';
  const capped = tier(
    { claim, severity: 'important', category: 'api_contract' },
    { technicalConfidence: 0.9 },
  );
  assert.equal(capped.severity, 'minor');
  assert.match(capped.reason, /capped at minor because the claim is framed as a question/);
  assert.equal(tier({ claim, severity: 'question' }, { technicalConfidence: 0.9 }).severity, 'question');
  const embedded = 'The default changed. Should callers pass a budget?';
  assert.equal(
    tier({ claim: embedded, severity: 'important', category: 'api_contract' }, { technicalConfidence: 0.9 })
      .severity,
    'minor',
  );
});

test('a confident traced assertion keeps its escalation, an untraced one does not', () => {
  const asserted = {
    severity: 'important',
    category: 'api_contract',
    claim: 'The default drops the retry budget.',
  };
  assert.equal(tier(asserted, { technicalConfidence: 0.9, impactTraced: true }).severity, 'important');
  assert.equal(tier(asserted, { technicalConfidence: 0.9 }).severity, 'important');
  assert.equal(tier({ ...asserted, severity: 'minor' }, { technicalConfidence: 0.9 }).severity, 'minor');
});

test('validate-output rejects a question rendered as important or blocking', () => {
  const text = (tag) => `[${tag}] \`a.ts:1\` - Is this intended? It changes the default.`;
  for (const tag of ['important', 'blocking']) {
    const result = validate(text(tag));
    assert.ok(
      result.violations.some((v) => v.code === 'question_as_blocking'),
      tag,
    );
  }
  const minor = validate(text('minor'));
  assert.ok(!minor.violations.some((v) => v.code === 'question_as_blocking'));
  const statement = validate('[important] `a.ts:1` - The default changed. Is that intended?');
  assert.ok(!statement.violations.some((v) => v.code === 'question_as_blocking'));
});
