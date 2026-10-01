import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const REVIEW = '[important] `src/a.ts:3` - `load` returns null here, so the caller dereferences it.\n';

function run(args, input, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-held-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (over = {}) => ({
  path: 'src/a.ts',
  line: 9,
  verdict: 'repeat',
  source: 'thread',
  reason: 'already raised on the pull request',
  ...over,
});

function record(dir, held, extra = []) {
  const file = join(dir, 'held.json');
  writeFileSync(file, JSON.stringify(held));
  return run(['record', '--repository', 'o/r', '--head', 'abc', '--held', file, ...extra], REVIEW, dir);
}

test('record --held stores entries and explain lists them after the findings', () => {
  withDir((dir) => {
    const done = record(dir, { held: [entry(), entry({ line: 12, verdict: 'refuted', source: 'cross-check', reason: 'guarded upstream' })] });
    assert.equal(done.code, 0, done.stderr);
    const id = JSON.parse(done.stdout).reviewRunId;

    const detail = JSON.parse(run(['explain', '--run', id, '--json'], '', dir).stdout);
    assert.equal(detail.held.length, 2);
    assert.equal(detail.headRef, 'abc');

    const text = run(['explain', '--run', id], '', dir).stdout;
    assert.ok(text.indexOf('Held back (2):') > text.indexOf('rv_01'));
    assert.match(text, /\[repeat\] src\/a\.ts:9 {2}thread - already raised on the pull request/);
    assert.match(text, /\[refuted\] src\/a\.ts:12 {2}cross-check - guarded upstream/);
  });
});

test('record --held accepts a bare array', () => {
  withDir((dir) => {
    assert.equal(record(dir, [entry({ verdict: 'partly', severity: 'minor', candidateId: 'c1', text: 'x' })]).code, 0);
  });
});

test('record --held rejects malformed entries with exit 2', () => {
  withDir((dir) => {
    for (const bad of [
      entry({ verdict: 'maybe' }),
      entry({ source: '' }),
      entry({ reason: '  ' }),
      entry({ line: 0 }),
      entry({ path: '' }),
      entry({ severity: 3 }),
      'nope',
    ]) {
      assert.equal(record(dir, [bad]).code, 2, JSON.stringify(bad));
    }
    assert.equal(record(dir, { other: [] }).code, 2);
  });
});

test('a run recorded without --held explains with no held section', () => {
  withDir((dir) => {
    const done = run(['record', '--repository', 'o/r'], REVIEW, dir);
    const id = JSON.parse(done.stdout).reviewRunId;
    assert.deepEqual(JSON.parse(run(['explain', '--run', id, '--json'], '', dir).stdout).held, []);
    assert.doesNotMatch(run(['explain', '--run', id], '', dir).stdout, /Held back/);
  });
});
