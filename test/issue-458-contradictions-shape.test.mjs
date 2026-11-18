/**
 * #458: a {wrong, right} object in contradictions was accepted.
 *
 * contradictions entries are plain strings; a correction-shaped object
 * belongs in corrections. check-verification refuses anything else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const good = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.9 };

function check(payload) {
  const data = mkdtempSync(join(tmpdir(), 'rv-issue-458-'));
  try {
    const r = spawnSync(process.execPath, [bundle, 'check-verification'], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      cwd: data,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

test('#458: a {wrong, right} object in contradictions is refused and pointed at corrections', () => {
  const r = check([{ ...good, contradictions: [{ wrong: 'a', right: 'b' }] }]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /corrections/);
});

test('#458: a non-string contradictions entry is refused', () => {
  assert.equal(check([{ ...good, contradictions: [5] }]).code, 2);
  assert.equal(check([{ ...good, contradictions: 'not a list' }]).code, 2);
});

test('#458: string contradictions pass', () => {
  const r = check([{ ...good, contradictions: ['loadUser has nine call sites, not eleven'] }]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { valid: true, verifications: 1 });
});

test('#458: the schema types contradictions items as strings', () => {
  const schema = JSON.parse(readFileSync(join(root, 'plugins/review-voice/schemas/verification.schema.json'), 'utf8'));
  assert.equal(schema.properties.contradictions.items.type, 'string');
});
