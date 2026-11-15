/**
 * #416: a detail the verifier corrected was posted as the analyst wrote it.
 * #417: the coordinator retyped each agent's JSON into a file by hand; the
 * commands now read a reply as it came.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherReplies } from '../plugins/review-voice/src/agents/reply-json.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-415-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir, args, input = '') =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } });

const candidate = {
  candidate_id: 'cand_001',
  path: 'src/a.ts',
  line: 3,
  category: 'correctness',
  severity: 'minor',
  claim: 'The rename misses eleven call sites of loadUser.',
  failure_mode: 'The eleven call sites fail to build.',
  evidence: ['eleven call sites still call loadUser'],
  technical_confidence: 0.9,
};
const verified = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.9 };

function score(dir, verification) {
  const file = join(dir, 'verification.json');
  writeFileSync(file, JSON.stringify([verification]));
  const result = run(dir, ['score', '--verification', file, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('#416: a verifier correction replaces the detail in the claim, failure mode and evidence', () =>
  withDir((dir) => {
    const out = score(dir, { ...verified, corrections: [{ wrong: 'eleven call sites', right: 'nine call sites' }] });
    const entry = out.eligible[0];
    assert.equal(entry.claim, 'The rename misses nine call sites of loadUser.');
    assert.equal(entry.failureMode, 'The nine call sites fail to build.');
    assert.deepEqual(entry.evidence, ['nine call sites still call loadUser']);
  }));

test('#416: a correction whose wrong text is not in the candidate holds the finding', () =>
  withDir((dir) => {
    const out = score(dir, { ...verified, corrections: [{ wrong: 'twelve call sites', right: 'nine call sites' }] });
    assert.deepEqual(out.eligible, []);
    assert.match(out.rejected[0].rejectedBecause, /the verifier corrected "twelve call sites", which is not in the candidate/);
  }));

test('#416: a malformed correction is refused by check-verification', () =>
  withDir((dir) => {
    const result = run(dir, ['check-verification'], JSON.stringify([{ ...verified, corrections: [{ wrong: '', right: 'x' }] }]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /corrections must be a list of at most 10/);
  }));

test('#417: check-candidates and check-intent read a reply with prose and a fence around its JSON', () =>
  withDir((dir) => {
    const reply = `Here are the candidates I found.\n\n\`\`\`json\n${JSON.stringify({ candidates: [] })}\n\`\`\`\n`;
    const checked = run(dir, ['check-candidates'], reply);
    assert.equal(checked.status, 0, checked.stderr);
    const none = run(dir, ['check-candidates'], 'I found nothing worth raising.');
    assert.equal(none.status, 2);
  }));

test('#417: several challenger or tie-breaker replies in one file are gathered', () => {
  const replies = [
    'Checked src/a.ts.\n{"verdicts": [{"candidate_id": "cand_001", "verdict": "confirmed"}]}',
    '```json\n{"verdicts": [{"candidate_id": "cand_002", "verdict": "refuted"}]}\n```',
  ].join('\n\n');
  assert.deepEqual(gatherReplies(replies, 'verdicts').value.verdicts.map((v) => v.candidate_id), ['cand_001', 'cand_002']);
  const rulings = '{"candidate_id": "cand_001", "upheld": true, "reason": "a"}\n{"candidate_id": "cand_002", "upheld": false, "reason": "b"}';
  assert.deepEqual(gatherReplies(rulings, 'tie_breaks').value.tie_breaks.map((r) => r.upheld), [true, false]);
  // One JSON document is passed on as it is, so the command's own shapes and refusals still apply.
  assert.deepEqual(gatherReplies('{"rulings": []}', 'tie_breaks'), { value: { rulings: [] }, wrapped: false });
  assert.equal(gatherReplies('no json here', 'verdicts'), undefined);
});

test('#421: gathered replies keep the keys beside their list', () => {
  const text = 'Reply one.\n{"verdicts": [{"candidate_id": "a"}], "reason": "late"}\nReply two.\n{"verdicts": [{"candidate_id": "b"}]}';
  const gathered = gatherReplies(text, 'verdicts').value;
  assert.deepEqual(gathered.verdicts.map((v) => v.candidate_id), ['a', 'b']);
  assert.equal(gathered.reason, 'late');
});
