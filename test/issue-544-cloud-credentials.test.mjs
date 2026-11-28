/**
 * #544: the Action runs a review with an Anthropic API key, a Claude Code
 * OAuth token, or a cloud provider's credentials that an earlier step (its
 * OIDC login action) exported, and skips with a reason only when the chosen
 * provider has none. The gate and review steps run as the runner runs them;
 * the review's bundle is a stub that records the credential variables it got.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const action = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const steps = action.runs.steps;
const gate = steps.find((step) => step.id === 'gate');
const review = steps.find((step) => step.id === 'review');

const WATCHED = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK',
  'AWS_ACCESS_KEY_ID',
  'AWS_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_RESOURCE',
];
const STUB = `import { writeFileSync } from 'node:fs';
const seen = {};
for (const key of ${JSON.stringify(WATCHED)}) if (key in process.env) seen[key] = process.env[key];
writeFileSync(process.env.FAKE_ENV, JSON.stringify(seen));
process.stdout.write('{}');
`;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-544-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'action/plugins/review-voice/dist'), { recursive: true });
  writeFileSync(join(dir, 'action/plugins/review-voice/dist/review-voice.mjs'), STUB);
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 7 } }));
  return dir;
}

function bash(dir, script, env) {
  const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  for (const path of Object.values(files)) writeFileSync(path, '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_EVENT_PATH: join(dir, 'event.json'), ...files, ...env },
  });
  return { status: result.status, stdout: result.stdout, output: readFileSync(files.GITHUB_OUTPUT, 'utf8') };
}

/** The gate with the inputs at their defaults, unless named, plus what the job's env holds. */
function runGate(t, { inputs = {}, jobEnv = {} } = {}) {
  const env = { EVENT_NAME: 'pull_request', API_KEY: '', OAUTH_TOKEN: '', PROVIDER: 'anthropic', ...inputs, ...jobEnv };
  return bash(scratch(t), gate.run, env);
}

/** The review step, returning the credential variables its bundle was started with. */
function runReview(t, { inputs = {}, jobEnv = {} } = {}) {
  const dir = scratch(t);
  const env = {
    ...jobEnv,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    PROVIDER: 'anthropic',
    ...inputs,
    GITHUB_TOKEN: 'unused',
    GITHUB_ACTION_PATH: join(dir, 'action'),
    GITHUB_REPOSITORY: 'acme/api',
    RUNNER_TEMP: dir,
    REVIEW_VOICE_DATA_DIR: join(dir, 'data'),
    PR: '7',
    MODE: 'auto',
    POST: 'false',
    CONFIG: '.review-voice/config.yaml',
    FAIL_OPEN: 'false',
    FAKE_ENV: join(dir, 'env.json'),
  };
  const result = bash(dir, review.run, env);
  assert.equal(result.status, 0, result.stdout);
  return JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
}

