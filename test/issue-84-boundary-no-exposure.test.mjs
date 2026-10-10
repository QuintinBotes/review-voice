/**
 * A boundary category is held at the requested tier only when the verifier
 * says nothing is exposed.
 *
 * A front-end route that skipped a role check the server still enforces was
 * reported as blocking: the tier tables give authorization `blocking` at every
 * reach, and the verifier's "minor, the backend returns 403" had no way in.
 * `impact_class: "no-exposure"` is that way in. Without it the boundary tier
 * stands exactly as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseCandidate, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const RAW = {
  candidate_id: 'c1',
  path: 'src/routes/admin.tsx',
  line: 12,
  category: 'authorization',
  severity: 'minor',
  claim: 'The admin route renders without the role check its menu entry applies.',
  failure_mode: 'A user without the role opens a page whose every request fails with 403.',
  evidence: 'src/routes/admin.tsx:12 mounts the page with no role guard.',
  technical_confidence: 0.82,
};

const REPOSITORY_REACH = {
  reach: 'repository',
  symbolSource: 'hunks',
  moduleFallback: false,
  symbols: ['AdminPage'],
  ignoredSymbols: [],
  paths: [],
  countedPaths: [],
  directoryCount: 6,
  outsideDirectoryCount: 5,
  inconclusive: false,
  searchedRef: 'HEAD',
};

function tier(overrides, verification) {
  const candidate = normaliseCandidate({ ...RAW, ...overrides }, 0);
  const v = { candidateId: 'c1', technicalConfidence: 0.82, impactTraced: false, reach: REPOSITORY_REACH, ...verification };
  return scoreCandidate(candidate, [], [], undefined, v).severity;
}

test('authorization requested minor with no-exposure at repository reach is held at minor', () => {
  const severity = tier({}, { impactClass: 'no-exposure' });
  assert.equal(severity.severity, 'minor');
  assert.match(severity.reason, /held at minor because the verifier found no exposure/);
});

test('authorization without impact_class, or with an exposure, keeps blocking', () => {
  assert.equal(tier({}, {}).severity, 'blocking');
  assert.equal(tier({}, { impactClass: 'data-exposure' }).severity, 'blocking');
  assert.equal(tier({}, { impactClass: 'privilege-escalation' }).severity, 'blocking');
});

test('no-exposure does not lower a tier that was not requested below it', () => {
  const severity = tier({ category: 'security', severity: 'blocking' }, { impactClass: 'no-exposure' });
  assert.equal(severity.severity, 'blocking');
  assert.doesNotMatch(severity.reason, /no exposure/);
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-84-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function score(dir, verification) {
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verification));
  return spawnSync(process.execPath, [bundle, 'score', '--verification', join(dir, 'v.json'), '--min-score', '0'], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ candidates: [RAW] }),
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
}

test('score refuses an impact_class outside the three it knows', () =>
  withDir((dir) => {
    const r = score(dir, [{ candidate_id: 'c1', verified: true, technical_confidence: 0.82, impact_class: 'bogus' }]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /entry 0 \(c1\): impact_class must be one of no-exposure, data-exposure, privilege-escalation/);
  }));

test('score reads impact_class and impactClass from the verification file', () =>
  withDir((dir) => {
    const without = score(dir, [{ candidate_id: 'c1', verified: true, technical_confidence: 0.82 }]);
    assert.equal(without.status, 0, without.stderr);
    assert.equal(JSON.parse(without.stdout).scores[0].severity.severity, 'blocking');
    for (const key of ['impact_class', 'impactClass']) {
      const r = score(dir, [{ candidate_id: 'c1', verified: true, technical_confidence: 0.82, [key]: 'no-exposure' }]);
      assert.equal(r.status, 0, r.stderr);
      const entry = JSON.parse(r.stdout).scores.find((s) => s.candidate_id === 'c1');
      assert.equal(entry.severity.severity, 'minor', key);
    }
  }));

test('check-verification accepts no-exposure and refuses anything else', () => {
  const ok = spawnSync(process.execPath, [bundle, 'check-verification'], {
    encoding: 'utf8',
    input: JSON.stringify([{ candidate_id: 'c1', impact_class: 'no-exposure' }]),
  });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [bundle, 'check-verification'], {
    encoding: 'utf8',
    input: JSON.stringify([{ candidate_id: 'c1', impact_class: 'none' }]),
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /impact_class/);
});
