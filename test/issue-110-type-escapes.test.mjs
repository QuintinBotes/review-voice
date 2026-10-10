/**
 * Issue #110: `diff --out` lists escape hatches from the type system on added
 * lines of production source, per language. Evidence for the analyst; it never
 * touches the verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTypeEscapes } from '../plugins/review-voice/src/diff/type-escapes.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/** One file's patch from lines prefixed with ' ', '+' or '-', starting at line `start`. */
function patch(path, lines, start = 1) {
  const oldCount = lines.filter((l) => !l.startsWith('+')).length;
  const newCount = lines.filter((l) => !l.startsWith('-')).length;
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${start},${oldCount} +${start},${newCount} @@`, ...lines, '',
  ].join('\n');
}

/** The kinds found on one added line of `path`. */
const kinds = (path, text) => findTypeEscapes(patch(path, [`+${text}`]), [path]).map((e) => e.kind);

const TS = 'src/order.ts';
const CS = 'src/Order.cs';
const PY = 'src/order.py';

// ---- every kind hits, per language ------------------------------------------

const HITS = [
  [TS, 'const a: any = 1;', ['any']],
  [TS, 'const a = b as any;', ['any']],
  [TS, 'const a = <any>b;', ['any']],
  [TS, 'f(a as any, b as any);', ['any', 'any']],
  [TS, 'const a = b as unknown as Order;', ['double-cast']],
  [TS, 'const a = order.customer!.name;', ['non-null']],
  [TS, 'const a = items[0]!;', ['non-null']],
  [TS, 'const a = f()!.x;', ['non-null']],
  [TS, 'foo(a!, b);', ['non-null']],
  [TS, '// @ts-ignore', ['ts-ignore']],
  [TS, '// @ts-expect-error legacy shape', ['ts-expect-error']],
  [TS, '// eslint-disable-next-line @typescript-eslint/no-explicit-any', ['lint-disable']],
  [TS, '/* eslint-disable @typescript-eslint/no-unsafe-assignment */', ['lint-disable']],
  [TS, '/* eslint-disable */', ['lint-disable']],
  [TS, 'const a = b as any; // eslint-disable-line', ['any', 'lint-disable']],
  [CS, 'var a = order.Customer!.Name;', ['null-forgiving']],
  [CS, 'string s = null!;', ['null-forgiving']],
  [CS, 'dynamic a = Load();', ['dynamic']],
  [CS, 'var a = (object)value;', ['object-cast']],
  [CS, 'var a = (object) Load();', ['object-cast']],
  [CS, '#nullable disable', ['nullable-disable']],
  [CS, '#pragma warning disable CS8618', ['nullable-disable']],
  [CS, '#pragma warning disable CS8602, CS1591', ['nullable-disable']],
  [CS, '#pragma warning disable nullable', ['nullable-disable']],
  [PY, 'x = load()  # type: ignore', ['type-ignore']],
  [PY, 'x = load()  # type: ignore[assignment]', ['type-ignore']],
  [PY, 'x = cast(Order, load())', ['cast']],
  [PY, 'x = typing.cast(Order, load())', ['cast']],
  [PY, 'def load(a: Any) -> Any:', ['any', 'any']],
];

for (const [path, text, expected] of HITS) {
  test(`${path}: ${text}`, () => assert.deepEqual(kinds(path, text), expected));
}

test('the extension picks the language, so a TypeScript pattern does not fire in C# or Python', () => {
  assert.deepEqual(kinds(CS, 'var a = b as any;'), []);
  assert.deepEqual(kinds(PY, 'x = a!.b'), []);
  assert.deepEqual(kinds(TS, 'dynamic a = 1; x = cast(Order, y);'), []);
  for (const ext of ['mts', 'cts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
    assert.deepEqual(kinds(`src/order.${ext}`, 'const a: any = 1;'), ['any'], ext);
  }
  assert.deepEqual(kinds('src/order.pyi', 'x: Any'), ['any']);
});

test('an unknown extension has no entries', () => {
  for (const path of ['src/order.go', 'src/order.rb', 'src/Makefile', 'src/order.ts.txt', 'README.md']) {
    assert.deepEqual(kinds(path, 'x = y as any; // @ts-ignore'), [], path);
  }
});

// ---- near misses ---------------------------------------------------------------

test('not-equal operators and prefix negation are not non-null assertions', () => {
  for (const path of [TS, CS]) {
    assert.deepEqual(kinds(path, 'if (a != b || a !== c) { go(!d, !(e)); }'), [], path);
  }
  assert.deepEqual(kinds(TS, 'const ok = !a && !!b;'), []);
});

test('words that merely contain a pattern are not hits', () => {
  assert.deepEqual(kinds(TS, 'const company = many; const x: anyone = 1;'), []);
  assert.deepEqual(kinds(CS, 'var dynamics = 1; var o = (object);'), []);
  assert.deepEqual(kinds(PY, 'x = forecast(1); y = Anything()'), []);
  assert.deepEqual(kinds(TS, '// eslint-disable-next-line no-console'), []);
  assert.deepEqual(kinds(CS, '#pragma warning disable CS1591'), []);
});

// ---- strings and comments -------------------------------------------------------

test('nothing inside a string literal is a hit, in any language', () => {
  assert.deepEqual(kinds(TS, 'const m = "cast it as any, then a!.b";'), []);
  assert.deepEqual(kinds(TS, "const m = 'x as unknown as y // @ts-ignore';"), []);
  assert.deepEqual(kinds(TS, 'const m = `type: any ${a}`;'), []);
  assert.deepEqual(kinds(TS, 'const m = "say \\"as any\\" twice";'), []);
  assert.deepEqual(kinds(CS, 'var m = "dynamic (object)x null!.";'), []);
  assert.deepEqual(kinds(PY, "m = 'cast(x) Any  # type: ignore'"), []);
  // The code after a string is still read.
  assert.deepEqual(kinds(TS, 'const m = "text"; const a: any = 1;'), ['any']);
});

test('no code-kind hit inside a comment', () => {
  assert.deepEqual(kinds(TS, '// const a: any = b as unknown as c; d!.e'), []);
  assert.deepEqual(kinds(TS, 'const x = 1; /* as any */'), []);
  assert.deepEqual(kinds(TS, ' * the value is a: any, see d!.e'), []);
  assert.deepEqual(kinds(CS, '// dynamic (object)x null!.y'), []);
  assert.deepEqual(kinds(PY, '# cast(x) and Any'), []);
  assert.deepEqual(kinds(PY, 'x = 1  # Any cast(y)'), []);
});

test('directive kinds are read from comments only', () => {
  assert.deepEqual(kinds(TS, 'const m = "@ts-ignore @ts-expect-error eslint-disable";'), []);
  assert.deepEqual(kinds(TS, 'const a = 1; /* @ts-expect-error */'), ['ts-expect-error']);
  assert.deepEqual(kinds(TS, ' * @ts-ignore'), ['ts-ignore']);
  assert.deepEqual(kinds(PY, 'm = "# type: ignore"'), []);
  assert.deepEqual(kinds(PY, 'x = 1  # type: ignore'), ['type-ignore']);
});

test('preprocessor directives are code in C#, not comments', () => {
  assert.deepEqual(kinds(CS, '#pragma warning disable CS8600 // the loader returns null'), ['nullable-disable']);
});

test('Python import lines are skipped', () => {
  assert.deepEqual(kinds(PY, 'from typing import Any, cast'), []);
  assert.deepEqual(kinds(PY, 'import typing'), []);
  assert.deepEqual(kinds(PY, '    from typing import cast'), []);
  assert.deepEqual(kinds(PY, 'x: Any = None'), ['any']);
});

// ---- the diff ------------------------------------------------------------------

test('only added lines count, and each carries its new-side line number', () => {
  const diff = patch(TS, [
    ' const a: any = 1;',
    '-const b: any = 2;',
    '-const c = d as any;',
    '+const e: any = 3;',
    ' const f = g as unknown as h;',
    '+const i = j!.k;',
  ], 10);
  assert.deepEqual(findTypeEscapes(diff, [TS]), [
    { path: TS, line: 11, kind: 'any' },
    { path: TS, line: 13, kind: 'non-null' },
  ]);
});

test('CRLF patches, a no-newline marker and a "++ " line are read as the lines they are', () => {
  const diff = [
    `diff --git a/${TS} b/${TS}`, `--- a/${TS}`, `+++ b/${TS}`, '@@ -1,1 +1,3 @@',
    ' const a = 1;\r', '+++ const b: any = 2;\r', '+const c = d as any;\r', '\\ No newline at end of file', '',
  ].join('\n');
  assert.deepEqual(findTypeEscapes(diff, [TS]).map((e) => [e.line, e.kind]), [[2, 'any'], [3, 'any']]);
});

test('quoted paths resolve and only the listed paths are read', () => {
  const quoted = 'src/caf\\303\\251.ts';
  const diff = [
    `diff --git "a/${quoted}" "b/${quoted}"`, `--- "a/${quoted}"`, `+++ "b/${quoted}"`,
    '@@ -0,0 +1,1 @@', '+const a: any = 1;', '',
  ].join('\n') + patch('src/other.ts', ['+const b: any = 2;']);
  assert.deepEqual(findTypeEscapes(diff, ['src/café.ts']), [{ path: 'src/café.ts', line: 1, kind: 'any' }]);
  assert.deepEqual(findTypeEscapes(diff, []), []);
});

test('entries are capped at 20 per file, earliest lines first, and sorted by path then line', () => {
  const many = Array.from({ length: 25 }, (_, i) => `+const v${i}: any = ${i};`);
  const diff = patch('src/b.ts', many) + patch('src/a.ts', ['+const x: any = 1;', '+const y = z!.w;']);
  const found = findTypeEscapes(diff, ['src/b.ts', 'src/a.ts']);
  assert.deepEqual(found.slice(0, 2), [{ path: 'src/a.ts', line: 1, kind: 'any' }, { path: 'src/a.ts', line: 2, kind: 'non-null' }]);
  const b = found.filter((e) => e.path === 'src/b.ts');
  assert.equal(b.length, 20);
  assert.deepEqual(b.map((e) => e.line), Array.from({ length: 20 }, (_, i) => i + 1));
});

// ---- diff --out, through the bundle ---------------------------------------------

test('diff --out lists type escapes in production source and leaves test files out', () => {
  const base = mkdtempSync(join(tmpdir(), 'rv-110-'));
  try {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'src/order.ts'), 'export const total = 0;\n');
    writeFileSync(join(repo, 'test/order.test.ts'), 'export const t = 0;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    writeFileSync(join(repo, 'src/order.ts'), 'export const total = 0;\nexport const raw = load() as unknown as Order;\n');
    writeFileSync(join(repo, 'test/order.test.ts'), 'export const t = 0;\nexport const u: any = 1;\n');

    const out = join(base, 'out');
    const result = spawnSync(process.execPath, [bundle, 'diff', '--out', out], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout).summary;
    assert.deepEqual(summary.structure.typeEscapes, [{ path: 'src/order.ts', line: 2, kind: 'double-cast' }]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'files.json'), 'utf8')).structure, summary.structure);
    assert.equal(summary.humanReviewNote, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
