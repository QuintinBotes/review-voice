/**
 * S18 part A. `review-voice import-benchmark` over a synthetic set document in
 * the shape D2 recorded (test/fixtures-benchmark/): the fixtures it writes and
 * that the recall harness reads and builds, the licence rule, the nine refusal
 * codes, the manifest's keys and counts, the exit codes, and the proof that the
 * importer works offline. No model is called and nothing reaches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { BENCHMARK_SET, importBenchmark, isKnownLicence, readSet, REFUSAL_REASONS, SET_LICENCE_SOURCE } from '../plugins/review-voice/src/evaluate/benchmark.ts';
import { materializeFixture, normalisePatch } from '../plugins/review-voice/src/evaluate/fixtures.ts';
import { selectFixtures } from '../plugins/review-voice/src/evaluate/recall.ts';
import { pluginVersion } from '../plugins/review-voice/src/version.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const synthetic = join(root, 'test/fixtures-benchmark');
const setFile = join(synthetic, 'set.jsonl');
const diffsDir = join(synthetic, 'diffs');
const licencesFile = join(synthetic, 'licences.json');
const FLAGS = ['--set-version', 'v1.0', '--set-licence', 'MIT', '--licences', licencesFile, '--diffs', diffsDir];

const scratch = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rv-benchmark-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The command in this process over the synthetic set, as the person would run it. */
const run = (out, ...extra) => runInProcess(['import-benchmark', '--from', setFile, ...FLAGS, '--out', out, ...extra]);
const manifestOf = (out) => JSON.parse(readFileSync(join(out, 'import.json'), 'utf8'));
/** A git first on PATH that answers `git rev-parse` as `answer` says when its condition holds, and runs the real git otherwise. */
const shimGit = (t, answer) => {
  const bin = scratch(t);
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = rev-parse ]; then ${answer}; fi\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  t.after(() => {
    process.env.PATH = saved;
  });
};
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A benchmark item as `readSet` would give it, for the paths this set never takes (a set licence, a diff in the set). */
const diffText = readFileSync(join(diffsDir, 'widget-pull-7.patch'), 'utf8');
const item = (id, licence = null, extra = {}) => ({
  id,
  repository: `repo-${id}`,
  pullRequest: null,
  licence,
  diff: diffText,
  description: null,
  issues: [{ path: 'src/app.ts', line: 3, severity: null, note: null }],
  ...extra,
});
const importItems = (t, items, overrides = {}) => {
  const details = [];
  const manifest = importBenchmark({
    items,
    setVersion: 'v1',
    setSha256: 'ab',
    setLicence: 'MIT',
    licences: new Map(),
    diffs: null,
    first: null,
    out: join(scratch(t), 'out'),
    onRefusal: (detail) => details.push(detail),
    ...overrides,
  });
  return { manifest, details };
};

test('readSet maps the D2 shape and refuses a document that is not it, naming the field and item', () => {
  const items = readSet(readFileSync(setFile, 'utf8'));
  assert.equal(items.length, 7);
  const first = items[0];
  assert.equal(first.id, 'widget-pull-7', 'the id is the tail of the pull request reference');
  assert.equal(first.repository, 'Widget');
  assert.equal(first.pullRequest, 'https://example.com/example-benchmarks/Widget/pull/7');
  assert.equal(first.licence, null);
  assert.equal(first.diff, null);
  assert.equal(first.description, null);
  // The first issue's end_line is 5, so reading end_line instead of start_line would show here.
  assert.deepEqual(first.issues, [
    { path: 'src/app.ts', line: 3, severity: null, note: 'quantity-rule' },
    { path: 'src/app.ts', line: 8, severity: null, note: null },
  ]);
  assert.deepEqual(items[1].issues[0], { path: null, line: null, severity: null, note: null });
  assert.equal(items[6].id, 'widget-pull-7', 'the repeated reference gives the repeated id');

  const pull = 'https://example.com/o/Widget/pull/1';
  assert.throws(() => readSet('{"repo":"Widget","issues":[]}\n'), /item 0 \(line 1\): id is missing/);
  assert.throws(() => readSet(`\n{"pr_url_to_review":"${pull}","issues":[]}\n`), /item 0 \(line 2\): repository/);
  assert.throws(() => readSet(`{"repo":"Widget","pr_url_to_review":"${pull}","issues":"none"}\n`), /item 0 \(line 1\): issues/);
  assert.throws(() => readSet(`{"repo":"Widget","pr_url_to_review":"${pull}","issues":[]}\n{"repo":"Widget","pr_url_to_review":"https://example.com/o/Widget/1","issues":[]}\n`), /item 1 \(line 2\): id is missing/);
  assert.throws(() => readSet('not json\n'), /item 0 \(line 1\): not a JSON object/);
  assert.throws(() => readSet('[1]\n'), /item 0 \(line 1\): not a JSON object/);
});

