/**
 * #424: a slash-command review posted without re-reading the thread, so a
 * point another reviewer made while the review ran was posted again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('draft-review always posts with --recheck-thread, as review --post does', () => {
  const command = readFileSync(new URL('../plugins/review-voice/commands/draft-review.md', import.meta.url), 'utf8');
  const posts = command.split('\n').filter((line) => line.startsWith('RV post '));
  assert.ok(posts.length > 0);
  for (const line of posts) assert.match(line, /--recheck-thread/, line);
});
