import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

test('record with empty stdin says what a run with no findings pipes', () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-nofind-'));
  try {
    const result = spawnSync(process.execPath, [bundle, 'record'], {
      input: '', encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('A run with no findings pipes exactly No actionable findings.'), result.stderr);
    assert.ok(result.stderr.includes("echo 'No actionable findings.' | RV record"), result.stderr);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
