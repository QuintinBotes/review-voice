/** #316: record refuses a stages file it cannot read as stages, and names a field it drops, instead of saving an empty list without a word. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function record(stages) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-316-'));
  try {
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dir };
    writeFileSync(join(dir, 'stages.json'), JSON.stringify(stages));
    const done = spawnSync(process.execPath, [bundle, 'record', '--repository', 'o/r', '--stages', join(dir, 'stages.json')], {
      cwd: dir,
      encoding: 'utf8',
      input: 'No actionable findings.',
      env,
    });
    const detail = done.status === 0 ? JSON.parse(spawnSync(process.execPath, [bundle, 'explain', '--json'], { encoding: 'utf8', env }).stdout) : null;
    return { done, stages: detail?.stages ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('stages keyed by name are refused with the names, not stored as an empty list', () => {
  const { done } = record({ analyst: { seconds: 5 }, verifier: { seconds: 2 } });
  assert.equal(done.status, 2, done.stderr);
  assert.match(done.stderr, /Cannot read stages from .*"analyst", "verifier"/);
});

test('an entry with an unknown field is kept, and the field it drops is named', () => {
  const { done, stages } = record([{ name: 'analyst', seconds: 5 }, { name: 'verifier', seconds: 2, duration: 2, note: 'x' }]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /entry 1: unknown fields "duration", "note" not stored/);
  assert.deepEqual(stages, [{ name: 'analyst', seconds: 5 }, { name: 'verifier', seconds: 2 }]);
});

test('an entry without a name or a numeric seconds is refused, not dropped', () => {
  for (const unnamed of [record([{ seconds: 5 }]), record([{ name: '', seconds: 5 }])]) {
    assert.equal(unnamed.done.status, 2, unnamed.done.stderr);
    assert.match(unnamed.done.stderr, /entry 0: name must be a non-empty string/);
  }
  const untimed = record([{ name: 'analyst', seconds: '5' }]);
  assert.equal(untimed.done.status, 2, untimed.done.stderr);
  assert.match(untimed.done.stderr, /entry 0: seconds must be a number/);
});

test('a file that is not a list of stage objects is refused, not stored as an empty list', () => {
  for (const shape of [{}, { stages: 5 }]) {
    const { done } = record(shape);
    assert.equal(done.status, 2, done.stderr);
    assert.match(done.stderr, /expected an array/);
  }
  const { done } = record(['analyst']);
  assert.equal(done.status, 2, done.stderr);
  assert.match(done.stderr, /entry 0: not an object/);
});

test('a well-formed stages file with any stage name is stored whole', () => {
  const { done, stages } = record({ stages: [{ name: 'analyst', seconds: 5, toolCalls: 3, model: 'sonnet' }, { name: 'my-lane', seconds: 2 }] });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(stages, [{ name: 'analyst', seconds: 5, model: 'sonnet', toolCalls: 3 }, { name: 'my-lane', seconds: 2 }]);
});
