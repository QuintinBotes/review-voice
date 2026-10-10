import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSymbolContext } from '../plugins/review-voice/src/diff/symbols.ts';
import {
  declarationName,
  declarationSearchTokens,
  declarationTokens,
} from '../plugins/review-voice/src/diff/declarations.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function addedDiff(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function context(diff, options = {}) {
  return collectSymbolContext({
    diff,
    cwd: '/repo',
    ref: 'base',
    search: () => [],
    lineSearch: () => [],
    ...options,
  });
}

function changedFile(report, path = 'src/new.ts') {
  const file = report.files.find((entry) => entry.path === path);
  assert.ok(file, `missing ${path}`);
  return file;
}

test('declaration tokens split names and reject generic names', () => {
  assert.deepEqual(declarationTokens('ToSnakeCase'), ['snake', 'case']);
  assert.deepEqual(declarationTokens('parseHTTPUrl'), ['parse', 'http', 'url']);
  assert.deepEqual(declarationTokens('make_snake-case2'), ['snake', 'case', '2']);
  assert.deepEqual(declarationSearchTokens('parseHTTPUrl'), ['parse', 'http']);
  assert.equal(declarationSearchTokens('getUser'), null);
});

test('lexical declarations cover supported languages without treating uses as declarations', () => {
  const declarations = [
    ['export async function toSnakeCase(value) {', 'toSnakeCase'],
    ['const toSnakeCase = (value) => value;', 'toSnakeCase'],
    ['  public toSnakeCase(value): string {', 'toSnakeCase'],
    ['def to_snake_case(value):', 'to_snake_case'],
    ['public string ToSnakeCase(string value) {', 'ToSnakeCase'],
    ['fun toSnakeCase(value: String): String {', 'toSnakeCase'],
    ['func (s *Formatter) ToSnakeCase(value string) string {', 'ToSnakeCase'],
    ['pub fn to_snake_case(value: &str) {', 'to_snake_case'],
  ];
  for (const [line, name] of declarations) assert.equal(declarationName(line), name, line);

  for (const line of [
    'toSnakeCase(value);',
    'const alias = toSnakeCase;',
    '  if (toSnakeCase(value)) {',
    '  return toSnakeCase(value);',
  ]) {
    assert.equal(declarationName(line), null, line);
  }
});

test('a declaration changed on both sides of a hunk is not listed as new', () => {
  const diff = [
    'diff --git a/src/new.ts b/src/new.ts',
    '--- a/src/new.ts',
    '+++ b/src/new.ts',
    '@@ -1 +1 @@',
    '-export function toSnakeCase(value: string) {',
    '+export function toSnakeCase(value: unknown) {',
  ].join('\n');

  assert.equal(changedFile(context(diff)).declared, undefined);
});

test('possible existing declarations use the Jaccard threshold and best-first ordering', () => {
  const report = context(addedDiff('src/new.ts', ['export function toSnakeCase(value) {']), {
    lineSearch: () => [
      { path: 'src/z.ts', line: 4, text: 'export function snakeCase(value) {' },
      { path: 'src/a.ts', line: 2, text: 'export function parseSnakeCase(value) {' },
      { path: 'src/b.ts', line: 3, text: 'export function formatSnakeCase(value) {' },
      { path: 'src/c.ts', line: 1, text: 'export function snakeCase(value) {' },
      { path: 'src/no.ts', line: 1, text: 'export function snakeValue(value) {' },
    ],
  });

  assert.deepEqual(changedFile(report).declared, [
    {
      name: 'toSnakeCase',
      line: 1,
      possibleExisting: [
        { path: 'src/c.ts', line: 1, name: 'snakeCase' },
        { path: 'src/z.ts', line: 4, name: 'snakeCase' },
        { path: 'src/a.ts', line: 2, name: 'parseSnakeCase' },
      ],
    },
  ]);
});

test('declarations the patch adds and test paths cannot become existing-helper evidence', () => {
  const report = context(addedDiff('src/new.ts', [
    'export function toSnakeCase(value) {',
    'export function snakeCase(value) {',
  ]), {
    lineSearch: () => [
      { path: 'src/new.ts', line: 1, text: 'export function toSnakeCase(value) {' },
      { path: 'src/new.ts', line: 2, text: 'export function snakeCase(value) {' },
      { path: 'test/strings.test.ts', line: 4, text: 'export function snakeCase(value) {' },
      { path: 'src/__tests__/strings.ts', line: 3, text: 'export function snakeCase(value) {' },
      { path: 'fixtures/strings.ts', line: 2, text: 'export function snakeCase(value) {' },
      { path: 'src/strings.ts', line: 1, text: 'export function formatSnakeCase(value) {' },
    ],
  });

  const declared = changedFile(report).declared;
  assert.ok(declared);
  assert.equal(declared.length, 2);
  assert.ok(declared.every((entry) => entry.possibleExisting.every((match) => !['toSnakeCase', 'snakeCase'].includes(match.name))));
  assert.ok(declared.every((entry) => entry.possibleExisting.every((match) => match.path === 'src/strings.ts')));
});

