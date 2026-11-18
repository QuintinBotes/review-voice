/**
 * #457: check-verification accepted a correction score would reject.
 *
 * A correction whose `wrong` paraphrased the candidate passed
 * check-verification, then score held the whole confirmed finding because
 * the text was not in the claim, failure mode or evidence. With
 * --candidates, check-verification runs the same verbatim check while the
 * verifier can still be re-asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const candidate = {
  candidate_id: 'cand_001',
  path: 'src/a.ts',
  line: 3,
  category: 'correctness',
  severity: 'minor',
  claim: 'The rename misses eleven call sites of loadUser.',
  failure_mode: 'The eleven call sites can also break the build.',
  evidence: ['eleven call sites still call loadUser'],
  technical_confidence: 0.9,
};
const verified = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.93 };

function check(payload, candidates) {
  const data = mkdtempSync(join(tmpdir(), 'rv-issue-457-'));
  try {
    const args = [bundle, 'check-verification'];
    if (candidates !== undefined) {
      const file = join(data, 'checked.json');
      writeFileSync(file, JSON.stringify(candidates));
      args.push('--candidates', file);
    }
    const r = spawnSync(process.execPath, args, {
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

const checked = { valid: true, kept: [candidate], droppedAsRepeat: [] };

test('#457: a correction whose wrong text is not in the candidate fails check-verification --candidates', () => {
  const r = check([{ ...verified, corrections: [{ wrong: 'the eleven call sites can break', right: 'the nine call sites can break' }] }], checked);
  assert.equal(r.code, 2, r.stdout);
  assert.ok(r.stderr.includes('cand_001'), r.stderr);
  assert.ok(r.stderr.includes('the eleven call sites can break'), r.stderr);
  assert.match(r.stderr, /verbatim/);
});

test('#457: a verbatim wrong in the claim, failure mode or evidence passes', () => {
  for (const wrong of ['eleven call sites of loadUser', 'can also break the build', 'still call loadUser']) {
    const r = check([{ ...verified, corrections: [{ wrong, right: 'nine call sites' }] }], checked);
    assert.equal(r.code, 0, `${wrong}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { valid: true, verifications: 1 });
  }
});

test('#457: matching is exact, so a case-only difference fails', () => {
  const r = check([{ ...verified, corrections: [{ wrong: 'Eleven call sites of loadUser', right: 'nine call sites' }] }], checked);
  assert.equal(r.code, 2, r.stdout);
  assert.ok(r.stderr.includes('cand_001'), r.stderr);
});

test('#457: matching is exact, so a whitespace-only difference fails', () => {
  const r = check([{ ...verified, corrections: [{ wrong: 'eleven  call sites of loadUser', right: 'nine call sites' }] }], checked);
  assert.equal(r.code, 2, r.stdout);
  assert.ok(r.stderr.includes('cand_001'), r.stderr);
});

test('#457: corrections apply in order, as score renders them, so a second may target what the first wrote', () => {
  const chained = [{ wrong: 'eleven call sites', right: 'nine call sites' }, { wrong: 'nine call sites of loadUser', right: 'nine call sites of loadUserById' }];
  assert.equal(check([{ ...verified, corrections: chained }], checked).code, 0);
  // The reverse order targets text that does not exist yet, which score would hold too.
  assert.equal(check([{ ...verified, corrections: [...chained].reverse() }], checked).code, 2);
});

test('#457: camelCase candidate and verification ids are checked like snake_case ones', () => {
  const { candidate_id: _id, ...rest } = candidate;
  const camelChecked = { valid: true, kept: [{ ...rest, candidateId: 'cand_001' }], droppedAsRepeat: [] };
  const { candidate_id: _vid, ...verifiedRest } = verified;
  const camelVerified = { ...verifiedRest, candidateId: 'cand_001' };
  const ok = check([{ ...camelVerified, corrections: [{ wrong: 'eleven call sites of loadUser', right: 'nine call sites' }] }], camelChecked);
  assert.equal(ok.code, 0, ok.stderr);
  const miss = check([{ ...camelVerified, corrections: [{ wrong: 'Eleven call sites', right: 'nine call sites' }] }], camelChecked);
  assert.equal(miss.code, 2, miss.stdout);
  assert.ok(miss.stderr.includes('cand_001'), miss.stderr);
});

test('#457: without --candidates the correction cannot be checked and output is unchanged', () => {
  const r = check([{ ...verified, corrections: [{ wrong: 'the eleven call sites can break', right: 'the nine call sites can break' }] }]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { valid: true, verifications: 1 });
});
