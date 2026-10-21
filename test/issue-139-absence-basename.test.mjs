/**
 * #139: a file a claim said was missing was searched for by content, so a doc
 * citing it, or a same-name file elsewhere, "refuted" the claim, and the
 * verified finding it dropped was listed nowhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAbsenceClaim } from '../plugins/review-voice/src/scoring/existence.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const none = () => [];

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-139-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A repository with a root README and a doc that cites `ci/README.md`, which is not there. */
function withDocsRepo(fn) {
  return withDir((dir) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'README.md'), 'Project readme.\n');
    writeFileSync(join(dir, 'docs/skill.md'), 'See ci/README.md for the pipeline.\n');
    for (const args of [['init', '--quiet'], ['add', '.']]) {
      assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
    }
    return fn(dir);
  });
}

test('a doc citing a missing path does not refute the claim that it is missing', () =>
  withDocsRepo((dir) => {
    const result = checkAbsenceClaim('`ci/README.md` is missing.', dir, null, undefined, null, none);
    assert.deepEqual(result.found, []);
    assert.deepEqual(result.checked, ['ci/README.md']);
    assert.equal(result.inconclusive, false);
  }));

test('a same-name file in another directory does not refute a missing path', () =>
  withDocsRepo((dir) => {
    const result = checkAbsenceClaim('`docs/README.md` does not exist.', dir, null, undefined, null, none);
    assert.deepEqual(result.found, []);
  }));

test('a path that is tracked still refutes the claim', () =>
  withDocsRepo((dir) => {
    const result = checkAbsenceClaim('`docs/skill.md` does not exist.', dir, null, undefined, null, none);
    assert.deepEqual(result.found, ['docs/skill.md']);
  }));

test('a bare file name the claim states still refutes it beside a missing path', () =>
  withDocsRepo((dir) => {
    const result = checkAbsenceClaim('`README.md` and `ci/README.md` are missing.', dir, null, undefined, null, none);
    assert.deepEqual(result.found, ['README.md']);
    assert.deepEqual(result.checked.sort(), ['README.md', 'ci/README.md']);
  }));

test('a verified finding the absence check contradicts is listed in absenceContradicted', () =>
  withDir((dir) => {
    writeFileSync(join(dir, 'guard.ts'), 'export function SharedPipelineGuard() { return true; }\n');
    for (const args of [['init', '--quiet'], ['add', '.']]) {
      assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
    }
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify([{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 }]));
    const candidate = {
      candidate_id: 'cand_001',
      path: 'guard.ts',
      line: 1,
      category: 'correctness',
      severity: 'minor',
      claim: 'The `SharedPipelineGuard` helper does not exist.',
      failure_mode: 'Callers fail to import it.',
      evidence: ['guard.ts:1'],
      technical_confidence: 0.9,
    };
    const result = spawnSync(process.execPath, [bundle, 'score', '--verification', verification, '--min-score', '0'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.eligible.length, 0);
    assert.equal(out.absenceContradicted.length, 1);
    assert.equal(out.absenceContradicted[0].candidateId, 'cand_001');
    assert.deepEqual(out.absenceContradicted[0].found, ['SharedPipelineGuard']);
    assert.match(out.absenceContradicted[0].rejectedBecause, /claims something is absent, but the repository contains SharedPipelineGuard/);
  }));
