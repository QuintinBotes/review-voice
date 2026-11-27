/** The composite action (docs/adr/0031): safe defaults and pinned dependencies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const action = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const steps = action.runs.steps;

test('declares the inputs with their defaults', () => {
  const { inputs } = action;
  for (const name of ['mode', 'post', 'anthropic-api-key', 'github-token', 'claude-code-version', 'config', 'fail-open']) {
    assert.ok(inputs[name], name);
  }
  assert.equal(inputs.mode.default, 'auto');
  assert.equal(String(inputs.post.default), 'false');
  assert.equal(String(inputs['fail-open'].default), 'false', 'a review that could not run fails the job unless the workflow opts in');
  assert.equal(inputs.config.default, '.review-voice/config.yaml');
  assert.match(inputs['claude-code-version'].default, /^\d+\.\d+\.\d+$/);
});

// The GitHub Marketplace lists an action by its name, description and branding.
test('carries the metadata the GitHub Marketplace lists', () => {
  assert.equal(action.name, 'Review Voice');
  assert.ok(action.description.length > 0 && action.description.length <= 125, 'the Marketplace shows up to 125 characters');
  assert.match(action.branding.icon, /^[a-z-]+$/);
  assert.ok(['white', 'black', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'].includes(action.branding.color));
});

test('every third-party action is pinned by a 40-hex SHA', () => {
  const uses = steps.map((s) => s.uses).filter(Boolean);
  assert.ok(uses.length > 0);
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, ref);
});

test('no event payload string is interpolated into a script', () => {
  for (const step of steps) {
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*github\.event\./);
  }
});

test('the pull_request_target guard runs first', () => {
  assert.match(steps[0].run, /pull_request_target/);
  assert.match(steps[0].run, /exit 1/);
});

test('secrets reach the review step only through env', () => {
  const review = steps.find((s) => s.id === 'review');
  assert.match(review.run, /\$GITHUB_ACTION_PATH\/plugins\/review-voice\/dist\/review-voice\.mjs/);
  assert.doesNotMatch(review.run, /\$\{\{/);
  assert.ok(review.env.ANTHROPIC_API_KEY && review.env.GITHUB_TOKEN);
});

// Two pull requests reviewed at once must not restore, then overwrite, each
// other's store (#509). `pr1-` must not prefix-match `pr12-`, so the number is
// followed by a dash.
test('#509: the store cache is keyed per pull request, with the repository as the fallback for a first run', () => {
  const cache = steps.find((s) => String(s.uses ?? '').startsWith('actions/cache@'));
  const pr = '${{ steps.gate.outputs.pr }}';
  assert.equal(cache.with.key, `review-voice-\${{ github.repository }}-pr${pr}-\${{ github.run_id }}-\${{ github.run_attempt }}`);
  assert.deepEqual(cache.with['restore-keys'].trim().split('\n'), [
    `review-voice-\${{ github.repository }}-pr${pr}-`,
    'review-voice-${{ github.repository }}-',
  ]);
});

// A rerun keeps the run id. Without the attempt in the key it restores the first
// attempt's store by exact key, and actions/cache never saves over a hit, so the
// rerun's records were lost: on review-voice-e2e#2 attempt 3 approved over a
// finding attempt 2 had posted (#541).
test('#541: every attempt of a run saves its own store, and the next restores the newest', () => {
  const cache = steps.find((s) => String(s.uses ?? '').startsWith('actions/cache@'));
  const key = cache.with.key;
  const restore = cache.with['restore-keys'].trim().split('\n');
  const attempt = (n) => key.replace('${{ github.run_id }}', '46070541377').replace('${{ github.run_attempt }}', String(n));
  assert.notEqual(attempt(1), attempt(2), 'a rerun has a key of its own, so it is a miss and is saved');
  const prefix = restore[0].replace('${{ github.run_id }}', '46070541377');
  assert.ok(attempt(1).startsWith(prefix) && attempt(2).startsWith(prefix), 'both attempts stay under the pull request prefix the next run restores from');
});

// The review's own job is a check run on the head and is still running when the
// verdict reads CI (#508); the review step passes its id so CI can leave it out.
test('#508: the review step passes its own check run id', () => {
  const review = steps.find((s) => s.id === 'review');
  assert.equal(review.env.REVIEW_VOICE_OWN_CHECK_RUN, '${{ job.check_run_id }}');
});
