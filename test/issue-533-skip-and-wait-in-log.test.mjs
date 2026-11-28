/**
 * #533: a skipped review, and one held for CI, say so in the job log as well
 * as the summary. Live shapes from review-voice-scratch#1: a green 5 s job
 * whose log said nothing, and a held review whose only log line read
 * "verdict APPROVE ... review posted false".
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

function runGate(t, env) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_EVENT_PATH: join(dir, 'event.json') };
  for (const path of Object.values(files)) writeFileSync(path, '');
  writeFileSync(files.GITHUB_EVENT_PATH, JSON.stringify({ repository: { full_name: 'acme/web' }, pull_request: { number: 1, head: { repo: { full_name: 'acme/web' } } } }));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', gate], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...files, ...env },
  });
  return { status: result.status, stdout: result.stdout, summary: readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8'), output: readFileSync(files.GITHUB_OUTPUT, 'utf8') };
}

test('#533: an empty key, as a fork pull request sees it, is a skip the log names', (t) => {
  const result = runGate(t, { EVENT_NAME: 'pull_request', API_KEY: '' });
  assert.equal(result.status, 0);
  assert.match(result.output, /^skip=true$/m);
  const line = 'Review Voice skipped: no Anthropic API key is available (fork pull requests receive no secrets).';
  assert.equal(result.stdout.trim(), line);
  assert.equal(result.summary.trim(), line);
});

test('#533: a run that is not skipped prints nothing from the gate', (t) => {
  const result = runGate(t, { EVENT_NAME: 'pull_request', API_KEY: 'set' });
  assert.equal(result.status, 0);
  assert.match(result.output, /^skip=false$/m);
  assert.equal(result.stdout, '');
});
