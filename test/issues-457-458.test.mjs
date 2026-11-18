/**
 * #457: check-verification accepted a correction score then refused, so a
 * confirmed finding was dropped after the verifier had finished.
 * #458: a {wrong, right} filed under contradictions was accepted and read by
 * nothing, so the refuted text stayed in the finding.
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

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-457-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir, args, input = '') =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } });

const candidate = {
  candidate_id: 'cand_001',
  path: 'src/a.ts',
  line: 3,
  category: 'correctness',
  severity: 'minor',
  claim: 'The rename misses eleven call sites of loadUser.',
  failure_mode: 'Callers in the job runner can also break at build time.',
  evidence: ['eleven call sites still call loadUser'],
  technical_confidence: 0.9,
};
const verified = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.9 };

function checkVerification(dir, verification) {
  const candidates = join(dir, 'checked.json');
  writeFileSync(candidates, JSON.stringify({ valid: true, kept: [candidate] }));
  return run(dir, ['check-verification', '--candidates', candidates], JSON.stringify([verification]));
}

test('#457: a paraphrased correction fails check-verification --candidates, naming the candidate and the nearest sentence', () =>
  withDir((dir) => {
    const result = checkVerification(dir, { ...verified, corrections: [{ wrong: 'callers in the job runner can break', right: 'x' }] });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cand_001: the correction's wrong "callers in the job runner can break" is not in the candidate/);
    assert.match(result.stderr, /nearest sentence is "Callers in the job runner can also break at build time\."/);
    assert.match(result.stderr, /copied verbatim/);
  }));

test('#457: a verbatim correction, or one differing only in case and line breaks, passes and is applied by score', () =>
  withDir((dir) => {
    const correction = { wrong: 'callers in the job runner\ncan also break', right: 'the job runner can break' };
    const checked = checkVerification(dir, { ...verified, corrections: [correction] });
    assert.equal(checked.status, 0, checked.stderr);
    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify([{ ...verified, corrections: [correction] }]));
    const scored = run(dir, ['score', '--verification', file, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
    assert.equal(scored.status, 0, scored.stderr);
    assert.equal(JSON.parse(scored.stdout).eligible[0].failureMode, 'the job runner can break at build time.');
  }));

test('#458: a {wrong, right} under contradictions fails check-verification and points to corrections', () =>
  withDir((dir) => {
    const result = run(dir, ['check-verification'], JSON.stringify([{ ...verified, contradictions: [{ wrong: 'a', right: 'b' }] }]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /contradictions must be a list of strings\. A \{"wrong", "right"\} object is a correction: put it in corrections/);
  }));

test('#458: string contradictions still pass', () =>
  withDir((dir) => {
    const result = run(dir, ['check-verification'], JSON.stringify([{ ...verified, contradictions: ['loadUser is also called from sync.ts.'] }]));
    assert.equal(result.status, 0, result.stderr);
  }));

// #461: a correction may target what an earlier one wrote; both commands apply them in order.
const chained = [
  { wrong: 'eleven call sites', right: 'nine call sites' },
  { wrong: 'nine call sites of loadUser', right: 'nine call sites of loadUserById' },
];

test('#461: chained corrections pass check-verification and score applies them in order', () =>
  withDir((dir) => {
    const checked = checkVerification(dir, { ...verified, corrections: chained });
    assert.equal(checked.status, 0, checked.stderr);
    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify([{ ...verified, corrections: chained }]));
    const scored = run(dir, ['score', '--verification', file, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
    assert.equal(scored.status, 0, scored.stderr);
    assert.equal(JSON.parse(scored.stdout).eligible[0].claim, 'The rename misses nine call sites of loadUserById.');
  }));

test('#461: the reverse order fails check-verification, as score would hold it', () =>
  withDir((dir) => {
    const reversed = [...chained].reverse();
    const checked = checkVerification(dir, { ...verified, corrections: reversed });
    assert.equal(checked.status, 2);
    assert.match(checked.stderr, /cand_001: the correction's wrong "nine call sites of loadUser" is not in the candidate/);
    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify([{ ...verified, corrections: reversed }]));
    const scored = run(dir, ['score', '--verification', file, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
    assert.deepEqual(JSON.parse(scored.stdout).eligible, []);
  }));
