import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const GENERATED = 'src/generated/types.ts';
const CONSUMER = 'src/orders/consumer.ts';
const OTHER = 'src/billing/invoice.ts';

const candidate = {
  candidate_id: 'c1',
  path: GENERATED,
  line: 5,
  category: 'correctness',
  severity: 'important',
  claim: 'The hand-edited status field in this generated file is lost when the client is regenerated.',
  failure_mode: 'Regenerating from the spec overwrites the field and breaks the consumer.',
  evidence: ['The field is added on a changed line of the generated file.'],
  technical_confidence: 0.95,
};

function checkCandidates(thread) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-143-'));
  try {
    const patch = join(dir, 'diff.patch');
    const body = Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`);
    writeFileSync(
      patch,
      [GENERATED, CONSUMER, OTHER]
        .flatMap((file) => [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1,20 @@', ...body])
        .join('\n'),
    );
    const threadFile = join(dir, 'thread.json');
    writeFileSync(threadFile, JSON.stringify({ comments: thread }));
    const stdout = execFileSync(process.execPath, [bundle, 'check-candidates', '--diff-file', patch, '--thread', threadFile], {
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a repeat of a comment anchored in another file that names this file is flagged for the verifier', () => {
  const out = checkCandidates([
    {
      path: CONSUMER,
      line: 12,
      author: 'other-reviewer',
      kind: 'review-comment',
      body: 'The status field hand-edited in types.ts is lost when the generated client is regenerated from the spec.',
    },
  ]);

  assert.deepEqual(out.droppedAsRepeat, [], 'only the file name ties them, so it is never dropped');
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].possibleRepeatOf.kind, 'thread');
  assert.equal(out.kept[0].possibleRepeatOf.path, CONSUMER);
  assert.equal(out.kept[0].possibleRepeatOf.line, 12);
});

test('the same wording anchored in another file about that file is neither dropped nor flagged', () => {
  // Every word of the claim, but the comment is about the invoice's own
  // generated field and never names the candidate's file.
  const out = checkCandidates([
    {
      path: OTHER,
      line: 5,
      author: 'other-reviewer',
      kind: 'review-comment',
      body: `${candidate.claim} ${candidate.failure_mode}`,
    },
  ]);

  assert.deepEqual(out.droppedAsRepeat, []);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].possibleRepeatOf, undefined);
});
