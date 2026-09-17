import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ineligibleReason } from '../plugins/review-voice/src/corpus/eligibility.ts';
import { contentKey } from '../plugins/review-voice/src/corpus/dedup.ts';
import { selectEvents } from '../plugins/review-voice/src/corpus/select.ts';

const REAL = 'This returns before the transaction commits, so a retry mints two tokens.';
const base = { role: 'owner', hasCodeContext: true };

test('a substantive owner comment is eligible', () => {
  assert.equal(ineligibleReason({ ...base, body: REAL, filePath: 'src/a.ts' }), null);
});

test('bot output never enters the corpus', () => {
  // It would teach the reviewer to sound like a linter.
  assert.equal(ineligibleReason({ ...base, role: 'bot', body: REAL }), 'bot');
});

test('external contributors are excluded', () => {
  // Per the owner's choice: learn from yourself and teammates only.
  assert.equal(ineligibleReason({ ...base, role: 'external', body: REAL }), 'external_reviewer');
  assert.equal(ineligibleReason({ ...base, role: 'team', body: REAL }), null);
});

test('approval-only comments carry no judgement', () => {
  for (const body of ['LGTM', 'lgtm!', 'Looks good to me', '👍', '+1', 'ship it', 'SGTM.']) {
    assert.equal(ineligibleReason({ ...base, body }), 'approval_only', body);
  }
});

test('a pull-request template is mostly structure', () => {
  const template = [
    '## Description',
    '',
    'Adds the thing.',
    '',
    '## Checklist',
    '- [x] Tests added',
    '- [ ] Docs updated',
    '- [ ] Changelog entry',
    '## Type of change',
    '- [x] Feature',
  ].join('\n');
  assert.equal(ineligibleReason({ ...base, body: template }), 'template_or_status');
  assert.equal(ineligibleReason({ ...base, body: '- [x] Tests added\n- [ ] Docs' }), 'template_or_status');
});

test('automation status carries no judgement whatever its length', () => {
  assert.equal(
    ineligibleReason({ ...base, body: 'Deployment succeeded for this pull request.' }),
    'template_or_status',
  );
});

test('a substantive review containing a checklist is kept', () => {
  // Measured against a real repository, the earlier "contains a checkbox" rule
  // discarded fourteen review summaries whose structure ratios were 0.18-0.30
  // - substantive reviews with a checklist in them. Losing those was losing
  // most of the corpus.
  const review = [
    'I went through the retry path and the transaction boundary.',
    '',
    'The response is emitted before the commit, so a retry can mint a second',
    'token. That needs to move below the commit.',
    '',
    'Separately the backoff is unbounded, which will hammer the downstream',
    'service during an outage rather than shedding load.',
    '',
    '- [x] I checked the migration',
    '- [ ] I did not verify the metrics dashboard',
    '',
    'Otherwise the shape looks right to me.',
  ].join('\n');
  assert.equal(ineligibleReason({ ...base, body: review }), null);
});

test('comments on generated files are excluded', () => {
  for (const filePath of ['dist/app.js', 'node_modules/x/index.js', 'package-lock.json', 'a.min.css']) {
    assert.equal(ineligibleReason({ ...base, body: REAL, filePath }), 'generated_file', filePath);
  }
});

test('an inline comment with no recoverable code context is excluded', () => {
  assert.equal(
    ineligibleReason({ ...base, body: REAL, filePath: 'src/a.ts', hasCodeContext: false }),
    'no_code_context',
  );
  // A conversation comment has no file, so it needs no hunk.
  assert.equal(ineligibleReason({ ...base, body: REAL, hasCodeContext: false }), null);
});

test('very short comments have no failure mode to extract', () => {
  // Reported as approval_only now: once approval language and punctuation are
  // stripped, too little is left either way. Both mean "nothing to learn".
  assert.ok(['too_short', 'approval_only'].includes(ineligibleReason({ ...base, body: 'why?' })));
});

