/**
 * The reading guide (docs/adr/0028, S24): `record --files` keeps the manifest's
 * structural signals as per-file counts, `explain` prints one line about them,
 * and `verdict.reading_guide` renders a deterministic, collapsed guide from the
 * recorded run alone, before the scope block and after the idempotency key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { describeStructure, recordedStructure, recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { readingGuide, replaceAnnotations, safeCheckName, scopeBlock } from '../plugins/review-voice/src/publish/verdict.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const HEAD = 'a1b2c3d' + 'e'.repeat(33);
const REPO = 'acme/web';
const PR = 7;
const CLEAN = 'No actionable findings.';
const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const SCORES = [{ candidateId: 'cart', path: 'src/cart.ts', line: 12, severity: { severity: 'minor' }, confidenceSource: 'verifier', eligible: true }];
const PROVENANCE = { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' };
const CAPTION = 'Changed files by structural signal, most first. Lexical leads the CLI measured, not findings.';
const OPEN = ['<details><summary>Reading guide</summary>', '', CAPTION, ''];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const check = (name, conclusion) => ({ id: 1, name, status: 'completed', conclusion, completed_at: '2026-11-01T10:00:00Z' });
const GREEN = [check('build', 'success')];
const RED = [check('build', 'failure')];

/** A manifest `structure` as `diff --out` writes it: one deleted file, one path with two marker kinds, one crossing. */
const STRUCTURE = {
  sizeCrossings: [{ path: 'src/api/routes.ts', baseLines: 990, headLines: 1042, threshold: 1000, line: 1001 }],
  branchGrowth: [
    { path: 'src/api/routes.ts', function: 'export function route(', addedDecisionPoints: 3, threshold: 3, line: 40 },
    { path: 'src/api/routes.ts', function: 'function parse(', addedDecisionPoints: 4, threshold: 3, line: 90 },
  ],
  typeEscapes: [1, 2, 3].map((line) => ({ path: 'src/db/query.ts', line, kind: 'any' })),
  removedControls: [
    { path: 'src/auth/session.ts', line: 1, kind: 'guard', text: 'if (!session) return;', deletedFile: true },
    { path: 'src/auth/session.ts', line: 1, kind: 'refusal', text: 'throw new Forbidden();', deletedFile: true },
  ],
  riskMarkers: [
    { path: 'src/db/query.ts', line: 7, kind: 'unsafe' },
    { path: 'src/db/query.ts', line: 9, kind: 'string-built-query' },
    { path: 'src/db/query.ts', line: 11, kind: 'unsafe' },
  ],
  unmeasured: { count: 1, paths: ['src/gen/big.ts'] },
};
const RECORDED = {
  files: [
    { path: 'src/api/routes.ts', deletedFile: false, removedControls: {}, riskMarkers: {}, sizeCrossing: { headLines: 1042, threshold: 1000 }, branchGrowth: 2, typeEscapes: 0 },
    { path: 'src/auth/session.ts', deletedFile: true, removedControls: { guard: 1, refusal: 1 }, riskMarkers: {}, sizeCrossing: null, branchGrowth: 0, typeEscapes: 0 },
    { path: 'src/db/query.ts', deletedFile: false, removedControls: {}, riskMarkers: { unsafe: 2, 'string-built-query': 1 }, sizeCrossing: null, branchGrowth: 0, typeEscapes: 3 },
  ],
  unmeasured: 1,
};
const signals = (path, extra = {}) => ({ path, deletedFile: false, removedControls: {}, riskMarkers: {}, sizeCrossing: null, branchGrowth: 0, typeEscapes: 0, ...extra });
const run = (structure) => ({ structure });

// ---- recording, through the bundle ----------------------------------------------

function scratchRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rv-guide-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  writeFileSync(join(base, 'diff.patch'), 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # scratch\n+more\n');
  return { base, repo, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function cli(scratch, args, input = '') {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    cwd: scratch.repo,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.dataDir },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function recordWith(scratch, name, manifest) {
  const files = join(scratch.base, name);
  writeFileSync(files, JSON.stringify(manifest));
  const recorded = cli(scratch, ['record', '--repository', REPO, '--head', HEAD, '--diff-file', join(scratch.base, 'diff.patch'), '--files', files], CLEAN);
  assert.equal(recorded.code, 0, recorded.stderr);
  return { runId: JSON.parse(recorded.stdout).reviewRunId, stderr: recorded.stderr };
}

test('AC-5: record --files aggregates the structure into per-file counts that runDetail and explain return', () => {
  const scratch = scratchRepo();
  try {
    const manifest = { files: [{ path: 'README.md' }], pullNumber: PR, repository: REPO };
    const kept = recordWith(scratch, 'files.json', { ...manifest, structure: STRUCTURE });
    const absent = recordWith(scratch, 'plain.json', manifest);
    const malformed = recordWith(scratch, 'broken.json', { ...manifest, structure: { sizeCrossings: 'none' } });
    assert.doesNotMatch(kept.stderr, /structure/);
    assert.doesNotMatch(absent.stderr, /structure/);
    assert.match(malformed.stderr, /^The structure signals in .*broken\.json are malformed; recording without them\.$/m);

    const db = openDatabase(join(scratch.dataDir, 'review-voice.db'));
    try {
      assert.deepEqual(runDetail(db, kept.runId).structure, RECORDED);
      assert.equal(runDetail(db, absent.runId).structure, null);
      assert.equal(runDetail(db, malformed.runId).structure, null);
      // Source text never reaches the store: the removed lines are in the manifest only.
      assert.equal(JSON.stringify(runDetail(db, kept.runId)).includes('if (!session)'), false);
      // A row recorded by the API without a structure reads the same as an older row.
      const older = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, diff: 'diff', output: CLEAN }).reviewRunId;
      assert.equal(runDetail(db, older).structure, null);
    } finally {
      db.close();
    }
    assert.match(cli(scratch, ['explain', '--run', kept.runId]).stdout, /^Structure 3 files with a signal, 1 unmeasured$/m);
    assert.match(cli(scratch, ['explain', '--run', absent.runId]).stdout, /^Structure not recorded$/m);
    assert.equal(describeStructure({ files: [signals('a.ts')], unmeasured: 0 }), 'Structure 1 file with a signal, 0 unmeasured');
  } finally {
    scratch.cleanup();
  }
});

test('AC-5: recordedStructure accepts only an object with the five lists, and a deleted file is one whose every entry says so', () => {
  assert.deepEqual(recordedStructure(STRUCTURE), RECORDED);
  for (const bad of [null, 'structure', [], {}, { ...STRUCTURE, riskMarkers: undefined }, { ...STRUCTURE, unmeasured: 1, typeEscapes: {} }]) {
    assert.equal(recordedStructure(bad), null, JSON.stringify(bad));
  }
  const none = { sizeCrossings: [], branchGrowth: [], typeEscapes: [], removedControls: [], riskMarkers: [], unmeasured: { count: 0, paths: [] } };
  assert.deepEqual(recordedStructure(none), { files: [], unmeasured: 0 });
  // One control from a deleted file and one marker on a surviving line is not a deleted file.
  const mixed = recordedStructure({
    ...none, removedControls: [{ path: 'src/a.ts', line: 1, kind: 'guard', text: 'x', deletedFile: true }], riskMarkers: [{ path: 'src/a.ts', line: 2, kind: 'unsafe' }],
  });
  assert.deepEqual(mixed.files, [signals('src/a.ts', { removedControls: { guard: 1 }, riskMarkers: { unsafe: 1 } })]);
  // The first crossing per path counts; a second is ignored, not summed.
  const twice = recordedStructure({ ...none, sizeCrossings: [{ path: 'src/a.ts', headLines: 1001, threshold: 1000 }, { path: 'src/a.ts', headLines: 2001, threshold: 2000 }] });
  assert.deepEqual(twice.files, [signals('src/a.ts', { sizeCrossing: { headLines: 1001, threshold: 1000 } })]);
  // An entry outside the tables, a prototype name among them, or a crossing
  // without integers, lists no path and takes nothing from the entries that count.
  const rejected = recordedStructure({
    ...none,
    removedControls: [{ path: 'src/b.ts', line: 1, kind: 'constructor', text: 'x' }, { path: 'src/a.ts', line: 1, kind: 'guard', text: 'x' }],
    riskMarkers: [{ path: 'src/c.ts', line: 2, kind: 'bogus' }, { path: 'src/a.ts', line: 2, kind: 'toString' }],
    sizeCrossings: [{ path: 'src/d.ts', headLines: 1.5, threshold: 1000 }],
  });
  assert.deepEqual(rejected.files, [signals('src/a.ts', { removedControls: { guard: 1 } })]);
});

