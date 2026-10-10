import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeReach } from '../plugins/review-voice/src/scoring/reach.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// A scores file that lists every matching path reached megabytes. The cap is
// on what `record` stores as well as on what `score` prints, so a file from
// before the cap or one a caller assembled cannot put them in the run.

test('record stores reach path lists capped, with the full count beside them', () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-scores-data-'));
  try {
    const paths = Array.from({ length: 5_000 }, (_, i) => `pkg${i % 40}/use${i}.ts`);
    const scoresFile = join(data, 'scores.json');
    writeFileSync(scoresFile, JSON.stringify({ scores: [{ candidateId: 'c1', reach: { paths, countedPaths: paths, directoryCount: 40 } }] }));
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data };
    const run = (args, input) => execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env, input });

    run(['record', '--scores', scoresFile], 'No actionable findings.');
    const stored = JSON.parse(run(['explain', '--json']));
    const reach = stored.scores[0].reach;

    assert.equal(reach.paths.length, 20);
    assert.equal(reach.pathsTotal, 5_000, 'the full count is kept');
    assert.equal(reach.countedPaths.length, 20);
    assert.equal(reach.countedPathsTotal, 5_000);
    assert.equal(reach.directoryCount, 40);
    assert.ok(JSON.stringify(stored.scores).length < 4 * 1024);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// One import line, a name used across the repository. The spread of an
// imported name is the spread of its users, not of what this change risks.

const diffOf = (path, removed, added) =>
  ['diff --git a/' + path + ' b/' + path, '--- a/' + path, '+++ b/' + path, '@@ -1,3 +1,3 @@', ...removed.map((l) => '-' + l), ...added.map((l) => '+' + l), ' const unchanged = 1;', ''].join('\n');
const users = ['a/one.ts', 'b/two.ts', 'c/three.ts', 'd/four.ts'];
const search = (symbol) =>
  symbol === 'formatDateValue' || symbol === 'widget' ? ['src/widget.ts', ...users, 'lib/dates.ts'] : [];

test('a one-line import change is not scored at the spread of the imported name', () => {
  const diff = diffOf('src/widget.ts', ["import { oldHelperName } from './old';"], ["import { formatDateValue } from './dates';"]);
  const check = computeReach('The import changed.', 'src/widget.ts', '/repo', null, search, diff);
  assert.equal(check.reach, null, 'absent, so the category tier applies');
  assert.equal(check.inconclusive, false);
});

test('an import of a new name does not fall back to the module name either', () => {
  const diff = diffOf('src/widget.ts', ["import { a } from './old';"], ["import { brandNewName } from './dates';"]);
  const check = computeReach('The import changed.', 'src/widget.ts', '/repo', null, search, diff);
  assert.equal(check.reach, null);
});

test('a change that edits code beside an import is still measured', () => {
  const diff = diffOf(
    'src/widget.ts',
    ["import { oldHelperName } from './old';", 'const a = oldHelperName();'],
    ["import { formatDateValue } from './dates';", 'const a = formatDateValue();'],
  );
  const check = computeReach('The call changed.', 'src/widget.ts', '/repo', null, search, diff);
  assert.equal(check.reach, 'repository');
});

test('a re-export is not an import-only change', () => {
  const diff = diffOf('src/widget.ts', ["export { oldHelperName } from './old';"], ["export { formatDateValue } from './dates';"]);
  const check = computeReach('The export changed.', 'src/widget.ts', '/repo', null, search, diff);
  assert.equal(check.reach, 'repository');
});
