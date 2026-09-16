import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { evaluatePostingGate } from '../plugins/review-voice/src/publish/gate.ts';
import { buildDraft } from '../plugins/review-voice/src/publish/draft.ts';

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-publish-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Records `count` labelled findings across however many reviews that takes.
 *
 * Five per review, because the contract caps a review at five — putting
 * twenty-five in one would make every recorded output non-compliant, which is
 * what an earlier version of this helper did and what the gate correctly
 * refused.
 */
function labelled(db, count, action) {
  let recorded = 0;
  while (recorded < count) {
    const batch = Math.min(5, count - recorded);
    const output = Array.from(
      { length: batch },
      (_, i) => `[minor] \`src/f${recorded + i}.ts:${recorded + i + 1}\` — A real problem here. It fails. Fix it.`,
    ).join('\n\n');
    const { reviewRunId } = recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: `d${recorded}`,
      output,
    });
    for (let i = 1; i <= batch; i += 1) {
      recordFeedback(db, {
        findingRef: `${reviewRunId}:rv_${String(i).padStart(2, '0')}`,
        action,
        actor: 'owner',
      });
    }
    recorded += batch;
  }
}

test('posting is refused with no measurement, whatever the config says', () => {
  withDb((db) => {
    // A boolean in a config file is a promise the user makes to themselves.
    const gate = evaluatePostingGate(db, true);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some((r) => /labelled/.test(r)));
  });
});

test('a high precision on too few samples is still refused', () => {
  withDb((db) => {
    labelled(db, 5, 'keep');
    const gate = evaluatePostingGate(db, true);
    // Five keeps and no dismissals is 100% and tells you nothing.
    assert.equal(gate.measured.precision, 1);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some((r) => /20 are needed/.test(r)));
  });
});

test('measured precision below target refuses posting', () => {
  withDb((db) => {
    labelled(db, 20, 'dismiss');
    const gate = evaluatePostingGate(db, true);
    assert.equal(gate.measured.precision, 0);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some((r) => /below the 0.8 target/.test(r)));
  });
});

test('posting is permitted only when the measurements support it', () => {
  withDb((db) => {
    labelled(db, 25, 'keep');
    const gate = evaluatePostingGate(db, true);
    assert.equal(gate.allowed, true, gate.reasons.join('; '));
    assert.equal(gate.measured.labelledFindings, 25);
  });
});

test('the config flag is necessary but nowhere near sufficient', () => {
  withDb((db) => {
    labelled(db, 25, 'keep');
    // Measurements pass; the flag alone still decides nothing on its own.
    assert.equal(evaluatePostingGate(db, true).allowed, true);
    const off = evaluatePostingGate(db, false);
    assert.equal(off.allowed, false);
    assert.ok(off.reasons.some((r) => /github_posting_enabled is false/.test(r)));
  });
});

test('the gate exposes no override', () => {
  // A gate with a bypass is a suggestion. The only inputs are the config flag
  // and what was measured; there is no third argument to pass.
  assert.equal(evaluatePostingGate.length, 2);
});

const OUTPUT = [
  '[blocking] `src/auth.ts:84` — Token returned before commit. A retry mints two. Commit first.',
  '[important] `.github/workflows/release.yml:52` — Publish runs after a skipped verify. Require it.',
].join('\n\n');

test('the draft carries the reviewed text unchanged', () => {
  const draft = buildDraft({ repository: 'org/a', pullNumber: 85, output: OUTPUT, diffHash: 'abc' });
  assert.equal(draft.comments.length, 2);
  assert.equal(draft.comments[0].path, 'src/auth.ts');
  assert.equal(draft.comments[0].line, 84);
  // Re-wording here would mean the reviewed text and the sent text were
  // different things.
  assert.match(draft.comments[0].body, /Token returned before commit/);
});

test('the preview is generated from what would be sent', () => {
  const draft = buildDraft({ repository: 'org/a', pullNumber: 85, output: OUTPUT, diffHash: 'abc' });
  // A preview generated separately from the payload is a mock-up, not a preview.
  for (const comment of draft.comments) {
    assert.ok(draft.preview.includes(comment.body), 'preview omits a comment that would be posted');
    assert.ok(draft.preview.includes(`${comment.path}:${comment.line}`));
  }
});

test('the idempotency key is stable for the same review of the same diff', () => {
  const a = buildDraft({ repository: 'org/a', pullNumber: 85, output: OUTPUT, diffHash: 'abc' });
  const b = buildDraft({ repository: 'org/a', pullNumber: 85, output: OUTPUT, diffHash: 'abc' });
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test('a different diff is a different post', () => {
  const a = buildDraft({ repository: 'org/a', pullNumber: 85, output: OUTPUT, diffHash: 'abc' });
  const b = buildDraft({ repository: 'org/a', pullNumber: 85, output: OUTPUT, diffHash: 'xyz' });
  // Otherwise a re-review after a force-push would be suppressed as a duplicate.
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test('a no-findings review drafts nothing', () => {
  const draft = buildDraft({
    repository: 'org/a',
    pullNumber: 85,
    output: 'No actionable findings.',
    diffHash: 'abc',
  });
  assert.equal(draft.comments.length, 0);
});