test('an item with two located issues becomes two fixtures the recall harness selects exactly and builds', async (t) => {
  const dir = scratch(t);
  const out = join(dir, 'out');
  const result = await run(out);
  assert.equal(result.code, 0, result.stderr);
  const sha = sha256(setFile);
  const diff = readFileSync(join(diffsDir, 'widget-pull-7.patch'));
  // Its blank context line has lost its space, so a normalised copy would differ from the source.
  assert.notEqual(normalisePatch(diff.toString('utf8')), diff.toString('utf8'));
  for (const [n, line, note] of [[1, 3, '  note: "quantity-rule"'], [2, 8, null]]) {
    const fixture = join(out, 'positive', `widget-pull-7-${n}`);
    assert.ok(readFileSync(join(fixture, 'diff.patch')).equals(diff), 'the diff is copied byte for byte');
    assert.equal(readFileSync(join(fixture, 'pr-body.md'), 'utf8'), readFileSync(join(diffsDir, 'widget-pull-7.md'), 'utf8'));
    const expected = [
      `name: "widget-pull-7-${n}"`,
      `asserts: "Issue ${n} of benchmark item widget-pull-7"`,
      'source:',
      `  set: "${BENCHMARK_SET}"`,
      '  set_version: "v1.0"',
      `  set_sha256: "${sha}"`,
      '  set_licence: "MIT"',
      '  item: "widget-pull-7"',
      '  repository: "Widget"',
      '  pull_request: "https://example.com/example-benchmarks/Widget/pull/7"',
      '  licence: "MIT"',
      '  licence_from: "owner"',
      `  issue: ${n}`,
      ...(note === null ? [] : [note]),
      'expect:',
      '  min_findings: 1',
      '  path: "src/app.ts"',
      `  line: ${line}`,
      '',
    ].join('\n');
    assert.equal(readFileSync(join(fixture, 'case.yaml'), 'utf8'), expected);
    assert.deepEqual(readdirSync(fixture).sort(), ['case.yaml', 'diff.patch', 'pr-body.md'], 'no config.yaml and no context/');
  }
  assert.deepEqual(readdirSync(join(out, 'positive/gadget-pull-12-4')).sort(), ['case.yaml', 'diff.patch'], 'no description, no pr-body.md');

  const selected = selectFixtures({ fixtures: out, classes: ['positive'], only: null });
  assert.deepEqual(
    selected.map(({ expectation }) => [expectation.name, expectation.path, expectation.line, expectation.category, expectation.skip]),
    [
      ['gadget-pull-12-4', 'src/lib.ts', 39, null, null],
      ['gadget-pull-12-5', 'src/lib.ts', 10, null, null],
      ['gadget-pull-12-7', 'src/other.ts', 22, null, null],
      ['widget-pull-7-1', 'src/app.ts', 3, null, null],
      ['widget-pull-7-2', 'src/app.ts', 8, null, null],
    ],
  );
  for (const [index, fixture] of selected.entries()) {
    const built = materializeFixture(fixture.dir, join(dir, 'repos', String(index)));
    assert.match(built.head, /^[0-9a-f]{40}$/);
  }
});

test('licence: absent, empty, the non-licences and free text are unknown-licence, set and owner disagreeing is a conflict, the owner fills a gap', (t) => {
  const bad = [null, '', '  ', 'NOASSERTION', 'none', 'UNKNOWN', 'OTHER', 'UNLICENSED', 'some free text'];
  const items = [...bad.map((licence, index) => item(`bad-${index}`, licence)), item('agree', 'MIT'), item('conflict', 'MIT'), item('fromset', 'Apache-2.0'), item('fromowner')];
  const licences = new Map([['repo-agree', 'MIT'], ['repo-conflict', 'BSD-3-Clause'], ['repo-fromowner', ' MIT ']]);
  const { manifest, details } = importItems(t, items, { licences });
  assert.deepEqual(manifest.refused, [
    ...bad.map((_, index) => ({ item: `bad-${index}`, issue: null, reason: 'unknown-licence' })),
    { item: 'conflict', issue: null, reason: 'licence-conflict' },
  ]);
  assert.deepEqual(
    manifest.items.map((entry) => [entry.item, entry.licence, entry.licenceFrom]),
    [['agree', 'MIT', 'set'], ['fromset', 'Apache-2.0', 'set'], ['fromowner', 'MIT', 'owner']],
  );
  assert.ok(details.some((detail) => detail.startsWith('conflict: licence-conflict: ') && detail.includes('BSD-3-Clause')), 'the detail names both licences');

  for (const ok of ['MIT', ' Apache-2.0 ', 'Apache-2.0 OR MIT', '(MIT AND BSD-3-Clause)', 'GPL-2.0-only WITH Classpath-exception-2.0', 'LicenseRef-Custom+']) {
    assert.equal(isKnownLicence(ok), true, ok);
  }
  for (const no of ['', ' ', 'noassertion', 'None', 'MIT OR', '(MIT', 'MIT)', 'MIT or Apache-2.0', 'Apache 2.0', 'MIT OR NONE', 'MIT; see LICENSE']) {
    assert.equal(isKnownLicence(no), false, JSON.stringify(no));
  }
});

