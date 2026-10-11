/** Issue #131: explain includes a stored body-only simplification. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const patch = [
  'diff --git a/src/orders.ts b/src/orders.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/orders.ts',
  '@@ -0,0 +1,3 @@',
  '+export function sendOrder() {',
  '+  return dispatchOrder();',
  '+}',
  '',
].join('\n');
const bodyFinding = {
  candidate: {
    category: 'maintainability',
    claim: 'Use dispatchOrder so routing does not pass through the handler.',
    removes: [
      { path: 'src/orders.ts', line: 1, element: 'sendOrder wrapper' },
      { path: 'src/orders.ts', line: 2, element: 'dispatch return' },
    ],
    abstraction: { path: 'src/orders.ts', line: 2, name: 'dispatchOrder' },
  },
  verification: {
    verified: true,
    elements: [
      { path: 'src/orders.ts', line: 1, exists_in_diff: true },
      { path: 'src/orders.ts', line: 2, exists_in_diff: true },
    ],
    behavior_preserved: true,
    removes_concepts: true,
    reason: 'dispatchOrder already owns the routing decision.',
  },
};

function run(directory, data, args, input = '') {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: directory,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    input,
    encoding: 'utf8',
  });
}

test('explain lists a body-only simplification when no inline findings were recorded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-131-'));
  const data = join(directory, 'data');
  const diffFile = join(directory, 'diff.patch');
  const bodyFile = join(directory, 'body.json');
  mkdirSync(data);
  writeFileSync(diffFile, patch);
  writeFileSync(bodyFile, JSON.stringify({ bodyFindings: [bodyFinding] }));
  try {
    const recorded = run(directory, data, ['record', '--diff-file', diffFile, '--body-findings', bodyFile], 'No actionable findings.');
    assert.equal(recorded.status, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;

    const explained = run(directory, data, ['explain', '--run', runId]);
    assert.equal(explained.status, 0, explained.stderr);
    assert.doesNotMatch(explained.stdout, /No findings were recorded\./);
    assert.match(explained.stdout, /Body-only simplifications \(1\):/);
    assert.match(explained.stdout, /Use dispatchOrder so routing does not pass through the handler\./);
    assert.match(explained.stdout, /src\/orders\.ts:1 \(sendOrder wrapper\)/);
    assert.match(explained.stdout, /src\/orders\.ts:2 \(dispatch return\)/);
    assert.match(explained.stdout, /never affects the verdict/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
