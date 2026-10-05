import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// A writer that is still filling the pipe when the command starts reading is
// the normal case under load. The read must wait for the end of input rather
// than take an empty pipe for empty input.
test('score reads candidates that arrive in pieces on a slow pipe', async () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-slow-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'rv-slow-repo-'));
  try {
    const input = JSON.stringify({
      candidates: [{
        candidate_id: 'c1', path: 'src/a.ts', line: 3, category: 'correctness', severity: 'minor',
        claim: 'The loop never ends when the list is empty.', failure_mode: 'An empty list hangs the worker.',
        evidence: ['src/a.ts:3 while (i !== list.length)'], technical_confidence: 0.9,
      }],
    });
    const child = spawn(process.execPath, [bundle, 'score', '--repository', 'org/a'], {
      cwd: dir, env: { ...process.env, REVIEW_VOICE_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => child.on('close', resolve));
    child.stdin.on('error', () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.write(input.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end(input.slice(40));
    const status = await done;
    assert.equal(status, 0, stderr);
    assert.equal(JSON.parse(stdout).scores.length, 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
