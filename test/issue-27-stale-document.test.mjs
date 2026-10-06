/**
 * A stale consumer that is a document. A guide that still tells authors to do
 * what the change replaced is wrong without any runtime break, so the verifier
 * rightly leaves `impact_traced` false - and the finding was then rejected
 * every time. A documentation consumer may now be reported untraced at nit;
 * anything above nit, and any code consumer, still needs the trace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDocumentationPath } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-stale-doc-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** `src/pipeline/base.ts` gains lines 1-6. */
function writePatch(dir) {
  const patch = join(dir, 'diff.patch');
  writeFileSync(
    patch,
    [
      'diff --git a/src/pipeline/base.ts b/src/pipeline/base.ts',
      '--- a/src/pipeline/base.ts',
      '+++ b/src/pipeline/base.ts',
      '@@ -0,0 +1,6 @@',
      ...Array.from({ length: 6 }, (_, i) => `+line ${i + 1}`),
    ].join('\n'),
  );
  return patch;
}

const stale = (over = {}) => ({
  candidate_id: 'cand_001',
  path: 'docs/guides/new-pipeline.md',
  line: 12,
  category: 'maintainability',
  severity: 'nit',
  claim: 'The guide still tells authors to copy the pipeline steps that `BasePipeline` now runs itself.',
  failure_mode: 'Authors following the guide duplicate steps the base class already runs.',
  evidence: ['docs/guides/new-pipeline.md:12 lists the steps to copy.', 'src/pipeline/base.ts:3 runs them.'],
  technical_confidence: 0.85,
  anchor: 'stale-consumer',
  caused_by: { path: 'src/pipeline/base.ts', line: 3 },
  ...over,
});

function score(dir, candidate, impactTraced = false) {
  const file = join(dir, 'verification.json');
  writeFileSync(
    file,
    JSON.stringify([{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.85, impact_traced: impactTraced }]),
  );
  const r = spawnSync(
    process.execPath,
    [bundle, 'score', '--verification', file, '--diff-file', writePatch(dir), '--min-score', '0.3'],
    { encoding: 'utf8', input: JSON.stringify({ candidates: [candidate] }), cwd: dir, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('an untraced stale consumer on documentation is eligible at nit', () =>
  withDir((dir) => {
    const out = score(dir, stale());
    const [row] = out.scores;
    assert.equal(row.severity.severity, 'nit');
    assert.equal(row.eligible, true, row.rejectedBecause);
    assert.equal(out.eligible[0].anchor, 'stale-consumer');
  }));

test('an untraced documentation consumer above nit is still rejected, and says why', () =>
  withDir((dir) => {
    const [row] = score(dir, stale({ category: 'correctness', severity: 'minor' })).scores;
    assert.equal(row.severity.severity, 'minor');
    assert.equal(row.eligible, false);
    assert.match(row.rejectedBecause, /needs the verifier to trace the impact/);
    assert.match(row.rejectedBecause, /documentation consumer may go untraced only at nit and on the verifier's confidence, and this one is minor/);
  }));

test('an untraced code consumer at nit is still rejected', () =>
  withDir((dir) => {
    const [row] = score(dir, stale({ path: 'src/report.ts' })).scores;
    assert.equal(row.eligible, false);
    assert.match(row.rejectedBecause, /needs the verifier to trace the impact/);
    assert.doesNotMatch(row.rejectedBecause, /documentation consumer/);
  }));

test('documentation is told apart from code by extension', () => {
  for (const path of ['README.md', 'skills/x/SKILL.md', 'notes.rst', 'manual.adoc']) {
    assert.equal(isDocumentationPath(path), true, path);
  }
  for (const path of ['src/report.ts', 'config.yaml', 'docs/build.py', 'md', 'CMakeLists.txt', 'requirements.txt', 'docs/page.mdx']) {
    assert.equal(isDocumentationPath(path), false, path);
  }
});

test('the verifier, analyst and review command state the documentation exception', () => {
  const read = (path) => readFileSync(join(plugin, path), 'utf8');
  assert.match(read('agents/evidence-verifier.md'), /reported at `nit`, and only at `nit`/);
  assert.match(read('agents/diff-analyst.md'), /`maintainability` at `nit`/);
  assert.match(read('commands/review.md'), /documentation consumer[\s\S]{0,80}eligible untraced when it is reported at `nit`/);
});
