/**
 * A check that concludes `failure` because the runner or a service it called
 * gave out needs a rerun, not a red verdict (#21, docs/adr/0013). The failure
 * text is read only from the check run's output and its annotations, by GET.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import {
  BUILTIN_RERUN_SIGNATURES,
  infrastructureSignature,
  readCi,
  summariseCi,
} from '../plugins/review-voice/src/publish/ci.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const HEAD = 'c'.repeat(40);
const REPO = 'example/shop';
const PR = 7;
const NOW = Date.parse('2026-10-06T12:00:00Z');

let nextId = 100;
const failed = (name, output = {}, extra = {}) => ({
  id: nextId++,
  name,
  status: 'completed',
  conclusion: 'failure',
  started_at: '2026-10-06T11:00:00Z',
  completed_at: '2026-10-06T11:10:00Z',
  output: { title: null, summary: null, annotations_count: 0, ...output },
  ...extra,
});
const passed = (name) => ({ id: nextId++, name, status: 'completed', conclusion: 'success' });

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Answers head, check-run, annotation and status reads. Records every request. */
function fakeGitHub({ runs, annotations = {}, annotationStatus = 200 }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    const annotated = /\/check-runs\/(\d+)\/annotations$/.exec(parsed.pathname);
    if (annotated !== null) {
      if (annotationStatus !== 200) return new Response('forbidden', { status: annotationStatus });
      return json(annotations[annotated[1]] ?? []);
    }
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: runs.length, check_runs: runs });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

test('a failure whose output names an infrastructure cause needs a rerun, with the signature in the detail', () => {
  const ci = summariseCi([failed('deploy', { summary: '##[error] We stopped hearing from agent build-07.' }), passed('lint')], []);
  assert.equal(ci.state, 'needs-rerun');
  assert.deepEqual(ci.failed, []);
  assert.deepEqual(ci.rerun.map((entry) => [entry.name, entry.detail]), [
    ['deploy', 'failure, matched "We stopped hearing from agent"'],
  ]);

  const text = summariseCi([failed('plan', { summary: 'Error: 429 TOO MANY REQUESTS after 3 retries' })], []);
  assert.equal(text.state, 'needs-rerun');
  assert.equal(text.rerun[0].detail, 'failure, matched "429 Too Many Requests"');
});

test('a failure with no signature, and a bare status code, stay red', () => {
  assert.equal(summariseCi([failed('test', { summary: 'expected 2, received 3' })], []).state, 'red');
  assert.equal(summariseCi([failed('test', { summary: '503 tests passed, 1 failed' })], []).state, 'red');
  // Only a plain failure is reclassified, never a conclusion not yet known.
  const unknown = { ...failed('test', { summary: 'ECONNRESET' }), conclusion: 'something_new' };
  assert.equal(summariseCi([unknown], []).state, 'red');
});

test('a real failure beside an infrastructure one keeps CI red', () => {
  const ci = summariseCi([failed('unit', { summary: 'assertion failed' }), failed('install', { summary: 'npm ERR! ECONNRESET' })], []);
  assert.equal(ci.state, 'red');
  assert.deepEqual(ci.failed.map((entry) => entry.name), ['unit']);
  assert.deepEqual(ci.rerun.map((entry) => entry.name), ['install']);
});

test('only failure-level annotations count', () => {
  const lost = failed('build', {}, {
    annotations: [{ path: '.github', annotation_level: 'failure', message: 'The self-hosted runner: r1 lost communication with the server.' }],
  });
  assert.equal(infrastructureSignature(lost, BUILTIN_RERUN_SIGNATURES), 'lost communication with the server');

  const warned = failed('build', {}, {
    annotations: [{ path: '.github', annotation_level: 'warning', message: 'No space left on device' }],
  });
  assert.equal(infrastructureSignature(warned, BUILTIN_RERUN_SIGNATURES), null);
  assert.equal(summariseCi([warned], []).state, 'red');
});

test('configured signatures replace the default list; an empty list matches nothing', () => {
  const run = failed('report', { summary: 'HttpError: 403 resource not accessible' });
  assert.equal(summariseCi([run], []).state, 'red');
  const rules = { rerunSignatures: [...BUILTIN_RERUN_SIGNATURES, 'HttpError: 403'] };
  assert.equal(summariseCi([run], [], [], {}, rules).state, 'needs-rerun');

  const agent = failed('deploy', { summary: 'We stopped hearing from agent' });
  assert.equal(summariseCi([agent], [], [], {}, { rerunSignatures: [] }).state, 'red');
});