test('an approval that then raises something is kept', () => {
  // The distinction that matters: approving and saying nothing teaches
  // nothing; approving and then raising a real point is exactly the judgement
  // being modelled.
  assert.equal(
    ineligibleReason({
      ...base,
      body: 'Approving. One thing though - the retry path can double-charge if the commit lands late.',
    }),
    null,
  );
});

test('a bare approval summary is excluded however it is phrased', () => {
  // Three unrelated "Approving." comments were the top precedents for a code
  // finding, from three different repositories.
  for (const body of [
    'Approving.',
    'Approving - nice work!',
    'Approved. 👍',
    'LGTM, thanks!',
    'No comments from me. 🎉',
    'All good, ship it.',
  ]) {
    assert.equal(ineligibleReason({ ...base, body }), 'approval_only', body);
  }
});

test('the same comment resurfacing after a rebase deduplicates', () => {
  const parts = { repository: 'org/repo', reviewerLogin: 'someone', body: REAL, filePath: 'src/a.ts', lineStart: 12 };
  // Whitespace and case differ after a rebase reflows the comment.
  assert.equal(contentKey(parts), contentKey({ ...parts, body: `  ${REAL.toUpperCase()}  ` }));
});

test('the same words at a different location are different evidence', () => {
  const parts = { repository: 'org/repo', reviewerLogin: 'someone', body: REAL, filePath: 'src/a.ts', lineStart: 12 };
  assert.notEqual(contentKey(parts), contentKey({ ...parts, lineStart: 99 }));
  assert.notEqual(contentKey(parts), contentKey({ ...parts, filePath: 'src/b.ts' }));
  assert.notEqual(contentKey(parts), contentKey({ ...parts, reviewerLogin: 'someone-else' }));
});

