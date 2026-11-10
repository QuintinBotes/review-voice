/**
 * S25 (docs/adr/0034), AC-6: ADR 0034 exists, ADR 0029 carries a dated
 * amendment, the index marks both, `docs/EVALUATION.md` documents the figure,
 * and the watcher document, the example config and the help name the setting
 * and the flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('ADR 0034 exists, ADR 0029 gains a dated amendment, and the index marks both', () => {
  const index = read('docs/adr/README.md');
  const listed = /\[0034\]\((0034-[^)]+)\)/.exec(index);
  assert.ok(listed, 'docs/adr/README.md lists ADR 0034');
  assert.ok(existsSync(join(root, 'docs/adr', listed[1])), `${listed[1]} exists`);
  const adr = read(join('docs/adr', listed[1]));
  assert.match(adr, /^# 0034 - Approvals are followed to an outcome/);
  assert.match(adr, /\*\*Status:\*\* Accepted/);
  for (const word of ['reverted', 'changes_requested', 'survived', 'merged_other_head', 'pending', 'approval_window_days', 'approval_escape_warn', 'Wilson', '0004', '0026', '0029']) {
    assert.ok(adr.includes(word), `ADR 0034 names ${word}`);
  }
  assert.match(adr, /never `survived`/);

  const amended = read('docs/adr/0029-posted-findings-are-followed-to-an-outcome.md');
  assert.match(amended, /## Amendment - 2026-11-09 \(approvals\)/);
  assert.match(amended, /\[0034\]\(0034-approvals-are-followed-to-an-outcome\.md\)/);
  const row = index.split('\n').find((line) => line.includes('[0029]'));
  assert.match(row, /by 0034 \(approvals\)/);
  // The search route gains the revert source, so 0026 is amended too.
  assert.match(adr, /reverts:<owner>\/<repo>#<n>/);
  assert.match(index.split('\n').find((line) => line.includes('[0026]')), /by 0034 \(revert search\)/);
});

test('EVALUATION.md documents the approval escape rate, its basis, its bound and the window rule', () => {
  const doc = read('docs/EVALUATION.md');
  assert.match(doc, /#### Approval outcomes/);
  assert.match(doc, /approval_escape_rate = \(reverted \+ changes_requested\) \/ \(reverted \+ changes_requested \+ survived\)/);
  assert.match(doc, /`E escaped \/ N settled approvals; P pending, W weak excluded`/);
  assert.match(doc, /Wilson 95% upper bound/);
  assert.match(doc, /`pending`, never `survived`/);
  assert.match(doc, /`approval_breakdown`/);
  assert.match(doc, /reports `null`, never zero/);
  assert.match(doc, /\| Approval escape rate \|/);
  assert.match(doc, /`outcomes\.approval_escape_warn` \(default 0\.05\)/);
});

test('the watcher document, the example config and the help name the settings and the flag', () => {
  const watcher = read('docs/WATCHER.md');
  assert.match(watcher, /review-voice outcomes \[--approvals\]/);
  assert.match(watcher, /ADR\s+0034/);
  const example = read('plugins/review-voice/templates/config.example.yaml');
  assert.match(example, /^outcomes:\n/m);
  assert.match(example, /^  approval_window_days: 14$/m);
  assert.match(example, /^  approval_escape_warn: 0\.05$/m);
  assert.match(commandHelp('outcomes'), /--approvals/);
  assert.match(commandHelp('outcomes'), /approval_window_days/);
  assert.match(commandHelp('evaluate'), /approval outcomes by mode, complexity, independence and origin/);
});

test('the outcomes help says that with --approvals --since limits only which settled approvals are read again', () => {
  assert.match(
    commandHelp('outcomes'),
    /With --approvals, an approval\s+not yet settled is checked whatever its age, and --since limits only which\s+settled ones are read again/,
  );
});