test('the live read fetches annotations of failed runs only, by GET, and matches them', async () => {
  const build = failed('build', { annotations_count: 2 });
  const lint = failed('lint', { annotations_count: 1 });
  const quiet = failed('docs', { summary: 'link check failed' });
  const already = failed('install', { summary: 'ECONNRESET' });
  const impl = fakeGitHub({
    runs: [build, lint, quiet, already, passed('format')],
    annotations: {
      [build.id]: [
        { path: '.github', annotation_level: 'warning', message: 'Node.js 16 actions are deprecated.' },
        { path: '.github', annotation_level: 'failure', message: 'The job running on runner r2 has exceeded the maximum execution time of 60 minutes.' },
      ],
      [lint.id]: [{ path: 'src/basket.ts', annotation_level: 'failure', message: 'Unexpected any. Specify a different type.' }],
    },
  });
  const ci = await readCi(client(impl), REPO, HEAD, [], NOW);
  assert.equal(ci.state, 'red');
  assert.deepEqual(ci.failed.map((entry) => entry.name), ['lint', 'docs']);
  assert.deepEqual(ci.rerun.map((entry) => [entry.name, entry.detail]), [
    ['build', 'failure, matched "has exceeded the maximum execution time"'],
    ['install', 'failure, matched "ECONNRESET"'],
  ]);
  assert.ok(impl.calls.every((call) => call.method === 'GET'));
  const annotationReads = impl.calls.filter((call) => call.path.endsWith('/annotations')).map((call) => call.path);
  // Not for a run with no annotations.
  assert.deepEqual(annotationReads, [
    `/repos/${REPO}/check-runs/${build.id}/annotations`,
    `/repos/${REPO}/check-runs/${lint.id}/annotations`,
  ]);
});

test('an annotation read that fails leaves the run red', async () => {
  const impl = fakeGitHub({ runs: [failed('build', { annotations_count: 1 })], annotationStatus: 403 });
  assert.equal((await readCi(client(impl), REPO, HEAD, [], NOW)).state, 'red');
});

test('with no signatures no annotation is read', async () => {
  const impl = fakeGitHub({ runs: [failed('build', { annotations_count: 1 })] });
  await readCi(client(impl), REPO, HEAD, [], NOW, { rerunSignatures: [] });
  assert.equal(impl.calls.filter((call) => call.path.endsWith('/annotations')).length, 0);
});

test('verdict holds every event with exit 6 and prints the matched signature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-infra-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    const review = 'No actionable findings.';
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: review, scores: [] });
    const impl = fakeGitHub({ runs: [failed('plan', { summary: 'other side closed' }), passed('lint')] });
    const { exitCode, output } = await computeVerdict({
      db,
      client: client(impl),
      repository: REPO,
      pullNumber: PR,
      head: HEAD,
      review,
      now: NOW,
    });
    assert.equal(exitCode, 6);
    assert.equal(output.event, null);
    assert.equal(output.payload, null);
    assert.ok(output.reasons.includes('CI needs a rerun: plan (failure, matched "other side closed")'), output.reasons.join('; '));
    assert.ok(impl.calls.every((call) => call.method === 'GET'));
  } finally {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

function withConfig(lines, body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-infra-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), [...lines, ''].join('\n'));
    body(loadConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ci.rerun_signatures adds to the built-in list; builtin_rerun_signatures: false drops it', () => {
  withConfig(['ci:', '  rerun_signatures:', '    - "HttpError: 403"', '    - ""'], (config) => {
    assert.deepEqual(config.ciRules.rerunSignatures, [...BUILTIN_RERUN_SIGNATURES, 'HttpError: 403']);
    assert.equal(config.warnings.length, 1);
  });
  withConfig(['ci:', '  builtin_rerun_signatures: false', '  rerun_signatures: ["socket hang up"]'], (config) => {
    assert.deepEqual(config.ciRules.rerunSignatures, ['socket hang up']);
  });
  withConfig(['ci:', '  builtin_rerun_signatures: false'], (config) => {
    assert.deepEqual(config.ciRules.rerunSignatures, []);
  });
  withConfig(['ci:', '  rerun_signatures: "ECONNRESET"', '  builtin_rerun_signatures: "no"'], (config) => {
    assert.equal(config.ciRules.rerunSignatures, undefined);
    assert.equal(config.warnings.length, 2);
  });
  withConfig([], (config) => assert.equal(config.ciRules.rerunSignatures, undefined));
});
