/**
 * #551 and #543: a maintainer asks for a review with workflow_dispatch and a
 * `pr` input. GitHub lets only people with write access dispatch a workflow.
 * The gate takes the number from the inputs and refuses anything that is not
 * one. The review step's handling of a fork is in action-review-step.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const steps = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8')).runs.steps;
const gate = steps.find((step) => step.id === 'gate').run;

function runGate(t, eventName, payload, apiKey = 'set') {
  const dir = mkdtempSync(join(tmpdir(), 'rv-551-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_EVENT_PATH: join(dir, 'event.json') };
  for (const path of Object.values(files)) writeFileSync(path, '');
  writeFileSync(files.GITHUB_EVENT_PATH, JSON.stringify(payload));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', gate], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...files, EVENT_NAME: eventName, API_KEY: apiKey },
  });
  return { status: result.status, stdout: result.stdout, output: readFileSync(files.GITHUB_OUTPUT, 'utf8') };
}

// The payload GitHub sends for workflow_dispatch: the inputs, the ref, no pull request.
const dispatch = (inputs) => ({ inputs, ref: 'refs/heads/main', repository: { full_name: 'QuintinBotes/review-voice-e2e' } });

test('#551: a dispatch with a pr input runs a review of that pull request', (t) => {
  const result = runGate(t, 'workflow_dispatch', dispatch({ pr: '4' }));
  assert.equal(result.status, 0);
  assert.match(result.output, /^skip=false$/m);
  assert.match(result.output, /^pr=4$/m);
});

test('#551: a dispatch whose pr input is not a pull request number stops with an error', (t) => {
  for (const pr of [undefined, '', '0', '4; rm -rf /', '$(id)', '04', '12345678901']) {
    const result = runGate(t, 'workflow_dispatch', dispatch(pr === undefined ? {} : { pr }));
    assert.equal(result.status, 2, `pr ${JSON.stringify(pr)}`);
    assert.match(result.stdout, /^::error::Review Voice: a workflow_dispatch review needs a pr input/m);
    assert.doesNotMatch(result.output, /^pr=/m);
  }
});

test('#551: a dispatch with no key skips, like a pull request event', (t) => {
  const result = runGate(t, 'workflow_dispatch', dispatch({ pr: '4' }), '');
  assert.equal(result.status, 0);
  assert.match(result.output, /^skip=true$/m);
});

test('#551: any other event is still skipped', (t) => {
  const result = runGate(t, 'push', { ref: 'refs/heads/main' });
  assert.match(result.output, /^skip=true$/m);
  assert.match(result.stdout, /not a pull request event/);
});
