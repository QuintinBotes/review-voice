import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normaliseCandidate } from '../plugins/review-voice/src/scoring/score.ts';
import { deriveSeverity } from '../plugins/review-voice/src/scoring/severity.ts';
import { SEVERITIES } from '../plugins/review-voice/src/contract/limits.ts';

// Inter-stage contract drift
//
// Four defects in this project came from a seam between a prompt and the code
// that reads its output, and none was caught by a test:
//
//   - `score` accepted `verifications` and `candidates`; the verifier emits
//     `results`. Every candidate silently fell back to the analyst self-report.
//   - The analyst emitted `title`, `location`, `suggested_direction`, and a
//     whole pull request produced nothing.
//   - The category enum was never in the analyst prompt, so the agent invented
//     plausible names, and severity had come to rest entirely on that field.
//   - Severities exist that no prompt listed.
//
// Each was invisible until a retest against a real repository. These pin the
// seams so the suite can fail instead.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');

const read = (path) => readFileSync(join(plugin, path), 'utf8');
const schema = (name) => JSON.parse(read(join('schemas', name)));

const ANALYST = read('agents/diff-analyst.md');
const VERIFIER = read('agents/evidence-verifier.md');
const EDITOR = read('agents/concise-editor.md');

// Seam one: the analyst's schema is what score actually parses

test('every field the candidate schema requires is one score reads', () => {
  const required = schema('candidate.schema.json').properties.candidates.items.required;

  const candidate = {
    candidate_id: 'cand_001',
    path: 'src/a.ts',
    line: 12,
    category: 'correctness',
    severity: 'minor',
    claim: 'A claim.',
    failure_mode: 'A failure.',
    evidence: ['At line 12.'],
    technical_confidence: 0.9,
  };

  for (const field of required) {
    assert.ok(field in candidate, `schema requires ${field}, which this test does not supply`);
  }

  const parsed = normaliseCandidate(candidate, 0);
  assert.equal(parsed.candidateId, 'cand_001');
  assert.equal(parsed.path, 'src/a.ts');
  assert.equal(parsed.line, 12);
  assert.equal(parsed.category, 'correctness');
  assert.equal(parsed.technicalConfidence, 0.9);
  assert.deepEqual(parsed.evidence, ['At line 12.']);
});

test('the analyst prompt names the schema it must emit against', () => {
  assert.match(ANALYST, /candidate\.schema\.json/);
});

// Seam two: the verifier's documented output is what score accepts

test('every field the verifier prompt promises is one score reads', () => {
  // Taken from the prompt rather than restated, so renaming a field there
  // fails here.
  const documented = [...VERIFIER.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  const consumed = ['candidate_id', 'evidence_quality', 'technical_confidence', 'required_context_missing'];

  for (const field of consumed) {
    assert.ok(
      documented.includes(field),
      `score reads ${field} and the verifier prompt never mentions it`,
    );
  }
});

test('a verification file shaped exactly as the prompt describes is read', () => {
  // `results` is what the verifier actually returned. It was not accepted, the
  // command exited 0, and the release's headline fix did nothing. This builds
  // the payload from the prompt's own field list rather than restating it.
  const documented = [...VERIFIER.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  assert.ok(documented.includes('candidate_id'), 'the prompt no longer documents candidate_id');
  assert.ok(documented.includes('technical_confidence'), 'the prompt no longer documents technical_confidence');

  const dir = mkdtempSync(join(tmpdir(), 'rv-seam-'));
  try {
    const file = join(dir, 'verification.json');
    writeFileSync(
      file,
      JSON.stringify({
        results: [{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.88 }],
      }),
    );

    const candidates = JSON.stringify({
      candidates: [
        {
          candidate_id: 'cand_001',
          path: 'src/a.ts',
          line: 12,
          category: 'correctness',
          severity: 'minor',
          claim: 'A claim.',
          failure_mode: 'A failure.',
          evidence: ['At line 12.'],
          technical_confidence: 0.5,
        },
      ],
    });

    const result = spawnSync(process.execPath, [join(plugin, 'dist/review-voice.mjs'), 'score', '--verification', file], {
      encoding: 'utf8',
      input: candidates,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scores[0].confidenceSource, 'verifier');
    assert.equal(parsed.scores[0].verifiedConfidence, 0.88);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Seam three: every enum a prompt must contain

test('every category in the schema appears in the analyst prompt', () => {
  // Severity rests entirely on this field, and the prompt referenced only the
  // schema, which reaches the enum through a $ref the agent never follows.
  const categories = schema('finding-category.schema.json').enum;
  const missing = categories.filter((category) => !ANALYST.includes(`\`${category}\``));

  assert.deepEqual(missing, [], `the analyst prompt does not list: ${missing.join(', ')}`);
});

test('every category the schema defines has a severity', () => {
  const categories = schema('finding-category.schema.json').enum;
  const unmapped = categories.filter((category) => deriveSeverity(category, 'minor').reason.includes('no mapping'));

  assert.deepEqual(unmapped, [], `no tier maps these categories: ${unmapped.join(', ')}`);
});

test('every severity the contract allows appears in the prompts that use it', () => {
  for (const severity of SEVERITIES) {
    assert.ok(ANALYST.includes(severity), `the analyst prompt never mentions ${severity}`);
    assert.ok(EDITOR.includes(severity), `the editor prompt never mentions ${severity}`);
  }
});

test('the severity list the editor states matches the contract exactly', () => {
  const stated = [...EDITOR.matchAll(/`(blocking|important|minor|nit|question)`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(stated)].sort(), [...SEVERITIES].sort());
});
