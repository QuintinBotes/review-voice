/**
 * Infrastructure signatures must not turn a real failure into a rerun (#21,
 * docs/adr/0013): only the output's title and summary and the runner's own
 * annotations are read, one unmatched failure annotation keeps a run red, the
 * optional annotation reads never wait out a rate limit, and a configured
 * phrase has to be specific.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { BUILTIN_RERUN_SIGNATURES, readCi, summariseCi } from '../plugins/review-voice/src/publish/ci.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const REPO = 'example/shop';
const SHA = 'b'.repeat(40);
const NOW = Date.parse('2026-10-06T12:00:00Z');

let nextId = 500;
const failed = (name, output = {}, annotations = undefined) => ({
  id: nextId++,
  name,
  status: 'completed',
  conclusion: 'failure',
  output: { title: null, summary: null, annotations_count: annotations?.length ?? 0, ...output },
  ...(annotations === undefined ? {} : { annotations }),
});
const runner = (message, level = 'failure') => ({ path: '.github', annotation_level: level, message });
const onFile = (path, message, extra = {}) => ({ path, annotation_level: 'failure', message, ...extra });

test('a test name quoting a signature is a test failure, not infrastructure', () => {
  const run = failed('unit', {}, [
    onFile('src/api/throttle.test.ts', 'returns 429 Too Many Requests when throttled', {
      title: 'throttle > returns 429 Too Many Requests when throttled',
    }),
  ]);
  const ci = summariseCi([run], []);
  assert.equal(ci.state, 'red');
  assert.deepEqual(ci.rerun, []);
});

test('a compiler diagnostic quoting a signature is a build failure, and output text and raw details are not read', () => {
  const run = failed(
    'typecheck',
    { text: "src/net/retry.ts(12,5): error TS2322: Type '\"ECONNRESET\"' is not assignable to type 'Code'." },
    [
      onFile('src/net/retry.ts', "Type '\"ECONNRESET\"' is not assignable to type 'Code'.", {
        raw_details: 'ECONNRESET other side closed',
      }),
    ],
  );
  assert.equal(summariseCi([run], []).state, 'red');

  const textOnly = failed('typecheck', { text: 'other side closed' });
  assert.equal(summariseCi([textOnly], []).state, 'red');
  const rawOnly = failed('typecheck', {}, [runner('Process failed', 'failure')]);
  rawOnly.annotations[0].raw_details = 'ECONNRESET';
  assert.equal(summariseCi([rawOnly], []).state, 'red');
});

test('one run with a real failure annotation beside an infrastructure one stays red', () => {
  const mixed = failed('e2e', {}, [
    runner('The self-hosted runner: r3 lost communication with the server.'),
    onFile('test/checkout.spec.ts', 'expected total 90, received 100'),
  ]);
  assert.equal(summariseCi([mixed], []).state, 'red');

  // An unmatched runner annotation is as much a failure as one on a file.
  const unmatched = failed('e2e', { summary: 'ECONNRESET while downloading' }, [runner('Error: the deployment was rejected')]);
  assert.equal(summariseCi([unmatched], []).state, 'red');

  // Warnings beside the infrastructure failure do not hold it red.
  const clean = failed('e2e', {}, [
    runner('The self-hosted runner: r3 lost communication with the server.'),
    onFile('src/basket.ts', 'Unused variable', { annotation_level: 'warning' }),
  ]);
  const ci = summariseCi([clean], []);
  assert.equal(ci.state, 'needs-rerun');
  assert.equal(ci.rerun[0].detail, 'failure, matched "lost communication with the server"');
});

test('annotations GitHub counted but that were not read keep a run red', () => {
  const unread = failed('deploy', { summary: 'We stopped hearing from agent', annotations_count: 2 });
  assert.equal(summariseCi([unread], []).state, 'red');
  const partly = failed('deploy', { annotations_count: 3 }, [runner('lost communication with the server')]);
  partly.output.annotations_count = 3;
  assert.equal(summariseCi([partly], []).state, 'red');
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeGitHub(runs, annotationResponse) {
  const calls = [];
  const impl = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith('/annotations')) return annotationResponse(path);
    if (path.endsWith('/check-runs')) return json({ total_count: runs.length, check_runs: runs });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const lostRuns = () =>
  [1, 2, 3].map((n) => ({
    id: 900 + n,
    name: `deploy ${n}`,
    status: 'completed',
    conclusion: 'failure',
    output: { title: null, summary: null, annotations_count: 1 },
  }));

test('a rate-limited annotation read stops the reads at once, without waiting, and the rest stay red', async () => {
  const limits = [
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791288000' } },
    { status: 403, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '12' } },
    { status: 429, headers: { 'retry-after': '120' } },
  ];
  for (const limit of limits) {
    let slept = 0;
    const impl = fakeGitHub(lostRuns(), () => new Response('API rate limit exceeded', limit));
    const client = new GitHubClient({
      allowlist: [REPO],
      token: 't',
      fetchImpl: impl,
      sleep: async () => {
        slept += 1;
      },
    });
    const ci = await readCi(client, REPO, SHA, [], NOW);
    assert.equal(slept, 0, JSON.stringify(limit));
    assert.equal(impl.calls.filter((path) => path.endsWith('/annotations')).length, 1, JSON.stringify(limit));
    assert.equal(ci.state, 'red');
    assert.equal(ci.failed.length, 3);
  }
});

test('the rest of the client still waits out a rate limit', async () => {
  let slept = 0;
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('API rate limit exceeded', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      : json({ ok: true });
  };
  const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => { slept += 1; } });
  assert.deepEqual((await client.get(`/repos/${REPO}/pulls/1`)).data, { ok: true });
  assert.equal(slept, 1);
});

test('an annotation read that fails for another reason skips that run and reads the next', async () => {
  const runs = lostRuns();
  const impl = fakeGitHub(runs, (path) =>
    path.includes(`/${runs[0].id}/`)
      ? new Response('server error', { status: 502 })
      : json([runner('The self-hosted runner: r1 lost communication with the server.')]),
  );
  const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });
  const ci = await readCi(client, REPO, SHA, [], NOW);
  assert.equal(ci.state, 'red');
  assert.deepEqual(ci.failed.map((entry) => entry.name), ['deploy 1']);
  assert.deepEqual(ci.rerun.map((entry) => entry.name), ['deploy 2', 'deploy 3']);
});

function withConfig(lines, body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-signature-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), [...lines, ''].join('\n'));
    body(loadConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('configured signatures that are not text, too short or one generic word are skipped with a warning', () => {
  withConfig(
    [
      'ci:',
      '  rerun_signatures:',
      '    - 403',
      '    - { phrase: "x" }',
      '    - "error"',
      '    - "Failed"',
      '    - "  Exception: "',
      '    - "timeout"',
      '    - "ETIMEDOUT"',
      '    - "socket hang up"',
    ],
    (config) => {
      assert.deepEqual(config.ciRules.rerunSignatures, [...BUILTIN_RERUN_SIGNATURES, 'ETIMEDOUT', 'socket hang up']);
      assert.equal(config.warnings.length, 6, config.warnings.join('\n'));
      assert.ok(config.warnings.some((warning) => warning.includes('403') && warning.includes('not text')));
      assert.ok(config.warnings.some((warning) => warning.includes('"Exception:"') && warning.includes('too generic')));
    },
  );
});
