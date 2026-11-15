/**
 * #381: "a task_id that does not exist" was read as a claim that something is
 * absent from the repository, and every name the sentence went on to mention
 * was searched for. Both were found, so a verified finding was held back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAbsenceClaim } from '../plugins/review-voice/src/scoring/existence.ts';

const found = () => true;
const check = (claim) => checkAbsenceClaim(claim, '/repo', 'main', found, null, () => [], () => []);

test('a run-time value that does not exist is not a claim about the repository', () => {
  const claim =
    'With the Temporal backend now writing through SqlAlchemyWorkflowStore, POST /workflow/runs with a task_id ' +
    'that does not exist hits the workflow_run.task_id foreign key at flush, and the resulting IntegrityError ' +
    'is not one of the exceptions _workflow_errors translates.';
  assert.equal(check(claim), null);
});

test('an unnamed subject in a conditional clause is not looked up either', () => {
  assert.equal(check('SqlAlchemyWorkflowStore raises IntegrityError when the task does not exist.'), null);
  assert.equal(check('`FooService` calls a helper that is not defined.'), null);
});

test('a name the claim says is present does not contradict the one it says is absent', () => {
  const result = check('`FooService` calls `barHelper`, which does not exist.');
  assert.deepEqual(result.checked, ['barHelper']);
});

test('a named subject is still checked, with or without a kind word after it', () => {
  assert.deepEqual(check('SqlAlchemyWorkflowStore does not exist.').found, ['SqlAlchemyWorkflowStore']);
  assert.deepEqual(check('`FooService` imports the `barHelper` hook, which does not exist.').checked, ['barHelper']);
  assert.deepEqual(check('There is no such function as `barHelper`.').checked, ['barHelper']);
  assert.deepEqual(check('If `barHelper` does not exist, `FooService` fails.').checked, ['barHelper']);
});

test('a pronoun subject settles nothing, so every name is checked as before', () => {
  assert.deepEqual(check('`FooService` and `barHelper`. Both do not exist.').checked, ['FooService', 'barHelper']);
  assert.deepEqual(check('`FooService` is referenced but does not exist.').checked, ['FooService']);
});
