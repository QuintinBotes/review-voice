/**
 * #475: step 6 said to pass the verdicts "if verification ran", which is every
 * review, so the evidence-verifier's output went to `record --verdicts` and was
 * refused. `--verdicts` takes only the step 3b second-pass report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const review = readFileSync(new URL('../plugins/review-voice/commands/review.md', import.meta.url), 'utf8');

test('#475: step 6 passes --verdicts only for a step 3b second pass', () => {
  assert.doesNotMatch(review, /if verification ran/);
  assert.match(review, /if step 3b ran a\s+second pass, its report with `--verdicts <tmpdir>\/second-pass\.json`/);
});
