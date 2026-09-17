import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertsAbsence,
  namedSymbols,
  checkAbsenceClaim,
} from '../plugins/review-voice/src/scoring/existence.ts';

// The worst finding of a real run asserted four files were absent when all
// four were present, at confidence 0.93, and proposed replacing correct
// cross-references with wrong ones.

test('the shapes a claim of absence takes are recognised', () => {
  for (const claim of [
    'CompanyActionsCell does not exist anywhere in the repo',
    'useBulkDeleteCompanies is not defined',
    'The helper is missing from this package',
    'There is no such component',
    'handleSubmit is never exported',
    'The constant cannot be found',
  ]) {
    assert.equal(assertsAbsence(claim), true, claim);
  }
});

test('an ordinary finding is not mistaken for one', () => {
  for (const claim of [
    'The handler returns before the transaction commits.',
    'This test does not assert the error path.',
    'The comment says the strip renders an empty state.',
  ]) {
    assert.equal(assertsAbsence(claim), false, claim);
  }
});

test('symbols are taken from backticks, filenames and CamelCase', () => {
  const symbols = namedSymbols(
    'The `useBulkDeleteCompanies` hook and CompanyActionsCell.tsx do not exist, nor does CompanyDataGrid.',
  );
  assert.ok(symbols.includes('useBulkDeleteCompanies'));
  assert.ok(symbols.includes('CompanyActionsCell.tsx'));
  assert.ok(symbols.includes('CompanyDataGrid'));
});

test('short or generic words are not searched', () => {
  // Searching for "data" proves nothing and would reject everything.
  const symbols = namedSymbols('The `id` and the data do not exist');
  assert.deepEqual(symbols, []);
});

test('a claim contradicted by the repository is reported', () => {
  const present = new Set(['CompanyActionsCell', 'useBulkDeleteCompanies']);
  const result = checkAbsenceClaim(
    '`CompanyActionsCell` and `useBulkDeleteCompanies` do not exist anywhere in the repo',
    '/repo',
    'origin/master',
    (symbol) => present.has(symbol),
  );
  assert.deepEqual(result.found.sort(), ['CompanyActionsCell', 'useBulkDeleteCompanies']);
  assert.equal(result.inconclusive, false);
  assert.equal(result.searchedRef, 'origin/master');
});

test('the record always names the tree that answered', () => {
  // An empty `found` is corroboration only if the right tree was searched. A
  // checkout 179 commits behind the base reported two present files as absent
  // with inconclusive: false, which read as the guard confirming the claim.
  const working = checkAbsenceClaim('`Thing` does not exist', '/repo', null, () => false);
  assert.equal(working.searchedRef, 'working tree');

  const atRef = checkAbsenceClaim('`Thing` does not exist', '/repo', '44c61fe', () => false);
  assert.equal(atRef.searchedRef, '44c61fe');
});

test('the ref is passed to the searcher, not silently dropped', () => {
  const seen = [];
  checkAbsenceClaim('`SomeComponent` does not exist', '/repo', 'origin/master', (symbol, cwd, ref) => {
    seen.push(ref);
    return false;
  });
  assert.deepEqual(seen, ['origin/master']);
});

test('a claim the repository agrees with is left alone', () => {
  const result = checkAbsenceClaim('`useNeverWritten` does not exist in this package', '/repo', null, () => false);
  assert.deepEqual(result.found, []);
  assert.equal(result.inconclusive, false);
});

test('a claim that names nothing searchable is not graded', () => {
  assert.equal(checkAbsenceClaim('the key does not exist', '/repo', null, () => true), null);
});

test('a failed search concludes nothing rather than confirming', () => {
  // A search that could not run is not evidence that the symbol is absent,
  // and it is certainly not evidence that it is present.
  const result = checkAbsenceClaim('`SomeComponent` does not exist', '/repo', null, () => {
    throw new Error('git not available');
  });
  assert.equal(result.inconclusive, true);
  assert.deepEqual(result.found, []);
});

test('a finding that is not about absence is never checked', () => {
  assert.equal(
    checkAbsenceClaim('`useEditEventSpaceForm` returns before the mutation settles', '/repo', null, () => {
      throw new Error('should not have searched');
    }),
    null,
  );
});