test('an unknown --set-licence exits 2 and writes nothing', async (t) => {
  const out = join(scratch(t), 'out');
  const result = await runInProcess(['import-benchmark', '--from', setFile, '--set-version', 'v1.0', '--set-licence', 'NOASSERTION', '--out', out]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--set-licence/);
  assert.equal(existsSync(out), false);
});

test('each refusal has its own case: code only in the manifest, detail on stderr, and accepted issues keep their numbers', async (t) => {
  const dir = scratch(t);
  const diffs = join(dir, 'diffs');
  cpSync(diffsDir, diffs, { recursive: true });
  // A link where the diff should be is no diff: the importer reads only a regular file.
  symlinkSync(join(diffs, 'widget-pull-7.patch'), join(diffs, 'widget-pull-9.patch'));
  const out = join(dir, 'out');
  const result = await runInProcess(['import-benchmark', '--from', setFile, '--set-version', 'v1.0', '--set-licence', 'MIT', '--licences', licencesFile, '--diffs', diffs, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const manifest = manifestOf(out);
  assert.deepEqual(manifest.refused, [
    { item: 'gadget-pull-12', issue: 1, reason: 'no-location' },
    { item: 'gadget-pull-12', issue: 2, reason: 'off-diff' },
    { item: 'gadget-pull-12', issue: 3, reason: 'unsafe-path' },
    { item: 'gadget-pull-12', issue: 6, reason: 'unsafe-path' },
    { item: 'gadget-pull-12', issue: 8, reason: 'off-diff' },
    { item: 'widget-pull-8', issue: null, reason: 'no-issue' },
    { item: 'widget-pull-9', issue: null, reason: 'no-diff' },
    { item: 'widget-pull-10', issue: null, reason: 'does-not-build' },
    { item: 'nolicence-pull-1', issue: null, reason: 'unknown-licence' },
    { item: 'widget-pull-7', issue: null, reason: 'bad-id' },
  ]);
  assert.deepEqual(
    manifest.items.map((entry) => [entry.fixture, entry.issue, entry.path, entry.line]),
    [
      ['positive/widget-pull-7-1', 1, 'src/app.ts', 3],
      ['positive/widget-pull-7-2', 2, 'src/app.ts', 8],
      ['positive/gadget-pull-12-4', 4, 'src/lib.ts', 39],
      ['positive/gadget-pull-12-5', 5, 'src/lib.ts', 10],
      ['positive/gadget-pull-12-7', 7, 'src/other.ts', 22],
    ],
    'issue 4 is still issue 4 after three refusals before it; 39 is three lines from the change and 40 is four; 22 is a pure deletion site and 26 is four lines from it',
  );
  assert.deepEqual(readdirSync(join(out, 'positive')).sort(), ['gadget-pull-12-4', 'gadget-pull-12-5', 'gadget-pull-12-7', 'widget-pull-7-1', 'widget-pull-7-2'], 'a refused item or issue writes no fixture');
  for (const reason of REFUSAL_REASONS) {
    if (reason === 'licence-conflict') continue;
    assert.match(result.stderr, new RegExp(`^[a-z0-9-]+: ${reason}: .+$`, 'm'), reason);
  }
  assert.match(result.stderr, /^widget-pull-9: no-diff: .*widget-pull-9\.patch/m, 'the no-diff detail names the file looked for');
  assert.match(result.stderr, /^gadget-pull-12-2: off-diff: /m);
  assert.doesNotMatch(JSON.stringify(manifest), /this is not a patch|does not apply|unrecognized/, 'no detail reaches the manifest');
});

test('a patch or body in --diffs the process cannot read refuses its item no-diff, and the import goes on and writes the manifest', { skip: process.getuid?.() === 0 && 'root reads a file of mode 000' }, async (t) => {
  const dir = scratch(t);
  for (const name of ['widget-pull-7.patch', 'widget-pull-7.md']) {
    const diffs = join(dir, `diffs-${name}`);
    cpSync(diffsDir, diffs, { recursive: true });
    chmodSync(join(diffs, name), 0o000);
    const out = join(dir, `out-${name}`);
    const result = await runInProcess(['import-benchmark', '--from', setFile, ...FLAGS.slice(0, 6), '--diffs', diffs, '--out', out]);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`^widget-pull-7: no-diff: .*${name.replace('.', '\\.')}`, 'm'), name);
    const manifest = manifestOf(out);
    assert.deepEqual(manifest.refused.filter((entry) => entry.item === 'widget-pull-7'), [{ item: 'widget-pull-7', issue: null, reason: 'no-diff' }, { item: 'widget-pull-7', issue: null, reason: 'bad-id' }], name);
    assert.deepEqual(manifest.items.map((entry) => entry.fixture), ['positive/gadget-pull-12-4', 'positive/gadget-pull-12-5', 'positive/gadget-pull-12-7'], `${name}: the later items are still imported`);
  }
});

