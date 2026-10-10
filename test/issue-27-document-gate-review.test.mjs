/**
 * The untraced-document exception is narrow. It needs the verifier's own
 * confirmation - with no verification entry the analyst's opinion of its own
 * finding would be the whole case - and it applies only to files no build
 * reads: `CMakeLists.txt`, `requirements.txt` and `.mdx` keep the strict rule.
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

const stale = (path) => ({
  candidate_id: 'cand_001',
  path,
  line: 4,
  category: 'maintainability',
  severity: 'nit',
  claim: 'The build notes still name the `legacy_target` that the change removed.',
  failure_mode: 'Anyone following the notes builds a target that no longer exists.',
  evidence: [`${path}:4 names legacy_target.`, 'src/build/targets.ts:2 removes it.'],
  technical_confidence: 0.9,
  anchor: 'stale-consumer',
  caused_by: { path: 'src/build/targets.ts', line: 2 },
});

function score(candidate, verification) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-doc-gate-'));
  try {
    const patch = join(dir, 'diff.patch');
    writeFileSync(
      patch,
      ['diff --git a/src/build/targets.ts b/src/build/targets.ts', '--- a/src/build/targets.ts', '+++ b/src/build/targets.ts', '@@ -0,0 +1,3 @@', '+a', '+b', '+c'].join('\n'),
    );
    const args = ['score', '--diff-file', patch, '--min-score', '0.3'];
    if (verification !== undefined) {
      writeFileSync(join(dir, 'v.json'), JSON.stringify([verification]));
      args.push('--verification', join(dir, 'v.json'));
    }
    const r = spawnSync(process.execPath, [bundle, ...args], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).scores[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const confirmed = { candidate_id: 'cand_001', technical_confidence: 0.9, impact_traced: false };

test('a documentation nit with no verification entry is not eligible untraced', () => {
  const row = score(stale('docs/build.md'));
  assert.equal(row.confidenceSource, 'analyst');
  assert.equal(row.eligible, false);
  assert.match(row.rejectedBecause, /needs the verifier to trace the impact/);
  assert.match(row.rejectedBecause, /on the analyst's confidence alone/);
});

test('the same nit is eligible once the verifier confirms it', () => {
  const row = score(stale('docs/build.md'), confirmed);
  assert.equal(row.eligible, true, row.rejectedBecause);
});

for (const path of ['CMakeLists.txt', 'requirements.txt', 'docs/page.mdx']) {
  test(`${path} keeps the strict rule`, () => {
    const row = score(stale(path), confirmed);
    assert.equal(row.eligible, false);
    assert.match(row.rejectedBecause, /needs the verifier to trace the impact/);
    assert.doesNotMatch(row.rejectedBecause, /documentation consumer/);
  });
}
