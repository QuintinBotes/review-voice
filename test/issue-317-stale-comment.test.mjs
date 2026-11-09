/**
 * #317. A verified nit about a stale doc comment in a source file was rejected
 * as an untraced stale consumer with no way forward, and `--severity <id>=nit`
 * is refused when the tier is already nit. A source comment keeps the trace
 * rule (docs/adr/0015), so the rejection now names the route that posts it.
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
  const dir = mkdtempSync(join(tmpdir(), 'rv-stale-comment-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `src/pipeline/base.ts` gains lines 1-6. */
const PATCH = [
  'diff --git a/src/pipeline/base.ts b/src/pipeline/base.ts',
  '--- a/src/pipeline/base.ts',
  '+++ b/src/pipeline/base.ts',
  '@@ -0,0 +1,6 @@',
  ...Array.from({ length: 6 }, (_, i) => `+line ${i + 1}`),
].join('\n');

const staleComment = (over = {}) => ({
  candidate_id: 'cand_001',
  path: 'src/pipeline/runner.ts',
  line: 4,
  category: 'maintainability',
  severity: 'nit',
  claim: 'The doc comment on runPipeline still tells callers to run the setup steps that BasePipeline now runs itself.',
  failure_mode: 'A reader following the comment duplicates steps the base class already runs.',
  evidence: ['src/pipeline/runner.ts:4 tells callers to run the setup steps.', 'src/pipeline/base.ts:3 runs them.'],
  technical_confidence: 0.85,
  anchor: 'stale-consumer',
  caused_by: { path: 'src/pipeline/base.ts', line: 3 },
  ...over,
});

function score(dir, candidate, extra = []) {
  const patch = join(dir, 'diff.patch');
  const verification = join(dir, 'verification.json');
  writeFileSync(patch, PATCH);
  writeFileSync(
    verification,
    JSON.stringify([{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.85, impact_traced: false }]),
  );
  return spawnSync(
    process.execPath,
    [bundle, 'score', '--verification', verification, '--diff-file', patch, '--min-score', '0.3', ...extra],
    { encoding: 'utf8', input: JSON.stringify({ candidates: [candidate] }), cwd: dir, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
  );
}

test('#317: an untraced stale comment in a source file says how to post it', () =>
  withDir((dir) => {
    const r = score(dir, staleComment());
    assert.equal(r.status, 0, r.stderr);
    const [row] = JSON.parse(r.stdout).scores;
    assert.equal(row.severity.severity, 'nit');
    assert.equal(row.eligible, false);
    assert.match(row.rejectedBecause, /needs the verifier to trace the impact/);
    assert.match(row.rejectedBecause, /a comment in a source file included/);
    assert.match(
      row.rejectedBecause,
      /have the analyst refile it as an ordinary finding on the changed line its `caused_by` names, with the consumer and its path in the claim and evidence$/,
    );
    // The route it names must not be the one `score` refuses at this tier.
    assert.doesNotMatch(row.rejectedBecause, /--severity/);
  }));

test('#317: owner overrides still cannot restate the nit tier', () =>
  withDir((dir) => {
    const r = score(dir, staleComment(), ['--severity', 'cand_001=nit']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must lower the scored nit tier/);
  }));

test('#317: the same finding refiled on its cause is eligible untraced at nit', () =>
  withDir((dir) => {
    const refiled = staleComment({
      path: 'src/pipeline/base.ts',
      line: 3,
      claim: 'BasePipeline now runs the setup steps, but the doc comment at src/pipeline/runner.ts:4 still tells callers to run them.',
      anchor: undefined,
      caused_by: undefined,
    });
    const r = score(dir, refiled);
    assert.equal(r.status, 0, r.stderr);
    const [row] = JSON.parse(r.stdout).scores;
    assert.equal(row.eligible, true, row.rejectedBecause);
    assert.equal(row.severity.severity, 'nit');
  }));
