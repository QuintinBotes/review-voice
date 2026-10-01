/**
 * A disabled second-pass verifier says how to turn it on.
 *
 * With another reviewer unavailable, a different-model check is the stand-in,
 * and `enabled: false` alone left four findings held on one day with nobody
 * knowing the pass existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFindings } from '../plugins/review-voice/src/verify/external.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const finding = { path: 'src/a.ts', line: 1, severity: 'minor', claim: 'A claim.', failureMode: 'A failure.', evidence: ['line 1'] };

test('an unconfigured verifier names how to enable it', () => {
  for (const config of [{ enabled: false, command: '' }, { enabled: true, command: '  ' }]) {
    const report = verifyFindings([finding], config, { cwd: process.cwd() });
    assert.equal(report.enabled, false);
    assert.match(report.howToEnable, /`verification:` block/);
    assert.match(report.howToEnable, /`enabled: true`/);
    assert.match(report.howToEnable, /`command`/);
  }
});

test('an enabled verifier with nothing to check carries no hint', () => {
  const report = verifyFindings([], { enabled: true, command: 'cat' }, { cwd: process.cwd() });
  assert.equal(report.howToEnable, undefined);
});

test('the review command relays the hint once', () => {
  const review = readFileSync(join(root, 'plugins/review-voice/commands/review.md'), 'utf8');
  const step = review.slice(review.indexOf('## Step 3b'), review.indexOf('## Step 4'));
  assert.match(step, /`howToEnable`, print it once after the findings/);
});
