/**
 * S18 part B. Every published external benchmark run under docs/benchmarks/
 * holds the two raw outputs a person committed, and docs/EVALUATION.md states
 * exactly what they say. Every expected figure is computed from the two files,
 * so an edited figure in either place fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKnownLicence, REFUSAL_REASONS } from '../plugins/review-voice/src/evaluate/benchmark.ts';
import { AGREEMENT_LINE_TOLERANCE } from '../plugins/review-voice/src/evaluate/metrics.ts';
import { readRecallResults, tallyResults } from '../plugins/review-voice/src/evaluate/recall-results.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const benchmarks = join(root, 'docs/benchmarks');
const subdirectories = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const runs = existsSync(benchmarks)
  ? subdirectories(benchmarks).flatMap((set) => subdirectories(join(benchmarks, set)).flatMap((version) => subdirectories(join(benchmarks, set, version)).map((plugin) => [set, version, plugin])))
  : [];

const MANIFEST_KEYS = ['set', 'setVersion', 'setSha256', 'setLicence', 'licenceSource', 'importedWith', 'firstItems', 'items', 'refused', 'counts'];
const ITEM_KEYS = ['fixture', 'item', 'issue', 'repository', 'pullRequest', 'licence', 'licenceFrom', 'path', 'line', 'severity'];
const REFUSAL_KEYS = ['item', 'issue', 'reason'];
const COUNT_KEYS = ['items', 'issues', 'fixtures', 'refusedItems', 'refusedIssues'];
const sameKeys = (value, keys, label) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has other keys than the documented ones`);

const evaluation = readFileSync(join(root, 'docs/EVALUATION.md'), 'utf8');
/** The `## External benchmark` section, up to the next second-level heading. */
const section = (() => {
  const start = evaluation.indexOf('\n## External benchmark\n');
  if (start === -1) return null;
  const end = evaluation.indexOf('\n## ', start + 1);
  return evaluation.slice(start, end === -1 ? undefined : end);
})();

/** The rows under the table whose header row is `header`, as trimmed cells with code backticks removed; null when absent. */
function tableRows(text, header) {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  if (at === -1) return null;
  const rows = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.slice(1, -1).split('|').map((cell) => cell.trim().replaceAll('`', '')));
  }
  return rows;
}

const ratio = (value) => (value === null ? 'no data' : value.toFixed(2));
const failed = (fixture) => fixture.exitCode !== 0 || fixture.error !== undefined;

test('at least one published benchmark run exists', () => {
  assert.ok(runs.length > 0, 'no docs/benchmarks/<set>/<set-version>/<plugin-version>/ directory');
});

test('the External benchmark section states the match rule, the single-run caveat and the clean-set rule', () => {
  assert.ok(section !== null, 'docs/EVALUATION.md has no ## External benchmark section');
  assert.ok(evaluation.indexOf('\n## External benchmark\n') > evaluation.indexOf('\n## Fixture recall\n'), 'the section does not follow Fixture recall');
  for (const phrase of [`within ${AGREEMENT_LINE_TOLERANCE} lines`, 'is a sample', 'never tuned against']) {
    assert.ok(section.replace(/\s+/g, ' ').includes(phrase),`the section does not say "${phrase}"`);
  }
});

/** Each run as its path segments, its directory relative to the root and its absolute directory. */
const each = (check) => {
  for (const [set, setVersion, pluginVersion] of runs) {
    const rel = `docs/benchmarks/${set}/${setVersion}/${pluginVersion}`;
    check({ set, setVersion, pluginVersion, rel, dir: join(root, rel) });
  }
};