test('a body in --diffs that is a link or a directory refuses its item no-diff, naming the file, rather than import it without its description', async (t) => {
  const dir = scratch(t);
  const cases = {
    link: (path) => symlinkSync(join(diffsDir, 'widget-pull-7.md'), path),
    dangling: (path) => symlinkSync(join(dir, 'nowhere.md'), path),
    directory: (path) => mkdirSync(path),
  };
  for (const [name, make] of Object.entries(cases)) {
    const diffs = join(dir, `diffs-${name}`);
    cpSync(diffsDir, diffs, { recursive: true });
    rmSync(join(diffs, 'widget-pull-7.md'));
    make(join(diffs, 'widget-pull-7.md'));
    const out = join(dir, `out-${name}`);
    const result = await runInProcess(['import-benchmark', '--from', setFile, ...FLAGS.slice(0, 6), '--diffs', diffs, '--out', out]);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /^widget-pull-7: no-diff: .*widget-pull-7\.md/m, name);
    const manifest = manifestOf(out);
    assert.deepEqual(manifest.refused.filter((entry) => entry.item === 'widget-pull-7'), [{ item: 'widget-pull-7', issue: null, reason: 'no-diff' }, { item: 'widget-pull-7', issue: null, reason: 'bad-id' }], name);
    assert.deepEqual(manifest.items.map((entry) => entry.fixture), ['positive/gadget-pull-12-4', 'positive/gadget-pull-12-5', 'positive/gadget-pull-12-7'], `${name}: the later items are still imported`);
  }
});

test('bad-id: an empty slug, a repeated slug, and an id, repository or reference over 200 characters or holding a line break, U+2028 and U+2029 included, or a control character', (t) => {
  const long = 'x'.repeat(201);
  const items = [
    item('!!!', 'MIT'),
    item('Same_Id', 'MIT'),
    item('same-id', 'MIT'),
    item(long, 'MIT'),
    item('repo', 'MIT', { repository: long }),
    item('pull', 'MIT', { pullRequest: 'https://example.com/a\nb' }),
    // JSON.stringify writes U+2028 and U+2029 raw, and recall would read the text after one as a top-level key of case.yaml.
    item('repo-ls', 'MIT', { repository: 'Widget\u2028harness: skip' }),
    item('pull-ps', 'MIT', { pullRequest: 'https://example.com/a\u2029harness: skip\u2029/Widget/pull/1' }),
    item('repo-esc', 'MIT', { repository: 'Widget\u001b[31m' }),
    item('id\u2028harness: skip', 'MIT'),
  ];
  const out = join(scratch(t), 'out');
  const { manifest, details } = importItems(t, items, { out });
  assert.deepEqual(manifest.refused, [
    { item: '!!!', issue: null, reason: 'bad-id' },
    { item: 'same-id', issue: null, reason: 'bad-id' },
    { item: 'x'.repeat(60), issue: null, reason: 'bad-id' },
    { item: 'repo', issue: null, reason: 'bad-id' },
    { item: 'pull', issue: null, reason: 'bad-id' },
    { item: 'repo-ls', issue: null, reason: 'bad-id' },
    { item: 'pull-ps', issue: null, reason: 'bad-id' },
    { item: 'repo-esc', issue: null, reason: 'bad-id' },
    { item: 'id-harness-skip', issue: null, reason: 'bad-id' },
  ]);
  assert.deepEqual(manifest.items.map((entry) => [entry.fixture, entry.item]), [['positive/same-id-1', 'Same_Id']], 'item is the set id, not its slug');
  assert.match(readFileSync(join(out, 'positive/same-id-1/case.yaml'), 'utf8'), /^ {2}item: "Same_Id"$/m);
  assert.deepEqual(manifest.counts, { items: 10, issues: 1, fixtures: 1, refusedItems: 9, refusedIssues: 0 });
  assert.doesNotMatch(details.join('\n'), /[\u001b\u2028\u2029]/u, 'no refused string reaches the detail');
});