const event = (repository, day, role = 'team') => ({
  repository,
  createdAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`,
  role,
});

test('no single repository dominates the corpus', () => {
  const events = [
    ...Array.from({ length: 80 }, (_, i) => event('org/busy', (i % 28) + 1)),
    ...Array.from({ length: 20 }, (_, i) => event('org/quiet', (i % 28) + 1)),
  ];
  const report = selectEvents(events, { target: 40, maxRepositoryShare: 0.5 });
  assert.equal(report.importedEvents, 40);
  assert.ok(report.perRepository['org/busy'] <= 20 + 20, 'busy repo should be capped then backfilled');
  assert.ok(report.perRepository['org/quiet'] > 0, 'the quiet repo must be represented');
});

test('the cap is relaxed rather than under-filling the corpus', () => {
  // A smaller corpus is a worse outcome than a slightly lopsided one, up to
  // the hard cap at 1.5x the configured share.
  const events = Array.from({ length: 30 }, (_, i) => event('org/only', (i % 28) + 1));
  const report = selectEvents(events, { target: 20, maxRepositoryShare: 0.5 });
  assert.equal(report.importedEvents, 15, 'soft cap 10, hard cap 15');
  assert.deepEqual(report.overRepresented, ['org/only']);
});

test('one repository cannot take the whole corpus', () => {
  // Measured in real use: a starved corpus let one repository reach 84%, which
  // is not a lopsided sample of the owner's work but a sample of one repository.
  const events = [
    ...Array.from({ length: 400 }, (_, i) => event('org/busy', (i % 28) + 1)),
    ...Array.from({ length: 40 }, (_, i) => event('org/quiet', (i % 28) + 1)),
  ];
  const report = selectEvents(events, { target: 250, maxRepositoryShare: 0.5 });
  assert.ok(report.perRepository['org/busy'] <= 187, 'hard cap is 1.5x the configured share');
  assert.equal(report.perRepository['org/quiet'], 40);
});

test('a diversity shortfall is not reported as an exhausted corpus', () => {
  // Different problems with different fixes: one means sync more history, the
  // other means the sample is lopsided.
  const events = [
    ...Array.from({ length: 400 }, (_, i) => event('org/busy', (i % 28) + 1)),
    ...Array.from({ length: 40 }, (_, i) => event('org/quiet', (i % 28) + 1)),
  ];
  const report = selectEvents(events, { target: 250, maxRepositoryShare: 0.5 });
  assert.ok(report.shortfall > 0);
  assert.match(report.shortfallReason, /diversity/i);

  const exhausted = selectEvents(
    Array.from({ length: 5 }, (_, i) => event('org/a', i + 1)),
    { target: 250, maxRepositoryShare: 0.5 },
  );
  assert.match(exhausted.shortfallReason, /exhausted/i);
});

test('a review this tool produced is never learned from', () => {
  // Posted output read back in becomes owner evidence and teaches the reviewer
  // its own voice - a closed loop that compounds every sync.
  assert.equal(
    ineligibleReason({
      ...base,
      body: '[blocking] `src/auth.ts:84` - Token returned before commit. A retry mints two. Commit first.',
    }),
    'self_generated',
  );
  assert.equal(
    ineligibleReason({
      ...base,
      body: 'Two things and a nit.\n\n[minor] `src/a.ts:1` - Something here. It fails. Fix it.',
    }),
    'self_generated',
  );
});

test('a shortfall is reported honestly, never as a full scan', () => {
  const events = Array.from({ length: 12 }, (_, i) => event('org/a', i + 1));
  const report = selectEvents(events, { target: 250, maxRepositoryShare: 0.5 });
  assert.equal(report.discoveredEligible, 12);
  assert.equal(report.importedEvents, 12);
  assert.equal(report.shortfall, 238);
  assert.match(report.shortfallReason, /exhausted/i);
});

test('newest evidence is preferred, and owner evidence wins a tie', () => {
  const events = [event('org/a', 1), event('org/a', 28), event('org/a', 28, 'owner')];
  const report = selectEvents(events, { target: 2, maxRepositoryShare: 1 });
  assert.equal(report.selected[0].role, 'owner');
  assert.ok(report.selected.every((e) => e.createdAt.endsWith('28T00:00:00Z')));
});

test('storing events writes only redacted text and deduplicates', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDatabase } = await import('../plugins/review-voice/src/store/db.ts');
  const { storeEvents, corpusCoverage } = await import('../plugins/review-voice/src/corpus/store.ts');

  const dir = mkdtempSync(join(tmpdir(), 'rv-corpus-'));
  const db = openDatabase(join(dir, 'corpus.db'));
  try {
    const event = {
      eventId: 'gh_1',
      source: 'github',
      repository: 'org/repo',
      pullNumber: 7,
      pullRequestUrl: 'https://github.com/org/repo/pull/7',
      commentId: '1',
      reviewerLogin: 'someone',
      role: 'owner',
      createdAt: '2026-09-01T00:00:00Z',
      bodyRedacted: 'Token is [REDACTED:GITHUB_TOKEN] here.',
      filePath: 'src/a.ts',
      lineStart: 12,
      contentKey: 'key-one',
      redactionVersion: '1',
      redactionCounts: { GITHUB_TOKEN: 1 },
    };

    assert.equal(storeEvents(db, [event]).inserted, 1);
    // The same content key arriving again is the rebase case; it must not duplicate.
    assert.equal(storeEvents(db, [{ ...event, eventId: 'gh_2', commentId: '2' }]).inserted, 0);

    const coverage = corpusCoverage(db);
    assert.equal(coverage.total, 1);
    assert.equal(coverage.byRepository['org/repo'], 1);
    assert.equal(coverage.byRole.owner, 1);

    // There is no column for original text, so none can be written by mistake.
    const columns = db.prepare('PRAGMA table_info(review_events)').all().map((c) => c.name);
    assert.ok(columns.includes('body_redacted'));
    assert.ok(!columns.includes('body_raw'));
    assert.ok(!columns.includes('source_json'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