// ---- rendering --------------------------------------------------------------------

test('AC-6: five files render in the specified shape and order', () => {
  const structure = {
    files: [
      signals('src/a.ts', { typeEscapes: 1 }),
      signals('src/api/routes.ts', { sizeCrossing: { headLines: 1042, threshold: 1000 }, branchGrowth: 2 }),
      signals('src/auth/session.ts', { deletedFile: true, removedControls: { guard: 1, refusal: 1 } }),
      signals('src/db/query.ts', { riskMarkers: { 'string-built-query': 1 }, typeEscapes: 3 }),
      signals('src/net/handlers.ts', { riskMarkers: { unsafe: 2, 'new-route': 1 } }),
    ],
    unmeasured: 0,
  };
  const expected = [
    ...OPEN,
    '1. `src/auth/session.ts` (deleted file): 2 removed controls (guard, refusal)',
    '2. `src/net/handlers.ts`: 3 risk markers (new-route, unsafe)',
    '3. `src/db/query.ts`: 1 risk marker (string-built-query); 3 type escapes',
    '4. `src/api/routes.ts`: crossed 1000 lines (now 1042); 2 functions grew past the branch threshold',
    '5. `src/a.ts`: 1 type escape',
    '',
    '</details>',
  ].join('\n');
  assert.equal(readingGuide(run(structure)), expected);
  assert.equal(readingGuide(run(structure)), expected);
  assert.equal(readingGuide(run({ ...structure, files: [...structure.files].reverse() })), expected, 'the stored order does not matter');
});

test('AC-6: each later sort key decides a pair that ties on the earlier ones, against the path order', () => {
  const structure = {
    files: [
      signals('src/a.ts', { removedControls: { guard: 1 } }),
      signals('src/b.ts', { branchGrowth: 1 }),
      signals('src/d.ts', { typeEscapes: 1 }),
      signals('src/w.ts', { typeEscapes: 3 }),
      signals('src/x.ts', { sizeCrossing: { headLines: 1001, threshold: 1000 } }),
      signals('src/y.ts', { branchGrowth: 3 }),
      signals('src/z.ts', { removedControls: { guard: 2 } }),
    ],
    unmeasured: 0,
  };
  const expected = [
    ...OPEN,
    '1. `src/z.ts`: 2 removed controls (guard)',
    '2. `src/a.ts`: 1 removed control (guard)',
    '3. `src/x.ts`: crossed 1000 lines (now 1001)',
    '4. `src/y.ts`: 3 functions grew past the branch threshold',
    '5. `src/b.ts`: 1 function grew past the branch threshold',
    '6. `src/w.ts`: 3 type escapes',
    '7. `src/d.ts`: 1 type escape',
    '',
    '</details>',
  ].join('\n');
  assert.equal(readingGuide(run(structure)), expected);
});

test('AC-6: twenty files are listed, the rest counted, and the unmeasured line follows', () => {
  const files = Array.from({ length: 25 }, (_, index) => signals(`src/f${String(index + 1).padStart(2, '0')}.ts`, { typeEscapes: 1 }));
  const body = readingGuide(run({ files: [...files].reverse(), unmeasured: 2 }));
  const lines = body.split('\n');
  assert.deepEqual(lines.slice(0, 4), OPEN);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(lines[4 + index], `${index + 1}. \`src/f${String(index + 1).padStart(2, '0')}.ts\`: 1 type escape`);
  }
  assert.deepEqual(lines.slice(24), ['and 5 more files with a signal.', '2 production files could not be measured.', '', '</details>']);
  assert.ok(!body.includes('f21.ts') && !body.includes('f25.ts'));
});

test('AC-6: a missing or empty structure says so, and never reads as zero', () => {
  assert.equal(readingGuide(run(null)), [...OPEN, 'Structure not recorded.', '', '</details>'].join('\n'));
  assert.equal(readingGuide(run({ files: [], unmeasured: 0 })), [...OPEN, 'No structural signal in this change.', '', '</details>'].join('\n'));
  assert.equal(
    readingGuide(run({ files: [], unmeasured: 1 })),
    [...OPEN, 'No structural signal in this change.', '1 production file could not be measured.', '', '</details>'].join('\n'),
  );
});

