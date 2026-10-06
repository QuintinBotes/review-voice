/**
 * A question is eligible when its premises are verified, even if its answer is
 * not. That was already the behaviour, written down nowhere, and it is the one
 * place an unverified candidate reaches the editor. The verifier can now say
 * so with `premises_verified`; `false` keeps the question from being asked.
 * The editor contract also states that a question comes after every nit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

function run(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-question-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const question = {
  candidate_id: 'cand_001',
  path: 'src/orders.ts',
  line: 12,
  category: 'api_contract',
  severity: 'question',
  claim: 'Does the billing service accept the new `currency` field on this request?',
  failure_mode: 'If it rejects unknown fields, every order submission fails.',
  evidence: ['src/orders.ts:12 adds `currency` to the request body.'],
  technical_confidence: 0.5,
};

function score(dir, entry) {
  const file = join(dir, 'verification.json');
  writeFileSync(file, JSON.stringify([{ candidate_id: 'cand_001', verified: false, technical_confidence: 0.5, ...entry }]));
  return run(['score', '--verification', file], JSON.stringify({ candidates: [question] }), dir);
}

test('a question whose premises are verified is eligible though its answer is not', () =>
  withDir((dir) => {
    for (const entry of [{ premises_verified: true }, {}]) {
      const r = score(dir, entry);
      assert.equal(r.code, 0, r.stderr);
      const [row] = JSON.parse(r.stdout).scores;
      assert.equal(row.severity.severity, 'question');
      assert.equal(row.eligible, true, row.rejectedBecause);
    }
  }));

test('a question whose premises the verifier could not verify is not asked', () =>
  withDir((dir) => {
    const r = score(dir, { premisesVerified: false });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scores[0].eligible, false);
    assert.match(out.scores[0].rejectedBecause, /premises this question rests on \(premises_verified: false\)/);
    assert.deepEqual(out.eligible, []);
  }));

test('premises_verified must be a boolean', () =>
  withDir((dir) => {
    const r = score(dir, { premises_verified: 'false' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /premises_verified must be true or false/);
    const checked = run(['check-verification'], JSON.stringify([{ candidate_id: 'cand_001', premises_verified: 'yes' }]), dir);
    assert.equal(checked.code, 2);
  }));

test('the rule is documented for the verifier, the review, the architecture notes and the schema', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  assert.match(read('plugins/review-voice/agents/evidence-verifier.md'), /`premises_verified`/);
  assert.match(read('plugins/review-voice/commands/review.md'), /A `question` is eligible when its premises are verified, even if its answer\s+is not/);
  assert.match(read('docs/ARCHITECTURE.md'), /eligible when its premises are verified, even if its answer is\s+not/);
  const schema = JSON.parse(read('plugins/review-voice/schemas/verification.schema.json'));
  assert.equal(schema.properties.premises_verified.type, 'boolean');
});

test('the editor contract puts a question after every nit', () =>
  withDir((dir) => {
    const editor = readFileSync(join(plugin, 'agents/concise-editor.md'), 'utf8');
    assert.match(editor, /`blocking`, `important`, `minor`, `nit`, then `question`/);
    assert.match(editor, /`severity_order`/);
    const out = run(
      ['validate-output'],
      '[question] `src/a.ts:1` - Is this reachable? It matters.\n\n[nit] `src/a.ts:2` - Name is vague. Readers guess.\n',
      dir,
    );
    assert.equal(out.code, 1);
    assert.match(out.stdout + out.stderr, /severity_order|order/i);
  }));
