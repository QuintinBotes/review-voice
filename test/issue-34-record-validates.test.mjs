import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-record-validates-'));
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dir };
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [bundle, ...args], { env, input, encoding: 'utf8' });
    if (result.error !== undefined) throw result.error;
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const runCount = () => {
    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: dir }));
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n;
    } finally {
      db.close();
    }
  };
  try {
    return fn(run, runCount);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('record refuses the JSON that carry prints, and stores nothing', () => {
  withStore((run, runCount) => {
    const carryStdout = JSON.stringify({ from: 'r1', head: 'abc', carried: [], notCarried: [], output: '' }, null, 2);
    const result = run(['record', '--repository', 'o/r', '--head', 'abc'], carryStdout);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /\[no_findings_response\]/);
    assert.match(result.stderr, /nothing was recorded/);
    assert.equal(result.stdout, '');
    // The database may not even exist yet; when it does, it holds no run.
    let count = 0;
    try {
      count = runCount();
    } catch {
      count = 0;
    }
    assert.equal(count, 0);
  });
});

test('record names every contract problem in a malformed review', () => {
  withStore((run) => {
    const draft = '## Review\n\n[minor] `a.ts:3` - fine.\n\n[blocking] `a.ts:9` - the loop never ends.\n';
    const result = run(['record'], draft);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /\[heading\]/);
    assert.match(result.stderr, /\[severity_order\]/);
  });
});

test('record still accepts a validated review and the clean-review sentence', () => {
  withStore((run, runCount) => {
    assert.equal(run(['record'], 'No actionable findings.\n').code, 0);
    const review = '[important] `a.ts:9` - The loop never ends. The request hangs. Break on the sentinel.\n';
    assert.equal(run(['record'], review).code, 0);
    assert.equal(runCount(), 2);
  });
});

test('record does not apply the word budget validate-output was given', () => {
  // `validate-output --scale-to-files` can pass a review longer than the
  // default budget; recording it must not then refuse what was validated.
  withStore((run) => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const findings = Array.from({ length: 12 }, (_, i) => `[minor] \`f${i}.ts:${i + 1}\` - ${words}.`).join('\n\n');
    assert.equal(run(['record'], findings).code, 0);
  });
});