test('AC-6: a hostile path renders as text inside a code span and a long one is cut at 60 code points', () => {
  const hostile = 'src/`x`‮</details>.ts';
  const long = 'src/' + 'w'.repeat(55) + '\u{1f600}' + 'z'.repeat(10) + '.ts';
  assert.equal([...long].length, 73);
  // Branch growth orders before type escapes, so the long path is listed first.
  const body = readingGuide(run({ files: [signals(hostile, { typeEscapes: 1 }), signals(long, { branchGrowth: 1 })], unmeasured: 0 }));
  assert.ok(body.includes('2. `' + safeCheckName(hostile) + '`: 1 type escape'), body);
  assert.equal(safeCheckName(hostile), 'src/x</details>.ts');
  assert.doesNotMatch(body, /[‮]/);
  assert.equal(body.includes('`x`'), false);
  assert.deepEqual(body.split('\n').filter((line) => line === '</details>'), ['</details>']);
  const cut = safeCheckName(long);
  assert.equal([...cut].length, 60);
  assert.ok(cut.endsWith('…'));
  assert.ok(body.includes('1. `' + cut + '`: 1 function grew past the branch threshold'), body);
  assert.equal(body.includes(long), false);
  assert.ok(body.isWellFormed());
});

test('AC-6: a stored kind outside its table reads as not recorded, so the guide never prints it', (t) => {
  const db = fixture(t);
  const kind = '</details>\n<img src=x onerror=alert(1)>';
  const stored = (riskMarkers) =>
    runDetail(db, recordRun(db, {
      repository: REPO, baseRef: null, headRef: HEAD, diff: 'diff', output: CLEAN, provenance: PROVENANCE,
      structure: { files: [signals('src/a.ts', { riskMarkers })], unmeasured: 0 },
    }).reviewRunId);
  const hostile = stored({ [kind]: 1 });
  assert.equal(hostile.structure, null);
  assert.equal(readingGuide(hostile).includes('onerror'), false);
  assert.deepEqual(stored({ unsafe: 1 }).structure, { files: [signals('src/a.ts', { riskMarkers: { unsafe: 1 } })], unmeasured: 0 });
});

// ---- placement, through computeVerdict ------------------------------------------

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'rv-guide-verdict-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = data;
  const db = openDatabase(join(data, 'review-voice.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  });
  return db;
}

function fakeGitHub(checks = GREEN) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/check-runs')) return json({ total_count: checks.length, check_runs: checks });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    throw new Error('Unexpected GitHub request: ' + path);
  };
}

function verdict(db, policy, { review = MINOR, checks = GREEN } = {}) {
  return computeVerdict({
    db, client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(checks), sleep: async () => {} }),
    repository: REPO, pullNumber: PR, head: HEAD, review, policy,
  });
}

test('AC-7: the body is findings, guide, scope block, annotations; the key ignores the guide; it is never a comment', async (t) => {
  const db = fixture(t);
  recordRun(db, {
    repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: MINOR, scores: SCORES,
    provenance: PROVENANCE, structure: recordedStructure(STRUCTURE),
  });
  const policy = { readingGuide: true, scopeBlock: true, ciRed: 'annotate' };
  const both = await verdict(db, policy, { checks: RED });
  assert.equal(both.exitCode, 0, JSON.stringify(both.output));
  const guide = readingGuide(both.run);
  const scope = scopeBlock(both.run, both.planned, policy);
  const note = 'Heads up: `build` failing on this head.';
  assert.match(guide, /^1\. `src\/auth\/session\.ts` \(deleted file\): 2 removed controls \(guard, refusal\)$/m);
  assert.equal(both.output.payload.body, ['1 comment, the highest minor.', guide, scope, note].join('\n\n'));
  assert.ok(both.output.preview.includes(both.output.payload.body));
  assert.equal(both.output.payload.comments.length, 1);
  assert.equal(JSON.stringify(both.output.payload.comments).includes('Reading guide'), false);

  const off = await verdict(db, { ...policy, readingGuide: false }, { checks: RED });
  assert.equal(off.output.key, both.output.key);
  assert.equal(off.output.payload.body, ['1 comment, the highest minor.', scope, note].join('\n\n'));
  const guideOnly = await verdict(db, { readingGuide: true });
  assert.equal(guideOnly.output.key, both.output.key);
  assert.equal(guideOnly.output.payload.body, ['1 comment, the highest minor.', guide].join('\n\n'));
  const neither = await verdict(db, {});
  assert.equal(neither.output.key, both.output.key);
  assert.equal(neither.output.payload.body, '1 comment, the highest minor.');

  // A CI annotation swap still finds the note after both blocks.
  const swapped = replaceAnnotations(both.output.payload.body, both.output.annotations, ['Heads up: `e2e` need a rerun.']);
  assert.equal(swapped, ['1 comment, the highest minor.', guide, scope, 'Heads up: `e2e` need a rerun.'].join('\n\n'));
  assert.equal(replaceAnnotations(both.output.payload.body, both.output.annotations, []), ['1 comment, the highest minor.', guide, scope].join('\n\n'));
  assert.ok(scope.endsWith(' -->'), 'the scope block trailer is the last line before the annotation');
});