test('a rule name holding a line terminator or control character is left out of case.yaml, so recall reads every imported fixture with no skip', (t) => {
  const out = join(scratch(t), 'out');
  const issue = (line, note) => ({ path: 'src/app.ts', line, severity: null, note });
  const notes = ['rule\u2028harness: skip\u2028harness_reason: PROSE FROM THE SET', 'rule\u2029harness: skip', 'rule\u001b[31m', 'x'.repeat(201), 'plain-rule'];
  const { manifest } = importItems(t, [item('noted', 'MIT', { issues: notes.map((note, index) => issue(index % 2 === 0 ? 3 : 8, note)) })], { out });
  assert.equal(manifest.counts.fixtures, notes.length);
  const yaml = (n) => readFileSync(join(out, 'positive', `noted-${n}`, 'case.yaml'), 'utf8');
  for (const n of [1, 2, 3, 4]) assert.doesNotMatch(yaml(n), /note:|harness|[\u001b\u2028\u2029]/u, `issue ${n}`);
  assert.match(yaml(5), /^ {2}note: "plain-rule"$/m, 'an identifier is kept');
  const selected = selectFixtures({ fixtures: out, classes: ['positive'], only: null });
  assert.deepEqual(
    selected.map(({ expectation }) => [expectation.name, expectation.skip]),
    [1, 2, 3, 4, 5].map((n) => [`noted-${n}`, null]),
  );
});

test('import.json has exactly the documented keys, the counts hold, the hash and version are recorded, and --first cuts the set first', async (t) => {
  const dir = scratch(t);
  const out = join(dir, 'out');
  const result = await run(out);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /5 fixture\(s\) from 7 item\(s\)/);
  const manifest = manifestOf(out);
  assert.deepEqual(Object.keys(manifest), ['set', 'setVersion', 'setSha256', 'setLicence', 'licenceSource', 'importedWith', 'firstItems', 'items', 'refused', 'counts']);
  for (const entry of manifest.items) {
    assert.deepEqual(Object.keys(entry), ['fixture', 'item', 'issue', 'repository', 'pullRequest', 'licence', 'licenceFrom', 'path', 'line', 'severity']);
    assert.equal(entry.severity, null, 'the set carries no severity');
  }
  for (const entry of manifest.refused) assert.deepEqual(Object.keys(entry), ['item', 'issue', 'reason']);
  assert.deepEqual(manifest.counts, { items: 7, issues: 10, fixtures: 5, refusedItems: 5, refusedIssues: 5 });
  assert.equal(manifest.counts.fixtures + manifest.counts.refusedIssues, manifest.counts.issues);
  assert.equal(manifest.counts.fixtures, manifest.items.length);
  assert.equal(manifest.counts.refusedItems, manifest.refused.filter((entry) => entry.issue === null).length);
  assert.equal(manifest.counts.refusedIssues, manifest.refused.filter((entry) => entry.issue !== null).length);
  assert.equal(manifest.set, 'qodo-pr-review-bench');
  assert.equal(manifest.setVersion, 'v1.0');
  assert.equal(manifest.setSha256, sha256(setFile));
  assert.equal(manifest.setLicence, 'MIT');
  assert.equal(manifest.licenceSource, SET_LICENCE_SOURCE);
  assert.equal(manifest.licenceSource, 'dataset card');
  assert.equal(manifest.importedWith, pluginVersion());
  assert.equal(manifest.firstItems, null);
  assert.deepEqual(manifest.items[0], {
    fixture: 'positive/widget-pull-7-1',
    item: 'widget-pull-7',
    issue: 1,
    repository: 'Widget',
    pullRequest: 'https://example.com/example-benchmarks/Widget/pull/7',
    licence: 'MIT',
    licenceFrom: 'owner',
    path: 'src/app.ts',
    line: 3,
    severity: null,
  });

  const first = join(dir, 'first');
  const cut = await run(first, '--first', '1');
  assert.equal(cut.code, 0, cut.stderr);
  const cutManifest = manifestOf(first);
  assert.equal(cutManifest.firstItems, 1);
  assert.deepEqual(cutManifest.counts, { items: 1, issues: 2, fixtures: 2, refusedItems: 0, refusedIssues: 0 });
  assert.deepEqual(readdirSync(join(first, 'positive')).sort(), ['widget-pull-7-1', 'widget-pull-7-2']);
  // The third item is refused no-issue; a cut taken after the checks would go on to the later items.
  const three = join(dir, 'three');
  const cutThree = await run(three, '--first', '3');
  assert.equal(cutThree.code, 0, cutThree.stderr);
  const threeManifest = manifestOf(three);
  assert.equal(threeManifest.firstItems, 3);
  assert.deepEqual(threeManifest.counts, { items: 3, issues: 10, fixtures: 5, refusedItems: 1, refusedIssues: 5 });
  assert.deepEqual([...new Set(threeManifest.refused.map((entry) => entry.item))], ['gadget-pull-12', 'widget-pull-8'], 'nothing after the third item is considered');

  const severity = importItems(t, [item('sev', 'MIT', { issues: [{ path: 'src/app.ts', line: 3, severity: 'high', note: null }, { path: 'src/app.ts', line: 3, severity: 'a\nb', note: null }, { path: 'src/app.ts', line: 3, severity: 'x'.repeat(201), note: null }] })]);
  assert.deepEqual(severity.manifest.items.map((entry) => entry.severity), ['high', null, null], 'a severity label with a line break or over 200 characters is null');
});

