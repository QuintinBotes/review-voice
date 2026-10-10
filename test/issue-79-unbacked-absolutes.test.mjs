/**
 * #79: the concise editor widened a finding about a banner shown "while the
 * query is still loading" to "on every open", then "on every load", and
 * `validate-output` passed both. With `--scores`, an absolute word the scored
 * finding does not use is now a violation the editor can retry on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkUnbackedAbsolutes } from '../plugins/review-voice/src/contract/backing-check.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const eligible = {
  candidateId: 'cand_001',
  candidate_id: 'cand_001',
  path: 'src/Banner.tsx',
  line: 12,
  severity: 'important',
  claim: 'The error banner renders while the query is still loading.',
  failureMode: 'Users see a false error until the query resolves.',
  evidence: ['src/Banner.tsx:12 checks `data === undefined` before `isLoading`.'],
  fix: { render: 'fix', text: 'Check `isLoading` before `data`.' },
};

const finding = (consequence) =>
  `[important] \`src/Banner.tsx:12\` - The error banner renders while the query is still loading. ${consequence} Check \`isLoading\` before \`data\`.`;

function validate(text, scores = { eligible: [eligible] }) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-79-'));
  try {
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scores));
    const r = spawnSync(process.execPath, [bundle, 'validate-output', '--json', '--scores', join(dir, 'scores.json')], {
      encoding: 'utf8',
      input: text,
    });
    return { code: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('"every load", which the finding does not say, is a violation', () => {
  const { code, out } = validate(finding('Users see a false error on every load.'));
  assert.equal(code, 1);
  const violation = out.violations.find((v) => v.code === 'unbacked_absolute');
  assert.ok(violation, JSON.stringify(out.violations));
  assert.match(violation.message, /src\/Banner\.tsx:12 says "every"/);
});

test('the scored wording, compressed, passes', () => {
  const { code, out } = validate(finding('Users see a false error until it resolves.'));
  assert.equal(code, 0, JSON.stringify(out.violations));
});

test('an absolute word the scored finding itself uses passes', () => {
  const scored = { ...eligible, failureMode: 'Every user sees a false error until the query resolves.' };
  const { code, out } = validate(finding('Every user sees a false error.'), { eligible: [scored] });
  assert.equal(code, 0, JSON.stringify(out.violations));
});

test('each absolute word is caught, and all of them are named', () => {
  const violations = checkUnbackedAbsolutes(finding('It always fails for all users and never recovers.'), [eligible]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /"always", "never", "all"/);
});

test('a code span is not read as a claim', () => {
  const text = '[important] `src/Banner.tsx:12` - The error banner renders while the query is still loading. Users see a false error until it resolves. Await `Promise.all` before `isLoading`.';
  assert.deepEqual(checkUnbackedAbsolutes(text, [eligible]), []);
});

test('without --scores nothing is checked, and a finding with no score is left to severity_no_score', () => {
  assert.deepEqual(checkUnbackedAbsolutes(finding('Users see it on every load.'), []), []);
  const r = spawnSync(process.execPath, [bundle, 'validate-output', '--json'], { encoding: 'utf8', input: finding('Users see it on every load.') });
  assert.equal(r.status, 0, r.stdout);
});