test('AC-7: a run without a recorded structure says so in the guide', async (t) => {
  const db = fixture(t);
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: CLEAN, provenance: PROVENANCE });
  const { output } = await verdict(db, { readingGuide: true }, { review: CLEAN });
  assert.equal(output.payload.body, 'No problems found.\n\n' + [...OPEN, 'Structure not recorded.', '', '</details>'].join('\n'));
});

// ---- documents ----------------------------------------------------------------------

test('AC-8: the ADR amendment, its README row and the posting documents name both settings', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const adr = readdirSync(join(root, 'docs/adr')).find((name) => /^0028-.*\.md$/.test(name));
  assert.ok(adr);
  const amendments = read('docs/adr/' + adr).split(/^## Amendment - 2026[^\n]*\n/m).slice(1);
  const amendment = amendments.find((text) => text.includes('min_posted_tier') && text.includes('reading_guide'));
  assert.ok(amendment, 'one dated 2026 amendment names both keys');
  assert.match(amendment, /\| `question` \| 2/);
  assert.match(amendment, /approval at COMMENT/);
  for (const category of ['security', 'authorization', 'authentication', 'data_integrity', 'trust_boundary']) assert.ok(amendment.includes(`\`${category}\``), category);
  assert.match(amendment, /0016[\s\S]*lists stay local/);
  assert.match(amendment, /0020[\s\S]*off the posted body/);
  const row = read('docs/adr/README.md').split('\n').find((line) => line.startsWith('| [0028]'));
  assert.ok(row.includes('min_posted_tier') && row.includes('reading_guide'), row);

  const template = read('plugins/review-voice/templates/config.example.yaml').split('\nverdict:\n')[1].split('\nstatic_evidence:')[0];
  assert.match(template, /^  min_posted_tier: nit$/m);
  assert.match(template, /^  reading_guide: false$/m);
  assert.match(template, /scope_block on beside a tier/);
  const architecture = read('docs/ARCHITECTURE.md');
  const posting = architecture.split('### Posting\n')[1].split('\n### ')[0];
  const structural = architecture.split('### Structural evidence\n')[1].split('\n### ')[0];
  assert.match(structural, /per-file counts[\s\S]*reading_guide/);
  for (const text of [posting, read('plugins/review-voice/commands/draft-review.md'), read('plugins/review-voice/src/help.ts')]) {
    assert.ok(text.includes('min_posted_tier'));
    assert.ok(text.includes('reading_guide'));
    assert.ok(text.includes('belowTier'));
  }
});

test('a machine-local path is dropped when the structure is recorded and never reaches the guide', () => {
  const local = ['/Users/example/private/auth.ts', '/auth.ts', '~/auth.ts', 'src/../../auth.ts', 'C:\\work\\auth.ts'];
  const raw = {
    removedControls: [],
    riskMarkers: [...local, 'src/auth.ts'].map((path) => ({ path, line: 1, kind: 'unsafe' })),
    typeEscapes: [],
    branchGrowth: [],
    sizeCrossings: [],
  };
  const recorded = recordedStructure(raw);
  assert.deepEqual(recorded.files.map((file) => file.path), ['src/auth.ts']);
  // A row stored before the check is filtered again when the guide renders.
  const stored = { ...recorded, files: [...recorded.files, ...local.map((path) => ({ ...recorded.files[0], path }))] };
  const guide = readingGuide({ structure: stored });
  assert.deepEqual([...guide.matchAll(/`([^`]*)`/g)].map((m) => m[1]), ['src/auth.ts']);
});
