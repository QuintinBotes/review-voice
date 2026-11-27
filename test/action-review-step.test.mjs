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

// Found by the first end-to-end run: a review that stopped printed nothing to
// the log, so the reason was only in the job summary.
test('a review that stopped prints its reason as one escaped error annotation', (t) => {
  const s = scratch(t);
  const report = JSON.stringify({ exitCode: 7, error: 'The diff lane failed twice: API Error: 400 at 100% load\r\nsecond line ::add-mask::x' });
  const result = run(t, s, { report, code: 7 });
  assert.equal(result.status, 7);
  const annotations = result.stdout.split('\n').filter((line) => line.startsWith('::'));
  assert.deepEqual(annotations, ['::error::Review Voice: The diff lane failed twice: API Error: 400 at 100%25 load%0D']);
});

test('a report with no error prints no annotation', (t) => {
  const s = scratch(t);
  const result = run(t, s, { report: JSON.stringify({ exitCode: 0, findings: [] }) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('::error::'), false);
});

test('issue 507: a review that was not posted says why in the log, one escaped warning a line', (t) => {
  const s = scratch(t);
  const notes = ['not posted: writes.github_posting_enabled is false in .review-voice/config.yaml', 'injected\n::error::forged'];
  const result = run(t, s, { post: 'true', report: JSON.stringify({ exitCode: 0, posted: false, findings: [], notes }) });
  assert.equal(result.status, 0);
  const annotations = result.stdout.split('\n').filter((line) => line.startsWith('::'));
  assert.deepEqual(annotations, ['::warning::Review Voice: not posted: writes.github_posting_enabled is false in .review-voice/config.yaml']);
});

test('#508: a review held for CI says it ran, and the log carries one line with its verdict', (t) => {
  const report = JSON.stringify({ exitCode: 4, verdict: { event: 'APPROVE', action: 'wait' }, findings: [{}, {}], held: [{}], posted: false, costUsd: 0.31, seconds: 20.5 });
  const result = run(t, scratch(t), { report, code: 4 });
  assert.equal(result.status, 0);
  assert.match(result.summary, /the review ran, but CI is pending or needs a rerun, so its verdict was not posted\./);
  assert.equal(result.summary.includes('no review was posted'), false);
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('Review Voice: verdict'));
  assert.deepEqual(lines, ['Review Voice: verdict APPROVE, 2 findings, 1 held, review posted false, cost $0.31 in 20.5 s']);
});

// The live report of run 46046051722 on review-voice-scratch#1, CI `test` in progress.
test('#533: a review held for CI says in the log that its verdict was not posted, after the verdict line', (t) => {
  const report = JSON.stringify({
    exitCode: 4,
    verdict: { event: 'APPROVE', action: 'wait', reasons: ['CI is still running; approve once it is green with verdict --recheck'] },
    findings: [],
    held: [],
    posted: false,
    costUsd: 0.0158,
    seconds: 12.74,
  });
  const result = run(t, scratch(t), { report, code: 4 });
  assert.equal(result.status, 0);
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('Review Voice:'));
  assert.deepEqual(lines, [
    'Review Voice: verdict APPROVE, 0 findings, 0 held, review posted false, cost $0.0158 in 12.74 s',
    'Review Voice: the review ran, but CI is pending or needs a rerun, so its verdict was not posted.',
  ]);
});

test('#533: a review whose head moved says so in the log', (t) => {
  const result = run(t, scratch(t), { report: JSON.stringify({ exitCode: 3, verdict: { event: 'APPROVE', action: 'refuse' } }), code: 3 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Review Voice: the head moved during the review; a newer run covers it\.$/m);
});

// The live note of run 46046452274 on review-voice-scratch#1, in a repository that does not let Actions approve.
const NOT_PERMITTED =
  'post exited 1: GitHub returned 422 for /repos/QuintinBotes/review-voice-scratch/pulls/1/reviews: {"message":"Unprocessable Entity","errors":["GitHub Actions is not permitted to approve pull requests."],"documentation_url":"https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request","status":"422"}';

test('#535: an approval the workflow token may not send passes the job with one warning naming the setting', (t) => {
  const report = JSON.stringify({
    exitCode: 1,
    verdict: { event: 'APPROVE', action: 'post', reasons: [] },
    findings: [],
    held: [],
    posted: false,
    notes: ["Reviewed changes to this pull request's own diff since 8f50952; base-branch changes merged in were not reviewed.", NOT_PERMITTED],
  });
  const result = run(t, scratch(t), { post: 'true', report, code: 1 });
  assert.equal(result.status, 0);
  const annotations = result.stdout.split('\n').filter((line) => line.startsWith('::'));
  assert.equal(annotations.length, 1);
  assert.match(annotations[0], /^::warning::Review Voice: the review approves, but this repository does not let GitHub Actions approve pull requests/);
  assert.match(annotations[0], /Workflow permissions/);
});

test('#535: any other failed post still fails the job', (t) => {
  const other = NOT_PERMITTED.replace('GitHub Actions is not permitted to approve pull requests.', 'Review cannot be submitted.');
  const report = JSON.stringify({ exitCode: 1, verdict: { event: 'APPROVE', action: 'post' }, notes: [other] });
  const result = run(t, scratch(t), { post: 'true', report, code: 1 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::Review Voice: post exited 1: GitHub returned 422/m);
});

test('#508: a report that is not JSON adds no verdict line', (t) => {
  const result = run(t, scratch(t), { report: 'not json' });
  assert.equal(result.stdout.includes('Review Voice: verdict'), false);
});

// A refusal in the post stage leaves a note and no `error`; the log must say why the job failed (#507).
test('#507: a refusal from the post stage is printed as an escaped error annotation when the job fails, not only as the help hint', (t) => {
  const note = 'post exited 2: the pull request head moved, 100% sure\r\nsecond line ::add-mask::x';
  const report = JSON.stringify({ exitCode: 2, notes: ['an earlier note', note] });
  const result = run(t, scratch(t), { report, code: 2 });
  assert.equal(result.status, 2);
  const annotations = result.stdout.split('\n').filter((line) => line.startsWith('::'));
  assert.deepEqual(annotations, ['::error::Review Voice: post exited 2: the pull request head moved, 100%25 sure%0D']);
});

test('#507: a refusal note is not annotated when the job passes, and an error already printed is not repeated', (t) => {
  const s = scratch(t);
  const held = JSON.stringify({ exitCode: 4, notes: ['post exited 4: CI is pending'] });
  const passed = run(t, s, { report: held, code: 4 });
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout.includes('::error::'), false);
  const stopped = JSON.stringify({ exitCode: 7, error: 'The diff lane failed twice', notes: ['post exited 2: x'] });
  const failed = run(t, s, { report: stopped, code: 7 });
  assert.deepEqual(failed.stdout.split('\n').filter((line) => line.startsWith('::')), ['::error::Review Voice: The diff lane failed twice']);
});
