import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EVIDENCE_QUALITIES } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const schema = JSON.parse(readFileSync(join(root, 'plugins/review-voice/schemas/verification.schema.json'), 'utf8'));

const candidate = (id, line) => ({
  candidate_id: id, path: 'src/auth.ts', line, category: 'correctness', severity: 'important',
  claim: 'The retry mints duplicate tokens before the transaction commits.',
  failure_mode: 'A client retry creates two tokens for one login.',
  evidence: ['src/auth.ts:12 mints the token before commit'],
  technical_confidence: 0.9,
});

function score(entries) {
  const data = mkdtempSync(join(tmpdir(), 'rv-vschema-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'rv-vschema-dir-'));
  try {
    writeFileSync(join(dir, 'v.json'), JSON.stringify(entries));
    return spawnSync(process.execPath, [bundle, 'score', '--verification', join(dir, 'v.json')], {
      cwd: dir, encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate('c1', 12), candidate('c2', 30)] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const good = { candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.9 };

test('the schema file lists the same evidence tiers as the code', () => {
  assert.deepEqual(schema.properties.evidence_quality.enum, [...EVIDENCE_QUALITIES]);
  assert.deepEqual(schema.required, ['candidate_id']);
});

for (const [name, entry, field] of [
  ['an unknown evidence tier', { ...good, evidence_quality: 'certain' }, 'evidence_quality'],
  ['a string confidence', { ...good, technical_confidence: '0.9' }, 'technical_confidence'],
  ['a confidence above 1', { ...good, technical_confidence: 7 }, 'technical_confidence'],
  ['context that is not an array of strings', { ...good, required_context_missing: [1] }, 'required_context_missing'],
  ['a missing candidate id', { evidence_quality: 'high' }, 'candidate_id'],
]) {
  test(`score refuses ${name} and names the entry and field`, () => {
    const result = score([good, entry]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /entry 1/);
    assert.ok(result.stderr.includes(field), result.stderr);
  });
}

test('score accepts camelCase aliases and warns about unknown and unverified ids', () => {
  const result = score([{ candidateId: 'c1', evidenceQuality: 'high', technicalConfidence: 0.9 }, { candidate_id: 'ghost' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /unknown candidate id.*ghost/);
  assert.match(result.stderr, /no verification for c2/);
});
