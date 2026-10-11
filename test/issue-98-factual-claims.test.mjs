/**
 * Issues #98, #101 and #102 share one factual-claim check. The deterministic
 * harness cannot decide natural-language truth, so these tests pin the analyst
 * and verifier instructions and the synthetic examples they must handle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('the analyst and verifier check and consolidate factual claims at the final head', () => {
  const analyst = read('plugins/review-voice/agents/diff-analyst.md');
  const verifier = read('plugins/review-voice/agents/evidence-verifier.md');

  assert.match(analyst, /description and in comments or\s+documentation the diff changes/);
  assert.match(analyst, /final head, the diff, configuration\s+and CI/);
  assert.match(analyst, /only this unmerged change introduces it, it\s+requires a flag, or it varies by environment/);
  assert.match(analyst, /all changed and\s+sibling files and the entry-point file/);
  assert.match(analyst, /one candidate: enumerate every remaining mismatch as `path:line` evidence/);
  assert.match(analyst, /do not re-raise a mismatch the\s+final head has corrected/);

  assert.match(verifier, /check every stated factual claim against the final head, diff,\s+configuration and CI/);
  assert.match(verifier, /Compare base and head/);
  assert.match(verifier, /flag-gated behaviour is conditional/);
  assert.match(verifier, /verify every listed\s+mismatch and that the final head has not corrected it/);
  assert.match(verifier, /one consolidated\s+candidate only when its evidence gives every remaining mismatch as `path:line`/);
});

test('the review flow gives the verifier the description it must check', () => {
  const review = read('plugins/review-voice/commands/review.md');
  assert.match(review, /On a `--pr` run, give it the same `thread\.json` too\./);
  assert.match(review, /factual claims in the description against the final head/);
});

test('claim fixtures cover a conditional mismatch and a corrected restraint case', () => {
  const positive = 'fixtures/positive/factual-claim-consistency';
  const negative = 'fixtures/negative/factual-claim-stated-conditionally';
  assert.match(read(`${positive}/case.yaml`), /consolidated factual-claim finding/);
  assert.match(read(`${positive}/diff.patch`), /rejectDuplicates/);
  assert.match(read(`${positive}/pr-body.md`), /refused at registration/);
  assert.match(read(`${negative}/case.yaml`), /No actionable findings\./);
  assert.match(read(`${negative}/pr-body.md`), /pending and requires/);
});
