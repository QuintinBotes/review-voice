import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectSymbolContext } from '../plugins/review-voice/src/diff/symbols.ts';

test('symbol context bounds and orders lexical references without counting prose', () => {
  const alphaSymbols = [
    'primarySymbol',
    'widespreadSymbol',
    ...Array.from({ length: 11 }, (_, index) => `extraSymbol${String(index).padStart(2, '0')}`),
  ];
  const diff = [
    'diff --git a/src/alpha.ts b/src/alpha.ts',
    '--- a/src/alpha.ts',
    '+++ b/src/alpha.ts',
    '@@ -1 +1,13 @@',
    ...alphaSymbols.map((symbol) => `+export const ${symbol} = 1;`),
    'diff --git a/src/beta.ts b/src/beta.ts',
    '--- a/src/beta.ts',
    '+++ b/src/beta.ts',
    '@@ -1 +1 @@',
    '+export const secondarySymbol = 1;',
  ].join('\n');
  const primaryReferences = Array.from(
    { length: 9 },
    (_, index) => `src/consumers/consumer-${String(index + 1).padStart(2, '0')}.ts`,
  );
  const widespread = Array.from({ length: 13 }, (_, index) => `packages/p${index}/use.ts`);
  const searched = [];

  const report = collectSymbolContext({
    diff,
    cwd: '/repo',
    ref: 'base-ref',
    search: (symbol, cwd, ref) => {
      searched.push([symbol, cwd, ref]);
      if (symbol === 'primarySymbol') {
        return ['src/alpha.ts', ...primaryReferences.reverse(), 'docs/primary.md', 'assets/primary.png'];
      }
      if (symbol === 'widespreadSymbol') return ['src/alpha.ts', ...widespread];
      if (symbol === 'secondarySymbol') {
        return ['src/beta.ts', 'src/alpha.ts', 'src/shared.ts', 'docs/secondary.md'];
      }
      return symbol.startsWith('extra') ? ['src/alpha.ts'] : [];
    },
  });

  // `reverse` above proves sorting belongs to the collector, not to the
  // injected searcher. The files have 9 and 2 distinct references respectively.
  assert.deepEqual(report.files.map((file) => file.path), ['src/alpha.ts', 'src/beta.ts']);
  assert.equal(report.searchedRef, 'base-ref');

  const alpha = report.files[0];
  assert.ok(alpha);
  assert.equal(alpha.moreSymbols, 1);
  assert.deepEqual(
    alpha.symbols.map((entry) => entry.symbol),
    alphaSymbols.slice(0, 12),
  );

  const primary = alpha.symbols.find((entry) => entry.symbol === 'primarySymbol');
  assert.deepEqual(primary, {
    symbol: 'primarySymbol',
    references: [...primaryReferences].sort().slice(0, 8),
    referenceCount: 9,
    truncated: true,
  });
  assert.ok(!primary.references.includes('src/alpha.ts'), 'a definition is not its own reference');
  assert.ok(!primary.references.some((path) => path.startsWith('docs/') || path.endsWith('.png')));

  const common = alpha.symbols.find((entry) => entry.symbol === 'widespreadSymbol');
  assert.deepEqual(common, { symbol: 'widespreadSymbol', common: true });
  assert.ok(!('references' in common), 'common words must not look like zero-reference symbols');

  const beta = report.files[1];
  assert.ok(beta);
  const secondary = beta.symbols.find((entry) => entry.symbol === 'secondarySymbol');
  assert.deepEqual(secondary, {
    symbol: 'secondarySymbol',
    references: ['src/alpha.ts', 'src/shared.ts'],
    referenceCount: 2,
  });

  // The changed peer is useful in beta's local context, but is not downstream
  // of the change as a whole. Only untouched consumers contribute here.
  assert.equal(report.downstreamFiles, 10);
  assert.ok(!searched.some(([symbol]) => symbol === 'extraSymbol10'), 'the thirteenth symbol is not searched');
  assert.ok(searched.every(([, cwd, ref]) => cwd === '/repo' && ref === 'base-ref'));
});

test('a failed symbol search leaves partial context inconclusive instead of empty', () => {
  const diff = [
    'diff --git a/src/failure.ts b/src/failure.ts',
    '--- a/src/failure.ts',
    '+++ b/src/failure.ts',
    '@@ -1 +1,3 @@',
    '+export const firstSymbol = 1;',
    '+export const failedSymbol = 2;',
    '+export const skippedSymbol = 3;',
    'diff --git a/src/second.ts b/src/second.ts',
    '--- a/src/second.ts',
    '+++ b/src/second.ts',
    '@@ -1 +1 @@',
    '+export const secondFileSymbol = 1;',
  ].join('\n');
  const searched = [];

  const report = collectSymbolContext({
    diff,
    cwd: '/repo',
    ref: null,
    search: (symbol) => {
      searched.push(symbol);
      if (symbol === 'failedSymbol') throw new Error('git grep timed out');
      if (symbol === 'firstSymbol') return ['src/failure.ts', 'src/first-consumer.ts'];
      if (symbol === 'secondFileSymbol') return ['src/second.ts', 'src/second-consumer.ts'];
      return [];
    },
  });

  const failed = report.files.find((file) => file.path === 'src/failure.ts');
  assert.ok(failed);
  assert.equal(failed.inconclusive, true);
  assert.deepEqual(failed.symbols, [
    { symbol: 'firstSymbol', references: ['src/first-consumer.ts'], referenceCount: 1 },
  ]);
  assert.equal(
    failed.symbols.find((entry) => entry.symbol === 'failedSymbol'),
    undefined,
    'a failed search must not be represented as an empty reference list',
  );
  assert.ok(!searched.includes('skippedSymbol'), 'failure stops only that file');

  const second = report.files.find((file) => file.path === 'src/second.ts');
  assert.ok(second);
  assert.deepEqual(second.symbols, [
    { symbol: 'secondFileSymbol', references: ['src/second-consumer.ts'], referenceCount: 1 },
  ]);
  assert.equal(report.downstreamFiles, 2);
});

function gitRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'rv-symbols-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

test('symbol context strips the ref prefix git grep adds to real paths', () => {
  const root = gitRepository({
    'src/changed.ts': 'export const changedSymbol = 1;\n',
    'src/consumer.ts': 'import { changedSymbol } from "./changed.ts";\nconsole.log(changedSymbol);\n',
  });
  try {
    writeFileSync(join(root, 'src/changed.ts'), 'export const changedSymbol = 2;\n');
    const diff = execFileSync('git', ['diff', '--', 'src/changed.ts'], { cwd: root, encoding: 'utf8' });

    const report = collectSymbolContext({ diff, cwd: root, ref: 'HEAD' });

    assert.equal(report.searchedRef, 'HEAD');
    assert.deepEqual(report.files, [
      {
        path: 'src/changed.ts',
        symbols: [
          { symbol: 'changedSymbol', references: ['src/consumer.ts'], referenceCount: 1 },
        ],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
