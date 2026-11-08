/**
 * The action's review step, run as GitHub's runner runs it (bash with -e and
 * pipefail), against a scratch repository and a stub bundle that records what
 * it was given. It proves which configuration a review reads, that the run
 * says it came from the Action, and when a failed review may pass the job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const action = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const script = action.runs.steps.find((step) => step.id === 'review').run;

const BASE_CONFIG = 'review:\n  mode: fast\n';
const HEAD_CONFIG = 'review:\n  mode: thorough\n';

// Records its arguments and a copy of the --config file, prints a canned report, exits as told.
const STUB = `import { copyFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args));
const at = args.indexOf('--config');
if (at !== -1) copyFileSync(args[at + 1], process.env.FAKE_CONFIG_COPY);
process.stdout.write(process.env.FAKE_REPORT ?? '{}');
process.exit(Number(process.env.FAKE_CODE ?? '0'));
`;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-action-step-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  const actionPath = join(dir, 'action');
  const temp = join(dir, 'runner-temp');
  for (const path of [workspace, join(actionPath, 'plugins/review-voice/dist'), temp]) mkdirSync(path, { recursive: true });
  writeFileSync(join(actionPath, 'plugins/review-voice/dist/review-voice.mjs'), STUB);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(workspace, 'ci'));
  writeFileSync(join(workspace, 'ci/review.yaml'), BASE_CONFIG);
  writeFileSync(join(workspace, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  // The pull request rewrites the config to loosen the review and adds one of its own.
  writeFileSync(join(workspace, 'ci/review.yaml'), HEAD_CONFIG);
  writeFileSync(join(workspace, 'ci/added.yaml'), HEAD_CONFIG);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return { dir, workspace, actionPath, temp, base };
}

function run(t, s, { config = '.review-voice/config.yaml', post = 'false', failOpen = 'false', report = '{}', code = 0, baseSha, workspace = s.workspace } = {}) {
  const event = join(s.dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: baseSha ?? s.base } } }));
  const summary = join(s.dir, `summary-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(summary, '');
  const args = join(s.dir, 'args.json');
  const copy = join(s.dir, 'config-copy.yaml');
  rmSync(args, { force: true });
  rmSync(copy, { force: true });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: s.workspace,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_ACTION_PATH: s.actionPath,
      GITHUB_WORKSPACE: workspace,
      GITHUB_EVENT_PATH: event,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: 'acme/api',
      RUNNER_TEMP: s.temp,
      REVIEW_VOICE_DATA_DIR: join(s.dir, 'data'),
      PR: '7',
      MODE: 'auto',
      POST: post,
      CONFIG: config,
      FAIL_OPEN: failOpen,
      ANTHROPIC_API_KEY: 'unused',
      GITHUB_TOKEN: 'unused',
      FAKE_ARGS: args,
      FAKE_CONFIG_COPY: copy,
      FAKE_REPORT: report,
      FAKE_CODE: String(code),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    argv: existsSync(args) ? JSON.parse(readFileSync(args, 'utf8')) : null,
    config: existsSync(copy) ? readFileSync(copy, 'utf8') : null,
    summary: readFileSync(summary, 'utf8'),
  };
}

const flagValue = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

test('the default config path passes no --config, so review --pr reads it from the base commit itself, and the run says it came from the Action', (t) => {
  const result = run(t, scratch(t));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(flagValue(result.argv, '--origin'), 'action');
  assert.equal(result.argv.includes('--config'), false);
  assert.equal(result.argv.includes('--post'), false);
});

test('a named repository config is read from the base commit, not the head the author rewrote', (t) => {
  const s = scratch(t);
  for (const config of ['ci/review.yaml', './ci/review.yaml']) {
    const result = run(t, s, { config });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.config, BASE_CONFIG, `${config} is the base commit's copy`);
    assert.equal(flagValue(result.argv, '--config'), join(s.temp, 'review-voice-config.yaml'));
  }
});

test('a named config the base commit does not have runs on the defaults and says so', (t) => {
  const result = run(t, scratch(t), { config: 'ci/added.yaml' });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.config, '', 'an empty file is the built-in defaults, never the head copy');
  assert.match(result.summary, /ci\/added\.yaml is not in the base commit, so the review used the built-in defaults\./);
});

test('a named config with the base commit missing from the clone stops before the review', (t) => {
  const result = run(t, scratch(t), { config: 'ci/review.yaml', baseSha: 'f'.repeat(40) });
  assert.equal(result.status, 2);
  assert.equal(result.argv, null, 'the review never ran');
  assert.match(result.stdout, /::error::The pull request's base commit is not in the clone.*fetch-depth: 0/);
});

test('post: true adds --post', (t) => {
  const result = run(t, scratch(t), { post: 'true' });
  assert.ok(result.argv.includes('--post'));
});

test('fail-open passes a failed_open review and never a failed_closed one', (t) => {
  const s = scratch(t);
  const failedOpen = JSON.stringify({ failure: { mode: 'failed_open' } });
  const failedClosed = JSON.stringify({ failure: { mode: 'failed_closed' } });
  const opted = run(t, s, { failOpen: 'true', report: failedOpen, code: 7 });
  assert.equal(opted.status, 0);
  assert.match(opted.summary, /unavailable on a low-risk change \(failed_open\); passing\./);
  assert.equal(run(t, s, { failOpen: 'true', report: failedClosed, code: 7 }).status, 7, 'failed_closed fails whatever the input says');
  assert.equal(run(t, s, { failOpen: 'false', report: failedOpen, code: 7 }).status, 7, 'off by default');
  assert.equal(run(t, s, { failOpen: 'true', report: '{}', code: 0 }).status, 0, 'a review that ran is untouched');
});

test('a report that does not parse never passes the job, even when it starts with failed_open', (t) => {
  const s = scratch(t);
  for (const report of [
    '{"failure":{"mode":"failed_open"}} trailing text',
    '{"failure":{"mode":"failed_open"}}{"failure":{"mode":"failed_open"}}',
    'not json',
    '{"failure":{"mode":"failed_open"},"costUsd":NaN}',
    '{"failure":{"mode":"failed_open"},"seconds":Infinity}',
    '[{"failure":{"mode":"failed_open"}}]',
  ]) {
    // The review's own code, or the summary step's when it cannot read the report; never a pass.
    assert.notEqual(run(t, s, { failOpen: 'true', report, code: 7 }).status, 0, report);
  }
});

// No spelling is resolved on disk, so none can reach the head's copy: anything but a plain relative path stops.
test('a config that is not a plain repository-relative path stops before the review', (t) => {
  const s = scratch(t);
  for (const config of [
    join(s.workspace, 'ci/review.yaml'),
    '/etc/review.yaml',
    '../outside.yaml',
    'ci/../ci/review.yaml',
    'ci/./review.yaml',
    'ci//review.yaml',
    '..review.yaml',
    '--version',
    '-x',
    'ci/review.yaml\n',
    'ci/',
  ]) {
    const result = run(t, s, { config });
    assert.equal(result.status, 2, JSON.stringify(config));
    assert.equal(result.argv, null, `${JSON.stringify(config)}: the review never ran`);
    assert.match(result.stdout, /::error::The config input must be a repository-relative path/);
  }
});
