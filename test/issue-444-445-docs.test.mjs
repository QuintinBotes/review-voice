/**
 * #444: the head-moved procedure left room to finish the run on the interdiff,
 * which refuses every carried candidate. #445: the editor stated a conditional
 * or an example as a general fact. Both are instructions, pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../plugins/review-voice/${path}`, import.meta.url), 'utf8');

test('#444: a carried run finishes on the full diff, without check-candidates on the merged set', () => {
  const review = read('commands/review.md');
  const section = review.slice(review.indexOf('## When the head moves before posting'));
  assert.match(section, /its diff is the full one from point\s+1, never the interdiff/);
  assert.match(section, /Do not run `check-candidates` on the\s+merged set/);
});

test('#445: the editor keeps conditionals conditional and examples as examples', () => {
  const editor = read('agents/concise-editor.md');
  assert.match(editor, /Keep the finding's modality and scope/);
  assert.match(editor, /never as a fixed number/);
});
