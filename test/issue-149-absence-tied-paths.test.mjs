/**
 * #149: every path a claim named was checked as if the claim said it was
 * missing, so a tracked file the claim only mentioned refuted a true finding.
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
const repro = '`docs/guide.md` cites `ci/README.md`, which does not exist.';

/** A repository with `docs/guide.md` and `src/b.ts` tracked, and `ci/README.md` not. */
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-149-'));
  try {
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'docs/guide.md'), 'See ci/README.md for the pipeline.\n');
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
    for (const args of [['init', '--quiet'], ['add', '.']]) {
      assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a path the claim only mentions does not refute the absence of another', () =>
  withRepo((dir) => {
    const result = checkAbsenceClaim(repro, dir, null, undefined, null, none);
    assert.deepEqual(result.checked, ['ci/README.md']);
    assert.deepEqual(result.found, []);
    assert.equal(result.inconclusive, false);
  }));

test('of two paths in one claim, only the one said to be missing is checked', () =>
  withRepo((dir) => {
    const result = checkAbsenceClaim(
      'The link in `docs/guide.md` points at `ci/README.md`; `ci/README.md` is missing.',
      dir,
      null,
      undefined,
      null,
      none,
    );
    assert.deepEqual(result.checked, ['ci/README.md']);
    assert.deepEqual(result.found, []);
  }));

test('a tracked path the claim does say is missing still refutes it', () =>
  withRepo((dir) => {
    const result = checkAbsenceClaim(
      '`ci/README.md` cites `docs/guide.md`, which does not exist.',
      dir,
      null,
      undefined,
      null,
      none,
    );
    assert.deepEqual(result.checked, ['docs/guide.md']);
    assert.deepEqual(result.found, ['docs/guide.md']);
  }));

test('a gate phrase tie outranks a path the change removed', () =>
  withRepo((dir) => {
    const result = checkAbsenceClaim(
      '`src/b.ts` is not defined; it replaces `src/legacy.ts`, which was removed.',
      dir,
      null,
      undefined,
      null,
      none,
    );
    assert.deepEqual(result.checked, ['src/b.ts']);
    assert.deepEqual(result.found, ['src/b.ts']);
  }));

test('a claim whose grammar ties no name still checks every path', () =>
  withRepo((dir) => {
    const result = checkAbsenceClaim('`docs/guide.md` and `ci/README.md`. Both do not exist.', dir, null, undefined, null, none);
    assert.deepEqual(result.checked.sort(), ['ci/README.md', 'docs/guide.md']);
    assert.deepEqual(result.found, ['docs/guide.md']);
  }));

test('a symbol said to be missing keeps a path it is only mentioned beside from refuting it', () =>
  withRepo((dir) => {
    const result = checkAbsenceClaim(
      '`docs/guide.md` imports `SharedPipelineGuard`, which does not exist.',
      dir,
      null,
      () => false,
      null,
      none,
    );
    assert.deepEqual(result.checked, ['SharedPipelineGuard']);
    assert.deepEqual(result.found, []);
  }));

test('the repro finding stays eligible instead of absence-contradicted', () =>
  withRepo((dir) => {
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify([{ candidate_id: 'cand_001', verified: true, technical_confidence: 0.9 }]));
    const candidate = {
      candidate_id: 'cand_001',
      path: 'docs/guide.md',
      line: 1,
      category: 'correctness',
      severity: 'minor',
      claim: repro,
      failure_mode: 'Readers follow a dead link.',
      evidence: ['docs/guide.md:1'],
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
    assert.equal(out.absenceContradicted.length, 0);
    assert.equal(out.eligible.length, 1);
  }));
