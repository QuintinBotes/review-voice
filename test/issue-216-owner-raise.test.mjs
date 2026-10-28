/**
 * #216: the legacy-tier hint (#179) names `--severity <id>=<tier>` to raise a
 * verified finding with unknown reach, but the override only lowered. Running
 * the command the hint prints now raises the tier, up to the requested one.
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
  path: '.github/workflows/build.yml',
  line: 12,
  category: 'ci',
  severity: 'important',
  claim: 'The build job now installs from a lockfile that is not committed.',
  failure_mode: 'Every later pull request fails the build job at install.',
  evidence: ['.github/workflows/build.yml:12 points the install step at the missing lockfile.'],
  technical_confidence: 0.9,
};

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-216-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function score(dir, verified, extra = []) {
  const verification = join(dir, 'verification.json');
  writeFileSync(verification, JSON.stringify([{ candidate_id: 'cand_001', verified, technical_confidence: 0.9 }]));
  return spawnSync(process.execPath, [bundle, 'score', '--verification', verification, '--min-score', '0', ...extra], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify({ candidates: [candidate] }),
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
  });
}

test('#216: the command the legacy-tier hint prints raises the tier to the requested one', () =>
  withDir((dir) => {
    const first = score(dir, true);
    assert.equal(first.status, 0, first.stderr);
    const [held] = JSON.parse(first.stdout).scores;
    assert.equal(held.severity.severity, 'minor');
    const hinted = held.severity.reason.match(/`--severity (\S+)`/);
    assert.ok(hinted, held.severity.reason);

    const raised = score(dir, true, ['--severity', hinted[1]]);
    assert.equal(raised.status, 0, raised.stderr);
    const [breakdown] = JSON.parse(raised.stdout).scores;
    assert.equal(breakdown.severity.severity, 'important');
    assert.match(breakdown.severity.reason, /raised at important by an explicit owner override/);
  }));

test('#216: a raise past the requested tier, or on an unverified finding, is refused', () =>
  withDir((dir) => {
    const past = score(dir, true, ['--severity', 'cand_001=blocking']);
    assert.equal(past.status, 2);
    assert.match(past.stderr, /up to the tier the analyst requested \(important\)/);

    const unverified = score(dir, false, ['--severity', 'cand_001=important']);
    assert.equal(unverified.status, 2);
    assert.match(unverified.stderr, /must lower the scored minor tier/);
  }));