test('exit 1 when every item is refused, with the manifest written; exit 2 for each bad invocation, with nothing written', async (t) => {
  const dir = scratch(t);
  const rows = readFileSync(setFile, 'utf8').split('\n').filter((line) => line !== '');
  const refusedOnly = join(dir, 'refused.jsonl');
  writeFileSync(refusedOnly, `${rows[2]}\n`);
  const allRefused = join(dir, 'all-refused');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo], { env: gitEnv });
  // A git hook exports GIT_DIR; the importer must drop it or every --out outside the repository would be refused as inside it.
  const savedGitDir = process.env.GIT_DIR;
  t.after(() => {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
  });
  process.env.GIT_DIR = join(repo, '.git');
  const result = await runInProcess(['import-benchmark', '--from', refusedOnly, ...FLAGS, '--out', allRefused]);
  assert.equal(result.code, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /inside a git working tree/, 'the exported GIT_DIR did not answer for an --out outside the repository');
  assert.deepEqual(readdirSync(allRefused), ['import.json']);
  assert.deepEqual(manifestOf(allRefused).counts, { items: 1, issues: 0, fixtures: 0, refusedItems: 1, refusedIssues: 0 });

  const noId = join(dir, 'no-id.jsonl');
  writeFileSync(noId, `${rows[0]}\n{"repo":"Widget","issues":[]}\n`);
  const notEmpty = join(dir, 'not-empty');
  mkdirSync(notEmpty);
  writeFileSync(join(notEmpty, 'keep.txt'), 'keep\n');
  const licencesNumber = join(dir, 'licences-number.json');
  writeFileSync(licencesNumber, '{"Widget": 1}\n');
  const licencesList = join(dir, 'licences-list.json');
  writeFileSync(licencesList, '["MIT"]\n');
  // A repository git refuses to read is still a repository, so the guard fails closed rather than importing into it.
  const unreadable = join(dir, 'unreadable');
  mkdirSync(unreadable);
  execFileSync('git', ['init', '-q', unreadable], { env: gitEnv });
  execFileSync('git', ['-C', unreadable, 'config', 'core.repositoryformatversion', '99'], { env: gitEnv });
  // Every existence check follows a link, so a dangling one at --out or above it looks like a path still to be made.
  const dangling = join(dir, 'dangling');
  symlinkSync(join(dir, 'nowhere'), dangling);
  const unlisted = join(dir, 'unlisted');
  mkdirSync(unlisted, 0o000);
  // A gitfile git cannot follow (a worktree whose main repository moved) says "not a git repository: <gitdir>", which is no answer.
  const brokenWorktree = join(dir, 'broken-worktree');
  mkdirSync(brokenWorktree);
  writeFileSync(join(brokenWorktree, '.git'), `gitdir: ${join(dir, 'moved', '.git', 'worktrees', 'x')}\n`);
  const bad = [
    ['missing --from', ['import-benchmark', ...FLAGS, '--out', join(dir, 'a')], /--from/],
    ['missing --set-version', ['import-benchmark', '--from', setFile, '--set-licence', 'MIT', '--out', join(dir, 'b')], /--set-version/],
    ['missing --set-licence', ['import-benchmark', '--from', setFile, '--set-version', 'v1', '--out', join(dir, 'c')], /--set-licence/],
    ['missing --out', ['import-benchmark', '--from', setFile, '--set-version', 'v1', '--set-licence', 'MIT'], /--out/],
    ['a flag without a value', ['import-benchmark', '--from', setFile, '--set-version', 'v1', '--set-licence', 'MIT', '--out'], /--out needs a value/],
    ['an unknown flag', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(dir, 'd'), '--bogus'], /Unexpected argument --bogus/],
    ['a bad --set-version', ['import-benchmark', '--from', setFile, '--set-version', 'v1/0', '--set-licence', 'MIT', '--out', join(dir, 'e')], /--set-version/],
    ['a --set-version over 64 characters', ['import-benchmark', '--from', setFile, '--set-version', 'v'.repeat(65), '--set-licence', 'MIT', '--out', join(dir, 'f')], /--set-version/],
    ['a malformed document', ['import-benchmark', '--from', noId, ...FLAGS, '--out', join(dir, 'g')], /item 1 \(line 2\): id is missing/],
    ['an unreadable --from', ['import-benchmark', '--from', join(dir, 'absent.jsonl'), ...FLAGS, '--out', join(dir, 'h')], /--from .*absent\.jsonl/],
    ['an unreadable --licences', ['import-benchmark', '--from', setFile, '--set-version', 'v1', '--set-licence', 'MIT', '--licences', join(dir, 'absent.json'), '--out', join(dir, 'i')], /--licences/],
    ['a --licences that is not JSON', ['import-benchmark', '--from', setFile, '--set-version', 'v1', '--set-licence', 'MIT', '--licences', noId, '--out', join(dir, 'j')], /--licences/],
    ['a --licences value that is not a string', ['import-benchmark', '--from', setFile, ...FLAGS.slice(0, 4), '--licences', licencesNumber, '--out', join(dir, 'j2')], /must be a JSON object from repository to SPDX id/],
    ['a --licences that is a list', ['import-benchmark', '--from', setFile, ...FLAGS.slice(0, 4), '--licences', licencesList, '--out', join(dir, 'j3')], /must be a JSON object from repository to SPDX id/],
    ['a --diffs that is not a directory', ['import-benchmark', '--from', setFile, '--set-version', 'v1', '--set-licence', 'MIT', '--diffs', setFile, '--out', join(dir, 'k')], /--diffs/],
    ['a --first that is not a positive whole number', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(dir, 'l'), '--first', '0'], /--first/],
    ['an --out that is not empty', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', notEmpty], /not an empty directory/],
    ['an --out that is a file', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', setFile], /not an empty directory/],
    ['an --out under a file', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(setFile, 'sub')], /not an empty directory \(.*set\.jsonl is a file\)/],
    ['an --out inside a repository git cannot read', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(unreadable, 'out')], /git could not say whether it is inside a working tree \(fatal: .*version/],
    ['an --out inside a worktree whose gitdir git cannot find', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(brokenWorktree, 'out')], /git could not say whether it is inside a working tree \(fatal: not a git repository: /],
    ['an --out inside a git working tree', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(repo, 'nested', 'out')], /inside a git working tree.*CONTRIBUTING\.md rule 1/],
    ['an --out inside a git directory', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(repo, '.git', 'out')], /inside a git working tree/],
    ['an --out that is a dangling link', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', dangling], /--out .*dangling is a symbolic link/],
    ['an --out under a dangling link', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', join(dangling, 'sub')], /--out .*dangling\/sub cannot be created/],
    // Root lists a directory of mode 000.
    ...(process.getuid?.() === 0 ? [] : [['an --out the process cannot list', ['import-benchmark', '--from', setFile, ...FLAGS, '--out', unlisted], /--out .*unlisted cannot be listed/]]),
  ];
  try {
    for (const [name, argv, message] of bad) {
      const refused = await runInProcess(argv);
      assert.equal(refused.code, 2, `${name}: exit ${refused.code}, stderr ${refused.stderr}`);
      assert.match(refused.stderr, message, name);
    }
  } finally {
    chmodSync(unlisted, 0o755);
  }
  assert.deepEqual(readdirSync(dir).sort(), ['all-refused', 'broken-worktree', 'dangling', 'licences-list.json', 'licences-number.json', 'no-id.jsonl', 'not-empty', 'refused.jsonl', 'repo', 'unlisted', 'unreadable'], 'no refused invocation created its --out');
  assert.deepEqual(readdirSync(unlisted), []);
  assert.equal(existsSync(join(dir, 'nowhere')), false, 'nothing was made through the link');
  assert.deepEqual(readdirSync(notEmpty), ['keep.txt']);
  assert.equal(existsSync(join(repo, 'nested')), false);
  assert.equal(existsSync(join(unreadable, 'out')), false);
  assert.deepEqual(readdirSync(brokenWorktree), ['.git']);
});

