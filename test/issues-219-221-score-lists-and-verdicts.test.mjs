/**
 * #219: a question the verifier rejected with low confidence that its gap is
 * real meets a confidence gate: belowGate, promotable. #220: eligible and
 * belowGate entries carry confidenceSource. #221: the verifier brief, the
 * schema and the CLI list the same fix_verdict values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIX_VERDICTS } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const question = {
  candidate_id: 'cand_001',
  path: 'src/notes.ts',
  line: 2,
  category: 'correctness',
  severity: 'question',
  claim: 'Can renderNotes receive null here?',
  failure_mode: 'A null list would throw in render.',
  evidence: ['src/notes.ts:2 calls notes.map without a guard.'],
  technical_confidence: 0.4,
};

function score(verification, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-219-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'notes.ts'), 'export function renderNotes(notes) {\n  return notes.map(String);\n}\n');
    for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init']]) {
      assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
    }
    const file = join(dir, 'verification.json');
    writeFileSync(file, JSON.stringify([{ candidate_id: 'cand_001', reason: 'Could not see the caller.', premises_verified: true, ...verification }]));
    const result = spawnSync(process.execPath, [bundle, 'score', '--verification', file, ...extra], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [question] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#219: a rejected question with low gap confidence is held in belowGate, and --promote lifts it', () => {
  const held = score({ verified: false, technical_confidence: 0.4 });
  assert.deepEqual(held.eligible, []);
  assert.match(held.scores[0].rejectedBecause, /below 0.5, and the verifier rejected this question \(verified: false\)/);
  assert.deepEqual(
    held.belowGate.map(({ candidate_id, gate, threshold, confidenceSource }) => [candidate_id, gate, threshold, confidenceSource]),
    [['cand_001', 'confidence', 0.5, 'verifier']],
  );

  const promoted = score({ verified: false, technical_confidence: 0.4 }, ['--promote', 'cand_001']);
  assert.deepEqual(promoted.eligible.map(({ candidate_id }) => candidate_id), ['cand_001']);
});

test('#219: at even odds or with the question verified, it is still asked', () => {
  assert.equal(score({ verified: false, technical_confidence: 0.5 }).eligible.length, 1);
  assert.equal(score({ verified: true, technical_confidence: 0.4 }).eligible.length, 1);
});

test('#220: an eligible entry says where its confidence came from', () => {
  const [entry] = score({ verified: true, technical_confidence: 0.9 }).eligible;
  assert.equal(entry.confidenceSource, 'verifier');
});

test('#221: the verifier brief and the schema list exactly the fix_verdict values the CLI accepts', () => {
  const brief = readFileSync(join(plugin, 'agents/evidence-verifier.md'), 'utf8');
  const row = brief.split('\n').find((line) => line.startsWith('| `fix_verdict` |'));
  assert.ok(row, 'the brief has a fix_verdict row');
  const listed = row.split(/(?<!\\)\|/)[2].match(/`([a-z]+)`/g).map((value) => value.slice(1, -1));
  assert.deepEqual(listed, [...FIX_VERDICTS]);

  const schema = JSON.parse(readFileSync(join(plugin, 'schemas/verification.schema.json'), 'utf8'));
  const enumValues = JSON.stringify(schema).match(/"fix_verdict":\{[^}]*"enum":\[([^\]]*)\]/)?.[1];
  assert.deepEqual(JSON.parse(`[${enumValues}]`), [...FIX_VERDICTS]);
});

test('#219: a rejected question whose confidence is only the analyst\'s is decided by its premises, as before', () => {
  const out = score({ verified: false, technical_confidence: undefined });
  assert.equal(out.scores[0].confidenceSource, 'analyst');
  assert.equal(out.eligible.length, 1, out.scores[0].rejectedBecause);
});
