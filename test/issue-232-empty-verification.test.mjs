/**
 * #232: with no candidates an empty verification file is the honest answer,
 * so a clean review runs score, validate-output and record like any other.
 * With candidates it is still refused.
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
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-232-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (dir, args, input) =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } });

test('#232: no candidates and an empty verification file score, validate and record cleanly', () =>
  withDir((dir) => {
    writeFileSync(join(dir, 'verification.json'), '[]');
    const scored = run(dir, ['score', '--verification', join(dir, 'verification.json')], JSON.stringify({ candidates: [] }));
    assert.equal(scored.status, 0, scored.stderr);
    assert.deepEqual(JSON.parse(scored.stdout).eligible, []);

    writeFileSync(join(dir, 'scores.json'), scored.stdout);
    const review = 'No actionable findings.\n';
    const validated = run(dir, ['validate-output', '--scores', join(dir, 'scores.json')], review);
    assert.equal(validated.status, 0, validated.stderr);
    const recorded = run(dir, ['record', '--repository', 'acme/web', '--head', 'abc', '--scores', join(dir, 'scores.json')], review);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(recorded.stdout).findings, []);
  }));

test('#232: an empty verification file is still refused when there are candidates', () =>
  withDir((dir) => {
    writeFileSync(join(dir, 'verification.json'), '[]');
    const candidate = {
      candidate_id: 'cand_001',
      path: 'src/a.ts',
      line: 1,
      category: 'correctness',
      severity: 'minor',
      claim: 'The guard is inverted.',
      failure_mode: 'Valid input is rejected.',
      evidence: ['src/a.ts:1 negates the check.'],
      technical_confidence: 0.9,
    };
    const scored = run(dir, ['score', '--verification', join(dir, 'verification.json')], JSON.stringify({ candidates: [candidate] }));
    assert.equal(scored.status, 2);
    assert.match(scored.stderr, /contained no verifications/);
  }));