test('declaration and possible-existing caps are bounded independently', () => {
  const lines = Array.from({ length: 9 }, (_, index) => `export function toSnake${index}Case(value) {`);
  const report = context(addedDiff('src/new.ts', lines), {
    lineSearch: () => [
      { path: 'src/a.ts', line: 1, text: 'export function snakeCase(value) {' },
      { path: 'src/b.ts', line: 1, text: 'export function snakeCase(value) {' },
      { path: 'src/c.ts', line: 1, text: 'export function snakeCase(value) {' },
      { path: 'src/d.ts', line: 1, text: 'export function snakeCase(value) {' },
    ],
  });

  const declared = changedFile(report).declared;
  assert.ok(declared);
  assert.equal(declared.length, 8);
  assert.deepEqual(declared.map((entry) => entry.line), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(declared.every((entry) => entry.possibleExisting.length === 3));
});

test('a failed line search marks only its declaration inconclusive', () => {
  const report = context(addedDiff('src/new.ts', [
    'export function toSnakeCase(value) {',
    'export function toKebabCase(value) {',
  ]), {
    lineSearch: (patterns) => {
      if (patterns.includes('snake')) throw new Error('search failed');
      return [{ path: 'src/strings.ts', line: 7, text: 'export function kebabCase(value) {' }];
    },
  });

  const file = changedFile(report);
  assert.equal(file.inconclusive, true);
  assert.deepEqual(file.declared, [
    { name: 'toSnakeCase', line: 1, possibleExisting: [], inconclusive: true },
    {
      name: 'toKebabCase',
      line: 2,
      possibleExisting: [{ path: 'src/strings.ts', line: 7, name: 'kebabCase' }],
    },
  ]);
});

test('the shared budget marks every unsearched declaration inconclusive', () => {
  let clock = 0;
  const timeouts = [];
  const report = context(addedDiff('src/new.ts', [
    'export function toSnakeCase(value) {',
    'export function toKebabCase(value) {',
    'export function toTitleCase(value) {',
    'export function toSlugCase(value) {',
  ]), {
    ref: null,
    maxMs: 100,
    now: () => clock,
    lineSearch: (_patterns, _cwd, _ref, timeoutMs) => {
      timeouts.push(timeoutMs);
      clock += 60;
      return [];
    },
  });

  const file = changedFile(report);
  assert.deepEqual(timeouts, [100, 40]);
  assert.equal(file.inconclusive, true);
  assert.equal(file.reason, 'time-budget');
  assert.ok(file.declared?.slice(2).every((entry) => entry.inconclusive === true && entry.reason === 'time-budget'));
  assert.equal(report.budget.exhausted, true);
});

function gitRepository(files) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-possible-existing-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, body] of Object.entries(files)) {
    const full = join(directory, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { directory, git };
}

test('the bundled symbols command finds a helper at the reviewed ref', () => {
  const { directory, git } = gitRepository({
    'src/strings.ts': 'export function snakeCase(value: string) { return value; }\n',
    'src/new.ts': '// module\n',
  });
  try {
    writeFileSync(join(directory, 'src/new.ts'), 'export function toSnakeCase(value: string) { return value; }\n');
    const patch = join(directory, 'change.patch');
    writeFileSync(patch, git('diff', '--', 'src/new.ts'));

    const run = spawnSync(process.execPath, [bundle, 'symbols', '--diff-file', patch, '--base', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const file = changedFile(JSON.parse(run.stdout));
    assert.deepEqual(file.declared, [
      {
        name: 'toSnakeCase',
        line: 1,
        possibleExisting: [{ path: 'src/strings.ts', line: 1, name: 'snakeCase' }],
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every hit of the real git grep is parsed, not only the first', () => {
  const { directory, git } = gitRepository({
    'src/strings.ts': 'export function snakeCase(value: string) { return value; }\n',
    'src/text/case.ts': '// helpers\nexport function toSnakeCaseKey(value: string) { return value; }\n',
    'src/new.ts': '// module\n',
  });
  try {
    writeFileSync(join(directory, 'src/new.ts'), 'export function toSnakeCase(value: string) { return value; }\n');
    const patch = join(directory, 'change.patch');
    writeFileSync(patch, git('diff', '--', 'src/new.ts'));

    const run = spawnSync(process.execPath, [bundle, 'symbols', '--diff-file', patch, '--base', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const [declared] = changedFile(JSON.parse(run.stdout)).declared;
    assert.deepEqual(
      [...declared.possibleExisting].sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: 'src/strings.ts', line: 1, name: 'snakeCase' },
        { path: 'src/text/case.ts', line: 2, name: 'toSnakeCaseKey' },
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
