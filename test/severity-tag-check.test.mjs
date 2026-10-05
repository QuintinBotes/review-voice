import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const scores = {
  scores: [],
  eligible: [{ candidateId: 'c1', path: 'src/auth.ts', line: 12, severity: 'important' }],
};

function validate(output, scoresJson) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-sevtag-'));
  try {
    const args = [bundle, 'validate-output'];
    if (scoresJson !== undefined) {
      writeFileSync(join(dir, 's.json'), JSON.stringify(scoresJson));
      args.push('--scores', join(dir, 's.json'));
    }
    return spawnSync(process.execPath, args, { input: output, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const finding = (severity, where) => `[${severity}] \`${where}\` - The retry mints two tokens when the client repeats the request.`;

test('a tag that matches its score passes', () => {
  assert.equal(validate(finding('important', 'src/auth.ts:12'), scores).status, 0);
});

test('a tag that disagrees with the score is a violation naming both severities', () => {
  const result = validate(finding('blocking', 'src/auth.ts:12'), scores);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/auth\.ts:12/);
  assert.match(result.stderr, /blocking/);
  assert.match(result.stderr, /important/);
});

test('a finding with no scored candidate at its line is a violation', () => {
  const result = validate(finding('important', 'src/auth.ts:99'), scores);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no scored candidate/);
});

test('the scores array and a bare array are both accepted', () => {
  const entry = { path: 'src/auth.ts', line: 12, eligible: true, severity: { severity: 'important' } };
  assert.equal(validate(finding('important', 'src/auth.ts:12'), { scores: [entry] }).status, 0);
  assert.equal(validate(finding('important', 'src/auth.ts:12'), [entry]).status, 0);
});

test('without --scores nothing changes', () => {
  assert.equal(validate(finding('blocking', 'src/auth.ts:99')).status, 0);
});
