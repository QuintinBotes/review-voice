/**
 * Issue 341. A fixture is reviewed as a repository, so what its patch points at
 * has to be there. Every fixture the recall harness runs is built the way the
 * harness builds it, and in the built head each relative import resolves to a
 * file, each file a CI step names exists, and no script declares a value it
 * leaves undefined. A careful reviewer reports a dangling import, a missing
 * project file or a value with no implementation, and on a clean fixture that
 * true report was scored as noise.
 *
 * Only what can be checked exactly is checked:
 * - Relative imports of TypeScript and JavaScript files. C# is left out because
 *   a `using` names a namespace, not a file, and Terraform because no fixture
 *   has a module source.
 * - Ambient value declarations in TypeScript sources. `declare const` passes
 *   the type check and defines nothing, so the code throws when it runs.
 *   Whether any other symbol is defined is not checked in any language, since
 *   that needs a compiler.
 * - Paths in a single-line `run:` step that a patch adds to a YAML file. A
 *   block scalar, a Makefile and package scripts are left out because no
 *   fixture has one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import { materializeFixture, normalisePatch } from '../plugins/review-voice/src/evaluate/fixtures.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'fixtures');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-fixture-consistency-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes `files` (path to content) under a new directory and returns it. */
function tree(t, files) {
  const dir = scratch(t);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** The fixtures `review-voice recall` scores: the three classes, less the ones marked `harness: skip`. */
function scoredFixtures() {
  const out = [];
  for (const group of ['positive', 'negative', 'no-findings']) {
    for (const name of readdirSync(join(fixtures, group)).sort()) {
      const dir = join(fixtures, group, name);
      if (!statSync(dir).isDirectory()) continue;
      if (/^harness:\s*skip\b/m.test(readFileSync(join(dir, 'case.yaml'), 'utf8'))) continue;
      out.push({ label: `${group}/${name}`, dir });
    }
  }
  return out;
}

/** Every file of a built head, repository-relative, less git's own and the generated configuration. */
function headFiles(repo, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(repo, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (path === '.git' || path === '.review-voice') continue;
    if (entry.isDirectory()) out.push(...headFiles(repo, path));
    else out.push(path);
  }
  return out;
}

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const IMPORTS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/** The `./` and `../` module specifiers a script names, in any import form. */
function relativeImports(text) {
  const found = new Set();
  for (const pattern of IMPORTS) {
    for (const match of text.matchAll(pattern)) {
      if (/^\.\.?\//.test(match[2])) found.add(match[2]);
    }
  }
  return [...found];
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** True when a relative specifier names a file of the head, by the extensions a bundler would try. */
function resolves(repo, from, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (target.startsWith('..')) return false;
  // A TypeScript source is imported under the name its output will have.
  const asSource = target.replace(/\.([cm]?)js$/, '.$1ts');
  const tried = [target, asSource];
  for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json']) tried.push(`${target}${extension}`);
  for (const index of ['index.ts', 'index.tsx', 'index.js', 'index.mjs']) tried.push(`${target}/${index}`);
  return tried.some((path) => isFile(join(repo, path)));
}

/** Each relative import in the head that resolves to no file. */
function importProblems(repo) {
  const problems = [];
  for (const path of headFiles(repo)) {
    if (!SCRIPT.test(path)) continue;
    for (const specifier of relativeImports(readFileSync(join(repo, path), 'utf8'))) {
      if (!resolves(repo, path, specifier)) problems.push(`${path} imports ${specifier}, which is no file in the built head`);
    }
  }
  return problems;
}

const AMBIENT = /^\s*(?:export\s+)?declare\s+(?:const|let|var|function|class)\s+([\w$]+)/gm;

/**
 * Each value a script of the head declares without defining. A declaration
 * file is left out, since describing values defined elsewhere is its purpose.
 */
function ambientProblems(repo) {
  const problems = [];
  for (const path of headFiles(repo)) {
    if (!SCRIPT.test(path) || /\.d\.[cm]?ts$/.test(path)) continue;
    for (const match of readFileSync(join(repo, path), 'utf8').matchAll(AMBIENT)) {
      problems.push(`${path} declares ${match[1]} and nothing in the built head defines it`);
    }
  }
  return problems;
}

/**
 * The repository paths a `run:` step names: a word with a directory and a file
 * extension and nothing a shell would expand, so `npm test`, a flag, a glob and
 * a variable are not taken for a file.
 */
function stepPaths(line) {
  const step = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
  if (step === null) return [];
  return step[1]
    .split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
    .filter((word) => /^(?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)+$/.test(word) && /\.[A-Za-z0-9]+$/.test(word))
    .map((word) => word.replace(/^\.\//, ''));
}

/** Each file a patch's added `run:` steps name that the head does not hold. */
function stepProblems(repo, normalised) {
  const problems = [];
  const lines = normalised.split('\n');
  for (const [path, hunks] of parseHunks(normalised)) {
    if (!/\.ya?ml$/.test(path)) continue;
    for (const [patchLine, fileLine] of hunks.patchLines) {
      if (!hunks.added.has(fileLine) || !lines[patchLine - 1].startsWith('+')) continue;
      for (const named of stepPaths(lines[patchLine - 1].slice(1))) {
        if (!isFile(join(repo, named))) problems.push(`${path}:${fileLine} runs ${named}, which is no file in the built head`);
      }
    }
  }
  return problems;
}

test('a relative import that resolves to nothing is reported, in each import form', (t) => {
  const repo = tree(t, {
    'src/a.ts': [
      "import { b } from './b';",
      "import type { C } from '../lib/c';",
      "export { d } from './nested';",
      "import './side-effect';",
      "const lazy = import('./lazy');",
      "const old = require('./old');",
      "import express from 'express';",
      '',
    ].join('\n'),
    'src/b.ts': '',
    'README.md': "import { nothing } from './nowhere';\n",
  });
  assert.deepEqual(importProblems(repo), [
    'src/a.ts imports ../lib/c, which is no file in the built head',
    'src/a.ts imports ./nested, which is no file in the built head',
    'src/a.ts imports ./side-effect, which is no file in the built head',
    'src/a.ts imports ./lazy, which is no file in the built head',
    'src/a.ts imports ./old, which is no file in the built head',
  ]);
});

test('a relative import resolves by extension, by index file, and from an output name to its source', (t) => {
  const repo = tree(t, {
    'src/a.ts': ["import './b';", "import './c.js';", "import './dir';", "import './data.json';", "import '../lib/e';", "import './view';", ''].join('\n'),
    'src/b.ts': '',
    'src/c.ts': '',
    'src/dir/index.ts': '',
    'src/data.json': '{}',
    'lib/e.mjs': '',
    'src/view.tsx': '',
  });
  assert.deepEqual(importProblems(repo), []);
  // A directory is not a module unless it holds an index, and a path may not leave the repository.
  const bad = tree(t, { 'src/a.ts': "import './dir';\nimport '../../outside';\n", 'src/dir/other.ts': '' });
  assert.deepEqual(importProblems(bad), [
    'src/a.ts imports ./dir, which is no file in the built head',
    'src/a.ts imports ../../outside, which is no file in the built head',
  ]);
});

test('a value a script only declares is reported, and a type, a class field and a declaration file are not', (t) => {
  const repo = tree(t, {
    'src/a.ts': [
      'declare const metrics: { record(name: string): void };',
      'export declare function send(): void;',
      'declare module "./b" { interface B { extra: string } }',
      'declare global { interface Window { ready: boolean } }',
      'class Row {',
      '  declare id: string;',
      '}',
      'metrics.record("row");',
      '',
    ].join('\n'),
    'src/globals.d.ts': 'declare const VERSION: string;\n',
    'docs/a.md': 'declare const prose: string;\n',
  });
  assert.deepEqual(ambientProblems(repo), [
    'src/a.ts declares metrics and nothing in the built head defines it',
    'src/a.ts declares send and nothing in the built head defines it',
  ]);
});

test('only a word that names a file is read from a run step', () => {
  assert.deepEqual(stepPaths('      - run: dotnet test test/contracts/Contracts.csproj'), ['test/contracts/Contracts.csproj']);
  assert.deepEqual(stepPaths('        run: node ./scripts/build.mjs --check "docs/a.md"'), ['scripts/build.mjs', 'docs/a.md']);
  assert.deepEqual(stepPaths('      - run: npm test'), []);
  assert.deepEqual(stepPaths('      - run: git diff origin/main -- src/**/*.ts $OUT/a.txt --out=dist/a.js'), []);
  assert.deepEqual(stepPaths('      - name: test/contracts/Contracts.csproj'), [], 'only a run step is a command');
});

test('a file an added run step names is reported when the head does not hold it, and a context line is not read', (t) => {
  const repo = tree(t, { 'test/unit/Unit.csproj': '<Project />\n' });
  const patch = [
    '--- a/.ci/verify.yml',
    '+++ b/.ci/verify.yml',
    '@@ -1,2 +1,4 @@',
    ' steps:',
    '   - run: dotnet build src/Gone.csproj',
    '+  - run: dotnet test test/unit/Unit.csproj',
    '+  - run: dotnet test test/contracts/Contracts.csproj',
    '--- a/docs/ci.md',
    '+++ b/docs/ci.md',
    '@@ -1,1 +1,2 @@',
    ' # CI',
    '+  - run: dotnet test test/nowhere/Nowhere.csproj',
    '',
  ].join('\n');
  assert.deepEqual(stepProblems(repo, normalisePatch(patch)), ['.ci/verify.yml:4 runs test/contracts/Contracts.csproj, which is no file in the built head']);
});

test('every fixture the harness runs is consistent once built: its relative imports resolve, the files its CI steps name exist and no value is only declared', (t) => {
  const scored = scoredFixtures();
  assert.ok(scored.length >= 35, `expected every scored fixture, found ${scored.length}`);
  const problems = [];
  let scripts = 0;
  for (const { label, dir } of scored) {
    const repo = join(scratch(t), 'repo');
    // The head is left checked out, so the working tree is the built head.
    materializeFixture(dir, repo, { name: label });
    scripts += headFiles(repo).filter((path) => SCRIPT.test(path)).length;
    const found = [...importProblems(repo), ...ambientProblems(repo), ...stepProblems(repo, normalisePatch(readFileSync(join(dir, 'diff.patch'), 'utf8')))];
    problems.push(...found.map((problem) => `${label}: ${problem}`));
  }
  assert.deepEqual(problems, []);
  assert.ok(scripts >= 20, `expected the sweep to read the fixtures' scripts, found ${scripts}`);
});