test('an --out on a volume mounted inside a working tree is refused: git looks past the mount point', async (t) => {
  const dir = scratch(t);
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  mkdirSync(join(repo, 'mnt'));
  // A test cannot mount a volume, so the shim gives what git prints at a mount point (setup.c) unless told to cross it.
  shimGit(t, `[ "$GIT_DISCOVERY_ACROSS_FILESYSTEM" = 1 ] || { printf 'fatal: not a git repository (or any parent up to mount point %s)\\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\\n' "$PWD" >&2; exit 128; }`);
  const out = join(repo, 'mnt', 'out');
  const result = await run(out);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /inside a git working tree/);
  assert.equal(existsSync(out), false);
});

test('an --out outside any repository is accepted under a translated git: the check reads git in the C locale', async (t) => {
  // gettext answers in the operator language unless LC_ALL is C, as a git with translations installed does.
  shimGit(t, '[ "$LC_ALL" = C ] || { echo "fatal: Kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git" >&2; exit 128; }');
  const out = join(scratch(t), 'out');
  const result = await run(out);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(out, 'import.json')));
});

test('the importer is offline: no network import, no fetch call, a throwing fetch changes nothing, and nothing is written outside --out', async (t) => {
  const source = readFileSync(join(root, 'plugins/review-voice/src/evaluate/benchmark.ts'), 'utf8');
  const imports = source.split('\n').filter((line) => /^import\b/.test(line) || /^\} from\s+['"]/.test(line));
  assert.ok(imports.length > 0, 'the import lines were found');
  for (const line of imports) assert.doesNotMatch(line, /node:(?:http|https|net)\b|\.\.\/github\//, line);
  assert.doesNotMatch(source, /\bfetch\(/);

  const dir = scratch(t);
  const out = join(dir, 'out');
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  // The inputs are copied in, so a file left beside --from, --licences or in --diffs shows in the listing.
  const input = join(dir, 'input');
  cpSync(synthetic, input, { recursive: true });
  const listing = () => readdirSync(input, { recursive: true }).sort();
  const before = listing();
  const savedFetch = globalThis.fetch;
  const savedTmp = process.env.TMPDIR;
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });
  globalThis.fetch = () => {
    throw new Error('the importer must not reach the network');
  };
  // os.tmpdir() reads TMPDIR on each call, so every temporary directory the import makes lands here.
  process.env.TMPDIR = tmp;
  const result = await runInProcess(['import-benchmark', '--from', join(input, 'set.jsonl'), ...FLAGS.slice(0, 4), '--licences', join(input, 'licences.json'), '--diffs', join(input, 'diffs'), '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^5 fixture\(s\)/, 'the copied inputs gave the same import');
  assert.deepEqual(readdirSync(tmp), [], 'the temporary directories are removed');
  assert.deepEqual(readdirSync(dir).sort(), ['input', 'out', 'tmp'], 'nothing is written beside --out');
  assert.deepEqual(listing(), before, 'nothing is written beside --from or --licences, or in --diffs');
  assert.deepEqual(readdirSync(out).sort(), ['import.json', 'positive']);
});

test('help documents import-benchmark in the recall entry shape, the command list names it, and fixtures/README.md states the rule', async () => {
  const help = await runInProcess(['help', 'import-benchmark']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^review-voice import-benchmark --from <file> --set-version <version> --set-licence <spdx> --out <dir>/);
  for (const flag of ['--from', '--set-version', '--set-licence', '--out', '--licences', '--diffs', '--first']) assert.ok(help.stdout.includes(flag), flag);
  for (const heading of ['\nFlags:\n', '\nReads: ', '\nWrites: ', '\nExit codes: ']) assert.ok(help.stdout.includes(heading), JSON.stringify(heading));
  const top = await runInProcess(['--help']);
  assert.match(top.stdout, /^ {2}import-benchmark\s/m);
  const readme = readFileSync(join(root, 'fixtures/README.md'), 'utf8');
  assert.match(readme, /import-benchmark/);
  assert.match(readme, /never\s+placed under `fixtures\/`/);
});
