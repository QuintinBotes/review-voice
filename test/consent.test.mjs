import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildConsentPlan } from '../plugins/review-voice/src/consent/plan.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { previewPurge, executePurge } from '../plugins/review-voice/src/consent/purge.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

test('the consent plan names concrete data, not a category', () => {
  const plan = buildConsentPlan({
    ownerLogin: 'your-github-login',
    repositories: ['your-org/your-repo'],
    targetEvents: 250,
    storageLocation: '/tmp/x',
  });
  // "Review history" is not consent to anything in particular; a user cannot
  // agree to a scope they have to infer.
  assert.ok(plan.dataCategories.length >= 4);
  assert.ok(plan.dataCategories.some((c) => /diff hunk/i.test(c)));
  assert.ok(plan.dataCategories.some((c) => /line number/i.test(c)));
  assert.equal(plan.writeOperations, 'none');
  assert.ok(plan.retention.some((r) => /never stored/i.test(r)));
  assert.ok(plan.retention.some((r) => /never leaves this machine/i.test(r)));
});

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-purge-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const event = (repository, key, createdAt = '2026-09-01T00:00:00Z') => ({
  eventId: `gh_${key}`,
  source: 'github',
  repository,
  pullNumber: 1,
  pullRequestUrl: 'https://example.com/pull/1',
  commentId: key,
  reviewerLogin: 'someone',
  role: 'owner',
  createdAt,
  bodyRedacted: 'A comment that carries some judgement about the code.',
  contentKey: key,
  redactionVersion: '1',
  redactionCounts: {},
});

test('a preview counts without deleting', () => {
  withDb((db) => {
    storeEvents(db, [event('org/a', 'k1'), event('org/b', 'k2')]);
    const preview = previewPurge(db, { all: true });
    assert.equal(preview.events, 2);
    // Still there: previewing must not remove anything.
    assert.equal(previewPurge(db, { all: true }).events, 2);
  });
});

test('purging one repository leaves the others alone', () => {
  withDb((db) => {
    storeEvents(db, [event('org/a', 'k1'), event('org/a', 'k2'), event('org/b', 'k3')]);
    const removed = executePurge(db, { repository: 'org/a' });
    assert.equal(removed.events, 2);
    assert.equal(previewPurge(db, { all: true }).events, 1);
    assert.deepEqual(Object.keys(previewPurge(db, { all: true }).byRepository), ['org/b']);
  });
});

test('purging by date removes only older events', () => {
  withDb((db) => {
    storeEvents(db, [
      event('org/a', 'old', '2026-01-01T00:00:00Z'),
      event('org/a', 'new', '2026-09-01T00:00:00Z'),
    ]);
    executePurge(db, { before: '2026-06-01T00:00:00Z' });
    assert.equal(previewPurge(db, { all: true }).events, 1);
  });
});

test('the audit entry survives the purge it records', () => {
  withDb((db) => {
    storeEvents(db, [event('org/a', 'k1')]);
    executePurge(db, { all: true });
    const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'purge'").get();
    // Deleting the evidence that a deletion happened would make the audit
    // trail useless exactly when it matters most.
    assert.equal(audits.n, 1);
  });
});

test('purge without a scope refuses rather than guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-purge-cli-'));
  try {
    execFileSync(process.execPath, [bundle, 'purge'], {
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
      encoding: 'utf8',
    });
    assert.fail('should have exited non-zero');
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(error.stderr, /needs a scope/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purge does not delete without --confirm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-purge-cli2-'));
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dir };
  try {
    execFileSync(process.execPath, [bundle, 'record'], {
      env,
      input: '[minor] `a.ts:1` - Something breaks here. It fails. Fix it.',
      encoding: 'utf8',
    });
    const preview = JSON.parse(
      execFileSync(process.execPath, [bundle, 'purge', '--all'], { env, encoding: 'utf8' }),
    );
    assert.equal(preview.confirmed, false);
    assert.equal(preview.wouldRemove.reviewRuns, 1);

    const after = JSON.parse(
      execFileSync(process.execPath, [bundle, 'purge', '--all'], { env, encoding: 'utf8' }),
    );
    // Unchanged: a preview is not a deletion.
    assert.equal(after.wouldRemove.reviewRuns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
