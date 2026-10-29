/** #226: record --held warns about an entry no later --held-from run can match, and still records it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const REVIEW = '[important] `src/a.ts:3` - `load` returns null here, so the caller dereferences it.\n';

function record(held) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-226-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'files.json'), JSON.stringify({ files: [{ path: 'src/a.ts' }] }));
    writeFileSync(join(dir, 'held.json'), JSON.stringify(held));
    const done = spawnSync(
      process.execPath,
      [bundle, 'record', '--repository', 'o/r', '--head', 'abc', '--files', join(dir, 'files.json'), '--held', join(dir, 'held.json')],
      { cwd: dir, encoding: 'utf8', input: REVIEW, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
    );
    const id = JSON.parse(done.stdout).reviewRunId;
    const detail = JSON.parse(
      spawnSync(process.execPath, [bundle, 'explain', '--run', id, '--json'], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } }).stdout,
    );
    return { done, held: detail.held };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (path, line = 3) => ({ path, line, verdict: 'repeat', source: 'thread', reason: 'already raised' });

test('a held entry whose path is in no changed file or candidate warns and is still recorded', () => {
  const { done, held } = record([entry('wrong/dir/a.ts')]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /wrong\/dir\/a\.ts:3 matches no changed file or candidate/);
  assert.equal(held.length, 1);
});

test('a held entry on a changed file produces no warning', () => {
  const { done, held } = record([entry('src/a.ts')]);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stderr, /Held entry/);
  assert.equal(held.length, 1);
});

test('a held entry past the end of its file warns; its last line does not', () => {
  const past = record([entry('src/a.ts', 4)]);
  assert.equal(past.done.status, 0, past.done.stderr);
  assert.match(past.done.stderr, /src\/a\.ts:4 is past the end of the file \(3 lines\)/);
  assert.equal(past.held.length, 1);
});
