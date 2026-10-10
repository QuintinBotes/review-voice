/**
 * Issue #109: `diff --out` lists existing functions a change adds branching
 * to, attributed the way git names a hunk's enclosing declaration. Evidence
 * for the analyst; it never touches the verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStructureSignals } from '../plugins/review-voice/src/diff/structure.ts';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const limits = { maxFileLines: 1000, maxAddedBranchesPerFunction: 3 };

/** One file's patch from hunks of `{ start, context, lines }`, lines prefixed with ' ', '+' or '-'. */
function patch(path, hunks) {
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const { start, context = '', lines } of hunks) {
    const oldCount = lines.filter((l) => !l.startsWith('+')).length;
    const newCount = lines.filter((l) => !l.startsWith('-')).length;
    out.push(`@@ -${start},${oldCount} +${start},${newCount} @@${context === '' ? '' : ` ${context}`}`, ...lines);
  }
  return `${out.join('\n')}\n`;
}

const growth = (diff, paths = ['src/flow.ts']) => findStructureSignals(diff, paths, new Map(), limits).branchGrowth;

test('branching added to an existing function is listed under the declaration git names', () => {
  const diff = patch('src/flow.ts', [{
    start: 20,
    context: 'export function handle(order: Order) {',
    lines: [
      '   const total = sum(order);',
      '+  if (order.region === "eu") applyVat(order);',
      '+  if (order.coupon && order.coupon.active) discount(order);',
      '   return total;',
    ],
  }]);
  assert.deepEqual(growth(diff), [{
    path: 'src/flow.ts', function: 'export function handle(order: Order) {', addedDecisionPoints: 3, threshold: 3, line: 21,
  }]);
});

test('points in one function are summed across hunks, anchored at the first', () => {
  const context = 'export function handle(order: Order) {';
  const diff = patch('src/flow.ts', [
    { start: 20, context, lines: ['   a();', '+  if (x) b();'] },
    { start: 60, context, lines: ['   c();', '+  while (y) d();', '+  return z ? 1 : 2;'] },
  ]);
  assert.deepEqual(growth(diff).map((g) => [g.addedDecisionPoints, g.line]), [[3, 21]]);
});

test('a new function the hunk adds is not attributed to the one before it', () => {
  const diff = patch('src/flow.ts', [{
    start: 40,
    context: 'export function handle(order: Order) {',
    lines: [
      ' }',
      '+',
      '+export function route(order: Order) {',
      '+  if (a) one();',
      '+  if (b) two();',
      '+  if (c) three();',
      '+}',
    ],
  }]);
  assert.deepEqual(growth(diff), []);
});

test('a declaration in a context line takes over from the header', () => {
  const diff = patch('src/flow.ts', [{
    start: 40,
    context: 'export function handle(order: Order) {',
    lines: [
      ' }',
      ' function audit(order: Order) {',
      '+  if (a) one();',
      '+  if (b) two();',
      '+  if (c) three();',
    ],
  }]);
  assert.deepEqual(growth(diff).map((g) => g.function), ['function audit(order: Order) {']);
});

test('a top-level statement keyword is not a declaration', () => {
  const diff = patch('src/flow.py', [{
    start: 10,
    context: 'def handle(order):',
    lines: [
      '     x = 1',
      '+    if a: one()',
      '+    if b: two()',
      '+    if c: three()',
    ],
  }]);
  assert.equal(growth(diff, ['src/flow.py'])[0].function, 'def handle(order):');
});

test('a hunk without header context is not attributed to anything', () => {
  const diff = patch('src/flow.ts', [{
    start: 1,
    lines: ['+if (a) one();', '+if (b) two();', '+if (c) three();'],
  }]);
  assert.deepEqual(growth(diff), []);
});

test('fewer points than the threshold, or a file not asked about, is not listed', () => {
  const diff = patch('src/flow.ts', [{
    start: 20,
    context: 'export function handle(order: Order) {',
    lines: ['   a();', '+  if (x) b();', '+  if (y) c();'],
  }]);
  assert.deepEqual(growth(diff), []);
  assert.equal(findStructureSignals(diff, ['src/flow.ts'], new Map(), { ...limits, maxAddedBranchesPerFunction: 2 }).branchGrowth.length, 1);
  assert.deepEqual(growth(diff, ['src/other.ts']), []);
});

test('attribution does not change the complexity assessment', () => {
  const diff = patch('src/flow.ts', [{
    start: 20,
    context: 'export function handle(order: Order) {',
    lines: ['   a();', '+  if (x && y) b();', '+  if (z) c();'],
  }]);
  const file = { path: 'src/flow.ts', status: 'modified', class: 'source', language: 'typescript', additions: 2, deletions: 0, reviewed: true };
  const assessment = assessComplexity(diff, [file]);
  assert.equal(assessment.decisionPoints, 3);
  assert.deepEqual(assessment.densestHunk, { path: 'src/flow.ts', line: 20, decisionPoints: 3 });
});

