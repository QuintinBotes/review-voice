/** The composite action (docs/adr/0031): safe defaults and pinned dependencies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const action = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const steps = action.runs.steps;

test('declares the inputs with their defaults', () => {
  const { inputs } = action;
  for (const name of ['mode', 'post', 'anthropic-api-key', 'github-token', 'claude-code-version', 'config']) {
    assert.ok(inputs[name], name);
  }
  assert.equal(inputs.mode.default, 'auto');
  assert.equal(String(inputs.post.default), 'false');
  assert.equal(inputs.config.default, '.review-voice/config.yaml');
  assert.match(inputs['claude-code-version'].default, /^\d+\.\d+\.\d+$/);
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
