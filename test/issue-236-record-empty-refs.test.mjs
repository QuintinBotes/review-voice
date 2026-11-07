/**
 * #236: `record` refuses an empty `--base` or `--head`. A shell slip that leaves
 * a variable unset used to store a run with no head, which no later run on the
 * same head could ever be compared with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const CLEAN = 'No actionable findings.';

/** `record` against a data directory of its own; stdin is a clean review. */
function record(t, args) {
  const data = mkdtempSync(join(tmpdir(), 'rv-236-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  const result = spawnSync(process.execPath, [bundle, 'record', '--repository', 'acme/api', ...args], { encoding: 'utf8', env, input: CLEAN, cwd: data });
  return { ...result, stored: existsSync(join(data, 'review-voice.db')) };
}

test('an empty --base or --head exits 2 before anything is stored', (t) => {
  for (const args of [
    ['--base', '', '--head', ''],
    ['--base', 'a'.repeat(40), '--head', ''],
    ['--base', '', '--head', 'b'.repeat(40)],
  ]) {
    const result = record(t, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /--(base|head) needs a git ref or sha; it was empty/);
    assert.equal(result.stdout, '');
    assert.equal(result.stored, false, 'no store was created');
  }
});

test('a flag with no value at all is refused the same way', (t) => {
  const result = record(t, ['--head', '--candidates', 'none.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--head needs a git ref or sha/);
  assert.equal(result.stored, false);
});

test('refs that are given are still recorded, and leaving both flags out still records none', (t) => {
  const given = record(t, ['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)]);
  assert.equal(given.status, 0, given.stderr);
  assert.ok(JSON.parse(given.stdout).reviewRunId);
  const omitted = record(t, []);
  assert.equal(omitted.status, 0, omitted.stderr);
  assert.ok(JSON.parse(omitted.stdout).reviewRunId);
});