// ---- configuration -------------------------------------------------------

test('review.structure.max_added_branches_per_function sets the threshold; a bad value warns', () => {
  const configIn = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-109-config-'));
    try {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice/config.yaml'), yaml);
      return loadConfig(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(configIn('review:\n  max_words_per_finding: 40\n').structure.maxAddedBranchesPerFunction, 3);
  assert.equal(configIn('review:\n  structure:\n    max_added_branches_per_function: 5\n').structure.maxAddedBranchesPerFunction, 5);
  const bad = configIn('review:\n  structure:\n    max_added_branches_per_function: 0\n');
  assert.equal(bad.structure.maxAddedBranchesPerFunction, 3);
  assert.deepEqual(bad.warnings, ['review.structure.max_added_branches_per_function must be a whole number above zero; using the default.']);
});

// ---- diff --out, through the bundle ---------------------------------------

test('diff --out lists branch growth from a real git hunk header', () => {
  const base = mkdtempSync(join(tmpdir(), 'rv-109-'));
  try {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    const body = Array.from({ length: 10 }, (_, i) => `  step${i}();`);
    writeFileSync(join(repo, 'src/flow.ts'), ['export function handle(order) {', ...body, '}', ''].join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    body.splice(8, 0, '  if (order.eu) vat();', '  if (order.coupon) discount();', '  if (order.gift) wrap();');
    writeFileSync(join(repo, 'src/flow.ts'), ['export function handle(order) {', ...body, '}', ''].join('\n'));

    const out = join(base, 'out');
    const result = spawnSync(process.execPath, [bundle, 'diff', '--out', out], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout).summary;
    assert.deepEqual(summary.structure.branchGrowth, [{
      path: 'src/flow.ts', function: 'export function handle(order) {', addedDecisionPoints: 3, threshold: 3, line: 10,
    }]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'files.json'), 'utf8')).structure, summary.structure);
    assert.equal(summary.humanReviewNote, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---- cases from review: rewrites, signatures, headers, line numbers --------

test('a rewrite that swaps branches is not growth: removed branches net out', () => {
  const context = 'export function handle(order: Order) {';
  const rewrite = patch('src/flow.ts', [{
    start: 20,
    context,
    lines: ['   a();', '-  if (x) b();', '-  if (y) c();', '+  if (x && y) bc();', '+  if (z) d();'],
  }]);
  assert.deepEqual(growth(rewrite), []);
  const grows = patch('src/flow.ts', [{
    start: 20,
    context,
    lines: ['   a();', '-  if (x) b();', '+  if (x && y) bc();', '+  if (z) d();', '+  if (w) e();'],
  }]);
  assert.deepEqual(growth(grows).map((g) => g.addedDecisionPoints), [3]);
});

test('a changed signature keeps the function it replaces', () => {
  const diff = patch('src/flow.ts', [{
    start: 5,
    context: 'import { x } from "./x";',
    lines: ['-function run(a) {', '+function run(a, options) {', '+  if (options.a) one();', '+  if (options.b) two();', '+  if (options.c) three();', '   return a;'],
  }]);
  assert.deepEqual(growth(diff).map((g) => [g.function, g.line]), [['function run(a) {', 6]]);
});

test('a header naming a top-level statement is not a function', () => {
  const diff = patch('src/flow.ts', [{
    start: 30,
    context: 'try {',
    lines: ['   a();', '+  if (x) b();', '+  if (y) c();', '+  if (z) d();'],
  }]);
  assert.deepEqual(growth(diff), []);
});

test('a long declaration is one function whether git named it in a header or a context line showed it', () => {
  const declaration = `export function ${'veryLongName'.repeat(8)}(order: Order) {`;
  assert.ok(declaration.length > 80);
  const diff = patch('src/flow.ts', [
    { start: 10, lines: [` ${declaration}`, '+  if (x) b();'] },
    { start: 40, context: declaration.slice(0, 80), lines: ['   a();', '+  if (y) c();', '+  if (z) d();'] },
  ]);
  assert.deepEqual(growth(diff).map((g) => [g.function.length, g.addedDecisionPoints, g.line]), [[80, 3, 11]]);
});

test('anchors follow new-side line numbers past removed lines', () => {
  const diff = [
    'diff --git a/src/flow.ts b/src/flow.ts',
    '--- a/src/flow.ts',
    '+++ b/src/flow.ts',
    '@@ -50,5 +48,5 @@ export function handle(order: Order) {',
    '   a();',
    '-  old1();',
    '-  old2();',
    '-  old3();',
    '   b();',
    '+  if (x) c();',
    '+  if (y) d();',
    '+  if (z) e();',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  assert.deepEqual(growth(diff).map((g) => [g.line, g.addedDecisionPoints]), [[50, 3]]);
});