// What each documented login step leaves in the job's env.
const AWS = { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_REGION: 'us-west-2' };
const GCP = { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gha-creds.json', ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: 'us-east5' };
const AZURE = { AZURE_CLIENT_ID: 'c', ANTHROPIC_FOUNDRY_RESOURCE: 'r' };

test('#544: the new inputs default to today\'s behaviour', () => {
  assert.equal(action.inputs.provider.default, 'anthropic');
  assert.equal(action.inputs['claude-code-oauth-token'].default, '');
  assert.equal(action.inputs['anthropic-api-key'].default, '');
  assert.equal(gate.env.OAUTH_TOKEN, '${{ inputs.claude-code-oauth-token }}');
  assert.equal(review.env.CLAUDE_CODE_OAUTH_TOKEN, '${{ inputs.claude-code-oauth-token }}');
  assert.equal(review.env.PROVIDER, '${{ inputs.provider }}');
  assert.doesNotMatch(gate.run, /\$\{\{/, 'the gate takes its inputs through env only');
});

test('#544: each credential form runs the review, and a provider with none skips with a reason in the log', (t) => {
  const runs = [
    { inputs: { API_KEY: 'sk-ant' } },
    { inputs: { OAUTH_TOKEN: 'sk-ant-oat' } },
    { inputs: { PROVIDER: 'bedrock' }, jobEnv: AWS },
    { inputs: { PROVIDER: 'bedrock' }, jobEnv: { AWS_BEARER_TOKEN_BEDROCK: 'b' } },
    { inputs: { PROVIDER: 'vertex' }, jobEnv: GCP },
    { inputs: { PROVIDER: 'foundry' }, jobEnv: AZURE },
    { inputs: { PROVIDER: 'foundry' }, jobEnv: { ANTHROPIC_FOUNDRY_API_KEY: 'k' } },
  ];
  for (const run of runs) {
    const result = runGate(t, run);
    assert.equal(result.status, 0, JSON.stringify(run));
    assert.match(result.output, /^skip=false$/m, JSON.stringify(run));
    assert.equal(result.stdout, '', JSON.stringify(run));
  }
  // A fork run: the secrets are empty and the login step was skipped or failed, so nothing was exported.
  const skips = [
    [{ inputs: {} }, /^Review Voice skipped: no Anthropic API key or Claude Code OAuth token is available/],
    [{ inputs: { PROVIDER: 'bedrock' }, jobEnv: { AWS_REGION: 'us-west-2' } }, /^Review Voice skipped: no Amazon Bedrock credential is available: none of AWS_ACCESS_KEY_ID/],
    [{ inputs: { PROVIDER: 'vertex' }, jobEnv: { CLOUD_ML_REGION: 'us-east5' } }, /^Review Voice skipped: no Google Cloud credential is available/],
    [{ inputs: { PROVIDER: 'foundry' }, jobEnv: { ANTHROPIC_FOUNDRY_RESOURCE: 'r' } }, /^Review Voice skipped: no Microsoft Foundry credential is available/],
    // An API key is not a cloud provider's credential.
    [{ inputs: { PROVIDER: 'bedrock', API_KEY: 'sk-ant' } }, /^Review Voice skipped: no Amazon Bedrock credential/],
  ];
  for (const [run, line] of skips) {
    const result = runGate(t, run);
    assert.equal(result.status, 0, JSON.stringify(run));
    assert.match(result.output, /^skip=true$/m, JSON.stringify(run));
    assert.match(result.stdout, line, JSON.stringify(run));
  }
});

test('#544: a provider the Action does not know stops the job before any review', (t) => {
  const result = runGate(t, { inputs: { PROVIDER: 'openai', API_KEY: 'sk-ant' } });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^::error::The provider input must be anthropic, bedrock, vertex or foundry\.$/m);
  assert.doesNotMatch(result.output, /skip=false/);
});

test('#544: the review gets the chosen provider and its credentials, and no other provider\'s selection', (t) => {
  assert.deepEqual(runReview(t, { inputs: { ANTHROPIC_API_KEY: 'sk-ant' } }), { ANTHROPIC_API_KEY: 'sk-ant' });
  assert.deepEqual(runReview(t, { inputs: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' } }), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' }, 'an empty key is unset, not passed empty');
  assert.deepEqual(runReview(t, { inputs: { PROVIDER: 'bedrock', ANTHROPIC_API_KEY: 'sk-ant' }, jobEnv: AWS }), {
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_REGION: 'us-west-2',
  });
  assert.deepEqual(runReview(t, { inputs: { PROVIDER: 'vertex' }, jobEnv: GCP }), {
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gha-creds.json',
    ANTHROPIC_VERTEX_PROJECT_ID: 'p',
  });
  assert.deepEqual(runReview(t, { inputs: { PROVIDER: 'foundry' }, jobEnv: AZURE }), {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    ANTHROPIC_FOUNDRY_RESOURCE: 'r',
  });
});

test('#544: the provider input decides, not a selection left in the job\'s env', (t) => {
  const stray = { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_MANTLE: '1' };
  assert.deepEqual(runReview(t, { inputs: { ANTHROPIC_API_KEY: 'sk-ant' }, jobEnv: stray }), { ANTHROPIC_API_KEY: 'sk-ant' });
  assert.deepEqual(runReview(t, { inputs: { PROVIDER: 'foundry' }, jobEnv: { ...stray, ...AZURE } }), {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    ANTHROPIC_FOUNDRY_RESOURCE: 'r',
  });
});