test('every published run holds two raw outputs that agree with each other and with their path', () =>
  each(({ set, setVersion, pluginVersion, rel, dir }) => {
    assert.ok(existsSync(join(dir, 'import.json')), 'no import.json');
    assert.ok(existsSync(join(dir, 'results.json')), 'no results.json');
    const results = readRecallResults(join(dir, 'results.json'));
    assert.equal(results.pluginVersion, pluginVersion);
    const manifest = JSON.parse(readFileSync(join(dir, 'import.json'), 'utf8'));
    assert.equal(manifest.set, set);
    assert.equal(manifest.setVersion, setVersion);

    sameKeys(manifest, MANIFEST_KEYS, 'the manifest');
    manifest.items.forEach((item, index) => sameKeys(item, ITEM_KEYS, `items[${index}]`));
    manifest.refused.forEach((refusal, index) => sameKeys(refusal, REFUSAL_KEYS, `refused[${index}]`));
    sameKeys(manifest.counts, COUNT_KEYS, 'counts');
    for (const refusal of manifest.refused) assert.ok(REFUSAL_REASONS.includes(refusal.reason), `unknown refusal reason ${refusal.reason}`);
    assert.ok(isKnownLicence(manifest.setLicence), `setLicence ${manifest.setLicence} is not a known licence`);
    for (const item of manifest.items) assert.ok(isKnownLicence(item.licence), `${item.fixture} has licence ${item.licence}`);

    const { counts } = manifest;
    assert.equal(counts.fixtures, manifest.items.length);
    assert.equal(counts.fixtures + counts.refusedIssues, counts.issues);
    assert.equal(counts.refusedItems, manifest.refused.filter((refusal) => refusal.issue === null).length);
    assert.equal(counts.refusedIssues, manifest.refused.filter((refusal) => refusal.issue !== null).length);
    // Every item considered either wrote a fixture or was refused, whole or by issue.
    assert.equal(counts.items, new Set([...manifest.items, ...manifest.refused].map((entry) => entry.item)).size);

    assert.deepEqual(results.fixtures.map((fixture) => fixture.name).sort(), manifest.items.map((item) => item.fixture).sort(), `the two files of ${rel} name different fixtures`);
  }));

test('docs/EVALUATION.md publishes every run as its two files give it', () =>
  each(({ set, setVersion, pluginVersion, rel, dir }) => {
    assert.ok(section !== null, 'docs/EVALUATION.md has no ## External benchmark section');
    const results = readRecallResults(join(dir, 'results.json'));
    const manifest = JSON.parse(readFileSync(join(dir, 'import.json'), 'utf8'));
    const heading = `### ${set}, version ${setVersion}, plugin ${pluginVersion}`;
    const start = section.indexOf(`\n${heading}\n`);
    assert.ok(start !== -1, `no heading "${heading}"`);
    const next = section.indexOf('\n### ', start + 1);
    const run = section.slice(start, next === -1 ? undefined : next);
    assert.ok(run.includes(`\`${rel}/\``), `the run does not name its directory ${rel}/`);
    // Prose wraps, so a phrase may break across a line.
    const prose = run.replace(/\s+/g, ' ');
    assert.ok(prose.includes(`runner \`${results.runner}\``) && prose.includes(`mode \`${results.mode}\``), 'the runner or the mode is not the one results.json records');

    const { summary } = results;
    const tally = tallyResults(results.fixtures);
    const figures = tableRows(run, '| Figure | Value | Basis |');
    assert.ok(figures !== null, 'no figures table');
    assert.deepEqual(figures.map(([name, value]) => [name, value]), [
      ['Key-bug recall', ratio(summary.keyBugRecall)],
      ['Causal-line hit', ratio(summary.causalLineHit)],
      ['Clean silence', ratio(summary.cleanSilence)],
      ['Failed runs', String(summary.failedRuns)],
    ]);
    assert.ok(figures[0][2].startsWith(`${tally.hits} of ${tally.completedPositives} `), `the key-bug recall basis is not ${tally.hits} of ${tally.completedPositives}`);
    assert.ok(figures[1][2].startsWith(`${tally.hits} of ${tally.onPath} `), `the causal-line hit basis is not ${tally.hits} of ${tally.onPath}`);
    if (tally.completedClean > 0) assert.ok(figures[2][2].startsWith(`${tally.silent} of ${tally.completedClean} `), 'the clean silence basis does not match');

    const refusals = REFUSAL_REASONS.map((reason) => [reason, String(manifest.refused.filter((refusal) => refusal.reason === reason).length)]).filter(([, count]) => count !== '0');
    const refusalRows = tableRows(run, '| Refusal | Count |');
    if (refusals.length === 0) {
      assert.ok(run.includes('Refusals: none.') && refusalRows === null, 'nothing was refused, so the run says Refusals: none. and has no refusals table');
    } else {
      assert.deepEqual(refusalRows, refusals);
    }

    const byName = new Map(results.fixtures.map((fixture) => [fixture.name, fixture]));
    const expected = manifest.items.map((item) => {
      const fixture = byName.get(item.fixture);
      const result = failed(fixture) ? 'failed' : fixture.hit === true ? 'hit' : 'miss';
      return [item.fixture, item.repository, item.licence, item.severity ?? '-', result, String(fixture.lineDelta ?? '-'), String(fixture.findings)];
    });
    assert.deepEqual(tableRows(run, '| Fixture | Repository | Licence | Severity | Result | Line delta | Findings |'), expected);
  }));
