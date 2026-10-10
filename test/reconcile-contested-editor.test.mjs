/**
 * A contested impact is marked for the editor.
 *
 * When the second pass disputed how far a failure reaches and no tie-break
 * upheld the wider claim, scoring already holds the tier. The comment could
 * still state the wider impact in its prose, so the eligible entry carries
 * `impactDisputed` and the editor contract says to leave that impact out.
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

const candidate = (id, line, over = {}) => ({
  candidate_id: id,
  path: 'src/sync.ts',
  line,
  category: 'correctness',
  severity: 'minor',
  claim: id === 's1' ? 'The sync drops the last page of results.' : 'The cursor is never persisted between runs.',
  failure_mode: id === 's1' ? 'Every consumer of the export misses records.' : 'A restart re-reads everything.',
  evidence: [`src/sync.ts:${line} stops one page early.`],
  technical_confidence: 0.9,
  ...over,
});

test('score marks a disputed candidate for the editor, and only that one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-contested-'));
  try {
    writeFileSync(join(dir, 'verification.json'), JSON.stringify([
      { candidate_id: 's1', technical_confidence: 0.9 },
      { candidate_id: 's2', technical_confidence: 0.9 },
    ]));
    const r = spawnSync(process.execPath, [bundle, 'score', '--verification', join(dir, 'verification.json'), '--min-score', '0.3'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate('s1', 10, { impact_disputed: true }), candidate('s2', 20)] }),
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    const eligible = Object.fromEntries(JSON.parse(r.stdout).eligible.map((entry) => [entry.candidateId, entry]));
    assert.equal(eligible.s1.impactDisputed, true);
    assert.equal(eligible.s2.impactDisputed, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the editor contract and the review command say to leave a contested impact out', () => {
  const editor = readFileSync(join(plugin, 'agents/concise-editor.md'), 'utf8');
  assert.match(editor, /`impactDisputed: true`/);
  assert.match(editor, /leave out\s+any claim that it reaches other callers, consumers or data/);
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const stepFive = review.slice(review.indexOf('## Step 5'), review.indexOf('## Step 6'));
  assert.match(stepFive, /`impactDisputed`/);
});
